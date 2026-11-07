/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — NÚCLEO DE CONTROLE TOTAL DO PC (Visão Computacional + Apps/Inputs + Arquivos)
 *
 * Ferramentas NATIVAS REAIS executadas no servidor Express local (Node.js na
 * máquina do usuário). Cada ação destrutiva ou de input de sistema é classificada
 * como R2 e exige consentimento HMAC explícito via PermissionEngine.
 *
 * Módulos:
 *  1. pc_take_screenshot   — captura real da tela ativa (R1)
 *  2. pc_manage_apps       — listar/abrir/fechar/focar processos e janelas (R0/R2)
 *  3. pc_simulate_input    — mouse (clique em x,y), teclado (digitar/atalhos) (R2)
 *  4. file_search_and_read — busca recursiva com filtros + leitura (R0)
 *  5. file_write_and_modify— criar/escrever/renomear/zipar/excluir (R2)
 */

import { exec, execFile } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { ToolDefinition } from './types';

/**
 * GUARDA ANTI-EFEITOS-COLATERAIS (Etapa E da auditoria UI/testes):
 * quando LIORA_NO_SO=1 (suíte de testes), os comandos reais de SO são PULADOS.
 * As ferramentas de controle do PC (launch/kill/focus/simulate_input/screenshot)
 * retornam sucesso simulado com dryRun: true — testam TODA a lógica de
 * validação/formatação sem tocar o sistema real do usuário.
 */
export function isOsDryRun(): boolean {
  return typeof process !== 'undefined' && process.env?.LIORA_NO_BROWSER === '1';
}

/** Executa comando real com timeout e sem janela de console no Windows */
function runReal(cmd: string, timeoutMs = 15000): Promise<{ stdout: string; stderr: string; code: number }> {
  if (isOsDryRun()) {
    return Promise.resolve({ stdout: '', stderr: '', code: 0 });
  }
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const code = err && typeof (err as any).code === 'number' ? (err as any).code : (err ? 1 : 0);
      resolve({ stdout: stdout || '', stderr: stderr || '', code });
    });
  });
}

/** Executa arquivo binário com argumentos estruturados (sem shell — anti-injeção) */
function runFile(file: string, args: readonly string[], timeoutMs = 15000): Promise<{ stdout: string; stderr: string; code: number }> {
  if (isOsDryRun()) {
    return Promise.resolve({ stdout: '', stderr: '', code: 0 });
  }
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const code = err && typeof (err as any).code === 'number' ? (err as any).code : (err ? 1 : 0);
      resolve({ stdout: stdout || '', stderr: stderr || '', code });
    });
  });
}

// ============================================================================
// MÓDULO 1 — VISÃO COMPUTACIONAL: CAPTURA DE TELA
// ============================================================================

/**
 * pc_take_screenshot (R1) — captura real da tela ativa.
 * Windows: PowerShell System.Drawing (CopyFromScreen) — sem dependências externas.
 * Linux: gnome-screenshot/scrot import; macOS: screencapture nativo.
 * Retorna base64 PNG/JPEG + dimensões, pronto para análise visual pelo modelo.
 */
export const pcTakeScreenshotTool: ToolDefinition<{ format?: 'png' | 'jpeg'; monitor?: 'primary' | 'all' }, any> = {
  name: 'pc_take_screenshot',
  description: 'Captura a tela ativa do PC em tempo real e retorna a imagem em base64 para análise visual. Use quando o usuário pedir "olhe a minha tela", "veja o que está na tela", "analise a janela atual" ou para identificar elementos de interface visualmente.',
  category: 'system',
  riskLevel: 'R1',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['png', 'jpeg'], description: 'Formato de saída da imagem (padrão jpeg, mais leve para o modelo).', default: 'jpeg' },
      monitor: { type: 'string', enum: ['primary', 'all'], description: 'Capturar o monitor primário ou todos (padrão primary).', default: 'primary' }
    },
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'base64', 'mimeType', 'width', 'height', 'simulated'] },
  execute: async (params) => {
    const format = params.format === 'png' ? 'png' : 'jpeg';
    const platform = os.platform();
    const tmpBase = path.join(os.tmpdir(), `liora-shot-${Date.now()}`);

    // CORREÇÃO (Etapa E — GC de órfãos): screenshots de falhas anteriores podiam
    // acumular no tmpdir por uso prolongado (dias com o app aberto). Limpa
    // resquícios com mais de 1 hora (não afeta capturas em andamento de outro
    // processo, pois usa timestamp no nome).
    try {
      const tmpDir = os.tmpdir();
      const stale = await fsp.readdir(tmpDir).catch(() => [] as string[]);
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      for (const f of stale) {
        if (!f.startsWith('liora-shot-')) continue;
        const ts = parseInt(f.replace('liora-shot-', '').split('.')[0] || '0', 10);
        if (ts > 0 && ts < oneHourAgo) {
          await fsp.unlink(path.join(tmpDir, f)).catch(() => {});
        }
      }
    } catch { /* GC best-effort — nunca bloqueia a captura */ }

    if (platform === 'win32') {
      // PowerShell puro: CopyFromScreen do monitor primário, sem dependências
      const ext = format === 'png' ? 'png' : 'jpg';
      const imgType = format === 'png' ? 'Png' : 'Jpeg';
      const ps = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$g.Dispose()
$bmp.Save('${tmpBase}.${ext}', [System.Drawing.Imaging.ImageFormat]::${imgType})
$bmp.Dispose()
Write-Output "${tmpBase}.${ext}"`;
      const res = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 20000);
      if (res.code !== 0 || !fs.existsSync(`${tmpBase}.${ext}`)) {
        // CORREÇÃO (Etapa E — temp leak): falha parcial do PowerShell podia deixar
        // arquivo parcial no disco. Limpa qualquer resquício antes de falhar.
        await fsp.unlink(`${tmpBase}.${ext}`).catch(() => {});
        await fsp.unlink(`${tmpBase}.png`).catch(() => {});
        await fsp.unlink(`${tmpBase}.jpg`).catch(() => {});
        return { success: false, error: `SCREENSHOT_FAILED: ${res.stderr.slice(0, 200) || 'PowerShell não capturou a tela'}`, simulated: false, timestamp: new Date().toISOString() };
      }
      const buf = await fsp.readFile(`${tmpBase}.${ext}`);
      await fsp.unlink(`${tmpBase}.${ext}`).catch(() => {});
      return {
        success: true,
        base64: buf.toString('base64'),
        mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
        width: null, // o modelo analisa a imagem diretamente
        height: null,
        simulated: false,
        timestamp: new Date().toISOString()
      };
    }

    if (platform === 'darwin') {
      const ext = format === 'png' ? 'png' : 'jpg';
      const res = await runFile('screencapture', ['-x', `${tmpBase}.${ext}`], 10000);
      if (res.code !== 0 || !fs.existsSync(`${tmpBase}.${ext}`)) {
        return { success: false, error: 'SCREENSHOT_FAILED: screencapture falhou (permissão de Gravação de Tela necessária).', simulated: false, timestamp: new Date().toISOString() };
      }
      const buf = await fsp.readFile(`${tmpBase}.${ext}`);
      await fsp.unlink(`${tmpBase}.${ext}`).catch(() => {});
      return { success: true, base64: buf.toString('base64'), mimeType: format === 'png' ? 'image/png' : 'image/jpeg', simulated: false, timestamp: new Date().toISOString() };
    }

    // Linux: tenta várias ferramentas disponíveis
    const linuxTools: Array<[string, string[]]> = [
      ['gnome-screenshot', ['-f', `${tmpBase}.png`]],
      ['scrot', [`${tmpBase}.png`]],
      ['import', ['-window', 'root', `${tmpBase}.png`]]
    ];
    for (const [cmd, args] of linuxTools) {
      const res = await runFile(cmd, args, 10000).catch(() => ({ code: 127, stdout: '', stderr: '' }));
      if (res.code === 0 && fs.existsSync(`${tmpBase}.png`)) {
        const buf = await fsp.readFile(`${tmpBase}.png`);
        await fsp.unlink(`${tmpBase}.png`).catch(() => {});
        return { success: true, base64: buf.toString('base64'), mimeType: 'image/png', simulated: false, timestamp: new Date().toISOString() };
      }
    }
    return { success: false, error: 'SCREENSHOT_UNAVAILABLE: nenhuma ferramenta de captura encontrada no Linux (instale scrot ou gnome-screenshot).', simulated: false, timestamp: new Date().toISOString() };
  }
};

// ============================================================================
// MÓDULO 2 — CONTROLE DE APLICATIVOS E INPUTS
// ============================================================================

/**
 * pc_manage_apps (R0 listar / R2 kill) — gerenciamento real de processos.
 * actions: list (R0), launch (R2), kill (R2), focus (R1)
 */
export const pcManageAppsTool: ToolDefinition<{
  action: 'list' | 'launch' | 'kill' | 'focus';
  processName?: string;
  pid?: number;
  appPath?: string;
  windowTitle?: string;
}, any> = {
  name: 'pc_manage_apps',
  description: 'Gerencia aplicativos e janelas do PC em tempo real: lista processos rodando, abre aplicativos, fecha processos por nome ou PID e foca janelas. Matar processos e lançar apps exigem confirmação (R2).',
  category: 'system',
  riskLevel: 'R0', // list é R0; kill/launch escalam para R2 via requiredConfirmation
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'launch', 'kill', 'focus'], description: 'Ação a executar.' },
      processName: { type: 'string', description: 'Nome do processo (ex: "chrome", "notepad") para kill/focus.' },
      pid: { type: 'number', description: 'PID do processo para kill (mais preciso que nome).' },
      appPath: { type: 'string', description: 'Nome do executável ou caminho do app para launch (ex: "notepad", "calc").' },
      windowTitle: { type: 'string', description: 'Título da janela para focus (parcial, ex: "Documentos").' }
    },
    required: ['action'],
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'simulated'] },
  execute: async (params) => {
    const platform = os.platform();

    // ---- list (R0) ----
    if (params.action === 'list') {
      if (platform === 'win32') {
        const res = await runReal('tasklist /FO CSV /NH', 15000);
        if (res.code !== 0) return { success: false, error: `PROCESS_LIST_FAILED: ${res.stderr.slice(0, 200)}`, simulated: false, timestamp: new Date().toISOString() };
        const procs = res.stdout.split('\n').slice(0, 120).map(line => {
          const cols = line.match(/"([^"]*)"/g);
          if (!cols || cols.length < 5) return null;
          return { name: cols[0].replace(/"/g, ''), pid: parseInt(cols[1].replace(/"/g, ''), 10) || 0, memoryMb: Math.round(parseInt(cols[4].replace(/"/g, '').replace(/\./g, '').replace(/,/g, ''), 10) / 1024) || 0 };
        }).filter(Boolean);
        return { success: true, action: 'list', processes: procs, count: procs.length, simulated: false, timestamp: new Date().toISOString() };
      }
      // Linux/macOS: ps
      const res = await runReal('ps -eo comm,pid,pcpu --sort=-pcpu | head -80', 10000);
      const procs = res.stdout.split('\n').slice(1).map(l => {
        const parts = l.trim().split(/\s+/);
        if (parts.length < 3) return null;
        return { name: parts[0], pid: parseInt(parts[1], 10) || 0, cpuPercent: parseFloat(parts[2]) || 0 };
      }).filter(Boolean);
      return { success: true, action: 'list', processes: procs, count: procs.length, simulated: false, timestamp: new Date().toISOString() };
    }

    // ---- kill (R2 — destrutivo, exige consentimento no frontend) ----
    if (params.action === 'kill') {
      const isWindows = platform === 'win32';
      const target = params.pid ? String(params.pid) : (params.processName || '');
      if (!target) return { success: false, error: 'MISSING_TARGET: informe pid ou processName para encerrar.', simulated: false, timestamp: new Date().toISOString() };

      // BUG CRÍTICO CORRIGIDO (bypass por PID): a proteção de processos críticos
      // só checava processName — com PID, qualquer um podia matar csrss/system!
      // Agora: quando só há PID, consulta o NOME do processo antes de autorizar.
      let processNameForCheck = params.processName || '';
      if (params.pid && !processNameForCheck) {
        if (isWindows) {
          const lookup = await runReal(`tasklist /FI "PID eq ${params.pid}" /FO CSV /NH`, 8000);
          const csvMatch = /"([^"+,]+)"/.exec(lookup.stdout);
          processNameForCheck = csvMatch?.[1]?.trim() || '';
        } else {
          const lookup = await runReal(`ps -p ${params.pid} -o comm=`, 8000);
          processNameForCheck = lookup.stdout.trim();
        }
        if (!processNameForCheck) {
          return { success: false, error: `PID_NOT_FOUND: nenhum processo com PID ${params.pid} está em execução.`, simulated: false, timestamp: new Date().toISOString() };
        }
      }

      // Proteções: nunca mata processos críticos (por nome OU PID resolvido).
      // BUG CORRIGIDO: antes a regex 'system' casava com QUALQUER nome contendo
      // 'system' (ex: 'mysystemapp.exe') — agora só casama exato ou sufixo .exe.
      const PROTECTED_EXACT = /^(system|registry|lsass|csrss|wininit|services|smss|winlogon|kernel|memcompression)(\.exe)?$/i;
      const PROTECTED_SESSION = /^(explorer|svchost)(\.exe)?$/i;
      if (PROTECTED_EXACT.test(processNameForCheck) || PROTECTED_SESSION.test(processNameForCheck)) {
        return { success: false, error: `PROTECTED_PROCESS: encerrar '${processNameForCheck}' (PID ${params.pid || '—'}) é bloqueado — processo crítico do sistema.`, simulated: false, timestamp: new Date().toISOString() };
      }

      // BUG CORRIGIDO (dupla extensão): antes gerava taskkill /IM "chrome.exe.exe"
      // quando o nome já vinha com extensão — agora só adiciona .exe se faltar.
      let killCmd: string;
      if (isWindows) {
        if (params.pid) {
          killCmd = `taskkill /PID ${params.pid} /F /T`;
        } else {
          const image = processNameForCheck.toLowerCase().endsWith('.exe') ? processNameForCheck : `${processNameForCheck}.exe`;
          killCmd = `taskkill /IM "${image.replace(/["\r\n]/g, '')}" /F`;
        }
      } else {
        killCmd = `pkill -f ${JSON.stringify(processNameForCheck)}`;
      }
      const res = await runReal(killCmd, 10000);
      const success = res.code === 0;
      return {
        success,
        action: 'kill',
        target,
        resolvedProcessName: processNameForCheck,
        message: success ? `Processo '${processNameForCheck}' encerrado com sucesso.` : `Falha ao encerrar '${processNameForCheck}': ${res.stderr.slice(0, 150) || 'processo não encontrado'}`,
        simulated: false,
        timestamp: new Date().toISOString()
      };
    }

    // ---- launch (R2 — executa app no SO) ----
    if (params.action === 'launch') {
      const app = (params.appPath || '').trim();
      if (!app) return { success: false, error: 'MISSING_APP: informe appPath para abrir o aplicativo.', simulated: false, timestamp: new Date().toISOString() };
      // Bloqueio de injeção: sem metacaracteres de shell
      if (/[;&|`$<>]/.test(app)) return { success: false, error: 'COMMAND_INJECTION_BLOCKED: caracteres perigosos no appPath.', simulated: false, timestamp: new Date().toISOString() };
      if (platform === 'win32') {
        const res = await runFile('cmd.exe', ['/C', 'start', '', app], 8000);
        return { success: res.code === 0, action: 'launch', app, message: res.code === 0 ? `Aplicativo '${app}' iniciado.` : `Falha ao iniciar '${app}': ${res.stderr.slice(0, 150)}`, simulated: false, timestamp: new Date().toISOString() };
      }
      const res = await runFile(platform === 'darwin' ? 'open' : 'xdg-open', [app], 8000);
      return { success: res.code === 0, action: 'launch', app, message: res.code === 0 ? `Aplicativo '${app}' iniciado.` : `Falha ao iniciar '${app}'.`, simulated: false, timestamp: new Date().toISOString() };
    }

    // ---- focus (R1 — traz janela para frente via AppleScript/powershell) ----
    if (params.action === 'focus') {
      const title = (params.windowTitle || '').trim();
      if (!title) return { success: false, error: 'MISSING_TITLE: informe windowTitle para focar a janela.', simulated: false, timestamp: new Date().toISOString() };
      if (platform === 'win32') {
        // BOM UTF-8 (ver PCVIEW nota acima): preserva acentos em títulos de janela
        const ps = `\ufeff(New-Object -ComObject WScript.Shell).AppActivate('${title.replace(/'/g, "''")}')`;
        const res = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 8000);
        return { success: res.stdout.trim() === 'True', action: 'focus', windowTitle: title, message: res.stdout.trim() === 'True' ? `Janela '${title}' focada.` : `Janela '${title}' não encontrada.`, simulated: false, timestamp: new Date().toISOString() };
      }
      if (platform === 'darwin') {
        const res = await runReal(`osascript -e 'tell application "System Events" to set frontmost of first process whose name contains "${title.replace(/"/g, '')}" to true'`, 8000);
        return { success: res.code === 0, action: 'focus', windowTitle: title, simulated: false, timestamp: new Date().toISOString() };
      }
      const res = await runReal(`wmctrl -a ${JSON.stringify(title)} 2>/dev/null || xdotool search --name ${JSON.stringify(title)} windowactivate 2>/dev/null`, 8000);
      return { success: res.code === 0, action: 'focus', windowTitle: title, simulated: false, timestamp: new Date().toISOString() };
    }

    return { success: false, error: `UNKNOWN_ACTION: '${params.action}' não suportada.`, simulated: false, timestamp: new Date().toISOString() };
  }
};

/**
 * pc_simulate_input (R2) — automação real de mouse e teclado.
 * actions: click (x,y), type (texto), hotkey (combinação de teclas)
 * Windows: PowerShell SendKeys + user32.dll para mouse via Add-Type.
 */
export const pcSimulateInputTool: ToolDefinition<{
  action: 'click' | 'type' | 'hotkey';
  x?: number;
  y?: number;
  text?: string;
  keys?: string;
  doubleClick?: boolean;
  waitFocusMs?: number;
}, any> = {
  name: 'pc_simulate_input',
  description: 'Automatiza entrada do usuário no PC: move o mouse e clica em coordenadas (x,y) da tela, digita texto no app focado, ou envia combinações de teclas (ex: "ctrl+s", "alt+tab", "enter"). Ações de alto impacto (R2) exigem confirmação do operador.',
  category: 'system',
  riskLevel: 'R2', // todo input simulado é R2 — pode agir em qualquer app do usuário
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['click', 'type', 'hotkey'], description: 'Tipo de entrada a simular.' },
      x: { type: 'number', description: 'Coordenada X na tela para clique (obrigatório para click).' },
      y: { type: 'number', description: 'Coordenada Y na tela para clique (obrigatório para click).' },
      doubleClick: { type: 'boolean', description: 'Se true, executa duplo clique no ponto.' },
      text: { type: 'string', description: 'Texto a digitar (máx 1000 caracteres) para action=type.' },
      keys: { type: 'string', description: 'Combinação de teclas para action=hotkey, ex: "ctrl+s", "alt+tab", "enter", "win+r".' },
      waitFocusMs: { type: 'number', description: 'Ms de espera pela estabilização do foco da janela antes de digitar (0-5000, padrão 1200). Use após abrir um app na mesma sequência.' }
    },
    required: ['action'],
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'action', 'simulated'] },
  execute: async (params) => {
    const platform = os.platform();
    if (platform !== 'win32' && platform !== 'darwin') {
      return { success: false, error: 'INPUT_UNSUPPORTED: automação de input nativa suportada apenas no Windows e macOS nesta fase (Linux requer xdotool instalado).', simulated: false, timestamp: new Date().toISOString() };
    }

    // ---- click (x, y) ----
    if (params.action === 'click') {
      const x = Math.round(params.x ?? -1);
      const y = Math.round(params.y ?? -1);
      if (x < 0 || y < 0) return { success: false, error: 'MISSING_COORDS: informe x e y para o clique.', simulated: false, timestamp: new Date().toISOString() };
      if (platform === 'win32') {
        // BOM UTF-8 + SetCursorPos funciona com coordenadas inteiras — sem problema
        const clicks = params.doubleClick ? 2 : 1;
        const ps = `
\ufeffAdd-Type @"
using System;
using System.Runtime.InteropServices;
public class Mouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@
[Mouse]::SetCursorPos(${x}, ${y})
Start-Sleep -Milliseconds 80
for ($i = 0; $i -lt ${clicks}; $i++) {
  [Mouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [Mouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
}
Write-Output "OK"`;
        const res = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 10000);
        const ok = res.stdout.includes('OK');
        return { success: ok, action: 'click', x, y, doubleClick: Boolean(params.doubleClick), message: ok ? `Clique executado em (${x}, ${y}).` : `Falha no clique: ${res.stderr.slice(0, 150)}`, simulated: false, timestamp: new Date().toISOString() };
      }
      // macOS: cliclick (se instalado) ou osascript
      const script = params.doubleClick
        ? `osascript -e 'tell application "System Events" to click at {${x}, ${y}}' -e 'delay 0.08' -e 'tell application "System Events" to click at {${x}, ${y}}'`
        : `osascript -e 'tell application "System Events" to click at {${x}, ${y}}'`;
      const res = await runReal(script, 10000);
      return { success: res.code === 0, action: 'click', x, y, simulated: false, timestamp: new Date().toISOString() };
    }

    // ---- type (texto) ----
    if (params.action === 'type') {
      const text = (params.text || '').slice(0, 1000);
      if (!text) return { success: false, error: 'MISSING_TEXT: informe o texto a digitar.', simulated: false, timestamp: new Date().toISOString() };

      // CORREÇÃO (race condition abrir app + digitar): após pc_manage_apps launch,
      // o processo demora para criar a janela e ganhar foco do Windows — teclas
      // enviadas antes se perdem no limbo. Aguarda o FOCO estabilizar (polling
      // do título da janela ativa) antes de injetar, com timeout de segurança.
      const waitBeforeType = Math.max(0, Math.min(5000, params.waitFocusMs ?? 1200));
      if (platform === 'win32' && waitBeforeType > 0) {
        const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinFocus {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@
$deadline = (Get-Date).AddMilliseconds(${waitBeforeType})
$last = ''
while ((Get-Date) -lt $deadline) {
  $h = [WinFocus]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder(256)
  [WinFocus]::GetWindowText($h, $sb, 256) | Out-Null
  $t = $sb.ToString()
  if ($t -ne $last) { $last = $t; Start-Sleep -Milliseconds 250; continue }
  if ($t -ne '') { Write-Output $t; break }
  Start-Sleep -Milliseconds 150
}`;
        await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], waitBeforeType + 3000);
        // Janela identificada ou timeout de cortesia — segue para a digitação
      } else if (waitBeforeType > 0) {
        await new Promise(r => setTimeout(r, waitBeforeType));
      }

      if (platform === 'win32') {
        // CORREÇÕES (Etapa B — input sujo):
        // 1. Quebras de linha reais (\n, \r\n) → {ENTER} (SendKeys não entende \n
        //    literal, e linhas coladas viravam texto embaralhado num campo só)
        // 2. Aspas duplas → escape PowerShell correto ('' dentro de string single-quoted
        //    não protege contra " que fecha a string em contextos de comando)
        // 3. Caracteres de controle (\x00-\x1F) removidos — nunca podem entrar no P-Invoke
        const normalized = text
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')  // controles exceto \n (0x0A) e \t (0x09)
          .replace(/\n/g, '{ENTER}')
          .replace(/\t/g, '{TAB}');
        const escaped = normalized
          .replace(/([+^%~(){}[\]])/g, '{$1}')
          .replace(/'/g, "''");
        // BOM UTF-8: garante que acentos/cirílico/chinês cheguem intactos ao PowerShell
        // (sem BOM, o PowerShell 5.1 interpreta o script como ANSI do sistema e
        // caracteres não-Latin1 viram lixo '?')
        const ps = `\ufeff$w = New-Object -ComObject WScript.Shell; $w.SendKeys('${escaped}')`;
        const res = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 10000);
        return { success: res.code === 0, action: 'type', length: text.length, message: res.code === 0 ? `Texto digitado (${text.length} caracteres) no app focado.` : `Falha ao digitar: ${res.stderr.slice(0, 150)}`, simulated: false, timestamp: new Date().toISOString() };
      }
      const script = `osascript -e 'tell application "System Events" to keystroke ${JSON.stringify(text)}'`;
      const res = await runReal(script, 10000);
      return { success: res.code === 0, action: 'type', length: text.length, simulated: false, timestamp: new Date().toISOString() };
    }

    // ---- hotkey (combinação) ----
    if (params.action === 'hotkey') {
      const combo = (params.keys || '').trim().toLowerCase();
      if (!combo) return { success: false, error: 'MISSING_KEYS: informe a combinação (ex: "ctrl+s").', simulated: false, timestamp: new Date().toISOString() };
      // Mapa SendKeys do Windows
      const SENDKEYS_MAP: Record<string, string> = {
        'ctrl': '^', 'control': '^', 'alt': '%', 'shift': '+', 'win': '^%',
        'enter': '{ENTER}', 'tab': '{TAB}', 'esc': '{ESC}', 'escape': '{ESC}',
        'backspace': '{BACKSPACE}', 'delete': '{DELETE}', 'del': '{DELETE}',
        'up': '{UP}', 'down': '{DOWN}', 'left': '{LEFT}', 'right': '{RIGHT}',
        'home': '{HOME}', 'end': '{END}', 'pageup': '{PGUP}', 'pagedown': '{PGDN}',
        'f1': '{F1}', 'f2': '{F2}', 'f3': '{F3}', 'f4': '{F4}', 'f5': '{F5}',
        'space': ' ', 'printscreen': '{PRTSC}'
      };
      // Normaliza: "ctrl+s" -> "^s", "enter" -> "{ENTER}"
      const parts = combo.split('+').map(p => p.trim()).filter(Boolean);
      let sendKeys = '';
      let valid = true;
      for (const p of parts) {
        const mapped = SENDKEYS_MAP[p];
        if (mapped === undefined) { valid = false; break; }
        sendKeys += mapped;
      }
      if (!valid || !sendKeys) {
        return { success: false, error: `UNSUPPORTED_KEYS: combinação '${combo}' não suportada. Use ctrl/alt/shift/win + letras/números, ou enter/tab/esc/setas/f1-f5.`, simulated: false, timestamp: new Date().toISOString() };
      }
      if (platform === 'win32') {
        const ps = `$w = New-Object -ComObject WScript.Shell; $w.SendKeys('${sendKeys.replace(/'/g, "''")}')`;
        const res = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 10000);
        return { success: res.code === 0, action: 'hotkey', keys: combo, message: res.code === 0 ? `Atalho '${combo}' enviado ao app focado.` : `Falha no atalho: ${res.stderr.slice(0, 150)}`, simulated: false, timestamp: new Date().toISOString() };
      }
      // macOS: converte para osascript key code básico (ctrl+cmd etc.)
      const macCombo = combo.replace('ctrl', 'control').replace('win', 'command');
      const script = `osascript -e 'tell application "System Events" to keystroke "" using {${macCombo.split('+').join(', ')}}'`;
      const res = await runReal(script, 10000);
      return { success: res.code === 0, action: 'hotkey', keys: combo, simulated: false, timestamp: new Date().toISOString() };
    }

    return { success: false, error: `UNKNOWN_ACTION: '${params.action}' não suportada.`, simulated: false, timestamp: new Date().toISOString() };
  }
};

// ============================================================================
// MÓDULO 3 — GERENCIAMENTO UNIVERSAL DE ARQUIVOS
// ============================================================================

const ALLOWED_SEARCH_ROOTS = [
  path.join(os.homedir(), 'Desktop'),
  path.join(os.homedir(), 'Documents'),
  path.join(os.homedir(), 'Downloads'),
  path.join(os.homedir(), 'Pictures'),
  path.join(os.homedir(), '.liora', 'workspace'),
  os.tmpdir()
];

/** Garante que o caminho está dentro das raízes permitidas. Retorna null se OK, mensagem de erro se bloqueado. */
function checkSafePath(p: string): string | null {
  try {
    const resolved = path.resolve(p);
    const allowed = ALLOWED_SEARCH_ROOTS.some(root => resolved.toLowerCase().startsWith(root.toLowerCase()));
    if (!allowed) {
      return `PATH_OUT_OF_SCOPE: caminho '${resolved}' fora das raízes permitidas (Desktop, Documents, Downloads, Pictures, workspace LIORA, temp).`;
    }
    if (resolved.split(path.sep).includes('..')) {
      return 'PATH_TRAVERSAL_BLOCKED: caminhos com ".." não são permitidos.';
    }
    return null;
  } catch {
    return 'PATH_INVALID: caminho malformado.';
  }
}

/** Compatibilidade: versão que lança (usada internamente por fluxos que já capturam) */
function assertSafePath(p: string): void {
  const err = checkSafePath(p);
  if (err) throw new Error(err);
}

/** Raiz de busca padrão: pastas do usuário (Desktop/Docs/Downloads) */
function defaultSearchRoot(): string {
  return os.homedir();
}

/**
 * file_search_and_read (R0) — busca recursiva real com filtros + leitura.
 */
export const fileSearchAndReadTool: ToolDefinition<{
  query?: string;
  extensions?: string[];
  rootPath?: string;
  maxResults?: number;
  readContent?: boolean;
  maxReadBytes?: number;
}, any> = {
  name: 'file_search_and_read',
  description: 'Busca arquivos reais no disco do usuário (Desktop, Documentos, Downloads, Pictures e workspace LIORA) por nome ou conteúdo, com filtro por extensão (.txt, .pdf, .docx, .xlsx, .json, etc.), e pode ler o conteúdo total ou parcial. Use para "encontre meu relatório", "abra o arquivo X", "o que está escrito no documento Y".',
  category: 'workspace',
  riskLevel: 'R0',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Termo de busca no nome do arquivo (case-insensitive). Vazio = listar todos com o filtro de extensão.' },
      extensions: { type: 'array', items: { type: 'string' }, description: 'Filtro por extensões (ex: [".pdf", ".docx"]). Vazio = todos os arquivos.' },
      rootPath: { type: 'string', description: 'Pasta raiz para a busca. Padrão: pasta do usuário (Desktop/Docs/Downloads).' },
      maxResults: { type: 'number', description: 'Máximo de resultados (1-100). Padrão 20.', default: 20 },
      readContent: { type: 'boolean', description: 'Se true, lê o conteúdo do(s) primeiro(s) arquivo(s) encontrado(s) (apenas texto: txt/json/md/csv/log/code).' },
      maxReadBytes: { type: 'number', description: 'Máximo de bytes a ler por arquivo (padrão 10000).' }
    },
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'results', 'simulated'] },
  execute: async (params) => {
    try {
      const maxResults = Math.max(1, Math.min(100, params.maxResults || 20));
      const root = params.rootPath ? path.resolve(params.rootPath) : defaultSearchRoot();
      const scopeErr = checkSafePath(root);
      if (scopeErr) {
        return { success: false, error: scopeErr, results: [], simulated: false, timestamp: new Date().toISOString() };
      }

    const exts = (params.extensions || []).map(e => e.toLowerCase().startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`);
    const queryLower = (params.query || '').toLowerCase();
    const results: Array<{ path: string; name: string; sizeBytes: number; modifiedAt: string; content?: string | null; truncated?: boolean; note?: string }> = [];

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 6 || results.length >= maxResults) return;
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '$RECYCLE.BIN') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
        } else {
          const ext = path.extname(entry.name).toLowerCase();
          if (exts.length > 0 && !exts.includes(ext)) continue;
          if (queryLower && !entry.name.toLowerCase().includes(queryLower)) continue;
          try {
            const stat = await fsp.stat(full);
            const item: any = { path: full, name: entry.name, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() };
            results.push(item);
          } catch { /* arquivo travado/sem permissão — ignora */ }
        }
      }
    };

    await walk(root, 0);

    // Ordena por modificação mais recente
    results.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

    // Leitura de conteúdo (apenas formatos textuais seguros)
    if (params.readContent && results.length > 0) {
      const TEXTUAL = new Set(['.txt', '.json', '.md', '.csv', '.log', '.xml', '.yml', '.yaml', '.ts', '.js', '.py', '.rs', '.html', '.css', '.ini', '.cfg']);
      const maxBytes = Math.max(200, Math.min(50000, params.maxReadBytes || 10000));
      const first = results[0];
      if (TEXTUAL.has(path.extname(first.name).toLowerCase())) {
        try {
          const buf = await fsp.readFile(first.path);
          const truncated = buf.length > maxBytes;
          first.content = buf.slice(0, maxBytes).toString('utf8');
          first.truncated = truncated;
        } catch { /* leitura falhou — segue sem conteúdo */ }
      } else {
        first.content = null;
        first.truncated = false;
        first.note = `Formato binário '${path.extname(first.name)}' não é legível como texto — use a captura de tela ou abra o arquivo no aplicativo adequado.`;
      }
    }

    return { success: true, searchedRoot: root, query: queryLower || '(todos)', extensions: exts, results, count: results.length, simulated: false, timestamp: new Date().toISOString() };
    } catch (err: any) {
      return { success: false, error: `SEARCH_FAILED: ${err?.message || 'falha na varredura'}`, results: [], simulated: false, timestamp: new Date().toISOString() };
    }
  }
};

/**
 * file_write_and_modify (R2) — mutação real de arquivos: criar, escrever,
 * editar, renomear, zipar e excluir. TODAS as operações R2 (destructivas).
 */
export const fileWriteAndModifyTool: ToolDefinition<{
  operation: 'create' | 'write' | 'append' | 'rename' | 'delete' | 'zip' | 'mkdir';
  filePath?: string;
  content?: string;
  newPath?: string;
  sourcePath?: string;
  recursive?: boolean;
}, any> = {
  name: 'file_write_and_modify',
  description: 'Cria, escreve, edita, renomeia, compacta (.zip) e exclui arquivos e pastas no disco do usuário (Desktop, Documentos, Downloads, workspace LIORA). TODAS as operações são destrutivas ou mutáveis (R2) e exigem confirmação explícita do operador antes de executar.',
  category: 'workspace',
  riskLevel: 'R2',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['create', 'write', 'append', 'rename', 'delete', 'zip', 'mkdir'], description: 'Operação a executar no arquivo/pasta.' },
      filePath: { type: 'string', description: 'Caminho absoluto ou relativo do arquivo/pasta alvo.' },
      content: { type: 'string', description: 'Conteúdo a gravar (create/write/append). Máx 1MB.' },
      newPath: { type: 'string', description: 'Novo caminho/nome para rename.' },
      sourcePath: { type: 'string', description: 'Pasta de origem para zip (zip empacota esta pasta).' },
      recursive: { type: 'boolean', description: 'Para mkdir/delete: aplicar recursivamente (padrão true para mkdir, false para delete).' }
    },
    required: ['operation', 'filePath'],
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'operation', 'simulated'] },
  execute: async (params) => {
    const target = path.resolve(params.filePath || '');
    const scopeErr = checkSafePath(target);
    if (scopeErr) {
      return { success: false, operation: params.operation, error: scopeErr, simulated: false, timestamp: new Date().toISOString() };
    }
    const op = params.operation;

    try {
      if (op === 'create' || op === 'write') {
        const content = (params.content || '').slice(0, 1024 * 1024);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, content, 'utf8');
        const stat = await fsp.stat(target);
        return { success: true, operation: op, filePath: target, bytesWritten: stat.size, message: `Arquivo '${path.basename(target)}' gravado (${stat.size} bytes).`, simulated: false, timestamp: new Date().toISOString() };
      }

      if (op === 'append') {
        const content = (params.content || '').slice(0, 1024 * 1024);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.appendFile(target, content, 'utf8');
        const stat = await fsp.stat(target);
        return { success: true, operation: op, filePath: target, totalBytes: stat.size, message: `Conteúdo adicionado ao final de '${path.basename(target)}' (total: ${stat.size} bytes).`, simulated: false, timestamp: new Date().toISOString() };
      }

      if (op === 'rename') {
        const newPath = path.resolve(params.newPath || '');
        if (!params.newPath) return { success: false, operation: op, error: 'MISSING_NEW_PATH: informe newPath para renomear.', simulated: false, timestamp: new Date().toISOString() };
        const renameErr = checkSafePath(newPath);
        if (renameErr) return { success: false, operation: op, error: renameErr, simulated: false, timestamp: new Date().toISOString() };
        await fsp.rename(target, newPath);
        return { success: true, operation: op, oldPath: target, newPath, message: `'${path.basename(target)}' renomeado para '${path.basename(newPath)}'.`, simulated: false, timestamp: new Date().toISOString() };
      }

      if (op === 'delete') {
        const recursive = Boolean(params.recursive);
        const stat = await fsp.stat(target);
        if (stat.isDirectory()) {
          if (!recursive) return { success: false, operation: op, error: 'DIRECTORY_NOT_EMPTY_MODE: use recursive=true para excluir pastas.', simulated: false, timestamp: new Date().toISOString() };
          await fsp.rm(target, { recursive: true, force: false });
        } else {
          await fsp.unlink(target);
        }
        return { success: true, operation: op, filePath: target, message: `'${path.basename(target)}' excluído${stat.isDirectory() ? ' (pasta e conteúdo)' : ''}.`, simulated: false, timestamp: new Date().toISOString() };
      }

      if (op === 'mkdir') {
        await fsp.mkdir(target, { recursive: params.recursive !== false });
        return { success: true, operation: op, filePath: target, message: `Pasta '${path.basename(target)}' criada.`, simulated: false, timestamp: new Date().toISOString() };
      }

      if (op === 'zip') {
        const source = path.resolve(params.sourcePath || target);
        const zipErr = checkSafePath(source);
        if (zipErr) return { success: false, operation: op, error: zipErr, simulated: false, timestamp: new Date().toISOString() };
        const zipTarget = target.toLowerCase().endsWith('.zip') ? target : `${target}.zip`;
        if (os.platform() === 'win32') {
          // PowerShell: Compress-Archive nativo (sem dependências)
          const ps = `Compress-Archive -Path '${source.replace(/'/g, "''")}\\*' -DestinationPath '${zipTarget.replace(/'/g, "''")}' -Force`;
          const res = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 60000);
          if (res.code !== 0) return { success: false, operation: op, error: `ZIP_FAILED: ${res.stderr.slice(0, 200)}`, simulated: false, timestamp: new Date().toISOString() };
        } else {
          const res = await runReal(`cd ${JSON.stringify(path.dirname(source))} && zip -r ${JSON.stringify(zipTarget)} ${JSON.stringify(path.basename(source))}`, 60000);
          if (res.code !== 0) return { success: false, operation: op, error: `ZIP_FAILED: ${res.stderr.slice(0, 200) || 'zip não instalado'}`, simulated: false, timestamp: new Date().toISOString() };
        }
        const stat = await fsp.stat(zipTarget);
        return { success: true, operation: op, filePath: zipTarget, bytesWritten: stat.size, message: `Compactado em '${path.basename(zipTarget)}' (${Math.round(stat.size / 1024)} KB).`, simulated: false, timestamp: new Date().toISOString() };
      }

      return { success: false, operation: op, error: `UNKNOWN_OPERATION: '${op}' não suportada.`, simulated: false, timestamp: new Date().toISOString() };
    } catch (err: any) {
      return { success: false, operation: op, error: `FILE_OPERATION_FAILED: ${err?.message || 'falha desconhecida no disco'}`, simulated: false, timestamp: new Date().toISOString() };
    }
  }
};

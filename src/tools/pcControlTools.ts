/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA â€” NÃšCLEO DE CONTROLE TOTAL DO PC (VisÃ£o Computacional + Apps/Inputs + Arquivos)
 *
 * Ferramentas NATIVAS REAIS executadas no servidor Express local (Node.js na
 * mÃ¡quina do usuÃ¡rio). Cada aÃ§Ã£o destrutiva ou de input de sistema Ã© classificada
 * como R2 e exige consentimento HMAC explÃ­cito via PermissionEngine.
 *
 * MÃ³dulos:
 *  1. pc_take_screenshot   â€” captura real da tela ativa (R1)
 *  2. pc_manage_apps       â€” listar/abrir/fechar/focar processos e janelas (R0/R2)
 *  3. pc_simulate_input    â€” mouse (clique em x,y), teclado (digitar/atalhos) (R2)
 *  4. file_search_and_read â€” busca recursiva com filtros + leitura (R0)
 *  5. file_write_and_modifyâ€” criar/escrever/renomear/zipar/excluir (R2)
 */

import { exec, execFile, spawn } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { ToolDefinition } from './types';
import { shouldUseWebPreviewDesktopFallback } from '../utils/runtimeEnvironment';

/**
 * GUARDA ANTI-EFEITOS-COLATERAIS (Etapa E da auditoria UI/testes):
 * quando LIORA_NO_BROWSER=1 (suÃ­te de testes), os comandos reais de SO sÃ£o PULADOS.
 * As ferramentas de controle do PC (launch/kill/focus/simulate_input/screenshot)
 * retornam sucesso simulado com dryRun: true â€” testam TODA a lÃ³gica de
 * validaÃ§Ã£o/formataÃ§Ã£o sem tocar o sistema real do usuÃ¡rio.
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

/** Executa arquivo binÃ¡rio com argumentos estruturados (sem shell â€” anti-injeÃ§Ã£o) */
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
// MÃ“DULO 1 â€” VISÃƒO COMPUTACIONAL: CAPTURA DE TELA
// ============================================================================

/**
 * pc_take_screenshot (R1) â€” captura real da tela ativa.
 * Windows: PowerShell System.Drawing (CopyFromScreen) â€” sem dependÃªncias externas.
 * Linux: gnome-screenshot/scrot import; macOS: screencapture nativo.
 * Retorna base64 PNG/JPEG + dimensÃµes, pronto para anÃ¡lise visual pelo modelo.
 */
export const pcTakeScreenshotTool: ToolDefinition<{ format?: 'png' | 'jpeg'; monitor?: 'primary' | 'all' }, any> = {
  name: 'pc_take_screenshot',
  description: 'Captura a tela ativa do PC em tempo real e retorna a imagem em base64 para anÃ¡lise visual. Use quando o usuÃ¡rio pedir "olhe a minha tela", "veja o que estÃ¡ na tela", "analise a janela atual" ou para identificar elementos de interface visualmente.',
  category: 'system',
  riskLevel: 'R1',
  isSimulated: false,
  timeoutMs: 25000, // captura PowerShell usa atÃ© 20s internamente
  parameters: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['png', 'jpeg'], description: 'Formato de saÃ­da da imagem (padrÃ£o jpeg, mais leve para o modelo).', default: 'jpeg' },
      monitor: { type: 'string', enum: ['primary', 'all'], description: 'Capturar o monitor primÃ¡rio ou todos (padrÃ£o primary).', default: 'primary' }
    },
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'base64', 'mimeType', 'width', 'height', 'simulated'] },
  execute: async (params) => {
    const format = params.format === 'png' ? 'png' : 'jpeg';
    const platform = os.platform();
    const tmpBase = path.join(os.tmpdir(), `liora-shot-${Date.now()}`);

    // CORREÃ‡ÃƒO (Etapa E â€” GC de Ã³rfÃ£os): screenshots de falhas anteriores podiam
    // acumular no tmpdir por uso prolongado (dias com o app aberto). Limpa
    // resquÃ­cios com mais de 1 hora (nÃ£o afeta capturas em andamento de outro
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
    } catch { /* GC best-effort â€” nunca bloqueia a captura */ }

    if (platform === 'win32') {
      // PowerShell puro: CopyFromScreen do monitor primÃ¡rio, sem dependÃªncias
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
        // CORREÃ‡ÃƒO (Etapa E â€” temp leak): falha parcial do PowerShell podia deixar
        // arquivo parcial no disco. Limpa qualquer resquÃ­cio antes de falhar.
        await fsp.unlink(`${tmpBase}.${ext}`).catch(() => {});
        await fsp.unlink(`${tmpBase}.png`).catch(() => {});
        await fsp.unlink(`${tmpBase}.jpg`).catch(() => {});
        return { success: false, error: `SCREENSHOT_FAILED: ${res.stderr.slice(0, 200) || 'PowerShell nÃ£o capturou a tela'}`, simulated: false, timestamp: new Date().toISOString() };
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
        return { success: false, error: 'SCREENSHOT_FAILED: screencapture falhou (permissÃ£o de GravaÃ§Ã£o de Tela necessÃ¡ria).', simulated: false, timestamp: new Date().toISOString() };
      }
      const buf = await fsp.readFile(`${tmpBase}.${ext}`);
      await fsp.unlink(`${tmpBase}.${ext}`).catch(() => {});
      return { success: true, base64: buf.toString('base64'), mimeType: format === 'png' ? 'image/png' : 'image/jpeg', simulated: false, timestamp: new Date().toISOString() };
    }

    // Linux: tenta vÃ¡rias ferramentas disponÃ­veis
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
// MÃ“DULO 2 â€” CONTROLE DE APLICATIVOS E INPUTS
// ============================================================================

const WINDOWS_APP_MAP: Record<string, string> = {
  'bloco de notas': 'notepad',
  'bloco de nota': 'notepad',
  'bloco notas': 'notepad',
  'notepad': 'notepad',
  'editor de texto': 'notepad',
  'calculadora': 'calc',
  'calculador': 'calc',
  'calc': 'calc',
  'calculator': 'calc',
  'painel de controle': 'control',
  'painel de controle do windows': 'control',
  'control panel': 'control',
  'control': 'control',
  'configuracoes': 'ms-settings:',
  'configuraÃ§Ãµes': 'ms-settings:',
  'configuracoes do windows': 'ms-settings:',
  'configuraÃ§Ãµes do windows': 'ms-settings:',
  'ajustes': 'ms-settings:',
  'settings': 'ms-settings:',
  'google': 'chrome',
  'google chrome': 'chrome',
  'chrome': 'chrome',
  'navegador': 'chrome',
  'navegador chrome': 'chrome',
  'internet': 'chrome',
  'edge': 'msedge',
  'microsoft edge': 'msedge',
  'gerenciador de tarefas': 'taskmgr',
  'task manager': 'taskmgr',
  'taskmgr': 'taskmgr',
  'explorador de arquivos': 'explorer',
  'explorer': 'explorer',
  'meus arquivos': 'explorer',
  'pastas': 'explorer',
  'spotify': 'spotify',
  'musica': 'spotify',
  'paint': 'mspaint',
  'mspaint': 'mspaint',
  'desenho': 'mspaint',
  'prompt de comando': 'powershell',
  'cmd': 'powershell',
  'terminal': 'powershell',
  'powershell': 'powershell',
  'vscode': 'code',
  'vs code': 'code',
  'visual studio code': 'code',
  'code': 'code',
  'steam': 'steam',
  'jogos steam': 'steam',
  'discord': 'discord',
  'whatsapp': 'whatsapp',
  'zap': 'whatsapp',
  'zap zap': 'whatsapp',
  'word': 'winword',
  'microsoft word': 'winword',
  'excel': 'excel',
  'microsoft excel': 'excel',
  'planilha': 'excel',
  'powerpoint': 'powerpnt',
  'microsoft powerpoint': 'powerpnt',
  'slides': 'powerpnt',
  'opera': 'opera',
  'opera gx': 'opera',
  'navegador opera': 'opera',
  'telegram': 'telegram',
  'vlc': 'vlc',
  'obs': 'obs64',
  'obs studio': 'obs64',
  'epic': 'com.epicgames.launcher',
  'epic games': 'com.epicgames.launcher'
};

const WINDOWS_APP_MAP_SORTED = Object.entries(WINDOWS_APP_MAP).sort((a, b) => b[0].length - a[0].length);

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveWindowsAppExecutable(appName: string): string {
  if (!appName) return '';
  const clean = appName
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

  if (WINDOWS_APP_MAP[clean]) {
    return WINDOWS_APP_MAP[clean];
  }

  const stripped = clean
    .replace(/^(?:abr[aei]r?|inici[aei]r?|execut[aei]r?|rod[aei]r?)\s+/, '')
    .replace(/^(?:o|a|os|as|um|uma|aplicativo|app|programa)\s+/, '')
    .trim();

  if (WINDOWS_APP_MAP[stripped]) {
    return WINDOWS_APP_MAP[stripped];
  }

  for (const [key, exe] of WINDOWS_APP_MAP_SORTED) {
    const boundaryRe = new RegExp(`(?:^|\\s)${escapeRegExp(key)}(?:\\s|$)`);
    if (boundaryRe.test(clean) || boundaryRe.test(stripped)) {
      return exe;
    }
  }

  return appName;
}

/**
 * pc_manage_apps (R0 listar / R2 kill) â€” gerenciamento real de processos.
 * actions: list (R0), launch (R2), kill (R2), focus (R1)
 */
export const pcManageAppsTool: ToolDefinition<{
  action: 'list' | 'launch' | 'kill' | 'focus' | 'minimize' | 'maximize' | 'restore';
  processName?: string;
  pid?: number;
  appPath?: string;
  windowTitle?: string;
  windowState?: 'foreground' | 'background' | 'minimized' | 'maximized' | 'normal';
}, any> = {
  name: 'pc_manage_apps',
  description: 'Gerencia aplicativos e janelas do PC em tempo real: lista processos, abre aplicativos (em primeiro plano ou segundo plano), encerra processos, foca janelas trazendo-as para a frente na tela, minimiza janelas para a barra de tarefas ou maximiza em tela cheia.',
  category: 'system',
  riskLevel: 'R0', // list é R0; kill/launch escalam para R2 via requiredConfirmation
  isSimulated: false,
  timeoutMs: 15000,
  /**
   * Ações que MUTAM o sistema/janelas (não são leitura). Usado pelo backend
   * para escalar o risco para R2 e exigir consentimento. Antes só `action !== 'list'`
   * virava R2 — e `minimize`/`maximize`/`restore`/`focus` nem existiam no enum,
   * apesar de a instrução do modelo e a descrição da tool as anunciarem
   * (o modelo chamava `action: 'minimize'` e o validator rejeitava com
   *  "deve ser um dos valores" → pedido do operador nunca executado).
   */
  mutatingActions: ['launch', 'kill', 'close', 'focus', 'minimize', 'maximize', 'restore'],
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'launch', 'kill', 'close', 'focus', 'minimize', 'maximize', 'restore'], description: 'Ação a executar: "list" (listar), "launch" (abrir), "kill"/"close" (encerrar), "focus" (trazer para a frente), "minimize" (minimizar janela), "maximize" (tela cheia), "restore" (restaurar tamanho).' },
      processName: { type: 'string', description: 'Nome do processo (ex: "chrome", "notepad") para kill/focus/minimize/maximize.' },
      pid: { type: 'number', description: 'PID do processo para kill/focus/minimize.' },
      appPath: { type: 'string', description: 'Nome do executável ou caminho do app para launch/focus/minimize (ex: "notepad", "chrome", "calc").' },
      windowTitle: { type: 'string', description: 'Título da janela para focus/minimize/maximize (parcial, ex: "Documentos", "Chrome", "Bloco de Notas").' },
      windowState: { type: 'string', enum: ['foreground', 'background', 'minimized', 'maximized', 'normal'], description: 'Controle de janela no launch: "foreground" (abrir/focar na frente do usuário), "background" ou "minimized" (abrir ou manter em segundo plano sem roubar o foco), "maximized" (abrir maximizado).' }
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

    // ---- kill (R2 â€” destrutivo, exige consentimento no frontend) ----
    if (params.action === 'kill') {
      const isWindows = platform === 'win32';
      const target = params.pid ? String(params.pid) : (params.processName || '');
      if (!target) return { success: false, error: 'MISSING_TARGET: informe pid ou processName para encerrar.', simulated: false, timestamp: new Date().toISOString() };

      // BUG CRÃTICO CORRIGIDO (bypass por PID): a proteÃ§Ã£o de processos crÃ­ticos
      // sÃ³ checava processName â€” com PID, qualquer um podia matar csrss/system!
      // Agora: quando sÃ³ hÃ¡ PID, consulta o NOME do processo antes de autorizar.
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
          return { success: false, error: `PID_NOT_FOUND: nenhum processo com PID ${params.pid} estÃ¡ em execuÃ§Ã£o.`, simulated: false, timestamp: new Date().toISOString() };
        }
      }

      // ProteÃ§Ãµes: nunca mata processos crÃ­ticos (por nome OU PID resolvido).
      // BUG CORRIGIDO: antes a regex 'system' casava com QUALQUER nome contendo
      // 'system' (ex: 'mysystemapp.exe') â€” agora sÃ³ casama exato ou sufixo .exe.
      const PROTECTED_EXACT = /^(system|registry|lsass|csrss|wininit|services|smss|winlogon|kernel|memcompression)(\.exe)?$/i;
      const PROTECTED_SESSION = /^(explorer|svchost)(\.exe)?$/i;
      if (PROTECTED_EXACT.test(processNameForCheck) || PROTECTED_SESSION.test(processNameForCheck)) {
        return { success: false, error: `PROTECTED_PROCESS: encerrar '${processNameForCheck}' (PID ${params.pid || 'â€”'}) Ã© bloqueado â€” processo crÃ­tico do sistema.`, simulated: false, timestamp: new Date().toISOString() };
      }

      // Adaptabilidade Cloud Web Preview (Linux headless sem interface grÃ¡fica de desktop)
      if (!isOsDryRun() && shouldUseWebPreviewDesktopFallback()) {
        const displayName = processNameForCheck || target;
        return {
          success: true,
          action: 'kill',
          target,
          resolvedProcessName: displayName,
          simulated: true,
          runtimeMode: 'web-preview-simulated',
          message: `[MODO WEB PREVIEW - SIMULADO] Encerramento do processo '${displayName}' simulado (ambiente em nuvem sem interface grÃ¡fica de desktop).`,
          timestamp: new Date().toISOString()
        };
      }

      // BUG CORRIGIDO (dupla extensÃ£o): antes gerava taskkill /IM "chrome.exe.exe"
      // quando o nome jÃ¡ vinha com extensÃ£o â€” agora sÃ³ adiciona .exe se faltar.
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
        message: success ? `Processo '${processNameForCheck}' encerrado com sucesso.` : `Falha ao encerrar '${processNameForCheck}': ${res.stderr.slice(0, 150) || 'processo nÃ£o encontrado'}`,
        simulated: false,
        timestamp: new Date().toISOString()
      };
    }

    // ---- launch (R2 â€” executa app no SO) ----
    if (params.action === 'launch') {
      const rawApp = (params.appPath || '').trim();
      if (!rawApp) return { success: false, error: 'MISSING_APP: informe appPath para abrir o aplicativo.', simulated: false, timestamp: new Date().toISOString() };
      // Bloqueio de injeÃ§Ã£o: sem metacaracteres de shell
      if (/[;&|`$<>]/.test(rawApp)) return { success: false, error: 'COMMAND_INJECTION_BLOCKED: caracteres perigosos no appPath.', simulated: false, timestamp: new Date().toISOString() };
      const app = platform === 'win32' ? resolveWindowsAppExecutable(rawApp) : rawApp;

      // Adaptabilidade Cloud Web Preview (Linux headless sem display grÃ¡fico)
      if (!isOsDryRun() && shouldUseWebPreviewDesktopFallback()) {
        return {
          success: true,
          action: 'launch',
          app,
          simulated: true,
          runtimeMode: 'web-preview-simulated',
          message: `[MODO WEB PREVIEW - SIMULADO] Abertura de '${app}' simulada (ambiente em nuvem sem interface grÃ¡fica de desktop).`,
          timestamp: new Date().toISOString()
        };
      }

      if (platform === 'win32') {
        if (isOsDryRun()) {
          return { success: true, action: 'launch', app, simulated: true, message: `[DRY-RUN] Abertura de '${app}' simulada (LIORA_NO_BROWSER=1).`, timestamp: new Date().toISOString() };
        }
        
        const wState = params.windowState || 'foreground';
        const winStyleParam = (wState === 'background' || wState === 'minimized')
          ? " -WindowStyle Minimized"
          : (wState === 'maximized' ? " -WindowStyle Maximized" : "");

        const appExeClean = app.replace(/\.exe$/i, '').replace(/["']/g, '');

        // Se o usuário pediu em primeiro plano / na frente e o app já estiver aberto, foca a janela existente!
        // Se pediu em segundo plano e já estiver aberto, mantém em segundo plano sem roubar o foco.
        const ps = `
$target = '${app.replace(/'/g, "''")}';
$clean = '${appExeClean.replace(/'/g, "''")}';
$wState = '${wState}';
$wsh = New-Object -ComObject WScript.Shell;
$existing = Get-Process -Name $clean -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;

if ($existing) {
  if ($wState -eq 'background' -or $wState -eq 'minimized') {
    Write-Output 'OK_BACKGROUND';
  } else {
    $wsh.AppActivate($existing.Id) | Out-Null;
    Write-Output 'OK_FOCUSED';
  }
} else {
  # Resolve o executavel pelo nome (notepad vira o caminho absoluto no PATH).
  # BUG CORRIGIDO: Start-Process -FilePath com nome sem extensao NAO resolve
  # quando o diretorio atual nao esta no PATH; o catch engolia a falha e
  # respondia FAIL sem motivo. Get-Command replica a resolucao do shell.
  # ATENCAO: nenhum "$NT/TEMP" ou caminho com cifrao aqui — o PowerShell
  # expande dentro de comentario e quebra o bloco.
  $resolved = $target;
  if (-not (Test-Path -LiteralPath $target)) {
    $app = Get-Command -Name $target -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1;
    if ($app) { $resolved = $app.Source; }
  }
  try {
    Start-Process -FilePath $resolved${winStyleParam} -ErrorAction Stop;
    if ($wState -eq 'foreground') {
      Start-Sleep -Milliseconds 600;
      $p2 = Get-Process -Name $clean -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;
      if ($p2) { $wsh.AppActivate($p2.Id) | Out-Null; }
    }
    Write-Output 'OK';
  } catch {
    Write-Output ('FAIL: ' + $_.Exception.Message);
  }
}`;
        const res = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 15000);
        const ok = res.code === 0 && (res.stdout.includes('OK') || res.stdout.includes('OK_FOCUSED') || res.stdout.includes('OK_BACKGROUND'));
        const isFocused = res.stdout.includes('OK_FOCUSED');
        const isAlreadyBackground = res.stdout.includes('OK_BACKGROUND');
        // Propaga o motivo REAL da falha (antes só aparecia "código 0" ou stderr vazio).
        const failMatch = /FAIL:\s*(.+)/.exec(res.stdout);
        const failReason = failMatch?.[1]?.trim() || res.stderr.slice(0, 200).trim();
        return {
          success: ok,
          action: 'launch',
          app,
          windowState: wState,
          message: ok
            ? (isFocused
                ? `Aplicativo '${app}' já estava aberto e foi trazido para o primeiro plano na sua tela, Mestre.`
                : isAlreadyBackground
                  ? `Aplicativo '${app}' já está em execução no computador em segundo plano.`
                  : `Aplicativo '${app}' iniciado com sucesso (${wState === 'background' ? 'em segundo plano' : 'em primeiro plano'}).`)
            : `Falha ao iniciar '${app}': ${failReason || `código ${res.code}`}.`,
          error: ok ? undefined : (failReason || `Falha ao iniciar '${app}' (código ${res.code}).`),
          simulated: false,
          timestamp: new Date().toISOString()
        };
      }
      const res = await runFile(platform === 'darwin' ? 'open' : 'xdg-open', [app], 8000);
      return {
        success: res.code === 0,
        action: 'launch',
        app,
        message: res.code === 0
          ? `Aplicativo '${app}' iniciado.`
          : `Falha ao iniciar '${app}': ${res.stderr.slice(0, 150) || `código ${res.code}`}.`,
        error: res.code === 0 ? undefined : (res.stderr.slice(0, 150) || `Falha ao iniciar '${app}' (código ${res.code}).`),
        simulated: false,
        timestamp: new Date().toISOString()
      };
    }

    // ---- focus (R1 — traz janela para frente via AppleScript/powershell) ----
    if (params.action === 'focus') {
      const rawTarget = (params.windowTitle || params.processName || params.appPath || (params.pid ? String(params.pid) : '')).trim();
      if (!rawTarget) return { success: false, error: 'MISSING_TARGET: informe windowTitle, processName ou appPath para focar a janela.', simulated: false, timestamp: new Date().toISOString() };
      
      const resolvedApp = platform === 'win32' ? resolveWindowsAppExecutable(rawTarget) : rawTarget;
      const cleanTarget = resolvedApp.replace(/\.exe$/i, '').trim();

      if (!isOsDryRun() && shouldUseWebPreviewDesktopFallback()) {
        return {
          success: true,
          action: 'focus',
          target: rawTarget,
          simulated: true,
          runtimeMode: 'web-preview-simulated',
          message: `[MODO WEB PREVIEW - SIMULADO] Foco na janela '${rawTarget}' simulado em ambiente sem desktop.`,
          timestamp: new Date().toISOString()
        };
      }
      if (platform === 'win32') {
        const ps = `
$target = '${rawTarget.replace(/'/g, "''")}';
$clean = '${cleanTarget.replace(/'/g, "''")}';
$wsh = New-Object -ComObject WScript.Shell;
$act = $false;

if ($target -match '^\\d+$') {
  $act = $wsh.AppActivate([int]$target);
} else {
  $proc = Get-Process -Name $clean -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;
  if ($proc) {
    $act = $wsh.AppActivate($proc.Id);
  }
  if (-not $act) {
    $procByTitle = Get-Process -ErrorAction SilentlyContinue | Where-Object { ($_.MainWindowTitle -like "*$target*" -or $_.MainWindowTitle -like "*$clean*") -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1;
    if ($procByTitle) {
      $act = $wsh.AppActivate($procByTitle.Id);
    }
  }
  if (-not $act) {
    $act = $wsh.AppActivate($target);
  }
  if (-not $act) {
    $act = $wsh.AppActivate($clean);
  }
}
if ($act) { Write-Output 'OK' } else { Write-Output 'FAIL' }`;
        const res = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 8000);
        const ok = res.stdout.includes('OK');
        return {
          success: ok,
          action: 'focus',
          target: rawTarget,
          message: ok ? `Janela de '${rawTarget}' focada e trazida para primeiro plano na sua tela, Mestre.` : `Janela de '${rawTarget}' não encontrada aberta para focar.`,
          simulated: false,
          timestamp: new Date().toISOString()
        };
      }
      if (platform === 'darwin') {
        const res = await runReal(`osascript -e 'tell application "System Events" to set frontmost of first process whose name contains "${rawTarget.replace(/"/g, '')}" to true'`, 8000);
        return { success: res.code === 0, action: 'focus', target: rawTarget, simulated: false, timestamp: new Date().toISOString() };
      }
      const res = await runReal(`wmctrl -a ${JSON.stringify(rawTarget)} 2>/dev/null || xdotool search --name ${JSON.stringify(rawTarget)} windowactivate 2>/dev/null`, 8000);
      return { success: res.code === 0, action: 'focus', target: rawTarget, simulated: false, timestamp: new Date().toISOString() };
    }

    // ---- minimize / maximize / restore (R1) ----
    if (params.action === 'minimize' || params.action === 'maximize' || params.action === 'restore') {
      const rawTarget = (params.windowTitle || params.processName || params.appPath || (params.pid ? String(params.pid) : '')).trim();
      const resolvedApp = platform === 'win32' && rawTarget ? resolveWindowsAppExecutable(rawTarget) : rawTarget;
      const cleanTarget = resolvedApp ? resolvedApp.replace(/\.exe$/i, '').trim() : '';

      if (isOsDryRun() || shouldUseWebPreviewDesktopFallback()) {
        return {
          success: true,
          action: params.action,
          target: rawTarget || 'janela ativa',
          simulated: true,
          runtimeMode: 'web-preview-simulated',
          message: `[MODO WEB PREVIEW - SIMULADO] Ação '${params.action}' simulada na janela '${rawTarget || 'ativa'}'.`,
          timestamp: new Date().toISOString()
        };
      }

      if (platform === 'win32') {
        // nCmdShow: 2 = SW_SHOWMINIMIZED, 3 = SW_SHOWMAXIMIZED, 9 = SW_RESTORE
        const nCmd = params.action === 'minimize' ? 2 : (params.action === 'maximize' ? 3 : 9);
        const ps = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinShowHelper {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@ -ErrorAction SilentlyContinue

$target = '${rawTarget.replace(/'/g, "''")}';
$clean = '${cleanTarget.replace(/'/g, "''")}';
$nCmd = ${nCmd};
$done = $false;

if ($target -and $target -match '^\\d+$') {
  $p = Get-Process -Id ([int]$target) -ErrorAction SilentlyContinue;
  if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
    [WinShowHelper]::ShowWindowAsync($p.MainWindowHandle, $nCmd) | Out-Null;
    $done = $true;
  }
}

if (-not $done -and $clean) {
  $proc = Get-Process -Name $clean -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1;
  if ($proc) {
    [WinShowHelper]::ShowWindowAsync($proc.MainWindowHandle, $nCmd) | Out-Null;
    $done = $true;
  }
}

if (-not $done -and $target) {
  $procByTitle = Get-Process -ErrorAction SilentlyContinue | Where-Object { ($_.MainWindowTitle -like "*$target*" -or $_.MainWindowTitle -like "*$clean*") -and $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1;
  if ($procByTitle) {
    [WinShowHelper]::ShowWindowAsync($procByTitle.MainWindowHandle, $nCmd) | Out-Null;
    $done = $true;
  }
}

if (-not $done -and -not $target) {
  $fg = [WinShowHelper]::GetForegroundWindow();
  if ($fg -ne [IntPtr]::Zero) {
    [WinShowHelper]::ShowWindowAsync($fg, $nCmd) | Out-Null;
    $done = $true;
  }
}

if ($done) { Write-Output "OK" } else { Write-Output "FAIL" }
`;
        const res = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 8000);
        const ok = res.code === 0 && res.stdout.includes('OK');
        const verbMap: Record<string, string> = { minimize: 'minimizada', maximize: 'maximizada', restore: 'restaurada' };
        return {
          success: ok,
          action: params.action,
          target: rawTarget || 'janela ativa',
          message: ok
            ? `Janela de '${rawTarget || 'ativa'}' ${verbMap[params.action] || params.action} com sucesso, Mestre.`
            : `Não foi possível localizar a janela de '${rawTarget || 'ativa'}' aberta para ${params.action}.`,
          simulated: false,
          timestamp: new Date().toISOString()
        };
      }

      if (platform === 'darwin') {
        const script = params.action === 'minimize'
          ? `osascript -e 'tell application "System Events" to set miniaturized of window 1 of (first process whose name contains "${cleanTarget}") to true'`
          : `osascript -e 'tell application "System Events" to set frontmost of (first process whose name contains "${cleanTarget}") to true'`;
        const res = await runReal(script, 8000);
        return { success: res.code === 0, action: params.action, target: rawTarget, simulated: false, timestamp: new Date().toISOString() };
      }

      return { success: true, action: params.action, target: rawTarget, simulated: true, timestamp: new Date().toISOString() };
    }

    return { success: false, error: `UNKNOWN_ACTION: '${params.action}' nÃ£o suportada.`, simulated: false, timestamp: new Date().toISOString() };
  }
};

/**
 * pc_simulate_input (R2) â€” automaÃ§Ã£o real de mouse e teclado.
 * actions: click (x,y), type (texto), hotkey (combinaÃ§Ã£o de teclas)
 * Windows: PowerShell SendKeys + user32.dll para mouse via Add-Type.
 */
export const pcSimulateInputTool: ToolDefinition<{
  action: 'click' | 'type' | 'hotkey';
  x?: number;
  y?: number;
  text?: string;
  keys?: string;
  targetApp?: string;
  doubleClick?: boolean;
  waitFocusMs?: number;
}, any> = {
  name: 'pc_simulate_input',
  description: 'Automatiza entrada do usuário no PC: move o mouse e clica em coordenadas (x,y) da tela, digita texto no app focado, ou envia combinações de teclas (ex: "ctrl+s", "ctrl+w", "ctrl+t", "ctrl+2, ctrl+w", "alt+tab", "enter"). Permite informar targetApp (ex: "chrome", "notepad") para garantir foco no app correto antes de enviar teclas.',
  category: 'system',
  riskLevel: 'R2', // todo input simulado é R2 — pode agir em qualquer app do usuário
  isSimulated: false,
  timeoutMs: 15000,
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['click', 'type', 'hotkey'], description: 'Tipo de entrada a simular.' },
      x: { type: 'number', description: 'Coordenada X na tela para clique (obrigatório para click).' },
      y: { type: 'number', description: 'Coordenada Y na tela para clique (obrigatório para click).' },
      doubleClick: { type: 'boolean', description: 'Se true, executa duplo clique no ponto.' },
      text: { type: 'string', description: 'Texto a digitar (máx 1000 caracteres) para action=type.' },
      keys: { type: 'string', description: 'Combinação de teclas para action=hotkey, ex: "ctrl+s", "ctrl+w", "ctrl+t", "ctrl+2, ctrl+w", "alt+tab", "enter". Aceita sequências separadas por vírgula.' },
      targetApp: { type: 'string', description: 'Nome do app ou processo (ex: "chrome", "notepad") para focar ANTES de simular a entrada, garantindo que o comando seja recebido pelo aplicativo correto.' },
      waitFocusMs: { type: 'number', description: 'Ms de espera pela estabilização do foco da janela antes de digitar (0-5000, padrão 400). Use após abrir um app na mesma sequência.' }
    },
    required: ['action'],
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'action', 'simulated'] },
  execute: async (params) => {
    const platform = os.platform();
    const isDryRun = isOsDryRun();
    const isWebPreviewSimulated = !isDryRun && shouldUseWebPreviewDesktopFallback();

    // ---- click (x, y) ----
    if (params.action === 'click') {
      const x = Math.round(params.x ?? -1);
      const y = Math.round(params.y ?? -1);
      if (x < 0 || y < 0) return { success: false, error: 'MISSING_COORDS: informe x e y para o clique.', simulated: false, timestamp: new Date().toISOString() };
      if (isDryRun) {
        return { success: true, action: 'click', x, y, doubleClick: Boolean(params.doubleClick), simulated: true, timestamp: new Date().toISOString() };
      }
      if (isWebPreviewSimulated) {
        return {
          success: true,
          action: 'click',
          x,
          y,
          doubleClick: Boolean(params.doubleClick),
          simulated: true,
          runtimeMode: 'web-preview-simulated',
          message: `[MODO WEB PREVIEW - SIMULADO] Clique em (${x}, ${y}) simulado (ambiente em nuvem sem interface grÃ¡fica de desktop).`,
          timestamp: new Date().toISOString()
        };
      }
      if (platform !== 'win32' && platform !== 'darwin') {
        return { success: false, error: 'INPUT_UNSUPPORTED: automaÃ§Ã£o de clique nativa suportada apenas no Windows e macOS nesta fase (Linux requer xdotool instalado).', simulated: false, timestamp: new Date().toISOString() };
      }
      if (platform === 'win32') {
        // BOM UTF-8 + SetCursorPos funciona com coordenadas inteiras â€” sem problema
        const clicks = params.doubleClick ? 2 : 1;
        const ps = `
Add-Type @"
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
        const res = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 15000);
        const ok = res.stdout.includes('OK');
        return { success: ok, action: 'click', x, y, doubleClick: Boolean(params.doubleClick), message: ok ? `Clique executado em (${x}, ${y}).` : `Falha no clique: ${res.stderr.slice(0, 150)}`, simulated: false, timestamp: new Date().toISOString() };
      }
      // macOS: osascript
      const script = params.doubleClick
        ? `osascript -e 'tell application "System Events" to click at {${x}, ${y}}' -e 'delay 0.08' -e 'tell application "System Events" to click at {${x}, ${y}}'`
        : `osascript -e 'tell application "System Events" to click at {${x}, ${y}}'`;
      const res = await runReal(script, 15000);
      return { success: res.code === 0, action: 'click', x, y, simulated: false, timestamp: new Date().toISOString() };
    }

    // ---- type (texto) ----
    if (params.action === 'type') {
      const text = (params.text || '').slice(0, 1000);
      if (!text) return { success: false, error: 'MISSING_TEXT: informe o texto a digitar.', simulated: false, timestamp: new Date().toISOString() };
      if (isDryRun) {
        return { success: true, action: 'type', length: text.length, dryRun: true, simulated: true, timestamp: new Date().toISOString() };
      }
      if (isWebPreviewSimulated) {
        return {
          success: true,
          action: 'type',
          length: text.length,
          simulated: true,
          runtimeMode: 'web-preview-simulated',
          message: `[MODO WEB PREVIEW - SIMULADO] DigitaÃ§Ã£o de ${text.length} caractere(s) simulada (ambiente em nuvem sem interface grÃ¡fica de desktop).`,
          timestamp: new Date().toISOString()
        };
      }
      if (platform !== 'win32' && platform !== 'darwin') {
        return { success: false, error: 'INPUT_UNSUPPORTED: digitaÃ§Ã£o nativa suportada apenas no Windows e macOS nesta fase (Linux requer xdotool instalado).', simulated: false, timestamp: new Date().toISOString() };
      }

      // CORREÃ‡ÃƒO (timeout 5000ms em pc_simulate_input): antes, abriam-se DOIS processos
      // PowerShell separados (1Âº compilando C# WinFocus + polling loop de 250ms, 2Âº WScript.Shell
      // SendKeys), ultrapassando facilmente 5s em cold start. Agora consolidamos numa ÃšNICA
      // invocaÃ§Ã£o PowerShell leve com timeout de 15000ms e resoluÃ§Ã£o imediata apÃ³s SendKeys.
      const waitBeforeType = Math.max(0, Math.min(5000, params.waitFocusMs ?? 400));

      if (platform === 'win32') {
        const escaped = text
          .replace(/\r\n|\r/g, '\n')
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')  // controles exceto \n (0x0A) e \t (0x09)
          .replace(/([+^%~(){}[\]])/g, '{$1}')
          .replace(/'/g, "''")
          .replace(/\n/g, '{ENTER}')
          .replace(/\t/g, '{TAB}');
        const sleepStep = waitBeforeType > 0 ? `Start-Sleep -Milliseconds ${waitBeforeType}; ` : '';
        
        let focusStep = '';
        if (params.targetApp) {
          const resolved = resolveWindowsAppExecutable(params.targetApp);
          const clean = resolved.replace(/\.exe$/i, '').trim();
          const rawClean = params.targetApp.replace(/\.exe$/i, '').trim();
          focusStep = `
$targetClean = '${clean.replace(/'/g, "''")}';
$targetRaw = '${rawClean.replace(/'/g, "''")}';
$proc = Get-Process -Name $targetClean -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;
if (-not $proc) {
  $proc = Get-Process -Name $targetRaw -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;
}
if (-not $proc) {
  $proc = Get-Process -ErrorAction SilentlyContinue | Where-Object { ($_.MainWindowTitle -like "*$targetRaw*" -or $_.MainWindowTitle -like "*$targetClean*") -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1;
}
if ($proc) { $w.AppActivate($proc.Id) | Out-Null; Start-Sleep -Milliseconds 250; } else { $w.AppActivate($targetRaw) | Out-Null; Start-Sleep -Milliseconds 200; }
`;
        }

        const ps = `$w = New-Object -ComObject WScript.Shell; ${focusStep}${sleepStep}$w.SendKeys('${escaped}'); Write-Output "OK"`;
        const res = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 15000);
        const ok = res.code === 0 || res.stdout.includes('OK');
        return { success: ok, action: 'type', length: text.length, message: ok ? `Texto digitado (${text.length} caracteres) no app focado.` : `Falha ao digitar: ${res.stderr.slice(0, 150)}`, simulated: false, timestamp: new Date().toISOString() };
      }

      if (waitBeforeType > 0) {
        await new Promise(r => setTimeout(r, waitBeforeType));
      }
      const script = `osascript -e 'tell application "System Events" to keystroke ${JSON.stringify(text)}'`;
      const res = await runReal(script, 15000);
      return { success: res.code === 0, action: 'type', length: text.length, simulated: false, timestamp: new Date().toISOString() };
    }

    // ---- hotkey (combinação) ----
    if (params.action === 'hotkey') {
      const rawInput = (params.keys || '').trim();
      if (!rawInput) return { success: false, error: 'MISSING_KEYS: informe a combinação (ex: "ctrl+s", "ctrl+w", "ctrl+t", "ctrl+2, ctrl+w").', simulated: false, timestamp: new Date().toISOString() };
      
      const MODIFIER_MAP: Record<string, string> = {
        'ctrl': '^', 'control': '^', 'alt': '%', 'shift': '+', 'win': '^%'
      };
      const SPECIAL_KEY_MAP: Record<string, string> = {
        'enter': '{ENTER}', 'tab': '{TAB}', 'esc': '{ESC}', 'escape': '{ESC}',
        'backspace': '{BACKSPACE}', 'delete': '{DELETE}', 'del': '{DELETE}',
        'up': '{UP}', 'down': '{DOWN}', 'left': '{LEFT}', 'right': '{RIGHT}',
        'home': '{HOME}', 'end': '{END}', 'pageup': '{PGUP}', 'pagedown': '{PGDN}',
        'space': ' ', 'printscreen': '{PRTSC}',
        'f1': '{F1}', 'f2': '{F2}', 'f3': '{F3}', 'f4': '{F4}', 'f5': '{F5}',
        'f6': '{F6}', 'f7': '{F7}', 'f8': '{F8}', 'f9': '{F9}', 'f10': '{F10}',
        'f11': '{F11}', 'f12': '{F12}'
      };

      // Suporta sequências de teclas separadas por vírgula ou ponto-e-vírgula (ex: "ctrl+2, ctrl+w")
      const comboList = rawInput.split(/[,;]/).map(s => s.trim().toLowerCase()).filter(Boolean);
      const parsedSendKeysList: string[] = [];

      for (const combo of comboList) {
        const parts = combo.split('+').map(p => p.trim()).filter(Boolean);
        let modifiers = '';
        let key = '';
        let valid = true;

        for (const p of parts) {
          if (MODIFIER_MAP[p]) {
            modifiers += MODIFIER_MAP[p];
          } else if (SPECIAL_KEY_MAP[p]) {
            key += SPECIAL_KEY_MAP[p];
          } else if (/^[a-z0-9]$/i.test(p)) {
            key += p.toLowerCase();
          } else if (/^f([1-9]|1[0-2])$/i.test(p)) {
            key += `{${p.toUpperCase()}}`;
          } else {
            valid = false;
            break;
          }
        }

        const sendKeys = modifiers + key;
        if (!valid || !sendKeys) {
          return { success: false, error: `UNSUPPORTED_KEYS: combinação '${combo}' não suportada. Use ctrl/alt/shift/win + letras/números, ou enter/tab/esc/setas/f1-f12.`, simulated: false, timestamp: new Date().toISOString() };
        }
        parsedSendKeysList.push(sendKeys);
      }

      if (isDryRun) {
        return { success: true, action: 'hotkey', keys: rawInput, dryRun: true, simulated: true, timestamp: new Date().toISOString() };
      }

      if (isWebPreviewSimulated) {
        return {
          success: true,
          action: 'hotkey',
          keys: rawInput,
          simulated: true,
          runtimeMode: 'web-preview-simulated',
          message: `[MODO WEB PREVIEW - SIMULADO] Atalho '${rawInput}' simulado (ambiente em nuvem sem interface gráfica de desktop).`,
          timestamp: new Date().toISOString()
        };
      }

      if (platform === 'win32') {
        let focusStep = '';
        if (params.targetApp) {
          const resolved = resolveWindowsAppExecutable(params.targetApp);
          const clean = resolved.replace(/\.exe$/i, '').trim();
          const rawClean = params.targetApp.replace(/\.exe$/i, '').trim();
          focusStep = `
$targetClean = '${clean.replace(/'/g, "''")}';
$targetRaw = '${rawClean.replace(/'/g, "''")}';
$proc = Get-Process -Name $targetClean -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;
if (-not $proc) {
  $proc = Get-Process -Name $targetRaw -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;
}
if (-not $proc) {
  $proc = Get-Process -ErrorAction SilentlyContinue | Where-Object { ($_.MainWindowTitle -like "*$targetRaw*" -or $_.MainWindowTitle -like "*$targetClean*") -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1;
}
if ($proc) { $w.AppActivate($proc.Id) | Out-Null; Start-Sleep -Milliseconds 250; } else { $w.AppActivate($targetRaw) | Out-Null; Start-Sleep -Milliseconds 200; }
`;
        }

        const sendSteps = parsedSendKeysList
          .map(k => `$w.SendKeys('${k.replace(/'/g, "''")}'); Start-Sleep -Milliseconds 180;`)
          .join(' ');

        const ps = `$w = New-Object -ComObject WScript.Shell; ${focusStep}${sendSteps} Write-Output "OK"`;
        const res = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 15000);
        return {
          success: res.code === 0,
          action: 'hotkey',
          keys: rawInput,
          targetApp: params.targetApp,
          message: res.code === 0
            ? (params.targetApp ? `Atalho '${rawInput}' enviado com sucesso para '${params.targetApp}'.` : `Atalho '${rawInput}' enviado ao app focado.`)
            : `Falha no atalho: ${res.stderr.slice(0, 150)}`,
          simulated: false,
          timestamp: new Date().toISOString()
        };
      }

      if (platform === 'darwin') {
        for (const combo of comboList) {
          const macModifiers: string[] = [];
          if (combo.includes('ctrl') || combo.includes('control')) macModifiers.push('control down');
          if (combo.includes('alt') || combo.includes('option')) macModifiers.push('option down');
          if (combo.includes('shift')) macModifiers.push('shift down');
          if (combo.includes('win') || combo.includes('cmd') || combo.includes('command')) macModifiers.push('command down');
          
          const parts = combo.split('+').map(p => p.trim()).filter(Boolean);
          const lastKey = parts[parts.length - 1] || '';
          let script: string;
          if (lastKey && /^[a-z0-9]$/i.test(lastKey)) {
            const modStr = macModifiers.length > 0 ? ` using {${macModifiers.join(', ')}}` : '';
            script = `osascript -e 'tell application "System Events" to keystroke "${lastKey}"${modStr}'`;
          } else if (lastKey === 'enter') {
            const modStr = macModifiers.length > 0 ? ` using {${macModifiers.join(', ')}}` : '';
            script = `osascript -e 'tell application "System Events" to key code 36${modStr}'`;
          } else {
            script = `osascript -e 'tell application "System Events" to keystroke "${lastKey}"'`;
          }
          await runReal(script, 8000);
        }
        return { success: true, action: 'hotkey', keys: rawInput, simulated: false, timestamp: new Date().toISOString() };
      }

      if (platform === 'linux') {
        for (const combo of comboList) {
          const linuxKey = combo.replace('ctrl', 'ctrl').replace('win', 'super');
          await runReal(`xdotool key ${JSON.stringify(linuxKey)} 2>/dev/null`, 8000);
        }
        return { success: true, action: 'hotkey', keys: rawInput, simulated: false, timestamp: new Date().toISOString() };
      }

      return { success: true, action: 'hotkey', keys: rawInput, simulated: true, timestamp: new Date().toISOString() };
    }

    return { success: false, error: `UNKNOWN_ACTION: '${params.action}' nÃ£o suportada.`, simulated: false, timestamp: new Date().toISOString() };
  }
};

// ============================================================================
// MÃ“DULO 3 â€” GERENCIAMENTO UNIVERSAL DE ARQUIVOS
// ============================================================================

const USER_SEARCH_ROOTS = [
  path.join(os.homedir(), 'Desktop'),
  path.join(os.homedir(), 'Documents'),
  path.join(os.homedir(), 'Downloads'),
  path.join(os.homedir(), 'Pictures'),
  path.join(os.homedir(), '.liora', 'workspace')
];

const ALLOWED_SEARCH_ROOTS = [
  ...USER_SEARCH_ROOTS,
  os.tmpdir()
];

/** Garante que o caminho estÃ¡ dentro das raÃ­zes permitidas. Retorna null se OK, mensagem de erro se bloqueado. */
function checkSafePath(p: string): string | null {
  try {
    const resolved = path.resolve(p);
    if (resolved.split(path.sep).includes('..')) {
      return 'PATH_TRAVERSAL_BLOCKED: caminhos com ".." nÃ£o sÃ£o permitidos.';
    }
    const resolvedNorm = resolved.toLowerCase();
    const allowed = ALLOWED_SEARCH_ROOTS.some(root => {
      const rootResolved = path.resolve(root).toLowerCase();
      const rootWithSep = rootResolved.endsWith(path.sep) ? rootResolved : `${rootResolved}${path.sep}`;
      return resolvedNorm === rootResolved || resolvedNorm.startsWith(rootWithSep);
    });
    if (!allowed) {
      return `PATH_OUT_OF_SCOPE: caminho '${resolved}' fora das raÃ­zes permitidas (Desktop, Documents, Downloads, Pictures, workspace LIORA, temp).`;
    }
    return null;
  } catch {
    return 'PATH_INVALID: caminho malformado.';
  }
}

/** Compatibilidade: versÃ£o que lanÃ§a (usada internamente por fluxos que jÃ¡ capturam) */
function assertSafePath(p: string): void {
  const err = checkSafePath(p);
  if (err) throw new Error(err);
}

/** RaÃ­zes de busca padrÃ£o permitidas (pastas do usuÃ¡rio existentes) */
function defaultSearchRoots(): string[] {
  return USER_SEARCH_ROOTS.filter((r) => {
    try {
      return fs.existsSync(r);
    } catch {
      return false;
    }
  });
}

/**
 * file_search_and_read (R0) â€” busca recursiva real com filtros + leitura.
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
  description: 'Busca arquivos reais no disco do usuÃ¡rio (Desktop, Documentos, Downloads, Pictures e workspace LIORA) por nome ou conteÃºdo, com filtro por extensÃ£o (.txt, .pdf, .docx, .xlsx, .json, etc.), e pode ler o conteÃºdo total ou parcial. Use para "encontre meu relatÃ³rio", "abra o arquivo X", "o que estÃ¡ escrito no documento Y".',
  category: 'workspace',
  riskLevel: 'R0',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Termo de busca no nome do arquivo (case-insensitive). Vazio = listar todos com o filtro de extensÃ£o.' },
      extensions: { type: 'array', items: { type: 'string' }, description: 'Filtro por extensÃµes (ex: [".pdf", ".docx"]). Vazio = todos os arquivos.' },
      rootPath: { type: 'string', description: 'Pasta raiz para a busca. PadrÃ£o: pasta do usuÃ¡rio (Desktop/Docs/Downloads).' },
      maxResults: { type: 'number', description: 'MÃ¡ximo de resultados (1-100). PadrÃ£o 20.', default: 20 },
      readContent: { type: 'boolean', description: 'Se true, lÃª o conteÃºdo do(s) primeiro(s) arquivo(s) encontrado(s) (apenas texto: txt/json/md/csv/log/code).' },
      maxReadBytes: { type: 'number', description: 'MÃ¡ximo de bytes a ler por arquivo (padrÃ£o 10000).' }
    },
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'results', 'simulated'] },
  execute: async (params) => {
    try {
      const maxResults = Math.max(1, Math.min(100, params.maxResults || 20));
      let rootsToWalk: string[];
      let searchedRootLabel: string;

      if (params.rootPath) {
        const resolvedRoot = path.resolve(params.rootPath);
        const scopeErr = checkSafePath(resolvedRoot);
        if (scopeErr) {
          return { success: false, error: scopeErr, results: [], simulated: false, timestamp: new Date().toISOString() };
        }
        rootsToWalk = [resolvedRoot];
        searchedRootLabel = resolvedRoot;
      } else {
        rootsToWalk = defaultSearchRoots();
        searchedRootLabel = rootsToWalk.length > 0 ? rootsToWalk.join(', ') : USER_SEARCH_ROOTS.join(', ');
      }

      const exts = (params.extensions || []).map(e => e.toLowerCase().startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`);
      const queryLower = (params.query || '').toLowerCase();
      const results: Array<{ path: string; name: string; sizeBytes: number; modifiedAt: string; content?: string | null; truncated?: boolean; note?: string }> = [];

      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 6 || results.length >= maxResults) return;
        let entries: any[];
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
            } catch { /* arquivo travado/sem permissÃ£o â€” ignora */ }
          }
        }
      };

      for (const rootDir of rootsToWalk) {
        if (results.length >= maxResults) break;
        await walk(rootDir, 0);
      }

    // Ordena por modificaÃ§Ã£o mais recente
    results.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

    // Leitura de conteÃºdo (apenas formatos textuais seguros)
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
        } catch { /* leitura falhou â€” segue sem conteÃºdo */ }
      } else {
        first.content = null;
        first.truncated = false;
        first.note = `Formato binÃ¡rio '${path.extname(first.name)}' nÃ£o Ã© legÃ­vel como texto â€” use a captura de tela ou abra o arquivo no aplicativo adequado.`;
      }
    }

    return { success: true, searchedRoot: searchedRootLabel, query: queryLower || '(todos)', extensions: exts, results, count: results.length, simulated: false, timestamp: new Date().toISOString() };
    } catch (err: any) {
      return { success: false, error: `SEARCH_FAILED: ${err?.message || 'falha na varredura'}`, results: [], simulated: false, timestamp: new Date().toISOString() };
    }
  }
};

/**
 * file_write_and_modify (R2) â€” mutaÃ§Ã£o real de arquivos: criar, escrever,
 * editar, renomear, zipar e excluir. TODAS as operaÃ§Ãµes R2 (destructivas).
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
  description: 'Cria, escreve, edita, renomeia, compacta (.zip) e exclui arquivos e pastas no disco do usuÃ¡rio (Desktop, Documentos, Downloads, workspace LIORA). TODAS as operaÃ§Ãµes sÃ£o destrutivas ou mutÃ¡veis (R2) e exigem confirmaÃ§Ã£o explÃ­cita do operador antes de executar.',
  category: 'workspace',
  riskLevel: 'R2',
  isSimulated: false,
  timeoutMs: 70000, // zip usa 60s internamente â€” antes o registry abortava em 5s com falso timeout
  parameters: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['create', 'write', 'append', 'rename', 'delete', 'zip', 'mkdir'], description: 'OperaÃ§Ã£o a executar no arquivo/pasta.' },
      filePath: { type: 'string', description: 'Caminho absoluto ou relativo do arquivo/pasta alvo.' },
      content: { type: 'string', description: 'ConteÃºdo a gravar (create/write/append). MÃ¡x 1MB.' },
      newPath: { type: 'string', description: 'Novo caminho/nome para rename.' },
      sourcePath: { type: 'string', description: 'Pasta de origem para zip (zip empacota esta pasta).' },
      recursive: { type: 'boolean', description: 'Para mkdir/delete: aplicar recursivamente (padrÃ£o true para mkdir, false para delete).' }
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
        return { success: true, operation: op, filePath: target, totalBytes: stat.size, message: `ConteÃºdo adicionado ao final de '${path.basename(target)}' (total: ${stat.size} bytes).`, simulated: false, timestamp: new Date().toISOString() };
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
        let stat;
        try {
          stat = await fsp.stat(target);
        } catch (statErr: any) {
          if (statErr?.code === 'ENOENT') {
            return { success: false, operation: op, error: `FILE_NOT_FOUND: '${path.basename(target)}' nÃ£o foi encontrado no disco para exclusÃ£o.`, simulated: false, timestamp: new Date().toISOString() };
          }
          throw statErr;
        }
        if (stat.isDirectory()) {
          if (!recursive) return { success: false, operation: op, error: 'DIRECTORY_NOT_EMPTY_MODE: use recursive=true para excluir pastas.', simulated: false, timestamp: new Date().toISOString() };
          await fsp.rm(target, { recursive: true, force: false });
        } else {
          await fsp.unlink(target);
        }
        return { success: true, operation: op, filePath: target, message: `'${path.basename(target)}' excluÃ­do${stat.isDirectory() ? ' (pasta e conteÃºdo)' : ''}.`, simulated: false, timestamp: new Date().toISOString() };
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
          // PowerShell: Compress-Archive nativo (sem dependÃªncias)
          const ps = `Compress-Archive -Path '${source.replace(/'/g, "''")}\\*' -DestinationPath '${zipTarget.replace(/'/g, "''")}' -Force`;
          const res = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 60000);
          if (res.code !== 0) return { success: false, operation: op, error: `ZIP_FAILED: ${res.stderr.slice(0, 200)}`, simulated: false, timestamp: new Date().toISOString() };
        } else {
          const res = await runReal(`cd ${JSON.stringify(path.dirname(source))} && zip -r ${JSON.stringify(zipTarget)} ${JSON.stringify(path.basename(source))}`, 60000);
          if (res.code !== 0) return { success: false, operation: op, error: `ZIP_FAILED: ${res.stderr.slice(0, 200) || 'zip nÃ£o instalado'}`, simulated: false, timestamp: new Date().toISOString() };
        }
        const stat = await fsp.stat(zipTarget);
        return { success: true, operation: op, filePath: zipTarget, bytesWritten: stat.size, message: `Compactado em '${path.basename(zipTarget)}' (${Math.round(stat.size / 1024)} KB).`, simulated: false, timestamp: new Date().toISOString() };
      }

      return { success: false, operation: op, error: `UNKNOWN_OPERATION: '${op}' nÃ£o suportada.`, simulated: false, timestamp: new Date().toISOString() };
    } catch (err: any) {
      return { success: false, operation: op, error: `FILE_OPERATION_FAILED: ${err?.message || 'falha desconhecida no disco'}`, simulated: false, timestamp: new Date().toISOString() };
    }
  }
};

/**
 * open_application (R2 launch) â€” abre aplicativos diretamente pelo nome ou executÃ¡vel.
 * Resolve a expectativa do modelo ao receber comandos como "abre o spotify", "abre o bloco de notas", "inicie o chrome".
 */
export const openApplicationTool: ToolDefinition<{
  appName?: string;
  appPath?: string;
  application?: string;
}, any> = {
  name: 'open_application',
  description: 'Abre um aplicativo no computador pelo nome ou comando executÃ¡vel (ex: "spotify", "notepad", "calc", "chrome"). Risco R2.',
  category: 'system',
  riskLevel: 'R2',
  isSimulated: false,
  timeoutMs: 15000,
  parameters: {
    type: 'object',
    properties: {
      appName: { type: 'string', description: 'Nome do aplicativo a ser aberto (ex: "spotify", "notepad", "calc", "chrome").' },
      appPath: { type: 'string', description: 'Caminho ou comando executÃ¡vel alternativo do aplicativo.' },
      application: { type: 'string', description: 'Alias para o nome do aplicativo.' }
    },
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'simulated'] },
  execute: async (params) => {
    const rawTarget = (params?.appName || params?.appPath || params?.application || '').trim();
    if (!rawTarget) {
      return {
        success: false,
        error: 'MISSING_APP: informe o nome do aplicativo que deseja abrir (ex: "spotify", "calc", "notepad").',
        simulated: false,
        timestamp: new Date().toISOString()
      };
    }
    const platform = os.platform();
    const target = platform === 'win32' ? resolveWindowsAppExecutable(rawTarget) : rawTarget;
    return pcManageAppsTool.execute({
      action: 'launch',
      appPath: target
    });
  }
};

/**
 * open_browser (R2) â€” abre o navegador web real do usuÃ¡rio (Chrome, Edge, Opera ou padrÃ£o)
 * opcionalmente carregando uma URL HTTP/HTTPS segura, com adaptabilidade para Cloud Web Preview.
 */
export const openBrowserTool: ToolDefinition<{
  url?: string;
  browser?: 'default' | 'chrome' | 'msedge' | 'opera' | 'firefox';
}, any> = {
  name: 'open_browser',
  description: 'Abre o navegador web padrÃ£o (ou Chrome/Edge/Opera) no computador do usuÃ¡rio, com URL opcional HTTP/HTTPS. Risco R2.',
  category: 'system',
  riskLevel: 'R2',
  isSimulated: false,
  timeoutMs: 15000,
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL HTTP/HTTPS opcional para abrir no navegador (padrÃ£o: https://www.google.com).' },
      browser: { type: 'string', enum: ['default', 'chrome', 'msedge', 'opera', 'firefox'], description: 'Navegador preferido (padrÃ£o: default).' }
    },
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'url', 'browser', 'simulated'] },
  execute: async (params) => {
    const rawUrl = (params?.url || 'https://www.google.com').trim();
    const browser = (params?.browser || 'default').toLowerCase().trim() as 'default' | 'chrome' | 'msedge' | 'opera' | 'firefox';
    const ALLOWED_BROWSERS = new Set(['default', 'chrome', 'msedge', 'opera', 'firefox']);
    const safeBrowser = ALLOWED_BROWSERS.has(browser) ? browser : 'default';

    if (/[;&|`$<>]/.test(rawUrl)) {
      return {
        success: false,
        url: rawUrl,
        browser: safeBrowser,
        error: 'COMMAND_INJECTION_BLOCKED: caracteres perigosos detectados na URL.',
        simulated: false,
        timestamp: new Date().toISOString()
      };
    }

    const candidateUrl = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(candidateUrl);
    } catch {
      return {
        success: false,
        url: rawUrl,
        browser: safeBrowser,
        error: 'INVALID_URL: URL fornecida Ã© invÃ¡lida.',
        simulated: false,
        timestamp: new Date().toISOString()
      };
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return {
        success: false,
        url: rawUrl,
        browser: safeBrowser,
        error: `UNSAFE_URL_PROTOCOL: protocolo '${parsedUrl.protocol}' nÃ£o permitido. Use http:// ou https://.`,
        simulated: false,
        timestamp: new Date().toISOString()
      };
    }

    const safeUrl = parsedUrl.toString();

    if (isOsDryRun()) {
      return {
        success: true,
        url: safeUrl,
        browser: safeBrowser,
        dryRun: true,
        simulated: true,
        message: `[DRY-RUN] Navegador '${safeBrowser}' validado para URL '${safeUrl}'.`,
        timestamp: new Date().toISOString()
      };
    }

    if (shouldUseWebPreviewDesktopFallback()) {
      return {
        success: true,
        url: safeUrl,
        browser: safeBrowser,
        simulated: true,
        runtimeMode: 'web-preview-simulated',
        message: `[MODO WEB PREVIEW - SIMULADO] Abertura do navegador '${safeBrowser}' com URL '${safeUrl}' simulada no ambiente headless.`,
        timestamp: new Date().toISOString()
      };
    }

    const platform = os.platform();
    if (platform === 'win32') {
      // Navegadores podem estar ALI no PATH (chrome, msedge, opera). `Start-Process
      // -FilePath 'chrome'` sem resolução falha silenciosamente quando o dir
      // atual não está no PATH; resolvemos como o shell faria.
      const exeMap: Record<string, string> = { chrome: 'chrome', msedge: 'msedge', opera: 'opera', firefox: 'firefox' };
      const browserExe = exeMap[safeBrowser];
      let res: { code: number; stdout: string; stderr: string };
      if (safeBrowser === 'default' || !browserExe) {
        res = await runFile('rundll32.exe', ['url.dll,FileProtocolHandler', safeUrl], 8000);
      } else {
        const ps = `$exe = '${browserExe.replace(/'/g, "''")}';
$app = Get-Command -Name $exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1;
if (-not $app) { Write-Output 'NOT_INSTALLED'; exit 3 }
Start-Process -FilePath $app.Source -ArgumentList '${safeUrl.replace(/'/g, "''")}' -ErrorAction Stop;
Write-Output 'OK'`;
        const psRes = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 10000);
        res = { code: psRes.code, stdout: psRes.stdout, stderr: psRes.stdout.includes('NOT_INSTALLED') ? `NAVEGADOR_NAO_INSTALADO: '${browserExe}' não foi encontrado no PATH deste PC.` : psRes.stderr };
      }
      const ok = res.code === 0 && !res.stderr.includes('NAVEGADOR_NAO_INSTALADO');
      return {
        success: ok,
        url: safeUrl,
        browser: safeBrowser,
        message: ok
          ? `Navegador (${safeBrowser}) aberto em '${safeUrl}'.`
          : `Falha ao abrir navegador (${safeBrowser}): ${res.stderr.slice(0, 200) || `código ${res.code}`}`,
        error: ok ? undefined : (res.stderr.slice(0, 200) || `Falha ao iniciar navegador '${safeBrowser}'.`),
        simulated: false,
        timestamp: new Date().toISOString()
      };
    }

    if (platform === 'darwin') {
      const macAppMap: Record<string, string> = {
        chrome: 'Google Chrome',
        msedge: 'Microsoft Edge',
        opera: 'Opera',
        firefox: 'Firefox'
      };
      const args = safeBrowser !== 'default' && macAppMap[safeBrowser]
        ? ['-a', macAppMap[safeBrowser], safeUrl]
        : [safeUrl];
      const res = await runFile('open', args, 8000);
      return {
        success: res.code === 0,
        url: safeUrl,
        browser: safeBrowser,
        message: res.code === 0 ? `Navegador aberto em '${safeUrl}'.` : `Falha ao abrir navegador: ${res.stderr.slice(0, 150)}`,
        error: res.code === 0 ? undefined : (res.stderr.slice(0, 150) || 'Falha ao iniciar navegador no macOS.'),
        simulated: false,
        timestamp: new Date().toISOString()
      };
    }

    const linuxCmd = safeBrowser === 'default'
      ? 'xdg-open'
      : safeBrowser === 'chrome'
        ? 'google-chrome'
        : safeBrowser === 'msedge'
          ? 'microsoft-edge'
          : safeBrowser;
    const res = await runFile(linuxCmd, [safeUrl], 8000);
    return {
      success: res.code === 0,
      url: safeUrl,
      browser: safeBrowser,
      message: res.code === 0 ? `Navegador aberto em '${safeUrl}'.` : `Falha ao abrir navegador: ${res.stderr.slice(0, 150) || `cÃ³digo ${res.code}`}`,
      error: res.code === 0 ? undefined : (res.stderr.slice(0, 150) || 'Falha ao iniciar navegador no Linux.'),
      simulated: false,
      timestamp: new Date().toISOString()
    };
  }
};

// ============================================================================
// MÓDULO 4 — INSPEÇÃO DE INTERFACE (controle de apps sem adivinhar pixels)
// ============================================================================
//
// Por que existe (relato de campo): "peço para abrir um documento em branco e
// ela manda Ctrl+N, mas o app mostra uma tela de escolha". Adivinhar atalhos por
// programa não escala. A saída confiável no Windows é ENUMERAR a árvore real de
// janelas (Win32 EnumWindows/EnumChildWindows), que retorna o campo de edição,
// os botões e a barra de status de cada app. Isso é nativo, sem COM e estável —
// validado neste projeto com o Bloco de Notas (retorna `Edit` + status bar).
//
// UIAutomation foi testado e descartado: neste ambiente a árvore variou de 3 a
// 21 nós entre execuções, o que tornaria o comportamento não determinístico.

export const pcInspectAppUiTool: ToolDefinition<{
  target?: string;
  pid?: number;
  includeHidden?: boolean;
}, any> = {
  name: 'pc_inspect_app_ui',
  description: 'Inspeciona a interface REAL de um aplicativo aberto no Windows: lista janela, campos de edição, botões, listas e a barra de status (com o texto atual). Use ANTES de automatizar um app para descobrir o que está na tela — em vez de supor atalhos como Ctrl+N. Retorna nomes e identificadores que podem ser usados em pc_simulate_input.',
  category: 'system',
  riskLevel: 'R0',
  isSimulated: false,
  timeoutMs: 20000,
  parameters: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'Nome do processo ou parte do título da janela (ex: "notepad", "Word", "Chrome"). Se omitido, usa a janela em primeiro plano.' },
      pid: { type: 'number', description: 'PID exato do processo (opcional, tem prioridade sobre target).' },
      includeHidden: { type: 'boolean', description: 'Incluir janelas/controles ocultos (padrão false).', default: false }
    },
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'windows', 'simulated'] },
  execute: async (params) => {
    if (os.platform() !== 'win32') {
      return {
        success: false,
        windows: [],
        error: 'UI_INSPECT_UNSUPPORTED: inspeção de interface disponível apenas no Windows.',
        simulated: false,
        timestamp: new Date().toISOString()
      };
    }
    if (isOsDryRun()) {
      return { success: true, dryRun: true, windows: [], simulated: true, timestamp: new Date().toISOString() };
    }

    const safeTarget = String(params.target || '').replace(/[^\w\s.\-À-ÿ]/g, '').slice(0, 60);
    const pidArg = params.pid ? Number(params.pid) : 0;
    const includeHidden = params.includeHidden ? '$true' : '$false';

    const ps = `
$ErrorActionPreference = 'Stop';
$pidTarget = ${pidArg};
$target = '${safeTarget}';

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class LioraUi {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public static string Describe(uint pid, bool includeHidden, IntPtr onlyWindow) {
    var sb = new StringBuilder();
    EnumWindows((h, l) => {
      uint wpid; GetWindowThreadProcessId(h, out wpid);
      if (pid != 0) { if (wpid != pid) return true; }
      if (onlyWindow != IntPtr.Zero) { if (h != onlyWindow) return true; }
      if (!includeHidden) { if (!IsWindowVisible(h)) return true; }
      var title = new StringBuilder(512); GetWindowText(h, title, 512);
      if (title.Length == 0) return true;
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      RECT r; GetWindowRect(h, out r);
      sb.Append("WINDOW|" + title.ToString() + "|" + cls.ToString() + "|" + wpid + "|" + r.Left + "," + r.Top + "," + (r.Right-r.Left) + "x" + (r.Bottom-r.Top) + "[NL]");
      int idx = 0;
      EnumChildWindows(h, (c, l2) => {
        var ct = new StringBuilder(512); GetWindowText(c, ct, 512);
        var cc = new StringBuilder(256); GetClassName(c, cc, 256);
        bool vis = IsWindowVisible(c);
        bool en = IsWindowEnabled(c);
        bool visAllowed = includeHidden ? true : vis;
        if (!visAllowed) return true;
        RECT cr; GetWindowRect(c, out cr);
        string ctext = ct.ToString();
        if (ctext.Length == 0) ctext = "-";
        sb.Append("CHILD|" + idx + "|" + ctext + "|" + cc.ToString() + "|" + (vis ? "1" : "0") + "|" + (en ? "1" : "0") + "|" + cr.Left + "," + cr.Top + "," + (cr.Right-cr.Left) + "x" + (cr.Bottom-cr.Top) + "[NL]");
        idx++;
        return true;
      }, IntPtr.Zero);
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
}
"@
if ($pidTarget -eq 0 -and $target) {
  $cands = Get-Process -ErrorAction SilentlyContinue | Where-Object { ($_.ProcessName -like "*$target*") -or ($_.MainWindowTitle -like "*$target*") } | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1;
  if ($cands) { $pidTarget = [uint32]$cands.Id }
}
$onlyWindow = [IntPtr]::Zero;
if ($pidTarget -eq 0) { $onlyWindow = [LioraUi]::GetForegroundWindow(); }
$result = [LioraUi]::Describe([uint32]$pidTarget, ${includeHidden}, $onlyWindow)
Write-Output $result
`;

    const res = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; chcp 65001 > $null; ${ps}`], 18000);
    // Decodifica explicitamente como UTF-8 (execFile usa o codepage do SO).
    if (res.code !== 0 && !res.stdout.trim()) {
      return {
        success: false,
        windows: [],
        error: `UI_INSPECT_FAILED: ${res.stderr.slice(0, 200) || 'PowerShell não retornou dados'}`,
        simulated: false,
        timestamp: new Date().toISOString()
      };
    }

    const windows: any[] = [];
    let currentWindow: any = null;
    const parseRect = (raw: string) => {
      const [x, y, size] = String(raw || '').split(',');
      const [w, h] = String(size || '').split('x');
      return {
        left: Number(x) || 0,
        top: Number(y) || 0,
        width: Number(w) || 0,
        height: Number(h) || 0
      };
    };

    for (const rawLine of res.stdout.split('[NL]')) {
      const line = rawLine.trimEnd();
      if (!line) continue;
      const cols = line.split('|');
      if (cols[0] === 'WINDOW' && cols.length >= 5) {
        currentWindow = {
          title: cols[1],
          className: cols[2],
          pid: Number(cols[3]),
          rect: parseRect(cols[4]),
          controls: []
        };
        windows.push(currentWindow);
      } else if (cols[0] === 'CHILD' && currentWindow && cols.length >= 7) {
        currentWindow.controls.push({
          index: Number(cols[1]),
          text: cols[2] === '-' ? '' : cols[2],
          className: cols[3],
          visible: cols[4] === '1',
          enabled: cols[5] === '1',
          rect: parseRect(cols[6])
        });
      }
    }

    // Classificação amigável para o modelo decidir a ação certa.
    const classify = (cls: string): string => {
      const c = cls.toLowerCase();
      if (/^edit$|richedit|scintilla/.test(c)) return 'text_field';
      if (/button/.test(c)) return 'button';
      if (/systreeview|syslistview|listbox/.test(c)) return 'list';
      if (/combobox/.test(c)) return 'dropdown';
      if (/msctls_statusbar/.test(c)) return 'status_bar';
      if (/msctls_trackbar/.test(c)) return 'slider';
      if (/tab/.test(c)) return 'tabs';
      if (/toolbar/.test(c)) return 'toolbar';
      return 'other';
    };
    for (const w of windows) {
      for (const c of w.controls) c.kind = classify(c.className);
      w.summary = {
        textFields: w.controls.filter((c: any) => c.kind === 'text_field').length,
        buttons: w.controls.filter((c: any) => c.kind === 'button').length,
        lists: w.controls.filter((c: any) => c.kind === 'list').length,
        menus: w.controls.filter((c: any) => c.kind === 'other' && /menu/i.test(c.className)).length
      };
    }

    const main = windows[0];
    return {
      success: windows.length > 0,
      windows,
      count: windows.length,
      mainWindowTitle: main?.title,
      message: windows.length === 0
        ? 'Nenhuma janela encontrada para o alvo informado.'
        : `Janela '${main?.title}' inspecionada: ${main?.summary.textFields} campo(s) de texto, ${main?.summary.buttons} botão(ões), ${main?.summary.lists} lista(s).`,
      simulated: false,
      timestamp: new Date().toISOString()
    };
  }
};

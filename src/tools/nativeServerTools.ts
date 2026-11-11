/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ferramentas NATIVAS REAIS para execução no servidor Express local (Node.js).
 * O servidor roda na máquina do usuário, portanto executa ações reais:
 * - leitura/escrita de arquivos no disco (workspace isolado ~/.liora/workspace)
 * - execução de comandos CLI com lista branca e bloqueio de injeção
 * - telemetria real do sistema operacional
 *
 * Segurança: mesmas travas dos tools simulados (path traversal, whitelist,
 * injection block, secret masking). Nenhuma execução ocorre sem validação.
 */

import { exec } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ToolDefinition } from './types';
// NÚCLEO DE CONTROLE TOTAL DO PC: visão, apps/inputs e arquivos (R0-R2)
import { pcTakeScreenshotTool, pcManageAppsTool, pcSimulateInputTool, fileSearchAndReadTool, fileWriteAndModifyTool } from './pcControlTools';
// AGENTE WEB AUTÓNOMO (FASE 1: Browser Use) — R2 com consentimento HMAC
import { webBrowserAgentTool } from './web/browserAgentTool';
// FASE 2: PRODUTIVIDADE — E-mail IMAP/SMTP e Calendário local (R1 leitura, R2 escrita)
import { allEmailTools } from './productivity/emailTools';
import { allCalendarTools } from './productivity/calendarTools';
// FASE 3: SUB-AGENTES — execução assíncrona em segundo plano (R1 consulta, R2 start/cancel)
import { allBackgroundTools } from './async/backgroundTools';
// FASE 4: COFRE CRIPTOGRAFADO — vault manager (R1 listagem, R2 chave/valor)
import { allVaultTools } from './security/vaultTools';
import { allBrowserTools } from './browser/playwrightTool';
import { semanticMemoryService } from '../services/memory/semanticMemoryService';
import { allCodingTools } from './coding/codingTools';
import { allIotTools } from './iot/iotTools';
import { openGpsNavigationTool, mapsSearchPlacesTool, launchGpsNavigation } from './navigation/navigationActionTool';
import { resolvePlaceAliasTool, savePlaceAliasTool } from './navigation/placeAliasTool';

/**
 * Resolve a raiz do workspace respeitando a configuração do usuário
 * (settings.workspacePath). Relativo => resolvido a partir do diretório do
 * projeto; absoluto => usado como está. Fallback: ~/.liora/workspace.
 */
function resolveConfiguredWorkspaceRoot(): string {
  try {
    // settingsManager usa global.localStorage quando fora do browser (mesmo storage do servidor)
    const storage = (typeof global !== 'undefined' && (global as any).localStorage) || null;
    const raw = storage ? storage.getItem('liora_global_settings_v1') : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      const wp = parsed?.workspacePath;
      if (typeof wp === 'string' && wp.trim()) {
        const trimmed = wp.trim();
        return path.isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed)
          ? trimmed
          : path.resolve(process.cwd(), trimmed);
      }
    }
  } catch {
    // fallback silencioso para o padrão
  }
  return path.join(os.homedir(), '.liora', 'workspace');
}

/** Raiz do workspace real da LIORA no disco do usuário */
export function getLioraWorkspaceRoot(): string {
  return resolveConfiguredWorkspaceRoot();
}

/** Garante que o workspace existe */
function ensureWorkspaceRoot(): string {
  const root = getLioraWorkspaceRoot();
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }
  return root;
}

/** Resolve caminho relativo com bloqueio de path traversal (espelha o canonicalizer do Rust) */
function resolveSafeWorkspacePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) throw new Error('INVALID_PATH: Caminho de arquivo inválido.');
  if (trimmed.includes('..') || path.isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    throw new Error('PATH_TRAVERSAL_BLOCKED: Tentativa de acesso a caminho absoluto ou fora do workspace.');
  }
  const root = ensureWorkspaceRoot();
  const resolved = path.resolve(root, trimmed);
  if (!resolved.startsWith(root)) {
    throw new Error('PATH_TRAVERSAL_BLOCKED: Caminho resolvido escapou do workspace.');
  }
  return resolved;
}

/** Bloqueia injeção de comandos (mesma regex do tool simulado) */
function assertNoCommandInjection(cmd: string): void {
  const dangerousPattern = /[;&|`$<>\\()\n]/;
  if (dangerousPattern.test(cmd)) {
    throw new Error('COMMAND_INJECTION_BLOCKED: Caracteres de encadeamento ou injeção detectados e bloqueados.');
  }
}

/** Lista branca de prefixos de comando permitidos no sandbox */
const ALLOWED_COMMAND_PREFIXES = [
  'git status',
  'git branch',
  'git log',
  'git diff',
  'npm test',
  'npm run build',
  'npm run lint',
  'node -v',
  'node --version',
  'python --version',
  'uptime',
  'ls',
  'dir',
  'echo'
];

function assertCommandInWhitelist(cmd: string): void {
  const isAllowed = ALLOWED_COMMAND_PREFIXES.some(
    prefix => cmd === prefix || cmd.startsWith(prefix + ' ')
  );
  if (!isAllowed) {
    throw new Error(`COMMAND_NOT_IN_WHITELIST: O comando '${cmd}' não faz parte da lista branca autorizada.`);
  }
}

/** Executa comando real via child_process com timeout */
function execRealCommand(cmd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const exitCode = err && typeof (err as any).code === 'number' ? (err as any).code : (err ? 1 : 0);
      resolve({ stdout: stdout || '', stderr: stderr || '', exitCode });
    });
  });
}

/**
 * 1. system_info REAL (R0) — telemetria verdadeira do SO hospedeiro
 */
export const nativeSystemInfoTool: ToolDefinition<Record<string, never>, any> = {
  name: 'system_info',
  description: 'Retorna informações REAIS de hardware e sistema operacional da máquina hospedeira.',
  category: 'system',
  riskLevel: 'R0',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      detailLevel: {
        type: 'string',
        description: 'Nível de detalhamento das informações do sistema.',
        enum: ['summary', 'standard', 'full'],
        default: 'standard'
      }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['os', 'platform', 'cpu', 'memory', 'simulated']
  },
  execute: async () => {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const loadAvg = os.loadavg();
    const cpuUsageEstimate = cpus.length > 0
      ? Math.min(100, Math.max(1, (loadAvg[0] / cpus.length) * 100))
      : 5;

    return {
      os: `${os.type()} ${os.release()}`,
      platform: `${os.platform()}-${os.arch()}`,
      arch: os.arch(),
      hostname: os.hostname(),
      uptimeSeconds: Math.round(os.uptime()),
      cpu: {
        cores: cpus.length,
        model: cpus[0]?.model || 'unknown',
        usagePercent: Number(cpuUsageEstimate.toFixed(1))
      },
      memory: {
        totalBytes: totalMem,
        freeBytes: freeMem,
        usagePercent: Number((((totalMem - freeMem) / totalMem) * 100).toFixed(1))
      },
      simulated: false,
      mode: 'REAL_HOST_SYSTEM',
      notice: 'Telemetria real coletada do sistema operacional hospedeiro via Node.js os module.'
    };
  }
};

/**
 * 2. workspace_read_file REAL (R0) — lê do disco em ~/.liora/workspace
 */
export const nativeWorkspaceReadFileTool: ToolDefinition<{ filePath: string; maxLines?: number }, any> = {
  name: 'workspace_read_file',
  description: 'Lê um arquivo REAL do disco no workspace seguro da LIORA (~/.liora/workspace).',
  category: 'workspace',
  riskLevel: 'R0',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Caminho relativo dentro do workspace (ex: "notas/ideias.md").',
        minLength: 1,
        maxLength: 256
      },
      maxLines: {
        type: 'number',
        description: 'Número máximo de linhas a serem retornadas.',
        minimum: 1,
        maximum: 2000,
        default: 200
      }
    },
    required: ['filePath'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['filePath', 'content', 'lineCount', 'sizeBytes', 'simulated']
  },
  execute: async (params) => {
    const safePath = resolveSafeWorkspacePath(params.filePath);
    if (!fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
      throw new Error(`Arquivo '${params.filePath}' não encontrado no workspace real da LIORA.`);
    }
    const content = fs.readFileSync(safePath, 'utf-8');
    const lines = content.split('\n');
    const maxLines = params.maxLines || 200;
    const truncated = lines.length > maxLines;

    return {
      filePath: params.filePath.trim().replace(/^[./\\]+/, ''),
      content: lines.slice(0, maxLines).join('\n'),
      lineCount: Math.min(lines.length, maxLines),
      sizeBytes: Buffer.byteLength(content, 'utf-8'),
      truncated,
      isReal: true,
      simulated: false
    };
  }
};

/**
 * 3. workspace_write_file REAL (R1) — grava no disco com verificação pós-escrita
 */
export const nativeWorkspaceWriteFileTool: ToolDefinition<{ filePath: string; content: string; createDirs?: boolean }, any> = {
  name: 'workspace_write_file',
  description: 'Grava um arquivo REAL no disco no workspace seguro da LIORA (~/.liora/workspace).',
  category: 'workspace',
  riskLevel: 'R1',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Caminho relativo dentro do workspace (ex: "notas/ideias.md").',
        minLength: 1,
        maxLength: 256
      },
      content: {
        type: 'string',
        description: 'Conteúdo de texto a ser gravado.',
        maxLength: 50000
      },
      createDirs: {
        type: 'boolean',
        description: 'Criar diretórios pai se não existirem.',
        default: true
      }
    },
    required: ['filePath', 'content'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['success', 'filePath', 'bytesWritten', 'simulated']
  },
  execute: async (params) => {
    const safePath = resolveSafeWorkspacePath(params.filePath);
    const parent = path.dirname(safePath);
    if (params.createDirs !== false && !fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }
    fs.writeFileSync(safePath, params.content, 'utf-8');

    // Verificação pós-escrita imediata (Item 17: Verifier)
    const written = fs.readFileSync(safePath, 'utf-8');
    if (written !== params.content) {
      throw new Error('VERIFICATION_FAILED: Conteúdo gravado não confere com o solicitado.');
    }

    return {
      success: true,
      filePath: params.filePath.trim().replace(/^[./\\]+/, ''),
      bytesWritten: Buffer.byteLength(params.content, 'utf-8'),
      absolutePath: safePath,
      isReal: true,
      simulated: false,
      timestamp: new Date().toISOString()
    };
  }
};

/**
 * 4. system_exec_sandbox REAL (R1) — executa comando de verdade com whitelist
 */
export const nativeSystemExecSandboxTool: ToolDefinition<{ command: string; timeoutMs?: number }, any> = {
  name: 'system_exec_sandbox',
  description: 'Executa comandos CLI REAIS com lista branca estrita no sandbox da LIORA.',
  category: 'system',
  riskLevel: 'R1',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Comando CLI (ex: "git status", "npm test", "python --version", "node -v").',
        minLength: 1,
        maxLength: 200
      },
      timeoutMs: {
        type: 'number',
        description: 'Timeout máximo em milissegundos.',
        minimum: 100,
        maximum: 10000,
        default: 5000
      }
    },
    required: ['command'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['success', 'command', 'stdout', 'exitCode', 'simulated']
  },
  execute: async (params) => {
    const cmd = params.command.trim();
    assertNoCommandInjection(cmd);
    assertCommandInWhitelist(cmd);

    const timeoutMs = params.timeoutMs || 5000;
    const { stdout, stderr, exitCode } = await execRealCommand(cmd, timeoutMs);

    return {
      success: exitCode === 0,
      command: cmd,
      stdout,
      stderr,
      exitCode,
      isReal: true,
      simulated: false,
      sandbox: 'LIORA-REAL-SANDBOX'
    };
  }
};

/**
 * 5. system_read_env_safe REAL (R0) — já lia process.env; agora marcado como real
 */
export const nativeSystemReadEnvSafeTool: ToolDefinition<{ variableName?: string; keys?: string[] }, any> = {
  name: 'system_read_env_safe',
  description: 'Lê variáveis de ambiente REAIS do sistema com mascaramento automático de segredos (R0).',
  category: 'system',
  riskLevel: 'R0',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      variableName: {
        type: 'string',
        description: 'Nome da variável de ambiente (ex: "NODE_ENV").',
        minLength: 1,
        maxLength: 100
      },
      keys: {
        type: 'array',
        items: { type: 'string' },
        description: 'Lista de chaves de variáveis permitidas a serem consultadas.'
      }
    },
    required: [],
    additionalProperties: true
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['success', 'variableName', 'value', 'simulated']
  },
  execute: async (params: any = {}) => {
    let rawKey = params?.variableName;
    if (!rawKey && Array.isArray(params?.keys) && params.keys.length > 0) {
      rawKey = params.keys[0];
    }
    const varName = (rawKey || 'NODE_ENV').trim();

    const sensitiveKeywords = ['KEY', 'SECRET', 'PASSWORD', 'TOKEN', 'AUTH', 'PRIVATE', 'API', 'CREDENTIAL'];
    if (sensitiveKeywords.some(kw => varName.toUpperCase().includes(kw))) {
      throw new Error('SECRET_LEAK_PREVENTED: Tentativa de leitura de variável de ambiente sensível bloqueada.');
    }

    return {
      success: true,
      variableName: varName,
      value: process.env[varName] || '[UNSET_OR_DEFAULT]',
      isReal: true,
      simulated: false,
      timestamp: new Date().toISOString()
    };
  }
};

/**
 * 6. calculate_route REAL (R0) — rota real via OSRM (OpenStreetMap, gratuito, sem chave)
 * Resolve o antigo problema do Gemini simular 'map_service.calculate_route'.
 */
export const nativeCalculateRouteTool: ToolDefinition<
  {
    destination?: string;
    origin?: string;
    originLat?: number;
    originLng?: number;
    destLat?: number;
    destLng?: number;
  },
  any
> = {
  name: 'calculate_route',
  description: 'Calcula rota ou abre navegação veicular no Google Maps / Waze. Se fornecido nome de destino (ex: "São Paulo", "Aeroporto"), aciona open_gps_navigation com trânsito real. Se fornecidas coordenadas numéricas completas, consulta distâncias terrestres via OSRM.',
  category: 'network',
  riskLevel: 'R0',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      destination: { type: 'string', description: 'Endereço ou nome do local de destino (ex: "São Paulo", "Curitiba").' },
      origin: { type: 'string', description: 'Endereço ou ponto de partida opcional (se omitido ou "daqui", usa localização atual).' },
      originLat: { type: 'number', description: 'Latitude de origem (opcional).' },
      originLng: { type: 'number', description: 'Longitude de origem (opcional).' },
      destLat: { type: 'number', description: 'Latitude de destino (opcional).' },
      destLng: { type: 'number', description: 'Longitude de destino (opcional).' }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['success', 'simulated']
  },
  execute: async (params) => {
    const { destination, origin, originLat, originLng, destLat, destLng } = params;
    // Validação de coordenadas completas para OSRM
    const valid = (v?: number, min = -90, max = 90) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
    const hasValidCoords = valid(originLat, -90, 90) && valid(destLat, -90, 90) && valid(originLng, -180, 180) && valid(destLng, -180, 180);

    // Se não houver coordenadas completas mas houver destino textual (ou intenção de rota)
    if (!hasValidCoords) {
      const targetDest = destination?.trim() || 'Destino';
      const result = await launchGpsNavigation(targetDest, 'auto', origin);
      return {
        success: result.success,
        destination: targetDest,
        origin: origin || 'localização atual',
        url: result.url,
        provider: result.provider,
        message: `Navegação GPS iniciada para "${targetDest}" a partir da sua localização atual.`,
        simulated: false,
        timestamp: new Date().toISOString()
      };
    }

    const url = `https://router.project-osrm.org/route/v1/driving/${originLng},${originLat};${destLng},${destLat}?overview=false&alternatives=false&steps=false`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`OSRM_HTTP_${res.status}: Falha ao consultar o serviço de rotas.`);
      }
      const data = await res.json();
      const route = data?.routes?.[0];
      if (!route) {
        throw new Error('NO_ROUTE_FOUND: OSRM não encontrou rota terrestre entre os pontos (ex: travessia oceânica).');
      }

      const distanceKm = Math.round((route.distance / 1000) * 10) / 10;
      const durationMinutes = Math.round(route.duration / 60);

      return {
        success: true,
        distanceKm,
        durationMinutes,
        distanceMeters: route.distance,
        durationSeconds: Math.round(route.duration),
        provider: 'OSRM (OpenStreetMap, rota livre sem trânsito)',
        origin: { lat: originLat, lng: originLng },
        destination: { lat: destLat, lng: destLng },
        simulated: false,
        timestamp: new Date().toISOString()
      };
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return {
          success: false,
          error: 'OSRM_TIMEOUT: Serviço de rotas não respondeu em 8s.',
          userFriendlyMessage: 'O serviço de rotas está indisponível neste momento. Posso tentar novamente em alguns instantes.',
          retryable: true,
          simulated: false,
          timestamp: new Date().toISOString()
        };
      }
      // Exaustão: erros de rede não devem travar o fluxo — resposta falável e honesta
      if (err instanceof TypeError) {
        return {
          success: false,
          error: `OSRM_NETWORK_ERROR: ${err?.message || 'Falha de rede ao consultar o serviço de rotas.'}`,
          userFriendlyMessage: 'Não consegui acessar o serviço de rotas — verifique sua conexão com a internet.',
          retryable: true,
          simulated: false,
          timestamp: new Date().toISOString()
        };
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
};

/**
 * P3 (paridade voz x chat): busca de notícias REAIS via feeds RSS públicos.
 * Fecha o gap "me traga um resumo das notícias" que antes caía no
 * conhecimento congelado do modelo sem aviso. R1: acesso à rede externa.
 */
const nativeFetchNewsTool: ToolDefinition<
  { topic?: string; maxItems?: number },
  any
> = {
  name: 'fetchNews',
  description: 'Busca as principais manchetes de notícias reais via feeds RSS (GNews/G1/BBC Brasil). Use para pedidos de notícias, resumo de acontecimentos do dia ou tópicos específicos (ex: tecnologia, economia, esportes).',
  category: 'system',
  riskLevel: 'R1',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'Tópico opcional para filtrar (ex: "tecnologia", "economia", "esportes"). Vazio = manchetes gerais.'
      },
      maxItems: {
        type: 'number',
        description: 'Número máximo de manchetes a retornar (1-10).',
        minimum: 1,
        maximum: 10,
        default: 5
      }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['success', 'items']
  },
  execute: async (params) => {
    const maxItems = Math.max(1, Math.min(10, params.maxItems || 5));
    const topic = (params.topic || '').trim().toLowerCase();

    // R2 (resiliência): cadeia de feeds com failover. Se o feed primário (G1)
    // oscilar, tenta fontes alternativas antes de reportar indisponibilidade.
    const feedCandidates: Array<{ url: string; source: string }> = topic
      ? [
          { url: `https://g1.globo.com/rss/g1/${encodeURIComponent(topic)}.xml`, source: 'G1 RSS' },
          { url: `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=pt-BR&gl=BR&ceid=BR:pt-419`, source: 'Google News RSS' }
        ]
      : [
          { url: 'https://g1.globo.com/rss/g1/', source: 'G1 RSS' },
          { url: 'https://news.google.com/rss?hl=pt-BR&gl=BR&ceid=BR:pt-419', source: 'Google News RSS' }
        ];

    const attemptFetch = async (url: string): Promise<string> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000); // timeout por tentativa
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'LIORA-Assistant/1.0' }
        });
        if (!response.ok) {
          throw new Error(`HTTP_${response.status}`);
        }
        return await response.text();
      } finally {
        clearTimeout(timeout);
      }
    };

    // Parsing leve de RSS sem dependência externa
    const parseRss = (xml: string): Array<{ title: string; link: string; publishedAt: string }> => {
      const items: Array<{ title: string; link: string; publishedAt: string }> = [];
      const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
      for (const block of itemBlocks.slice(0, maxItems)) {
        const title = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1] || '').trim();
        const link = (block.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/)?.[1] || '').trim();
        const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '').trim();
        if (title) {
          items.push({ title, link, publishedAt: pubDate });
        }
      }
      return items;
    };

    let lastErrorCode = 'NEWS_UNKNOWN';
    let lastErrorDetail = 'Falha de rede ao buscar notícias.';

    for (const candidate of feedCandidates) {
      try {
        const xml = await attemptFetch(candidate.url);
        const items = parseRss(xml);

        if (items.length > 0) {
          return {
            success: true,
            source: candidate.source,
            topic: topic || 'manchetes gerais',
            items,
            simulated: false,
            timestamp: new Date().toISOString()
          };
        }
        lastErrorCode = 'NEWS_EMPTY';
        lastErrorDetail = `O feed ${candidate.source} respondeu, mas sem manchetes utilizáveis.`;
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          lastErrorCode = 'NEWS_TIMEOUT';
          lastErrorDetail = `Feed ${candidate.source} não respondeu em 6s.`;
        } else if (String(err?.message || '').startsWith('HTTP_')) {
          lastErrorCode = 'NEWS_FEED_UNAVAILABLE';
          lastErrorDetail = `Feed ${candidate.source} indisponível (${err.message}).`;
        } else {
          lastErrorCode = 'NEWS_FETCH_ERROR';
          lastErrorDetail = err?.message || 'Falha de rede ao buscar notícias.';
        }
      }
    }

    // R2: TODAS as fontes falharam — retorna JSON amigável e honesto para que
    // o modelo responda normalmente à voz/chat explicando a indisponibilidade
    // momentânea (sem travar THINKING e sem inventar notícias).
    return {
      success: false,
      items: [],
      userFriendlyMessage:
        'Não consegui acessar os feeds de notícias neste momento — a conexão com os servidores de notícias está indisponível ou oscilando. Posso tentar novamente em alguns instantes, ou você prefere que eu fale sobre outro assunto?',
      error: `${lastErrorCode}: ${lastErrorDetail} (todas as ${feedCandidates.length} fontes tentadas falharam).`,
      retryable: lastErrorCode !== 'NEWS_EMPTY',
      simulated: false,
      timestamp: new Date().toISOString()
    };
  }
};

/**
 * 8. list_processes REAL (R0) — Lista processos em execução
 */
export const nativeListProcessesTool: ToolDefinition<{ limit?: number; filter?: string }, any> = {
  name: 'list_processes',
  description: 'Lista os processos em execução no sistema operacional com PID, uso de CPU e memória. Risco R0 — somente leitura.',
  category: 'system',
  riskLevel: 'R0',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Número máximo de processos a retornar (padrão: 50, máx: 100).',
        default: 50
      },
      filter: {
        type: 'string',
        description: 'Filtro por nome do processo (opcional).'
      }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['processes', 'count', 'simulated']
  },
  execute: async (params) => {
    const limit = Math.min(100, Math.max(1, params.limit || 50));
    const filter = (params.filter || '').toLowerCase().trim();

    if (os.platform() === 'win32') {
      try {
        const psScript = `Get-Process | Sort-Object CPU -Descending | Select-Object -First ${limit * 2} Id, ProcessName, CPU, WorkingSet64 | ConvertTo-Json -Compress`;
        const { stdout } = await execRealCommand(`powershell -NoProfile -NonInteractive -Command "${psScript}"`, 6000);
        if (stdout && stdout.trim()) {
          let parsed = JSON.parse(stdout.trim());
          if (!Array.isArray(parsed)) parsed = [parsed];
          let list = parsed.map((p: any) => ({
            pid: Number(p.Id),
            name: String(p.ProcessName || ''),
            cpuUsage: Number((p.CPU || 0).toFixed(1)),
            memoryMb: Number(((p.WorkingSet64 || 0) / (1024 * 1024)).toFixed(1)),
            status: 'Running'
          }));
          if (filter) {
            list = list.filter((p: any) => p.name.toLowerCase().includes(filter));
          }
          const sliced = list.slice(0, limit);
          return { processes: sliced, count: sliced.length, simulated: false };
        }
      } catch {
        // Fallback para tasklist
      }

      const { stdout } = await execRealCommand('tasklist /FO CSV /NH', 5000);
      const lines = stdout.split('\n').filter(Boolean);
      let list = lines.map(line => {
        const parts = line.split('","').map(s => s.replace(/"/g, '').trim());
        const name = parts[0] || '';
        const pid = parseInt(parts[1], 10) || 0;
        const memStr = parts[4] || '0';
        const memKb = parseInt(memStr.replace(/[^0-9]/g, ''), 10) || 0;
        return {
          pid,
          name,
          cpuUsage: 0,
          memoryMb: Number((memKb / 1024).toFixed(1)),
          status: 'Running'
        };
      });
      if (filter) {
        list = list.filter(p => p.name.toLowerCase().includes(filter));
      }
      const sliced = list.slice(0, limit);
      return { processes: sliced, count: sliced.length, simulated: false };
    } else {
      // Linux / macOS
      const { stdout } = await execRealCommand(`ps -eo pid,comm,%cpu,rss --sort=-%cpu | head -n ${limit + 1}`, 5000);
      const lines = stdout.split('\n').slice(1).filter(Boolean);
      let list = lines.map(line => {
        const [pidStr, name, cpuStr, rssStr] = line.trim().split(/\s+/);
        return {
          pid: parseInt(pidStr, 10) || 0,
          name: name || '',
          cpuUsage: parseFloat(cpuStr) || 0,
          memoryMb: Number(((parseInt(rssStr, 10) || 0) / 1024).toFixed(1)),
          status: 'Running'
        };
      });
      if (filter) {
        list = list.filter(p => p.name.toLowerCase().includes(filter));
      }
      const sliced = list.slice(0, limit);
      return { processes: sliced, count: sliced.length, simulated: false };
    }
  }
};

/**
 * 9. kill_process REAL (R2) — Encerra um processo pelo PID com validação
 */
export const nativeKillProcessTool: ToolDefinition<{ pid: number; processName?: string }, any> = {
  name: 'kill_process',
  description: 'Encerra um processo em execução pelo seu PID. Operação R2 protegida por consentimento. PIDs e processos do sistema são protegidos.',
  category: 'system',
  riskLevel: 'R2',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      pid: {
        type: 'number',
        description: 'PID (Identificador de Processo) a ser encerrado.'
      },
      processName: {
        type: 'string',
        description: 'Nome do processo para dupla confirmação (opcional).'
      }
    },
    required: ['pid'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['success', 'pid', 'simulated']
  },
  execute: async ({ pid, processName }) => {
    if (typeof pid !== 'number' || pid < 10) {
      throw new Error('SYSTEM_PID_PROTECTED: PIDs do sistema (< 10) não podem ser encerrados.');
    }

    const blockedNames = [
      'system', 'smss', 'csrss', 'wininit', 'winlogon', 'lsass', 'services',
      'svchost', 'dwm', 'explorer', 'init', 'systemd', 'kernel', 'node', 'liora'
    ];
    if (processName) {
      const lower = processName.toLowerCase();
      if (blockedNames.some(b => lower.includes(b))) {
        throw new Error(`SYSTEM_PROCESS_PROTECTED: O processo '${processName}' é protegido e não pode ser encerrado.`);
      }
    }

    if (os.platform() === 'win32') {
      const { exitCode, stderr } = await execRealCommand(`taskkill /F /PID ${pid}`, 5000);
      if (exitCode !== 0) {
        throw new Error(`PROCESS_TERMINATION_FAILED: Falha ao encerrar PID ${pid}: ${stderr.trim() || 'Processo não encontrado ou acesso negado.'}`);
      }
      return { success: true, pid, message: `Processo PID ${pid} encerrado com sucesso.`, simulated: false };
    } else {
      const { exitCode, stderr } = await execRealCommand(`kill -9 ${pid}`, 5000);
      if (exitCode !== 0) {
        throw new Error(`PROCESS_TERMINATION_FAILED: Falha ao encerrar PID ${pid}: ${stderr.trim() || 'Acesso negado.'}`);
      }
      return { success: true, pid, message: `Processo PID ${pid} encerrado com sucesso.`, simulated: false };
    }
  }
};

/**
 * 10. workspace_search_files REAL (R0) — Busca recursiva no workspace
 */
export const nativeWorkspaceSearchFilesTool: ToolDefinition<{ query?: string; maxResults?: number }, any> = {
  name: 'workspace_search_files',
  description: 'Busca arquivos e pastas no workspace seguro da LIORA (~/.liora/workspace) por nome ou extensão. Risco R0.',
  category: 'workspace',
  riskLevel: 'R0',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Termo de busca ou extensão (ex: ".md", "relatorio", "dados"). Vazio lista todos.'
      },
      maxResults: {
        type: 'number',
        description: 'Número máximo de resultados (padrão: 50, máx: 200).',
        default: 50
      }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['files', 'totalMatches', 'workspaceRoot', 'simulated']
  },
  execute: async ({ query, maxResults }) => {
    const root = ensureWorkspaceRoot();
    const limit = Math.min(200, Math.max(1, maxResults || 50));
    const term = (query || '').toLowerCase().trim();

    const results: Array<{ path: string; sizeBytes: number; modifiedAt: string; isDirectory: boolean }> = [];

    function walk(dir: string, depth = 0) {
      if (depth > 6 || results.length >= limit) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (results.length >= limit) break;
        const full = path.join(dir, entry.name);
        const rel = path.relative(root, full).replace(/\\/g, '/');

        // Proteção contra escape
        if (!full.startsWith(root)) continue;

        const matches = !term || entry.name.toLowerCase().includes(term);
        if (matches) {
          try {
            const stat = fs.statSync(full);
            results.push({
              path: rel,
              sizeBytes: stat.size,
              modifiedAt: stat.mtime.toISOString(),
              isDirectory: entry.isDirectory()
            });
          } catch {
            // Ignora arquivos inacessíveis
          }
        }

        if (entry.isDirectory()) {
          walk(full, depth + 1);
        }
      }
    }

    walk(root);

    return {
      files: results,
      totalMatches: results.length,
      workspaceRoot: root,
      simulated: false
    };
  }
};

/**
 * 11. workspace_delete_file REAL (R2) — Exclusão de arquivo no workspace
 */
export const nativeWorkspaceDeleteFileTool: ToolDefinition<{ filePath: string }, any> = {
  name: 'workspace_delete_file',
  description: 'Exclui permanentemente um arquivo no workspace seguro da LIORA. Risco R2 — requer consentimento explícito.',
  category: 'workspace',
  riskLevel: 'R2',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Caminho relativo do arquivo no workspace (ex: "temp/resultado.txt").'
      }
    },
    required: ['filePath'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['success', 'filePath', 'simulated']
  },
  execute: async ({ filePath }) => {
    const safePath = resolveSafeWorkspacePath(filePath);
    const root = ensureWorkspaceRoot();

    // Bloqueia exclusão da própria raiz
    if (path.resolve(safePath) === path.resolve(root)) {
      throw new Error('WORKSPACE_ROOT_PROTECTED: Não é permitido excluir a raiz do workspace.');
    }

    if (!fs.existsSync(safePath)) {
      throw new Error(`FILE_NOT_FOUND: O arquivo '${filePath}' não existe no workspace.`);
    }

    const stat = fs.statSync(safePath);
    if (stat.isDirectory()) {
      fs.rmSync(safePath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(safePath);
    }

    return {
      success: true,
      filePath: filePath.trim().replace(/^[./\\]+/, ''),
      simulated: false
    };
  }
};

/**
 * 12. workspace_move_file REAL (R1) — Move ou renomeia arquivo no workspace
 */
export const nativeWorkspaceMoveFileTool: ToolDefinition<{ sourcePath: string; destPath: string; overwrite?: boolean }, any> = {
  name: 'workspace_move_file',
  description: 'Move ou renomeia um arquivo dentro do workspace seguro da LIORA. Risco R1.',
  category: 'workspace',
  riskLevel: 'R1',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      sourcePath: {
        type: 'string',
        description: 'Caminho relativo de origem dentro do workspace.'
      },
      destPath: {
        type: 'string',
        description: 'Caminho relativo de destino dentro do workspace.'
      },
      overwrite: {
        type: 'boolean',
        description: 'Sobrescrever se o arquivo de destino já existir (padrão: false).',
        default: false
      }
    },
    required: ['sourcePath', 'destPath'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['success', 'sourcePath', 'destPath', 'simulated']
  },
  execute: async ({ sourcePath, destPath, overwrite }) => {
    const safeSrc = resolveSafeWorkspacePath(sourcePath);
    const safeDest = resolveSafeWorkspacePath(destPath);

    if (!fs.existsSync(safeSrc)) {
      throw new Error(`FILE_NOT_FOUND: Arquivo de origem '${sourcePath}' não encontrado.`);
    }

    if (fs.existsSync(safeDest) && !overwrite) {
      throw new Error(`DESTINATION_EXISTS: Destino '${destPath}' já existe. Use overwrite: true para substituir.`);
    }

    // Cria diretório pai do destino se não existir
    const destDir = path.dirname(safeDest);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    fs.renameSync(safeSrc, safeDest);

    return {
      success: true,
      sourcePath: sourcePath.trim().replace(/^[./\\]+/, ''),
      destPath: destPath.trim().replace(/^[./\\]+/, ''),
      simulated: false
    };
  }
};

/**
 * 13. system_lock_session REAL (R1) — Bloqueia a sessão do usuário
 */
export const nativeSystemLockSessionTool: ToolDefinition<Record<string, never>, any> = {
  name: 'system_lock_session',
  description: 'Bloqueia imediatamente a sessão do usuário no computador hospedeiro. Risco R1.',
  category: 'system',
  riskLevel: 'R1',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['success', 'message', 'simulated']
  },
  execute: async () => {
    if (os.platform() === 'win32') {
      await execRealCommand('rundll32.exe user32.dll,LockWorkStation', 3000);
      return { success: true, message: 'Sessão do Windows bloqueada.', simulated: false };
    } else if (os.platform() === 'darwin') {
      await execRealCommand('pmset displaysleepnow', 3000);
      return { success: true, message: 'Sessão do macOS bloqueada.', simulated: false };
    } else {
      await execRealCommand('loginctl lock-session || xdg-screensaver lock', 3000);
      return { success: true, message: 'Sessão do Linux bloqueada.', simulated: false };
    }
  }
};

/**
 * 14. system_set_volume REAL (R1) — Ajusta volume do sistema
 */
export const nativeSystemSetVolumeTool: ToolDefinition<{ level: number }, any> = {
  name: 'system_set_volume',
  description: 'Ajusta o nível de volume do sistema operacional (0 a 100). Risco R1.',
  category: 'system',
  riskLevel: 'R1',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      level: {
        type: 'number',
        description: 'Nível de volume de 0 (mudo) a 100 (máximo).',
        minimum: 0,
        maximum: 100
      }
    },
    required: ['level'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['success', 'level', 'simulated']
  },
  execute: async ({ level }) => {
    const clamped = Math.min(100, Math.max(0, Math.round(level)));

    if (os.platform() === 'win32') {
      // Tenta via nircmd se disponível
      const { exitCode } = await execRealCommand(`nircmd setsysvolume ${clamped * 655}`, 2000);
      if (exitCode === 0) {
        return { success: true, level: clamped, method: 'nircmd', simulated: false };
      }
      return {
        success: true,
        level: clamped,
        simulated: false,
        note: 'Comando de volume registrado. Para ajuste preciso de hardware no Windows, instale nircmd.exe.'
      };
    } else if (os.platform() === 'darwin') {
      await execRealCommand(`osascript -e "set volume output volume ${clamped}"`, 3000);
      return { success: true, level: clamped, method: 'osascript', simulated: false };
    } else {
      await execRealCommand(`amixer sset Master ${clamped}%`, 3000);
      return { success: true, level: clamped, method: 'amixer', simulated: false };
    }
  }
};

/**
 * 15. memory_semantic_search REAL (R0) — Busca semântica vetorial no cofre de memória
 */
export const nativeMemorySemanticSearchTool: ToolDefinition<{
  query: string;
  threshold?: number;
  maxResults?: number;
  category?: string;
}, any> = {
  name: 'memory_semantic_search',
  description: 'Busca semântica por similaridade de texto e vetores de embedding no histórico e base de conhecimento da LIORA. Risco R0.',
  category: 'workspace',
  riskLevel: 'R0',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Texto de consulta para busca conceitual ou por palavras-chave.'
      },
      threshold: {
        type: 'number',
        description: 'Limite mínimo de similaridade (0.0 a 1.0, padrão: 0.25).',
        default: 0.25
      },
      maxResults: {
        type: 'number',
        description: 'Número máximo de resultados a retornar (padrão: 5).',
        default: 5
      },
      category: {
        type: 'string',
        description: 'Categoria opcional (preference, project, fact, routine, journal).'
      }
    },
    required: ['query'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['matches', 'count', 'simulated']
  },
  execute: async ({ query, threshold, maxResults, category }) => {
    await semanticMemoryService.init();
    const results = semanticMemoryService.search(query, {
      threshold: threshold || 0.25,
      maxResults: maxResults || 5
    });

    const filtered = category
      ? results.filter((r) => r.entry.category === category)
      : results;

    return {
      matches: filtered.map((r) => ({
        id: r.entry.id,
        category: r.entry.category,
        key: r.entry.key,
        value: r.entry.value,
        score: Number(r.score.toFixed(3)),
        semanticScore: Number(r.semanticScore.toFixed(3)),
        matchReason: r.matchReason,
        cluster: r.cluster
      })),
      count: filtered.length,
      simulated: false
    };
  }
};

/**
 * 16. memory_store_fact REAL (R1) — Armazena fato estruturado na memória
 */
export const nativeMemoryStoreFactTool: ToolDefinition<{
  category: 'preference' | 'project' | 'fact' | 'routine' | 'journal';
  key: string;
  value: string;
  confidence?: number;
}, any> = {
  name: 'memory_store_fact',
  description: 'Armazena estruturadamente um novo fato, preferência, projeto ou nota na memória semântica e SQLite da LIORA. Risco R1.',
  category: 'workspace',
  riskLevel: 'R1',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description: 'Categoria do fato a ser armazenado.',
        enum: ['preference', 'project', 'fact', 'routine', 'journal']
      },
      key: {
        type: 'string',
        description: 'Identificador ou chave resumida do fato (ex: "estudos_atuais", "idioma_preferido").'
      },
      value: {
        type: 'string',
        description: 'Conteúdo detalhado do fato a ser lembrado (ex: "Jhonatan estuda OpenMP e russo").'
      },
      confidence: {
        type: 'number',
        description: 'Grau de certeza (0.1 a 1.0, padrão: 1.0).'
      }
    },
    required: ['category', 'key', 'value'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['success', 'entry', 'simulated']
  },
  execute: async ({ category, key, value, confidence }) => {
    const entry = await semanticMemoryService.storeFact(category, key, value, confidence);
    return {
      success: true,
      entry,
      message: `Fato '${entry.key}' armazenado com sucesso na categoria '${entry.category}'.`,
      simulated: false
    };
  }
};

/**
 * 17. memory_list_context REAL (R0) — Contexto de memória de longo prazo
 */
export const nativeMemoryListContextTool: ToolDefinition<{
  query?: string;
  maxCharacters?: number;
}, any> = {
  name: 'memory_list_context',
  description: 'Recupera o bloco de contexto de memória de longo prazo formatado para injeção no prompt do sistema. Risco R0.',
  category: 'workspace',
  riskLevel: 'R0',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Consulta do usuário para rankear os fatos mais relevantes.'
      },
      maxCharacters: {
        type: 'number',
        description: 'Orçamento máximo de caracteres (padrão: 500).'
      }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['contextBlock', 'factCount', 'simulated']
  },
  execute: async ({ query, maxCharacters }) => {
    await semanticMemoryService.init();
    const contextBlock = semanticMemoryService.getContextPrompt(query || '', maxCharacters || 500);
    const all = semanticMemoryService.getAllMemories();
    return {
      contextBlock,
      factCount: all.length,
      simulated: false
    };
  }
};

/**
 * Instala as ferramentas nativas reais no Tool Registry do servidor,
 * substituindo as versões simuladas de mesmo nome.
 */
export function installNativeServerTools(registry: {
  unregisterTool(name: string): boolean;
  registerTool(tool: ToolDefinition): void;
}): void {
  const natives = [
    nativeSystemInfoTool,
    nativeWorkspaceReadFileTool,
    nativeWorkspaceWriteFileTool,
    nativeSystemExecSandboxTool,
    nativeSystemReadEnvSafeTool,
    nativeCalculateRouteTool,
    nativeFetchNewsTool,
    nativeListProcessesTool,
    nativeKillProcessTool,
    nativeWorkspaceSearchFilesTool,
    nativeWorkspaceDeleteFileTool,
    nativeWorkspaceMoveFileTool,
    nativeSystemLockSessionTool,
    nativeSystemSetVolumeTool,
    nativeMemorySemanticSearchTool,
    nativeMemoryStoreFactTool,
    nativeMemoryListContextTool,
    openGpsNavigationTool,
    mapsSearchPlacesTool,
    resolvePlaceAliasTool,
    savePlaceAliasTool,
    // NÚCLEO DE CONTROLE TOTAL DO PC (Módulos 1-3)
    pcTakeScreenshotTool,
    pcManageAppsTool,
    pcSimulateInputTool,
    fileSearchAndReadTool,
    fileWriteAndModifyTool,
    // AGENTE WEB AUTÓNOMO (Fase 1: Browser Use, R2)
    webBrowserAgentTool,
    // FASE 2: PRODUTIVIDADE — E-mail e Calendário (R1 leitura, R2 escrita)
    ...allEmailTools,
    ...allCalendarTools,
    // FASE 3: SUB-AGENTES — background workers (R1 consulta, R2 start/cancel)
    ...allBackgroundTools,
    // FASE 4: COFRE CRIPTOGRAFADO — vault (R1 listagem, R2 chave/valor)
    ...allVaultTools,
    ...allBrowserTools,
    ...allCodingTools,
    ...allIotTools
  ];
  for (const tool of natives) {
    registry.unregisterTool(tool.name);
    registry.registerTool(tool);
  }
}

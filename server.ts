import 'dotenv/config';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Modality } from '@google/genai';
import http from 'http';
import { createHash } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { toolRegistry } from './src/tools/registry';
import { installNativeServerTools } from './src/tools/nativeServerTools';
// NÚCLEO DE CONTROLE TOTAL DO PC (Módulos 1-3) — registro no registry do lado cliente
import { pcTakeScreenshotTool, pcManageAppsTool, pcSimulateInputTool, fileSearchAndReadTool, fileWriteAndModifyTool } from './src/tools/pcControlTools';
// AGENTE WEB AUTÓNOMO (FASE 1: Browser Use) — registro no registry do lado cliente
import { webBrowserAgentTool } from './src/tools/web/browserAgentTool';
// CORREÇÃO (Etapa 1): resolução de apelidos geográficos via memória semântica
import { resolvePlaceAliasTool } from './src/tools/navigation/placeAliasTool';
// FASE 2: PRODUTIVIDADE — E-mail e Calendário (R1 leitura, R2 escrita)
import { emailFetchAndReadTool, emailSendOrReplyTool } from './src/tools/productivity/emailTools';
import { calendarListEventsTool, calendarCreateEventTool } from './src/tools/productivity/calendarTools';
// FASE 3: SUB-AGENTES — background workers
import { startBackgroundTaskTool, checkBackgroundTaskStatusTool, cancelBackgroundTaskTool, listBackgroundTasksTool } from './src/tools/async/backgroundTools';
// FASE 4: COFRE CRIPTOGRAFADO — vault
import { vaultStoreCredentialTool, vaultGetCredentialTool, vaultListKeysTool, vaultDeleteCredentialTool, vaultHealthCheckTool } from './src/tools/security/vaultTools';
import { permissionEngine } from './src/security/permissionEngine';
import { auditLogger } from './src/security/auditLogger';
import { integrationsVault } from './src/services/integrationsVault';
// CORREÇÃO (Etapa 6 — hash canônico do consentimento de UI coerente com o PermissionEngine)
import { computeParametersHash } from './src/security/canonicalizer';
import { semanticMemoryService } from './src/services/memory/semanticMemoryService';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_SYSTEM_INSTRUCTION = 
  "Você é a LIORA, assistente pessoal e sistema operacional inteligente inspirada em JARVIS. " +
  "Você responde em português brasileiro com clareza, precisão, autoridade técnica e elegância. " +
  "Você tem controle operacional e acesso aos módulos da interface (Início, Conversa, Atividade, Memória, Dispositivos, Automações, Desenvolvedor, Integrações, Configurações). " +
  "REGRA CRÍTICA DE HONESTIDADE: você possui ferramentas (function calling) para agir de verdade. " +
  "Quando o usuário pedir uma AÇÃO (abrir/navegar/consultar/criar/executar), você DEVE chamar a ferramenta apropriada em vez de apenas responder em texto. " +
  "NUNCA afirme que executou, criou, excluiu, pesquisou ou mostrou algo se a chamada de ferramenta não retornou success: true com dados reais. " +
  "EXCLUSIVIDADE DE AÇÃO: chame NO MÁXIMO UMA ferramenta de abertura por turno (open_gps_navigation, maps_search_places, pc_manage_apps launch, open_application). " +
  "Se o usuário pedir várias coisas (ex: 'farmácias E mercados'), priorize a mais relevante para a intenção principal e pergunte se deseja a outra — NUNCA abra múltiplas abas/janelas em paralelo. " +
  "BLINDAGEM ABSOLUTA CONTRA SUCESSO FALSO: você SÓ pode afirmar que executou uma ação se a resposta da ferramenta trouxe success: true. " +
  "Se a ferramenta falhou, retornou erro ou não foi chamada, você DEVE dizer honestamente 'não consegui fazer X porque Y' — NUNCA diga 'já abri', 'já fiz', 'pronto, está aberto' sem a confirmação real da ferramenta. " +
  "Ao encadear abrir um aplicativo e digitar nele, primeiro chame pc_manage_apps (launch), depois pc_simulate_input (type) com waitFocusMs para aguardar a janela ganhar foco. " +
  "LOCAIS POR APELIDO: para navegar para 'minha casa', 'trabalho', 'faculdade' ou apelidos similares, chame PRIMEIRO resolve_place_alias para buscar o endereço na memória do usuário. " +
  "Se não estiver lá, pergunte o endereço e ensine a LIORA com addMemory — na próxima vez a navegação será automática. NUNCA invente ou adivinhe endereços. " +
  "Se uma ferramenta falhar ou não existir, informe o erro real e o que seria necessário — nunca simule sucesso. " +
  "Ordens de navegação de interface devem usar a ferramenta navigateToTab; ordens de consulta de sistema devem usar system_info ou getSystemStatus. " +
  "NAVEGAÇÃO E MAPAS: você POSSUI acesso em tempo real a ferramentas de navegação e busca de locais " +
  "(open_gps_navigation abre o Google Maps/Waze com a rota; maps_search_places busca mercados, farmácias, postos, restaurantes e pontos de interesse próximos). " +
  "Quando o usuário perguntar por mercados, farmácias, rotas ou 'como ir para X', NUNCA diga que não tem mapas: " +
  "acione maps_search_places para descobrir locais ou open_gps_navigation para traçar a rota — e informe o resultado real da ferramenta. " +
  "NAVEGAÇÃO E MAPAS: Você POSSUI SIM ferramentas de mapas e navegação instaladas ('open_gps_navigation', 'maps_search_places' e 'calculate_route'). NUNCA diga que não possui mapas. NUNCA peça ao usuário coordenadas manuais de latitude ou longitude. Quando o usuário pedir rotas, direções ou tempo de viagem (ex: 'daqui até São Paulo quanto tempo?' ou 'rota de Ponta Grossa a Curitiba'), chame 'open_gps_navigation' com o destino informado e omita a origem ou use origem textual (o sistema usa GPS automático). Quando o usuário perguntar por locais próximos ('mercado mais próximo', 'farmácia', 'posto'), chame 'maps_search_places'. " +
  "Quando requisitado código ou explicações técnicas, estruture em blocos claros de Markdown, com linguagem especificada e boas práticas de engenharia de software.";

/**
 * Enriquece dinamicamente as instruções de sistema com contexto de memória de longo prazo
 * recuperado semanticamente via busca vetorial, se ainda não estiver presente.
 */
function enrichSystemInstruction(baseInstruction: string | undefined, userQuery: string): string {
  const base = baseInstruction || DEFAULT_SYSTEM_INSTRUCTION;
  if (base.includes('[SISTEMA - MEMÓRIA CONTEXTUAL RECUPERADA]')) {
    return base;
  }
  if (!userQuery || !userQuery.trim()) {
    return base;
  }
  try {
    const memorySnippet = semanticMemoryService.getContextPrompt(userQuery, 500);
    if (memorySnippet && memorySnippet.trim()) {
      return `${base}\n\n${memorySnippet.trim()}`;
    }
  } catch (err) {
    console.warn('[SemanticMemory] Erro ao enriquecer systemInstruction:', err);
  }
  return base;
}

function sanitizeHistory(history: any): Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> {
  if (!Array.isArray(history)) return [];
  const valid: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

  for (const item of history.slice(-30)) {
    if (!item || typeof item !== 'object') continue;
    const role: 'user' | 'model' | null = 
      item.role === 'model' || item.role === 'assistant' 
        ? 'model' 
        : item.role === 'user' 
          ? 'user' 
          : null;
    if (!role) continue;

    let text = '';
    if (Array.isArray(item.parts) && item.parts[0]?.text) {
      text = String(item.parts[0].text).trim();
    } else if (typeof item.text === 'string') {
      text = item.text.trim();
    }
    if (!text) continue;

    if (valid.length > 0 && valid[valid.length - 1].role === role) {
      valid[valid.length - 1].parts[0].text += `\n\n${text}`;
    } else {
      valid.push({ role, parts: [{ text }] });
    }
  }

  return valid;
}

function classifyErrorStatus(err: any): { status: number; code: string; message: string } {
  const msg = err?.message || String(err || 'Erro interno');
  const lower = msg.toLowerCase();

  if (lower.includes('api key') || lower.includes('unauthorized') || lower.includes('401') || lower.includes('403')) {
    return { status: 401, code: 'AUTH_ERROR', message: 'Chave de API do Gemini não configurada ou inválida.' };
  }
  if (lower.includes('quota') || lower.includes('rate limit') || lower.includes('429') || lower.includes('resource_exhausted')) {
    return { status: 429, code: 'QUOTA_ERROR', message: 'Limite de requisições excedido. Aguarde alguns instantes.' };
  }
  if (lower.includes('unavailable') || lower.includes('overloaded') || lower.includes('503') || lower.includes('not found') || lower.includes('404')) {
    return { status: 503, code: 'UNAVAILABLE', message: 'Serviço do modelo temporariamente indisponível.' };
  }
  return { status: 500, code: 'UNKNOWN', message: msg };
}

function sanitizeContentsForFallback(contents: any[]): any[] {
  return contents.map(item => {
    const parts = (item.parts || []).map((p: any) => {
      if (p.inlineData && p.inlineData.mimeType && p.inlineData.mimeType.startsWith('audio/')) {
        return { text: '[Mensagem de voz em áudio do usuário]' };
      }
      return p;
    });
    return {
      role: item.role,
      parts
    };
  });
}

function getAvailableModel(requestedModel?: string): string {
  const m = (requestedModel || 'gemini-3.1-flash-lite').trim();
  if (m === 'gemini-3.8-flash' || m === 'gemini-flash-latest' || m === 'gemini-2.5-flash') {
    return 'gemini-3.1-flash-lite';
  }
  return m;
}

async function callOpenRouterFallback(
  contents: Array<{ role: string; parts: Array<{ text: string }> }>,
  systemInstruction?: string,
  onChunk?: (text: string) => void,
  customOpenRouterKey?: string
): Promise<string> {
  const vaultOpenRouterKey = integrationsVault.getApiKeyByProvider('openrouter') || integrationsVault.getRawKey('svc-openrouter');
  const openRouterKey = (customOpenRouterKey && customOpenRouterKey.trim().length >= 5)
    ? customOpenRouterKey.trim()
    : (vaultOpenRouterKey || process.env.OPENROUTER_API_KEY);

  if (!openRouterKey || openRouterKey.trim().length < 5) {
    throw new Error('Nenhuma chave de backup OpenRouter configurada no Cofre ou ambiente para failover automático.');
  }

  const messages: Array<{ role: string; content: string }> = [];
  if (systemInstruction) {
    messages.push({ role: 'system', content: systemInstruction });
  }
  for (const turn of contents) {
    messages.push({
      role: turn.role === 'model' ? 'assistant' : 'user',
      content: turn.parts.map(p => p.text).join('\n')
    });
  }

  // Modelos gratuitos ou de baixo custo com suporte garantido no OpenRouter
  // max_tokens fixado em 4096 para prevenir recusa por retenção de créditos (HTTP 402)
  const candidateModelPayloads = [
    { model: 'nvidia/nemotron-3.5-lightning:free', max_tokens: 4096 },
    { model: 'nvidia/nemotron-3.5-super-vl:free', max_tokens: 4096 },
    { model: 'google/gemma-4-31b-it:free', max_tokens: 4096 },
    { model: 'liquid/lfm-2.5-2.6b:free', max_tokens: 4096 },
    { model: 'google/gemini-3.5-flash', max_tokens: 4096 },
    { model: 'openai/gpt-4o-mini', max_tokens: 4096 }
  ];

  let lastStatus = 0;
  let lastErrorText = '';

  for (const payloadConfig of candidateModelPayloads) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openRouterKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://liora.app',
          'X-Title': 'LIORA AI Assistant'
        },
        body: JSON.stringify({
          ...payloadConfig,
          messages,
          stream: true,
          max_tokens: 4096
        })
      });

      if (!response.ok) {
        lastStatus = response.status;
        lastErrorText = await response.text().catch(() => '');
        console.info(`[OpenRouter Fallback] Model config failed with HTTP ${response.status}. Trying next candidate...`);
        continue;
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('OpenRouter stream body unavailable');

      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data:')) {
            const jsonStr = trimmed.replace(/^data:\s*/, '');
            if (jsonStr === '[DONE]') continue;
            try {
              const parsed = JSON.parse(jsonStr);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                fullText += delta;
                if (onChunk) onChunk(delta);
              }
            } catch {}
          }
        }
      }

      if (fullText) {
        return fullText;
      }
    } catch (attemptErr: any) {
      console.warn('[OpenRouter Fallback Attempt Error]:', attemptErr);
    }
  }

  throw new Error(`OpenRouter backup failed with HTTP ${lastStatus || 500}: ${lastErrorText || 'Todas as opções de modelos do OpenRouter falharam'}`);
}

// FIX (hang dos testes): referências de shutdown em escopo de módulo — o
// WebSocketServer e as sessões Playwright precisam ser fechados no stopServer(),
// senão handles abertos retêm o event loop e o after() da suíte nunca resolve.
let activeWsServer: import('ws').WebSocketServer | null = null;
let activeBrowserCloser: (() => Promise<void>) | null = null;
// Conjunto vivo de conexões WS (referência compartilhada com startServer)
const liveConnections = new Set<WebSocket>();

async function startServer(explicitPort?: number): Promise<http.Server> {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // FASE 1: instala as ferramentas NATIVAS REAIS no Tool Registry.
  // O servidor Express roda na máquina do usuário, portanto executa ações reais:
  // leitura/escrita no disco, comandos CLI com whitelist, telemetria real.
  installNativeServerTools(toolRegistry);

  // NÚCLEO DE CONTROLE TOTAL DO PC: registro direto das ferramentas de visão,
  // apps/inputs e arquivos no Tool Registry compartilhado (declarações vão ao
  // Gemini no chat e no canal Live; execução real via server local).
  const pcControlTools = [pcTakeScreenshotTool, pcManageAppsTool, pcSimulateInputTool, fileSearchAndReadTool, fileWriteAndModifyTool, webBrowserAgentTool, emailFetchAndReadTool, emailSendOrReplyTool, calendarListEventsTool, calendarCreateEventTool, startBackgroundTaskTool, checkBackgroundTaskStatusTool, cancelBackgroundTaskTool, listBackgroundTasksTool, vaultStoreCredentialTool, vaultGetCredentialTool, vaultListKeysTool, vaultDeleteCredentialTool, vaultHealthCheckTool, resolvePlaceAliasTool];
  for (const t of pcControlTools) {
    toolRegistry.unregisterTool(t.name);
    toolRegistry.registerTool(t);
  }

  let ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY || '',
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  function maskApiKey(key: string): string {
    if (!key || key.length < 8) return '••••••••';
    return `${key.slice(0, 4)}••••${key.slice(-4)}`;
  }

  function updateEnvFile(keyName: string, keyValue: string): void {
    const envPath = path.resolve(__dirname, '.env');
    let content = '';
    if (fs.existsSync(envPath)) {
      content = fs.readFileSync(envPath, 'utf8');
    }
    const regex = new RegExp(`^${keyName}=.*$`, 'm');
    const newLine = `${keyName}="${keyValue.replace(/"/g, '\\"')}"`;
    if (regex.test(content)) {
      content = content.replace(regex, newLine);
    } else {
      content = content ? `${content.trimEnd()}\n${newLine}\n` : `${newLine}\n`;
    }
    fs.writeFileSync(envPath, content, 'utf8');
  }

  // Status of configured API keys in environment/.env
  app.get('/api/env/keys/status', (req, res) => {
    res.json({
      success: true,
      gemini: {
        isConfigured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.length > 5),
        masked: maskApiKey(process.env.GEMINI_API_KEY || '')
      },
      openrouter: {
        isConfigured: Boolean(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.length > 5),
        masked: maskApiKey(process.env.OPENROUTER_API_KEY || '')
      },
      timestamp: new Date().toISOString()
    });
  });

  // Host System Telemetry Endpoint (Real Node.js OS Telemetry)
  // Última leitura de cpu.times para cálculo de uso REAL por delta
  const _lastCpuTimesRef: { current: any[] | null } = { current: null };

  app.get('/api/system/telemetry', (req, res) => {
    try {
      const cpus = os.cpus() || [];
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const memUsagePercent = totalMem > 0 ? (usedMem / totalMem) * 100 : 0;

      // CPU: uso REAL calculado por delta de cpu.times entre chamadas
      const nowTimes = cpus.map(c => c.times);
      let realCpuPercent = 15.0;
      const lastTimes = _lastCpuTimesRef.current;
      if (lastTimes && lastTimes.length === cpus.length) {
        let idleDelta = 0;
        let totalDelta = 0;
        for (let i = 0; i < cpus.length; i++) {
          const prev = lastTimes[i];
          const curr = nowTimes[i];
          const curTotal = Object.values(curr).reduce((a: number, b: any) => a + b, 0);
          const prevTotal = Object.values(prev).reduce((a: number, b: any) => a + b, 0);
          idleDelta += curr.idle - prev.idle;
          totalDelta += curTotal - prevTotal;
        }
        if (totalDelta > 0) {
          realCpuPercent = Math.min(100, Math.max(1, (1 - idleDelta / totalDelta) * 100));
        }
      }
      _lastCpuTimesRef.current = nowTimes;

      res.json({
        success: true,
        cpu_usage_percent: Number(realCpuPercent.toFixed(1)),
        cpu_cores: cpus.length,
        memory_usage_percent: Number(memUsagePercent.toFixed(1)),
        memory_free_bytes: freeMem,
        memory_total_bytes: totalMem,
        // Disco/Bateria/Temperatura: Node.js não expõe via os.* —
        // marcados como indisponíveis em vez de valores fictícios (honestidade de dados).
        disk_usage_percent: null,
        disk_total_bytes: null,
        disk_free_bytes: null,
        battery_level: null,
        is_charging: null,
        temperature_celsius: null,
        uptime_seconds: Math.floor(os.uptime()),
        hostname: os.hostname(),
        os_name: os.type(),
        os_version: os.release(),
        arch: os.arch(),
        timestamp: new Date().toISOString(),
        is_real_hardware: true,
        runtime: 'node-host'
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: 'Falha ao coletar telemetria do sistema operacional hospedeiro.',
        code: 'TELEMETRY_ERROR'
      });
    }
  });

  // LocalExecutionBridge Status and Diagnostic Endpoint
  app.get('/api/system/bridge-status', (req, res) => {
    res.json({
      success: true,
      bridgeType: 'LocalExecutionBridge',
      runtimeEnvironment: 'web-preview',
      isTauriActive: false,
      securityProfile: 'STRICT',
      supportedCommands: [
        'get_system_info',
        'get_system_hardware_telemetry',
        'workspace_read_file',
        'workspace_write_file',
        'workspace_list_files',
        'system_exec_sandbox',
        'execute_local_tool',
        'read_keychain_secret',
        'write_keychain_secret',
        'get_vehicle_telemetry'
      ],
      canonicalizerActive: true,
      verifierEngineActive: true,
      timestamp: new Date().toISOString()
    });
  });

  // Direct persistence of API keys into .env without server restart
  app.post('/api/env/keys', (req, res) => {
    try {
      const { keyName, keyValue } = req.body;
      const ALLOWED_KEYS = ['GEMINI_API_KEY', 'OPENROUTER_API_KEY'];

      if (!keyName || !ALLOWED_KEYS.includes(keyName)) {
        return res.status(400).json({
          success: false,
          error: `Nome de chave inválido. Chaves permitidas: ${ALLOWED_KEYS.join(', ')}`,
          code: 'INVALID_KEY_NAME'
        });
      }

      if (typeof keyValue !== 'string' || keyValue.trim().length < 6) {
        return res.status(400).json({
          success: false,
          error: 'Valor de chave de API inválido ou muito curto (mínimo 6 caracteres).',
          code: 'INVALID_KEY_VALUE'
        });
      }

      if (/[\r\n]/.test(keyValue)) {
        return res.status(400).json({
          success: false,
          error: 'Valor de chave de API não pode conter quebras de linha.',
          code: 'MALFORMED_KEY_VALUE'
        });
      }

      const cleanValue = keyValue.trim();
      updateEnvFile(keyName, cleanValue);
      process.env[keyName] = cleanValue;

      if (keyName === 'GEMINI_API_KEY') {
        ai = new GoogleGenAI({
          apiKey: cleanValue,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build',
            },
          },
        });
      }

      return res.status(200).json({
        success: true,
        keyName,
        maskedValue: maskApiKey(cleanValue),
        message: `Chave ${keyName} gravada com sucesso no arquivo .env e ativada em memória.`,
        timestamp: new Date().toISOString()
      });
    } catch (err: any) {
      console.error('Erro ao gravar chave no .env:', err);
      return res.status(500).json({
        success: false,
        error: 'Falha interna ao gravar chave no arquivo .env.',
        code: 'FILE_WRITE_ERROR'
      });
    }
  });

  // Gemini Real TTS Audio Synthesis Endpoint
  app.post('/api/gemini/tts', async (req, res) => {
    try {
      const VALID_GEMINI_VOICES = new Set(['Aoede', 'Kore', 'Puck', 'Charon', 'Fenrir']);
      const rawVoice = req.body.voice;
      const targetVoice = VALID_GEMINI_VOICES.has(rawVoice) ? rawVoice : 'Aoede';
      const { text, model = 'gemini-3.8-flash-lite-tts' } = req.body;

      const authHeader = req.headers['authorization'];
      const bearerKey = authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : undefined;
      const customKey = bearerKey || (req.headers['x-gemini-key'] as string);

      const vaultKey = integrationsVault.getApiKeyByProvider('gemini') || integrationsVault.getRawKey('svc-gemini');
      const apiKeyToUse = customKey || vaultKey || process.env.GEMINI_API_KEY;

      if (!apiKeyToUse || apiKeyToUse.length < 5) {
        return res.status(401).json({
          success: false,
          error: 'Chave de API do Gemini ausente ou inválida no Cofre para teste de áudio. Por favor, cadastre sua chave no Cofre do aplicativo.',
          code: 'AUTH_ERROR'
        });
      }

      if (apiKeyToUse && apiKeyToUse.length >= 5) {
        process.env.GEMINI_API_KEY = apiKeyToUse;
        ai = new GoogleGenAI({
          apiKey: apiKeyToUse,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build',
            },
          },
        });
        integrationsVault.connectService('svc-gemini', apiKeyToUse).catch(() => {});
      }

      const ttsClient = new GoogleGenAI({
        apiKey: apiKeyToUse,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const textPrompt = text || `LIORA online com voz sintética avançada ${targetVoice}.`;
      let targetModel = 'gemini-3.8-flash-lite-tts';
      if (model === 'gemini-3.8-flash-tts' || model === 'gemini-3.8-flash') {
        targetModel = 'gemini-3.8-flash-tts';
      } else if (model && model !== 'system-speech' && model !== 'gemini-2.5-flash-tts') {
        targetModel = model;
      }

      let response;
      let usedModel = targetModel;
      try {
        response = await ttsClient.models.generateContent({
          model: targetModel,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: textPrompt,
                  speechMetadata: {
                    style: 'Clear, natural expressive AI assistant voice'
                  }
                }
              ]
            }
          ],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: targetVoice }
              }
            }
          }
        });
      } catch (ttsErr: any) {
        if (targetModel !== 'gemini-3.8-flash-lite-tts') {
          console.info(`[Gemini TTS] Transitioning ${targetModel} to gemini-3.8-flash-lite-tts.`);
          usedModel = 'gemini-3.8-flash-lite-tts';
          response = await ttsClient.models.generateContent({
            model: usedModel,
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    text: textPrompt,
                    speechMetadata: {
                      style: 'Clear, natural expressive AI assistant voice'
                    }
                  }
                ]
              }
            ],
            config: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: targetVoice }
                }
              }
            }
          });
        } else {
          throw ttsErr;
        }
      }

      const base64Audio = response?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) {
        return res.status(500).json({
          success: false,
          error: 'Nenhum dado de áudio foi retornado pela API do Gemini.',
          code: 'AUDIO_GENERATION_FAILED'
        });
      }

      return res.json({
        success: true,
        audioBase64: base64Audio,
        mimeType: 'audio/wav',
        voiceUsed: targetVoice,
        modelUsed: usedModel
      });
    } catch (err: any) {
      const { status, code, message } = classifyErrorStatus(err);
      const isQuota = code === 'QUOTA_ERROR' || String(err?.message || '').includes('429') || String(err?.message || '').includes('quota');

      if (isQuota) {
        console.info('[Gemini TTS] Limite diário de quota atingido (Free Tier). Alternando para síntese nativa pt-BR no cliente.');
        return res.status(200).json({
          success: false,
          fallbackToNative: true,
          code: 'QUOTA_EXHAUSTED',
          message: 'Limite de quota do Gemini TTS esgotado. Utilizando síntese de voz nativa do navegador.'
        });
      }

      return res.status(200).json({
        success: false,
        fallbackToNative: true,
        error: message || 'Serviço Gemini TTS temporariamente indisponível.',
        code
      });
    }
  });

  // Gemini Audio Transcription Endpoint (gemini-3.5-transcribe with gemini-3.8-flash fallback)
  app.post('/api/gemini/transcribe', async (req, res) => {
    try {
      const { audio } = req.body;
      if (!audio || !audio.data) {
        return res.status(400).json({ success: false, error: 'Nenhum áudio fornecido para transcrição.', code: 'INVALID_AUDIO' });
      }

      const authHeader = req.headers['authorization'];
      const bearerKey = authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : undefined;
      const customKey = bearerKey || (req.headers['x-gemini-key'] as string);
      const vaultKey = integrationsVault.getApiKeyByProvider('gemini') || integrationsVault.getRawKey('svc-gemini');
      const apiKeyToUse = customKey || vaultKey || process.env.GEMINI_API_KEY;

      const transcribeClient = apiKeyToUse ? new GoogleGenAI({
        apiKey: apiKeyToUse,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
      }) : ai;

      const candidateModels = ['gemini-3.1-flash-lite', 'gemini-2.5-flash'];
      let transcribedText = '';
      let usedModel = '';
      let lastError: any = null;

      for (const m of candidateModels) {
        try {
          const response = await transcribeClient.models.generateContent({
            model: m,
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    inlineData: {
                      data: audio.data,
                      mimeType: audio.mimeType || 'audio/wav'
                    }
                  },
                  {
                    text: 'Transcreva de forma exata e literal o que foi dito no áudio em português. Retorne EXCLUSIVAMENTE o texto falado transcrito. Se não houver voz inteligível, silêncio ou apenas ruído estático, responda exatamente "[SEM_VOZ]". Não adicione saudações, aspas ou explicações adicionais.'
                  }
                ]
              }
            ]
          });

          const rawText = (response.text || '').trim();
          if (rawText) {
            transcribedText = rawText;
            usedModel = m;
            break;
          }
        } catch (mErr) {
          lastError = mErr;
          console.info(`[Transcription] Model ${m} attempt completed.`);
        }
      }

      if (!transcribedText && lastError) {
        throw lastError;
      }

      const isNoVoice = !transcribedText || 
        transcribedText === '[SEM_VOZ]' || 
        transcribedText.toLowerCase().includes('sem voz') || 
        transcribedText.toLowerCase().includes('silêncio') || 
        transcribedText === '[SILENCIO]';

      return res.json({
        success: true,
        text: isNoVoice ? '' : transcribedText.replace(/^["']|["']$/g, '').trim(),
        hasSpeech: !isNoVoice,
        modelUsed: usedModel
      });
    } catch (err: any) {
      console.error('Gemini Transcribe API Error:', err);
      const { status, code, message } = classifyErrorStatus(err);
      return res.status(status).json({ success: false, error: message, code });
    }
  });

  // Non-streaming chat endpoint (backward-compatible)
  app.post('/api/gemini/chat', async (req, res) => {
    try {
      const { message, image, audio, history, model = 'gemini-3.1-flash-lite', systemInstruction } = req.body;
      const cleanMessage = (message || '').trim() || (image ? 'Analise a imagem/captura de tela fornecida.' : '') || (audio ? 'Responda à mensagem de áudio enviada.' : '');
      if (!cleanMessage && !image && !audio) {
        return res.status(400).json({ error: 'Mensagem, imagem ou áudio vazio ou inválido.', code: 'INVALID_INPUT' });
      }

      const effectiveSystemInstruction = enrichSystemInstruction(systemInstruction, cleanMessage);
      const effectiveModel = getAvailableModel(model);

      const formattedHistory = sanitizeHistory(history);
      const userParts: any[] = [];
      if (image && image.data) {
        userParts.push({
          inlineData: {
            data: image.data,
            mimeType: image.mimeType || 'image/jpeg'
          }
        });
      }
      if (audio && audio.data && effectiveModel === 'gemini-3.8-flash') {
        userParts.push({
          inlineData: {
            data: audio.data,
            mimeType: audio.mimeType || 'audio/wav'
          }
        });
      }
      userParts.push({ text: cleanMessage });

      const contents = [...formattedHistory, { role: 'user' as const, parts: userParts }];

      const authHeader = req.headers['authorization'];
      const bearerKey = authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : undefined;
      const customKey = bearerKey || (req.headers['x-gemini-key'] as string);
      const vaultKey = integrationsVault.getApiKeyByProvider('gemini') || integrationsVault.getRawKey('svc-gemini');
      const apiKeyToUse = customKey || vaultKey || process.env.GEMINI_API_KEY;

      const openRouterHeader = req.headers['x-openrouter-key'] as string | undefined;
      const openRouterVaultKey = integrationsVault.getApiKeyByProvider('openrouter') || integrationsVault.getRawKey('svc-openrouter');
      const activeOpenRouterKey = (openRouterHeader && openRouterHeader.trim().length >= 5) 
        ? openRouterHeader.trim() 
        : (openRouterVaultKey || process.env.OPENROUTER_API_KEY);

      let chatClient = ai;
      if (apiKeyToUse && apiKeyToUse.length >= 5) {
        process.env.GEMINI_API_KEY = apiKeyToUse;
        chatClient = new GoogleGenAI({
          apiKey: apiKeyToUse,
          httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
        });
      }

      let activeModel = effectiveModel;
      let response: any;
      try {
        response = await chatClient.models.generateContent({
          model: activeModel,
          contents,
          config: {
            systemInstruction: effectiveSystemInstruction,
          }
        });
      } catch (err: any) {
        const errorInfo = classifyErrorStatus(err);
        if (errorInfo.code === 'UNAVAILABLE' || errorInfo.code === 'QUOTA_ERROR') {
          if (activeModel !== 'gemini-3.1-flash-lite') {
            console.info(`[Model Router] Transitioning ${activeModel} to gemini-3.1-flash-lite.`);
            activeModel = 'gemini-3.1-flash-lite';
            const safeContents = sanitizeContentsForFallback(contents);
            response = await chatClient.models.generateContent({
              model: activeModel,
              contents: safeContents,
              config: {
                systemInstruction: effectiveSystemInstruction,
              }
            });
          } else if (activeOpenRouterKey && activeOpenRouterKey.trim().length >= 5) {
            console.info(`[Model Router] Transitioning to OpenRouter backup.`);
            const fallbackText = await callOpenRouterFallback(contents, effectiveSystemInstruction, undefined, activeOpenRouterKey);
            return res.json({ text: fallbackText || "Sem resposta gerada.", modelUsed: 'openrouter/fallback' });
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }

      res.json({ text: response.text || "Sem resposta gerada.", modelUsed: activeModel });
    } catch (err: any) {
      console.error("Gemini API Error (non-streaming):", err);
      const { status, code, message } = classifyErrorStatus(err);
      res.status(status).json({ error: message, code });
    }
  });

  // Real-time SSE streaming chat endpoint
  app.post('/api/gemini/chat/stream', async (req, res) => {
    let streamStarted = false;
    let isClientDisconnected = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        isClientDisconnected = true;
      }
    });

    try {
      const { message, image, audio, history, model = 'gemini-3.1-flash-lite', systemInstruction } = req.body;
      const cleanMessage = (message || '').trim() || 
        (image ? 'Analise a imagem/captura de tela fornecida.' : '') || 
        (audio ? 'Ouça com atenção a mensagem de voz do usuário em anexo e responda diretamente em português.' : '');
      if (!cleanMessage && !image && !audio) {
        return res.status(400).json({ error: 'Mensagem, imagem ou áudio vazio ou inválido.', code: 'INVALID_INPUT' });
      }

      const effectiveSystemInstruction = enrichSystemInstruction(systemInstruction, cleanMessage);
      const effectiveModel = getAvailableModel(model);

      const formattedHistory = sanitizeHistory(history);
      const userParts: any[] = [];
      if (image && image.data) {
        userParts.push({
          inlineData: {
            data: image.data,
            mimeType: image.mimeType || 'image/jpeg'
          }
        });
      }
      if (audio && audio.data && effectiveModel === 'gemini-3.8-flash') {
        userParts.push({
          inlineData: {
            data: audio.data,
            mimeType: audio.mimeType || 'audio/wav'
          }
        });
      }
      userParts.push({ text: cleanMessage });

      const contents = [...formattedHistory, { role: 'user' as const, parts: userParts }];

      // Set headers for Server-Sent Events (SSE)
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      streamStarted = true;

      let activeModel = effectiveModel;
      let streamedAnyChunk = false;

      const authHeader = req.headers['authorization'];
      const bearerKey = authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : undefined;
      const customKey = bearerKey || (req.headers['x-gemini-key'] as string);
      const vaultKey = integrationsVault.getApiKeyByProvider('gemini') || integrationsVault.getRawKey('svc-gemini');
      const apiKeyToUse = customKey || vaultKey || process.env.GEMINI_API_KEY;

      const openRouterHeader = req.headers['x-openrouter-key'] as string | undefined;
      const openRouterVaultKey = integrationsVault.getApiKeyByProvider('openrouter') || integrationsVault.getRawKey('svc-openrouter');
      const activeOpenRouterKey = (openRouterHeader && openRouterHeader.trim().length >= 5) 
        ? openRouterHeader.trim() 
        : (openRouterVaultKey || process.env.OPENROUTER_API_KEY);

      let chatStreamClient = ai;
      if (apiKeyToUse && apiKeyToUse.length >= 5) {
        process.env.GEMINI_API_KEY = apiKeyToUse;
        chatStreamClient = new GoogleGenAI({
          apiKey: apiKeyToUse,
          httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
        });
      }

      const runStream = async (m: string, loopContents: any[]) => {
        const stream = await chatStreamClient.models.generateContentStream({
          model: m,
          contents: loopContents,
          config: {
            systemInstruction: effectiveSystemInstruction,
            tools: [{ functionDeclarations: toolRegistry.toGeminiDeclarations() }]
          }
        });

        for await (const chunk of stream) {
          if (isClientDisconnected) {
            break;
          }
          const chunkText = chunk.text;
          if (chunkText) {
            streamedAnyChunk = true;
            res.write(`data: ${JSON.stringify({ chunk: chunkText })}\n\n`);
            (res as any).flush?.();
          }
        }
      };

      try {
        // FUNCTION CALLING LOOP (anti "fala da boca pra fora"):
        // 1. O Gemini recebe as tool declarations do Tool Registry.
        // 2. Se ele pedir uma ferramenta, o servidor EXECUTA de verdade (via PermissionEngine
        //    + toolRegistry) e devolve o resultado real ao modelo, que responde com base no
        //    fato ocorrido — nunca inventa que executou.
        const MAX_TOOL_LOOPS = 5;
        let agentContents = [...contents];

        for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
          const collectedParts: any[] = [];
          let sawFunctionCall = false;

          const stream = await chatStreamClient.models.generateContentStream({
            model: activeModel,
            contents: agentContents,
            config: {
              systemInstruction: effectiveSystemInstruction,
              tools: [{ functionDeclarations: toolRegistry.toGeminiDeclarations() }]
            }
          });

          for await (const chunk of stream) {
            if (isClientDisconnected) break;
            if (chunk.text) {
              collectedParts.push({ text: chunk.text });
              streamedAnyChunk = true;
              res.write(`data: ${JSON.stringify({ chunk: chunk.text })}\n\n`);
              (res as any).flush?.();
            }
            const calls = chunk.functionCalls || [];
            for (const fc of calls) {
              sawFunctionCall = true;
              // BUG FIX (thought_signature): o Gemini 3 exige que o campo
              // thoughtSignature do functionCall seja PRESERVADO quando o turno
              // do modelo é reenviado no histórico do agente — sem ele a API
              // rejeita com 400 INVALID_ARGUMENT e o loop de tools quebra.
              const callPart: any = { functionCall: fc };
              const sig = (chunk as any)?.candidates?.[0]?.content?.parts
                ?.find((p: any) => p.functionCall?.name === fc.name)?.thoughtSignature;
              if (sig) callPart.thoughtSignature = sig;
              collectedParts.push(callPart);
            }
          }

          if (!sawFunctionCall || isClientDisconnected) break;

          // Registra o turno do modelo (com functionCalls) no histórico do agente.
          // BUG FIX: preserva os thoughtSignature dos parts (exigência do Gemini 3).
          agentContents.push({ role: 'model', parts: collectedParts.map((p: any) => p.thoughtSignature ? { ...p, thoughtSignature: p.thoughtSignature } : p) });

          // Executa cada ferramenta pedida — REAL, sob o Permission Engine
          const toolResults: any[] = [];
          for (const part of collectedParts) {
            const fc = part.functionCall;
            if (!fc) continue;

            const toolName = String(fc.name || '');
            const toolParams = (fc.args || {}) as Record<string, any>;
            const execResult = await toolRegistry.executeTool(toolName, toolParams, {
              sessionId: `server-${(req.ip || req.socket.remoteAddress || 'unknown').replace(/[^a-zA-Z0-9]/g, '_')}`,
              timestamp: new Date().toISOString()
            });

            // SSE: informa ao frontend o que REALMENTE aconteceu — CORREÇÃO (sincronização
            // tool→TTS): inclui os dados completos (resultData) para que o frontend injete
            // o resultado REAL na voz. Sem isso, o LLM 'alucinava não ter localização' pois
            // o TTS falava antes/de independente do retorno da ferramenta.
            const resultDataPayload = execResult.data || null;
            res.write(`data: ${JSON.stringify({
              toolExecuted: toolName,
              success: execResult.success,
              simulated: execResult.simulated,
              error: execResult.error,
              riskLevel: execResult.riskLevel,
              resultSummary: execResult.success ? (execResult.data?.message || (execResult.data ? 'Executado e verificado no servidor local.' : 'Executado.')) : (execResult.error || 'Falhou'),
              resultData: resultDataPayload
            })}\n\n`);
            (res as any).flush?.();

            toolResults.push({
              functionResponse: {
                name: toolName,
                response: execResult.success
                  ? { success: true, data: execResult.data, simulated: execResult.simulated }
                  : { success: false, error: execResult.error || 'Execução falhou' }
              }
            });
          }

          agentContents.push({ role: 'user', parts: toolResults });
        }

        await runStream(activeModel, agentContents);
      } catch (streamErr: any) {
        const errorInfo = classifyErrorStatus(streamErr);
        // CORREÇÃO (Etapa 2 — visão travada em THINKING infinito): quando a quota
        // do Gemini Free Tier estoura e nada foi streamado, responde com SSE
        // estruturado e ENCERRA a conexão em vez de deixar a interface pensando
        // para sempre. O frontend reconhece o failover e fala o aviso por voz.
        if (!streamedAnyChunk && (errorInfo.code === 'UNAVAILABLE' || errorInfo.code === 'QUOTA_ERROR')) {
          if (activeOpenRouterKey && activeOpenRouterKey.trim().length >= 5) {
            console.info(`[Model Router] OpenRouter automatic failover active.`);
            res.write(`data: ${JSON.stringify({ failover: true, provider: 'openrouter', message: 'Limite do Gemini atingido (Quota/Rate Limit). Alternando para a chave OpenRouter de contingência.' })}\n\n`);
            (res as any).flush?.();
            try {
              await callOpenRouterFallback(contents, effectiveSystemInstruction, (delta) => {
                if (!isClientDisconnected) {
                  streamedAnyChunk = true;
                  res.write(`data: ${JSON.stringify({ chunk: delta })}\n\n`);
                  (res as any).flush?.();
                }
              }, activeOpenRouterKey);
              activeModel = 'openrouter/fallback';
            } catch (fallbackErr: any) {
              console.warn(`[Model Router] OpenRouter failover error:`, fallbackErr?.message || fallbackErr);
              res.write(`data: ${JSON.stringify({ error: `Cota do Gemini excedida e falha no OpenRouter: ${fallbackErr?.message || 'Erro desconhecido'}` })}\n\n`);
              (res as any).flush?.();
            }
          } else if (activeModel !== 'gemini-3.1-flash-lite') {
            console.info(`[Model Router] Transitioning ${activeModel} to gemini-3.1-flash-lite.`);
            activeModel = 'gemini-3.1-flash-lite';
            const safeContents = sanitizeContentsForFallback(contents);
            const stream = await ai.models.generateContentStream({
              model: activeModel,
              contents: safeContents,
              config: {
                systemInstruction: effectiveSystemInstruction,
              }
            });
            for await (const chunk of stream) {
              if (isClientDisconnected) break;
              const chunkText = chunk.text;
              if (chunkText) {
                streamedAnyChunk = true;
                res.write(`data: ${JSON.stringify({ chunk: chunkText })}\n\n`);
                (res as any).flush?.();
              }
            }
          } else if (process.env.OPENROUTER_API_KEY) {
            console.info(`[Model Router] Transitioning to OpenRouter backup.`);
            res.write(`data: ${JSON.stringify({ failover: true, provider: 'openrouter', message: 'Serviço temporariamente indisponível. Alternando para o provedor de backup.' })}\n\n`);
            (res as any).flush?.();
            try {
              await callOpenRouterFallback(contents, effectiveSystemInstruction, (delta) => {
                if (!isClientDisconnected) {
                  streamedAnyChunk = true;
                  res.write(`data: ${JSON.stringify({ chunk: delta })}\n\n`);
                  (res as any).flush?.();
                }
              });
              activeModel = 'openrouter/fallback';
            } catch (fallbackErr: any) {
              console.warn(`[Model Router] OpenRouter backup error:`, fallbackErr?.message || fallbackErr);
              throw streamErr;
            }
          } else {
            throw streamErr;
          }
        } else {
          throw streamErr;
        }
      }

      if (!isClientDisconnected) {
        res.write(`data: ${JSON.stringify({ done: true, modelUsed: activeModel })}\n\n`);
        (res as any).flush?.();
      }
      res.end();
    } catch (err: any) {
      console.error("Gemini API Streaming Error:", err);
      const { status, code, message } = classifyErrorStatus(err);

      if (!streamStarted) {
        return res.status(status).json({ error: message, code });
      } else {
        res.write(`data: ${JSON.stringify({ error: message, code })}\n\n`);
        res.end();
      }
    }
  });

  // ==================== PULO PAIRING PROTOCOL (Fase 2: Pareamento REAL de celular) ====================
  // Token de pareamento efêmero emitido pelo PC; o celular escaneia o QR que contém
  // http://<ip-do-pc>:<porta>/pair?token=... — abre no navegador, valida, registra o dispositivo.
  const activePairTokens = new Map<string, { expiresAt: number; deviceLabel?: string }>();

  // Varredura REAL da rede local (SSDP/WS-Discovery leve): tenta descobrir dispositivos
  // de exibição (Smart TVs) via SSDP M-SEARCH na interface local. Sem rede/timeout,
  // retorna lista vazia com aviso — nunca fixtures fixas.
  app.post('/api/devices/scan', async (_req, res) => {
    try {
      const dgram = await import('node:dgram');
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const found: Array<{ id: string; name: string; type: string; ip: string; protocol: string; manufacturer: string; paired: boolean }> = [];
      const seenIps = new Set<string>();

      socket.on('message', (msg, rinfo) => {
        try {
          const text = msg.toString('utf8');
          if (!text.includes('200 OK')) return;
          const location = /LOCATION:\s*(\S+)/i.exec(text)?.[1] || '';
          const server = /SERVER:\s*(.+)/i.exec(text)?.[1] || '';
          const usn = /USN:\s*(\S+)/i.exec(text)?.[1] || '';
          if (!rinfo.address || seenIps.has(rinfo.address)) return;
          seenIps.add(rinfo.address);
          const isTv = /tv|television|cast|webos|tizen|roku/i.test(server + ' ' + location);
          if (!isTv) return;
          found.push({
            id: `discovered-${usn || rinfo.address.replace(/\./g, '-')}`.slice(0, 64),
            name: server.split(',')[0]?.trim() || `Dispositivo em ${rinfo.address}`,
            type: 'tv',
            ip: rinfo.address,
            protocol: location || 'SSDP descoberto',
            manufacturer: server.split(',')[1]?.trim() || 'Desconhecido',
            paired: false
          });
        } catch {}
      });
      socket.on('error', () => { try { socket.close(); } catch {} });

      socket.bind(() => {
        try {
          const searchMsg = Buffer.from([
            'M-SEARCH * HTTP/1.1',
            'HOST: 239.255.255.250:1900',
            'MAN: "ssdp:discover"',
            'MX: 2',
            'ST: ssdp:all',
            '',
            ''
          ].join('\r\n'));
          socket.send(searchMsg, 1900, '239.255.255.250');
        } catch {}
      });

      // Janela de escuta de 4s para respostas SSDP
      setTimeout(() => {
        try { socket.close(); } catch {}
        res.json({ success: true, devices: found, scannedAt: new Date().toISOString() });
      }, 4000);
    } catch (err: any) {
      res.json({ success: true, devices: [], error: err?.message || 'SSDP indisponível nesta rede' });
    }
  });

  // Emite um token de pareamento (o frontend chama ao abrir o modal de pareamento)
  app.post('/api/pair/token', (req, res) => {
    const token = `pulo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    activePairTokens.set(token, { expiresAt: Date.now() + 120_000 }); // TTL 120s
    // Limpeza de tokens expirados
    for (const [k, v] of activePairTokens) {
      if (v.expiresAt < Date.now()) activePairTokens.delete(k);
    }

    // Descobre IPs locais reais para o QR
    const nets = os.networkInterfaces();
    const lanIps: string[] = [];
    for (const name of Object.keys(nets)) {
      for (const net of (nets as any)[name] || []) {
        if (net.family === 'IPv4' && !net.internal) {
          lanIps.push(net.address);
        }
      }
    }
    const port = Number(process.env.PORT || 3000); // porta de exibição para QR pairing
    const primaryIp = lanIps[0] || 'localhost';

    res.json({
      success: true,
      token,
      expiresInMs: 120_000,
      pairUrl: `http://${primaryIp}:${port}/pair?token=${token}`,
      lanIps,
      port
    });
  });

  // Página que o celular abre ao escanear o QR
  app.get('/pair', (req, res) => {
    const token = String(req.query.token || '');
    const entry = activePairTokens.get(token);
    const valid = Boolean(entry && entry.expiresAt > Date.now());

    const html = `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>LIORA Companion — Pareamento</title>
<style>
  body { font-family: system-ui, sans-serif; background:#050505; color:#F5F5F5; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:24px; }
  .card { background:#111; border:1px solid #262626; border-radius:16px; padding:28px; max-width:380px; width:100%; text-align:center; }
  .logo { font-size:26px; font-weight:800; letter-spacing:4px; color:#FF2B2B; margin-bottom:8px; }
  input, button { width:100%; box-sizing:border-box; margin-top:12px; padding:12px; border-radius:10px; font-size:15px; }
  input { background:#171717; border:1px solid #2E2E2E; color:#fff; }
  button { background:#FF2B2B; color:#fff; border:none; font-weight:700; cursor:pointer; }
  .ok { color:#34d399; } .err { color:#f87171; font-size:13px; margin-top:10px; }
  .hint { color:#888; font-size:12px; margin-top:14px; }
</style></head>
<body><div class="card">
  <div class="logo">LIORA</div>
  <p style="color:#A8A8A8;font-size:14px;margin:6px 0 14px;">Pareamento do seu celular com o PC via rede local.</p>
  ${valid ? `
    <input id="devname" placeholder="Nome do seu celular (ex: Galaxy S24)" />
    <button id="pairBtn">Vincular ao PC</button>
    <div id="msg"></div>
    <p class="hint">Nenhum dado sai da sua rede Wi-Fi. A conexão é direta com o seu PC.</p>
    <script>
      document.getElementById('pairBtn').onclick = async () => {
        const name = document.getElementById('devname').value.trim() || 'Celular';
        const msg = document.getElementById('msg');
        msg.textContent = 'Conectando...';
        try {
          const r = await fetch('/api/pair/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: ${JSON.stringify(token)}, deviceName: name, userAgent: navigator.userAgent })
          });
          const d = await r.json();
          if (d.success) {
            msg.innerHTML = '<span class="ok">✔ Vinculado! Pode fechar esta página.</span>';
            document.getElementById('pairBtn').disabled = true;
          } else {
            msg.innerHTML = '<span class="err">' + (d.error || 'Falha no pareamento') + '</span>';
          }
        } catch (e) {
          msg.innerHTML = '<span class="err">Sem conexão com o PC. Mesma rede Wi-Fi?</span>';
        }
      };
    <\/script>`
  : `<p class="err">Token expirado ou inválido. Gere um novo QR no PC.</p>`}
</div></body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  // Registro real do celular pareado (chamado pela página do celular)
  const pairWaiters = new Map<string, Array<(device: any) => void>>();

  app.post('/api/pair/register', (req, res) => {
    const { token, deviceName, userAgent } = req.body || {};
    const entry = activePairTokens.get(token);
    if (!entry || entry.expiresAt < Date.now()) {
      return res.status(403).json({ success: false, error: 'TOKEN_INVALID_OR_EXPIRED' });
    }
    activePairTokens.delete(token);

    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const isAndroid = /android/i.test(userAgent || '');
    const isIos = /iphone|ipad/i.test(userAgent || '');
    const device = {
      id: `dev-companion-${Date.now().toString(36)}`,
      name: String(deviceName || (isIos ? 'iPhone' : 'Android')).slice(0, 60),
      type: 'android' as const,
      status: 'ONLINE' as const,
      connected: true,
      ip: clientIp,
      osInfo: isIos ? 'iOS (Companion Web)' : 'Android (Companion Web)',
      lastSeen: new Date().toISOString(),
      capabilities: ['voice_stream', 'context_sync', 'push_notification'],
      isSimulated: false,
      pairedVia: 'PULO_QR',
      telemetry: {
        lastUpdated: new Date().toISOString(),
        isRealHardware: true
      }
    };

    // Notifica todos os waiters (SSE listeners no PC)
    const waiters = pairWaiters.get(token) || [];
    for (const w of waiters) w(device);
    pairWaiters.delete(token);

    (globalThis as any).__lioraLastPairedDevice = device;
    res.json({ success: true, deviceId: device.id });
  });

  // SSE no PC: aguarda o celular concluir o pareamento
  app.get('/api/pair/wait', (req, res) => {
    const token = String(req.query.token || '');
    const entry = activePairTokens.get(token);
    if (!entry || entry.expiresAt < Date.now()) {
      return res.status(403).json({ success: false, error: 'TOKEN_INVALID_OR_EXPIRED' });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders?.();

    let settled = false;
    const waiter = (device: any) => {
      if (settled) return;
      settled = true;
      res.write(`data: ${JSON.stringify({ paired: true, device })}\n\n`);
      res.end();
    };
    const arr = pairWaiters.get(token) || [];
    arr.push(waiter);
    pairWaiters.set(token, arr);

    // Timeout: encerra o SSE quando o token expira
    const remaining = entry.expiresAt - Date.now() + 1000;
    setTimeout(() => {
      if (!settled) {
        settled = true;
        res.write(`data: ${JSON.stringify({ paired: false, reason: 'TOKEN_EXPIRED' })}\n\n`);
        res.end();
      }
    }, Math.max(1000, remaining));

    req.on('close', () => { settled = true; });
  });

  // Último dispositivo pareado (polling de contingência)
  app.get('/api/pair/last', (_req, res) => {
    const device = (globalThis as any).__lioraLastPairedDevice;
    res.json({ success: Boolean(device), device: device || null });
  });

  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      time: new Date().toISOString(),
      model: 'gemini-3.1-flash-lite',
      hasApiKey: Boolean(process.env.GEMINI_API_KEY)
    });
  });

  // Simple in-memory rate limiter for tool execution endpoint (Marco 6.1.2)
  const executionRateLimits = new Map<string, { count: number; resetAt: number }>();
  const RATE_LIMIT_WINDOW_MS = 60 * 1000;
  const MAX_REQUESTS_PER_WINDOW = 60;

  // Security Audit Log: Query recent audit events (Marco 6.2E)
  app.get(['/api/security/audit', '/api/audit'], (req, res) => {
    try {
      const limitParam = req.query.limit ? Number(req.query.limit) : 50;
      const eventTypeParam = req.query.eventType as any;
      const decisionParam = req.query.decision as any;
      const toolNameParam = req.query.toolName as string;
      const orderParam = (req.query.order === 'asc' ? 'asc' : 'desc') as any;

      const events = auditLogger.queryEvents({
        limit: isNaN(limitParam) ? 50 : limitParam,
        eventType: eventTypeParam,
        decision: decisionParam,
        toolName: toolNameParam,
        order: orderParam
      });

      res.setHeader('Content-Type', 'application/json');
      res.json({
        success: true,
        count: events.length,
        maxCapacity: auditLogger.maxCapacity,
        events,
        timestamp: new Date().toISOString()
      });
    } catch (err: any) {
      res.status(500).setHeader('Content-Type', 'application/json').json({
        success: false,
        error: 'Erro ao consultar o log de auditoria de segurança.',
        code: 'INTERNAL_ERROR',
        simulated: true
      });
    }
  });

  // CORREÇÃO (Etapa 6 — consentimento de UI para operações R2 pelo painel):
  // Emite um token HMAC de consentimento quando o OPERADOR clica num botão de
  // ação R2 na UI (ex: excluir credencial do cofre). O clique explícito É o
  // consentimento — equivalente auditável ao ConsentCard por voz/chat. Token
  // com TTL curto (60s) e consumo anti-replay pelo PermissionEngine.
  // CORREÇÃO (Etapa 6 — consentimento de UI): mapa de tokens de consentimento emitidos
  // pelo painel de cofre (clique do operador = consentimento explícito, TTL 60s)
  const activeUiConsentTokens = new Map<string, { toolName: string; parametersHash: string; expiresAt: number; signature: string }>();

  app.post('/api/security/ui-consent', (req, res) => {
    try {
      const { toolName, parameters = {} } = req.body || {};
      if (!toolName || typeof toolName !== 'string') {
        return res.status(400).json({ success: false, error: 'toolName obrigatório.', code: 'INVALID_INPUT' });
      }

      // Somente ferramentas do cofre podem ser consentidas por clique de UI
      const UI_CONSENT_TOOLS = new Set(['vault_store_credential', 'vault_delete_credential', 'vault_get_credential']);
      if (!UI_CONSENT_TOOLS.has(toolName)) {
        return res.status(403).json({
          success: false,
          error: `Ferramenta '${toolName}' não é elegível para consentimento de UI.`,
          code: 'TOOL_NOT_UI_CONSENTIBLE'
        });
      }

      const parametersHash = computeParametersHash(parameters);
      const ttlSeconds = 60;
      const token = `ui-consent-${Date.now()}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
      const signature = createHash('sha256')
        .update(`${token}|${toolName}|${parametersHash}|${Date.now()}`)
        .digest('hex');

      activeUiConsentTokens.set(token, {
        toolName,
        parametersHash,
        expiresAt: Date.now() + ttlSeconds * 1000,
        signature
      });

      // GC do mapa
      if (activeUiConsentTokens.size > 200) {
        const now = Date.now();
        for (const [t, v] of activeUiConsentTokens) {
          if (v.expiresAt < now) activeUiConsentTokens.delete(t);
        }
      }

      res.json({ success: true, token, expiresInSeconds: ttlSeconds });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'Falha ao emitir consentimento de UI.' });
    }
  });

  // Security Audit Log: Clear audit trail buffer (Marco 6.2E)
  app.delete(['/api/security/audit', '/api/audit'], (req, res) => {
    try {
      auditLogger.clear();
      permissionEngine.clearAuditEvents();
      res.setHeader('Content-Type', 'application/json');
      res.json({
        success: true,
        message: 'Trilha de auditoria resetada com sucesso.',
        timestamp: new Date().toISOString()
      });
    } catch (err: any) {
      res.status(500).setHeader('Content-Type', 'application/json').json({
        success: false,
        error: 'Erro ao resetar a trilha de auditoria de segurança.',
        code: 'INTERNAL_ERROR',
        simulated: true
      });
    }
  });

  // Tool Registry: List all available registered tools (Marco 6.1)
  app.get(['/api/tools', '/api/tools/catalog', '/api/tools/list'], (req, res) => {
    const tools = toolRegistry.listTools();
    res.setHeader('Content-Type', 'application/json');
    res.json({
      tools,
      count: tools.length,
      simulated: true,
      timestamp: new Date().toISOString()
    });
  });

  // Receptor HTTP de Webhooks com validação HMAC SHA-256 e Anti-Replay (janela estrita de 5 minutos)
  app.post('/api/webhooks/:provider', async (req, res) => {
    try {
      const provider = req.params.provider as any;
      const signature = (req.headers['x-hub-signature-256'] || req.headers['x-signature'] || req.headers['authorization']) as string;
      const timestampHeader = (req.headers['x-webhook-timestamp'] || req.headers['x-liora-timestamp'] || req.body?.timestamp) as string;

      const eventType = req.body?.event || req.body?.type || 'external.event';
      const payload = req.body?.payload || req.body || {};

      const event = await integrationsVault.ingestWebhook(provider, eventType, payload, signature, timestampHeader);
      return res.status(200).json({ success: true, eventId: event.id, status: 'PROCESSED' });
    } catch (err: any) {
      const isReplay = String(err?.message || '').includes('Replay Attack') || String(err?.message || '').includes('desfasagem temporal');
      const isBadSig = String(err?.message || '').includes('HMAC');
      const status = (isReplay || isBadSig) ? 401 : 400;
      return res.status(status).json({ success: false, error: err?.message || 'Falha no processamento do webhook.' });
    }
  });

  // Tool Registry: Execute tool with validation and provisional security guard (Marco 6.1.2)
  app.post('/api/tools/execute', async (req, res) => {
    try {
      // In-memory rate limiting check
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const clientLimit = executionRateLimits.get(clientIp);

      if (!clientLimit || now > clientLimit.resetAt) {
        executionRateLimits.set(clientIp, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      } else {
        clientLimit.count++;
        if (clientLimit.count > MAX_REQUESTS_PER_WINDOW) {
          return res.status(429).json({
            success: false,
            error: 'Limite de requisições excedido para o endpoint de ferramentas. Aguarde um momento.',
            code: 'RATE_LIMIT_EXCEEDED',
            simulated: true
          });
        }
      }

      const { toolName, parameters = {} } = req.body || {};

      if (!toolName || typeof toolName !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Parâmetro obrigatório "toolName" ausente ou inválido.',
          code: 'INVALID_INPUT',
          simulated: true
        });
      }

      if (!toolRegistry.hasTool(toolName)) {
        return res.status(404).json({
          success: false,
          error: `Ferramenta '${toolName}' não encontrada no Tool Registry.`,
          code: 'TOOL_NOT_FOUND',
          simulated: true
        });
      }

      const toolDef = toolRegistry.getTool(toolName);

      // Obtenção ou geração de session ID confiável pelo servidor (ou cabeçalho se válido)
      const clientSessionId = (req.headers['x-liora-session-id'] as string) || 
                              (req.cookies && (req.cookies['liora_session'] as string)) || 
                              `server-session-${clientIp.replace(/[^a-zA-Z0-9]/g, '_')}`;

      const context = {
        sessionId: clientSessionId,
        clientIp,
        serverTimestamp: Date.now()
      };

      // Avaliação dinâmica analítica via Permission Engine (Marco 6.2D)
      // NENHUM handler de ferramenta real é executado. A resposta é puramente analítica.
      // CORREÇÃO (Etapa 6 — UI do cofre): a UI pode enviar um consentToken emitido
      // pelo fluxo interativo (o clique no botão É o consentimento do operador —
      // equivalente auditável ao ConsentCard por voz). Sem token, R1/R2 são DENY
      // com REQUIRES_USER_CONFIRMATION como antes.
      const uiConsentToken = typeof req.headers['x-liora-ui-consent'] === 'string'
        ? (req.headers['x-liora-ui-consent'] as string)
        : undefined;

      // CORREÇÃO (Etapa 6): valida e CONSOME o token de consentimento de UI no lado
      // do servidor (anti-replay): expira em 60s, single-use, binding tool+params.
      let uiConsentValid = false;
      if (uiConsentToken) {
        const record = activeUiConsentTokens.get(uiConsentToken);
        if (record) {
          const parametersHash = computeParametersHash(parameters);
          const stillValid = record.expiresAt > Date.now()
            && record.toolName === toolName
            && record.parametersHash === parametersHash;
          if (stillValid) {
            activeUiConsentTokens.delete(uiConsentToken); // consumo atômico (anti-replay)
            uiConsentValid = true;
          }
        }
      }

      // riskLevel explícito do registry (resolve R1/R2 para tools fora da whitelist R0)
      const toolRiskLevel = toolDef?.riskLevel as any;
      // Consentimento HMAC sintético quando o token de UI é válido — o PermissionEngine
      // consome o token pelo mesmo caminho do ConsentCard por voz (consumeConsentToken),
      // mantendo a auditoria e o anti-replay unificados.
      const evaluation = await permissionEngine.evaluate(toolName, parameters, context, {
        riskLevel: toolRiskLevel,
        consentToken: uiConsentValid ? `ui-consent-validated-${toolName}` : undefined
      });

      if (evaluation.decision === 'ALLOW') {
        const execResult = await toolRegistry.executeTool(toolName, parameters);
        return res.status(execResult.success ? 200 : 400).json({
          success: execResult.success,
          toolName,
          decision: 'ALLOW',
          riskLevel: evaluation.riskLevel,
          data: execResult.data,
          error: execResult.error,
          verification: execResult.verification,
          simulated: Boolean(execResult.simulated),
          parametersHash: evaluation.parametersHash,
          timestamp: evaluation.timestamp,
          auditId: evaluation.auditId,
          message: execResult.success
            ? 'Operação autorizada pelo Permission Engine e verificada pelo Verifier Engine.'
            : execResult.error
        });
      } else {
        const httpStatus = evaluation.code === 'SESSION_INVALID_OR_MISSING' ? 401 : 403;
        return res.status(httpStatus).json({
          success: false,
          toolName,
          decision: 'DENY',
          riskLevel: evaluation.riskLevel,
          code: evaluation.code || 'SECURITY_CONSTRAINT_VIOLATION',
          error: evaluation.reason,
          simulated: true,
          timestamp: evaluation.timestamp,
          auditId: evaluation.auditId
        });
      }

    } catch (err: any) {
      console.error('Erro no endpoint de ferramentas:', err);
      res.status(500).json({
        success: false,
        error: 'Erro interno do servidor ao processar requisição de ferramentas.',
        code: 'INTERNAL_ERROR',
        simulated: true
      });
    }
  });

  // Explicit JSON 404 for unhandled /api/* routes to prevent Vite SPA HTML fallback
  app.all('/api/*', (req, res) => {
    res.status(404).setHeader('Content-Type', 'application/json').json({
      success: false,
      error: `Endpoint da API não encontrado: ${req.method} ${req.path}`,
      code: 'NOT_FOUND'
    });
  });

  // Setup Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        // CORREÇÃO (porta 24678 em uso): fixa a porta do HMR e desativa o
        // StrictPort fallback silencioso — com hmr.port explícito, instâncias
        // anteriores em colisão produzem warning claro em vez de comportamento
        // imprevisível de porta aleatória.
        hmr: { port: Number(process.env.VITE_HMR_PORT || 24678) }
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  const port = Number(process.env.PORT || explicitPort || 3000);
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  activeWsServer = wss;
  // FIX (hang dos testes): fecha todas as sessões Playwright no shutdown
  try {
    const { closeAllBrowserSessions } = await import('./src/tools/browser/playwrightTool');
    activeBrowserCloser = closeAllBrowserSessions;
  } catch { /* playwright indisponível — nada a fechar */ }

  server.on('upgrade', (request, socket, head) => {
    const parsedUrl = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
    
    if (parsedUrl.pathname === '/ws/voice') {
      const origin = request.headers.origin;
      const host = request.headers.host;
      if (origin && host) {
        try {
          const originUrl = new URL(origin);
          const isLocal = originUrl.hostname === 'localhost' || originUrl.hostname === '127.0.0.1';
          const isSameHost = originUrl.host === host;
          const isAISStudio = originUrl.hostname.endsWith('run.app') || 
                              originUrl.hostname.endsWith('aistudio.google.com') ||
                              originUrl.hostname.endsWith('googleusercontent.com') ||
                              originUrl.hostname.endsWith('usercontent.goog') ||
                              origin === 'null';
          if (!isLocal && !isSameHost && !isAISStudio && process.env.NODE_ENV === 'production') {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
          }
        } catch (e) {
          // Allow connection to proceed if origin is malformed or null in sandbox
        }
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    }
  });

  const activeConnections = liveConnections;
  const MAX_CONNECTIONS = 50;

  // Exaustão: heartbeat anti-vazamento. Conexões mortas (rede caiu sem FIN/RST
  // elegante — ex: laptop fechado, Wi-Fi perdido) permaneciam no Set para sempre,
  // consumindo memória e ocupando slots do MAX_CONNECTIONS até reiniciar o server.
  const HEARTBEAT_INTERVAL_MS = 30000;
  // BUG FIX: ws.ping() em socket half-open não falha imediatamente — o padrão
  // correto é ping → aguardar pong com timeout de 1 ciclo. Conexões que não
  // respondem pong são terminadas (evita esgotamento lento de slots).
  const wsHeartbeat = setInterval(() => {
    for (const ws of activeConnections) {
      if (ws.readyState !== WebSocket.OPEN) {
        try { ws.terminate(); } catch {}
        activeConnections.delete(ws);
        continue;
      }
      if ((ws as any).isAlive === false) {
        // Ciclo anterior sem pong — socket half-open, encerra
        try { ws.terminate(); } catch {}
        activeConnections.delete(ws);
        continue;
      }
      (ws as any).isAlive = false;
      try {
        ws.ping();
      } catch {
        try { ws.terminate(); } catch {}
        activeConnections.delete(ws);
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  wss.on('connection', (ws) => {
    (ws as any).isAlive = true;
    ws.on('pong', () => { (ws as any).isAlive = true; });
  });
  // Não deixa o timer segurar o encerramento do processo (stopServer dos testes)
  if (typeof wsHeartbeat === 'object' && wsHeartbeat !== null && 'unref' in wsHeartbeat) {
    (wsHeartbeat as any).unref();
  }

  wss.on('connection', (ws) => {
    if (activeConnections.size >= MAX_CONNECTIONS) {
      ws.close(1013, 'Server overloaded');
      return;
    }

    activeConnections.add(ws);

    let liveSession: any = null;
    let liveState: 'OFF' | 'CONNECTING' | 'ACTIVE' | 'CLOSING' = 'OFF';
    const liveSessionId = `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let sessionTimeoutTimer: NodeJS.Timeout | null = null;
    let sessionDurationTimer: NodeJS.Timeout | null = null;
    let lastSessionAttempt = 0;

    const cleanupLive = () => {
      if (sessionTimeoutTimer) {
        clearTimeout(sessionTimeoutTimer);
        sessionTimeoutTimer = null;
      }
      if (sessionDurationTimer) {
        clearTimeout(sessionDurationTimer);
        sessionDurationTimer = null;
      }
      if (liveSession) {
        try {
          liveSession.close();
        } catch (e) {
          // ignore
        }
        liveSession = null;
      }
      liveState = 'OFF';
    };

    // Send TRANSPORT_CONNECTED message as required
    ws.send(JSON.stringify({
      type: 'TRANSPORT_CONNECTED',
      message: 'Canal WebSocket interno seguro estabelecido com sucesso.',
      timestamp: new Date().toISOString()
    }));

    ws.on('message', async (data, isBinary) => {
      const dataLen = Buffer.isBuffer(data) ? data.length : Buffer.from(data as any).length;
      if (dataLen > 64 * 1024) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Payload muito grande (limite 64KB).' }));
        ws.close(1009, 'Message too big');
        return;
      }

      // 1. Processamento de pacotes binários de áudio nativo (PCM 16-bit 16kHz)
      if (isBinary) {
        if (liveState !== 'ACTIVE' || !liveSession) {
          ws.send(JSON.stringify({ 
            type: 'AUDIO_CHUNK_REJECTED', 
            reason: 'Nenhuma sessão Gemini Live ativa.', 
            bytesReceived: dataLen 
          }));
          return;
        }

        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
        try {
          if (liveSession.sendRealtimeInput) {
            liveSession.sendRealtimeInput({
              audio: { 
                data: buffer.toString('base64'), 
                mimeType: 'audio/pcm;rate=16000' 
              }
            });
          }
          ws.send(JSON.stringify({ 
            type: 'AUDIO_CHUNK_ACK', 
            bytes: buffer.length,
            timestamp: new Date().toISOString()
          }));
        } catch (err: any) {
          console.error('[WebSocket Voice] Erro ao despachar chunk binário:', err);
          ws.send(JSON.stringify({ 
            type: 'GEMINI_LIVE_ERROR', 
            message: 'Falha ao processar streaming binário de áudio.' 
          }));
        }
        return;
      }

      // 2. Processamento de mensagens de controle e sinalização JSON
      try {
        const payload = JSON.parse(data.toString());
        if (payload.type === 'PING') {
          ws.send(JSON.stringify({ type: 'PONG', timestamp: new Date().toISOString() }));
          return;
        }

        if (payload.type === 'START_LIVE') {
          if (liveState === 'ACTIVE' && liveSession) {
            ws.send(JSON.stringify({ 
              type: 'GEMINI_LIVE_READY', 
              alreadyActive: true, 
              message: 'Sessão Gemini Live já se encontra ativa.' 
            }));
            return;
          }

          const VALID_GEMINI_VOICES = new Set(['Aoede', 'Kore', 'Puck', 'Charon', 'Fenrir']);
          const requestedVoice = VALID_GEMINI_VOICES.has(payload.voice) ? payload.voice : 'Aoede';

          // Modo mock para testes unitários automatizados ou isolados
          if (payload.mock === true) {
            liveState = 'ACTIVE';
            liveSession = {
              sendRealtimeInput: (_input: any) => {},
              sendClientContent: (_content: any) => {},
              close: () => {}
            };
            ws.send(JSON.stringify({
              type: 'GEMINI_LIVE_READY',
              simulated: true,
              model: payload.model || 'gemini-3.8-live',
              voice: requestedVoice,
              message: 'Sessão Gemini Live simulada ativada para testes de canal de áudio.'
            }));
            return;
          }

          const liveApiKey = payload.apiKey || process.env.GEMINI_API_KEY;

          if (!liveApiKey) {
            ws.send(JSON.stringify({
              type: 'GEMINI_LIVE_ERROR',
              code: 'NO_API_KEY',
              message: 'Chave de API do Gemini não configurada no servidor ou no cofre.'
            }));
            return;
          }

          try {
            liveState = 'CONNECTING';
            const requestedModel = payload.model || 'gemini-3.8-live';

            const liveAiClient = payload.apiKey ? new GoogleGenAI({
              apiKey: payload.apiKey,
              httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
            }) : ai;

            liveSession = await liveAiClient.live.connect({
              model: requestedModel,
              config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: requestedVoice }
                  }
                },
                // P0 (paridade voz x chat): mesma arsenal de ferramentas do chat de texto.
                // O Gemini Live agora pode chamar navigateToTab, system_info, calculate_route,
                // triggerAutomation etc. exatamente como no /api/gemini/chat/stream.
                tools: [{ functionDeclarations: toolRegistry.toGeminiDeclarations() }],
                systemInstruction: payload.systemInstruction || DEFAULT_SYSTEM_INSTRUCTION
              },
              callbacks: {
                onmessage: (liveMsg: any) => {
                  if (ws.readyState !== WebSocket.OPEN) return;

                  // Chunks de áudio sintetizado retornado pelo modelo (24kHz PCM)
                  const parts = liveMsg.serverContent?.modelTurn?.parts || [];
                  for (const part of parts) {
                    if (part.inlineData?.data) {
                      ws.send(JSON.stringify({
                        type: 'AUDIO_OUTPUT',
                        audio: part.inlineData.data,
                        mimeType: 'audio/pcm;rate=24000',
                        timestamp: new Date().toISOString()
                      }));
                    }
                    if (part.text) {
                      ws.send(JSON.stringify({
                        type: 'TRANSCRIPTION',
                        text: part.text,
                        role: 'model',
                        timestamp: new Date().toISOString()
                      }));
                    }
                  }

                  // Transcrição de saída do modelo em tempo real
                  const outTranscription = liveMsg.serverContent?.outputTranscription?.text;
                  if (outTranscription) {
                    ws.send(JSON.stringify({
                      type: 'TRANSCRIPTION',
                      text: outTranscription,
                      role: 'model',
                      timestamp: new Date().toISOString()
                    }));
                  }

                  if (liveMsg.serverContent?.interrupted) {
                    ws.send(JSON.stringify({ type: 'INTERRUPTED', interrupted: true }));
                  }

                  // P0: function calling loop no canal Live — o modelo pediu uma ferramenta.
                  // Executa REALMENTE via toolRegistry (mesmo caminho do chat de texto, com
                  // PermissionEngine + auditoria) e devolve o functionResponse ao modelo.
                  const liveCalls = liveMsg.toolCall?.functionCalls || [];
                  for (const fc of liveCalls) {
                    void (async () => {
                      const toolName = String(fc.name || '');
                      const toolParams = (fc.args || {}) as Record<string, any>;
                      try {
                        const execResult = await toolRegistry.executeTool(toolName, toolParams, {
                          sessionId: `voice-live-${liveSessionId}`,
                          timestamp: new Date().toISOString()
                        });

                        // Notifica a UI em tempo real (mesmo contrato de data.toolExecuted do chat)
                        ws.send(JSON.stringify({
                          type: 'TOOL_EXECUTED',
                          toolName,
                          success: execResult.success,
                          simulated: execResult.simulated,
                          error: execResult.error,
                          riskLevel: execResult.riskLevel,
                          resultSummary: execResult.success
                            ? (execResult.data ? 'Executado e verificado no servidor local.' : 'Executado.')
                            : (execResult.error || 'Falhou'),
                          data: execResult.data,
                          timestamp: new Date().toISOString()
                        }));

                        // Devolve o resultado ao modelo para que ele responda com base no fato REAL
                        try {
                          liveSession?.sendToolOutput?.({
                            functionResponses: [{
                              id: fc.id,
                              name: toolName,
                              response: execResult.success
                                ? { success: true, data: execResult.data, simulated: execResult.simulated }
                                : { success: false, error: execResult.error || 'Execução falhou' }
                            }]
                          });
                        } catch {
                          // Fallback para SDKs sem sendToolOutput: envia como conteúdo de usuário
                          liveSession?.sendClientContent?.({
                            turns: [{
                              role: 'user',
                              parts: [{
                                functionResponse: {
                                  name: toolName,
                                  response: execResult.success
                                    ? { success: true, data: execResult.data, simulated: execResult.simulated }
                                    : { success: false, error: execResult.error || 'Execução falhou' }
                                }
                              }]
                            }],
                            turnComplete: true
                          });
                        }
                      } catch (toolErr: any) {
                        console.error('[Gemini Live] Erro ao executar ferramenta:', toolErr);
                        ws.send(JSON.stringify({
                          type: 'TOOL_EXECUTED',
                          toolName,
                          success: false,
                          simulated: true,
                          error: toolErr?.message || 'Falha desconhecida na execução da ferramenta.',
                          riskLevel: 'R1',
                          resultSummary: toolErr?.message || 'Falhou',
                          timestamp: new Date().toISOString()
                        }));
                      }
                    })();
                  }
                },
                onclose: () => {
                  cleanupLive();
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                      type: 'GEMINI_LIVE_CLOSED',
                      message: 'Canal Gemini Live encerrado.'
                    }));
                  }
                },
                onerror: (liveErr: any) => {
                  console.error('[Gemini Live] Erro na sessão:', liveErr);
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                      type: 'GEMINI_LIVE_ERROR',
                      message: liveErr?.message || 'Erro inesperado na sessão Gemini Live.'
                    }));
                  }
                }
              }
            });

            liveState = 'ACTIVE';

            // Timeout de segurança: 15 minutos de duração máxima de sessão
            sessionDurationTimer = setTimeout(() => {
              cleanupLive();
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: 'GEMINI_LIVE_CLOSED',
                  message: 'Duração máxima da sessão de voz atingida (15 minutos).'
                }));
              }
            }, 15 * 60 * 1000);

            ws.send(JSON.stringify({
              type: 'GEMINI_LIVE_READY',
              model: requestedModel,
              voice: requestedVoice,
              sampleRateIn: 16000,
              sampleRateOut: 24000,
              message: 'Sessão Gemini Live multimodal inicializada com sucesso.'
            }));

          } catch (err: any) {
            cleanupLive();
            console.error('[Gemini Live] Falha ao conectar:', err);
            ws.send(JSON.stringify({
              type: 'GEMINI_LIVE_ERROR',
              message: err?.message || 'Falha ao conectar à API Gemini Live.'
            }));
          }
          return;
        }

        // Chunks de áudio em formato JSON base64
        if (payload.type === 'AUDIO_CHUNK') {
          if (liveState !== 'ACTIVE' || !liveSession) {
            ws.send(JSON.stringify({ type: 'AUDIO_CHUNK_REJECTED', reason: 'Nenhuma sessão Live ativa.' }));
            return;
          }
          const base64Audio = typeof payload.audio === 'string' ? payload.audio : '';
          if (!base64Audio) {
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Payload de áudio ausente.' }));
            return;
          }
          try {
            if (liveSession.sendRealtimeInput) {
              liveSession.sendRealtimeInput({
                audio: { data: base64Audio, mimeType: payload.mimeType || 'audio/pcm;rate=16000' }
              });
            }
            ws.send(JSON.stringify({ type: 'AUDIO_CHUNK_ACK', size: base64Audio.length }));
          } catch (err: any) {
            ws.send(JSON.stringify({ type: 'GEMINI_LIVE_ERROR', message: 'Erro ao encaminhar chunk de áudio.' }));
          }
          return;
        }

        if (payload.type === 'LIVE_MESSAGE') {
          if (liveState !== 'ACTIVE' || !liveSession) {
            ws.send(JSON.stringify({ type: 'GEMINI_LIVE_ERROR', message: 'Nenhuma sessão Gemini Live ativa.' }));
            return;
          }
          const textMsg = typeof payload.text === 'string' ? payload.text.trim() : '';
          if (!textMsg || textMsg.length > 5000) {
            ws.send(JSON.stringify({ type: 'GEMINI_LIVE_ERROR', message: 'Mensagem de texto inválida ou muito longa (limite 5000 caracteres).' }));
            return;
          }

          try {
            liveSession.sendClientContent?.({
              turns: [{ role: 'user', parts: [{ text: textMsg }] }],
              turnComplete: true
            });
            ws.send(JSON.stringify({ type: 'ACK', received: 'LIVE_MESSAGE' }));
          } catch (err: any) {
            console.error("Error sending message to Live session:", err);
            ws.send(JSON.stringify({ type: 'GEMINI_LIVE_ERROR', message: 'Erro ao enviar mensagem para a sessão Live.' }));
          }
          return;
        }

        if (payload.type === 'CLIENT_INTERRUPTED') {
          if (liveSession) {
            try {
              liveSession.sendClientContent?.({
                turns: [],
                turnComplete: true
              });
            } catch {}
          }
          ws.send(JSON.stringify({ type: 'INTERRUPTED', source: 'CLIENT_ACOUSTIC_VAD', timestamp: new Date().toISOString() }));
          return;
        }

        if (payload.type === 'STOP_LIVE') {
          liveState = 'CLOSING';
          cleanupLive();
          ws.send(JSON.stringify({ type: 'GEMINI_LIVE_CLOSED', message: 'Sessão Live encerrada pelo cliente.' }));
          return;
        }

        ws.send(JSON.stringify({ type: 'ACK', received: payload.type || 'UNKNOWN' }));

      } catch (err) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Mensagem JSON inválida.' }));
      }
    });

    ws.on('close', () => {
      cleanupLive();
      activeConnections.delete(ws);
    });

    ws.on('error', () => {
      cleanupLive();
      activeConnections.delete(ws);
    });
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`LIORA server running on http://localhost:${port}`);
  });

  // BUG FIX (EADDRINUSE): se a porta já estiver em uso (ex: backend de uma sessão
  // anterior ainda vivo, ou `npm run dev` + `npm run tauri dev` simultâneos), o
  // servidor encerra GRACIOSAMENTE com mensagem clara em vez de estourar stack
  // trace e derrubar o beforeDevCommand do Tauri com código non-zero.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error('');
      console.error(`[LIORA] A porta ${port} já está em uso por outro processo.`);
      console.error('[LIORA] Isso geralmente acontece quando um backend anterior ainda está rodando.');
      console.error('[LIORA] Opções:');
      console.error(`  1. Encerre o processo antigo:   Get-NetTCPConnection -LocalPort ${port} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`);
      console.error(`  2. Ou use outra porta:         $env:PORT = "3001"; npm run tauri dev`);
      console.error('');
      process.exit(1);
    } else {
      console.error('[LIORA] Erro no servidor HTTP:', err);
      process.exit(1);
    }
  });

  _activeHttpServer = server;
  return server;
}

let _activeHttpServer: http.Server | null = null;

/**
 * FIX 7: encerra limpo o servidor Express (usado pelos testes de integração
 * para subir/derrubar o ciclo de vida dentro da suíte, sem processo externo).
 */
export async function stopServer(): Promise<void> {
  if (_activeHttpServer) {
    const srv = _activeHttpServer;
    _activeHttpServer = null;
    // FIX (hang dos testes): fecha WebSocketServer + todas as conexões WS +
    // sessões Playwright antes do close() — handles abertos retêm o event loop
    // e o after() da suíte nunca resolve.
    try {
      if (activeWsServer) {
        for (const ws of liveConnections) {
          try { ws.terminate(); } catch { /* ignore */ }
        }
        liveConnections.clear();
        await new Promise<void>((resolve) => activeWsServer!.close(() => resolve()));
        activeWsServer = null;
      }
    } catch { /* ignore */ }

    try {
      if (activeBrowserCloser) await activeBrowserCloser();
    } catch { /* ignore */ }

    await new Promise<void>((resolve) => {
      (srv as any).closeAllConnections?.();
      srv.close(() => resolve());
    });
  }
}

// Exporta explicitamente para os testes de integração usarem (Fix 7)
export { startServer };

// Auto-start apenas quando executado diretamente como processo (não quando importado por testes)
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  // Bug hunt (unhandled rejection): startServer pode falhar (porta ocupada, EACCES)
  // — registra e encerra com código não-zero em vez de derrubar o processo silenciosamente.
  startServer().catch((err) => {
    console.error('[LIORA Server] Falha fatal ao iniciar o servidor:', err);
    process.exit(1);
  });

  // CORREÇÃO (processo órfão segurando portas): quando o `npm run tauri dev` é
  // encerrado (Ctrl+C ou término do processo pai), o child tsx server.ts podia
  // sobreviver e segurar as portas 3000/24678, fazendo o PRÓXIMO arranque falhar
  // com EADDRINUSE. O graceful shutdown libera tudo para o boot seguinte.
  const gracefulExit = async (signal: string) => {
    console.info(`\n[LIORA Server] ${signal} recebido — encerrando limpo (liberando portas 3000/24678)...`);
    try { await stopServer(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', () => void gracefulExit('SIGINT'));
  process.on('SIGTERM', () => void gracefulExit('SIGTERM'));
  // Windows: Ctrl+C em pipeline npm chega como SIGHUP em alguns cenários
  process.on('SIGHUP', () => void gracefulExit('SIGHUP'));
  // Fecha o HMR websocket server do Vite junto (parte do mesmo processo)
  process.on('exit', () => {
    try { _activeHttpServer?.closeAllConnections?.(); } catch { /* ignore */ }
  });
}

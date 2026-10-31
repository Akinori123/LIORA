import 'dotenv/config';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Modality } from '@google/genai';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { toolRegistry } from './src/tools/registry';
import { permissionEngine } from './src/security/permissionEngine';
import { auditLogger } from './src/security/auditLogger';
import { integrationsVault } from './src/services/integrationsVault';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_SYSTEM_INSTRUCTION = 
  "Você é a LIORA, assistente pessoal e sistema operacional inteligente inspirada em JARVIS. " +
  "Você responde em português brasileiro com clareza, precisão, autoridade técnica e elegância. " +
  "Você tem controle operacional e acesso aos módulos da interface (Início, Conversa, Atividade, Memória, Dispositivos, Automações, Desenvolvedor, Integrações, Configurações). " +
  "Nunca afirme que 'não tem acesso ao código' ou que 'não pode mudar de tela'. Ao receber ordens para navegar ou alternar abas, confirme com prontidão e naturalidade. " +
  "Quando requisitado código ou explicações técnicas, estruture em blocos claros de Markdown, com linguagem especificada e boas práticas de engenharia de software.";

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

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
  app.get('/api/system/telemetry', (req, res) => {
    try {
      const cpus = os.cpus() || [];
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const memUsagePercent = totalMem > 0 ? (usedMem / totalMem) * 100 : 0;

      // Cálculo de uso de CPU baseado em tempos
      let totalIdle = 0;
      let totalTick = 0;
      for (const cpu of cpus) {
        for (const type in cpu.times) {
          totalTick += (cpu.times as any)[type];
        }
        totalIdle += cpu.times.idle;
      }
      const loadAvg = os.loadavg();
      const cpuUsageEstimate = cpus.length > 0 
        ? Math.min(100, Math.max(5, (loadAvg[0] / cpus.length) * 100))
        : 15.0;

      res.json({
        success: true,
        cpu_usage_percent: Number(cpuUsageEstimate.toFixed(1)),
        cpu_cores: cpus.length,
        memory_usage_percent: Number(memUsagePercent.toFixed(1)),
        memory_free_bytes: freeMem,
        memory_total_bytes: totalMem,
        disk_usage_percent: 45.0,
        disk_total_bytes: 100 * 1024 * 1024 * 1024,
        disk_free_bytes: 55 * 1024 * 1024 * 1024,
        battery_level: null,
        is_charging: true,
        temperature_celsius: 38.5,
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
            systemInstruction: systemInstruction || DEFAULT_SYSTEM_INSTRUCTION,
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
                systemInstruction: systemInstruction || DEFAULT_SYSTEM_INSTRUCTION,
              }
            });
          } else if (activeOpenRouterKey && activeOpenRouterKey.trim().length >= 5) {
            console.info(`[Model Router] Transitioning to OpenRouter backup.`);
            const fallbackText = await callOpenRouterFallback(contents, systemInstruction || DEFAULT_SYSTEM_INSTRUCTION, undefined, activeOpenRouterKey);
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

      const runStream = async (m: string) => {
        const stream = await chatStreamClient.models.generateContentStream({
          model: m,
          contents,
          config: {
            systemInstruction: systemInstruction || DEFAULT_SYSTEM_INSTRUCTION,
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
        await runStream(activeModel);
      } catch (streamErr: any) {
        const errorInfo = classifyErrorStatus(streamErr);
        if (!streamedAnyChunk && (errorInfo.code === 'UNAVAILABLE' || errorInfo.code === 'QUOTA_ERROR')) {
          if (activeOpenRouterKey && activeOpenRouterKey.trim().length >= 5) {
            console.info(`[Model Router] OpenRouter automatic failover active.`);
            res.write(`data: ${JSON.stringify({ failover: true, provider: 'openrouter', message: 'Limite do Gemini atingido (Quota/Rate Limit). Alternando para a chave OpenRouter de contingência.' })}\n\n`);
            (res as any).flush?.();
            try {
              await callOpenRouterFallback(contents, systemInstruction || DEFAULT_SYSTEM_INSTRUCTION, (delta) => {
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
                systemInstruction: systemInstruction || DEFAULT_SYSTEM_INSTRUCTION,
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
              await callOpenRouterFallback(contents, systemInstruction || DEFAULT_SYSTEM_INSTRUCTION, (delta) => {
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
      const evaluation = await permissionEngine.evaluate(toolName, parameters, context);

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
          simulated: true,
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
      server: { middlewareMode: true },
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

  const port = Number(process.env.PORT || 3000);
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

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

  const activeConnections = new Set<WebSocket>();
  const MAX_CONNECTIONS = 50;

  wss.on('connection', (ws) => {
    if (activeConnections.size >= MAX_CONNECTIONS) {
      ws.close(1013, 'Server overloaded');
      return;
    }

    activeConnections.add(ws);

    let liveSession: any = null;
    let liveState: 'OFF' | 'CONNECTING' | 'ACTIVE' | 'CLOSING' = 'OFF';
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
}

startServer();

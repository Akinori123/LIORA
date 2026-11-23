/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { integrationsVault } from './integrationsVault';
import { toolRegistry } from '../tools/registry';
import { speechService } from './speechService';
import { audioGate } from './audioGate';
import { eventBus } from '../utils/eventBus';
import { rankMemories, formatMemoryContextBlock } from '../utils/memoryRanker';
import { auditLogger } from '../security/auditLogger';
import { createAudioChunkProcessor, AudioChunkProcessor } from '../utils/audioProcessor';
import type { MemoryEntry } from '../types';
import { useLioraStore, LIORA_SYSTEM_INSTRUCTION } from '../store/lioraStore';

/**
 * Marca (por sessão de chat) se a última resposta foi dada pelo canal Gemini Live.
 * O `lioraStore` usa isto para NÃO sintetizar outra voz por cima do áudio Live —
 * era a causa da "voz dupla" (offline + API) alternando a cada frase.
 */
export function markLiveVoiceAnsweredForChat(sessionId: string): void {
  try {
    useLioraStore.getState().markLiveVoiceAnswered(sessionId || 'default-session');
  } catch {}
}

export type VoiceLiveStatus = 'IDLE' | 'CONNECTING' | 'LISTENING' | 'SPEAKING' | 'ERROR';

export interface VoiceLiveCallbacks {
  onStatusChange?: (status: VoiceLiveStatus) => void;
  onAudioLevel?: (level: number) => void; // 0.0 to 1.0
  onTranscription?: (text: string, role: 'user' | 'model') => void;
  onError?: (errorMessage: string) => void;
}

export interface VoiceLiveConfig {
  model?: string;
  voice?: 'Aoede' | 'Puck' | 'Charon' | 'Kore' | 'Fenrir';
  systemInstruction?: string;
}

/**
 * Utilitário de conversão de Float32Array (Web Audio API) para 16-bit PCM little-endian.
 */
export function floatTo16BitPCM(float32Array: Float32Array): Int16Array {
  const pcm16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return pcm16;
}

/**
 * Utilitário de conversão de base64 PCM 16-bit para Float32Array para reprodução via AudioContext.
 */
export function pcmBase64ToFloat32(base64: string): Float32Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768.0;
  }
  return float32;
}

/**
 * Janela de atenção após ser chamada pelo nome: enquanto durar, a LIORA escuta
 * comandos normalmente. Expira para não voltar ao modo "escuta tudo".
 */
const ATTENTION_WINDOW_MS = 25_000;

/** Nomes/pronomes que fazem a LIORA acordar no modo mãos-livres. */
const WAKE_WORD_REGEX = /\b(l+i+o+r+a+|li\s*ora|l[e3]\s*ora|l[i1]\s*[e3]ora|leora|lyora|oi\s+l[i1e3]\w*|ei\s+l[i1e3]\w*|ol[aá]\s+l[i1e3]\w*|fala\s+l[i1e3]\w*)\b/i;

/**
 * Cliente WebSocket multimodal nativo para voz em tempo real (Gemini Live API).
 * Compatível com o runtime do desktop Tauri e navegadores modernos.
 */
export class VoiceLiveClient {
  private ws: WebSocket | null = null;
  private inputAudioCtx: AudioContext | null = null;
  private outputAudioCtx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  // Processador moderno (AudioWorklet) ou fallback legado — ver utils/audioProcessor
  private micChunkProcessor: AudioChunkProcessor | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private zeroGain: GainNode | null = null; // BUG FIX: nó de grafo rastreado para disconnect

  private status: VoiceLiveStatus = 'IDLE';
  private callbacks: VoiceLiveCallbacks = {};
  private subscribers = new Set<VoiceLiveCallbacks>();
  private config: VoiceLiveConfig = {};
  private nextStartTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  private isSimulatedMode = false;
  private lastLogTime = 0;
  /**
   * Ativa o modo atenção manualmente (botão do mic). Ao ligar a voz, o usuário
   * espera que a próxima fala seja atendida — sem precisar dizer "LIORA".
   */
  public primeAttention(): void {
    this.attentionActive = true;
    this.attentionActivatedAt = Date.now();
  }

  /** Desliga a atenção (ex: usuário desativou a voz ou trocou de app/aba). */
  public clearAttention(): void {
    this.attentionActive = false;
    this.lastUserTranscript = '';
  }

  public isAttentionActive(): boolean {
    return this.attentionActive && Date.now() - this.attentionActivatedAt <= ATTENTION_WINDOW_MS;
  }

  /**
   * Recebe a transcrição local (Web Speech) para decidir se a fala era dirigida
   * à LIORA. Só isso decide se o áudio do microfone segue para o Gemini Live.
   */
  public feedUserTranscript(text: string): void {
    const clean = String(text || '').trim();
    if (!clean) return;
    this.lastUserTranscript = clean;
    if (WAKE_WORD_REGEX.test(clean)) {
      this.attentionActive = true;
      this.attentionActivatedAt = Date.now();
    }
  }

  /** Verdadeiro quando a fala transcrita chama a LIORA pelo nome. */
  public isWakeWordHeard(text: string): boolean {
    return WAKE_WORD_REGEX.test(String(text || ''));
  }

  /**
   * Fim de uma frase ditada pelo Mestre (Web Speech `isFinal`). Limpa a última
   * transcrição usada pelo gate de atenção para que o PRÓXIMO áudio não seja
   * bloqueado por um texto antigo que já foi atendido.
   */
  public clearUserTranscript(): void {
    this.lastUserTranscript = '';
  }

  /**
   * Diagnóstico do canal de voz (usado pelo painel/DevTools): mostra sem ambiguidade
   * por que o áudio está sendo enviado ou bloqueado.
   */
  public getAttentionDiagnostics() {
    return {
      status: this.status,
      attentionActive: this.isAttentionActive(),
      attentionRaw: this.attentionActive,
      lastHeard: this.lastUserTranscript,
      suppressionRemainingMs: Math.max(0, this.suppressAudioUntil - Date.now()),
      wsOpen: this.ws ? this.ws.readyState === WebSocket.OPEN : false,
      simulated: this.isSimulatedMode
    };
  }

  private speakingStartedAt = 0;
  /** Evita spammar audioStreamEnd no mesmo turno da LIORA (reset em cada SPEAKING). */
  private streamEndSentForCurrentTurn = false;
  private consecutiveBargeInFrames = 0;
  // ── Gate de atenção (wake word) ───────────────────────────────────────────
  // Impede que a LIORA responda a TV/vídeos/outras pessoas. Fica ativo após o
  // usuário ser chamado pelo nome OU ativar a voz manualmente; expira sozinho.
  private attentionActive = false;
  private attentionActivatedAt = 0;
  private lastUserTranscript = '';
  // Flag: quando um comando determinístico é interceptado no onTranscription,
  // suprime o áudio do modelo que chega em seguida (evita voz dupla).
  private suppressAudioUntil = 0;

  /**
   * Estende dinamicamente a janela de supressão de áudio do Live
   * para blindar contra voz dupla enquanto a fala local/determinística está ativa.
   */
  public extendSuppression(ms = 6000) {
    this.suppressAudioUntil = Math.max(this.suppressAudioUntil, Date.now() + ms);
    audioGate.suppressLiveFor(ms);
  }

  // R3 (resiliência): estado de reconexão do canal Live. Quedas breves de rede
  // reconectam automaticamente com backoff exponencial (máx 3 tentativas,
  // 1s→2s→4s), reenviando o payload START_LIVE higienizado (chave e contexto de
  // memória recalculados do store atual) sem duplicar listeners no eventBus.
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalStop = false;
  private maxReconnectAttempts = 3;

  /**
   * P2: extrai memórias e último transcript do store global para montar o
   * systemInstruction contextual do canal Live — mesma estratégia do chat.
   */
  private getContextFromStore(): { memoryEntries: MemoryEntry[]; lastUserTranscript: string } {
    try {
      const state = useLioraStore.getState();
      return {
        memoryEntries: state.memoryEntries || [],
        lastUserTranscript: this.lastUserTranscript
      };
    } catch {
      return { memoryEntries: [], lastUserTranscript: '' };
    }
  }

  constructor(config: VoiceLiveConfig = {}, callbacks: VoiceLiveCallbacks = {}) {
    this.config = config;
    this.callbacks = callbacks;
    audioGate.registerAbortHandler('live_ws', () => {
      this.stopAudioPlayback();
    });
  }

  public setCallbacks(callbacks: VoiceLiveCallbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public subscribeCallbacks(callbacks: VoiceLiveCallbacks): () => void {
    this.subscribers.add(callbacks);
    return () => {
      this.subscribers.delete(callbacks);
    };
  }

  /**
   * Despacha um callback para o listener principal e para todos os assinantes,
   * isolando exceções de cada consumidor (um erro não derruba os demais).
   */
  private emit<K extends 'onStatusChange' | 'onAudioLevel' | 'onTranscription' | 'onError'>(
    key: K,
    ...args: Parameters<NonNullable<VoiceLiveCallbacks[K]>>
  ) {
    const call = (cb?: VoiceLiveCallbacks[K]) => {
      if (!cb) return;
      try {
        (cb as (...a: Parameters<NonNullable<VoiceLiveCallbacks[K]>>) => void)(...args);
      } catch {}
    };
    call(this.callbacks[key]);
    this.subscribers.forEach((sub) => call(sub[key]));
  }

  private emitStatusChange(status: VoiceLiveStatus) {
    this.emit('onStatusChange', status);
  }

  private emitAudioLevel(level: number) {
    this.emit('onAudioLevel', level);
  }

  private emitTranscription(text: string, role: 'user' | 'model') {
    this.emit('onTranscription', text, role);
  }

  private emitError(errMsg: string) {
    this.emit('onError', errMsg);
  }

  public setVoice(voice: 'Aoede' | 'Puck' | 'Charon' | 'Kore' | 'Fenrir') {
    if (['Aoede', 'Puck', 'Charon', 'Kore', 'Fenrir'].includes(voice)) {
      this.config.voice = voice;
    }
  }

  public getStatus(): VoiceLiveStatus {
    return this.status;
  }

  public isSimulated(): boolean {
    return this.isSimulatedMode;
  }

  public getDiagnosticData() {
    const wsState = this.ws ? this.ws.readyState : (typeof WebSocket !== 'undefined' ? WebSocket.CLOSED : 3);
    const stateLabel = wsState === 0 
      ? 'CONNECTING' 
      : wsState === 1 
        ? 'CONNECTED' 
        : wsState === 2 
          ? 'CLOSING' 
          : 'CLOSED';

    return {
      status: this.status,
      isSimulated: this.isSimulatedMode,
      wsState,
      wsStateLabel: stateLabel,
      wsUrl: this.ws ? this.ws.url : '/ws/voice',
      inputSampleRate: this.inputAudioCtx ? this.inputAudioCtx.sampleRate : 16000,
      outputSampleRate: this.outputAudioCtx ? this.outputAudioCtx.sampleRate : 24000,
      activeSourcesCount: this.activeSources.length
    };
  }

  private setStatus(newStatus: VoiceLiveStatus) {
    this.status = newStatus;
    if (newStatus === 'SPEAKING') {
      this.speakingStartedAt = Date.now();
      this.streamEndSentForCurrentTurn = false;
      this.consecutiveBargeInFrames = 0;
    } else {
      this.consecutiveBargeInFrames = 0;
    }
    if (newStatus === 'CONNECTING' || newStatus === 'LISTENING' || newStatus === 'SPEAKING') {
      audioGate.setLiveSessionActive(true);
    } else {
      audioGate.setLiveSessionActive(false);
      audioGate.releaseChannel('live_ws');
    }
    this.emitStatusChange(newStatus);
  }

  /**
   * Conecta ao endpoint WebSocket /ws/voice e inicializa captura e reprodução de áudio.
   */
  public async start(): Promise<boolean> {
    if (this.status !== 'IDLE' && this.status !== 'ERROR') {
      return true;
    }

    // R3: início limpo sempre zera o estado de reconexão
    this.intentionalStop = false;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.setStatus('CONNECTING');
    this.isSimulatedMode = false;

    try {
      // 1. Configurar WebSocket
      const isNonHttpOrTauriOrigin =
        typeof window !== 'undefined' &&
        (typeof window.location?.protocol === 'string' && !window.location.protocol.startsWith('http') ||
          String(window.location?.host || '').includes('tauri.localhost'));
      const protocol = !isNonHttpOrTauriOrigin && typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = !isNonHttpOrTauriOrigin && typeof window !== 'undefined' && window.location.host
        ? window.location.host
        : 'localhost:3000';
      const wsUrl = `${protocol}//${host}/ws/voice`;

      // R3: fecha qualquer WebSocket remanescente antes de criar um novo (evita vazamento)
      if (this.ws) {
        try {
          this.ws.onclose = null;
          this.ws.onerror = null;
          this.ws.onmessage = null;
          if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
            this.ws.close();
          }
        } catch {}
        this.ws = null;
      }

      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = 'arraybuffer';

      const connectionPromise = new Promise<void>((resolve, reject) => {
        if (!this.ws) return reject(new Error('WebSocket não inicializado.'));

        let settled = false;
        const cleanupListeners = () => {
          if (this.ws) {
            this.ws.onopen = null;
            this.ws.onerror = null;
            this.ws.onclose = null;
          }
        };

        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanupListeners();
          try {
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.ws.close();
            } else if (this.ws?.readyState === WebSocket.CONNECTING) {
              const pendingWs = this.ws;
              pendingWs.onopen = () => { try { pendingWs.close(); } catch {} };
            }
          } catch {}
          reject(new Error('Tempo limite de conexão ao canal de voz excedido.'));
        }, 10000);

        this.ws.onopen = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          cleanupListeners();
          resolve();
        };

        this.ws.onerror = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          cleanupListeners();
          reject(new Error('Falha ao conectar no WebSocket de voz (/ws/voice).'));
        };

        this.ws.onclose = (ev) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          cleanupListeners();
          reject(new Error(`WebSocket fechado antes de abrir (código: ${ev.code || 'desconhecido'}).`));
        };
      });

      await connectionPromise;

      this.setupWebSocketListeners();

      // 2. Enviar solicitação START_LIVE e aguardar confirmação GEMINI_LIVE_READY do backend
      const liveReadyPromise = new Promise<void>((resolve, reject) => {
        const readyTimeout = setTimeout(() => {
          cleanup();
          resolve();
        }, 10000);

        const onMsg = (event: MessageEvent) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'GEMINI_LIVE_READY') {
              cleanup();
              resolve();
            } else if (data.type === 'GEMINI_LIVE_ERROR') {
              cleanup();
              reject(new Error(data.message || 'Falha ao conectar à sessão Gemini Live.'));
            }
          } catch {}
        };

        const cleanup = () => {
          clearTimeout(readyTimeout);
          this.ws?.removeEventListener('message', onMsg);
        };

        this.ws?.addEventListener('message', onMsg);
      });

      this.sendStartLive();
      await liveReadyPromise;

      // 3. Inicializar saída de áudio (AudioContext 24kHz)
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtxClass) {
        if (this.outputAudioCtx) {
          try { this.outputAudioCtx.close(); } catch {}
          this.outputAudioCtx = null;
        }
        this.outputAudioCtx = new AudioCtxClass({ sampleRate: 24000 });
        if (this.outputAudioCtx.state === 'suspended') {
          await this.outputAudioCtx.resume();
        }
      }

      // 4. Inicializar captura de microfone nativo (16kHz)
      await this.initMicrophoneCapture();

      return true;
    } catch (err: any) {
      console.error('[VoiceLiveClient] Erro ao iniciar sessão de voz:', err);
      const msg = err?.message || 'Falha ao iniciar microfone ou conexão com o servidor de voz.';
      this.emitError(msg);
      this.stop();
      this.setStatus('ERROR');
      return false;
    }
  }

  /**
   * R3: monta e envia o payload START_LIVE sempre HIGIENIZADO — recalcula a
   * chave do cofre e o bloco de memória semântica do store ATUAL (não usa cache
   * de sessão anterior), garantindo que reconexões nunca corrompam o contexto.
   */
  private sendStartLive(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // P2 (paridade voz x chat): o canal Live recebe a MESMA systemInstruction
    // contextual do chat de texto — memórias semânticas rankeadas são injetadas
    // para que a voz tenha o mesmo cofre de contexto.
    const { memoryEntries, lastUserTranscript } = this.getContextFromStore();
    const rankedMemories = rankMemories(lastUserTranscript || 'conversa livre', memoryEntries, {
      minScoreThreshold: 0.35,
      maxInjectedMemories: 4,
      maxCharacterBudget: 400
    });
    const memoryContextBlock = formatMemoryContextBlock(rankedMemories, 400);
    const now = new Date();
    const dateStr = now.toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const temporalEnforcer = `[HORÁRIO LOCAL DO BRASIL: Hoje é ${dateStr}, e são ${timeStr}. Responda perguntas sobre data e hora com base estritamente nesta data e hora real.] `;
    const baseInstruction = this.config.systemInstruction || LIORA_SYSTEM_INSTRUCTION;
    const languageEnforcer = "IDIOMA OBRIGATÓRIO: Responda SEMPRE e EXCLUSIVAMENTE em Português do Brasil (pt-BR). É terminantemente proibido falar em espanhol, inglês ou outro idioma. Ao cumprimentar o Mestre, use sempre português brasileiro. ";
    const liveSystemInstruction = memoryContextBlock
      ? `${languageEnforcer}${temporalEnforcer}${baseInstruction}${memoryContextBlock}`
      : `${languageEnforcer}${temporalEnforcer}${baseInstruction}`;

    // R3: chave SEMPRE re-resolvida do cofre (nunca cacheada entre sessões —
    // o usuário pode ter rotacionado a chave enquanto a sessão estava aberta)
    const rawGeminiKey = integrationsVault.getApiKeyByProvider('gemini') || integrationsVault.getRawKey('svc-gemini');
    const geminiKey = rawGeminiKey ? String(rawGeminiKey).trim().replace(/^['"]|['"]$/g, '') : undefined;

    // Injeção de Memória de Curto Prazo (Histórico de Diálogos e Comandos Recentes)
    const storeState = useLioraStore.getState();
    const recentMessages = (storeState.messages || []).slice(-8);
    let shortTermHistory = '';
    if (recentMessages.length > 0) {
      shortTermHistory = '\n\n[MEMÓRIA DE CURTO PRAZO - HISTÓRICO RECENTE]:\n' +
        recentMessages.map(m => `- ${m.sender === 'user' ? 'Mestre pediu' : 'LIORA respondeu/executou'}: "${(m.text || '').slice(0, 160)}"`).join('\n') +
        '\n[FIM DO HISTÓRICO RECENTE. Se o Mestre perguntar "qual foi meu comando anterior?", "o que acabei de pedir?", cite o último comando com exatidão.]\n';
    }

    const recentLogs = (storeState.activityLogs || []).slice(0, 6);
    let recentActions = '';
    if (recentLogs.length > 0) {
      recentActions = '\n[ÚLTIMAS AÇÕES EXECUTADAS NO SISTEMA]:\n' +
        recentLogs.map(l => `- [${l.category.toUpperCase()}] ${l.summary}: ${l.details.slice(0, 120)} (${l.status})`).join('\n') +
        '\n[FIM DAS AÇÕES RECENTES.]\n';
    }

    const enrichedInstruction = `${liveSystemInstruction}${shortTermHistory}${recentActions}`;

    this.ws.send(JSON.stringify({
      type: 'START_LIVE',
      model: this.config.model || 'gemini-3.8-live',
      voice: this.config.voice || 'Aoede',
      apiKey: geminiKey || undefined,
      // Gemini Live aceita estritamente ['AUDIO'] em responseModalities.
      // A combinação ['TEXT', 'AUDIO'] encerra a conexão no Google com código 1007.
      responseModalities: ['AUDIO'],
      systemInstruction: enrichedInstruction,
      // CORREÇÃO (payload inútil): o servidor ignora `tools` e sempre registra o
      // ToolRegistry REAL (`toGeminiDeclarations`, com schemas válidos para o Gemini).
      // Antes enviávamos `toolRegistry.listTools()` — todo o catálogo com schemas
      // internos — em cada START_LIVE/reconexão, gastando banda e enganando quem
      // lesse o protocolo achando que a lista do cliente era a usada.
    }));
  }

  /**
   * Envia uma mensagem de texto (transcrição do Web Speech ou prompt do usuário)
   * diretamente para a sessão Gemini Live ativa. Garante resposta mesmo quando
   * o microfone PCM estiver em volume baixo ou o VAD acústico da nuvem hesitar.
   */
  public sendLiveMessage(text: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    const clean = String(text || '').trim();
    if (!clean) return false;
    try {
      this.ws.send(JSON.stringify({
        type: 'LIVE_MESSAGE',
        text: clean,
        timestamp: new Date().toISOString()
      }));
      this.attentionActive = true;
      this.attentionActivatedAt = Date.now();
      return true;
    } catch (err) {
      console.warn('[VoiceLiveClient] Falha ao enviar LIVE_MESSAGE:', err);
      return false;
    }
  }

  /**
   * Envia uma atualização de contexto de curto prazo para a sessão Live ativa.
   * Permite que comandos executados localmente (ex: abrir app, consulta de horário)
   * sejam imediatamente conhecidos pelo modelo caso o operador pergunte "qual foi meu comando anterior?".
   */
  public sendContextUpdate(userText: string, assistantReply: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({
          type: 'CONTEXT_UPDATE',
          userText,
          assistantReply,
          timestamp: new Date().toISOString()
        }));
      } catch (err) {
        console.warn('[VoiceLiveClient] Falha ao enviar context update:', err);
      }
    }
  }

  /**
   * R3: agenda reconexão automática com backoff exponencial (1s→2s→4s).
   * Só reconecta se o stop foi NÃO intencional (queda de rede) e o modo de voz
   * do usuário continua ativo (verificado via store). Não duplica listeners:
   * a reconexão reutiliza o fluxo start() completo, que fecha o WS anterior.
   */
  private scheduleReconnect(): void {
    if (this.intentionalStop) return;
    // Bug hunt (race condition): onerror E onclose podem disparar para a mesma
    // queda de rede — sem este guard, duas cadeias de reconexão paralelas seriam
    // agendadas e o start() rodaria duas vezes (duplicando o microfone/WS).
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn('[VoiceLiveClient] Máximo de tentativas de reconexão atingido. Sessão encerrada.');
      this.emitError('Canal de voz indisponível após 3 tentativas de reconexão. Verifique a conexão e reative a voz.');
      this.setStatus('ERROR');
      return;
    }

    // Só reconecta se o usuário ainda quer voz ativa (não reconecta após pause)
    try {
      const storeState = useLioraStore.getState();
      if (!storeState.isVoiceActive) {
        this.setStatus('IDLE');
        return;
      }
    } catch {}

    const delayMs = Math.min(4000, 1000 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts += 1;
    console.info(`[VoiceLiveClient] Reconectando em ${delayMs}ms (tentativa ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.setStatus('IDLE'); // permite start() rodar novamente
      void this.start();
    }, delayMs);
  }

  /**
   * Configura listeners de eventos do WebSocket.
   */
  private setupWebSocketListeners() {
    if (!this.ws) return;

    this.ws.onmessage = (event) => {
      try {
        if (typeof event.data === 'string') {
          const payload = JSON.parse(event.data);

          switch (payload.type) {
            case 'TRANSPORT_CONNECTED':
              break;

            case 'GEMINI_LIVE_READY':
              this.isSimulatedMode = Boolean(payload.simulated);
              this.setStatus('LISTENING');
              break;

            case 'AUDIO_OUTPUT':
              if (payload.audio) {
                this.playAudioOutputChunk(payload.audio);
              }
              break;

            case 'INTERRUPTED':
              this.stopAudioPlayback();
              this.setStatus('LISTENING');
              break;

            case 'TRANSCRIPTION':
              if (payload.text) {
                if (payload.role === 'user') {
                  // P2: mantém o último dito pelo usuário para rankear memórias na próxima sessão
                  this.lastUserTranscript = String(payload.text).slice(0, 200);
                }
                this.emitTranscription(payload.text, payload.role || 'model');
              }
              break;

            case 'TOOL_EXECUTED':
              // P0 (paridade voz x chat): ferramentas executadas no canal Live
              // são publicadas no eventBus para o lioraStore registrar no log de
              // atividade igual ao data.toolExecuted do chat de texto.
              eventBus.publish('liora:voice_tool_executed', {
                toolName: payload.toolName,
                parameters: payload.parameters,
                data: payload.data,
                success: Boolean(payload.success),
                simulated: Boolean(payload.simulated),
                requiresConsent: Boolean(payload.requiresConsent),
                code: payload.code,
                riskLevel: payload.riskLevel || 'R1',
                resultSummary: payload.resultSummary,
                error: payload.error
              });
              // Sincronização tool→TTS: publica o resultado real apenas quando há erro
              // explícito ou quando a sessão Live não está falando o retorno.
              eventBus.publish('liora:tool_result', {
                toolName: payload.toolName,
                success: Boolean(payload.success),
                simulated: Boolean(payload.simulated),
                fromLiveSession: true,
                resultSummary: payload.resultSummary,
                resultData: payload.data?.resultData || payload.data,
                error: payload.error
              });
              break;

            case 'GEMINI_LIVE_ERROR':
              this.emitError(payload.message || 'Erro na sessão de voz ao vivo.');
              if (payload.code === 'NO_API_KEY') {
                this.setStatus('ERROR');
              }
              break;

            case 'GEMINI_LIVE_CLOSED':
              // R3: servidor encerrou a sessão Gemini (timeout de 15min ou failover).
              // Se o usuário ainda tem voz ativa, tenta reconectar em vez de abandonar.
              this.scheduleReconnect();
              break;
          }
        }
      } catch (err) {
        console.error('[VoiceLiveClient] Erro ao processar mensagem do servidor:', err);
      }
    };

    this.ws.onclose = () => {
      this.cleanupAudio();
      // R3: queda de rede — reconecta automaticamente se o stop não foi intencional
      if (!this.intentionalStop) {
        this.scheduleReconnect();
      } else if (this.status !== 'IDLE' && this.status !== 'ERROR') {
        this.setStatus('IDLE');
      }
    };

    this.ws.onerror = (err) => {
      console.error('[VoiceLiveClient] Erro no WebSocket:', err);
      this.emitError('Conexão com o servidor de voz perdida.');
      // R3: erro de rede também agenda reconexão (o onclose subsequente não duplica
      // porque o scheduleReconnect é idempotente via reconnectTimer guard)
      this.scheduleReconnect();
    };
  }

  /**
   * Inicializa captura do microfone usando a API nativa WebRTC/MediaStream compatível com Tauri.
   */
  private async initMicrophoneCapture() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      console.warn('[VoiceLiveClient] WebRTC getUserMedia não suportado neste ambiente.');
      this.isSimulatedMode = true;
      return;
    }

    try {
      const activeStream = speechService.getMediaStream();
      if (activeStream && activeStream.active && activeStream.getAudioTracks().some(t => t.readyState === 'live')) {
        this.mediaStream = activeStream;
      } else {
        try {
          this.mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              channelCount: 1,
              sampleRate: 16000,
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true
            }
          });
        } catch (mediaErr: any) {
          console.info('[VoiceLiveClient] Microfone físico não disponível ou ocupado. Operando em modo de espera.');
          this.isSimulatedMode = true;
          return;
        }
      }

      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      if (this.inputAudioCtx) {
        try { this.inputAudioCtx.close(); } catch {}
        this.inputAudioCtx = null;
      }
      this.inputAudioCtx = new AudioCtxClass({ sampleRate: 16000 });
      if (this.inputAudioCtx.state === 'suspended') {
        await this.inputAudioCtx.resume();
      }

      this.micSource = this.inputAudioCtx.createMediaStreamSource(this.mediaStream);

      // CORREÇÃO (depreciação): AudioWorklet (thread de áudio dedicada) com
      // fallback automático para ScriptProcessor em WebViews antigos. O callback
      // recebe blocos de 2048 amostras exatamente como antes — o pipeline de envio
      // para o Gemini Live permanece idêntico.
      const handleMicChunk = (channelData: Float32Array) => {
        if (this.status !== 'LISTENING' && this.status !== 'SPEAKING') return;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        // Calcular volume médio (RMS) para indicador visual
        let sumSquares = 0;
        for (let i = 0; i < channelData.length; i++) {
          sumSquares += channelData[i] * channelData[i];
        }
        const rms = Math.sqrt(sumSquares / channelData.length);
        const volumeLevel = Math.min(1, rms * 5);
        this.emitAudioLevel(volumeLevel);

        /**
         * GATE DE ATENÇÃO (relato de campo): "ela escutou o streamer do vídeo e
         * falou com ele". O microfone é um loop aberto — TODO som ambiente ia para
         * o Gemini Live, que respondia a qualquer voz (TV, YouTube, outra pessoa).
         *
         * Regra: a LIORA só fica "atenta" depois de:
         *  - o usuário ativar a voz manualmente (ativação = resposta ao próximo fala), ou
         *  - ser chamada pelo nome ("LIORA", "Liora", "Oi Liora").
         * Depois de responder, volta a dormir até ser chamada novamente.
         * A checagem usa o Web Speech (transcrição local) — sem custo de API.
         */
        if (!this.attentionActive) {
          // ATENÇÃO GRANT/DENY (bug de campo: "ouve o primeiro comando e depois para").
          // O gate usava `lastUserTranscript`, que só é preenchido por TRANSCRIPTION do
          // servidor. Quando a transcrição não chega (ou a Web Speech API não existe no
          // WebView2), a atenção expira e NADA mais é enviado ao Gemini para sempre.
          // Agora:
          //  - fala reconhecida pelo Web Speech sem o nome = ruído de ambiente → bloqueia;
          //  - qualquer outro caso (sem transcrição confiável, ou com o nome) libera;
          //  - o fim da fala da LIORA reabre a janela (ver source.onended), então o
          //    operador pode continuar a conversa sem repetir o wake word.
          // Alias de pronúncia: o Web Speech grava "leora"/"Leora" para o nome
          // falado — a comparação é feita também pelo texto falado literalmente.
          const heard = String(this.lastUserTranscript || '').trim();
          if (heard && !this.isWakeWordHeard(heard)) return;
          this.attentionActive = true;
          this.attentionActivatedAt = Date.now();
        }
        // Janela de atenção expira (sem fala dirigida a ela) → volta a dormir.
        if (this.attentionActive && Date.now() - this.attentionActivatedAt > ATTENTION_WINDOW_MS) {
          this.attentionActive = false;
          return;
        }

        // Anti-Echo / Duplex Shield & Barge-In Acústico Calibrado:
        // Enquanto a LIORA fala, o som sai pelos alto-falantes e é captado pelo microfone.
        if (this.status === 'SPEAKING') {
          // Grace period inicial de 1200ms para evitar que o início da fala seja cortado pelo eco do alto-falante.
          // Após 1200ms, exige intensidade proposital (volumeLevel >= 0.50 e RMS >= 0.085) por ao menos 3 frames consecutivos (~380ms).
          const timeSinceStart = Date.now() - this.speakingStartedAt;
          if (timeSinceStart > 1200 && (volumeLevel >= 0.50 || rms >= 0.085)) {
            this.consecutiveBargeInFrames += 1;
            if (this.consecutiveBargeInFrames >= 3) {
              console.log('[VoiceLiveClient Barge-In] Interrupção deliberada do usuário detectada. Interrompendo reprodução.');
              this.stopAudioPlayback();
              this.setStatus('LISTENING');
              this.consecutiveBargeInFrames = 0;
              if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                try {
                  this.ws.send(JSON.stringify({ type: 'CLIENT_INTERRUPTED', timestamp: new Date().toISOString() }));
                } catch {}
              }
            }
          } else {
            this.consecutiveBargeInFrames = 0;
          }

          // REGRA DE OURO: enquanto a LIORA fala, NÃO enviamos áudio do microfone para o Gemini Live.
          // Isso impede que a IA escute a si mesma pelo alto-falante e se auto-interrompa.
          return;
        }

        // Converter para 16-bit PCM little-endian
        const pcm16 = floatTo16BitPCM(channelData);
        const binaryChunk = new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);

        // Log de intensidade de áudio (silenciado em produção para não poluir o console)
        if (typeof window !== 'undefined' && (window as any).__LIORA_DEBUG_AUDIO__ && (!this.lastLogTime || Date.now() - this.lastLogTime > 5000)) {
          this.lastLogTime = Date.now();
          console.debug(`[VoiceLiveClient] 🎤 Microfone Ativo | RMS: ${rms.toFixed(5)} | Status WS: ${this.ws?.readyState === WebSocket.OPEN ? 'CONECTADO' : 'DESCONECTADO'}`);
        }

        // Despachar chunk de áudio binário respeitando o limite seguro (< 64KB)
        if (binaryChunk.byteLength <= 64 * 1024) {
          try {
            const chunkBuffer = binaryChunk.buffer.slice(
              binaryChunk.byteOffset,
              binaryChunk.byteOffset + binaryChunk.byteLength
            ) as ArrayBuffer;
            this.ws.send(chunkBuffer);
          } catch (sendErr) {
            console.error('[VoiceLiveClient] Falha ao enviar chunk binário de áudio:', sendErr);
          }
        }
      };

      this.micChunkProcessor = await createAudioChunkProcessor(this.inputAudioCtx, 2048, handleMicChunk);
      this.micChunkProcessor.connect(this.micSource);

    } catch (micErr: any) {
      console.warn('[VoiceLiveClient] Permissão de microfone negada ou indisponível:', micErr);
      this.isSimulatedMode = true;
      this.emitError('Microfone inacessível. Verifique as permissões de gravação de áudio do sistema.');
    }
  }

  /**
   * Registra no store que a conversa atual foi atendida pelo canal Live (voz única).
   */
  private markCurrentChatAnsweredByLive(): void {
    try {
      const sessionId = useLioraStore.getState().activeSessionId;
      useLioraStore.getState().markLiveVoiceAnswered(sessionId || 'default-session');
    } catch {}
  }

  /**
   * Enfileira e reproduz chunks de áudio recebidos do Gemini (24kHz PCM).
   */
  private playAudioOutputChunk(base64Pcm: string) {
    if (!this.outputAudioCtx) return;
    // Suprime áudio quando um comando determinístico foi interceptado ou a LIORA local já está falando
    if (Date.now() < this.suppressAudioUntil || audioGate.isLiveSuppressed()) return;
    if (speechService.isSpeaking() && !audioGate.acquireChannel('live_ws')) return;
    if (!audioGate.acquireChannel('live_ws')) return;

    try {
      const float32 = pcmBase64ToFloat32(base64Pcm);
      if (!float32 || float32.length === 0) return;
      this.setStatus('SPEAKING');
      // Marca a conversa como respondida pelo Live: o chat (HTTP/TTS) não deve
      // sintetizar outra voz para a mesma fala — fim da alternância offline/API.
      this.markCurrentChatAnsweredByLive();
      const audioBuffer = this.outputAudioCtx.createBuffer(1, float32.length, 24000);
      audioBuffer.getChannelData(0).set(float32);

      const source = this.outputAudioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.outputAudioCtx.destination);

      const currentTime = this.outputAudioCtx.currentTime;
      const startTime = Math.max(currentTime, this.nextStartTime);
      source.start(startTime);
      this.nextStartTime = startTime + audioBuffer.duration;

      this.activeSources.push(source);
      source.onended = () => {
        const index = this.activeSources.indexOf(source);
        if (index !== -1) {
          this.activeSources.splice(index, 1);
        }
        if (this.activeSources.length === 0) {
          // Pequena margem (150ms) para acomodar chunks de áudio recebidos em fluxo contínuo
          setTimeout(() => {
            if (this.activeSources.length === 0 && this.status === 'SPEAKING') {
              audioGate.releaseChannel('live_ws');
              this.setStatus('LISTENING');
              // Fim do turno da LIORA: reabre a janela de atenção para que o Mestre
              // continue falando sem precisar repetir o nome a cada resposta.
              this.attentionActive = true;
              this.attentionActivatedAt = Date.now();
            }
          }, 150);
        }
      };
    } catch (e) {
      console.error('[VoiceLiveClient] Erro ao reproduzir áudio do modelo:', e);
    }
  }

  /**
   * Sinaliza ao servidor que a fala do Mestre terminou (audioStreamEnd), para o
   * Gemini processar o áudio já enviado em vez de esperar indefinidamente.
   */
  public sendAudioStreamEnd(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({ type: 'CLIENT_INTERRUPTED', timestamp: new Date().toISOString() }));
    } catch {}
  }

  /**
   * Interrompe imediatamente qualquer reprodução de áudio pendente (Gemini interrupted).
   */
  private stopAudioPlayback() {
    for (const source of this.activeSources) {
      try {
        source.stop();
        source.disconnect();
      } catch (e) {
        // ignore
      }
    }
    this.activeSources = [];
    this.nextStartTime = 0;
    audioGate.releaseChannel('live_ws');
  }

  /**
   * Interrompe ativamente a reprodução e notifica o servidor WebSocket Live
   * para resetar o turno e parar geração de áudio no backend.
   */
  public interrupt() {
    this.stopAudioPlayback();
    // Suprime áudio residual em voo por 6s (evita vazamento de turnos e voz dupla com comandos locais)
    this.suppressAudioUntil = Date.now() + 6000;
    audioGate.suppressLiveFor(6000);
    if (this.status === 'SPEAKING') {
      this.setStatus('LISTENING');
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'CLIENT_INTERRUPTED', timestamp: new Date().toISOString() }));
      } catch {}
    }
  }

  /**
   * Libera recursos de microfone e nós de áudio.
   */
  private cleanupAudio() {
    this.stopAudioPlayback();

    if (this.scriptProcessor) {
      try {
        this.scriptProcessor.disconnect();
      } catch (e) {
        // ignore
      }
      this.scriptProcessor = null;
    }

    if (this.micChunkProcessor) {
      try {
        this.micChunkProcessor.dispose();
      } catch (e) {
        // ignore
      }
      this.micChunkProcessor = null;
    }

    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch (e) {
        // ignore
      }
      this.micSource = null;
    }

    // BUG FIX: desconecta o nó de ganho zerado (rastreado) do destination
    if (this.zeroGain) {
      try {
        this.zeroGain.disconnect();
      } catch (e) {
        // ignore
      }
      this.zeroGain = null;
    }

    if (this.mediaStream) {
      // Se a stream for compartilhada com o speechService, não mata as trilhas globais de hardware
      const isShared = this.mediaStream === speechService.getMediaStream();
      if (!isShared) {
        this.mediaStream.getTracks().forEach((track) => track.stop());
      }
      this.mediaStream = null;
    }

    if (this.inputAudioCtx) {
      try {
        this.inputAudioCtx.close();
      } catch (e) {
        // ignore
      }
      this.inputAudioCtx = null;
    }

    if (this.outputAudioCtx) {
      try {
        this.outputAudioCtx.close();
      } catch (e) {
        // ignore
      }
      this.outputAudioCtx = null;
    }
  }

  /**
   * Encerra a sessão de voz e fecha as conexões.
   */
  public stop() {
    // R3: marca como stop INTENCIONAL para o onclose não disparar reconexão
    this.intentionalStop = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      try {
        // R3: remove handlers antes de fechar para evitar callbacks pós-stop
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.onmessage = null;
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'STOP_LIVE' }));
          this.ws.close();
        } else if (this.ws.readyState === WebSocket.CONNECTING) {
          const connectingWs = this.ws;
          connectingWs.onopen = () => {
            try { connectingWs.close(); } catch {}
          };
        }
      } catch (e) {
        // ignore
      }
      this.ws = null;
    }

    this.cleanupAudio();
    this.setStatus('IDLE');
  }
}

export const voiceLiveClient = new VoiceLiveClient();

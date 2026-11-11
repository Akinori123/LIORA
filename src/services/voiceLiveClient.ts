/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { integrationsVault } from './integrationsVault';
import { toolRegistry } from '../tools/registry';
import { speechService } from './speechService';
import { eventBus } from '../utils/eventBus';
import { rankMemories, formatMemoryContextBlock } from '../utils/memoryRanker';
import type { MemoryEntry } from '../types';
import { useLioraStore, LIORA_SYSTEM_INSTRUCTION } from '../store/lioraStore';

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
  const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768.0;
  }
  return float32;
}

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
  private micSource: MediaStreamAudioSourceNode | null = null;
  private zeroGain: GainNode | null = null; // BUG FIX: nó de grafo rastreado para disconnect

  private status: VoiceLiveStatus = 'IDLE';
  private callbacks: VoiceLiveCallbacks = {};
  private config: VoiceLiveConfig = {};
  private nextStartTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  private lastUserTranscript = '';
  private isSimulatedMode = false;
  private lastLogTime = 0;

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
  }

  public setCallbacks(callbacks: VoiceLiveCallbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
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
    this.callbacks.onStatusChange?.(newStatus);
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
      const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = typeof window !== 'undefined' && window.location.host ? window.location.host : 'localhost:3000';
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
          try { this.ws?.close(); } catch {}
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

      // 2. Enviar solicitação START_LIVE (payload higienizado montado por método
      // dedicado — reutilizado na reconexão automática R3)
      this.sendStartLive();

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
      this.callbacks.onError?.(msg);
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
    const baseInstruction = this.config.systemInstruction || LIORA_SYSTEM_INSTRUCTION;
    const liveSystemInstruction = memoryContextBlock
      ? `${baseInstruction}${memoryContextBlock}`
      : baseInstruction;

    // R3: chave SEMPRE re-resolvida do cofre (nunca cacheada entre sessões —
    // o usuário pode ter rotacionado a chave enquanto a sessão estava aberta)
    const geminiKey = integrationsVault.getApiKeyByProvider('gemini') || integrationsVault.getRawKey('svc-gemini');

    this.ws.send(JSON.stringify({
      type: 'START_LIVE',
      model: this.config.model || 'gemini-3.8-live',
      voice: this.config.voice || 'Aoede',
      apiKey: geminiKey || undefined,
      systemInstruction: liveSystemInstruction,
      tools: toolRegistry.listTools()
    }));
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
      this.callbacks.onError?.('Canal de voz indisponível após 3 tentativas de reconexão. Verifique a conexão e reative a voz.');
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
                this.callbacks.onTranscription?.(payload.text, payload.role || 'model');
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
                riskLevel: payload.riskLevel || 'R1',
                resultSummary: payload.resultSummary,
                error: payload.error
              });
              // Sincronização tool→TTS: publica o resultado real para a LIORA
              // FALAR o que a ferramenta retornou (maps, rotas, notícias, etc).
              eventBus.publish('liora:tool_result', {
                toolName: payload.toolName,
                success: Boolean(payload.success),
                resultSummary: payload.resultSummary,
                resultData: payload.data?.resultData || payload.data
              });
              break;

            case 'GEMINI_LIVE_ERROR':
              this.callbacks.onError?.(payload.message || 'Erro na sessão de voz ao vivo.');
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
      this.callbacks.onError?.('Conexão com o servidor de voz perdida.');
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
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            sampleRate: 16000,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
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
      // FIX W3 (preparação para AudioWorklet): buffer de 2048 amostras ~ 128ms por chunk em 16kHz.
      // O AudioWorklet migraria o processamento para um thread de áudio dedicado, eliminando o jank
      // da thread principal. Manteremos a estrutura do onaudioprocess intocada até uma migração
      // segura (precisa de public/wasm/worklet module e refatoração de pipeline de envio).
      this.scriptProcessor = this.inputAudioCtx.createScriptProcessor(2048, 1, 1);

      this.scriptProcessor.onaudioprocess = (e) => {
        if (this.status !== 'LISTENING' && this.status !== 'SPEAKING') return;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const channelData = e.inputBuffer.getChannelData(0);

        // Calcular volume médio (RMS) para indicador visual
        let sumSquares = 0;
        for (let i = 0; i < channelData.length; i++) {
          sumSquares += channelData[i] * channelData[i];
        }
        const rms = Math.sqrt(sumSquares / channelData.length);
        const volumeLevel = Math.min(1, rms * 5);
        this.callbacks.onAudioLevel?.(volumeLevel);

        // Detecção de Barge-In Acústico Local (Interrupção Instantânea em 0ms)
        if (this.status === 'SPEAKING' && (volumeLevel >= 0.15 || rms >= 0.028)) {
          console.log('[VoiceLiveClient Barge-In] Voz do usuário detectada durante fala da LIORA. Interrompendo reprodução imediatamente.');
          this.stopAudioPlayback();
          this.setStatus('LISTENING');
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
              this.ws.send(JSON.stringify({ type: 'CLIENT_INTERRUPTED', timestamp: new Date().toISOString() }));
            } catch {}
          }
        }

        // Converter para 16-bit PCM little-endian
        const pcm16 = floatTo16BitPCM(channelData);
        const binaryChunk = new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);

        // Log detalhado de intensidade de áudio (throttled a cada ~1 segundo)
        if (!this.lastLogTime || Date.now() - this.lastLogTime > 1000) {
          this.lastLogTime = Date.now();
          console.log(`[VoiceLiveClient] 🎤 [LIVE MODE] Microfone Ativo | RMS: ${rms.toFixed(5)} | Intensidade: ${Math.round(volumeLevel * 100)}% | Chunks enviados: ${binaryChunk.byteLength} bytes | Status WS: ${this.ws?.readyState === WebSocket.OPEN ? 'CONECTADO' : 'DESCONECTADO'}`);
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

      this.micSource.connect(this.scriptProcessor);
      // Blindagem absoluta contra microfonia e loop de áudio: nó de ganho zerado.
      // BUG FIX (leak de grafo): guardamos o zeroGain para disconnect no cleanup —
      // sem isso o nó permanecia conectado ao destination a cada sessão,
      // acumulando nós no grafo de áudio do WebView (degradação progressiva).
      this.zeroGain = this.inputAudioCtx.createGain();
      this.zeroGain.gain.value = 0;
      this.scriptProcessor.connect(this.zeroGain);
      this.zeroGain.connect(this.inputAudioCtx.destination);

    } catch (micErr: any) {
      console.warn('[VoiceLiveClient] Permissão de microfone negada ou indisponível:', micErr);
      this.isSimulatedMode = true;
      this.callbacks.onError?.('Microfone inacessível. Verifique as permissões de gravação de áudio do sistema.');
    }
  }

  /**
   * Enfileira e reproduz chunks de áudio recebidos do Gemini (24kHz PCM).
   */
  private playAudioOutputChunk(base64Pcm: string) {
    if (!this.outputAudioCtx) return;

    try {
      this.setStatus('SPEAKING');
      const float32 = pcmBase64ToFloat32(base64Pcm);
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
        if (this.activeSources.length === 0 && this.status === 'SPEAKING') {
          this.setStatus('LISTENING');
        }
      };
    } catch (e) {
      console.error('[VoiceLiveClient] Erro ao reproduzir áudio do modelo:', e);
    }
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
  }

  /**
   * Interrompe ativamente a reprodução e notifica o servidor WebSocket Live
   * para resetar o turno e parar geração de áudio no backend.
   */
  public interrupt() {
    this.stopAudioPlayback();
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
          this.ws.close();
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

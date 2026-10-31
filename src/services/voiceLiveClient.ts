/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { integrationsVault } from './integrationsVault';
import { toolRegistry } from '../tools/registry';
import { speechService } from './speechService';

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

  private status: VoiceLiveStatus = 'IDLE';
  private callbacks: VoiceLiveCallbacks = {};
  private config: VoiceLiveConfig = {};
  private nextStartTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  private isSimulatedMode = false;
  private lastLogTime = 0;

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

    this.setStatus('CONNECTING');
    this.isSimulatedMode = false;

    try {
      // 1. Configurar WebSocket
      const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = typeof window !== 'undefined' && window.location.host ? window.location.host : 'localhost:3000';
      const wsUrl = `${protocol}//${host}/ws/voice`;

      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = 'arraybuffer';

      const connectionPromise = new Promise<void>((resolve, reject) => {
        if (!this.ws) return reject(new Error('WebSocket não inicializado.'));

        const timeout = setTimeout(() => {
          reject(new Error('Tempo limite de conexão ao canal de voz excedido.'));
        }, 10000);

        this.ws.onopen = () => {
          clearTimeout(timeout);
          resolve();
        };

        this.ws.onerror = (e) => {
          clearTimeout(timeout);
          reject(new Error('Falha ao conectar no WebSocket de voz (/ws/voice).'));
        };
      });

      await connectionPromise;

      this.setupWebSocketListeners();

      // 2. Enviar solicitação START_LIVE com token e voz neural oficial
      const geminiKey = integrationsVault.getApiKeyByProvider('gemini') || integrationsVault.getRawKey('svc-gemini');
      this.ws.send(JSON.stringify({
        type: 'START_LIVE',
        model: this.config.model || 'gemini-3.8-live',
        voice: this.config.voice || 'Aoede',
        apiKey: geminiKey || undefined,
        systemInstruction: this.config.systemInstruction,
        tools: toolRegistry.listTools()
      }));

      // 3. Inicializar saída de áudio (AudioContext 24kHz)
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtxClass) {
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
                this.callbacks.onTranscription?.(payload.text, payload.role || 'model');
              }
              break;

            case 'GEMINI_LIVE_ERROR':
              this.callbacks.onError?.(payload.message || 'Erro na sessão de voz ao vivo.');
              if (payload.code === 'NO_API_KEY') {
                this.setStatus('ERROR');
              }
              break;

            case 'GEMINI_LIVE_CLOSED':
              this.stop();
              break;
          }
        }
      } catch (err) {
        console.error('[VoiceLiveClient] Erro ao processar mensagem do servidor:', err);
      }
    };

    this.ws.onclose = () => {
      if (this.status !== 'IDLE' && this.status !== 'ERROR') {
        this.setStatus('IDLE');
      }
      this.cleanupAudio();
    };

    this.ws.onerror = (err) => {
      console.error('[VoiceLiveClient] Erro no WebSocket:', err);
      this.callbacks.onError?.('Conexão com o servidor de voz perdida.');
      this.setStatus('ERROR');
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
      this.inputAudioCtx = new AudioCtxClass({ sampleRate: 16000 });
      if (this.inputAudioCtx.state === 'suspended') {
        await this.inputAudioCtx.resume();
      }

      this.micSource = this.inputAudioCtx.createMediaStreamSource(this.mediaStream);
      // Buffer de 2048 amostras ~ 128ms por chunk em 16kHz
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
            this.ws.send(binaryChunk.buffer as ArrayBuffer);
          } catch (sendErr) {
            console.error('[VoiceLiveClient] Falha ao enviar chunk binário de áudio:', sendErr);
          }
        }
      };

      this.micSource.connect(this.scriptProcessor);
      // Blindagem absoluta contra microfonia e loop de áudio: nó de ganho zerado
      const zeroGain = this.inputAudioCtx.createGain();
      zeroGain.gain.value = 0;
      this.scriptProcessor.connect(zeroGain);
      zeroGain.connect(this.inputAudioCtx.destination);

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
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'STOP_LIVE' }));
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

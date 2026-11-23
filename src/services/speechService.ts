import { integrationsVault } from './integrationsVault';
import { audioGate } from './audioGate';
import { voiceManager } from './voiceManager';
import { parseConsentVoiceDecision } from '../utils/consentVoiceParser';
import { createAudioChunkProcessor, AudioChunkProcessor } from '../utils/audioProcessor';

// Interface para o Web Speech Recognition API
interface SpeechRecognitionEventLike extends Event {
  results: {
    [index: number]: {
      [index: number]: {
        transcript: string;
      };
      isFinal?: boolean;
      length: number;
    };
    length: number;
  };
  resultIndex: number;
}

interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
  message?: string;
}

interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
  }
}

export type SpeechCallback = (transcript: string, isFinal: boolean) => void;
export type AudioLevelCallback = (level: number) => void;
export type FrequencyCallback = (bins: number[]) => void;

class SpeechService {
  private recognition: SpeechRecognitionInstance | null = null;
  private isListeningActive = false;
  private shouldBeListening = false;
  private currentUtterance: SpeechSynthesisUtterance | null = null;

  // Web Audio API para monitorar nível real do microfone físico (VU meter)
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private micGainNode: GainNode | null = null;
  private micSourceNode: MediaStreamAudioSourceNode | null = null;
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedAudioChunks: Blob[] = [];
  private scriptProcessor: ScriptProcessorNode | null = null;
  private silentGainNode: GainNode | null = null;
  private rawAudioSamples: Float32Array[] = [];
  private animFrameId: number | null = null;
  // Processador moderno (AudioWorklet) ou fallback legado — ver utils/audioProcessor
  private micChunkProcessor: AudioChunkProcessor | null = null;
  // Loop do medidor espectral de fallback (quando não há microfone físico).
  // Precisava de handle próprio para ser cancelado no teardown.
  private fallbackIntervalId: ReturnType<typeof setInterval> | null = null;
  // CORREÇÃO (Etapa 7): loop do medidor por setInterval (sobrevive à minimização)
  private meterIntervalId: ReturnType<typeof setInterval> | null = null;
  private lastEmitTime: number = 0;
  private audioLevelListeners = new Set<AudioLevelCallback>();
  private frequencyListeners = new Set<FrequencyCallback>();

  private autoSendCallback: (() => void) | null = null;
  private silenceTimer: any = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private userSpokeInSession: boolean = false;

  private currentAudioElement: HTMLAudioElement | null = null;
  private currentAudioSource: AudioBufferSourceNode | null = null;
  private isStartingMeter: boolean = false;
  private ttsAbortController: AbortController | null = null;
  private ttsAudioCache = new Map<string, AudioBuffer>();
  private activeNeuralVoice: string = 'Aoede';
  private activeSpeakId: number = 0;
  private streamingEpoch: number = 0;
  private isWarmingTtsCache: boolean = false;
  private webSpeechNetworkFails: number = 0;

  constructor() {
    this.initRecognition();
    audioGate.registerAbortHandler('neural_tts', () => {
      this.cancelNeuralPlayback();
    });
    audioGate.registerAbortHandler('offline_tts', () => {
      this.cancelOfflinePlayback();
    });
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = () => {
        try { window.speechSynthesis.getVoices(); } catch {}
      };
    }
  }

  public setActiveNeuralVoice(voice: string) {
    if (['Aoede', 'Puck', 'Charon', 'Kore', 'Fenrir'].includes(voice)) {
      if (this.activeNeuralVoice !== voice) {
        this.activeNeuralVoice = voice;
        this.ttsAudioCache.clear();
        const isVoiceActive = Boolean(
          typeof window !== 'undefined' && (window as any).__LIORA_STORE__?.getState?.()?.isVoiceActive
        );
        if (isVoiceActive) {
          void this.warmTtsCache();
        }
      }
    }
  }

  public getActiveNeuralVoice(): string {
    return this.activeNeuralVoice;
  }

  public getOrCreateAudioContext(): AudioContext {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioCtx({ sampleRate: 16000 });
    }
    return this.audioContext;
  }

  public getDiagnosticData() {
    const ctx = this.audioContext;
    const hasWebSpeech = typeof window !== 'undefined' && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
    return {
      audioContextState: ctx ? ctx.state : 'uninitialized',
      sampleRate: ctx ? ctx.sampleRate : 16000,
      baseLatencyMs: ctx ? Math.round((ctx.baseLatency || 0.0125) * 1000) : 12,
      isListeningActive: this.isListeningActive,
      shouldBeListening: this.shouldBeListening,
      hasWebSpeechSupport: hasWebSpeech,
      usingFallbackMeter: this.isFallbackMeterActive,
      hasMediaStream: Boolean(this.mediaStream && this.mediaStream.active),
      mediaTrackState: this.mediaStream?.getAudioTracks()?.[0]?.readyState || 'none',
      hasScriptProcessor: Boolean(this.scriptProcessor),
      cachedPhrasesCount: this.ttsAudioCache.size
    };
  }

  public async warmTtsCache() {
    if (this.isWarmingTtsCache) return;
    const geminiKey = integrationsVault.getApiKeyByProvider('gemini') || integrationsVault.getRawKey('svc-gemini');
    if (!geminiKey || geminiKey.trim().length < 5) {
      return;
    }

    this.isWarmingTtsCache = true;
    const defaultPhrases = [
      'Entendido.',
      'Certo.',
      'Analisando.',
      'Processando.',
      'Abrindo Bloco de Notas, Mestre.',
      'Abrindo Calculadora, Mestre.',
      'Abrindo Painel de Controle, Mestre.',
      'Abrindo Google Chrome, Mestre.',
      'Abrindo Configurações do Windows, Mestre.',
      'Abrindo Gerenciador de Tarefas, Mestre.',
      'Abrindo Explorador de Arquivos, Mestre.',
      'Abrindo Visual Studio Code, Mestre.',
      'Bloqueando a sessão do computador, Mestre.',
      'Aumentando o volume, Mestre.',
      'Diminuindo o volume, Mestre.',
      'Silenciando o áudio do computador, Mestre.',
      'Navegando para o Painel Geral.',
      'Abrindo as Configurações.',
      'Abrindo Automações.',
      'Abrindo Dispositivos IoT.'
    ];
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${geminiKey}`
    };

    const storeModel = (typeof window !== 'undefined' && (window as any).__LIORA_STORE__?.getState()?.settings?.ttsModel)
      ? (window as any).__LIORA_STORE__.getState().settings.ttsModel
      : 'gemini-3.8-flash-lite-tts';

    try {
      for (const phrase of defaultPhrases) {
        if (this.ttsAudioCache.has(phrase.toLowerCase())) continue;
        try {
          const res = await fetch('/api/gemini/tts', {
            method: 'POST',
            headers,
            body: JSON.stringify({ text: phrase, voice: this.activeNeuralVoice, model: storeModel })
          });
          if (!res.ok) {
            break;
          }
          const data = await res.json();
          if (data.fallbackToNative || data.code === 'QUOTA_EXHAUSTED' || data.code === 'AUTH_ERROR') {
            break;
          }
          if (data.success && data.audioBase64) {
            const binaryString = atob(data.audioBase64);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            const audioCtx = this.getOrCreateAudioContext();
            const buffer = await audioCtx.decodeAudioData(bytes.buffer.slice(0));
            this.ttsAudioCache.set(phrase.toLowerCase(), buffer);
          }
        } catch {
          break;
        }
      }
    } finally {
      this.isWarmingTtsCache = false;
    }
  }

  public playInstantAcknowledgment(): boolean {
    if (typeof window === 'undefined' || this.isSpeaking()) return false;
    if (!audioGate.acquireChannel('neural_tts')) return false;

    const phrases = ['entendido.', 'certo.', 'analisando.', 'processando.'];
    for (const p of phrases) {
      const cached = this.ttsAudioCache.get(p);
      if (cached && this.audioContext) {
        try {
          if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
          }
          const source = this.audioContext.createBufferSource();
          source.buffer = cached;
          source.connect(this.audioContext.destination);
          this.currentAudioSource = source;
          // Correção: sem onended, a referência fica órfã e isSpeaking() retorna true para sempre,
          // bloqueando reconhecimentos futuros e o turn-taking do duplex.
          source.onended = () => {
            if (this.currentAudioSource === source) {
              this.currentAudioSource = null;
            }
            audioGate.releaseChannel('neural_tts');
          };
          source.start(0);
          return true;
        } catch {}
      }
    }

    audioGate.releaseChannel('neural_tts');
    // Erradicação total de voz robótica: Nunca utilizar síntese nativa do navegador aqui
    return false;
  }

  private initRecognition(): SpeechRecognitionInstance | null {
    if (typeof window === 'undefined') return null;

    const SpeechRecConstructor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecConstructor) {
      try {
        const rec = new SpeechRecConstructor();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = 'pt-BR';
        this.recognition = rec;
        return rec;
      } catch (e) {
        console.warn('[SpeechService] Falha ao instanciar SpeechRecognition:', e);
      }
    }
    return null;
  }

  public unlockAudio() {
    if (typeof window === 'undefined') return;
    try {
      if (window.speechSynthesis) {
        window.speechSynthesis.resume();
      }
      const audioCtx = this.getOrCreateAudioContext();
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      // Desbloqueia o AudioContext no Chrome via buffer silencioso 16kHz
      const silentBuffer = audioCtx.createBuffer(1, 1, 16000);
      const source = audioCtx.createBufferSource();
      source.buffer = silentBuffer;
      source.connect(audioCtx.destination);
      source.start(0);
    } catch {}
  }

  public isSupported(): boolean {
    if (typeof window === 'undefined') return false;
    return Boolean(
      (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) || 
      window.SpeechRecognition || 
      window.webkitSpeechRecognition
    );
  }

  public isListening(): boolean {
    return this.isListeningActive || this.shouldBeListening;
  }

  public getMediaStream(): MediaStream | null {
    if (this.mediaStream && this.mediaStream.active) {
      return this.mediaStream;
    }
    return null;
  }

  public onAudioLevel(cb: AudioLevelCallback): () => void {
    this.audioLevelListeners.add(cb);
    return () => this.audioLevelListeners.delete(cb);
  }

  public onFrequencyData(cb: FrequencyCallback): () => void {
    this.frequencyListeners.add(cb);
    return () => this.frequencyListeners.delete(cb);
  }

  private selectedDeviceId: string | null = null;

  public setSelectedAudioDevice(id: string) {
    if (this.selectedDeviceId === id) return;
    this.selectedDeviceId = id;
    if (typeof window !== 'undefined' && (this.mediaStream || this.micSourceNode || this.shouldBeListening)) {
      const wasListening = this.shouldBeListening;
      // CORREÇÃO: `acquireMediaStream()` reutiliza a stream existente enquanto ela
      // estiver `active` — trocar o dispositivo no menu deixava a stream antiga
      // viva e o microfone antigo continuava sendo usado. O teardown completo
      // encerra as trilhas de hardware para que o novo device seja aberto.
      this.stopAudioMeter(true);
      if (wasListening) {
        this.shouldBeListening = true;
        void this.startAudioMeter();
      }
    }
  }

  public getSelectedAudioDevice(): string | null {
    return this.selectedDeviceId;
  }

  public async getAudioInputDevices(): Promise<MediaDeviceInfo[]> {
    if (typeof window === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter(d => d.kind === 'audioinput');
    } catch {
      return [];
    }
  }

  private async acquireMediaStream(): Promise<MediaStream> {
    if (this.mediaStream && this.mediaStream.active) {
      const liveTracks = this.mediaStream.getAudioTracks().filter(t => t.readyState === 'live');
      if (liveTracks.length > 0) {
        return this.mediaStream;
      }
    }

    const constraintsList: MediaStreamConstraints[] = [];
    if (this.selectedDeviceId) {
      constraintsList.push({ audio: { deviceId: { exact: this.selectedDeviceId }, sampleRate: 16000, channelCount: 1 } });
      constraintsList.push({ audio: { deviceId: this.selectedDeviceId, sampleRate: 16000, channelCount: 1 } });
    }
    constraintsList.push({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 16000, channelCount: 1 } });
    constraintsList.push({ audio: { sampleRate: 16000, channelCount: 1 } });
    constraintsList.push({ audio: true });

    let lastError: any = null;
    for (const constraints of constraintsList) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (stream && stream.active && stream.getAudioTracks().length > 0) {
          this.mediaStream = stream;
          return stream;
        }
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('Nenhum fluxo de microfone pôde ser obtido.');
  }

  public async requestMicrophonePermission(): Promise<{ success: boolean; error?: string }> {
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      console.error('[GlobalVoiceBar AudioContext] getUserMedia is not supported in this browser environment.');
      return { success: false, error: 'Navegador ou dispositivo sem suporte a áudio.' };
    }
    try {
      this.unlockAudio();
      const stream = await this.acquireMediaStream();

      const audioTracks = stream.getAudioTracks();
      console.log(`[GlobalVoiceBar AudioContext] Stream acquired. Active: ${stream.active}, Track Count: ${audioTracks.length}`);
      
      audioTracks.forEach((track, i) => {
        console.log(`[GlobalVoiceBar AudioTrack #${i}] Label: "${track.label}", Enabled: ${track.enabled}, Muted: ${track.muted}, State: "${track.readyState}"`);
      });

      this.getOrCreateAudioContext();
      if (this.audioContext && this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      return { success: true };
    } catch (err: any) {
      console.info('[GlobalVoiceBar AudioContext] getUserMedia erro:', err?.name || err);
      let msg = '';
      if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') {
        msg = 'O microfone está BLOQUEADO nas permissões do navegador ou sistema. Verifique as configurações de Privacidade do Windows/Mac e do navegador.';
      } else if (err?.name === 'NotFoundError' || err?.name === 'DevicesNotFoundError') {
        msg = 'Nenhum dispositivo de microfone foi encontrado ou detectado conectado ao computador.';
      } else if (err?.name === 'NotReadableError' || err?.name === 'TrackStartError') {
        msg = 'O microfone está em uso exclusivo por outro aplicativo (Zoom, Discord, Meet ou outra aba). Feche outros apps de áudio e tente novamente.';
      } else {
        msg = `Falha ao acessar microfone: ${err?.message || err}`;
      }
      return { success: false, error: msg };
    }
  }

  private async startAudioMeter() {
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) return;
    if (this.isStartingMeter) return;
    this.isStartingMeter = true;
    try {
      // Cancela qualquer loop de animação prévio para impedir multiplicidade de frames
      if (this.animFrameId) {
        cancelAnimationFrame(this.animFrameId);
        this.animFrameId = null;
      }

      if (!this.mediaStream || !this.mediaStream.active) {
        console.debug('[GlobalVoiceBar AudioContext] startAudioMeter: Solicitando stream via acquireMediaStream...');
        this.mediaStream = await this.acquireMediaStream();
      }

      const audioTracks = this.mediaStream.getAudioTracks();
      const isTrackEnabled = audioTracks.some(t => t.enabled && t.readyState === 'live' && !t.muted);
      if (!isTrackEnabled) {
        console.warn('[GlobalVoiceBar AudioContext] AVISO: Nenhuma trilha de microfone ativa detectada.');
      }

      const audioCtx = this.getOrCreateAudioContext();
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      if (!this.micGainNode) {
        this.micGainNode = audioCtx.createGain();
      }
      this.micGainNode.gain.setValueAtTime(1.0, audioCtx.currentTime);

      if (!this.micSourceNode) {
        this.micSourceNode = audioCtx.createMediaStreamSource(this.mediaStream);
        this.micSourceNode.connect(this.micGainNode);
      }

      if (!this.analyser) {
        this.analyser = audioCtx.createAnalyser();
        this.analyser.fftSize = 128; // 64 bins de frequência em alta resolução
        this.analyser.smoothingTimeConstant = 0.4;
        this.micGainNode.connect(this.analyser);
      }

      // Reinicializa MediaRecorder para transcrição pontual se necessário
      try {
        if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
          this.recordedAudioChunks = [];
          this.mediaRecorder = new MediaRecorder(this.mediaStream, { mimeType: 'audio/webm' });
          this.mediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) {
              this.recordedAudioChunks.push(e.data);
            }
          };
          this.mediaRecorder.start(500);
        }
      } catch (e) {
        // Fallback silencioso se MediaRecorder não suportar webm
      }

      if (!this.scriptProcessor && !this.micChunkProcessor) {
        this.rawAudioSamples = [];
        // CORREÇÃO (depreciação): AudioWorklet com fallback para ScriptProcessor.
        // Coleta os mesmos blocos de 2048 amostras do micGainNode (WAV p/ Gemini).
        void createAudioChunkProcessor(audioCtx, 2048, (channelData) => {
          if (!this.shouldBeListening) return;
          this.rawAudioSamples.push(new Float32Array(channelData));
          if (this.rawAudioSamples.length > 500) {
            this.rawAudioSamples.shift();
          }
        }).then((processor) => {
          this.micChunkProcessor = processor;
          if (this.shouldBeListening && this.micGainNode) {
            processor.connect(this.micGainNode);
          }
        }).catch((err) => {
          console.warn('[SpeechService] Falha ao iniciar processador de áudio:', err);
        });
        if (!this.silentGainNode) {
          this.silentGainNode = audioCtx.createGain();
          this.silentGainNode.gain.value = 0;
          this.silentGainNode.connect(audioCtx.destination);
        }
      }

      // CORREÇÃO (Etapa 7 — microfone morre ao minimizar): o requestAnimationFrame
      // PAUSA AUTOMATICAMENTE quando a janela é minimizada (comportamento nativo
      // do WebView2), matando o VAD e o medidor de nível — a LIORA "surdia" em
      // segundo plano. Substituído por setInterval de 50ms (20Hz), que continua
      // rodando com a janela minimizada, mantendo a escuta contínua.
      const timeData = new Uint8Array(this.analyser.fftSize);
      const freqData = new Uint8Array(this.analyser.frequencyBinCount);
      let smoothedLevel = 0;
      // Etapa E: reinicializa o timestamp de emissão a cada restart do medidor
      // (evita burst de emissões atrasadas do ciclo anterior)
      this.lastEmitTime = 0;

      if (this.meterIntervalId) {
        clearInterval(this.meterIntervalId);
      }
      this.meterIntervalId = setInterval(() => {
        // Auto-recuperação do AudioContext caso seja suspenso pelo WebView2/Chromium
        if (this.audioContext && this.audioContext.state === 'suspended') {
          this.audioContext.resume().catch(() => {});
        }
        if (this.micGainNode && this.audioContext && this.micGainNode.gain.value === 0) {
          try {
            this.micGainNode.gain.setValueAtTime(1.0, this.audioContext.currentTime);
          } catch {}
        }

        if (!this.shouldBeListening || !this.analyser) return;

        this.analyser.getByteTimeDomainData(timeData);
        this.analyser.getByteFrequencyData(freqData);

        // 1. Cálculo de RMS real do sinal de áudio do microfone
        let sumSquares = 0;
        for (let i = 0; i < timeData.length; i++) {
          const norm = (timeData[i] - 128) / 128;
          sumSquares += norm * norm;
        }
        const rms = Math.sqrt(sumSquares / timeData.length);
        // Calibração responsiva: voz humana normal (~0.05 a ~0.25 RMS) mapeada para escala 15-85%
        const targetLevel = Math.min(100, Math.round(Math.min(1, rms * 5.0) * 100));

        // Suavização exponencial suave (sem travamentos ou lag)
        smoothedLevel = smoothedLevel * 0.65 + targetLevel * 0.35;

        // Emite a 20Hz (a cada ~50ms)
        const nowTs = performance.now();
        if (!this.lastEmitTime || nowTs - this.lastEmitTime >= 50) {
          this.lastEmitTime = nowTs;

          const levelEmit = Math.round(smoothedLevel);
          this.audioLevelListeners.forEach(listener => listener(levelEmit));

          // VAD (Voice Activity Detection): detecção de voz do operador
          if (levelEmit >= 12 || rms > 0.025) {
            // Anti-auto-interrupção acústica: quando a LIORA está falando pelo alto-falante,
            // o microfone capta o som dos próprios alto-falantes (eco acústico).
            // NUNCA interrompe a fala por RMS bruto — a interrupção inteligente (barge-in)
            // é tratada exclusivamente pelo STT no onResult quando palavras humanas reais são reconhecidas.
            if (!this.isSpeaking()) {
              this.userSpokeInSession = true;
              if (this.silenceTimer) {
                clearTimeout(this.silenceTimer);
                this.silenceTimer = null;
              }
            }
          } else if (this.userSpokeInSession && levelEmit < 8 && this.autoSendCallback) {
            if (!this.silenceTimer) {
              this.silenceTimer = setTimeout(() => {
                this.silenceTimer = null;
                if (this.userSpokeInSession && this.autoSendCallback && this.shouldBeListening) {
                  this.userSpokeInSession = false;
                  const cb = this.autoSendCallback;
                  this.autoSendCallback = null;
                  cb();
                }
              }, 750);
            }
          }

          // 2. Cálculo dos 20 Bins Hz discretos cobrindo graves, médios e agudos da voz
          const numBins = 20;
          const frequencyBins: number[] = [];
          const totalBins = freqData.length; // 64 bins
          for (let b = 0; b < numBins; b++) {
            const start = Math.floor((b / numBins) * totalBins);
            const end = Math.max(start + 1, Math.floor(((b + 1) / numBins) * totalBins));
            let binSum = 0;
            let count = 0;
            for (let j = start; j < end; j++) {
              binSum += freqData[j] || 0;
              count++;
            }
            const binAvg = count > 0 ? binSum / count : 0;
            // Normaliza com curva logarítmica de voz (voz comum fica entre 15% e 80%)
            const normalizedBin = Math.min(100, Math.round((binAvg / 180) * 100));
            frequencyBins.push(normalizedBin);
          }
          this.frequencyListeners.forEach(listener => listener(frequencyBins));
        }
      }, 50);
    } catch (err: any) {
      console.info('[GlobalVoiceBar AudioContext] Microfone físico não inicializado. Ativando sintetizador espectral de fallback:', err?.message || err);
      this.startFallbackAudioMeter();
    } finally {
      this.isStartingMeter = false;
    }
  }

  public ensureAudioMeterRunning(): void {
    this.shouldBeListening = true;
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(() => {});
    }
    if (this.micGainNode && this.audioContext) {
      try {
        this.micGainNode.gain.setValueAtTime(1.0, this.audioContext.currentTime);
      } catch {}
    }
    if (!this.meterIntervalId || !this.mediaStream || !this.mediaStream.active || !this.analyser) {
      void this.startAudioMeter();
    }
  }

  private isFallbackMeterActive = false;

  public isUsingFallbackMeter(): boolean {
    return this.isFallbackMeterActive;
  }

  public async transcribeAudio(audio: { data: string; mimeType: string }): Promise<{ success: boolean; text?: string; hasSpeech?: boolean; error?: string }> {
    try {
      const geminiKey = integrationsVault.getApiKeyByProvider('gemini') || integrationsVault.getRawKey('svc-gemini');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (geminiKey) headers['Authorization'] = `Bearer ${geminiKey}`;

      const res = await fetch('/api/gemini/transcribe', {
        method: 'POST',
        headers,
        body: JSON.stringify({ audio })
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        return { success: false, error: errJson.error || 'Falha na transcrição' };
      }
      const data = await res.json();
      return { success: true, text: data.text || '', hasSpeech: Boolean(data.hasSpeech && data.text) };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Erro de rede na transcrição' };
    }
  }

  private startFallbackAudioMeter() {
    this.isFallbackMeterActive = true;
    // CORREÇÃO (handles órfãos): o loop anterior usava requestAnimationFrame e só
    // parava via `shouldBeListening` — com a janela minimizada o rAF PAUSA, e o id
    // do frame nunca era usado para cancelar em stopAudioMeter (que só cancelava
    // `this.animFrameId`, sobrescrito a cada frame). Resultado: loops duplicados a
    // cada restart -> bursts de nível de áudio falso. Agora o loop é um	timers
    // rastreado e sempre cancelado no teardown.
    if (this.fallbackIntervalId) {
      clearInterval(this.fallbackIntervalId);
      this.fallbackIntervalId = null;
    }
    let tick = 0;
    let smoothedLevel = 0;
    let lastEmitTime = 0;

    const pollFallback = () => {
      if (!this.shouldBeListening) {
        if (this.fallbackIntervalId) {
          clearInterval(this.fallbackIntervalId);
          this.fallbackIntervalId = null;
        }
        this.isFallbackMeterActive = false;
        return;
      }
      tick += 0.08;
      const isTalking = this.isSpeaking();
      const targetLevel = isTalking 
        ? Math.round(35 + Math.sin(tick * 2) * 25) 
        : Math.round(12 + Math.sin(tick * 1.2) * 8);

      smoothedLevel = Math.round(smoothedLevel * 0.75 + targetLevel * 0.25);

      const timestamp = performance.now();
      if (!lastEmitTime || timestamp - lastEmitTime >= 50) {
        lastEmitTime = timestamp;

        this.audioLevelListeners.forEach(listener => listener(smoothedLevel));

        const frequencyBins: number[] = [];
        for (let b = 0; b < 20; b++) {
          const val = isTalking 
            ? Math.round(25 + Math.sin(tick * 1.8 + b * 0.35) * 45) 
            : Math.round(10 + Math.sin(tick * 1.0 + b * 0.25) * 12);
          frequencyBins.push(Math.max(4, Math.min(100, val)));
        }
        this.frequencyListeners.forEach(listener => listener(frequencyBins));
      }
    };
    this.fallbackIntervalId = setInterval(pollFallback, 50);
  }

  public async getRecordedAudioBlob(): Promise<{ data: string; mimeType: string } | null> {
    if (this.rawAudioSamples.length > 0) {
      let totalLength = 0;
      for (const chunk of this.rawAudioSamples) {
        totalLength += chunk.length;
      }
      const combined = new Float32Array(totalLength);
      let offset = 0;
      for (const chunk of this.rawAudioSamples) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      this.rawAudioSamples = [];

      let sumAbs = 0;
      for (let i = 0; i < combined.length; i++) {
        sumAbs += Math.abs(combined[i]);
      }
      const avgAbs = sumAbs / (combined.length || 1);
      console.log(`[SpeechService] WAV Audio recorded. Samples: ${combined.length}, Avg amp: ${avgAbs.toFixed(6)}`);

      // Se temos pelo menos ~0.15s de gravação (2400 amostras a 16kHz)
      if (combined.length >= 1600) {
        const wavBlob = encodeWAV(combined, this.audioContext?.sampleRate || 16000);
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64data = (reader.result as string || '').split(',')[1];
            if (base64data) {
              resolve({ data: base64data, mimeType: 'audio/wav' });
            } else {
              resolve(null);
            }
          };
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(wavBlob);
        });
      }
    }

    if (this.recordedAudioChunks.length > 0) {
      const mime = this.mediaRecorder?.mimeType || 'audio/webm';
      const blob = new Blob(this.recordedAudioChunks, { type: mime });
      this.recordedAudioChunks = [];
      if (blob.size >= 50) {
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64data = (reader.result as string || '').split(',')[1];
            if (base64data) {
              resolve({ data: base64data, mimeType: mime });
            } else {
              resolve(null);
            }
          };
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      }
    }

    return null;
  }

  private stopAudioMeter(fullTeardown = false) {
    this.isFallbackMeterActive = false;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    // CORREÇÃO (handles órfãos): o loop do medidor espectral de fallback também
    // precisa ser cancelado aqui — antes sobrevivia e re-emitia níveis falsos.
    if (this.fallbackIntervalId) {
      clearInterval(this.fallbackIntervalId);
      this.fallbackIntervalId = null;
    }
    // CORREÇÃO (Etapa E): limpa o intervalo do medidor em TODAS as rotas de
    // desligamento — antes o intervalo sobrevivia a stopListening simples e o
    // VAD continuava rodando (emitindo nível 0 silenciosamente) com mic "desligado".
    if (this.meterIntervalId) {
      clearInterval(this.meterIntervalId);
      this.meterIntervalId = null;
    }
    // Módulo 3: Silencia o ganho sem matar a captura de hardware
    if (this.micGainNode && this.audioContext) {
      try {
        this.micGainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
      } catch {}
    }
    if (this.mediaRecorder) {
      try {
        if (this.mediaRecorder.state !== 'inactive') {
          this.mediaRecorder.stop();
        }
      } catch {}
      this.mediaRecorder = null;
    }
    this.recordedAudioChunks = [];

    if (this.scriptProcessor) {
      try {
        this.scriptProcessor.disconnect();
      } catch {}
      this.scriptProcessor = null;
    }

    if (this.micChunkProcessor) {
      try {
        this.micChunkProcessor.dispose();
      } catch {}
      this.micChunkProcessor = null;
    }

    if (this.silentGainNode) {
      try {
        this.silentGainNode.disconnect();
      } catch {}
      this.silentGainNode = null;
    }

    // Apenas destrói hardware em caso de desmontagem completa (fullTeardown = true)
    if (fullTeardown) {
      this.rawAudioSamples = [];
      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach(t => t.stop());
        this.mediaStream = null;
      }
      if (this.audioContext) {
        try {
          this.audioContext.close();
        } catch {}
        this.audioContext = null;
      }
      this.micSourceNode = null;
      this.micGainNode = null;
      this.analyser = null;
    }
    this.audioLevelListeners.forEach(listener => listener(0));
  }

  public startListening(
    onResult: SpeechCallback,
    onError?: (error: string) => void,
    onEnd?: () => void,
    onAutoSend?: () => void
  ): boolean {
    this.shouldBeListening = true;
    this.autoSendCallback = onAutoSend || null;
    this.userSpokeInSession = false;
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }

    // Inicia SEMPRE o monitoramento de volume físico do microfone (VU meter) e gravação de áudio WAV para o Gemini
    this.startAudioMeter();

    // Re-instancia o SpeechRecognition para evitar travamento de estado assíncrono no Chromium após o stop()
    if (this.recognition) {
      try {
        const oldRec: SpeechRecognitionInstance = this.recognition;
        oldRec.onresult = null;
        oldRec.onerror = null;
        oldRec.onend = null;
        oldRec.stop();
      } catch {}
      this.recognition = null;
    }

    const rec = this.initRecognition();

    // Se o navegador não tiver SpeechRecognition (ex: Opera GX, Firefox, Brave),
    // o microfone continua gravando normalmente via AudioContext/WAV para o Gemini!
    if (!rec) {
      console.info('[SpeechService] Web Speech API não disponível neste navegador (Opera GX). Modo de áudio nativo PCM/Gemini ativado.');
      this.isListeningActive = true;
      return true;
    }

    try {
      rec.onresult = (event: SpeechRecognitionEventLike) => {
        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const piece = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalTranscript += piece;
          } else {
            interimTranscript += piece;
          }
        }

        const fullText = (finalTranscript || interimTranscript).trim();
        if (fullText) {
          if (this.isSpeaking()) {
            // Anti-Echo & Barge-In Consciente:
            // Se a LIORA está falando, verifica se é um comando explícito de parada ou uma decisão de consentimento.
            const normLower = fullText.toLowerCase().trim();
            const isStopCommand = /^(?:para|parar|pare|cancela|cancelar|silencio|silêncio|quieta|chega|stop|shh|calada)$/i.test(normLower) ||
              /\b(?:para|parar|pare|cancela|cancelar|silencio|silêncio|chega)\s+liora\b/i.test(normLower);

            const consentDecision = parseConsentVoiceDecision(normLower);

            if (isStopCommand || consentDecision) {
              console.log('[SpeechService Barge-In STT] Comando de parada ou decisão de consentimento do usuário reconhecido:', fullText);
              this.stopSpeaking();
              if (consentDecision) {
                this.userSpokeInSession = true;
                onResult(fullText, Boolean(finalTranscript));
              }
              return;
            }

            // Se não for comando de parada nem decisão de consentimento, é eco do próprio alto-falante captado pelo microfone.
            // Ignora para não cortar a fala da LIORA na metade nem disparar loops de auto-reconhecimento.
            return;
          }

          this.userSpokeInSession = true;
          this.webSpeechNetworkFails = 0;
          onResult(fullText, Boolean(finalTranscript));

          if (finalTranscript && this.autoSendCallback) {
            if (this.silenceTimer) clearTimeout(this.silenceTimer);
            this.silenceTimer = setTimeout(() => {
              this.silenceTimer = null;
              if (this.autoSendCallback && this.shouldBeListening) {
                console.log('[SpeechService STT] Texto final de voz recebido (750ms). Envio automático acionado.');
                this.userSpokeInSession = false;
                const cb = this.autoSendCallback;
                this.autoSendCallback = null;
                cb();
              }
            }, 750);
          }
        }
      };

      rec.onerror = (event: SpeechRecognitionErrorEventLike) => {
        if (event.error === 'not-allowed' || event.error === 'permission-denied') {
          console.warn('[SpeechService] Permissão de microfone negada:', event.error);
          this.shouldBeListening = false;
          this.stopAudioMeter();
          onError?.('Permissão de microfone negada. Clique no cadeado na barra de endereços do navegador e autorize o microfone.');
        } else if (event.error === 'no-speech') {
          // Normal: silêncio transitório. Não aborta escuta contínua.
        } else if (event.error === 'network') {
          // Web Speech API do Chromium/WebView2 não consegue alcançar os servidores proprietários do Google Speech (comum em WebView2 no Windows).
          // Não polui o console nem assusta o usuário na interface com erro: o VAD e o pipeline de áudio PCM/Gemini continuam 100% ativos!
          this.webSpeechNetworkFails = (this.webSpeechNetworkFails || 0) + 1;
          if (this.webSpeechNetworkFails <= 1) {
            console.info('[SpeechService] Web Speech API em nuvem não disponível neste ambiente (network). Microfone operando via áudio PCM nativo + VAD.');
          }
        } else {
          console.warn('[SpeechService] Evento de erro:', event.error);
          onError?.(event.message || `Status do microfone: ${event.error}`);
        }
      };

      rec.onend = () => {
        this.isListeningActive = false;
        // Se o usuário ainda quer manter a voz ativa, reinicia com uma nova instância limpa
        // evitando que o Chrome trave a escuta após pausas!
        if (this.shouldBeListening) {
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          // Se o Web Speech API falhar repetidamente por network (comum no WebView2/Tauri),
          // aplica backoff para evitar laço agressivo de 100ms que consome CPU e inunda o log
          const delay = (this.webSpeechNetworkFails >= 2) ? 15000 : 500;
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.shouldBeListening) {
              try {
                this.startListening(onResult, onError, onEnd, onAutoSend);
              } catch (e: any) {
                console.warn('[SpeechService] Tentativa de reconexão do microfone:', e);
              }
            }
          }, delay);
        } else {
          onEnd?.();
        }
      };

      rec.start();
      this.isListeningActive = true;
      return true;
    } catch (err: any) {
      console.warn('[SpeechService] Erro ao iniciar captura:', err);
      if (err.name === 'InvalidStateError') {
        this.isListeningActive = true;
        return true;
      }
      onError?.(err?.message || 'Falha ao acessar microfone.');
      return false;
    }
  }

  public stopListening() {
    this.shouldBeListening = false;
    this.autoSendCallback = null;
    this.userSpokeInSession = false;
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopAudioMeter();
    if (this.recognition) {
      try {
        this.recognition.onresult = null;
        this.recognition.onerror = null;
        this.recognition.onend = null;
        this.recognition.stop();
      } catch {}
      this.recognition = null;
    }
    this.isListeningActive = false;
  }

  private streamingQueue: Array<{ text: string; onStart?: () => void }> = [];
  private isProcessingQueue = false;
  private isStreamDone = false;
  private onAllStreamingFinished: (() => void) | null = null;

  public resetStreamingQueue() {
    this.streamingQueue = [];
    this.isProcessingQueue = false;
    this.isStreamDone = false;
    this.onAllStreamingFinished = null;
    this.stopSpeaking();
  }

  public speakStreamingChunk(chunkText: string, onStart?: () => void) {
    const cleanText = chunkText
      .replace(/[*#_`~[\]()]/g, '')
      .replace(/https?:\/\/\S+/g, 'link')
      .trim();

    if (!cleanText) return;

    this.streamingQueue.push({ text: cleanText, onStart });
    if (!this.isProcessingQueue) {
      this.processStreamingQueue();
    }
  }

  public finishStreamingQueue(onAllFinished?: () => void) {
    this.isStreamDone = true;
    this.onAllStreamingFinished = onAllFinished || null;
    if (!this.isProcessingQueue && this.streamingQueue.length === 0) {
      this.onAllStreamingFinished?.();
      this.onAllStreamingFinished = null;
    }
  }

  private async processStreamingQueue() {
    const epoch = this.streamingEpoch;
    if (this.streamingQueue.length === 0) {
      this.isProcessingQueue = false;
      if (this.isStreamDone) {
        this.onAllStreamingFinished?.();
        this.onAllStreamingFinished = null;
      }
      return;
    }

    this.isProcessingQueue = true;
    const item = this.streamingQueue.shift()!;

    await this.speakSingleChunk(item.text, item.onStart);
    if (epoch !== this.streamingEpoch) return;

    this.processStreamingQueue();
  }

  private async speakSingleChunk(text: string, onStart?: () => void): Promise<void> {
    return new Promise((resolve) => {
      this.speak(
        text,
        onStart,
        () => {
          resolve();
        },
        { preserveStreamingQueue: true }
      );
    });
  }

  /**
   * Fala em voz alta um texto usando a síntese de voz (TTS) neural do Gemini ou nativa do navegador
   */
  public async speak(
    text: string,
    onStart?: () => void,
    onEnd?: () => void,
    options?: { isDeterministicOverride?: boolean; preserveStreamingQueue?: boolean }
  ) {
    if (typeof window === 'undefined') {
      onEnd?.();
      return;
    }
    const isDeterministicOverride = Boolean(options?.isDeterministicOverride ?? audioGate.isLiveSuppressed());

    // CORREÇÃO (voz dupla — relato de campo "apareceu 2 vozes, uma offline e
    // outra da API"): quando a fala é DETERMINÍSTICA (confirmação/resultado de
    // ferramenta), ela precisa ser a ÚNICA voz. Antes o override só liberava o
    // canal neural_tts, deixando o Gemini Live falando em paralelo por cima do
    // TTS — dois áudios simultâneos. Aqui o Live é interrompido e suprimido
    // enquanto a fala determinística está no ar.
    if (isDeterministicOverride) {
      audioGate.suppressLiveFor(4500);
    }

    // Gate estrito de exclusão mútua: se o canal Live WS está ativo e não foi suprimido,
    // nunca empilha uma segunda voz paralela nem aborta o canal Live antes da hora.
    if (!audioGate.canAcquire('neural_tts', { isDeterministicOverride })) {
      onEnd?.();
      return;
    }

    // Cancela qualquer fala, fetch ou buffer de áudio anterior antes de reivindicar canal no VoiceManager
    if (options?.preserveStreamingQueue) {
      this.cancelActiveAudio();
    } else {
      this.stopSpeaking();
    }
    const speakId = ++this.activeSpeakId;

    // Remove markdown e caracteres especiais para fala fluida
    const cleanText = text
      .replace(/[*#_`~[\]()]/g, '')
      .replace(/https?:\/\/\S+/g, 'link')
      .slice(0, 1000)
      .trim();

    if (!cleanText) {
      onEnd?.();
      return;
    }

    voiceManager.prepareForStreamPlayback();

    if (!audioGate.acquireChannel('neural_tts', { isDeterministicOverride })) {
      voiceManager.releaseLock('stream');
      onEnd?.();
      return;
    }

    const cacheKey = cleanText.toLowerCase();

    // 1. Checa se o áudio já está pré-sintetizado em cache (desempenho < 5ms)
    const cachedBuffer = this.ttsAudioCache.get(cacheKey);
    if (cachedBuffer) {
      try {
        const audioCtx = this.getOrCreateAudioContext();
        if (audioCtx.state === 'suspended') {
          await audioCtx.resume();
        }
        if (speakId !== this.activeSpeakId) {
          audioGate.releaseChannel('neural_tts');
          voiceManager.releaseLock('stream');
          onEnd?.();
          return;
        }

        const source = audioCtx.createBufferSource();
        source.buffer = cachedBuffer;
        source.connect(audioCtx.destination);

        source.onended = () => {
          if (this.currentAudioSource === source) {
            this.currentAudioSource = null;
          }
          audioGate.releaseChannel('neural_tts');
          voiceManager.releaseLock('stream');
          onEnd?.();
        };

        this.currentAudioSource = source;
        onStart?.();
        source.start(0);
        console.log(`[SpeechService Cache Hit] Reprodução instantânea (<5ms): '${cleanText.slice(0, 30)}...'`);
        return;
      } catch (cacheErr) {
        console.warn('[SpeechService Cache Fallback]:', cacheErr);
      }
    }

    if (speakId !== this.activeSpeakId) {
      audioGate.releaseChannel('neural_tts');
      voiceManager.releaseLock('stream');
      onEnd?.();
      return;
    }

    // 2. Se não estiver em cache, tenta síntese de voz neural via backend Gemini TTS
    const abortCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    this.ttsAbortController = abortCtrl;

    try {
      const geminiKey = integrationsVault.getApiKeyByProvider('gemini') || integrationsVault.getRawKey('svc-gemini');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (geminiKey) headers['Authorization'] = `Bearer ${geminiKey}`;

      const storeModel = (typeof window !== 'undefined' && (window as any).__LIORA_STORE__?.getState()?.settings?.ttsModel)
        ? (window as any).__LIORA_STORE__.getState().settings.ttsModel
        : 'gemini-3.8-flash-lite-tts';

      const res = await fetch('/api/gemini/tts', {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: cleanText, voice: this.activeNeuralVoice, model: storeModel }),
        signal: abortCtrl?.signal
      });
      if (this.ttsAbortController === abortCtrl) {
        this.ttsAbortController = null;
      }
      if (speakId !== this.activeSpeakId) {
        audioGate.releaseChannel('neural_tts');
        voiceManager.releaseLock('stream');
        onEnd?.();
        return;
      }

      if (res.ok) {
        const data = await res.json();
        if (speakId !== this.activeSpeakId) {
          audioGate.releaseChannel('neural_tts');
          voiceManager.releaseLock('stream');
          onEnd?.();
          return;
        }
        if (data.fallbackToNative || data.code === 'QUOTA_EXHAUSTED' || !data.success) {
          audioGate.releaseChannel('neural_tts');
          voiceManager.releaseLock('stream');
          console.info('[SpeechService] Gemini TTS indisponível ou cota esgotada. Alternando para voz nativa pt-BR do sistema.');
          this.speakFallbackBrowser(cleanText, onStart, onEnd, isDeterministicOverride);
          return;
        }

        if (data.success && data.audioBase64) {
          const binaryString = atob(data.audioBase64);
          const len = binaryString.length;
          const bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }

          const audioCtx = this.getOrCreateAudioContext();
          if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
          }
          if (speakId !== this.activeSpeakId) {
            audioGate.releaseChannel('neural_tts');
            voiceManager.releaseLock('stream');
            onEnd?.();
            return;
          }

          const audioBuffer = await audioCtx.decodeAudioData(bytes.buffer.slice(0));
          if (speakId !== this.activeSpeakId) {
            audioGate.releaseChannel('neural_tts');
            voiceManager.releaseLock('stream');
            onEnd?.();
            return;
          }

          // Guarda em cache frases de até 150 caracteres para reuso instantâneo
          if (cleanText.length <= 150) {
            if (this.ttsAudioCache.size >= 60) {
              const firstKey = this.ttsAudioCache.keys().next().value;
              if (firstKey) this.ttsAudioCache.delete(firstKey);
            }
            this.ttsAudioCache.set(cacheKey, audioBuffer);
          }

          const source = audioCtx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(audioCtx.destination);

          source.onended = () => {
            if (this.currentAudioSource === source) {
              this.currentAudioSource = null;
            }
            audioGate.releaseChannel('neural_tts');
            voiceManager.releaseLock('stream');
            onEnd?.();
          };

          this.currentAudioSource = source;
          onStart?.();
          source.start(0);
          return;
        }
      } else {
        audioGate.releaseChannel('neural_tts');
        voiceManager.releaseLock('stream');
        console.info(`[SpeechService] Gemini TTS respondeu com status ${res.status}. Alternando para síntese nativa.`);
        this.speakFallbackBrowser(cleanText, onStart, onEnd, isDeterministicOverride);
        return;
      }
    } catch (e: any) {
      if (this.ttsAbortController === abortCtrl) {
        this.ttsAbortController = null;
      }
      if (e?.name === 'AbortError' || speakId !== this.activeSpeakId) {
        audioGate.releaseChannel('neural_tts');
        voiceManager.releaseLock('stream');
        onEnd?.();
        return;
      }
      console.warn('[SpeechService] Falha na síntese Gemini TTS:', e);
      audioGate.releaseChannel('neural_tts');
      voiceManager.releaseLock('stream');
      this.speakFallbackBrowser(cleanText, onStart, onEnd, isDeterministicOverride);
      return;
    }

    audioGate.releaseChannel('neural_tts');
    voiceManager.releaseLock('stream');
    this.speakFallbackBrowser(cleanText, onStart, onEnd, isDeterministicOverride);
  }

  private speakFallbackBrowser(
    cleanText: string,
    onStart?: () => void,
    onEnd?: () => void,
    isDeterministicOverride = false
  ) {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      onEnd?.();
      return;
    }

    voiceManager.prepareForLocalPlayback();
    // Gate de exclusão mútua: se API/Live estiver ativo, TTS offline é estritamente silenciado
    if (!audioGate.acquireChannel('offline_tts', { isDeterministicOverride })) {
      window.speechSynthesis.cancel();
      voiceManager.releaseLock('local');
      onEnd?.();
      return;
    }

    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(cleanText);
      utterance.lang = 'pt-BR';
      const storeRate = (typeof window !== 'undefined' && (window as any).__LIORA_STORE__?.getState?.()?.settings?.speechRate) || 1.05;
      utterance.rate = storeRate;
      utterance.pitch = 1.0;

      // Seleciona a melhor voz natural pt-BR instalada no Windows (Microsoft Francisca, Maria, etc.)
      const voices = window.speechSynthesis.getVoices();
      const ptBrVoice = voices.find(v => (v.lang === 'pt-BR' || v.lang === 'pt_BR') && (v.name.includes('Natural') || v.name.includes('Google') || v.name.includes('Microsoft') || v.name.includes('Francisca') || v.name.includes('Luciana') || v.name.includes('Maria'))) 
        || voices.find(v => v.lang === 'pt-BR' || v.lang === 'pt_BR');
      
      if (ptBrVoice) {
        utterance.voice = ptBrVoice;
      }

      utterance.onstart = () => {
        this.currentUtterance = utterance;
        onStart?.();
      };

      utterance.onend = () => {
        if (this.currentUtterance === utterance) {
          this.currentUtterance = null;
        }
        audioGate.releaseChannel('offline_tts');
        voiceManager.releaseLock('local');
        onEnd?.();
      };

      utterance.onerror = (e) => {
        // 'interrupted' é comportamento normal: nova fala cancela a anterior.
        // Não logar como erro poluindo o console.
        if (e.error !== 'interrupted' && e.error !== 'canceled') {
          console.warn('[SpeechService Fallback TTS Error]:', e.error, e);
        }
        if (this.currentUtterance === utterance) {
          this.currentUtterance = null;
        }
        audioGate.releaseChannel('offline_tts');
        voiceManager.releaseLock('local');
        onEnd?.();
      };

      this.currentUtterance = utterance;
      window.speechSynthesis.speak(utterance);
    } catch (err) {
      console.warn('[SpeechService Fallback TTS Exception]:', err);
      audioGate.releaseChannel('offline_tts');
      voiceManager.releaseLock('local');
      onEnd?.();
    }
  }

  private cancelNeuralPlayback() {
    this.activeSpeakId += 1;
    if (this.ttsAbortController) {
      try {
        this.ttsAbortController.abort();
      } catch {}
      this.ttsAbortController = null;
    }
    if (typeof window !== 'undefined') {
      if (this.currentAudioSource) {
        try {
          this.currentAudioSource.onended = null;
          this.currentAudioSource.stop();
          this.currentAudioSource.disconnect();
        } catch {}
        this.currentAudioSource = null;
      }
      if (this.currentAudioElement) {
        try {
          this.currentAudioElement.pause();
          this.currentAudioElement.currentTime = 0;
        } catch {}
        this.currentAudioElement = null;
      }
    }
    audioGate.releaseChannel('neural_tts');
    voiceManager.releaseLock('stream');
  }

  private cancelOfflinePlayback() {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
      this.currentUtterance = null;
    }
    audioGate.releaseChannel('offline_tts');
    voiceManager.releaseLock('local');
  }

  private cancelActiveAudio() {
    this.cancelNeuralPlayback();
    this.cancelOfflinePlayback();
  }

  public stopSpeaking() {
    this.streamingEpoch += 1;
    this.streamingQueue = [];
    this.isProcessingQueue = false;
    this.isStreamDone = false;
    this.onAllStreamingFinished = null;

    this.cancelActiveAudio();
  }

  public isSpeaking(): boolean {
    if (typeof window === 'undefined') return false;
    if (this.currentAudioSource) return true;
    if (this.currentAudioElement && !this.currentAudioElement.paused) return true;
    return Boolean(window.speechSynthesis && window.speechSynthesis.speaking);
  }
}

function encodeWAV(samples: Float32Array, originalSampleRate: number): Blob {
  // Downsampling ou Upsampling rigoroso para 16kHz (padrão Gemini)
  const targetSampleRate = 16000;
  let finalSamples = samples;
  const actualSampleRate = originalSampleRate || 16000;

  if (actualSampleRate !== targetSampleRate) {
    const ratio = actualSampleRate / targetSampleRate;
    const newLen = Math.round(samples.length / ratio);
    const resampled = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const srcIdx = i * ratio;
      const idxLow = Math.floor(srcIdx);
      const idxHigh = Math.min(idxLow + 1, samples.length - 1);
      const frac = srcIdx - idxLow;
      // Interpolação linear para evitar distorção de pitch (slow motion)
      resampled[i] = (1 - frac) * (samples[idxLow] || 0) + frac * (samples[idxHigh] || 0);
    }
    finalSamples = resampled;
  }

  const sampleRate = targetSampleRate;
  const buffer = new ArrayBuffer(44 + finalSamples.length * 2);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + finalSamples.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // Byte rate
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // Bits per sample
  writeString(view, 36, 'data');
  view.setUint32(40, finalSamples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < finalSamples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, finalSamples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }

  return new Blob([view], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

export const speechService = new SpeechService();

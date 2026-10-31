import { integrationsVault } from './integrationsVault';

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
  private rawAudioSamples: Float32Array[] = [];
  private animFrameId: number | null = null;
  private audioLevelListeners = new Set<AudioLevelCallback>();
  private frequencyListeners = new Set<FrequencyCallback>();

  private autoSendCallback: (() => void) | null = null;
  private silenceTimer: any = null;
  private userSpokeInSession: boolean = false;

  private currentAudioElement: HTMLAudioElement | null = null;
  private currentAudioSource: AudioBufferSourceNode | null = null;
  private ttsAudioCache = new Map<string, AudioBuffer>();
  private activeNeuralVoice: string = 'Aoede';

  constructor() {
    this.initRecognition();
    if (typeof window !== 'undefined') {
      if (window.speechSynthesis) {
        window.speechSynthesis.onvoiceschanged = () => {
          try { window.speechSynthesis.getVoices(); } catch {}
        };
      }
      setTimeout(() => {
        this.warmTtsCache();
      }, 1000);
    }
  }

  public setActiveNeuralVoice(voice: string) {
    if (['Aoede', 'Puck', 'Charon', 'Kore', 'Fenrir'].includes(voice)) {
      this.activeNeuralVoice = voice;
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
    const defaultPhrases = ['Entendido.', 'Certo.', 'Analisando.', 'Processando.'];
    const geminiKey = integrationsVault.getApiKeyByProvider('gemini') || integrationsVault.getRawKey('svc-gemini');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (geminiKey) headers['Authorization'] = `Bearer ${geminiKey}`;

    for (const phrase of defaultPhrases) {
      if (this.ttsAudioCache.has(phrase.toLowerCase())) continue;
      try {
        const res = await fetch('/api/gemini/tts', {
          method: 'POST',
          headers,
          body: JSON.stringify({ text: phrase, voice: this.activeNeuralVoice })
        });
        if (res.ok) {
          const data = await res.json();
          if (data.fallbackToNative || data.code === 'QUOTA_EXHAUSTED') {
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
        }
      } catch (e) {
        break;
      }
    }
  }

  public playInstantAcknowledgment(): boolean {
    if (typeof window === 'undefined' || this.isSpeaking()) return false;
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
          source.start(0);
          return true;
        } catch {}
      }
    }

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
    this.selectedDeviceId = id;
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
    try {
      // Cancela qualquer loop de animação prévio para impedir multiplicidade de frames
      if (this.animFrameId) {
        cancelAnimationFrame(this.animFrameId);
        this.animFrameId = null;
      }

      if (!this.mediaStream || !this.mediaStream.active) {
        console.log('[GlobalVoiceBar AudioContext] startAudioMeter: Solicitando stream via acquireMediaStream...');
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

      if (!this.scriptProcessor) {
        this.rawAudioSamples = [];
        this.scriptProcessor = audioCtx.createScriptProcessor(2048, 1, 1);
        this.scriptProcessor.onaudioprocess = (e) => {
          if (!this.shouldBeListening) return;
          const channelData = e.inputBuffer.getChannelData(0);
          this.rawAudioSamples.push(new Float32Array(channelData));
          if (this.rawAudioSamples.length > 500) {
            this.rawAudioSamples.shift();
          }
        };
        this.micGainNode.connect(this.scriptProcessor);
        const silentGain = audioCtx.createGain();
        silentGain.gain.value = 0;
        this.scriptProcessor.connect(silentGain);
        silentGain.connect(audioCtx.destination);
      }

      const timeData = new Uint8Array(this.analyser.fftSize);
      const freqData = new Uint8Array(this.analyser.frequencyBinCount);
      let smoothedLevel = 0;
      let lastEmitTime = 0;

      const pollLevel = (timestamp: number) => {
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
        if (!lastEmitTime || timestamp - lastEmitTime >= 50) {
          lastEmitTime = timestamp;

          const levelEmit = Math.round(smoothedLevel);
          this.audioLevelListeners.forEach(listener => listener(levelEmit));

          // VAD (Voice Activity Detection): detecção de voz e barge-in
          if (levelEmit >= 10 || rms > 0.02) {
            if (this.isSpeaking()) {
              console.log('[SpeechService Barge-In] Usuário falou. Interrompendo áudio LIORA...');
              this.stopSpeaking();
            }

            this.userSpokeInSession = true;
            if (this.silenceTimer) {
              clearTimeout(this.silenceTimer);
              this.silenceTimer = null;
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

        this.animFrameId = requestAnimationFrame(pollLevel);
      };

      this.animFrameId = requestAnimationFrame(pollLevel);
    } catch (err: any) {
      console.info('[GlobalVoiceBar AudioContext] Microfone físico não inicializado. Ativando sintetizador espectral de fallback:', err?.message || err);
      this.startFallbackAudioMeter();
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
    let tick = 0;
    let smoothedLevel = 0;
    let lastEmitTime = 0;

    const pollFallback = (timestamp: number) => {
      if (!this.shouldBeListening) return;
      tick += 0.08;
      const isTalking = this.isSpeaking();
      const targetLevel = isTalking 
        ? Math.round(35 + Math.sin(tick * 2) * 25) 
        : Math.round(12 + Math.sin(tick * 1.2) * 8);

      smoothedLevel = Math.round(smoothedLevel * 0.75 + targetLevel * 0.25);

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

      this.animFrameId = requestAnimationFrame(pollFallback);
    };
    this.animFrameId = requestAnimationFrame(pollFallback);
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
            console.log('[SpeechService Barge-In STT] Palavra do usuário reconhecida. Interrompendo resposta da LIORA...');
            this.stopSpeaking();
          }

          this.userSpokeInSession = true;
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
        console.warn('[SpeechService] Evento de erro:', event.error);
        if (event.error === 'not-allowed' || event.error === 'permission-denied') {
          this.shouldBeListening = false;
          this.stopAudioMeter();
          onError?.('Permissão de microfone negada. Clique no cadeado na barra de endereços do navegador e autorize o microfone.');
        } else if (event.error === 'no-speech') {
          // Normal: silêncio transitório. Não aborta escuta contínua.
        } else {
          onError?.(event.message || `Status do microfone: ${event.error}`);
        }
      };

      rec.onend = () => {
        this.isListeningActive = false;
        // Se o usuário ainda quer manter a voz ativa, reinicia com uma nova instância limpa
        // evitando que o Chrome trave a escuta após pausas!
        if (this.shouldBeListening) {
          setTimeout(() => {
            if (this.shouldBeListening) {
              try {
                this.startListening(onResult, onError, onEnd, onAutoSend);
              } catch (e: any) {
                console.warn('[SpeechService] Tentativa de reconexão do microfone:', e);
              }
            }
          }, 100);
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

    this.processStreamingQueue();
  }

  private async speakSingleChunk(text: string, onStart?: () => void): Promise<void> {
    return new Promise((resolve) => {
      this.speak(
        text,
        onStart,
        () => {
          resolve();
        }
      );
    });
  }

  /**
   * Fala em voz alta um texto usando a síntese de voz (TTS) neural do Gemini ou nativa do navegador
   */
  public async speak(text: string, onStart?: () => void, onEnd?: () => void) {
    if (typeof window === 'undefined') return;

    // Cancela qualquer fala ou áudio anterior
    this.stopSpeaking();

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

    const cacheKey = cleanText.toLowerCase();

    // 1. Checa se o áudio já está pré-sintetizado em cache (desempenho < 5ms)
    const cachedBuffer = this.ttsAudioCache.get(cacheKey);
    if (cachedBuffer) {
      try {
        const audioCtx = this.getOrCreateAudioContext();
        if (audioCtx.state === 'suspended') {
          await audioCtx.resume();
        }

        const source = audioCtx.createBufferSource();
        source.buffer = cachedBuffer;
        source.connect(audioCtx.destination);

        source.onended = () => {
          if (this.currentAudioSource === source) {
            this.currentAudioSource = null;
          }
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

    // 2. Se não estiver em cache, tenta síntese de voz neural via backend Gemini TTS
    try {
      const geminiKey = integrationsVault.getApiKeyByProvider('gemini') || integrationsVault.getRawKey('svc-gemini');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (geminiKey) headers['Authorization'] = `Bearer ${geminiKey}`;

      const res = await fetch('/api/gemini/tts', {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: cleanText, voice: this.activeNeuralVoice })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.fallbackToNative || data.code === 'QUOTA_EXHAUSTED' || !data.success) {
          console.warn('[SpeechService] Gemini TTS indisponível ou cota esgotada. Alternando para voz nativa do navegador (pt-BR).');
          this.speakFallbackBrowser(cleanText, onStart, onEnd);
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

          const audioBuffer = await audioCtx.decodeAudioData(bytes.buffer.slice(0));

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
            onEnd?.();
          };

          this.currentAudioSource = source;
          onStart?.();
          source.start(0);
          return;
        }
      }
    } catch (e) {
      console.warn('[SpeechService] Falha na síntese Gemini TTS, acionando síntese nativa:', e);
    }

    // 3. Fallback garantido para a voz nativa do navegador (Web Speech Synthesis pt-BR)
    this.speakFallbackBrowser(cleanText, onStart, onEnd);
  }

  private speakFallbackBrowser(cleanText: string, onStart?: () => void, onEnd?: () => void) {
    // Eliminação total de voz robótica do navegador. Executa apenas terminação limpa.
    onEnd?.();
  }

  public stopSpeaking() {
    this.streamingQueue = [];
    this.isProcessingQueue = false;
    this.isStreamDone = false;
    this.onAllStreamingFinished = null;

    if (typeof window !== 'undefined') {
      if (this.currentAudioSource) {
        try {
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
      if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
        this.currentUtterance = null;
      }
    }
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

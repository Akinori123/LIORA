/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — Serviço de Visão Computacional, Rastreamento de Mão e Inspeção de Objetos
 * Rastreia a mão e objetos do usuário via webcam em tempo real com alta fluidez,
 * sem travamentos ("cortando ligação"), com suporte a inversão de eixo e análise multimodal.
 */

import { analyzeFrame, computeForegroundThreshold, isSkinPixel } from './gestureVision';

export type GestureType = 'fist_click' | 'wave_left' | 'wave_right' | 'wave_up' | 'wave_down' | 'push' | 'steady' | 'none';
export type GestureSensitivityLevel = 'low' | 'medium' | 'high' | 'ultra';
export type TrackedTargetType = 'hand' | 'object' | 'none';

export interface GestureBoundingBox {
  minX: number; // 0..1
  maxX: number; // 0..1
  minY: number; // 0..1
  maxY: number; // 0..1
  width: number; // 0..1
  height: number; // 0..1
}

export interface GestureState {
  isActive: boolean;
  hasCamera: boolean;
  handDetected: boolean;
  handX: number; // 0.0 a 1.0 normalizado
  handY: number; // 0.0 a 1.0 normalizado
  targetType: TrackedTargetType;
  activeGesture: GestureType;
  lastGestureTime: number;
  sensitivity: GestureSensitivityLevel;
  invertX: boolean;
  /** O cursor está espelhado? (invertX combinado com o espelho da própria imagem) */
  cursorMirrored?: boolean;
  error?: string | null;
  /** Tentativa de inicialização em andamento (feedback imediato no badge). */
  isStarting?: boolean;
  /** Retângulo delimitador suavizado do alvo detectado na câmera */
  boundingBox?: GestureBoundingBox | null;
}

export type GestureListener = (state: GestureState) => void;

/** Chave de persistência da câmera escolhida (celular/USB sobrevive ao restart). */
export const PREFERRED_CAMERA_STORAGE_KEY = 'liora_preferred_camera_v1';

/** Quantos quadros compõem a mediana inicial do fundo (~1s a 100ms por amostra). */
export const BG_CALIBRATION_FRAMES = 9;

/**
 * Constraints da webcam para RASTREAMENTO (não para vídeo bonito).
 * A raiz de "a mão não é vista / o retângulo não acompanha": a câmera entregava
 * 1280x720. O canvas do laço tem 160x120, então o `drawImage` fazia downscale de
 * 8x em 8 px na GPU (média de vizinhos). Uma mão a 60 cm ocupava ~8 pixels e os
 * tons de pele ficavam todos cinzas — a segmentação via 0 alvo ou um ponto que
 * pulava. Com reamostragem em degraus (1280 -> 640 -> 320 -> 160), cada pixel do
 * canvas é a média de um bloco alinhado e o centróide fica estável.
 * `aspectRatio` evita letterbox (faixas pretas) quando o dispositivo só oferece
 * 16:9.
 */
export const GESTURE_VIDEO_TRACK_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 640 },
  height: { ideal: 480 },
  aspectRatio: { ideal: 4 / 3 },
  frameRate: { ideal: 30, max: 30 }
};

function loadPreferredCamera(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(PREFERRED_CAMERA_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

class GestureService {
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private stream: MediaStream | null = null;
  private animFrameId: number | null = null;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private hiddenResumeTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<GestureListener>();

  // Modelo de plano de fundo adaptativo (Float32Array [r, g, b, ...])
  private bgModel: Float32Array | null = null;
  private bgInitFrames = 0;
  private backgroundFrozen = false;
  // Janela de calibração: quadros coletados para a mediana inicial do fundo
  private bgCalibSamples: Float32Array[] = [];
  private bgLastSampleAt = 0;
  // Último instante em que um alvo válido foi visto (evita recalibrar o fundo em cima da mão)
  private bgLastTargetSeenAt = 0;

  private sensitivity: GestureSensitivityLevel = 'high';
  private invertX = true; // Modo espelho padrão (webcam): mover a mão para a direita move o cursor para a direita, igual à prévia espelhada
  // Câmera escolhida pelo usuário (ex: celular via DroidCam/Iriun) — persistida
  private preferredDeviceId: string | null = loadPreferredCamera();
  private isRunning = false;
  private handDetected = false;
  private targetType: TrackedTargetType = 'none';

  // Histerese temporal para eliminar oscilação (flickering da detecção)
  private detectedStreak = 0;
  private missingStreak = 0;
  private smoothedBox: GestureBoundingBox | null = null;

  // Desacoplamento arquitetural: Câmera ativa x Controle de cursor por gestos
  public isCursorControlEnabled = false;
  // Espelho aplicado pela PRÓPRIA imagem (selfieMode do driver / webcam frontal).
  // Usado para não inverter o X duas vezes (cursor ia ao contrário da mão).
  private cameraMirrored: boolean | null = null;
  private videoHasSelfieMode = false;
  // Rastreamento de objetos físicos (além da mão), configurado pela UI
  private objectTrackingEnabled = true;

  private handX = 0.5;
  private handY = 0.45;
  private prevHandX = 0.5;
  private prevHandY = 0.45;

  private activeGesture: GestureType = 'none';
  private lastGestureTime = 0;
  private lastClickTime = 0;
  // Posição de repouso da mão: centro exato da zona mapeada (ver deadzone/Y).
  private readonly restHandX = 0.5;
  private readonly restHandY = 0.45;
  // Se o cursor virtual estiver OCULTO (feedback visual desligado ou Home
  // minimizada), um clique de mão não pode "clicar às cegas" no elemento que
  // estiver sob o ponto — antes isso acionava botões invisíveis ao usuário.
  public pointerVisible = false;
  private lastHandSeenTime = 0;
  private wasHandOpen = false;
  private currentError: string | null = null;

  // Multiplicadores de sensibilidade calibrados: controlam o GANHO do mapeamento
  // mão -> tela (zona útil da câmera). Antes este dicionário não era lido em
  // nenhum lugar — o seletor de sensibilidade não mudava NADA no movimento.
  private sensitivityMultipliers: Record<GestureSensitivityLevel, number> = {
    low: 0.80,
    medium: 1.0,
    high: 1.25,
    ultra: 1.55
  };

  public setSensitivity(level: GestureSensitivityLevel) {
    this.sensitivity = level;
    this.notifyListeners();
  }

  public getSensitivity(): GestureSensitivityLevel {
    return this.sensitivity;
  }

  public setInvertX(invert: boolean) {
    this.invertX = invert;
    this.notifyListeners();
  }

  public getInvertX(): boolean {
    return this.invertX;
  }

  public toggleInvertX() {
    this.invertX = !this.invertX;
    this.notifyListeners();
  }

  /**
   * Recalibra o modelo de fundo da sala imediatamente
   */
  public recalibrateBackground() {
    this.bgModel = null;
    this.bgInitFrames = 0;
    this.bgCalibSamples = [];
    this.bgLastSampleAt = 0;
  }

  /**
   * Congela a adaptação do fundo (durante a calibração com a mão no quadro).
   * Sem isso, a mão parada no enquadramento é absorvida pelo modelo adaptativo
   * em poucos segundos e deixa de ser detectada.
   */
  public setBackgroundFreeze(frozen: boolean) {
    this.backgroundFrozen = frozen;
  }

  public isBackgroundFrozen(): boolean {
    return this.backgroundFrozen;
  }

  /**
   * Captura um snapshot em alta resolução da webcam atual em formato Base64 JPEG.
   * Utilizado para Visão Computacional Multimodal (identificação de objetos, leitura de texto, inspeção de itens).
   */
  public captureSnapshotBase64(quality = 0.88): string | null {
    if (!this.video || this.video.readyState < 2) return null;
    try {
      const snapCanvas = document.createElement('canvas');
      snapCanvas.width = this.video.videoWidth || 640;
      snapCanvas.height = this.video.videoHeight || 480;
      const snapCtx = snapCanvas.getContext('2d');
      if (!snapCtx) return null;
      snapCtx.drawImage(this.video, 0, 0, snapCanvas.width, snapCanvas.height);
      const dataUrl = snapCanvas.toDataURL('image/jpeg', quality);
      const parts = dataUrl.split(',');
      return parts[1] || dataUrl;
    } catch (err) {
      console.warn('[GestureService] Erro ao capturar snapshot da câmera:', err);
      return null;
    }
  }

  public async hasPhysicalCamera(): Promise<boolean> {
    if (typeof window === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return false;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.some(d => d.kind === 'videoinput');
    } catch {
      return false;
    }
  }

  public triggerGesture(gesture: GestureType) {
    this._doTriggerGesture(gesture);
  }

  public setCursorControlEnabled(enabled: boolean) {
    this.isCursorControlEnabled = enabled;
    if (enabled) {
      // Cursor ligado: o ponteiro precisa começar de onde ele está agora, senão
      // a primeira amostra da mão salta do centro da tela para a posição real.
      this.prevHandX = this.handX;
      this.prevHandY = this.handY;
    } else {
      this.wasHandOpen = false;
      this.activeGesture = 'none';
      this.handX = this.restHandX;
      this.handY = this.restHandY;
    }
    this.notifyListeners();
  }

  /**
   * Habilita/desabilita o rastreamento de OBJETOS (não-mão). Antes o toggle
   * "Rastreamento de Objetos & Documentos" existia na UI e nas settings, mas
   * nenhum código o lia — um documento na frente da câmera virava "📦 Objeto"
   * e desligar o switch não mudava nada.
   */
  public setObjectTrackingEnabled(enabled: boolean) {
    this.objectTrackingEnabled = enabled;
    if (!enabled) {
      this.targetType = this.targetType === 'object' ? 'none' : this.targetType;
    }
    this.notifyListeners();
  }

  public isObjectTrackingEnabled(): boolean {
    return this.objectTrackingEnabled;
  }

  public getCursorControlEnabled(): boolean {
    return this.isCursorControlEnabled;
  }

  public getState(): GestureState {
    return {
      isActive: this.isRunning,
      hasCamera: Boolean(this.stream && this.stream.active),
      handDetected: this.handDetected,
      handX: this.handX,
      handY: this.handY,
      targetType: this.targetType,
      activeGesture: this.activeGesture,
      lastGestureTime: this.lastGestureTime,
      sensitivity: this.sensitivity,
      invertX: this.invertX,
      cursorMirrored: this.isCursorMirrored(),
      // Se está rodando, NÃO existe erro a exibir: um `lastStartError` antigo
      // (de uma tentativa anterior que falhou) fazia o badge ficar eternamente
      // em "⚠ Abrindo câmera..." mesmo com a câmera já funcionando.
      error: this.isRunning ? null : (this.currentError || (this.isStarting ? null : this.lastStartError)),
      isStarting: this.isStarting && !this.isRunning,
      boundingBox: this.smoothedBox
    };
  }

  public subscribe(listener: GestureListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  private notifyListeners() {
    const state = this.getState();
    this.listeners.forEach((l) => l(state));
  }

  /**
   * Câmera preferida (ex: câmera do celular virtualizada como "DroidCam").
   * Descoberta a raiz: o serviço sempre pedia a câmera PADRÃO do Windows, então
   * quem usava o celular como webcam continuava capturando a webcam do notebook.
   * `autoRestart` evita loop: `requestVideoStream` já cai para a câmera padrão
   * quando o device preferido sumiu (ex: celular desconectou).
   */
  public setPreferredDevice(deviceId: string | null, options: { autoRestart?: boolean } = {}) {
    this.preferredDeviceId = deviceId;
    if (typeof localStorage !== 'undefined') {
      try {
        if (deviceId) localStorage.setItem(PREFERRED_CAMERA_STORAGE_KEY, deviceId);
        else localStorage.removeItem(PREFERRED_CAMERA_STORAGE_KEY);
      } catch {}
    }
    if (options.autoRestart !== false && this.isRunning) {
      // Troca em quente: derruba a stream e reabre. Guarda quem estava rodando
      // o loop (HUD/previa montados) e religa no dispositivo novo — antes o
      // serviço parava e nada chamava start() de novo até outro efeito rodar.
      const wasRunning = this.isRunning;
      this.stop();
      if (wasRunning) {
        void this.start().then((ok) => {
          if (!ok) this.notifyListeners();
        });
      }
    }
  }

  /** Força uma passada de análise agora (diagnóstico/teclas de teste). */
  public tick(): void {
    if (this.isRunning) this.processLoop();
  }

  /**
   * Reinicia a captura preservando a preferência de câmera (usado pelo botão
   * "▶ Tentar" e ao trocar de device). Antes o botão só chamava `start()`, que
   * retornava `true` imediatamente quando `isRunning` continuava true após uma
   * falha parcial — clicar em "Tentar" não fazia nada visível.
   */
  // Ãšltimo erro REAL de inicialização (sobrevive ao stop() que limpa currentError)
  private lastStartError: string | null = null;
  // Estado de tentativa em andamento (mostra feedback no badge)
  private isStarting = false;

  public async restart(): Promise<boolean> {
    this.isRunning = false;
    this.currentError = null;
    this.stop();
    return this.start();
  }

  /** Exibe feedback imediato no badge antes de qualquer await (webkit demora). */
  public notifyAttempt(): void {
    this.isStarting = true;
    this.currentError = null;
    this.notifyListeners();
  }

  public getPreferredDevice(): string | null {
    return this.preferredDeviceId;
  }

  /**
   * Anexa o vídeo ao vivo da câmera a um elemento (pré-visualização).
   * Motivo: sem ver o enquadramento, o usuário não sabe se a mão está no campo,
   * nem se a imagem está escura/tremida — era a razão de "coloco a mão e não
   * reconhece". O elemento `<video>` do serviço é reutilizado (nenhuma segunda
   * stream é aberta).
   */
  public attachPreview(target: HTMLVideoElement | null): void {
    if (!target) return;
    if (this.video) {
      target.srcObject = this.video.srcObject;
      target.muted = true;
      target.autoplay = true;
      target.playsInline = true;
      void target.play().catch(() => {});
    }
  }

  /** Última leitura do loop (diagnóstico): ajuda a entender "não detecta". */
  private lastAnalysis = {
    fgPixels: 0,
    skinRatio: 0,
    boxW: 0,
    boxH: 0,
    boxArea: 0,
    minY: 0,
    isValidTarget: false,
    threshold: 0,
    readyState: 0,
    canvasCorner: [0, 0, 0],
    canvasCenter: [0, 0, 0],
    bgCorner: [0, 0, 0],
    bgCenter: [0, 0, 0],
    calibFrames: 0,
    frozen: false
  };

  public getLastAnalysis() {
    return { ...this.lastAnalysis };
  }

  /** Diagnóstico em tempo real para a UI (ajuda a entender "não detecta"). */
  public getDiagnostics(): {
    isActive: boolean;
    hasStream: boolean;
    videoReadyState: number;
    videoWidth: number;
    videoHeight: number;
    handDetected: boolean;
    lastSeenMsAgo: number;
    error: string | null;
  } {
    return {
      isActive: this.isRunning,
      hasStream: Boolean(this.stream && this.stream.active),
      videoReadyState: this.video?.readyState ?? 0,
      videoWidth: this.video?.videoWidth ?? 0,
      videoHeight: this.video?.videoHeight ?? 0,
      handDetected: this.handDetected,
      lastSeenMsAgo: this.lastHandSeenTime ? Date.now() - this.lastHandSeenTime : -1,
      error: this.currentError || this.lastStartError
    };
  }

  /** Lista as câmeras disponíveis (internas, USB e celular virtual). */
  public async listCameras(): Promise<Array<{ deviceId: string; label: string; isLikelyPhone: boolean }>> {
    if (typeof window === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter(d => d.kind === 'videoinput')
        .map((d, idx) => ({
          deviceId: d.deviceId,
          label: d.label || `Câmera ${idx + 1}`,
          isLikelyPhone: /droidcam|iriun|camo|phone|android|iphone|mobile|virtual/i.test(d.label || '')
        }));
    } catch {
      return [];
    }
  }

  /**
   * Abre a stream de vídeo com fallback em cascata: dispositivo preferido —
   * qualquer câmera com constraints suaves — apenas `video: true`. Câmeras de
   * celular por Wi-Fi (DroidCam/Iriun) costumam rejeitar 320x240@30 e só
   * aceitam constraints genéricas.
   */
  private async requestVideoStream(): Promise<MediaStream> {
    // CRÍTICO (espelho): a câmera FRONTAL do Windows entrega a imagem JÁ espelhada
    // em muitas webcams (driver aplica o mirror). O canvas do laço recebe essa
    // imagem espelhada. Se o serviço também aplicasse `invertX` no x, o cursor
    // andava ao CONTRÁRIO da tela (sintoma "movo a mão para a direita e o cursor
    // vai para a esquerda"). Por isso:
    //   - `mirrored` vem do WHICH camera abriu: `selfieMode` quando o dispositivo
    //     suportar; senão, câmera "frontal" (webcam embutida) é tratada como já
    //     espelhada pelo driver e câmeras externas/celular NÃO.
    //   - o canvas passa a desenhar SEM espelho e o espelho visual da prévia é
    //     resolvido por CSS a partir de `mirrored`/`invertX` (ver getState).
    this.cameraMirrored = null;
    this.videoHasSelfieMode = false;

    const base = GESTURE_VIDEO_TRACK_CONSTRAINTS;
    const candidates: MediaStreamConstraints[] = [];
    // Preferência SALVA desta sessão/anterior (câmera escolhida em Configurações).
    // `deviceId: exact` NUNCA combinado com resolução: webcam barata do Windows
    // rejeita a combinação com OverconstrainedError e o serviço caía para a
    // PRIMEIRA câmera do sistema — o usuário escolhia o celular (DroidCam) e
    // recebia a webcam do notebook. Só o id exato na primeira tentativa.
    if (this.preferredDeviceId) {
      candidates.push({ video: { deviceId: { exact: this.preferredDeviceId } }, audio: false });
      candidates.push({ video: { ...base, deviceId: { exact: this.preferredDeviceId } }, audio: false });
    }
    candidates.push({ video: base, audio: false });
    candidates.push({ video: true, audio: false });

    let lastError: any = null;
    for (const constraints of candidates) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (stream && stream.getVideoTracks().length > 0) {
          await this.applySelfieModeIfSupported(stream);
          return stream;
        }
        stream?.getTracks().forEach(t => t.stop());
      } catch (err: any) {
        lastError = err;
        // Permissão negada não melhora ao trocar de constraint: aborta já.
        if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') break;
      }
    }
    throw lastError || new Error('Nenhum fluxo de vídeo pôde ser obtido.');
  }

  /**
   * Tenta habilitar `selfieMode` (espelho no DRIVER) na track ativa.
   * Quando existe, a imagem que chega no canvas JÁ está espelhada e o serviço
   * NÃO deve inverter o X por conta própria — senão o cursor vai ao contrário
   * da tela. `selfieMode` é experimental (getCapabilities) e falha em silêncio
   * quando o driver não suporta.
   */
  private async applySelfieModeIfSupported(stream: MediaStream): Promise<void> {
    const track = stream.getVideoTracks()[0] as any;
    if (!track) return;
    try {
      const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : null;
      if (caps && Array.isArray(caps.selfieMode) && caps.selfieMode.length > 0) {
        await track.applyConstraints({ advanced: [{ selfieMode: true }] } as any);
        this.videoHasSelfieMode = true;
        this.cameraMirrored = true;
      }
    } catch {
      // Driver não suporta selfieMode: segue a heurística de câmera frontal.
    }
  }

  /**
   * A imagem do canvas já vem espelhada pelo driver/selfieMode nesta câmera?
   * Usado para decidir se o X precisa ser invertido (e se a prévia deve ser
   * espelhada por CSS) — sem isso, `invertX` e espelho do driver se cancelavam
   * e o cursor ia para o lado oposto da mão.
   */
  private isCameraImageMirrored(): boolean {
    if (this.videoHasSelfieMode) return true;
    try {
      const track = this.stream?.getVideoTracks()[0];
      const label = (track?.label || '').toLowerCase();
      if (!label) return true; // webcam embutida típica no Windows
      if (/droidcam|iriun|camo|phone|android|iphone|mobile|usb|virtual|obs/.test(label)) return false;
      if (/front|frontal|user|integrated|built-?in|facetime/.test(label)) return true;
      return /webcam|hd|fhd|u?v[cC]/.test(label) ? true : false;
    } catch {
      return true;
    }
  }

  /**
   * Espelho EFETIVO do cursor: `invertX` do usuário trocado pelo espelho já
   * aplicado na imagem. Exposto para a prévia desenhar o mesmo lado que o cursor.
   */
  public isCursorMirrored(): boolean {
    return Boolean(this.invertX) !== this.isCameraImageMirrored();
  }

  private waitForVideoReady(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.removeEventListener('loadeddata', done);
        video.removeEventListener('canplay', done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      video.addEventListener('loadeddata', done, { once: true });
      video.addEventListener('canplay', done, { once: true });
      if (video.readyState >= 2) done();
    });
  }

  private describeCameraError(err: any): string {
    const name = err?.name || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Permissão de câmera negada. Libere a câmera nas configurações do Windows (Privacidade > Câmera) e no WebView.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'Nenhuma câmera encontrada. Se for usar o celular, abra o app de webcam no celular e aguarde alguns segundos.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
      return 'A câmera está em uso por outro aplicativo (Teams, Zoom, câmera do Windows ou o próprio app do celular). Feche o outro app e tente novamente.';
    }
    if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
      return 'A câmera selecionada não suporta o formato pedido. Escolha outra câmera no badge de gestos.';
    }
    return `Status da câmera: ${err?.message || err}`;
  }

  /**
   * Inicia a captura da câmera e o loop de visão computacional contínua
   */
  public async start(): Promise<boolean> {
    if (this.isRunning) return true;
    if (this.isStarting) return false; // evita duplo clique abrindo 2 streams
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.lastStartError = 'Câmera não suportada neste ambiente.';
      this.currentError = this.lastStartError;
      this.notifyListeners();
      return false;
    }

    this.isStarting = true;
    this.lastStartError = null;
    this.notifyListeners();
    try {
      this.currentError = null;

      // Verificação prévia de dispositivos de vídeo
      if (navigator.mediaDevices.enumerateDevices) {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const hasVideoInput = devices.some(d => d.kind === 'videoinput');
          if (!hasVideoInput) {
            this.lastStartError = 'Nenhuma câmera física detectada no PC. Se for usar o celular como webcam, abra o app (DroidCam/Iriun/Camo) e aguarde a câmera aparecer.';
            this.currentError = this.lastStartError;
            this.isRunning = false;
            this.isStarting = false;
            this.notifyListeners();
            return false;
          }
        } catch {}
      }

      this.stream = await this.requestVideoStream();

      // O <video> do serviço permanece DESTACADO no DOM (invisível) — isso é
      // intencional e funciona no Chrome. Mas há WebViews que não decodificam
      // frames de elementos fora do documento (canvas sai PRETO => 0 pixels de
      // primeiro plano => "SEM MÃO" com imagem visível na prévia). Manter o
      // elemento no DOM, oculto, garante decodificação em todos os ambientes.
      this.video = document.createElement('video');
      this.video.autoplay = true;
      this.video.playsInline = true;
      this.video.muted = true;
      this.video.setAttribute('aria-hidden', 'true');
      this.video.style.position = 'fixed';
      this.video.style.width = '1px';
      this.video.style.height = '1px';
      this.video.style.opacity = '0';
      this.video.style.pointerEvents = 'none';
      this.video.style.left = '-10px';
      this.video.style.top = '-10px';
      this.video.dataset.lioraGestureVideo = 'true';
      this.video.srcObject = this.stream;
      document.body.appendChild(this.video);
      // Câmera de celular (DroidCam/Iriun via Wi-Fi) demora a entregar o
      // primeiro frame; esperar o evento `loadedmetadata` com timeout evita o
      // play() preso e o loop rodando com videoWidth = 0.
      await this.waitForVideoReady(this.video, 4000);
      try {
        await this.video.play();
      } catch (playErr) {
        // Autoplay pode falhar sem gesto do usuário em WebView2 — `muted` já
        // está true, então tentamos uma vez mais e seguimos se houver frame.
        if (this.video.readyState < 2) throw playErr;
      }

      this.canvas = document.createElement('canvas');
      this.canvas.width = 160; // Resolução otimizada para acurácia espacial suave
      this.canvas.height = 120;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

      this.bgModel = null;
      this.bgInitFrames = 0;
      this.isRunning = true;
      this.isStarting = false;
      this.handDetected = false;
      this.targetType = 'none';

      this.processLoop();
      this.notifyListeners();
      return true;
    } catch (err: any) {
      // CORRE——fO ("Tentar" sem resposta): o stop() limpava `currentError` logo
      // em seguida, então o erro real nunca aparecia e o badge voltava a dizer
      // apenas "Câmera Inativa". Agora o erro é preservado em `lastStartError`.
      this.lastStartError = this.describeCameraError(err);
      this.currentError = this.lastStartError;
      this.stop();
      this.notifyListeners();
      return false;
    } finally {
      // INVARIANTE: `isStarting` nunca sobrevive a start(). Sem isso, um caminho
      // de saída antecipado deixava o badge eternamente em "⏳ Abrindo câmera...".
      this.isStarting = false;
      this.notifyListeners();
    }
  }

  /**
   * Para a câmera e limpa todos os recursos
   */
  public stop() {
    this.isRunning = false;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    if (this.hiddenResumeTimer) {
      clearTimeout(this.hiddenResumeTimer);
      this.hiddenResumeTimer = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      // Remove o elemento oculto do DOM (evita acúmulo de <video> a cada restart)
      try { this.video.remove(); } catch {}
      this.video = null;
    }
    this.canvas = null;
    this.ctx = null;
    this.bgModel = null;
    this.handDetected = false;
    this.targetType = 'none';
    this.activeGesture = 'none';
    this.smoothedBox = null;
    this.detectedStreak = 0;
    this.missingStreak = 0;
    // Preserva o último ERRO real (não sobrescreve com null)
    this.currentError = null;
    this.notifyListeners();
  }

  /**
   * Loop principal de Visão Computacional:
   * Segmentação de Primeiro Plano Adaptativa + Rastreamento de Centróide Estável
   * Não depende apenas de movimento transitório (eliminando o sintoma de "cortando a ligação").
   */
  private processLoop = () => {
    if (!this.isRunning || !this.video || !this.ctx || !this.canvas) return;

    if (this.video.readyState >= 2) {
      const width = this.canvas.width;
      const height = this.canvas.height;

      // Desenha frame atual da câmera diretamente.
      // CORREÇÃO ("SEM MÃO" com imagem visível): se o elemento <video> estiver
      // PAUSADO (autoplay bloqueado pelo WebView2, aba oculta etc.), `drawImage`
      // grava um quadro PRETO e o algoritmo vê 0 pixels de primeiro plano — a
      // prévia na tela continua bonita (é outro <video>) e o rastreamento falha.
      // Retomar antes de desenhar garante imagem real em ambos.
      if (this.video.paused) {
        void this.video.play().catch(() => {});
      }
      this.ctx.drawImage(this.video, 0, 0, width, height);
      const frame = this.ctx.getImageData(0, 0, width, height);
      const data = frame.data;
      const totalPixels = width * height;

      // Diagnóstico: amostra do canto/centro do canvas usado pelo loop
      this.lastAnalysis = {
        ...this.lastAnalysis,
        canvasCorner: [data[0], data[1], data[2]],
        canvasCenter: [
          data[((height >> 1) * width + (width >> 1)) * 4],
          data[((height >> 1) * width + (width >> 1)) * 4 + 1],
          data[((height >> 1) * width + (width >> 1)) * 4 + 2]
        ]
      };

      // 1. Modelo de fundo (calibração)
      // RASTREAMENTO DE OBJETO ESTÁTICO que antes falhava:
      //  - o fundo era re-inicializado a cada `start()` COPIANDO O QUADRO ATUAL.
      //    Se a mão já estivesse na frente da câmera, o "fundo" virava a própria
      //    mão — e nada mais era detectado (fgPixels = 0, "SEM MÃO").
      //  - a adaptação lenta (`bg = bg*0.992 + pixel*0.008`) engolia a mão parada.
      // Correção: a calibração inicial usa a MEDIANA de 9 quadros coletados (~1s).
      // Numa janela com a mão se movendo/entrando, a mediana de cada pixel
      // representa o FUNDO (a mão ocupa cada pixel em poucos quadros), em vez de
      // copiar a mão para o modelo. Depois disso o fundo é congelado enquanto
      // houver alvo (freezeBackground) para não absorver a mão.
      if (!this.bgModel || this.bgModel.length !== data.length) {
        this.bgModel = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) {
          this.bgModel[i] = data[i];
        }
        this.bgCalibSamples = [new Float32Array(data)];
        this.bgInitFrames = 1;
        this.bgLastTargetSeenAt = 0;
      } else if (this.bgCalibSamples.length < BG_CALIBRATION_FRAMES) {
        // Coleta a janela de calibração (um quadro a cada ~100ms). ANTES isto só
        // colhia amostras aqui — e este mesmo laço congela o fundo enquanto
        // `handDetected` for true. Duas mãos na cena (ou a mão logo no início)
        // => calibração NUNCA avançava: o bgModel ficava congelado no primeiro
        // quadro PARA SEMPRE, e um cenário levemente diferente virava "objeto"
        // em 4/5 da tela. Agora a coleta também alimenta o modelo por acumulação
        // incremental (média amostrada) enquanto o quadro está congelado, sem
        // jamais perder amostras.
        const nowCal = Date.now();
        if (nowCal - this.bgLastSampleAt >= 100) {
          this.bgLastSampleAt = nowCal;
          this.bgCalibSamples.push(new Float32Array(data));
          const sampled = this.bgCalibSamples.length;
          this.bgInitFrames = sampled;
          // Média incremental apenas fora de alvo (com alvo, a amostra é
          // descartada para não aprender a mão).
          if (!this.handDetected && sampled > 1) {
            const alpha = 1 / sampled;
            for (let i = 0; i < data.length; i++) {
              this.bgModel[i] = this.bgModel[i] * (1 - alpha) + data[i] * alpha;
            }
          }
          if (sampled >= BG_CALIBRATION_FRAMES) {
            // Mediana por canal: descarta a mão (presente em minoria dos quadros)
            const frames = this.bgCalibSamples;
            const count = frames.length;
            const values = new Float32Array(count);
            for (let i = 0; i < data.length; i += 4) {
              for (let ch = 0; ch < 3; ch++) {
                for (let f = 0; f < count; f++) values[f] = frames[f][i + ch];
                const sorted = Array.prototype.slice.call(values).sort((a: number, b: number) => a - b);
                this.bgModel[i + ch] = sorted[Math.floor(count / 2)];
              }
              this.bgModel[i + 3] = 255;
            }
            this.bgInitFrames = BG_CALIBRATION_FRAMES;
            this.bgCalibSamples = [];
          }
        }
      }

      const analysis = analyzeFrame({
        data,
        background: this.bgModel,
        width,
        height,
        fgThreshold: computeForegroundThreshold(this.bgModel),
        // Trava o fundo enquanto a mão está no quadro: impede que ela seja
        // absorvida pelo modelo adaptativo (causa do "SEM MÃO" logo após calibração).
        freezeBackground: this.backgroundFrozen || this.handDetected
      });
      const { fgPixels, skinPixels, totalWeight, boxW, boxH, boxArea, isValidTarget, skinRatio } = analysis;
      // Diagnóstico: amostra do modelo de fundo nos MESMOS pontos do quadro
      this.lastAnalysis = {
        ...this.lastAnalysis,
        bgCorner: [this.bgModel[0], this.bgModel[1], this.bgModel[2]],
        bgCenter: [
          this.bgModel[((height >> 1) * width + (width >> 1)) * 4],
          this.bgModel[((height >> 1) * width + (width >> 1)) * 4 + 1],
          this.bgModel[((height >> 1) * width + (width >> 1)) * 4 + 2]
        ],
        calibFrames: this.bgInitFrames,
        frozen: this.backgroundFrozen || this.handDetected
      };
      this.lastAnalysis = {
        ...this.lastAnalysis,
        fgPixels,
        skinRatio: Number(skinRatio.toFixed(3)),
        boxW,
        boxH,
        boxArea: Number(boxArea.toFixed(3)),
        minY: analysis.minY,
        isValidTarget,
        threshold: Number(computeForegroundThreshold(this.bgModel).toFixed(1)),
        readyState: this.video?.readyState ?? 0
      };

      if (totalWeight > 0 && isValidTarget && !analysis.skinDetected && !this.objectTrackingEnabled && !this.handDetected) {
        // Alvo não-humano com o rastreamento de objetos DESLIGADO: nada a seguir.
        this.detectedStreak = 0;
        this.missingStreak++;
      } else if (totalWeight > 0 && isValidTarget) {
        this.detectedStreak++;
        this.missingStreak = 0;

        this.bgLastTargetSeenAt = Date.now();
        this.lastHandSeenTime = Date.now();
        this.handDetected = true;

        // Classificação: Mão Humana vs Objeto Físico Segurado
        this.targetType = skinRatio >= 0.18 ? 'hand' : 'object';

        // Normalização e suavização do bounding box (0..1).
        // BUG CORRIGIDO (retículo travado no canto inferior-direito): quando a
        // mão é reconhecida por COR e não pelo modelo de fundo, a análise cai no
        // fallback de pele — min/max/boxW/boxH valem 0 e o `Math.max(1, ...)` da
        // análise dava 1px. O box normalizado virava minX = maxX = ... = 1 →
        // sempre "94%,94%" na tela, não importa onde a mão estivesse.
        // A posição real está no centroide normalizado (handX/handY).
        const centroidIsFallbackBox =
          analysis.maxX - analysis.minX < 2 && analysis.maxY - analysis.minY < 2;
        const rawBoxMinX = centroidIsFallbackBox
          ? Math.max(0, analysis.handX - 0.12)
          : Math.max(0, analysis.minX / width);
        const rawBoxMaxX = centroidIsFallbackBox
          ? Math.min(1, analysis.handX + 0.12)
          : Math.min(1, analysis.maxX / width);
        const rawBoxMinY = centroidIsFallbackBox
          ? Math.max(0, analysis.handY - 0.12)
          : Math.max(0, analysis.minY / height);
        const rawBoxMaxY = centroidIsFallbackBox
          ? Math.min(1, analysis.handY + 0.12)
          : Math.min(1, analysis.maxY / height);

        if (!this.smoothedBox) {
          this.smoothedBox = {
            minX: rawBoxMinX,
            maxX: rawBoxMaxX,
            minY: rawBoxMinY,
            maxY: rawBoxMaxY,
            width: rawBoxMaxX - rawBoxMinX,
            height: rawBoxMaxY - rawBoxMinY
          };
        } else {
          // Suavização EMA (70% histórico + 30% novo) para as linhas não piscarem/tremerem
          this.smoothedBox = {
            minX: this.smoothedBox.minX * 0.70 + rawBoxMinX * 0.30,
            maxX: this.smoothedBox.maxX * 0.70 + rawBoxMaxX * 0.30,
            minY: this.smoothedBox.minY * 0.70 + rawBoxMinY * 0.30,
            maxY: this.smoothedBox.maxY * 0.70 + rawBoxMaxY * 0.30,
            width: (this.smoothedBox.maxX - this.smoothedBox.minX),
            height: (this.smoothedBox.maxY - this.smoothedBox.minY)
          };
        }

        const rawX = analysis.handX;
        const rawY = analysis.handY;

        // MAPEAMENTO MÃO -> TELA (zona útil com ganho de sensibilidade):
        // a webcam precisa ver só o CENTRO do quadro para cobrir a tela toda.
        // Sem isso o usuário tinha de mover a mão até a extremidade do
        // enquadramento para chegar à borda da tela (e saía do quadro antes).
        // O multiplicador vem do seletor de Sensibilidade (antes era ignorado).
        const gain = this.sensitivityMultipliers[this.sensitivity] ?? 1.0;
        const spanX = 1 / gain;
        const spanY = 1 / gain;
        const startX = (1 - spanX) / 2;
        const startY = (1 - spanY) / 2;
        const mapAxis = (value: number, start: number, span: number) =>
          Math.min(1, Math.max(0, (value - start) / span));
        const mappedX = mapAxis(rawX, startX, spanX);
        const mappedY = mapAxis(rawY, startY, spanY);

        // Espelho do cursor: `invertX` do usuário combinado com o espelho que a
        // PRÓPRIA imagem já traz (selfieMode / webcam frontal do Windows). Sem
        // isso os dois espelhos se cancelavam: mover a mão para a direita movia
        // o cursor para a esquerda — o sintoma clássico de "o ponteiro vai ao
        // contrário da mão".
        const targetX = this.isCursorMirrored() ? (1.0 - mappedX) : mappedX;
        const targetY = mappedY;

        // LERP ADAPTATIVO POR VELOCIDADE:
        // Movimentos rápidos -> lerp alto (0.58), zero latência ou travamento.
        // Movimentos finos/parados -> lerp suave (0.24), sem tremores.
        const dist = Math.hypot(targetX - this.handX, targetY - this.handY);
        const lerpFactor = Math.min(0.60, Math.max(0.24, dist * 3.0));

        this.prevHandX = this.handX;
        this.prevHandY = this.handY;
        this.handX = this.handX + (targetX - this.handX) * lerpFactor;
        this.handY = this.handY + (targetY - this.handY) * lerpFactor;

        // ANÁLISE DE GESTO E CLIQUES (SOMENTE SE O CURSOR POR GESTOS ESTIVER LIGADO)
        if (this.isCursorControlEnabled && this.targetType === 'hand') {
          // Densidade medida no CENTROIDE da mão, não no quadro inteiro.
          // Antes: fgPixels (contagem global, dentro do bounding box de pele que
          // cresce com o desvio padrão) podia passar de 1.0 — `isFist` ficava
          // sempre verdadeiro e `isOpenHand` nunca era reconhecido. Resultado:
          // clique disparava sem gesto, ou `wasHandOpen` nunca era setado e a
          // mão aberta nunca rolava. Agora conta só os pixels de alvo numa
          // janela 2 x box ao redor do centroide (aproximação estável).
          const density = this.measureCentroidDensity(data, width, height, analysis.handX, analysis.handY, boxW, boxH);
          const aspectRatio = boxW / boxH;

          const isFist = density >= 0.62 && density < 0.88 && aspectRatio >= 0.60 && aspectRatio <= 1.60;
          // Uma mão aberta passa de 55% de ocupação em média (dedos separados):
          // o limite antigo (52%) classificava mão aberta como nem-punho-nem-aberta,
          // desligando deliberadamente o clique com punho. Densidade acima de 88%
          // (janela toda preenchida) não é gesto válido.
          const isOpenHand = density >= 0 && density <= 0.55;

          if (isOpenHand) {
            this.wasHandOpen = true;
          }

          const now = Date.now();
          if (isFist && this.wasHandOpen && (now - this.lastClickTime > 1100)) {
            this.triggerFistClick();
            this.wasHandOpen = false;
            this.lastClickTime = now;
          } else if (isOpenHand) {
            // Rolagem suave — SOMENTE com a mão aberta. Antes, qualquer quadro
            // que não fosse punho (mão a 52%..62% de densidade, ruído, objeto)
            // rolava a tela: o punho fechado fazia a página pular ao clicar e um
            // balanço leve rolava tudo sem intenção.
            const dy = this.handY - this.prevHandY;
            const dx = this.handX - this.prevHandX;
            this.dispatchScrollAction(dx, dy);
          }
        }
      } else {
        this.missingStreak++;
        this.detectedStreak = 0;

        // Histerese temporal estável: Permanece ativo por 1.5s após a mão parar para evitar piscar
        const timeSinceSeen = Date.now() - this.lastHandSeenTime;
        if (timeSinceSeen < 1500 && this.missingStreak < 30) {
          // Mantém estado anterior estável
        } else {
          this.handDetected = false;
          this.targetType = 'none';
          this.wasHandOpen = false;
          this.smoothedBox = null;
          // MÃO FORA DO QUADRO = CURSOR EM REPOUSO. Antes o cursor ficava
          // congelado na última posição (inclusive colado na borda, onde a
          // mão saiu do enquadramento) e o usuário achava que havia travado ou
          // que "não acompanhava mais". Voltar ao centro devolve o controle.
          if (this.isCursorControlEnabled) {
            this.prevHandX = this.handX;
            this.prevHandY = this.handY;
            this.handX += (this.restHandX - this.handX) * 0.25;
            this.handY += (this.restHandY - this.handY) * 0.25;
            if (Math.abs(this.handX - this.restHandX) < 0.002) this.handX = this.restHandX;
            if (Math.abs(this.handY - this.restHandY) < 0.002) this.handY = this.restHandY;
          }
        }
      }

      this.notifyListeners();
    } else {
      // O vídeo ainda não entregou o primeiro frame. Sem isso o loop PARAVA aqui
      // para sempre (o agendamento ficava depois do `if (readyState >= 2)`) e o
      // badge ficava eternamente em "Aguardando Alvo" / "não rastreável".
      this.notifyListeners();
    }

    // Painel PRETO = loop vivo: com a janela minimizada o requestAnimationFrame
    // pausa (WebView2) e o vídeo congela; ao voltar, o loop precisa continuar.
    // Usa setTimeout fora da aba oculta para não morrer junto com o rAF.
    // (A captura de snapshot continua garantida por `start()`.)
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    if (typeof document !== 'undefined' && document.hidden) {
      this.hiddenResumeTimer = setTimeout(() => {
        this.hiddenResumeTimer = null;
        if (this.isRunning && document.visibilityState === 'visible') {
          this.scheduleNextFrame();
        }
      }, 250);
    } else {
      this.scheduleNextFrame();
    }
  };

  /**
   * Densidade de ALVO (primeiro plano ou pele) numa janela 2 x box ao redor do
   * centroide da mão. Usada para distinguir punho fechado (denso) de mão aberta
   * (dedos separados, menos densa).
   *
   * Antes o `fgPixels` GLOBAL era dividido pela área do box de pele — que inclui
   * quaisquer outros objetos em movimento no quadro — e podia passar de 1.0:
   * `isFist` virava sempre verdadeiro e o clique disparava sozinho. Retorna -1
   * quando não há dados suficientes (o chamador trata como "indeterminado").
   */
  private measureCentroidDensity(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    normalizedX: number,
    normalizedY: number,
    boxW: number,
    boxH: number
  ): number {
    const cx = Math.round(normalizedX * width);
    const cy = Math.round(normalizedY * height);
    // Janela quadrada ao redor do centro; mínimo de 12px para mão longe/pequena.
    const half = Math.max(6, Math.round(Math.max(boxW, boxH) / 2));
    const minX = Math.max(0, cx - half);
    const maxX = Math.min(width - 1, cx + half);
    const minY = Math.max(0, cy - half);
    const maxY = Math.min(height - 1, cy + half);
    if (maxX - minX < 2 || maxY - minY < 2) return -1;
    const bg = this.bgModel;
    let filled = 0;
    let total = 0;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const i = (y * width + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        total++;
        if (isSkinPixel(r, g, b)) {
          filled++;
          continue;
        }
        if (bg) {
          const diff =
            (Math.abs(r - bg[i]) + Math.abs(g - bg[i + 1]) + Math.abs(b - bg[i + 2])) / 3;
          if (diff > 12) filled++;
        }
      }
    }
    return total > 0 ? filled / total : -1;
  }

  /**
   * Agenda o próximo frame.
   * Throttlado a ~15fps (66ms mínimo por frame): o processLoop é CPU-intensivo
   * (getImageData + loop de pixels) e a 60fps gerava violações de rAF.
   * Mantém o fallback via setTimeout para o WebView2 com janela oculta/foco perdido.
   */
  private _lastFrameAt = 0;
  private scheduleNextFrame() {
    if (!this.isRunning) return;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    const TARGET_FPS_MS = 33; // ~30fps: mais amostras => menos jitter no ponteiro (o downscale 640->160 é barato)
    let frameFired = false;
    this.animFrameId = requestAnimationFrame((ts) => {
      frameFired = true;
      this.animFrameId = null;
      const elapsed = this._lastFrameAt ? ts - this._lastFrameAt : TARGET_FPS_MS;
      if (elapsed < TARGET_FPS_MS) {
        // Ainda cedo demais: agenda o próximo frame sem processar
        this.scheduleNextFrame();
        return;
      }
      // Marca o INSTANTE DO PROCESSAMENTO (não o timestamp do rAF): se o
      // `processLoop` foi chamado pelo timer de fallback, o próximo rAF poderia
      // ficar com `elapsed = 0` e re-agendar em loop sem nunca processar.
      this._lastFrameAt = performance.now();
      this.processLoop();
    });
    this.loopTimer = setTimeout(() => {
      this.loopTimer = null;
      if (!frameFired && this.isRunning) {
        if (this.animFrameId) {
          cancelAnimationFrame(this.animFrameId);
          this.animFrameId = null;
        }
        this.processLoop();
      }
    }, 100);
  }

  /**
   * Dispara o clique virtual onde o cursor está posicionado ao fechar o punho
   */
  private triggerFistClick() {
    if (typeof window === 'undefined') return;
    this.activeGesture = 'fist_click';
    this.lastGestureTime = Date.now();
    this.notifyListeners();

    if (!this.pointerVisible) {
      console.info('[GestureService] Clique de mão ignorado: cursor virtual oculto.');
    } else try {
      // Coordenada do clique = MESMA origem do cursor virtual do HUD
      // (`--liora-sidebar-width`). Antes, com a sidebar de 80px, o punho clicava
      // 80px à direita do que o usuário via na tela.
      const sidebarWidth = (() => {
        try {
          const raw = getComputedStyle(document.documentElement).getPropertyValue('--liora-sidebar-width');
          const parsed = parseFloat(raw);
          return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
        } catch {
          return 0;
        }
      })();
      const usableWidth = Math.max(1, window.innerWidth - sidebarWidth);
      const clientX = Math.round(sidebarWidth + this.handX * usableWidth);
      const clientY = Math.round(this.handY * window.innerHeight);

      // Sobreposições do HUD (o próprio cursor virtual e o badge) são
      // `pointer-events-none`, então não interceptam.
      const el = document.elementFromPoint(clientX, clientY);
      if (el) {
        const clickable = (el.closest('button, a, input, select, textarea, [role="button"], [tabindex]') || el) as HTMLElement;
        if (typeof clickable.click === 'function') {
          clickable.click();
        } else {
          clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX, clientY }));
        }
      }
    } catch (err) {
      console.debug('[GestureService] Erro ao disparar clique virtual:', err);
    }

    setTimeout(() => {
      if (this.activeGesture === 'fist_click') {
        this.activeGesture = 'none';
        this.notifyListeners();
      }
    }, 700);
  }

  /**
   * Rolagem vertical suave e amortecida
   */
  private dispatchScrollAction(dx: number, dy: number) {
    const mult = this.sensitivityMultipliers[this.sensitivity] || 1.25;

    if (Math.abs(dy) > 0.07 && Math.abs(dy) > Math.abs(dx) * 1.8) {
      const scrollSpeed = Math.sign(dy) * Math.min(Math.abs(dy) * 110 * mult, 24);
      this.scrollActiveContainer(scrollSpeed);
      this.activeGesture = dy > 0 ? 'wave_down' : 'wave_up';
      this.lastGestureTime = Date.now();
      this.notifyListeners();
    } else if (this.activeGesture === 'wave_down' || this.activeGesture === 'wave_up') {
      this.activeGesture = 'none';
    }
  }

  private _doTriggerGesture(gesture: GestureType) {
    this.activeGesture = gesture;
    this.lastGestureTime = Date.now();
    this.notifyListeners();

    setTimeout(() => {
      if (this.activeGesture === gesture) {
        this.activeGesture = 'none';
        this.notifyListeners();
      }
    }, 600);
  }

  /**
   * Rola o container scrollável ativo na tela
   */
  private scrollActiveContainer(amount: number) {
    if (typeof window === 'undefined') return;
    const scrollable = document.querySelector('[data-gesture-scroll]') ||
      document.querySelector('main') ||
      document.documentElement;

    if (scrollable) {
      scrollable.scrollBy({ top: amount, behavior: 'smooth' });
    }
  }
}

export const gestureService = new GestureService();

// Registro de diagnóstico: permite inspecionar o serviço pelo console do WebView
// (`window.__LIORA_GESTURE__.getDiagnostics()`), essencial para entender por que
// a câmera não abre / a mão não é vista em uma máquina específica.
// (Antes este bloco declarava `gestureService` uma SEGUNDA vez — `SyntaxError:
// Identifier 'gestureService' has already been declared` em runtime; esbuild
// tolera, mas o módulo real do navegador quebra e nada da câmera monta.)
//
// Correções desta auditoria:
//  - o primeiro `export const gestureService` NÃO tinha o registro: só existia
//    depois do wrapper `gestureServiceSafe` (mais abaixo). Agora sai na hora.
//  - no Node/backend `window` não existe; o registro vai também para
//    `globalThis` (antes o import dinâmico de diagnóstico lançava em silêncio).
//  - `defineProperty` não-enumerável: aparece no console sem poluir
//    `Object.keys(window)`.
for (const _diagTarget of [
  typeof window !== 'undefined' ? (window as any) : null,
  typeof globalThis !== 'undefined' ? (globalThis as any) : null
]) {
  if (!_diagTarget) continue;
  try {
    Object.defineProperty(_diagTarget, '__LIORA_GESTURE__', {
      value: gestureService,
      configurable: true,
      writable: true,
      enumerable: false
    });
  } catch {
    try { _diagTarget.__LIORA_GESTURE__ = gestureService; } catch { /* ambiente congelado */ }
  }
}

// NO-BREAK da cadeia circular `gestureService <-> lioraStore`.
// O app boota mesmo se o singleton de gestos quebrar em runtime (foi exatamente
// o que aconteceu com uma declaração duplicada em versão anterior: o módulo
// lançava SyntaxError e TODA a árvore React morria — “nada funciona”).
// Os helpers abaixo garantem que qualquer chamada degrada para no-op; e o
// store importa APENAS `gestureServiceSafe` (sem import estático de
// gestureService, que arrastaria o módulo inteiro para o bundle do store).
export const gestureServiceSafe: Pick<
  GestureService,
  | 'start'
  | 'stop'
  | 'restart'
  | 'getState'
  | 'getDiagnostics'
  | 'getLastAnalysis'
  | 'hasPhysicalCamera'
  | 'captureSnapshotBase64'
  | 'listCameras'
  | 'setPreferredDevice'
  | 'getPreferredDevice'
  | 'setCursorControlEnabled'
  | 'getCursorControlEnabled'
  | 'attachPreview'
  | 'notifyAttempt'
  | 'recalibrateBackground'
  | 'setBackgroundFreeze'
  | 'isObjectTrackingEnabled'
> = {
  start: () => gestureService.start(),
  stop: () => gestureService.stop(),
  restart: () => gestureService.restart(),
  getState: () => gestureService.getState(),
  getDiagnostics: () => gestureService.getDiagnostics(),
  getLastAnalysis: () => gestureService.getLastAnalysis(),
  hasPhysicalCamera: () => gestureService.hasPhysicalCamera(),
  captureSnapshotBase64: (quality?: number) => gestureService.captureSnapshotBase64(quality),
  listCameras: () => gestureService.listCameras(),
  setPreferredDevice: (deviceId: string | null, options?: { autoRestart?: boolean }) =>
    gestureService.setPreferredDevice(deviceId, options),
  getPreferredDevice: () => gestureService.getPreferredDevice(),
  setCursorControlEnabled: (enabled: boolean) => gestureService.setCursorControlEnabled(enabled),
  getCursorControlEnabled: () => gestureService.getCursorControlEnabled(),
  attachPreview: (target: HTMLVideoElement | null) => gestureService.attachPreview(target),
  notifyAttempt: () => gestureService.notifyAttempt(),
  recalibrateBackground: () => gestureService.recalibrateBackground(),
  setBackgroundFreeze: (frozen: boolean) => gestureService.setBackgroundFreeze(frozen),
  isObjectTrackingEnabled: () => gestureService.isObjectTrackingEnabled()
};

// Diagnóstico: permite inspecionar o serviço pelo console do WebView
// (`window.__LIORA_GESTURE__.getDiagnostics()`), essencial para entender por que
// a câmera não abre / a mão não é vista em uma máquina específica.
// (Antes este bloco declarava `gestureService` uma SEGUNDA vez — `SyntaxError:
// Identifier 'gestureService' has already been declared` em runtime; esbuild
// tolera, mas o módulo real do navegador quebra e nada da câmera monta.)

// Registro de diagnóstico: no navegador em `window`, no backend em `globalThis`.
// Antes existia apenas `window.__LIORA_GESTURE__` e, no Node, o import lançava
// "window is not defined" dentro de um try vazio — o registro sumia em silêncio.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__LIORA_GESTURE__', {
    value: gestureService,
    configurable: true,
    writable: true,
    enumerable: false
  });
}
if (typeof globalThis !== 'undefined') {
  Object.defineProperty(globalThis, '__LIORA_GESTURE__', {
    value: gestureService,
    configurable: true,
    writable: true,
    enumerable: false
  });
}

export const GESTURE_DIAGNOSTIC_KEY = '__LIORA_GESTURE__';
export const GESTURE_DIAGNOSTIC_PROBE = {
  kind: 'gesture-service-diag',
  service: gestureService
};
// Instância canônica exposta para o módulo de diagnóstico (main.tsx faz o
// `import()` dinâmico SÓ quando o singleton ainda não está no window/globalThis).
export default gestureService;


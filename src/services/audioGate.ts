export type AudioChannel = 'live_ws' | 'neural_tts' | 'offline_tts';

export interface AudioGateOptions {
  isDeterministicOverride?: boolean;
}

export interface AudioGateState {
  activeChannel: AudioChannel | null;
  liveSessionActive: boolean;
  liveSuppressedUntil: number;
}

class MutuallyExclusiveAudioGate {
  private activeChannel: AudioChannel | null = null;
  private liveSessionActive = false;
  private liveSuppressedUntil = 0;
  private abortHandlers: Map<AudioChannel, Set<() => void>> = new Map();

  public registerAbortHandler(channel: AudioChannel, handler: () => void): () => void {
    let handlers = this.abortHandlers.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.abortHandlers.set(channel, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
    };
  }

  public cancelNativeSpeechSynthesis(): void {
    try {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    } catch {
      // Ignore speechSynthesis access errors in restricted/headless contexts
    }
  }

  public setLiveSessionActive(active: boolean): void {
    this.liveSessionActive = active;
    if (active && !this.isLiveSuppressed()) {
      this.abortChannel('offline_tts');
      this.cancelNativeSpeechSynthesis();
    } else if (!active && this.activeChannel === 'live_ws') {
      this.activeChannel = null;
    }
  }

  public isLiveSessionActive(): boolean {
    return this.liveSessionActive;
  }

  public suppressLiveFor(ms: number): void {
    const safeMs = Math.max(0, ms);
    const target = Date.now() + safeMs;
    if (target > this.liveSuppressedUntil) {
      this.liveSuppressedUntil = target;
    }
    if (safeMs > 0) {
      this.abortChannel('live_ws');
    }
  }

  public isLiveSuppressed(): boolean {
    return Date.now() < this.liveSuppressedUntil;
  }

  public canUseOfflineTts(opts?: AudioGateOptions): boolean {
    const override = Boolean(opts?.isDeterministicOverride);
    if (this.liveSessionActive && !this.isLiveSuppressed() && !override) {
      return false;
    }
    if (this.activeChannel === 'live_ws' && !this.isLiveSuppressed() && !override) {
      return false;
    }
    if (this.activeChannel === 'neural_tts' && !override) {
      return false;
    }
    return true;
  }

  public canAcquire(channel: AudioChannel, opts?: AudioGateOptions): boolean {
    if (channel === 'offline_tts') {
      return this.canUseOfflineTts(opts);
    }
    if (channel === 'live_ws') {
      return !this.isLiveSuppressed();
    }
    if (channel === 'neural_tts') {
      if (this.liveSessionActive && !this.isLiveSuppressed() && !opts?.isDeterministicOverride) {
        return false;
      }
      return true;
    }
    return true;
  }

  public acquireChannel(channel: AudioChannel, opts?: AudioGateOptions): boolean {
    if (!this.canAcquire(channel, opts)) {
      return false;
    }

    // Strict mutually exclusive cleanup: clear native synthesis and abort competing channels
    this.cancelNativeSpeechSynthesis();
    const allChannels: AudioChannel[] = ['live_ws', 'neural_tts', 'offline_tts'];
    for (const ch of allChannels) {
      if (ch !== channel) {
        this.abortChannel(ch);
      }
    }

    this.activeChannel = channel;
    return true;
  }

  public releaseChannel(channel: AudioChannel): void {
    if (this.activeChannel === channel) {
      this.activeChannel = null;
    }
  }

  public abortChannel(channel: AudioChannel): void {
    if (channel === 'offline_tts') {
      this.cancelNativeSpeechSynthesis();
    }
    const handlers = this.abortHandlers.get(channel);
    if (handlers) {
      for (const fn of handlers) {
        try {
          fn();
        } catch {
          // Ignore individual handler abort errors
        }
      }
    }
    if (this.activeChannel === channel) {
      this.activeChannel = null;
    }
  }

  public abortAll(): void {
    this.cancelNativeSpeechSynthesis();
    const allChannels: AudioChannel[] = ['live_ws', 'neural_tts', 'offline_tts'];
    for (const ch of allChannels) {
      this.abortChannel(ch);
    }
    this.activeChannel = null;
  }

  public getState(): AudioGateState {
    return {
      activeChannel: this.activeChannel,
      liveSessionActive: this.liveSessionActive,
      liveSuppressedUntil: this.liveSuppressedUntil,
    };
  }

  public resetForTests(): void {
    this.activeChannel = null;
    this.liveSessionActive = false;
    this.liveSuppressedUntil = 0;
  }
}

export const audioGate = new MutuallyExclusiveAudioGate();

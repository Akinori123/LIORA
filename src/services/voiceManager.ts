/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { audioGate } from './audioGate';

export type VoiceChannelType = 'local' | 'stream';

export class VoiceManager {
  private static instance: VoiceManager;
  private activeChannel: VoiceChannelType | null = null;

  private constructor() {}

  public static getInstance(): VoiceManager {
    if (!VoiceManager.instance) {
      VoiceManager.instance = new VoiceManager();
    }
    return VoiceManager.instance;
  }

  /**
   * Enforces hard exclusive lock before streaming API audio starts.
   * Calls window.speechSynthesis.cancel() immediately and claims exclusive lock for 'stream'.
   */
  public prepareForStreamPlayback(): void {
    try {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    } catch (err) {
      console.warn('[VoiceManager] Failed to cancel speechSynthesis:', err);
    }

    audioGate.cancelNativeSpeechSynthesis();
    audioGate.acquireChannel('neural_tts', { isDeterministicOverride: true });
    this.activeChannel = 'stream';
  }

  /**
   * Prepares for local SpeechSynthesis (offline TTS).
   * If streaming API audio is active, releases or yields.
   */
  public prepareForLocalPlayback(): void {
    audioGate.cancelNativeSpeechSynthesis();
    const canAcquire = audioGate.acquireChannel('offline_tts');
    if (canAcquire) {
      this.activeChannel = 'local';
    }
  }

  public releaseLock(channel: VoiceChannelType): void {
    if (this.activeChannel === channel) {
      this.activeChannel = null;
      if (channel === 'stream') {
        audioGate.releaseChannel('neural_tts');
      } else if (channel === 'local') {
        audioGate.releaseChannel('offline_tts');
      }
    }
  }

  public cancelAll(): void {
    try {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    } catch {}
    audioGate.abortAll();
    this.activeChannel = null;
  }

  public getActiveChannel(): VoiceChannelType | null {
    return this.activeChannel;
  }

  public isStreamActive(): boolean {
    return this.activeChannel === 'stream';
  }

  public isLocalActive(): boolean {
    return this.activeChannel === 'local';
  }
}

export const voiceManager = VoiceManager.getInstance();

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import { voiceManager } from '../src/services/voiceManager';
import { audioGate } from '../src/services/audioGate';

test('VoiceManager - singleton enforces hard exclusive lock and cancels speechSynthesis', async () => {
  // Mock window.speechSynthesis
  let cancelCalledCount = 0;
  const mockSpeechSynthesis = {
    cancel: () => {
      cancelCalledCount++;
    },
    speak: () => {},
    getVoices: () => []
  };

  (globalThis as any).window = {
    speechSynthesis: mockSpeechSynthesis
  };

  // Reset audio gate & voice manager
  audioGate.resetForTests();
  voiceManager.cancelAll();

  assert.strictEqual(voiceManager.getActiveChannel(), null);

  // Test stream playback preparation
  voiceManager.prepareForStreamPlayback();
  assert.strictEqual(voiceManager.isStreamActive(), true);
  assert.strictEqual(cancelCalledCount, 1, 'window.speechSynthesis.cancel() must be called before stream playback starts');

  // Test local playback preparation
  voiceManager.prepareForLocalPlayback();
  assert.strictEqual(voiceManager.isLocalActive(), true);
  assert.strictEqual(cancelCalledCount, 2, 'window.speechSynthesis.cancel() must be called when preparing for local playback');

  // Clean up
  voiceManager.cancelAll();
  assert.strictEqual(voiceManager.getActiveChannel(), null);

  delete (globalThis as any).window;
});

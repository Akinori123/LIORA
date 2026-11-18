/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceLiveClient } from '../src/services/voiceLiveClient';
import { settingsManager, DEFAULT_SETTINGS, STORAGE_KEY_SETTINGS } from '../src/services/settingsManager';
import { sanitizeChatMessage } from '../src/utils/historyStorage';
import { backgroundWorkerManager } from '../src/core/backgroundWorkers';
import { voiceManager } from '../src/services/voiceManager';

test('AUDIT-01: VoiceLiveClient subscribeCallbacks preserves independent subscribers across setCallbacks and unsubscribe', () => {
  const client = new VoiceLiveClient();
  const receivedGlobal: string[] = [];
  const receivedTemp: string[] = [];

  const unsubGlobal = client.subscribeCallbacks({
    onStatusChange: (status) => receivedGlobal.push(status)
  });

  const unsubTemp = client.subscribeCallbacks({
    onStatusChange: (status) => receivedTemp.push(status)
  });

  // Legacy setCallbacks({}) must NOT wipe subscriber listeners
  client.setCallbacks({});
  (client as any).emitStatusChange('LISTENING');

  assert.deepStrictEqual(receivedGlobal, ['LISTENING']);
  assert.deepStrictEqual(receivedTemp, ['LISTENING']);

  // Unsubscribing temporary listener preserves global listener
  unsubTemp();
  (client as any).emitStatusChange('SPEAKING');

  assert.deepStrictEqual(receivedGlobal, ['LISTENING', 'SPEAKING']);
  assert.deepStrictEqual(receivedTemp, ['LISTENING']);

  unsubGlobal();
});

test('AUDIT-02: settingsManager.resetSettings clears persisted overrides and restores DEFAULT_SETTINGS', () => {
  const backing: Record<string, string> = {};
  const originalLocalStorage = (globalThis as any).localStorage;
  (globalThis as any).localStorage = {
    getItem: (k: string) => (k in backing ? backing[k] : null),
    setItem: (k: string, v: string) => { backing[k] = String(v); },
    removeItem: (k: string) => { delete backing[k]; },
    clear: () => { Object.keys(backing).forEach((k) => delete backing[k]); }
  };

  try {
    settingsManager.saveSettings({
      ...DEFAULT_SETTINGS,
      theme: 'emerald',
      requestTimeoutMs: 45000,
      ttsVoice: 'Fenrir'
    });
    assert.strictEqual(settingsManager.loadSettings().theme, 'emerald');
    assert.strictEqual(settingsManager.loadSettings().requestTimeoutMs, 45000);

    const restored = settingsManager.resetSettings();
    assert.strictEqual(restored.theme, DEFAULT_SETTINGS.theme);
    assert.strictEqual(restored.requestTimeoutMs, DEFAULT_SETTINGS.requestTimeoutMs);
    assert.strictEqual(restored.ttsVoice, DEFAULT_SETTINGS.ttsVoice);

    const reloaded = JSON.parse(backing[STORAGE_KEY_SETTINGS]);
    assert.strictEqual(reloaded.theme, DEFAULT_SETTINGS.theme);
    assert.strictEqual(reloaded.requestTimeoutMs, DEFAULT_SETTINGS.requestTimeoutMs);
  } finally {
    (globalThis as any).localStorage = originalLocalStorage;
  }
});

test('AUDIT-03: historyStorage sanitizeChatMessage preserves toolsCalled and valid tokens', () => {
  const sanitized = sanitizeChatMessage({
    id: 'msg-audit-1',
    sender: 'assistant',
    text: 'Arquivo verificado com sucesso.',
    timestamp: '12:00:00',
    status: 'completed',
    modelUsed: 'gemini-3.1-flash-lite',
    toolsCalled: ['system_info', 'open_application'],
    tokens: 342
  });

  assert.ok(sanitized);
  assert.deepStrictEqual(sanitized.toolsCalled, ['system_info', 'open_application']);
  assert.strictEqual(sanitized.tokens, 342);

  // Invalid negative tokens or non-string tool names are filtered out cleanly
  const sanitizedInvalid = sanitizeChatMessage({
    id: 'msg-audit-2',
    sender: 'assistant',
    text: 'Teste',
    timestamp: '12:01:00',
    toolsCalled: ['system_info', 123, '', null],
    tokens: -10
  });
  assert.ok(sanitizedInvalid);
  assert.deepStrictEqual(sanitizedInvalid.toolsCalled, ['system_info']);
  assert.strictEqual(sanitizedInvalid.tokens, undefined);
});

test('AUDIT-04: backgroundWorkers blocks CR/LF separators and git config/upload-pack argument injection', async () => {
  const crlfAttempt = await backgroundWorkerManager.enqueue('shell', 'CRLF Injection', {
    command: 'git status\nrm -rf /'
  });
  assert.strictEqual(crlfAttempt.success, false);
  assert.match(String(crlfAttempt.error), /COMMAND_INJECTION_BLOCKED/);

  const gitConfigAttempt = await backgroundWorkerManager.enqueue('shell', 'Git -c Injection', {
    command: 'git -c core.sshCommand=evil status'
  });
  assert.strictEqual(gitConfigAttempt.success, false);
  assert.match(String(gitConfigAttempt.error), /COMMAND_INJECTION_BLOCKED/);

  const gitUploadPackAttempt = await backgroundWorkerManager.enqueue('shell', 'Git upload-pack Injection', {
    command: 'git ls-remote --upload-pack=evil origin'
  });
  assert.strictEqual(gitUploadPackAttempt.success, false);
  assert.match(String(gitUploadPackAttempt.error), /COMMAND_INJECTION_BLOCKED/);

  // Legitimate git flag containing "-c" as substring (--cached) must NOT be blocked
  const gitCachedAllowed = await backgroundWorkerManager.enqueue('shell', 'TESTE-AUDIT-GIT-CACHED', {
    command: 'git diff --cached --stat'
  });
  assert.strictEqual(gitCachedAllowed.success, true);
  if (gitCachedAllowed.taskId) {
    await backgroundWorkerManager.cancel(gitCachedAllowed.taskId, 'audit cleanup').catch(() => {});
  }
});

test('AUDIT-05: VoiceManager cancels speechSynthesis before stream playback and releases locks cleanly', () => {
  const originalWindow = (globalThis as any).window;
  let cancelCalledCount = 0;

  (globalThis as any).window = {
    speechSynthesis: {
      cancel: () => {
        cancelCalledCount += 1;
      }
    }
  };

  try {
    voiceManager.cancelAll();
    cancelCalledCount = 0;

    voiceManager.prepareForStreamPlayback();
    assert.ok(cancelCalledCount >= 1, 'speechSynthesis.cancel deve rodar ao preparar stream');
    assert.strictEqual(voiceManager.getActiveChannel(), 'stream');
    assert.strictEqual(voiceManager.isStreamActive(), true);

    voiceManager.releaseLock('stream');
    assert.strictEqual(voiceManager.getActiveChannel(), null);
    assert.strictEqual(voiceManager.isStreamActive(), false);

    voiceManager.prepareForLocalPlayback();
    assert.strictEqual(voiceManager.getActiveChannel(), 'local');
    voiceManager.releaseLock('local');
    assert.strictEqual(voiceManager.getActiveChannel(), null);
  } finally {
    voiceManager.cancelAll();
    (globalThis as any).window = originalWindow;
  }
});

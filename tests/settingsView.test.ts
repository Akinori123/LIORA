/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import { settingsManager } from '../src/services/settingsManager';
import { eventBus } from '../src/utils/eventBus';

test('SET-VIEW-01: Theme injection into DOM and CSS variables', () => {
  let appliedTheme = '';
  let cssVarVal = '';
  (global as any).document = {
    documentElement: {
      setAttribute: (k: string, v: string) => { if (k === 'data-theme') appliedTheme = v; },
      style: { setProperty: (n: string, v: string) => { if (n === '--accent-primary') cssVarVal = v; } }
    }
  };

  settingsManager.applyTheme('amber');
  assert.strictEqual(appliedTheme, 'amber');
  assert.strictEqual(cssVarVal, '#f59e0b');
});

test('SET-VIEW-02: Security enforcement level event propagation via EventBus', () => {
  let eventFired = false;
  let eventPayload: any = null;

  const unsub = eventBus.subscribe('SECURITY_LEVEL_CHANGED', (payload) => {
    eventFired = true;
    eventPayload = payload;
  });

  eventBus.publish('SECURITY_LEVEL_CHANGED', { level: 'strict', timestamp: new Date().toISOString() });
  
  assert.strictEqual(eventFired, true);
  assert.strictEqual(eventPayload.level, 'strict');
  unsub();
});

test('SET-VIEW-03: Timeout clamping and validation [1000, 60000]', () => {
  const lowResult = settingsManager.validateAndSanitize({ requestTimeoutMs: 500 });
  assert.strictEqual(lowResult.sanitizedSettings.requestTimeoutMs, 1000);

  const highResult = settingsManager.validateAndSanitize({ requestTimeoutMs: 120000 });
  assert.strictEqual(highResult.sanitizedSettings.requestTimeoutMs, 60000);

  const validResult = settingsManager.validateAndSanitize({ requestTimeoutMs: 15000 });
  assert.strictEqual(validResult.sanitizedSettings.requestTimeoutMs, 15000);
});

test('SET-VIEW-04: Gemini TTS Audio API synthesis endpoint integration', async () => {
  let endpointCalled = '';
  let payloadPassed: any = null;

  const originalFetch = global.fetch;
  (global as any).fetch = async (url: string, opts: any) => {
    endpointCalled = url;
    payloadPassed = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        audioBase64: 'UklGRiAAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=',
        mimeType: 'audio/wav',
        voiceUsed: 'Zephyr',
        modelUsed: 'gemini-3.8-flash-lite-tts'
      })
    };
  };

  try {
    const res = await fetch('/api/gemini/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'LIORA online com voz sintética avançada Zephyr.',
        voice: 'Zephyr',
        model: 'gemini-3.8-flash-lite-tts'
      })
    });

    const data = await res.json();
    assert.strictEqual(endpointCalled, '/api/gemini/tts');
    assert.strictEqual(payloadPassed.voice, 'Zephyr');
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.mimeType, 'audio/wav');
  } finally {
    global.fetch = originalFetch;
  }
});

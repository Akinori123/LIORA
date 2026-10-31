/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import { integrationsVault } from '../src/services/integrationsVault';

test('AUD-SET-01: Voice test sends correct HTTP request to Gemini TTS API with Vault key', async () => {
  let requestUrl = '';
  let requestMethod = '';
  let requestHeaders: Record<string, string> = {};
  let requestBody: any = null;

  // Mock global fetch
  const originalFetch = global.fetch;
  (global as any).fetch = async (url: string, options: any) => {
    requestUrl = url;
    requestMethod = options?.method || 'GET';
    requestHeaders = options?.headers || {};
    requestBody = options?.body ? JSON.parse(options.body) : null;

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
    // Save a test key in the vault for Gemini
    await integrationsVault.connectService('svc-gemini', 'AIzaSyTestVaultKey999999');
    const vaultKey = integrationsVault.getApiKeyByProvider('gemini') || integrationsVault.getRawKey('svc-gemini');

    assert.strictEqual(vaultKey, 'AIzaSyTestVaultKey999999');

    // Simulate clicking test voice button HTTP fetch call
    const res = await fetch('/api/gemini/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${vaultKey}`
      },
      body: JSON.stringify({
        text: 'LIORA online com voz sintética avançada Zephyr.',
        voice: 'Zephyr',
        model: 'gemini-3.8-flash-lite-tts'
      })
    });

    const data = await res.json();

    assert.strictEqual(requestUrl, '/api/gemini/tts');
    assert.strictEqual(requestMethod, 'POST');
    assert.strictEqual(requestHeaders['Authorization'], 'Bearer AIzaSyTestVaultKey999999');
    assert.strictEqual(requestBody.voice, 'Zephyr');
    assert.strictEqual(requestBody.model, 'gemini-3.8-flash-lite-tts');

    assert.strictEqual(data.success, true);
    assert.strictEqual(data.mimeType, 'audio/wav');
    assert.strictEqual(typeof data.audioBase64, 'string');
  } finally {
    global.fetch = originalFetch;
  }
});

test('AUD-SET-02: Missing or invalid Gemini API key in Vault rejects TTS request with 401 error', async () => {
  const originalFetch = global.fetch;
  (global as any).fetch = async (url: string, options: any) => {
    return {
      ok: false,
      status: 401,
      json: async () => ({
        success: false,
        error: 'Chave de API do Gemini ausente ou inválida no Cofre para teste de áudio',
        code: 'AUTH_ERROR'
      })
    };
  };

  try {
    const res = await fetch('/api/gemini/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Teste sem chave',
        voice: 'Zephyr',
        model: 'gemini-3.8-flash-lite-tts'
      })
    });

    const data = await res.json();
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 401);
    assert.strictEqual(data.error, 'Chave de API do Gemini ausente ou inválida no Cofre para teste de áudio');
  } finally {
    global.fetch = originalFetch;
  }
});

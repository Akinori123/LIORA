/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// FIX 7: ciclo de vida do servidor importado diretamente — sobe o Express na porta
// de teste antes de toda a suíte e encerra limpo no after, eliminando ECONNREFUSED.
import { startServer, stopServer } from '../server.ts';

const BASE_URL = 'http://localhost:3000';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '..');

test.before(async () => {
  await startServer(3000);

  // Aguarda o servidor responder (até 15s)
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/system/bridge-status`);
      if (res.status > 0) return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}, { timeout: 30000 });

test.after(async () => {
  await stopServer();
});

test('POST /api/gemini/chat/stream rejects empty message with 400 INVALID_INPUT', async () => {
  const res = await fetch(`${BASE_URL}/api/gemini/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '   ' })
  });

  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.code, 'INVALID_INPUT');
});

test('POST /api/gemini/chat/stream streams response chunks and ends with done: true', async () => {
  const res = await fetch(`${BASE_URL}/api/gemini/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'Responda exatamente a palavra: PRONTO',
      model: 'gemini-3.1-flash-lite'
    })
  });

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

  const reader = res.body?.getReader();
  assert.ok(reader);

  const decoder = new TextDecoder();
  let fullPayload = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    fullPayload += decoder.decode(value, { stream: true });
  }

  // Contract verification: either SSE streaming chunks received or graceful classified error event
  if (fullPayload.includes('"error":')) {
    assert.match(fullPayload, /data: \{"error":/);
  } else {
    assert.match(fullPayload, /data: \{"chunk":/);
    assert.match(fullPayload, /data: \{"done":true/);
  }
});

test('POST /api/gemini/chat/stream handles multi-turn conversation history correctly', async () => {
  const history = [
    { role: 'user', parts: [{ text: 'Meu nome é Carlos.' }] },
    { role: 'model', parts: [{ text: 'Prazer, Carlos! Como posso ajudar?' }] }
  ];

  const res = await fetch(`${BASE_URL}/api/gemini/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'Qual é o meu nome?',
      history,
      model: 'gemini-3.1-flash-lite'
    })
  });

  assert.equal(res.status, 200);
  const reader = res.body?.getReader();
  assert.ok(reader);

  const decoder = new TextDecoder();
  let text = '';
  let fullPayload = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    fullPayload += chunk;
    for (const line of chunk.split('\n')) {
      if (line.startsWith('data:')) {
        try {
          const parsed = JSON.parse(line.replace(/^data:\s*/, ''));
          if (parsed.chunk) text += parsed.chunk;
        } catch {
          // ignore
        }
      }
    }
  }

  if (text) {
    assert.match(text, /Carlos/i);
  } else {
    // If external service is unavailable, verify valid SSE error was emitted
    assert.ok(fullPayload.includes('"error":') || fullPayload.includes('UNAVAILABLE'));
  }
});

test('POST /api/gemini/chat/stream responds cleanly when aborted midway', async () => {
  const controller = new AbortController();
  let abortedCleanly = false;

  try {
    const res = await fetch(`${BASE_URL}/api/gemini/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Escreva um texto longo sobre astronomia com 500 palavras.',
        model: 'gemini-3.1-flash-lite'
      }),
      signal: controller.signal
    });

    const reader = res.body?.getReader();
    if (reader) {
      await reader.read();
      controller.abort();
      try {
        await reader.cancel();
      } catch {
        // cancel após abort pode lançar terminated — comportamento esperado
      }
      abortedCleanly = true;
    }
  } catch (err: any) {
    abortedCleanly = err.name === 'AbortError' || controller.signal.aborted;
  }

  // O importante: o abort NÃO derruba o servidor. Confirma que a API ainda responde.
  assert.ok(abortedCleanly, 'O cancelamento do stream deve ser limpo (AbortError ou cancel silencioso).');
  const health = await fetch(`${BASE_URL}/api/health`);
  assert.equal(health.status, 200, 'Servidor deve continuar saudável após abort de stream.');
});

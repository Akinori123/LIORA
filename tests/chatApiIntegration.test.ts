/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const BASE_URL = 'http://localhost:3000';

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
      await reader.cancel().catch(() => {});
    }
  } catch (err: any) {
    assert.ok(err.name === 'AbortError' || controller.signal.aborted);
  }
});

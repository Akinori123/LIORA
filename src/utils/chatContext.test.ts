import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeInput, formatGeminiHistory, classifyChatError } from './chatContext.ts';
import type { ChatMessage } from '../types.ts';

test('sanitizeInput trims whitespace and enforces length limit', () => {
  assert.equal(sanitizeInput('   olá liora   '), 'olá liora');
  assert.equal(sanitizeInput(''), '');
  const longText = 'a'.repeat(20);
  assert.equal(sanitizeInput(longText, 10), 'aaaaaaaaaa');
});

test('formatGeminiHistory maps user and assistant to user and model roles', () => {
  const messages: ChatMessage[] = [
    { id: '1', sender: 'user', text: 'Oi', timestamp: '12:00' },
    { id: '2', sender: 'assistant', text: 'Olá! Como posso ajudar?', timestamp: '12:00' }
  ];

  const turns = formatGeminiHistory(messages);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].role, 'user');
  assert.equal(turns[0].parts[0].text, 'Oi');
  assert.equal(turns[1].role, 'model');
  assert.equal(turns[1].parts[0].text, 'Olá! Como posso ajudar?');
});

test('formatGeminiHistory filters out error messages and empty texts', () => {
  const messages: ChatMessage[] = [
    { id: '1', sender: 'user', text: 'Primeira', timestamp: '12:00' },
    { id: '2', sender: 'assistant', text: 'Erro 500', status: 'error', timestamp: '12:01' },
    { id: '3', sender: 'user', text: '   ', timestamp: '12:02' },
    { id: '4', sender: 'user', text: 'Segunda', timestamp: '12:03' }
  ];

  const turns = formatGeminiHistory(messages);
  // Messages 1 and 4 are consecutive user messages, so they are merged
  assert.equal(turns.length, 1);
  assert.equal(turns[0].role, 'user');
  assert.match(turns[0].parts[0].text, /Primeira/);
  assert.match(turns[0].parts[0].text, /Segunda/);
});

test('formatGeminiHistory respects maxTurns sliding window', () => {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < 30; i++) {
    messages.push({
      id: `m-${i}`,
      sender: i % 2 === 0 ? 'user' : 'assistant',
      text: `Mensagem ${i}`,
      timestamp: '12:00'
    });
  }

  const turns = formatGeminiHistory(messages, 6);
  assert.ok(turns.length <= 6);
  // Should contain recent messages (e.g., Mensagem 29)
  const lastTurn = turns[turns.length - 1];
  assert.equal(lastTurn.parts[0].text, 'Mensagem 29');
});

test('classifyChatError correctly classifies various failure modes', () => {
  // Cancelled
  const cancelErr = classifyChatError(new Error('The user aborted a request.'));
  assert.equal(cancelErr.code, 'CANCELLED');

  // Auth / Key
  const authErr = classifyChatError(401);
  assert.equal(authErr.code, 'AUTH_ERROR');

  const authErrMsg = classifyChatError(0, 'API key not valid');
  assert.equal(authErrMsg.code, 'AUTH_ERROR');

  // Quota
  const quotaErr = classifyChatError(429);
  assert.equal(quotaErr.code, 'QUOTA_ERROR');

  // Unavailable
  const unavailErr = classifyChatError(503);
  assert.equal(unavailErr.code, 'UNAVAILABLE');

  // Network
  const netErr = classifyChatError(0, 'Failed to fetch');
  assert.equal(netErr.code, 'NETWORK_ERROR');
});

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { useLioraStore } from '../src/store/lioraStore.ts';
import { ChatMessage } from '../src/types.ts';

test('store initial state has chat enabled with clean defaults', () => {
  const state = useLioraStore.getState();
  assert.equal(state.isGenerating, false);
  assert.equal(state.activeAbortController, null);
  assert.ok(Array.isArray(state.messages));
});

test('retryMessage replaces failed assistant message without duplicating user turn', async () => {
  const store = useLioraStore.getState();

  // Setup state with 1 user message and 1 error message
  const userMsgId = 'user-test-1';
  const failedMsgId = 'failed-test-1';

  useLioraStore.setState({
    messages: [
      { id: userMsgId, sender: 'user', text: 'Pergunta teste', timestamp: '10:00', status: 'completed' },
      { id: failedMsgId, sender: 'assistant', text: '', timestamp: '10:00', status: 'error', errorCode: 'AUTH_ERROR', errorMessage: 'Falha simulada' }
    ],
    isGenerating: false
  });

  const beforeMessages = useLioraStore.getState().messages;
  assert.equal(beforeMessages.length, 2);

  // Invoke retry
  const retryPromise = useLioraStore.getState().retryMessage(failedMsgId);

  // Abort immediately so we don't wait for network
  setTimeout(() => {
    useLioraStore.getState().abortGeneration();
  }, 20);

  try {
    await retryPromise;
  } catch {
    // aborted
  }

  const afterMessages = useLioraStore.getState().messages;
  // User messages must not be duplicated: exactly 1 user message
  const userMessages = afterMessages.filter(m => m.sender === 'user');
  assert.equal(userMessages.length, 1);
  assert.equal(userMessages[0].text, 'Pergunta teste');

  // The failedMsgId must have been replaced
  assert.ok(!afterMessages.some(m => m.id === failedMsgId));
});

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Regressão do GATE DE ATENÇÃO do canal de voz.
 *
 * Bug de campo: a LIORA ouvia o primeiro comando, respondia e depois ficava
 * muda para sempre. Causa raiz: o gate só liberava áudio quando
 * `lastUserTranscript` (preenchido por TRANSCRIPTION do servidor) continha o
 * wake word. Sem transcrição — ou depois que o texto antigo era descartado — a
 * atenção expirava e nenhum chunk de microfone era enviado ao Gemini Live.
 *
 * Este teste verifica APENAS o contrato do gate (público), sem abrir áudio real.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceLiveClient } from '../src/services/voiceLiveClient';

test('VOICE-GATE-01: ligar o microfone (primeAttention) libera a próxima fala', () => {
  const client = new VoiceLiveClient();
  client.clearAttention();
  assert.equal(client.isAttentionActive(), false);

  client.primeAttention();
  assert.equal(client.isAttentionActive(), true, 'ativação manual = intenção explícita de falar');
});

test('VOICE-GATE-02: transcrição sem o nome bloqueia ruído de ambiente', () => {
  const client = new VoiceLiveClient();
  client.clearAttention();
  client.feedUserTranscript('a aula de hoje foi sobre integrais');
  assert.equal(client.isAttentionActive(), false, 'fala de terceiros/TV não deve acordar a LIORA');
});

test('VOICE-GATE-03: chamar pelo nome acorda a LIORA', () => {
  const client = new VoiceLiveClient();
  client.clearAttention();
  client.feedUserTranscript('oi LIORA, abre o bloco de notas');
  assert.equal(client.isAttentionActive(), true);
});

test('VOICE-GATE-04: turno final limpa a transcrição (não bloqueia a próxima fala)', () => {
  const client = new VoiceLiveClient();
  client.clearAttention();
  client.feedUserTranscript('abre o navegador'); // sem nome → bloqueado
  assert.equal(client.isAttentionActive(), false);

  client.primeAttention();          // usuário acabou de ligar/retomar o mic
  client.clearUserTranscript();     // frase final consumida
  client.clearAttention();

  // Fluxo real: nova fala chega sem nome, mas o texto antigo não existe mais.
  client.primeAttention();
  const diag = client.getAttentionDiagnostics();
  assert.equal(diag.lastHeard, '');
  assert.equal(diag.attentionActive, true);
});

test('VOICE-GATE-05: diagnóstico expõe estado real para depuração', () => {
  const client = new VoiceLiveClient();
  const diag = client.getAttentionDiagnostics();
  assert.equal(typeof diag.status, 'string');
  assert.equal(diag.wsOpen, false, 'sem start() não há WebSocket aberto');
  assert.equal(typeof diag.attentionActive, 'boolean');
  assert.equal(typeof diag.suppressionRemainingMs, 'number');
});

test('VOICE-GATE-06: pronúncias reais do nome ("leora", "Leora") acordam a LIORA', () => {
  const client = new VoiceLiveClient();
  for (const heard of ['Oi, leora.', 'leora', 'Ei Lerora', 'Liora, abre o bloco de notas', 'fala liora']) {
    client.clearAttention();
    client.feedUserTranscript(heard);
    assert.equal(client.isAttentionActive(), true, `"${heard}" deveria acordar a LIORA`);
  }
});

test('VOICE-GATE-07: sinalização de fim de fala é no-op sem WebSocket aberto', () => {
  const client = new VoiceLiveClient();
  assert.doesNotThrow(() => client.sendAudioStreamEnd());
});

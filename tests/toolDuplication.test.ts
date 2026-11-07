/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Testes de Regressão da Auditoria E2E — LIORA
 * Valida: exclusividade atômica de ferramentas de navegação (bug das abas
 * duplicadas do Maps) e sincronização tool→TTS (anti-alucinação).
 */

/**
 * CORREÇÃO ANTI-ABAS: ativa o dry-run ANTES de qualquer import da tool — os
 * testes nunca devem abrir abas reais de Maps/Waze no navegador do usuário.
 * (Auditoria: antes, cada npm test abria ~8 abas de verdade.)
 */
process.env.LIORA_NO_BROWSER = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapsSearchPlacesTool,
  openGpsNavigationTool
} from '../src/tools/navigation/navigationActionTool';

// ─── Exclusividade atômica (bug das abas duplicadas) ─────────────────────────

test('DUP-01: mesma busca em sequência rápida abre UMA aba (lock de intenção)', async () => {
  // Primeira chamada: executa real
  const first = await mapsSearchPlacesTool.execute({ query: 'farmácia', nearLocation: 'daqui' });
  assert.strictEqual(first.simulated, false);
  const firstOk = first.success;

  if (firstOk) {
    // Segunda chamada IDÊNTICA dentro de 5s: deve ser suprimida
    const second = await mapsSearchPlacesTool.execute({ query: 'farmácia', nearLocation: 'daqui' });
    assert.strictEqual(second.duplicateSuppressed, true, 'chamada duplicada deve ser suprimida pelo lock');
    assert.strictEqual(second.success, true);
    assert.strictEqual(second.url, first.url, 'resultado anterior deve ser reutilizado');
  }
});

test('DUP-02: busca de destino diferente NÃO é suprimida (intenções distintas)', async () => {
  const first = await mapsSearchPlacesTool.execute({ query: 'farmácia' });
  const second = await mapsSearchPlacesTool.execute({ query: 'mercado' });
  // São intenções diferentes — cada uma pode abrir (o lock só bloqueia duplicatas exatas)
  if (first.success && second.success) {
    assert.notStrictEqual(second.duplicateSuppressed, true, 'intent diferente não deve ser suprimida');
  }
});

test('DUP-03: mesma rota GPS em sequência rápida abre UMA navegação', async () => {
  const first = await openGpsNavigationTool.execute({ destination: 'Aeroporto Internacional' });
  if (first.success) {
    const second = await openGpsNavigationTool.execute({ destination: 'Aeroporto Internacional' });
    assert.strictEqual(second.duplicateSuppressed, true, 'rota duplicada deve ser suprimida');
    assert.strictEqual(second.url, first.url);
  }
});

test('DUP-04: lock normaliza acentos e caixa (farmácia == FARMACIA)', async () => {
  const first = await mapsSearchPlacesTool.execute({ query: 'farmácia' });
  if (first.success) {
    const second = await mapsSearchPlacesTool.execute({ query: 'FARMACIA' });
    assert.strictEqual(second.duplicateSuppressed, true, 'mesma intenção em caixa/acento diferente deve ser suprimida');
  }
});

// ─── Sincronização tool→TTS (anti-alucinação) ────────────────────────────────

test('SYNC-01: resultado da ferramenta contém message para o pipeline de voz', async () => {
  const res = await mapsSearchPlacesTool.execute({ query: 'teste sync tts' });
  assert.ok(typeof res.message === 'string' && res.message.length > 5, 'message deve existir para o TTS falar');
  // A message nunca deve conter URLs cruas (ilegível em voz)
  assert.ok(!res.message.includes('https://'), 'message falável não deve conter URL crua');
});

test('SYNC-02: rota GPS retorna message com nome do app e destino (falável)', async () => {
  const res = await openGpsNavigationTool.execute({ destination: 'teste destino' });
  assert.ok(typeof res.message === 'string' && res.message.length > 5);
  assert.ok(res.message.includes('Google Maps') || res.message.includes('Waze'), 'message deve citar o app de navegação');
  assert.ok(!res.message.includes('https://'), 'message falável não deve conter URL crua');
});

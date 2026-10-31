/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import { 
  tokenizeText, 
  sanitizeMemoryValue, 
  rankMemories, 
  formatMemoryContextBlock 
} from '../src/utils/memoryRanker';
import { MemoryEntry } from '../src/types';
import { useLioraStore } from '../src/store/lioraStore';

test('MEM-01: Tokenização correta e cálculo de score com priorização por categoria', () => {
  // 1. Tokenização e remoção de stopwords
  const tokens = tokenizeText('Como mudar o meu tema visual para vermelho na liora?');
  assert.ok(!tokens.includes('como'), 'Stopwords devem ser excluídas');
  assert.ok(!tokens.includes('o'), 'Stopwords devem ser excluídas');
  assert.ok(!tokens.includes('para'), 'Stopwords devem ser excluídas');
  assert.ok(!tokens.includes('na'), 'Stopwords devem ser excluídas');
  assert.ok(tokens.includes('tema'), 'Termos significativos devem ser mantidos');
  assert.ok(tokens.includes('visual'), 'Termos significativos devem ser mantidos');
  assert.ok(tokens.includes('vermelho'), 'Termos significativos devem ser mantidos');

  // 2. Priorização por categoria: preference (1.4x) vs fact (1.0x)
  const sampleMemories: MemoryEntry[] = [
    {
      id: 'mem-fact',
      category: 'fact',
      key: 'tema_escuro',
      value: 'Modo escuro ativado',
      confidence: 1.0,
      updatedAt: '2026-10-18'
    },
    {
      id: 'mem-pref',
      category: 'preference',
      key: 'tema_escuro',
      value: 'Modo escuro ativado',
      confidence: 1.0,
      updatedAt: '2026-10-18'
    }
  ];

  const results = rankMemories('tema escuro', sampleMemories);
  assert.strictEqual(results.length, 2);
  // O item de 'preference' deve ter score maior que o de 'fact'
  assert.strictEqual(results[0].entry.category, 'preference');
  assert.strictEqual(results[1].entry.category, 'fact');
  assert.ok(results[0].score > results[1].score);
});

test('MEM-02: Filtro de segurança e mascaramento de segredos em memórias', () => {
  // 1. Chave sensível contendo TOKEN / SECRET
  const res1 = sanitizeMemoryValue('GITHUB_TOKEN', 'ghp_1234567890abcdefghijklmnopqrstuvwxyz');
  assert.strictEqual(res1.sanitizedValue, '[REDACTED_SECURITY_SECRET]');
  assert.strictEqual(res1.isRedacted, true);

  const res2 = sanitizeMemoryValue('API_SECRET_KEY', 'minha-chave-secreta');
  assert.strictEqual(res2.sanitizedValue, '[REDACTED_SECURITY_SECRET]');

  // 2. Valor contendo padrão de chave Google AI Studio / Gemini
  const res3 = sanitizeMemoryValue('nota_config', 'Use a chave AIzaSyD1234567890abcdefghijklmnopqrstuvw para conectar');
  assert.strictEqual(res3.sanitizedValue, '[REDACTED_SECURITY_SECRET]');

  // 3. Verificação no rankeador completo
  const memoriesWithSecrets: MemoryEntry[] = [
    {
      id: 'sec-1',
      category: 'preference',
      key: 'DATABASE_PASSWORD',
      value: 'super_secret_123',
      confidence: 1.0,
      updatedAt: '2026-10-18'
    }
  ];

  const ranked = rankMemories('qual o database password?', memoriesWithSecrets);
  assert.strictEqual(ranked.length, 1);
  assert.strictEqual(ranked[0].entry.value, '[REDACTED_SECURITY_SECRET]');
});

test('MEM-03: Respeito rigoroso aos limites de orçamento (Top-4 e Max 400 caracteres)', () => {
  // Criar 10 memórias relevantes com textos extensos
  const largeMemories: MemoryEntry[] = Array.from({ length: 10 }, (_, i) => ({
    id: `mem-${i}`,
    category: 'project',
    key: `config_projeto_modulo_extenso_${i}`,
    value: `Descrição detalhada e muito extensa sobre a arquitetura do módulo de engenharia número ${i} com parâmetros específicos.`,
    confidence: 1.0,
    updatedAt: '2026-10-18'
  }));

  // O rankeador deve retornar no máximo 4 itens (Top-K <= 4)
  const ranked = rankMemories('config projeto modulo', largeMemories, {
    maxInjectedMemories: 4
  });
  assert.ok(ranked.length <= 4, 'Deve retornar no máximo 4 memórias');

  // O bloco formatado deve respeitar o orçamento de 400 caracteres
  const contextBlock = formatMemoryContextBlock(ranked, 400);
  assert.ok(contextBlock.length <= 400, `O bloco formatado deve ter <= 400 caracteres, obteve ${contextBlock.length}`);
  assert.ok(contextBlock.includes('[SISTEMA - MEMÓRIA CONTEXTUAL RECUPERADA]'));
});

test('MEM-04: Integração de rankeamento contextual com memórias do store', () => {
  const store = useLioraStore.getState();
  const storeMemories = store.memoryEntries;
  assert.ok(storeMemories.length > 0, 'O store deve conter memórias iniciais');

  // Consulta por tema e visual
  const rankedTheme = rankMemories('quero usar tema visual vermelho', storeMemories);
  assert.ok(rankedTheme.length > 0);
  const topMatch = rankedTheme[0];
  assert.strictEqual(topMatch.entry.key, 'tema_visual');
  assert.ok(topMatch.entry.value.includes('#FF2B2B'));

  // Formatação do bloco contextual
  const block = formatMemoryContextBlock(rankedTheme, 400);
  assert.ok(block.includes('tema_visual: Preto, Branco e Vermelho (#FF2B2B)'));
  assert.ok(block.includes('Diretriz: Utilize essas informações de forma natural'));
});

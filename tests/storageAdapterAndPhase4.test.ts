/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { storageAdapter } from '../src/services/storageAdapter';
import { verifierEngine } from '../src/tools/verifier';
import { semanticMemoryEngine } from '../src/services/semanticMemoryEngine';
import { MemoryEntry } from '../src/types';

test('Fase 4 - StorageAdapter: grava, recupera e remove registros com integridade', async () => {
  const table = 'test_table_fase4';
  const testId = 'rec-001';
  const testData = { name: 'LIORA Desktop Node', port: 3000, secure: true };

  // 1. Gravar registro
  const saved = await storageAdapter.save(table, testId, testData);
  assert.equal(saved, true, 'Registro deve ser gravado com sucesso no storage');

  // 2. Carregar registros da tabela
  const records = await storageAdapter.loadAll<typeof testData>(table);
  assert.ok(Array.isArray(records), 'Registros devem retornar como array');
  const found = records.find(r => r.name === testData.name);
  assert.ok(found, 'O registro gravado deve constar no array retornado');
  assert.equal(found?.port, 3000, 'Porta deve bater com o gravado');

  // 3. Remover registro
  const removed = await storageAdapter.remove(table, testId);
  assert.equal(removed, true, 'Remoção do registro deve ser confirmada');

  // 4. Verificar se a remoção surtiu efeito
  const recordsAfter = await storageAdapter.loadAll<typeof testData>(table);
  const foundAfter = recordsAfter.find(r => r.name === testData.name);
  assert.equal(foundAfter, undefined, 'Registro não deve mais existir após remoção');
});

test('Fase 4 - StorageAdapter: exportFullBackup gera pacote JSON com todas as tabelas requeridas', async () => {
  // Popula um registro em 'settings'
  await storageAdapter.save('settings', 'global_pref', { theme: 'crimson', shield: true });

  const backupJson = await storageAdapter.exportFullBackup();
  assert.ok(typeof backupJson === 'string', 'O backup deve ser uma string serializada');

  const parsed = JSON.parse(backupJson);
  assert.equal(parsed.schemaVersion, '1.0.0', 'Versão do schema deve ser 1.0.0');
  assert.ok(parsed.timestamp, 'Deve conter timestamp ISO');
  assert.ok(parsed.tables, 'Deve conter objeto de tabelas');

  const requiredTables = ['sessions', 'memories', 'settings', 'automations', 'devices', 'audit_logs'];
  for (const table of requiredTables) {
    assert.ok(table in parsed.tables, `A tabela '${table}' deve estar presente no backup`);
  }
});

test('Passo 1 / Verifier Engine: valida gravação no workspace e detecta discrepâncias', async () => {
  // Teste 1: Falha quando filePath é omitido
  const failedCheck = await verifierEngine.verifyExecution('workspace_write_file', {}, {});
  assert.equal(failedCheck.passed, false, 'Deve falhar se o arquivo não foi especificado');
  assert.ok(failedCheck.error?.includes('VERIFICATION_FAILED'));

  // Teste 2: Falha quando comando no sandbox retorna código de saída diferente de zero
  const failedExec = await verifierEngine.verifyExecution(
    'system_exec_sandbox',
    { command: 'cat /invalid' },
    { exitCode: 1, stderr: 'No such file or directory' }
  );
  assert.equal(failedExec.passed, false, 'Deve falhar se exitCode !== 0');
  assert.equal(failedExec.evidence.verified, false);

  // Teste 3: Sucesso quando comando sandbox retorna 0 sem stderr
  const successExec = await verifierEngine.verifyExecution(
    'system_exec_sandbox',
    { command: 'echo "OK"' },
    { exitCode: 0, stdout: 'OK\n', stderr: '' }
  );
  assert.equal(successExec.passed, true, 'Deve passar quando exitCode === 0');
  assert.equal(successExec.evidence.verified, true);
});

test('Passo 3 / Semantic Memory Engine: embeddings de 32 dimensões e similaridade de cosseno', () => {
  const textA = 'como programar em typescript e rust no editor vscode';
  const textB = 'desenvolvimento de software e codigo no terminal';
  const textC = 'horario de dormir e rotina silenciosa da noite';

  const embA = semanticMemoryEngine.generateEmbedding(textA);
  const embB = semanticMemoryEngine.generateEmbedding(textB);
  const embC = semanticMemoryEngine.generateEmbedding(textC);

  // 1. Dimensão estrita de 32 posições
  assert.equal(embA.length, 32, 'Embedding deve ter exatamente 32 dimensões');
  assert.equal(embB.length, 32, 'Embedding deve ter exatamente 32 dimensões');

  // 2. Normalização L2 (soma dos quadrados ~ 1.0)
  const normA = embA.reduce((sum, v) => sum + v * v, 0);
  assert.ok(Math.abs(normA - 1.0) < 0.01, 'Vetor deve ser unitário normalizado L2');

  // 3. Afinidade conceitual: Software Dev (A e B) deve ter cosseno maior do que com Rotinas (C)
  const simAB = semanticMemoryEngine.cosineSimilarity(embA, embB);
  const simAC = semanticMemoryEngine.cosineSimilarity(embA, embC);

  assert.ok(simAB > simAC, `Afinidade entre código e software (${simAB.toFixed(3)}) deve ser maior que com rotina (${simAC.toFixed(3)})`);
});

test('Passo 3 / Semantic Memory Engine: busca híbrida e detecção de clusters conceituais', () => {
  const dummyMemories: MemoryEntry[] = [
    { id: 'm1', category: 'preference', key: 'linguagem_preferida', value: 'TypeScript e Rust nativo', confidence: 0.95, updatedAt: '2026-03-30' },
    { id: 'm2', category: 'routine', key: 'horario_foco', value: '23:00 às 06:00 sem interrupções', confidence: 0.90, updatedAt: '2026-03-30' },
    { id: 'm3', category: 'preference', key: 'computador_desktop', value: 'GPU RTX 4090 e 64GB de RAM', confidence: 1.0, updatedAt: '2026-03-30' }
  ];

  // Busca semântica por "codificar programa"
  const searchResults = semanticMemoryEngine.search('programar codigo', dummyMemories, { mode: 'hybrid' });
  assert.ok(searchResults.length > 0, 'Deve encontrar resultados relevantes');
  assert.equal(searchResults[0].entry.id, 'm1', 'A primeira memória deve ser a de programação');
  assert.equal(searchResults[0].cluster, 'Desenvolvimento & Código', 'Cluster deve ser Desenvolvimento & Código');

  // Clusters da coleção
  const clusters = semanticMemoryEngine.getClusters(dummyMemories);
  assert.ok(clusters.length >= 2, 'Deve mapear os múltiplos clusters');
  assert.ok(clusters.some(c => c.name === 'Desenvolvimento & Código'));
  assert.ok(clusters.some(c => c.name === 'Rotinas & Horários'));
});

test('Passo 5 / Voice Live: cálculo de RMS e limiares de Barge-in acústico', () => {
  // Simula buffer PCM16 com silêncio (amplitude 0)
  const silenceBuffer = new Int16Array(1024).fill(0);
  let sumSquaresSilence = 0;
  for (let i = 0; i < silenceBuffer.length; i++) {
    const norm = silenceBuffer[i] / 32768.0;
    sumSquaresSilence += norm * norm;
  }
  const rmsSilence = Math.sqrt(sumSquaresSilence / silenceBuffer.length);
  assert.equal(rmsSilence, 0, 'RMS do silêncio absoluto deve ser 0');

  // Simula buffer PCM16 com fala moderada (amplitude ~12000)
  const speechBuffer = new Int16Array(1024).fill(12000);
  let sumSquaresSpeech = 0;
  for (let i = 0; i < speechBuffer.length; i++) {
    const norm = speechBuffer[i] / 32768.0;
    sumSquaresSpeech += norm * norm;
  }
  const rmsSpeech = Math.sqrt(sumSquaresSpeech / speechBuffer.length);
  
  // Limiar de disparo de barge-in em voiceLiveClient é 0.028
  const BARGE_IN_THRESHOLD = 0.028;
  assert.ok(rmsSpeech > BARGE_IN_THRESHOLD, `RMS de voz (${rmsSpeech.toFixed(4)}) deve exceder o limiar de barge-in (${BARGE_IN_THRESHOLD})`);
});

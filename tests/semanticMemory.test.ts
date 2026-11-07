/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Suíte de Testes Unitários: Módulo de Memória Semântica Avançada (Vector DB + SQLite)
 */

import test from 'node:test';
import assert from 'node:assert';
import { VectorStore } from '../src/services/memory/vectorStore';
import { MarkdownMemorySync } from '../src/services/memory/markdownSync';
import { SemanticMemoryService } from '../src/services/memory/semanticMemoryService';
import { semanticMemoryEngine } from '../src/services/semanticMemoryEngine';
import {
  nativeMemorySemanticSearchTool,
  nativeMemoryStoreFactTool,
  nativeMemoryListContextTool
} from '../src/tools/nativeServerTools';
import { MemoryEntry } from '../src/types';

test('MEM-01: VectorStore - Indexação vetorial e busca por similaridade de cosseno', async () => {
  const store = new VectorStore('test_vectors');
  await store.clear();

  // 1. Indexa memórias conceituais
  await store.upsert('v1', 'Jhonatan desenvolve sistemas em Rust e TypeScript', 'project');
  await store.upsert('v2', 'O usuário prefere interface no tema Crimson escuro', 'preference');
  await store.upsert('v3', 'Horário de sono e silêncio das 23h às 07h da manhã', 'routine');

  assert.strictEqual(store.size, 3, 'Deve conter 3 vetores indexados');

  // 2. Busca semântica por código e engenharia
  const devResults = store.search('programação software compilação código', { topK: 1, threshold: 0.2 });
  assert.ok(devResults.length > 0, 'Deve encontrar resultados relevantes');
  assert.strictEqual(devResults[0].record.id, 'v1', 'O vetor mais similar deve ser v1 (desenvolvimento)');
  assert.ok(devResults[0].similarity > 0.5, 'Similaridade de cosseno deve ser expressiva (> 0.5)');

  // 3. Busca semântica por interface visual
  const uiResults = store.search('cores visual layout aparência dark', { topK: 1 });
  assert.strictEqual(uiResults[0].record.id, 'v2', 'O vetor mais similar deve ser v2 (tema Crimson)');

  // 4. Exclusão de vetor
  const deleted = await store.delete('v3');
  assert.strictEqual(deleted, true);
  assert.strictEqual(store.size, 2);
});

test('MEM-02: MarkdownMemorySync - Serialização e parsing bidirecional de Markdown', async () => {
  const sync = new MarkdownMemorySync();

  const entries: MemoryEntry[] = [
    {
      id: 'm1',
      category: 'project',
      key: 'linguagem_principal',
      value: 'Rust & TypeScript',
      confidence: 1.0,
      updatedAt: '2026-11-03T00:00:00.000Z'
    },
    {
      id: 'm2',
      category: 'project',
      key: 'arquitetura',
      value: 'Tauri + React Local-First',
      confidence: 0.95,
      updatedAt: '2026-11-03T00:00:00.000Z'
    }
  ];

  // 1. Serializa para Markdown
  const markdown = sync.serializeToMarkdown('Projetos Ativos', entries);
  assert.ok(markdown.includes('# Projetos Ativos'), 'Cabeçalho deve estar presente');
  assert.ok(markdown.includes('- **linguagem_principal**: Rust & TypeScript'));
  assert.ok(markdown.includes('- **arquitetura**: Tauri + React Local-First'));

  // 2. Converte Markdown de volta em entradas estruturadas
  const parsed = sync.parseMarkdown(markdown, 'project');
  assert.strictEqual(parsed.length, 2, 'Deve reconstruir 2 entradas de memória');
  assert.strictEqual(parsed[0].key, 'linguagem_principal');
  assert.strictEqual(parsed[0].value, 'Rust & TypeScript');
  assert.strictEqual(parsed[1].key, 'arquitetura');
  assert.strictEqual(parsed[1].value, 'Tauri + React Local-First');
});

test('MEM-03: SemanticMemoryService - Inserção, busca híbrida e prompt contextual', async () => {
  const vectorStore = new VectorStore('test_service_vectors');
  const markdownSync = new MarkdownMemorySync();
  const service = new SemanticMemoryService(vectorStore, markdownSync);

  // 1. Armazena fatos estruturados
  const fact1 = await service.storeFact('fact', 'estudo_idiomas', 'Jhonatan estuda russo e programação paralela OpenMP', 1.0);
  assert.ok(fact1.id.startsWith('mem_'));
  assert.strictEqual(fact1.key, 'estudo_idiomas');

  const fact2 = await service.storeFact('preference', 'modo_resposta', 'Respostas diretas, sem enrolação e com autoridade técnica', 0.95);
  assert.ok(fact2.id);

  // 2. Busca híbrida (vetor + léxico)
  const searchResults = service.search('língua russa estudos de computação', { threshold: 0.25, maxResults: 3 });
  assert.ok(searchResults.length > 0, 'Deve retornar correspondências semânticas');
  assert.strictEqual(searchResults[0].entry.key, 'estudo_idiomas');

  // 3. Geração de contexto para prompt do sistema
  const promptContext = service.getContextPrompt('quais são meus estudos de idiomas?');
  assert.ok(promptContext.includes('[SISTEMA - MEMÓRIA CONTEXTUAL RECUPERADA]'), 'Deve conter o cabeçalho contextual');
  assert.ok(promptContext.includes('estudo_idiomas: Jhonatan estuda russo e programação paralela OpenMP'));
});

test('MEM-04: Ferramentas Nativas de Memória (memory_semantic_search, memory_store_fact, memory_list_context)', async () => {
  // 1. Validação de esquema e metadados
  assert.strictEqual(nativeMemorySemanticSearchTool.name, 'memory_semantic_search');
  assert.strictEqual(nativeMemorySemanticSearchTool.riskLevel, 'R0');
  assert.strictEqual(nativeMemorySemanticSearchTool.isSimulated, false);

  assert.strictEqual(nativeMemoryStoreFactTool.name, 'memory_store_fact');
  assert.strictEqual(nativeMemoryStoreFactTool.riskLevel, 'R1');
  assert.strictEqual(nativeMemoryStoreFactTool.isSimulated, false);

  assert.strictEqual(nativeMemoryListContextTool.name, 'memory_list_context');
  assert.strictEqual(nativeMemoryListContextTool.riskLevel, 'R0');
  assert.strictEqual(nativeMemoryListContextTool.isSimulated, false);

  // 2. Execução do memory_store_fact
  const storeRes = await nativeMemoryStoreFactTool.execute({
    category: 'fact',
    key: 'veiculo_atual',
    value: 'Carro conectado equipado com scanner OBD-II Bluetooth',
    confidence: 1.0
  });
  assert.strictEqual(storeRes.success, true);
  assert.strictEqual(storeRes.entry.key, 'veiculo_atual');

  // 3. Execução do memory_semantic_search
  const searchRes = await nativeMemorySemanticSearchTool.execute({
    query: 'telemetria automotiva e diagnóstico de carro',
    threshold: 0.15
  });
  assert.strictEqual(searchRes.simulated, false);
  assert.ok(searchRes.count >= 1, 'Deve encontrar a memória armazenada sobre o veículo');
  assert.ok(searchRes.matches.some((m: { key: string }) => m.key === 'veiculo_atual'));

  // 4. Execução do memory_list_context
  const contextRes = await nativeMemoryListContextTool.execute({
    query: 'carro e telemetria',
    maxCharacters: 400
  });
  assert.strictEqual(contextRes.simulated, false);
  assert.ok(typeof contextRes.contextBlock === 'string');
});

test('MEM-05: SemanticMemoryEngine - Projeção vetorial determinística de 32 dimensões', () => {
  const text1 = 'Desenvolvimento com React e Vite na interface';
  const text2 = 'Desenvolvimento com React e Vite na interface';
  const text3 = 'Alarme às 7 da manhã para acordar';

  const vec1 = semanticMemoryEngine.generateEmbedding(text1);
  const vec2 = semanticMemoryEngine.generateEmbedding(text2);
  const vec3 = semanticMemoryEngine.generateEmbedding(text3);

  assert.strictEqual(vec1.length, 32, 'Vetor deve ter exatamente 32 dimensões');
  assert.deepStrictEqual(vec1, vec2, 'A projeção para o mesmo texto deve ser 100% determinística');

  const simIdentical = semanticMemoryEngine.cosineSimilarity(vec1, vec2);
  assert.ok(Math.abs(simIdentical - 1.0) < 0.001, 'Textos idênticos devem ter similaridade ~1.0');

  const simDifferent = semanticMemoryEngine.cosineSimilarity(vec1, vec3);
  assert.ok(simDifferent < simIdentical, 'Textos com tópicos divergentes devem ter similaridade inferior');
});


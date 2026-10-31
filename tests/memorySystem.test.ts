/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { useLioraStore, MEMORIES_STORAGE_KEY } from '../src/store/lioraStore';
import { rankMemories, sanitizeMemoryValue } from '../src/utils/memoryRanker';
import { MemoryEntry } from '../src/types';

// Mock localStorage for Node environment if missing
if (typeof globalThis.localStorage === 'undefined') {
  const store: Record<string, string> = {};
  globalThis.localStorage = {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); },
    length: 0,
    key: (index: number) => Object.keys(store)[index] || null
  };
}

describe('Aba Memória & Contexto (MemorySystem Suite)', () => {
  beforeEach(() => {
    localStorage.clear();
    useLioraStore.setState({
      memoryEntries: [
        { id: 'mem-1', category: 'preference', key: 'idioma', value: 'Português Brasileiro (pt-BR)', confidence: 0.99, updatedAt: '2026-10-14' },
        { id: 'mem-2', category: 'preference', key: 'tema_visual', value: 'Preto, Branco e Vermelho (#FF2B2B)', confidence: 1.0, updatedAt: '2026-10-14' },
        { id: 'mem-3', category: 'project', key: 'diretorio_workspace', value: '/workspace/liora-core', confidence: 0.95, updatedAt: '2026-10-14' }
      ]
    });
  });

  test('MEM-01: Persistência no LocalStorage com chave liora_memories_v1', () => {
    useLioraStore.getState().addMemory({
      category: 'routine',
      key: 'horario_foco',
      value: '08:00 às 12:00',
      confidence: 0.9
    });

    const raw = localStorage.getItem(MEMORIES_STORAGE_KEY);
    assert.ok(raw, 'Deveria existir a chave liora_memories_v1 no LocalStorage');

    const parsed = JSON.parse(raw!);
    assert.ok(Array.isArray(parsed), 'O cofre salvo deve ser uma lista JSON');
    assert.strictEqual(parsed[0].key, 'horario_foco');
  });

  test('MEM-02: Deduplicação automática ao adicionar chave com mesmo nome (case-insensitive)', () => {
    const initialCount = useLioraStore.getState().memoryEntries.length;

    // Adicionar 'IDIOMA' em maiúsculo (já existe 'idioma')
    useLioraStore.getState().addMemory({
      category: 'preference',
      key: 'IDIOMA',
      value: 'English (US)',
      confidence: 1.0
    });

    const memories = useLioraStore.getState().memoryEntries;
    assert.strictEqual(memories.length, initialCount, 'A contagem total de memórias não deve aumentar em caso de chave duplicada');
    
    const target = memories.find(m => m.key.toLowerCase() === 'idioma');
    assert.ok(target, 'A chave idioma deve existir');
    assert.strictEqual(target.value, 'English (US)', 'O valor da chave deve ter sido atualizado');
  });

  test('MEM-03: Edição e atualização de memórias (updateMemory)', () => {
    useLioraStore.getState().updateMemory('mem-1', {
      value: 'Español (ES)',
      category: 'preference'
    });

    const updated = useLioraStore.getState().memoryEntries.find(m => m.id === 'mem-1');
    assert.ok(updated);
    assert.strictEqual(updated.value, 'Español (ES)');
    assert.strictEqual(updated.updatedAt, new Date().toISOString().split('T')[0]);
  });

  test('MEM-04: Importação em lote de cofre (importMemories)', () => {
    const importData: MemoryEntry[] = [
      { id: 'imp-1', category: 'fact', key: 'autor', value: 'Engenheiro LIORA', confidence: 1.0, updatedAt: '2026-10-22' },
      { id: 'imp-2', category: 'project', key: 'framework', value: 'Vite + React + Express', confidence: 1.0, updatedAt: '2026-10-22' }
    ];

    useLioraStore.getState().importMemories(importData, 'merge');

    const memories = useLioraStore.getState().memoryEntries;
    assert.strictEqual(memories.length, 5, 'Deveria combinar os 3 existentes com os 2 importados');
  });

  test('MEM-05: Sanitização de segredos e rankeamento com memoryRanker.ts', () => {
    const secretRes = sanitizeMemoryValue('GEMINI_KEY', 'AIzaSyD1234567890abcdefghijklmnopqrstuvw');
    assert.strictEqual(secretRes.sanitizedValue, '[REDACTED_SECURITY_SECRET]');

    const ranked = rankMemories('qual o idioma do sistema?', useLioraStore.getState().memoryEntries);
    assert.ok(ranked.length > 0);
    assert.strictEqual(ranked[0].entry.key, 'idioma');
  });
});

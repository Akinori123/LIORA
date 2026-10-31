/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { useLioraStore, MEMORIES_STORAGE_KEY, ACTIVITY_LOGS_STORAGE_KEY, MAX_ACTIVITY_LOGS } from '../src/store/lioraStore';
import { rankMemories, sanitizeMemoryValue } from '../src/utils/memoryRanker';
import { compressConversationHistory } from '../src/utils/chatContext';
import { MemoryEntry, ChatMessage } from '../src/types';

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

describe('Frente 3: Aprendizado Local, Memória Persistente e Custo Zero (LocalMemoryEconomy Suite)', () => {
  beforeEach(() => {
    localStorage.clear();
    useLioraStore.setState({
      memoryEntries: [
        { id: 'm-1', category: 'preference', key: 'idioma_preferido', value: 'Português Brasileiro', confidence: 0.99, updatedAt: '2026-10-24' },
        { id: 'm-2', category: 'project', key: 'stack_principal', value: 'React + Vite + TypeScript + Tailwind + Tauri', confidence: 1.0, updatedAt: '2026-10-24' },
        { id: 'm-3', category: 'fact', key: 'diretorio_raiz', value: '/app/applet', confidence: 0.95, updatedAt: '2026-10-24' }
      ],
      activityLogs: []
    });
  });

  test('LME-01: Sistema de Memória Adaptativa Local-First e Busca Contextual', () => {
    const memories = useLioraStore.getState().memoryEntries;
    const ranked = rankMemories('qual a stack e o framework do projeto?', memories, { minScoreThreshold: 0.2 });
    
    assert.ok(ranked.length > 0, 'Deveria retornar memórias rankeadas relevantes');
    assert.strictEqual(ranked[0].entry.key, 'stack_principal');
  });

  test('LME-02: Sanitização de Segredos e Credenciais em Memória Local', () => {
    const res = sanitizeMemoryValue('GEMINI_API_KEY', 'AIzaSyD1234567890abcdefghijklmnopqrstuvw');
    assert.strictEqual(res.sanitizedValue, '[REDACTED_SECURITY_SECRET]');
    assert.strictEqual(res.isRedacted, true);
  });

  test('LME-03: Compressão Dinâmica do Histórico de Conversa (Token Economy)', () => {
    const manyMessages: ChatMessage[] = [];
    for (let i = 1; i <= 35; i++) {
      manyMessages.push({
        id: `msg-${i}`,
        sender: i % 2 === 1 ? 'user' : 'assistant',
        text: `Mensagem de teste número ${i} sobre arquitetura e otimização de sistema.`,
        timestamp: '12:00',
        status: 'completed'
      });
    }

    const { activeMessages, summaryBlock } = compressConversationHistory(manyMessages, 15);

    assert.strictEqual(activeMessages.length, 15, 'Deve manter exatamente o número configurado de mensagens recentes');
    assert.ok(summaryBlock, 'Deve gerar um bloco de síntese executiva para o histórico antigo');
    assert.ok(summaryBlock.includes('35 mensagens') || summaryBlock.includes('20 mensagens') || summaryBlock.includes('Síntese Executiva'), 'O bloco de síntese deve referenciar o histórico comprimido');
  });

  test('LME-04: Gerenciamento do Ring Buffer Forense de Atividades (/activity) com Teto de 1000 Eventos', () => {
    const store = useLioraStore.getState();
    assert.strictEqual(MAX_ACTIVITY_LOGS, 1000, 'O teto rigoroso do Ring Buffer na RAM deve ser 1000 eventos');

    // Inserir 1050 eventos simulados
    for (let i = 1; i <= 1050; i++) {
      store.addActivityLog({
        category: 'system',
        summary: `Evento de auditoria #${i}`,
        details: `Detalhes do evento forense ${i}`,
        riskLevel: 'R0',
        status: 'success',
        simulated: false
      });
    }

    const currentLogs = useLioraStore.getState().activityLogs;
    assert.strictEqual(currentLogs.length, 1000, 'O Ring Buffer deve limitar estritamente a 1000 eventos em memória RAM');
    assert.strictEqual(currentLogs[0].summary, 'Evento de auditoria #1050', 'O log mais recente deve estar no topo');

    const rawPersisted = localStorage.getItem(ACTIVITY_LOGS_STORAGE_KEY);
    assert.ok(rawPersisted, 'Os logs devem ser persistidos em lotes no armazenamento local');
    const parsedPersisted = JSON.parse(rawPersisted);
    assert.strictEqual(parsedPersisted.length, 1000);
  });
});

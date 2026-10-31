/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { useLioraStore } from '../src/store/lioraStore.ts';
import { 
  loadHistory, 
  saveHistory, 
  clearStoredHistory, 
  PRIMARY_STORAGE_KEY, 
  CURRENT_SCHEMA_VERSION, 
  sanitizeSession,
  sanitizeChatMessage 
} from '../src/utils/historyStorage.ts';
import { ChatMessage, ConversationSession } from '../src/types.ts';

// In-memory Storage mock compliant with Web Storage API
class MockStorage implements Storage {
  private data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

// Ensure globalThis.localStorage exists in Node test environment
const mockStorage = new MockStorage();
(globalThis as any).localStorage = mockStorage;

// Helper to create SSE stream responses for fetch mocking
function createMockSseResponse(chunks: string[], delayMs = 5) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const text of chunks) {
        if (delayMs > 0) {
          await new Promise(r => setTimeout(r, delayMs));
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk: text })}\n\n`));
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
      controller.close();
    }
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  });
}

// Reset store and mock storage before testing
function resetTestEnvironment() {
  mockStorage.clear();
  useLioraStore.setState({
    sessions: [],
    activeSessionId: null,
    messages: [],
    isGenerating: false,
    activeAbortController: null
  });
}

test('AUDIT 1: Criar duas conversas com mensagens diferentes', async () => {
  resetTestEnvironment();

  const originalFetch = globalThis.fetch;
  try {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return createMockSseResponse(['Resposta para a conversa 1']);
      }
      return createMockSseResponse(['Resposta para a conversa 2']);
    };

    // Criar Conversa 1
    const id1 = useLioraStore.getState().createSession('Conversa Alfa');
    await useLioraStore.getState().sendMessage('Pergunta Alfa');

    // Criar Conversa 2
    const id2 = useLioraStore.getState().createSession('Conversa Beta');
    await useLioraStore.getState().sendMessage('Pergunta Beta');

    const state = useLioraStore.getState();
    assert.equal(state.sessions.length, 2, 'Devem existir exatamente 2 sessões');
    assert.ok(state.sessions.some(s => s.id === id1));
    assert.ok(state.sessions.some(s => s.id === id2));

    const sess1 = state.sessions.find(s => s.id === id1)!;
    const sess2 = state.sessions.find(s => s.id === id2)!;

    assert.equal(sess1.messages[0].text, 'Pergunta Alfa');
    assert.equal(sess1.messages[1].text, 'Resposta para a conversa 1');

    assert.equal(sess2.messages[0].text, 'Pergunta Beta');
    assert.equal(sess2.messages[1].text, 'Resposta para a conversa 2');

    // Verificar se o localStorage foi populado corretamente
    const stored = loadHistory();
    assert.equal(stored.sessions.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AUDIT 2: Recarregar a aplicação e recuperar ambas as conversas', () => {
  // O teste 1 persistiu as conversas no mockStorage
  // Simular recarregamento da aplicação (limpar estado de memória e re-hidratar do storage)
  useLioraStore.setState({
    sessions: [],
    activeSessionId: null,
    messages: []
  });

  // Re-hidratar a partir do armazenamento (como ocorre ao dar F5 na aplicação)
  useLioraStore.getState().reloadFromStorage();

  const restored = useLioraStore.getState();
  assert.equal(restored.sessions.length, 2, 'Ambas as conversas devem ser recuperadas após reload');
  
  const alfa = restored.sessions.find(s => s.title === 'Conversa Alfa');
  const beta = restored.sessions.find(s => s.title === 'Conversa Beta');

  assert.ok(alfa, 'Conversa Alfa deve existir após reload');
  assert.ok(beta, 'Conversa Beta deve existir após reload');
  assert.equal(alfa.messages.length, 2);
  assert.equal(beta.messages.length, 2);
});

test('AUDIT 3: Abrir cada conversa e confirmar que suas mensagens estão estritamente isoladas', () => {
  const store = useLioraStore.getState();
  const alfa = store.sessions.find(s => s.title === 'Conversa Alfa')!;
  const beta = store.sessions.find(s => s.title === 'Conversa Beta')!;

  // Abrir Alfa
  useLioraStore.getState().openSession(alfa.id);
  assert.equal(useLioraStore.getState().activeSessionId, alfa.id);
  const alfaActiveMsgs = useLioraStore.getState().messages;
  assert.equal(alfaActiveMsgs.length, 2);
  assert.equal(alfaActiveMsgs[0].text, 'Pergunta Alfa');
  assert.ok(!alfaActiveMsgs.some(m => m.text.includes('Beta')), 'Mensagens de Beta não devem vazar para Alfa');

  // Abrir Beta
  useLioraStore.getState().openSession(beta.id);
  assert.equal(useLioraStore.getState().activeSessionId, beta.id);
  const betaActiveMsgs = useLioraStore.getState().messages;
  assert.equal(betaActiveMsgs.length, 2);
  assert.equal(betaActiveMsgs[0].text, 'Pergunta Beta');
  assert.ok(!betaActiveMsgs.some(m => m.text.includes('Alfa')), 'Mensagens de Alfa não devem vazar para Beta');

  // Confirmar que o activeSessionId persistido no storage é o de Beta
  const stored = loadHistory();
  assert.equal(stored.activeSessionId, beta.id);
});

test('AUDIT 4: Acrescentar mensagens e confirmar que são salvas no armazenamento', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      return createMockSseResponse(['Resposta adicional para Beta']);
    };

    const betaId = useLioraStore.getState().activeSessionId!;
    await useLioraStore.getState().sendMessage('Segunda pergunta para Beta');

    // Verificar mensagens na sessão ativa
    const currentMsgs = useLioraStore.getState().messages;
    assert.equal(currentMsgs.length, 4, 'Beta agora deve ter 4 mensagens');
    assert.equal(currentMsgs[2].text, 'Segunda pergunta para Beta');
    assert.equal(currentMsgs[3].text, 'Resposta adicional para Beta');

    // Verificar diretamente no storage persistido
    const stored = loadHistory();
    const storedBeta = stored.sessions.find(s => s.id === betaId)!;
    assert.equal(storedBeta.messages.length, 4, 'Mensagens adicionais devem ser salvas no storage');
    assert.equal(storedBeta.messages[3].text, 'Resposta adicional para Beta');

    // Confirmar que Alfa continuou intacta no storage com 2 mensagens
    const storedAlfa = stored.sessions.find(s => s.title === 'Conversa Alfa')!;
    assert.equal(storedAlfa.messages.length, 2, 'Alfa não deve sofrer alteração');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AUDIT 5: Excluir uma conversa e confirmar que ela não reaparece após novo carregamento', () => {
  const store = useLioraStore.getState();
  const alfa = store.sessions.find(s => s.title === 'Conversa Alfa')!;
  
  // Excluir Conversa Alfa
  useLioraStore.getState().deleteSession(alfa.id);

  // Verificar que Alfa foi removida do store
  assert.ok(!useLioraStore.getState().sessions.some(s => s.id === alfa.id));

  // Simular novo recarregamento
  useLioraStore.setState({ sessions: [], activeSessionId: null, messages: [] });
  useLioraStore.getState().reloadFromStorage();

  const reloaded = useLioraStore.getState();
  assert.ok(!reloaded.sessions.some(s => s.id === alfa.id), 'Conversa excluída não pode reaparecer no reload');
  assert.equal(reloaded.sessions.length, 1);
  assert.equal(reloaded.sessions[0].title, 'Conversa Beta');
});

test('AUDIT 6: Garantir que a exclusão da conversa ativa selecione outra conversa válida ou retorne ao estado inicial sem erros', () => {
  resetTestEnvironment();

  // Criar três conversas: C1, C2, C3
  const id1 = useLioraStore.getState().createSession('C1');
  const id2 = useLioraStore.getState().createSession('C2');
  const id3 = useLioraStore.getState().createSession('C3');

  // C3 é a ativa atualmente
  assert.equal(useLioraStore.getState().activeSessionId, id3);

  // Caso A: Excluir C3 (ativa). Deve selecionar outra conversa válida (C2 ou C1)
  useLioraStore.getState().deleteSession(id3);
  const nextActiveId = useLioraStore.getState().activeSessionId;
  assert.ok(nextActiveId === id2 || nextActiveId === id1, 'Deve selecionar outra conversa válida');
  assert.equal(useLioraStore.getState().sessions.length, 2);

  // Caso B: Excluir restantes até a última
  useLioraStore.getState().deleteSession(id2);
  assert.equal(useLioraStore.getState().activeSessionId, id1);

  // Excluir a última conversa (C1)
  useLioraStore.getState().deleteSession(id1);

  // Deve retornar ao estado inicial seguro com uma nova sessão padrão limpa, sem null/undefined ou crash
  const stateAfterLastDelete = useLioraStore.getState();
  assert.equal(stateAfterLastDelete.sessions.length, 1, 'Deve criar sessão limpa ao deletar última');
  assert.ok(typeof stateAfterLastDelete.activeSessionId === 'string' && stateAfterLastDelete.activeSessionId.length > 0);
  assert.equal(stateAfterLastDelete.messages.length, 0);

  // Verificar que o storage sobreviveu e tem a sessão padrão
  const stored = loadHistory();
  assert.equal(stored.sessions.length, 1);
});

test('AUDIT 7: Simular uma resposta interrompida ou incompleta e confirmar que ela é persistida corretamente sem corromper', async () => {
  resetTestEnvironment();

  const originalFetch = globalThis.fetch;
  try {
    const encoder = new TextEncoder();

    // Mock stream que envia o primeiro chunk e aguarda abort
    globalThis.fetch = async (_url, options: any) => {
      const signal = options?.signal as AbortSignal;
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk: 'Início da resposta da IA...' })}\n\n`));
          
          // Espera abort do usuário
          signal.addEventListener('abort', () => {
            controller.error(new DOMException('The user aborted a request.', 'AbortError'));
          });
        }
      });

      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    };

    const sessId = useLioraStore.getState().createSession('Sessão Interrupção');
    
    // Inicia envio de mensagem
    const sendPromise = useLioraStore.getState().sendMessage('Gere um plano complexo');

    // Aguarda primeiro chunk ser processado e interrompe
    await new Promise(r => setTimeout(r, 40));
    useLioraStore.getState().abortGeneration();

    await sendPromise;

    const msgs = useLioraStore.getState().messages;
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].sender, 'user');
    assert.equal(msgs[1].sender, 'assistant');
    assert.equal(msgs[1].status, 'cancelled', 'Mensagem deve ter status cancelled');
    assert.match(msgs[1].text, /Geração interrompida/);

    // Verificar se a mensagem cancelada foi salva corretamente no storage sem corromper o JSON
    const stored = loadHistory();
    const targetSession = stored.sessions.find(s => s.id === sessId)!;
    assert.equal(targetSession.messages.length, 2);
    assert.equal(targetSession.messages[1].status, 'cancelled');

    // Simular reload e confirmar persistência íntegra
    useLioraStore.setState({ sessions: [], activeSessionId: null, messages: [] });
    useLioraStore.getState().reloadFromStorage();
    const afterReload = useLioraStore.getState();
    assert.equal(afterReload.messages[1].status, 'cancelled');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AUDIT 8: Simular falha de rede/API e confirmar que o erro é registrado sem perda das mensagens anteriores', async () => {
  resetTestEnvironment();

  const originalFetch = globalThis.fetch;
  try {
    let shouldFail = false;
    globalThis.fetch = async () => {
      if (shouldFail) {
        // Simular falha de rede (TypeError: Failed to fetch)
        throw new TypeError('Failed to fetch');
      }
      return createMockSseResponse(['Primeira mensagem respondida com sucesso.']);
    };

    const sessId = useLioraStore.getState().createSession('Sessão Falha de Rede');
    
    // Mensagem 1 - Sucesso
    await useLioraStore.getState().sendMessage('Mensagem inicial importante');
    assert.equal(useLioraStore.getState().messages.length, 2);

    // Ativar falha de rede para a mensagem 2
    shouldFail = true;
    await useLioraStore.getState().sendMessage('Segunda mensagem que falhará na rede');

    const msgs = useLioraStore.getState().messages;
    assert.equal(msgs.length, 4, 'Todas as 4 mensagens devem estar preservadas');
    assert.equal(msgs[0].text, 'Mensagem inicial importante');
    assert.equal(msgs[1].text, 'Primeira mensagem respondida com sucesso.');
    assert.equal(msgs[2].text, 'Segunda mensagem que falhará na rede');
    
    // Mensagem 4 é a falha do assistente
    assert.equal(msgs[3].status, 'error', 'Mensagem 4 deve registrar status de erro');
    assert.equal(msgs[3].errorCode, 'NETWORK_ERROR');
    assert.ok(msgs[3].errorMessage && msgs[3].errorMessage.length > 0);

    // Verificar no armazenamento: histórico anterior intacto
    const stored = loadHistory();
    const storedSess = stored.sessions.find(s => s.id === sessId)!;
    assert.equal(storedSess.messages.length, 4);
    assert.equal(storedSess.messages[0].text, 'Mensagem inicial importante');
    assert.equal(storedSess.messages[1].text, 'Primeira mensagem respondida com sucesso.');
    assert.equal(storedSess.messages[3].errorCode, 'NETWORK_ERROR');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AUDIT 9: Integridade do formato e robustez contra dados corrompidos ou IDs inexistentes', () => {
  resetTestEnvironment();

  // 1. Validar estrutura do schema serializado
  const sampleSessions: ConversationSession[] = [
    {
      id: 'sess-integrity-1',
      title: 'Conversa de Teste',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        { id: 'm1', sender: 'user', text: 'Olá', timestamp: '10:00', status: 'completed' }
      ]
    }
  ];

  const saveRes = saveHistory(sampleSessions, 'sess-integrity-1');
  assert.equal(saveRes.success, true);
  assert.ok(saveRes.bytesWritten && saveRes.bytesWritten > 0);

  // Inspecionar o JSON gravado no storage
  const rawString = mockStorage.getItem(PRIMARY_STORAGE_KEY)!;
  assert.ok(rawString);
  const parsed = JSON.parse(rawString);
  assert.equal(parsed.version, CURRENT_SCHEMA_VERSION);
  assert.equal(parsed.activeSessionId, 'sess-integrity-1');
  assert.ok(Array.isArray(parsed.sessions));
  assert.ok(parsed.lastSavedAt);

  // 2. Sobrevive a string corrompida no localStorage sem travar
  mockStorage.setItem(PRIMARY_STORAGE_KEY, '{ invalid json malformed data :::');
  const corruptedResult = loadHistory();
  assert.deepEqual(corruptedResult, { sessions: [], activeSessionId: null }, 'Deve recuperar estado seguro sem exception');

  // 3. Sobrevive a payload vazio ou tipo incorreto
  mockStorage.setItem(PRIMARY_STORAGE_KEY, 'null');
  assert.deepEqual(loadHistory(), { sessions: [], activeSessionId: null });

  mockStorage.setItem(PRIMARY_STORAGE_KEY, '"uma string qualquer"');
  assert.deepEqual(loadHistory(), { sessions: [], activeSessionId: null });

  // 4. Sobrevive a campos faltantes ou mensagens malformadas com sanitização
  const malformedPayload = {
    version: 1,
    activeSessionId: 'sess-x',
    sessions: [
      null,
      {},
      { id: 'sess-x', title: 123, messages: [null, { text: 456 }] }
    ]
  };
  mockStorage.setItem(PRIMARY_STORAGE_KEY, JSON.stringify(malformedPayload));
  const sanitizedLoad = loadHistory();
  assert.equal(sanitizedLoad.sessions.length, 1);
  assert.equal(sanitizedLoad.sessions[0].id, 'sess-x');
  assert.equal(typeof sanitizedLoad.sessions[0].title, 'string');
  assert.equal(sanitizedLoad.sessions[0].messages.length, 1);

  // 5. Chamada de openSession com ID inexistente não trava a aplicação
  useLioraStore.setState({ sessions: sampleSessions, activeSessionId: 'sess-integrity-1' });
  useLioraStore.getState().openSession('id-totalmente-inexistente-9999');
  assert.equal(useLioraStore.getState().activeSessionId, 'sess-integrity-1', 'ID inexistente deve ser ignorado com segurança');
});

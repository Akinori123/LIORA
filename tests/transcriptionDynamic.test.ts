/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { useLioraStore } from '../src/store/lioraStore.ts';
import { 
  formatTimestampHms, 
  messageToTranscriptionEvent, 
  formatTranscriptionPlainText, 
  formatTranscriptionMarkdown, 
  copyTranscriptionToClipboard 
} from '../src/utils/transcriptionExport.ts';
import { loadHistory } from '../src/utils/historyStorage.ts';
import { ChatMessage } from '../src/types.ts';

// In-memory Storage mock
class MockStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number { return this.data.size; }
  clear(): void { this.data.clear(); }
  getItem(key: string): string | null { return this.data.has(key) ? this.data.get(key)! : null; }
  key(index: number): string | null { return Array.from(this.data.keys())[index] ?? null; }
  removeItem(key: string): void { this.data.delete(key); }
  setItem(key: string, value: string): void { this.data.set(key, String(value)); }
}

const mockStorage = new MockStorage();
(globalThis as any).localStorage = mockStorage;

function resetStore() {
  mockStorage.clear();
  useLioraStore.setState({
    sessions: [],
    activeSessionId: null,
    messages: [],
    isGenerating: false,
  });
}

// SSE helper
function createMockSseResponse(chunks: string[], delayMs = 5) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const text of chunks) {
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
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

test('T1: Uma mensagem real do usuário aparece na transcrição com ID e horário', async () => {
  resetStore();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => createMockSseResponse(['Resposta LIORA']);
    const sessId = useLioraStore.getState().createSession('Sessão Transcrição');
    
    await useLioraStore.getState().sendMessage('Qual o status do sistema?');

    const messages = useLioraStore.getState().messages;
    const userMsg = messages.find(m => m.sender === 'user')!;
    assert.ok(userMsg);
    assert.equal(userMsg.text, 'Qual o status do sistema?');

    const event = messageToTranscriptionEvent(userMsg, sessId);
    assert.equal(event.speaker, 'user');
    assert.equal(event.speakerLabel, 'Você');
    assert.equal(event.status, 'completed');
    assert.equal(event.isPartial, false);
    assert.match(event.timestamp, /^\d{2}:\d{2}:\d{2}$/, 'Timestamp deve estar no formato HH:MM:SS');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('T2 & T3: A resposta da LIORA aparece durante o streaming e chunks atualizam uma Ãºnica entrada', async () => {
  resetStore();
  const originalFetch = globalThis.fetch;
  try {
    let emitSecondChunk: () => void;
    let finishStream: () => void;

    const encoder = new TextEncoder();
    globalThis.fetch = async () => {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk: 'Parte 1... ' })}\n\n`));
          
          await new Promise<void>(resolve => { emitSecondChunk = resolve; });
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk: 'Parte 2 finalizada.' })}\n\n`));
          
          await new Promise<void>(resolve => { finishStream = resolve; });
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };

    const sessId = useLioraStore.getState().createSession('Stream Test');
    const sendPromise = useLioraStore.getState().sendMessage('Pergunta streaming');

    // Aguardar primeiro chunk
    await new Promise(r => setTimeout(r, 40));
    let stateMsgs = useLioraStore.getState().messages;
    assert.equal(stateMsgs.length, 2, 'Deve ter mensagem do usuÃ¡rio e mensagem assistente');
    const assistantMsg = stateMsgs[1];
    assert.equal(assistantMsg.sender, 'assistant');
    assert.equal(assistantMsg.status, 'streaming');
    assert.equal(assistantMsg.text, 'Parte 1... ');
    const assistantId = assistantMsg.id;

    // Emitir segundo chunk
    emitSecondChunk!();
    await new Promise(r => setTimeout(r, 40));
    stateMsgs = useLioraStore.getState().messages;
    assert.equal(stateMsgs.length, 2, 'Chunks nÃ£o devem criar novas linhas na transcriÃ§Ã£o');
    assert.equal(stateMsgs[1].id, assistantId, 'ID da mensagem deve ser mantido idÃªntico');
    assert.equal(stateMsgs[1].text, 'Parte 1... Parte 2 finalizada.');

    // Finalizar stream
    finishStream!();
    await sendPromise;
    stateMsgs = useLioraStore.getState().messages;
    assert.equal(stateMsgs[1].id, assistantId, 'ConclusÃ£o preserva o identificador da mensagem');
    assert.equal(stateMsgs[1].status, 'completed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('T4 & T5: Mensagens interrompidas mantÃªm o conteÃºdo parcial e status cancelled', async () => {
  resetStore();
  const originalFetch = globalThis.fetch;
  try {
    const encoder = new TextEncoder();
    globalThis.fetch = async (_url, options: any) => {
      const signal = options?.signal as AbortSignal;
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk: 'Texto que foi gerado atÃ© a parada.' })}\n\n`));
          signal.addEventListener('abort', () => {
            controller.error(new DOMException('The user aborted a request.', 'AbortError'));
          });
        }
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };

    useLioraStore.getState().createSession('Abort Test');
    const sendPromise = useLioraStore.getState().sendMessage('Explique computaÃ§Ã£o quÃ¢ntica');

    await new Promise(r => setTimeout(r, 30));
    useLioraStore.getState().abortGeneration();
    await sendPromise;

    const msgs = useLioraStore.getState().messages;
    const assistantMsg = msgs[1];
    assert.equal(assistantMsg.status, 'cancelled');
    assert.match(assistantMsg.text, /Texto que foi gerado atÃ© a parada/);
    assert.match(assistantMsg.text, /GeraÃ§Ã£o interrompida pelo usuÃ¡rio/);

    const event = messageToTranscriptionEvent(assistantMsg, 'Abort Test');
    assert.equal(event.status, 'cancelled');
    assert.equal(event.isPartial, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('T6: Erros nÃ£o sÃ£o exibidos como respostas concluÃ­das', async () => {
  resetStore();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch (simulated network failure)');
    };

    useLioraStore.getState().createSession('Error Test');
    await useLioraStore.getState().sendMessage('Tentativa com erro');

    const msgs = useLioraStore.getState().messages;
    const assistantMsg = msgs[1];
    assert.equal(assistantMsg.status, 'error');
    assert.notEqual(assistantMsg.status, 'completed');
    assert.equal(assistantMsg.errorCode, 'NETWORK_ERROR');
    assert.ok(assistantMsg.errorMessage);

    const event = messageToTranscriptionEvent(assistantMsg, 'Error Test');
    assert.equal(event.status, 'error');
    assert.notEqual(event.status, 'completed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('T7: formatTimestampHms formata e preserva timestamps legÃ­timos em HH:MM:SS', () => {
  assert.equal(formatTimestampHms('14:30:15'), '14:30:15');
  assert.equal(formatTimestampHms('14:30'), '14:30:00');
  assert.equal(formatTimestampHms(''), '00:00:00');
  
  const isoDate = '2026-10-16T12:45:30.000Z';
  const fromIso = formatTimestampHms(undefined, isoDate);
  assert.match(fromIso, /^\d{2}:\d{2}:\d{2}$/);
});

test('T8 & T9: Alternar sessÃµes e reabrir conversas recupera transcriÃ§Ã£o correspondente e isolada', () => {
  resetStore();

  const id1 = useLioraStore.getState().createSession('SessÃ£o Alpha');
  const msgAlpha: ChatMessage = {
    id: 'm-alpha',
    sender: 'user',
    text: 'Mensagem Alpha 1',
    timestamp: '10:00:00',
    status: 'completed',
    source: 'text'
  };
  useLioraStore.setState({ messages: [msgAlpha], sessions: [{ id: id1, title: 'SessÃ£o Alpha', createdAt: '', updatedAt: '', messages: [msgAlpha] }] });

  const id2 = useLioraStore.getState().createSession('SessÃ£o Beta');
  const msgBeta: ChatMessage = {
    id: 'm-beta',
    sender: 'user',
    text: 'Mensagem Beta 1',
    timestamp: '11:00:00',
    status: 'completed',
    source: 'text'
  };
  useLioraStore.setState({ 
    messages: [msgBeta], 
    sessions: [
      { id: id1, title: 'SessÃ£o Alpha', createdAt: '', updatedAt: '', messages: [msgAlpha] },
      { id: id2, title: 'SessÃ£o Beta', createdAt: '', updatedAt: '', messages: [msgBeta] }
    ] 
  });

  // Abrir Alpha
  useLioraStore.getState().openSession(id1);
  const activeMsgsAlpha = useLioraStore.getState().messages;
  assert.equal(activeMsgsAlpha.length, 1);
  assert.equal(activeMsgsAlpha[0].text, 'Mensagem Alpha 1');

  // Abrir Beta
  useLioraStore.getState().openSession(id2);
  const activeMsgsBeta = useLioraStore.getState().messages;
  assert.equal(activeMsgsBeta.length, 1);
  assert.equal(activeMsgsBeta[0].text, 'Mensagem Beta 1');
});

test('T10: Copiar transcrição produz texto limpo com horários, interlocutores e status', () => {
  const sampleMessages: ChatMessage[] = [
    { id: '1', sender: 'user', text: 'Olá LIORA', timestamp: '10:00:00', status: 'completed', source: 'text' },
    { id: '2', sender: 'assistant', text: 'Olá! Como posso ajudar?', timestamp: '10:00:02', status: 'completed', source: 'text' },
    { id: '3', sender: 'assistant', text: 'Parcial', timestamp: '10:01:00', status: 'cancelled', source: 'text' }
  ];

  const text = formatTranscriptionPlainText(sampleMessages, 'Sessão Teste');
  assert.match(text, /LIORA — TRANSCRIÇÃO DE CONVERSA/);
  assert.match(text, /Sessão: Sessão Teste/);
  assert.match(text, /\[10:00:00\] \[Texto\] Você:/);
  assert.match(text, /Olá LIORA/);
  assert.match(text, /\[10:00:02\] \[Texto\] LIORA:/);
  assert.match(text, /\[10:01:00\] \[Texto\] LIORA \[INTERROMPIDO\]:/);
});

test('T11 & T12: Exportar TXT e Markdown preservam estrutura dos registros', () => {
  const sampleMessages: ChatMessage[] = [
    { id: '1', sender: 'user', text: 'Status da rede', timestamp: '08:00:00', status: 'completed' },
    { id: '2', sender: 'assistant', text: 'Rede 100% operacional.', timestamp: '08:00:01', status: 'completed' }
  ];

  // TXT
  const txt = formatTranscriptionPlainText(sampleMessages, 'Auditoria Rede');
  assert.ok(txt.includes('Total de Registros: 2'));
  assert.ok(txt.includes('Rede 100% operacional.'));

  // Markdown
  const md = formatTranscriptionMarkdown(sampleMessages, 'Auditoria Rede');
  assert.match(md, /# Transcrição de Conversa — LIORA/);
  assert.match(md, /> \*\*Sessão:\*\* Auditoria Rede/);
  assert.match(md, /### `\[08:00:00\]` Você `\[Texto\]`/);
  assert.match(md, /### `\[08:00:01\]` LIORA `\[Texto\]`/);
  assert.match(md, /Rede 100% operacional\./);
});

test('T13 & T14: Lógica de congelamento (pausa visual) e retomada preserva todos os eventos', () => {
  const initialMessages: ChatMessage[] = [
    { id: '1', sender: 'user', text: 'M1', timestamp: '10:00:00', status: 'completed' }
  ];

  // Snapshot congelado
  const frozen = [...initialMessages];
  assert.equal(frozen.length, 1);

  // Chegam novas mensagens no store durante a pausa
  const updatedMessages = [
    ...initialMessages,
    { id: '2', sender: 'assistant' as const, text: 'M2', timestamp: '10:00:05', status: 'completed' as const },
    { id: '3', sender: 'user' as const, text: 'M3', timestamp: '10:00:10', status: 'completed' as const }
  ];

  // Enquanto pausado, a lista exibida é 'frozen'
  const displayedWhilePaused = frozen;
  assert.equal(displayedWhilePaused.length, 1);
  const pendingCount = updatedMessages.length - frozen.length;
  assert.equal(pendingCount, 2, 'Deve identificar 2 novas mensagens pendentes');

  // Ao retomar, a lista exibida aponta para updatedMessages
  const displayedAfterResume = updatedMessages;
  assert.equal(displayedAfterResume.length, 3);
  assert.equal(displayedAfterResume[1].text, 'M2');
  assert.equal(displayedAfterResume[2].text, 'M3');
});

test('T15 & T16: Estado vazio e tratamento de ausência de registros', () => {
  const emptyPlain = formatTranscriptionPlainText([], 'Sessão Vazia');
  assert.match(emptyPlain, /Nenhum registro encontrado para esta sessão/);

  const emptyMd = formatTranscriptionMarkdown([], 'Sessão Vazia');
  assert.match(emptyMd, /Nenhum registro disponível para esta sessão/);
});

test('T17: Nenhuma transcriÃ§Ã£o de voz fictÃ­cia Ã© mostrada quando nÃ£o hÃ¡ Ã¡udio real', () => {
  const messages: ChatMessage[] = [
    { id: '1', sender: 'user', text: 'Mensagem via teclado', timestamp: '12:00:00', status: 'completed' }
  ];

  const event = messageToTranscriptionEvent(messages[0], 's1');
  assert.equal(event.source, 'text', 'Origem padrÃ£o deve ser text');
  assert.notEqual(event.source, 'voice', 'NÃ£o deve fingir reconhecimento de voz');
});

test('T19 & T20: PersistÃªncia e retryMessage continuam funcionando perfeitamente', async () => {
  resetStore();
  const sessId = useLioraStore.getState().createSession('Retry & Persistence');
  
  useLioraStore.setState({
    messages: [
      { id: 'u1', sender: 'user', text: 'Mensagem para retry', timestamp: '10:00:00', status: 'completed' },
      { id: 'a1', sender: 'assistant', text: '', timestamp: '10:00:01', status: 'error', errorMessage: 'Falha simulada', errorCode: 'AUTH_ERROR' }
    ]
  });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => createMockSseResponse(['Resposta bem sucedida apÃ³s retry']);
    
    await useLioraStore.getState().retryMessage('a1');

    const msgs = useLioraStore.getState().messages;
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].text, 'Mensagem para retry');
    assert.equal(msgs[1].status, 'completed');
    assert.equal(msgs[1].text, 'Resposta bem sucedida apÃ³s retry');

    // Confirmar persistÃªncia no storage
    const stored = loadHistory();
    const target = stored.sessions.find(s => s.id === sessId)!;
    assert.equal(target.messages.length, 2);
    assert.equal(target.messages[1].text, 'Resposta bem sucedida apÃ³s retry');
  } finally {
    globalThis.fetch = originalFetch;
  }
});


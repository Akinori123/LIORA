/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatMessage } from '../types';

export interface GeminiContentPart {
  text: string;
}

export interface GeminiContentTurn {
  role: 'user' | 'model';
  parts: GeminiContentPart[];
}

export interface ErrorClassification {
  code: 'AUTH_ERROR' | 'QUOTA_ERROR' | 'UNAVAILABLE' | 'NETWORK_ERROR' | 'CANCELLED' | 'UNKNOWN';
  userMessage: string;
}

/**
 * Sanitizes input text before sending to AI or state.
 */
export function sanitizeInput(text: string, maxLength = 10000): string {
  if (!text) return '';
  return text.trim().slice(0, maxLength);
}

/**
 * Formats a list of ChatMessages into valid Gemini API multi-turn history.
 * - Filters out empty, error or cancelled messages.
 * - Caps history to maxTurns (sliding window) to prevent token bloat.
 * - Maps user -> 'user' and assistant -> 'model'.
 * - Merges consecutive turns of identical roles to maintain valid schema.
 */
export function formatGeminiHistory(
  messages: ChatMessage[],
  maxTurns = 20
): GeminiContentTurn[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  // Filter out invalid or purely error turns without meaningful content
  const validMessages = messages.filter((m) => {
    if (!m || !m.text || typeof m.text !== 'string') return false;
    if (m.text.trim().length === 0) return false;
    if (m.status === 'error') return false;
    // Exclude system messages from user/model contents turns
    if (m.sender !== 'user' && m.sender !== 'assistant') return false;
    return true;
  });

  // Apply sliding window
  const recent = validMessages.slice(-maxTurns);

  const turns: GeminiContentTurn[] = [];

  for (const msg of recent) {
    const role: 'user' | 'model' = msg.sender === 'user' ? 'user' : 'model';
    const cleanText = msg.text.trim();

    if (turns.length > 0 && turns[turns.length - 1].role === role) {
      // Merge with previous turn to avoid consecutive same-role violations
      turns[turns.length - 1].parts[0].text += `\n\n${cleanText}`;
    } else {
      turns.push({
        role,
        parts: [{ text: cleanText }]
      });
    }
  }

  return turns;
}

/**
 * Classifies HTTP status codes and error messages into actionable categories.
 */
export function classifyChatError(
  statusOrError: number | Error | string,
  rawMessage?: string
): ErrorClassification {
  const errMsg = typeof statusOrError === 'string'
    ? statusOrError
    : statusOrError instanceof Error
      ? statusOrError.message
      : rawMessage || '';

  const lowerMsg = errMsg.toLowerCase();

  // Cancelled by user or AbortController
  if (lowerMsg.includes('abort') || lowerMsg.includes('cancel') || lowerMsg.includes('interromp')) {
    return {
      code: 'CANCELLED',
      userMessage: 'Geração interrompida pelo usuário.'
    };
  }

  // HTTP Status 401 or 403, or invalid API key
  if (
    statusOrError === 401 ||
    statusOrError === 403 ||
    lowerMsg.includes('api key') ||
    lowerMsg.includes('unauthorized') ||
    lowerMsg.includes('permission denied')
  ) {
    return {
      code: 'AUTH_ERROR',
      userMessage: 'Chave de API do Gemini não configurada ou inválida no servidor.'
    };
  }

  // HTTP Status 429: Rate Limit / Quota Exceeded
  if (
    statusOrError === 429 ||
    lowerMsg.includes('quota') ||
    lowerMsg.includes('rate limit') ||
    lowerMsg.includes('too many requests')
  ) {
    return {
      code: 'QUOTA_ERROR',
      userMessage: 'Limite de requisições excedido (Quota/Rate Limit). Aguarde alguns instantes antes de reenviar.'
    };
  }

  // HTTP Status 503 or 504: Service Unavailable / Overloaded
  if (
    statusOrError === 503 ||
    statusOrError === 504 ||
    lowerMsg.includes('overloaded') ||
    lowerMsg.includes('unavailable') ||
    lowerMsg.includes('deadline exceeded')
  ) {
    return {
      code: 'UNAVAILABLE',
      userMessage: 'Serviço do modelo Gemini temporariamente indisponível. Tente novamente em alguns segundos.'
    };
  }

  // Network / Connection drop
  if (
    lowerMsg.includes('network') ||
    lowerMsg.includes('failed to fetch') ||
    lowerMsg.includes('econnrefused') ||
    lowerMsg.includes('offline')
  ) {
    return {
      code: 'NETWORK_ERROR',
      userMessage: 'Falha de conexão com o servidor da LIORA. Verifique a rede.'
    };
  }

  return {
    code: 'UNKNOWN',
    userMessage: errMsg || 'Erro desconhecido ao processar mensagem.'
  };
}

/**
 * Compacta o histórico de conversa quando excede o limite de turnos, gerando um bloco de síntese executiva
 * e mantendo as mensagens mais recentes intactas (Token Economy).
 */
export function compressConversationHistory(
  messages: ChatMessage[],
  maxActiveMessages = 20
): { activeMessages: ChatMessage[]; summaryBlock?: string } {
  if (!Array.isArray(messages) || messages.length <= maxActiveMessages) {
    return { activeMessages: messages || [] };
  }

  const olderMessages = messages.slice(0, messages.length - maxActiveMessages);
  const activeMessages = messages.slice(-maxActiveMessages);

  const topics = olderMessages
    .filter(m => m.sender === 'user')
    .map(m => m.text.slice(0, 40))
    .join('; ');

  const summaryBlock = `[Síntese Executiva do Histórico Anterior (${olderMessages.length} mensagens): Tópicos discutidos: ${topics || 'interações gerais'}. Preservado para economia de tokens e janela de contexto.]`;

  return {
    activeMessages,
    summaryBlock
  };
}

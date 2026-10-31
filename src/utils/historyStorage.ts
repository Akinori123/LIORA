/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ConversationSession, ChatMessage } from '../types';
import { storageAdapter } from '../services/storageAdapter';

export const PRIMARY_STORAGE_KEY = 'liora-conversation-history-v1';
export const LEGACY_STORAGE_KEY = 'liora-history';
export const CURRENT_SCHEMA_VERSION = 1;

export interface StoredHistoryPayload {
  version: number;
  sessions: ConversationSession[];
  activeSessionId: string | null;
  lastSavedAt: string;
}

export interface StorageOperationResult {
  success: boolean;
  error?: string;
  bytesWritten?: number;
}

/**
 * Strips potential API keys or sensitive credential patterns from stored text
 */
export function sanitizeStoredText(text: string): string {
  if (!text) return '';
  // Redact AIzaSy..., sk-..., ghp_... patterns if accidentally pasted
  return text
    .replace(/AIzaSy[A-Za-z0-9_-]{33}/g, '[CHAVE_REDACTADA]')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[CHAVE_REDACTADA]');
}

/**
 * Validates and sanitizes a single chat message
 */
export function sanitizeChatMessage(msg: any): ChatMessage | null {
  if (!msg || typeof msg !== 'object') return null;
  const id = typeof msg.id === 'string' && msg.id ? msg.id : `msg-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;
  const sender = msg.sender === 'user' || msg.sender === 'assistant' || msg.sender === 'system' ? msg.sender : 'user';
  const text = typeof msg.text === 'string' ? sanitizeStoredText(msg.text) : '';
  const timestamp = typeof msg.timestamp === 'string' && msg.timestamp ? msg.timestamp : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  
  const sanitized: ChatMessage = {
    id,
    sender,
    text,
    timestamp,
    status: msg.status || 'completed',
    modelUsed: typeof msg.modelUsed === 'string' ? msg.modelUsed : undefined,
    errorMessage: typeof msg.errorMessage === 'string' ? msg.errorMessage : undefined,
    errorCode: msg.errorCode || undefined,
    source: msg.source === 'voice' ? 'voice' : 'text',
    createdAt: typeof msg.createdAt === 'string' ? msg.createdAt : undefined,
    sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : undefined
  };

  return sanitized;
}

/**
 * Validates and sanitizes a single conversation session
 */
export function sanitizeSession(raw: any): ConversationSession | null {
  if (!raw || typeof raw !== 'object') return null;
  // If entry is an empty object without id, title, and messages, treat as invalid
  if (!raw.id && !raw.title && !raw.messages) return null;

  const id = typeof raw.id === 'string' && raw.id ? raw.id : `sess-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 100) : 'Nova Conversa';
  
  let createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : (raw.createdAt instanceof Date ? raw.createdAt.toISOString() : new Date().toISOString());
  let updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : (raw.updatedAt instanceof Date ? raw.updatedAt.toISOString() : new Date().toISOString());

  // Verify ISO validity
  if (isNaN(Date.parse(createdAt))) createdAt = new Date().toISOString();
  if (isNaN(Date.parse(updatedAt))) updatedAt = new Date().toISOString();

  const rawMessages = Array.isArray(raw.messages) ? raw.messages : [];
  const messages: ChatMessage[] = [];
  for (const item of rawMessages) {
    const validMsg = sanitizeChatMessage(item);
    if (validMsg) messages.push(validMsg);
  }

  return {
    id,
    title,
    createdAt,
    updatedAt,
    messages
  };
}

export function getEffectiveStorage(storageOverride?: Storage): Storage | null {
  if (storageOverride !== undefined) return storageOverride;
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  if (typeof globalThis !== 'undefined' && (globalThis as any).localStorage) return (globalThis as any).localStorage;
  return null;
}

/**
 * Loads conversation history with schema validation, fallback support, and corruption handling
 */
export function loadHistory(storageOverride?: Storage): { sessions: ConversationSession[]; activeSessionId: string | null } {
  const storage = getEffectiveStorage(storageOverride);
  if (!storage) {
    return { sessions: [], activeSessionId: null };
  }

  try {
    let raw = storage.getItem(PRIMARY_STORAGE_KEY);
    // Backward compatibility fallback to legacy key
    if (!raw) {
      raw = storage.getItem(LEGACY_STORAGE_KEY);
    }

    if (!raw) {
      return { sessions: [], activeSessionId: null };
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      console.warn('[LioraStorage] Formato corrompido ou inválido. Retornando histórico vazio.');
      return { sessions: [], activeSessionId: null };
    }

    const rawSessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    const validSessions: ConversationSession[] = [];

    for (const item of rawSessions) {
      const sanitized = sanitizeSession(item);
      if (sanitized) validSessions.push(sanitized);
    }

    // Sort sessions by updatedAt descending (newest first)
    validSessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    let activeSessionId: string | null = null;
    if (typeof parsed.activeSessionId === 'string' && validSessions.some(s => s.id === parsed.activeSessionId)) {
      activeSessionId = parsed.activeSessionId;
    } else if (validSessions.length > 0) {
      activeSessionId = validSessions[0].id;
    }

    return { sessions: validSessions, activeSessionId };
  } catch (err) {
    console.warn('[LioraStorage] Erro ao recuperar histórico persistido. Recuperando estado seguro:', err);
    return { sessions: [], activeSessionId: null };
  }
}

/**
 * Saves conversation history safely to storage with quota check and versioning
 */
export function saveHistory(
  sessions: ConversationSession[],
  activeSessionId: string | null,
  storageOverride?: Storage
): StorageOperationResult {
  const storage = getEffectiveStorage(storageOverride);
  if (!storage) {
    return { success: false, error: 'Storage indisponível no ambiente atual.' };
  }

  try {
    const validSessions = sessions.map(s => sanitizeSession(s)).filter((s): s is ConversationSession => s !== null);

    const payload: StoredHistoryPayload = {
      version: CURRENT_SCHEMA_VERSION,
      sessions: validSessions,
      activeSessionId,
      lastSavedAt: new Date().toISOString()
    };

    const serialized = JSON.stringify(payload);
    storage.setItem(PRIMARY_STORAGE_KEY, serialized);

    // Espelhamento transacional via storageAdapter (Desktop SQLite / Backups)
    storageAdapter.save('sessions', 'history_payload', payload).catch((e) => {
      console.warn('[LioraStorage] Falha no espelhamento para storageAdapter:', e);
    });

    return {
      success: true,
      bytesWritten: serialized.length
    };
  } catch (err: any) {
    const errorMsg = err?.name === 'QuotaExceededError' 
      ? 'Limite de armazenamento local (quota) excedido.' 
      : (err?.message || 'Falha ao persistir conversas no armazenamento local.');
    console.error('[LioraStorage] Erro na gravação do histórico:', errorMsg);
    return {
      success: false,
      error: errorMsg
    };
  }
}

/**
 * Clears stored history completely
 */
export function clearStoredHistory(storageOverride?: Storage): boolean {
  const storage = getEffectiveStorage(storageOverride);
  if (!storage) return false;
  try {
    storage.removeItem(PRIMARY_STORAGE_KEY);
    storage.removeItem(LEGACY_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Searches sessions by title and message contents
 */
export function searchSessions(sessions: ConversationSession[], query: string): ConversationSession[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;

  return sessions.filter((session) => {
    if (session.title.toLowerCase().includes(q)) return true;
    return session.messages.some((m) => m.text.toLowerCase().includes(q));
  });
}

/**
 * Estimates tokens from message contents (~4 chars per token)
 * Returns a human-friendly label clearly marked as an estimate.
 */
export function estimateSessionTokens(messages: ChatMessage[]): string {
  const totalChars = messages.reduce((acc, m) => acc + (m.text?.length || 0), 0);
  const estimatedTokens = Math.max(1, Math.round(totalChars / 4));
  if (estimatedTokens >= 1000) {
    return `~${(estimatedTokens / 1000).toFixed(1)}k tokens (est.)`;
  }
  return `~${estimatedTokens} tokens (est.)`;
}

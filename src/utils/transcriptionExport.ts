/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ChatMessage, TranscriptionEvent } from '../types';

/**
 * Normalizes a timestamp to standard HH:MM:SS format
 */
export function formatTimestampHms(timestamp?: string, createdAt?: string): string {
  if (createdAt) {
    const parsed = new Date(createdAt);
    if (!isNaN(parsed.getTime())) {
      return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    }
  }

  if (!timestamp) return '00:00:00';

  const trimmed = timestamp.trim();

  // If already standard 24h HH:MM:SS
  if (/^\d{2}:\d{2}:\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  // Handle 12-hour AM/PM format (e.g., "03:30 PM", "3:30:15 PM", "03:30 PM:00")
  const ampmMatch = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)(?::(\d{2}))?$/i);
  if (ampmMatch) {
    let hours = parseInt(ampmMatch[1], 10);
    const minutes = ampmMatch[2];
    const seconds = ampmMatch[3] || ampmMatch[5] || '00';
    const isPm = ampmMatch[4].toUpperCase() === 'PM';

    if (isPm && hours < 12) hours += 12;
    if (!isPm && hours === 12) hours = 0;

    return `${String(hours).padStart(2, '0')}:${minutes}:${seconds}`;
  }

  // Standard 2-part HH:MM
  const parts = trimmed.split(':');
  if (parts.length === 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
    return `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}:00`;
  }

  // 3-part HH:MM:SS
  if (parts.length === 3 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2])) {
    return `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}:${parts[2].padStart(2, '0')}`;
  }

  return trimmed;
}

/**
 * Converts a ChatMessage to a standardized TranscriptionEvent
 */
export function messageToTranscriptionEvent(msg: ChatMessage, sessionId: string): TranscriptionEvent {
  const speakerLabel = msg.sender === 'user' ? 'Você' : (msg.sender === 'assistant' ? 'LIORA' : 'Sistema');
  const hms = formatTimestampHms(msg.timestamp, msg.createdAt);
  const status = msg.status || 'completed';

  return {
    id: msg.id,
    sessionId: msg.sessionId || sessionId,
    speaker: msg.sender,
    speakerLabel,
    text: msg.text || '',
    timestamp: hms,
    status,
    source: msg.source || 'text',
    isPartial: status === 'streaming',
    errorMessage: msg.errorMessage,
    errorCode: msg.errorCode
  };
}

/**
 * Formats messages into clean plain text for copying or TXT export
 */
export function formatTranscriptionPlainText(
  messages: ChatMessage[], 
  sessionTitle: string = 'Conversa Atual',
  sessionCreatedAt?: string
): string {
  const headerDate = sessionCreatedAt 
    ? new Date(sessionCreatedAt).toLocaleString('pt-BR') 
    : new Date().toLocaleString('pt-BR');

  const lines: string[] = [
    '================================================================================',
    'LIORA — TRANSCRIÇÃO DE CONVERSA',
    `Sessão: ${sessionTitle}`,
    `Data do Registro: ${headerDate}`,
    `Total de Registros: ${messages.length}`,
    'Origem: Fluxo de mensagens sincronizado em tempo real',
    '================================================================================',
    ''
  ];

  if (messages.length === 0) {
    lines.push('Nenhum registro encontrado para esta sessão.');
  }

  for (const msg of messages) {
    const speaker = msg.sender === 'user' ? 'Você' : (msg.sender === 'assistant' ? 'LIORA' : 'Sistema');
    const time = formatTimestampHms(msg.timestamp, msg.createdAt);
    const origin = msg.source === 'voice' ? '[Voz]' : '[Texto]';

    let stateSuffix = '';
    if (msg.status === 'streaming') stateSuffix = ' (Em andamento...)';
    else if (msg.status === 'cancelled') stateSuffix = ' [INTERROMPIDO]';
    else if (msg.status === 'error') stateSuffix = ` [ERRO: ${msg.errorCode || 'FALHA'}]`;

    lines.push(`[${time}] ${origin} ${speaker}${stateSuffix}:`);
    
    if (msg.status === 'error' && msg.errorMessage) {
      lines.push(`Falha: ${msg.errorMessage}`);
      if (msg.text) {
        lines.push(`Conteúdo parcial retido: ${msg.text}`);
      }
    } else {
      lines.push(msg.text || (msg.status === 'streaming' ? '(processando resposta...)' : '(sem conteúdo)'));
    }
    lines.push('');
  }

  lines.push('================================================================================');
  lines.push('Fim da Transcrição — LIORA Core');
  return lines.join('\n');
}

/**
 * Formats messages into clean Markdown for MD export
 */
export function formatTranscriptionMarkdown(
  messages: ChatMessage[], 
  sessionTitle: string = 'Conversa Atual',
  sessionCreatedAt?: string
): string {
  const headerDate = sessionCreatedAt 
    ? new Date(sessionCreatedAt).toLocaleString('pt-BR') 
    : new Date().toLocaleString('pt-BR');

  const lines: string[] = [
    `# Transcrição de Conversa — LIORA`,
    '',
    `> **Sessão:** ${sessionTitle}  `,
    `> **Data:** ${headerDate}  `,
    `> **Total de Entradas:** ${messages.length} turnos  `,
    `> **Origem dos Dados:** Mensagens de texto sincronizadas em tempo real  `,
    '',
    '---',
    ''
  ];

  if (messages.length === 0) {
    lines.push('*Nenhum registro disponível para esta sessão.*');
    return lines.join('\n');
  }

  for (const msg of messages) {
    const speaker = msg.sender === 'user' ? 'Você' : (msg.sender === 'assistant' ? 'LIORA' : 'Sistema');
    const time = formatTimestampHms(msg.timestamp, msg.createdAt);
    const originBadge = msg.source === 'voice' ? '`[Voz]`' : '`[Texto]`';

    let statusBadge = '';
    if (msg.status === 'streaming') statusBadge = ' *(Em andamento...)*';
    else if (msg.status === 'cancelled') statusBadge = ' `[INTERROMPIDO]`';
    else if (msg.status === 'error') statusBadge = ` \`[ERRO: ${msg.errorCode || 'FALHA'}]\``;

    lines.push(`### \`[${time}]\` ${speaker} ${originBadge}${statusBadge}`);
    lines.push('');

    if (msg.status === 'error') {
      lines.push(`> ⚠️ **Falha no processamento:** ${msg.errorMessage || 'Erro inesperado'}`);
      if (msg.text) {
        lines.push('');
        lines.push('**Conteúdo parcial recuperado:**');
        lines.push(msg.text);
      }
    } else if (msg.text) {
      lines.push(msg.text);
    } else if (msg.status === 'streaming') {
      lines.push('*Aguardando dados do modelo...*');
    } else {
      lines.push('*(Mensagem vazia)*');
    }

    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Robust clipboard copy helper with execCommand fallback
 */
export async function copyTranscriptionToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to DOM fallback
    }
  }

  if (typeof document !== 'undefined') {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '0';
      textarea.setAttribute('readonly', '');
      document.body.appendChild(textarea);
      textarea.select();
      const successful = document.execCommand('copy');
      document.body.removeChild(textarea);
      return successful;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Triggers browser download for generated text/markdown files
 */
export function downloadFile(content: string, filename: string, mimeType: string = 'text/plain;charset=utf-8'): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

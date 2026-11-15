/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * LIORA — Parser Determinístico de Horário e Calendário Local
 * Responde instantaneamente perguntas sobre data, hora e calendário com o relógio real do SO.
 */

export interface TimeQueryMatch {
  type: 'time_query';
  spokenFeedback: string;
  rawInput: string;
}

export function parseTimeCommandIntent(input: string): TimeQueryMatch | null {
  if (!input) return null;
  const clean = input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!clean) return null;

  // Remove invocações e cortesia
  const normalized = clean
    .replace(/\b(?:e\s+|ei\s+|ola\s+|ok\s+)?liora\b/g, ' ')
    .replace(/\b(?:por\s+favor|por\s+gentileza|faca\s+o\s+favor|favor)\b/g, ' ')
    .replace(/\b(?:voce\s+pode|pode|consegue|poderia|seria\s+possivel|me\s+diz|me\s+fala|sabe|diga)\b/g, ' ')
    .replace(/\b(?:pra\s+mim|para\s+mim)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const isDateQuery = 
    normalized.includes('que dia e hoje') ||
    normalized.includes('que dia e') ||
    normalized.includes('que dia estamos') ||
    normalized.includes('que dia') ||
    normalized.includes('qual dia') ||
    normalized.includes('qual o dia de hoje') ||
    normalized.includes('qual o dia') ||
    normalized.includes('qual e o dia') ||
    normalized.includes('qual e a data de hoje') ||
    normalized.includes('qual a data de hoje') ||
    normalized.includes('qual e a data') ||
    normalized.includes('qual a data') ||
    normalized.includes('qual data') ||
    normalized.includes('data de hoje') ||
    normalized.includes('dia da semana') ||
    normalized.includes('hoje e que dia') ||
    normalized === 'que dia estamos' ||
    normalized === 'dia de hoje';

  const isTimeQuery = 
    normalized.includes('que horas sao') ||
    normalized.includes('que horas e') ||
    normalized.includes('que horas') ||
    normalized.includes('as horas') ||
    normalized.includes('sao que horas') ||
    normalized.includes('horas tem') ||
    normalized.includes('qual a hora') ||
    normalized.includes('qual e a hora') ||
    normalized.includes('hora atual') ||
    normalized.includes('hora de agora') ||
    normalized === 'horas' ||
    normalized === 'que horas';

  if (!isDateQuery && !isTimeQuery) return null;

  const now = new Date();
  const dateStr = now.toLocaleDateString('pt-BR', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  const timeStr = now.toLocaleTimeString('pt-BR', { 
    hour: '2-digit', 
    minute: '2-digit' 
  });

  let spokenFeedback = '';
  if (isDateQuery && isTimeQuery) {
    spokenFeedback = `Hoje é ${dateStr}, e são exatamente ${timeStr}, Mestre.`;
  } else if (isDateQuery) {
    spokenFeedback = `Hoje é ${dateStr}, Mestre.`;
  } else {
    spokenFeedback = `Agora são ${timeStr}, Mestre.`;
  }

  return {
    type: 'time_query',
    spokenFeedback,
    rawInput: input.trim()
  };
}

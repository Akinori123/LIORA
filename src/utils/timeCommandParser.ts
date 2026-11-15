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
    /\b(?:que dia e hoje|que dia e|que dia estamos|hoje e que dia|qual(?: e)? o dia de hoje|qual(?: e)? a data de hoje|data de hoje|dia da semana|dia de hoje)\b/.test(normalized) ||
    /^(?:que dia|qual dia|qual o dia|qual a data|qual e a data|qual data)$/.test(normalized);

  const isTimeQuery =
    /\b(?:que horas sao|que horas e agora|agora sao que horas|sao que horas|qual(?: e)? a hora atual|qual(?: e)? a hora de agora|hora atual|hora de agora|que hora e|que horas sao agora)\b/.test(normalized) ||
    /^(?:que horas|as horas|horas|hora|que hora)$/.test(normalized);

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

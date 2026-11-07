/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — FASE 2: MÓDULO DE CALENDÁRIO (Produtividade)
 *
 * Consulta (R1) e criação (R2) de eventos de agenda REAIS.
 *
 * Estratégia de persistência local-first:
 *  - Os eventos são armazenados em JSON persistente no perfil do usuário
 *    (~/.liora/calendar/events.json) via fs — zero nuvem, dados 100% locais.
 *  - Se o serviço de calendário do cofre estiver conectado com endpoint HTTP
 *    (ex: Google Calendar REST via webhook/CLI), a sincronização externa é
 *    opcional e apenas para leitura (R1).
 *
 * R1: calendar_list_events  — consulta por data/intervalo
 * R2: calendar_create_event — criação de compromissos (consentimento HMAC)
 */

import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { ToolDefinition } from '../types';

// ─── Persistência local ──────────────────────────────────────────────────────

const CALENDAR_DIR = path.join(os.homedir(), '.liora', 'calendar');
const EVENTS_FILE = path.join(CALENDAR_DIR, 'events.json');

interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  location?: string;
  /** ISO 8601 com offset local */
  start: string;
  /** ISO 8601 com offset local */
  end: string;
  participants: string[];
  /** R2: criado por qual ferramenta/fonte */
  source: 'liora' | 'imported';
  createdAt: string;
}

async function loadEvents(): Promise<CalendarEvent[]> {
  try {
    if (!fs.existsSync(EVENTS_FILE)) return [];
    const raw = await fsp.readFile(EVENTS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveEvents(events: CalendarEvent[]): Promise<void> {
  await fsp.mkdir(CALENDAR_DIR, { recursive: true });
  // Escrita atômica: tmp + rename (proteção contra corrupção)
  const tmp = `${EVENTS_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(events, null, 2), 'utf8');
  await fsp.rename(tmp, EVENTS_FILE);
}

// ─── Helpers de data ─────────────────────────────────────────────────────────

function parseDateOrError(value: string | undefined, field: string): { ok: true; date: Date } | { ok: false; error: string } {
  if (!value || typeof value !== 'string') {
    return { ok: false, error: `MISSING_DATE: informe '${field}' em formato ISO (ex: 2025-01-15T14:30:00).` };
  }
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    return { ok: false, error: `INVALID_DATE: '${value}' não é uma data ISO válida para '${field}'.` };
  }
  return { ok: true, date: d };
}

/** Valida e-mail de participante */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── Ferramentas ─────────────────────────────────────────────────────────────

/**
 * calendar_list_events (R1) — consulta de eventos por data ou intervalo.
 */
export const calendarListEventsTool: ToolDefinition<{
  mode: 'day' | 'range' | 'upcoming' | 'all';
  date?: string;
  startDate?: string;
  endDate?: string;
  maxResults?: number;
}, any> = {
  name: 'calendar_list_events',
  description: 'Lista eventos REAIS da agenda do usuário armazenados localmente: eventos de um dia específico, de um intervalo, os próximos agendados ou todos. Use para "o que tenho na agenda amanhã", "quais reuniões esta semana", "mostre meus compromissos".',
  category: 'system',
  riskLevel: 'R1',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['day', 'range', 'upcoming', 'all'], description: 'Modo de consulta.', default: 'upcoming' },
      date: { type: 'string', description: 'Data alvo (ISO, ex: 2025-01-15) — apenas para mode=day.' },
      startDate: { type: 'string', description: 'Início do intervalo (ISO) — para mode=range.' },
      endDate: { type: 'string', description: 'Fim do intervalo (ISO) — para mode=range.' },
      maxResults: { type: 'number', description: 'Máximo de eventos a retornar (1-100). Padrão 30.', default: 30 }
    },
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'events', 'simulated'] },
  execute: async (params) => {
    const events = await loadEvents();
    const max = Math.max(1, Math.min(100, params.maxResults || 30));
    const now = new Date();
    const mode = params.mode || 'upcoming';

    let filtered: CalendarEvent[];
    let period: string;

    switch (mode) {
      case 'day': {
        const check = parseDateOrError(params.date, 'date');
        if (!check.ok) return { success: false, error: check.error, events: [], simulated: false, timestamp: new Date().toISOString() };
        // CORREÇÃO (timezone): datas sem hora ("2030-01-15") são parseadas pelo JS
        // como UTC meia-noite — deslocando a janela do dia pelo offset local.
        // Parse manual como data local garante que o dia consultado é o dia do usuário.
        const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(params.date || '');
        let dayStart: Date, dayEnd: Date;
        if (dateOnly) {
          const [y, m, d] = (params.date || '').split('-').map(Number);
          dayStart = new Date(y, m - 1, d, 0, 0, 0, 0);
          dayEnd = new Date(y, m - 1, d, 23, 59, 59, 999);
        } else {
          dayStart = new Date(check.date); dayStart.setHours(0, 0, 0, 0);
          dayEnd = new Date(check.date); dayEnd.setHours(23, 59, 59, 999);
        }
        filtered = events.filter(e => {
          const s = new Date(e.start);
          return s >= dayStart && s <= dayEnd;
        });
        period = `dia ${params.date}`;
        break;
      }
      case 'range': {
        const s1 = parseDateOrError(params.startDate, 'startDate');
        if (!s1.ok) return { success: false, error: s1.error, events: [], simulated: false, timestamp: new Date().toISOString() };
        const s2 = parseDateOrError(params.endDate, 'endDate');
        if (!s2.ok) return { success: false, error: s2.error, events: [], simulated: false, timestamp: new Date().toISOString() };
        const start = s1.date, end = s2.date;
        filtered = events.filter(e => {
          const s = new Date(e.start);
          return s >= start && s <= end;
        });
        period = `intervalo ${params.startDate} a ${params.endDate}`;
        break;
      }
      case 'upcoming': {
        filtered = events.filter(e => new Date(e.start) >= now);
        period = 'próximos eventos';
        break;
      }
      case 'all':
      default:
        filtered = events;
        period = 'todos os eventos';
        break;
    }

    filtered.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

    return {
      success: true,
      mode,
      period,
      events: filtered.slice(0, max),
      count: Math.min(filtered.length, max),
      totalInPeriod: filtered.length,
      simulated: false,
      timestamp: new Date().toISOString()
    };
  }
};

/**
 * calendar_create_event (R2) — criação real de compromisso (consentimento HMAC).
 */
export const calendarCreateEventTool: ToolDefinition<{
  title: string;
  start: string;
  end?: string;
  description?: string;
  location?: string;
  participants?: string[];
  durationMinutes?: number;
}, any> = {
  name: 'calendar_create_event',
  description: 'Cria um evento REAL na agenda do usuário (persistido localmente em ~/.liora/calendar). AÇÃO MUTÁVEL (R2) — exige consentimento explícito do operador. Use para "agende reunião com X amanhã às 14h", "marque consulta no dia 20".',
  category: 'system',
  riskLevel: 'R2',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Título do evento (máx 120 caracteres).' },
      start: { type: 'string', description: 'Início em ISO 8601 (ex: 2025-01-15T14:30:00).' },
      end: { type: 'string', description: 'Fim em ISO 8601. Se omitido, usa durationMinutes (padrão 60).' },
      description: { type: 'string', description: 'Descrição/notas do evento (máx 2000 caracteres).' },
      location: { type: 'string', description: 'Local ou link da reunião (máx 200 caracteres).' },
      participants: { type: 'array', items: { type: 'string' }, description: 'E-mails dos participantes (validados).' },
      durationMinutes: { type: 'number', description: 'Duração em minutos quando end não for informado (padrão 60).' }
    },
    required: ['title', 'start'],
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'event', 'simulated'] },
  execute: async (params) => {
    // ── Validações ──
    const title = (params.title || '').trim().slice(0, 120);
    if (!title) return { success: false, error: 'MISSING_TITLE: informe o título do evento.', simulated: false, timestamp: new Date().toISOString() };

    const startCheck = parseDateOrError(params.start, 'start');
    if (!startCheck.ok) return { success: false, error: startCheck.error, simulated: false, timestamp: new Date().toISOString() };
    const startDate = startCheck.date;

    let endDate: Date;
    if (params.end) {
      const endCheck = parseDateOrError(params.end, 'end');
      if (!endCheck.ok) return { success: false, error: endCheck.error, simulated: false, timestamp: new Date().toISOString() };
      endDate = endCheck.date;
    } else {
      const duration = Math.max(5, Math.min(480, params.durationMinutes || 60));
      endDate = new Date(startDate.getTime() + duration * 60000);
    }

    if (endDate <= startDate) {
      return { success: false, error: 'INVALID_RANGE: o fim do evento deve ser após o início.', simulated: false, timestamp: new Date().toISOString() };
    }

    // Participants: valida cada e-mail
    const participants = (params.participants || []).map(p => String(p).trim()).filter(Boolean);
    for (const p of participants) {
      if (!EMAIL_RE.test(p)) {
        return { success: false, error: `INVALID_PARTICIPANT: '${p}' não é um e-mail válido.`, simulated: false, timestamp: new Date().toISOString() };
      }
    }

    // ── Verificação de conflito de horário (mesma janela já ocupada) ──
    const existing = await loadEvents();
    const conflicts = existing.filter(e => {
      const eStart = new Date(e.start);
      const eEnd = new Date(e.end);
      return startDate < eEnd && endDate > eStart; // sobreposição
    });

    const event: CalendarEvent = {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      description: (params.description || '').slice(0, 2000) || undefined,
      location: (params.location || '').slice(0, 200) || undefined,
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      participants,
      source: 'liora',
      createdAt: new Date().toISOString()
    };

    existing.push(event);
    await saveEvents(existing);

    return {
      success: true,
      event,
      conflicts: conflicts.length > 0 ? conflicts.map(c => ({ id: c.id, title: c.title, start: c.start, end: c.end })) : [],
      warning: conflicts.length > 0
        ? `ATENÇÃO: este evento sobrepõe ${conflicts.length} evento(s) já agendado(s) — verifique a agenda.`
        : undefined,
      message: `Evento '${title}' agendado para ${startDate.toLocaleString('pt-BR')} (duração: ${Math.round((endDate.getTime() - startDate.getTime()) / 60000)} min).`,
      simulated: false,
      timestamp: new Date().toISOString()
    };
  }
};

/** Export para registro em massa */
export const allCalendarTools: ToolDefinition<any, any>[] = [
  calendarListEventsTool,
  calendarCreateEventTool
];

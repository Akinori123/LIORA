/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { IAuditLogger, AuditQueryFilter, SecurityAuditEvent } from './types';
import { storageAdapter } from '../services/storageAdapter';

export const MAX_AUDIT_LOG_CAPACITY = 200;
export const DEFAULT_QUERY_LIMIT = 50;

/**
 * Erro controlado lançado pelo registrador de auditoria.
 */
export class AuditLoggerError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'AuditLoggerError';
    this.code = code;
    Object.setPrototypeOf(this, AuditLoggerError.prototype);
  }
}

/**
 * Registrador de auditoria em memória com buffer circular FIFO,
 * sequenceNumber monotônico e proteção estrita contra mutações externas.
 */
export class AuditLogger implements IAuditLogger {
  public readonly maxCapacity: number;
  private readonly events: SecurityAuditEvent[] = [];
  private currentSequenceNumber = 0;

  constructor(maxCapacity: number = MAX_AUDIT_LOG_CAPACITY) {
    if (typeof maxCapacity !== 'number' || maxCapacity <= 0 || !Number.isInteger(maxCapacity)) {
      throw new AuditLoggerError('INVALID_CAPACITY', 'A capacidade máxima do logger deve ser um número inteiro positivo.');
    }
    this.maxCapacity = maxCapacity;
  }

  public get count(): number {
    return this.events.length;
  }

  /**
   * Registra um novo evento no buffer circular.
   * O sequenceNumber é estritamente atribuído pelo logger (monotônico).
   */
  public logEvent(eventInput: Omit<SecurityAuditEvent, 'sequenceNumber'>): Readonly<SecurityAuditEvent> {
    if (!eventInput || typeof eventInput !== 'object') {
      throw new AuditLoggerError('INVALID_EVENT_FORMAT', 'Evento de auditoria inválido.');
    }

    if (!eventInput.auditId || typeof eventInput.auditId !== 'string') {
      throw new AuditLoggerError('INVALID_EVENT_FIELD', 'Campo obrigatório "auditId" ausente ou inválido.');
    }

    if (!eventInput.timestamp || typeof eventInput.timestamp !== 'string') {
      throw new AuditLoggerError('INVALID_EVENT_FIELD', 'Campo obrigatório "timestamp" ausente ou inválido.');
    }

    if (!eventInput.eventType || typeof eventInput.eventType !== 'string') {
      throw new AuditLoggerError('INVALID_EVENT_FIELD', 'Campo obrigatório "eventType" ausente ou inválido.');
    }

    if (!eventInput.toolName || typeof eventInput.toolName !== 'string') {
      throw new AuditLoggerError('INVALID_EVENT_FIELD', 'Campo obrigatório "toolName" ausente ou inválido.');
    }

    if (!eventInput.decision || (eventInput.decision !== 'ALLOW' && eventInput.decision !== 'DENY')) {
      throw new AuditLoggerError('INVALID_EVENT_FIELD', 'Campo obrigatório "decision" deve ser ALLOW ou DENY.');
    }

    // Atribuição monotônica exclusiva pelo logger
    this.currentSequenceNumber++;

    const immutableEvent: SecurityAuditEvent = Object.freeze({
      sequenceNumber: this.currentSequenceNumber,
      auditId: eventInput.auditId,
      timestamp: eventInput.timestamp,
      eventType: eventInput.eventType,
      toolName: eventInput.toolName,
      riskLevel: eventInput.riskLevel || 'R0',
      decision: eventInput.decision,
      denialCode: eventInput.denialCode,
      sessionId: eventInput.sessionId || 'missing',
      clientIp: eventInput.clientIp,
      parametersHash: eventInput.parametersHash,
      consentAuditId: eventInput.consentAuditId,
      durationMs: typeof eventInput.durationMs === 'number' ? eventInput.durationMs : 0,
      simulated: true as const
    });

    this.events.push(immutableEvent);

    // Persiste no storageAdapter soberano de forma assíncrona (tabela 'audit_logs')
    storageAdapter.save('audit_logs', immutableEvent.auditId, immutableEvent).catch(() => {});

    // Política FIFO: se ultrapassar a capacidade máxima, descarta o evento mais antigo
    if (this.events.length > this.maxCapacity) {
      this.events.shift();
    }

    return immutableEvent;
  }

  /**
   * Consulta eventos no buffer com filtros e limites seguros.
   * Retorna cópias defensivas congeladas.
   */
  public queryEvents(filter: AuditQueryFilter = {}): readonly Readonly<SecurityAuditEvent>[] {
    let result = [...this.events];

    // 1. Filtragem por tipo de evento
    if (filter.eventType) {
      result = result.filter(e => e.eventType === filter.eventType);
    }

    // 2. Filtragem por decisão (ALLOW / DENY)
    if (filter.decision) {
      result = result.filter(e => e.decision === filter.decision);
    }

    // 3. Filtragem por ferramenta
    if (filter.toolName) {
      result = result.filter(e => e.toolName === filter.toolName);
    }

    // 4. Ordenação determinística (por sequenceNumber monotônico)
    const order = filter.order === 'asc' ? 'asc' : 'desc';
    if (order === 'desc') {
      result.sort((a, b) => b.sequenceNumber - a.sequenceNumber);
    } else {
      result.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    }

    // 5. Limite sanitizado (1 a 200, padrão 50)
    let sanitizedLimit = DEFAULT_QUERY_LIMIT;
    if (filter.limit !== undefined) {
      if (typeof filter.limit === 'number' && Number.isFinite(filter.limit)) {
        sanitizedLimit = Math.max(1, Math.min(this.maxCapacity, Math.floor(filter.limit)));
      } else {
        sanitizedLimit = DEFAULT_QUERY_LIMIT;
      }
    }

    const truncated = result.slice(0, sanitizedLimit);
    return Object.freeze(truncated);
  }

  /**
   * Limpa o buffer de auditoria e reseta a sequência.
   * Utilizado estritamente em testes unitários.
   */
  public clear(): void {
    this.events.length = 0;
    this.currentSequenceNumber = 0;
  }
}

// Instância singleton padrão do registrador de auditoria
export const auditLogger = new AuditLogger(MAX_AUDIT_LOG_CAPACITY);

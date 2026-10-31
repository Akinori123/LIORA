/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolRiskLevel } from '../tools/types';

/**
 * Categorias de gatilhos suportados pelo AutomationsEngine
 */
export type AutomationTriggerType = 
  | 'TIME_INTERVAL'    // Disparo periódico a cada N minutos/segundos
  | 'TIME_OF_DAY'     // Disparo em horário fixo do dia (HH:MM)
  | 'CRON_EXPRESSION' // Notação cron padrão
  | 'SYSTEM_EVENT'    // Evento publicado no barramento EventBus
  | 'MANUAL';         // Disparo sob demanda pelo usuário via interface

/**
 * Eventos padronizados e tipados do barramento do sistema LIORA
 */
export const SYSTEM_EVENTS = {
  DEVICE_STATUS_CHANGED: 'DEVICE_STATUS_CHANGED',
  MEMORY_UPDATED: 'MEMORY_UPDATED',
  SHIELD_MODE_TOGGLED: 'SHIELD_MODE_TOGGLED',
  ORB_STATE_CHANGED: 'ORB_STATE_CHANGED',
  SECURITY_ALERT: 'SECURITY_ALERT',
  BACKUP_TRIGGERED: 'BACKUP_TRIGGERED',
  ACTIVITY_LOGGED: 'ACTIVITY_LOGGED',
} as const;

export type SystemEventType = (typeof SYSTEM_EVENTS)[keyof typeof SYSTEM_EVENTS] | (string & {});

/**
 * Especificação do gatilho configurado na regra
 */
export interface AutomationTrigger {
  type: AutomationTriggerType;
  /** Configurações específicas para cada tipo de gatilho */
  config: {
    intervalMinutes?: number;
    timeOfDay?: string;       // Formato 'HH:MM' em 24 horas
    cron?: string;
    eventName?: SystemEventType; // Ex: 'DEVICE_STATUS_CHANGED', 'SECURITY_ALERT', 'ORB_STATE_CHANGED'
  };
  humanReadable: string;      // Ex: "Todos os dias às 08:00" ou "A cada 30 min"
}

/**
 * Condição opcional para filtrar a ação após o disparo do gatilho
 */
export interface AutomationCondition {
  field: string;              // Ex: 'device.type', 'battery', 'status'
  operator: 'EQUALS' | 'NOT_EQUALS' | 'GREATER_THAN' | 'LESS_THAN' | 'CONTAINS';
  value: any;
}

/**
 * Ação associada que a automação executará
 */
export interface AutomationAction {
  type: 'EXECUTE_TOOL' | 'SEND_NOTIFICATION' | 'UPDATE_ORB_STATE';
  toolName?: string;
  parameters?: Record<string, any>;
  description: string;        // Ex: "Consultar métricas do sistema"
  expectedRiskLevel: ToolRiskLevel;
}

/**
 * Status de execução possíveis
 */
export type AutomationStatusType = 
  | 'SUCCESS' 
  | 'BLOCKED_BY_POLICY' 
  | 'WAITING_CONSENT' 
  | 'FAILED' 
  | 'SKIPPED_BUSY';

/**
 * Registro de log individual de uma execução de automação
 */
export interface AutomationExecutionLog {
  id: string;
  ruleId: string;
  ruleName: string;
  timestamp: string;          // ISO String
  timeHms: string;            // HH:MM:SS
  triggerType: AutomationTriggerType;
  actionExecuted: string;
  status: AutomationStatusType;
  riskLevel: ToolRiskLevel;
  durationMs: number;
  outputSummary?: string;
  errorMessage?: string;
  auditId?: string;
  parametersHash?: string;
  consentAuditId?: string;
  simulated: boolean;
  isNative?: boolean;
  retryCount?: number;
}

/**
 * Definição completa de uma Regra de Automação
 */
export interface AutomationRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  conditions?: AutomationCondition[];
  action: AutomationAction;
  lastExecutedAt?: string;
  lastExecutionStatus?: AutomationStatusType;
  autoRetry?: boolean;
  maxRetries?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Contrato do ouvinte do Barramento de Eventos (EventBus)
 */
export type EventBusListener<T = any> = (payload: T) => void | Promise<void>;

/**
 * Interface do Barramento de Eventos
 */
export interface IEventBus {
  subscribe<T = any>(event: string, listener: EventBusListener<T>): () => void;
  publish<T = any>(event: string, payload?: T): Promise<void>;
  clear(): void;
  listenerCount(event: string): number;
}

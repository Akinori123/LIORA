/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolRiskLevel } from '../tools/types';

export type { ToolRiskLevel };

/** Decisão categórica de avaliação de permissão */
export type PermissionDecisionEffect = 'ALLOW' | 'DENY';

/** Perfis de segurança do sistema */
export type SecurityProfileName = 'STRICT' | 'STANDARD' | 'DEVELOPER';

/** Códigos de negação estruturados e auditáveis */
export type PermissionDenialCode =
  | 'NO_POLICY_CONFIGURED'
  | 'PROFILE_UNKNOWN'
  | 'SESSION_INVALID_OR_MISSING'
  | 'TOOL_NOT_REGISTERED'
  | 'TOOL_NOT_IN_PROFILE_WHITELIST'
  | 'TOOL_EXPLICITLY_DENIED'
  | 'RISK_LEVEL_EXCEEDS_PROFILE'
  | 'REQUIRES_USER_CONFIRMATION'
  | 'CONSENT_TOKEN_MISSING'
  | 'CONSENT_TOKEN_INVALID'
  | 'CONSENT_TOKEN_ALREADY_USED'
  | 'CONSENT_TOKEN_EXPIRED'
  | 'CONSENT_TOOL_MISMATCH'
  | 'CONSENT_PARAMETER_MISMATCH'
  | 'CONSENT_SESSION_MISMATCH'
  | 'CANONICALIZATION_FAILED'
  | 'SECURITY_CONSTRAINT_VIOLATION'
  | 'ACTUATOR_UNREACHABLE'
  | 'DENY_R1_BLOCKED_IN_PHASE_6_2B'
  | 'DENY_R2_NOT_PERMITTED_IN_PHASE_6_2'
  | 'DENY_CRITICAL_BLOCKED';

/** Contexto de segurança da requisição avaliada pelo backend */
export interface SecurityRequestContext {
  readonly sessionId: string;
  readonly clientIp?: string;
  readonly serverTimestamp: number;
  readonly consentToken?: string;
}

/** Configuração imutável de perfil de segurança */
export interface SecurityProfileConfig {
  readonly profileName: SecurityProfileName;
  readonly allowedTools: readonly string[];
  readonly deniedTools?: readonly string[];
  readonly requireConfirmationForR1: boolean;
  readonly allowR2: false; // Invariante: R2 bloqueado no Marco 6.2
  readonly allowR3: false; // Invariante: R3 categoricamente proibido no web preview
}

/** Resultado formal e auditável da avaliação de permissão */
export interface PermissionEvaluationResult {
  readonly decision: PermissionDecisionEffect;
  readonly toolName: string;
  readonly riskLevel: ToolRiskLevel;
  readonly code?: PermissionDenialCode;
  readonly reason: string;
  readonly parametersHash?: string;
  readonly requiredConfirmation?: boolean;
  /** ID de auditoria do consentimento HMAC consumido (presente quando R1/R2 autorizados por consentimento) */
  readonly consentAuditId?: string;
  readonly evaluationTimeMs: number;
  readonly timestamp: string;
  readonly auditId: string;
}

/** Registro de auditoria seguro (estritamente sem segredos ou tokens) */
export interface SecurityAuditEvent {
  readonly sequenceNumber: number; // Identificador sequencial monotônico para ordenação determinística
  readonly auditId: string;
  readonly timestamp: string;
  readonly eventType: 'PERMISSION_EVALUATION' | 'CONSENT_ISSUED' | 'CONSENT_CONSUMED' | 'SECURITY_VIOLATION';
  readonly toolName: string;
  readonly riskLevel: ToolRiskLevel;
  readonly decision: PermissionDecisionEffect;
  readonly denialCode?: PermissionDenialCode;
  readonly sessionId: string;
  readonly clientIp?: string;
  readonly parametersHash?: string;
  readonly consentAuditId?: string;
  readonly durationMs: number;
  readonly simulated: true;
}

/** Opções de consulta para a trilha de auditoria */
export interface AuditQueryFilter {
  /** Quantidade máxima de registros a retornar (1 a 200, padrão: 50) */
  readonly limit?: number;
  /** Filtrar por tipo de evento específico */
  readonly eventType?: SecurityAuditEvent['eventType'];
  /** Filtrar por decisão de permissão */
  readonly decision?: PermissionDecisionEffect;
  /** Filtrar por nome da ferramenta */
  readonly toolName?: string;
  /** Ordem cronológica dos eventos: 'desc' (mais recentes primeiro, padrão) ou 'asc' */
  readonly order?: 'desc' | 'asc';
}

/** Interface pública do registrador de auditoria seguro */
export interface IAuditLogger {
  readonly maxCapacity: number;
  readonly count: number;

  logEvent(event: Omit<SecurityAuditEvent, 'sequenceNumber'>): Readonly<SecurityAuditEvent>;
  queryEvents(filter?: AuditQueryFilter): readonly Readonly<SecurityAuditEvent>[];
  clear(): void;
}

/** Registro interno de consentimento (armazenado apenas como hash SHA-256 do token) */
export interface UserConsentRecord {
  readonly consentAuditId: string; // Identificador público não derivado do segredo
  readonly toolName: string;
  readonly parametersHash: string;
  readonly sessionId: string;
  readonly tokenHash: string; // Hash SHA-256 do token gerado (o segredo nunca é mantido em claro)
  readonly issuedAt: number;
  readonly expiresAt: number;
  consumed: boolean;
}

/** Interface do Permission Engine isolado */
export interface IPermissionEngine {
  readonly activeProfile: SecurityProfileConfig;

  evaluate(
    toolName: string,
    rawParameters: unknown,
    context: SecurityRequestContext,
    toolMetadata?: { riskLevel: ToolRiskLevel; consentToken?: string }
  ): Promise<PermissionEvaluationResult>;

  issueConsentToken(
    toolName: string,
    parametersHash: string,
    sessionId: string
  ): Promise<{ token: string; consentAuditId: string; expiresAt: number }>;

  consumeConsentToken(
    token: string,
    toolName: string,
    parametersHash: string,
    sessionId: string
  ): { success: boolean; denialCode?: PermissionDenialCode; consentAuditId?: string };

  getAuditEvents(): readonly SecurityAuditEvent[];
  clearAuditEvents(): void;
}

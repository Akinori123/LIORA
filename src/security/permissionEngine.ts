/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { generateUUID, generateRandomHex, sha256Sync } from '../utils/cryptoIsomorphic';
import { 
  IPermissionEngine, 
  PermissionDecisionEffect, 
  PermissionDenialCode, 
  PermissionEvaluationResult, 
  SecurityAuditEvent, 
  SecurityProfileConfig, 
  SecurityRequestContext, 
  UserConsentRecord,
  ToolRiskLevel,
  IAuditLogger
} from './types';
import { computeParametersHash, CanonicalizationError } from './canonicalizer';
import { toolRegistry } from '../tools/registry';
import { auditLogger, MAX_AUDIT_LOG_CAPACITY } from './auditLogger';
import { STRICT_PROFILE, isValidSecurityProfile } from './profiles';

export { STRICT_PROFILE };
export const DEFAULT_CONSENT_TTL_MS = 60 * 1000; // 60 segundos
export const MAX_AUDIT_EVENTS = MAX_AUDIT_LOG_CAPACITY; // 200 eventos

export class PermissionEngine implements IPermissionEngine {
  public readonly activeProfile: SecurityProfileConfig;
  private readonly consentRecords: Map<string, UserConsentRecord> = new Map();
  private readonly logger: IAuditLogger;
  // BUG FIX (memory leak): consentRecords nunca era limpo — cada token emitido
  // (mesmo consumido ou expirado) ficava para sempre no Map. Com uso contínuo de
  // automações R1+, o mapa crescia indefinidamente. Tokens são removidos ao
  // consumir; expirados são podados por GC na próxima emissão (teto de 500).
  private static readonly MAX_CONSENT_RECORDS = 500;

  constructor(
    profile: SecurityProfileConfig = STRICT_PROFILE,
    logger: IAuditLogger = auditLogger
  ) {
    this.activeProfile = profile;
    this.logger = logger;
  }

  /**
   * Avalia a permissão para uma ferramenta de forma puramente analítica.
   * IMPORTANTE: Esta função NUNCA executa a ferramenta sob nenhuma circunstância.
   */
  public async evaluate(
    toolName: string,
    rawParameters: unknown = {},
    context: SecurityRequestContext,
    toolMetadata?: { riskLevel: ToolRiskLevel; consentToken?: string }
  ): Promise<PermissionEvaluationResult> {
    const startTime = performance.now();
    const timestamp = new Date().toISOString();
    const auditId = generateUUID();
    // Consentimento HMAC opcional (R1/R2): passado via toolMetadata pela chamada
    const consentToken = toolMetadata?.consentToken;

    // 0. Validação de integridade do perfil ativo
    if (!isValidSecurityProfile(this.activeProfile)) {
      const result: PermissionEvaluationResult = {
        decision: 'DENY',
        toolName: toolName || 'unknown',
        riskLevel: toolMetadata?.riskLevel || 'R0',
        code: 'PROFILE_UNKNOWN',
        reason: 'Perfil de segurança ativo inválido ou malformado. Bloqueado por padrão.',
        evaluationTimeMs: Math.round(performance.now() - startTime),
        timestamp,
        auditId
      };
      return this.safelyLogAndReturn(result, context);
    }

    // 1. Validação estrita de contexto de sessão
    if (!context || !context.sessionId || typeof context.sessionId !== 'string' || context.sessionId.trim().length === 0) {
      const result: PermissionEvaluationResult = {
        decision: 'DENY',
        toolName: toolName || 'unknown',
        riskLevel: toolMetadata?.riskLevel || 'R0',
        code: 'SESSION_INVALID_OR_MISSING',
        reason: 'Contexto de sessão ausente, inválido ou não fornecido pelo servidor.',
        evaluationTimeMs: Math.round(performance.now() - startTime),
        timestamp,
        auditId
      };
      return this.safelyLogAndReturn(result, context);
    }

    // 2. Resolução da ferramenta e obtenção do nível de risco registrado no servidor
    const toolDef = toolRegistry.getTool(toolName);
    const resolvedRiskLevel: ToolRiskLevel = toolMetadata?.riskLevel || toolDef?.riskLevel || 'R0';

    if (!toolDef && !toolMetadata) {
      const result: PermissionEvaluationResult = {
        decision: 'DENY',
        toolName,
        riskLevel: 'R0',
        code: 'TOOL_NOT_REGISTERED',
        reason: `Ferramenta '${toolName}' não registrada no Tool Registry do servidor.`,
        evaluationTimeMs: Math.round(performance.now() - startTime),
        timestamp,
        auditId
      };
      return this.safelyLogAndReturn(result, context);
    }

    // 3. Canonicalização e hashing dos parâmetros
    let parametersHash: string | undefined;
    try {
      parametersHash = computeParametersHash(rawParameters);
    } catch (err: unknown) {
      const errMsg = err instanceof CanonicalizationError ? err.message : 'Falha na validação canônica de parâmetros.';
      const result: PermissionEvaluationResult = {
        decision: 'DENY',
        toolName,
        riskLevel: resolvedRiskLevel,
        code: 'CANONICALIZATION_FAILED',
        reason: `Parâmetros rejeitados pelo canonicalizador: ${errMsg}`,
        evaluationTimeMs: Math.round(performance.now() - startTime),
        timestamp,
        auditId
      };
      return this.safelyLogAndReturn(result, context);
    }

    // 4. Validação contra chaves proibidas da política ativa
    if (this.activeProfile.deniedTools?.includes(toolName)) {
      const result: PermissionEvaluationResult = {
        decision: 'DENY',
        toolName,
        riskLevel: resolvedRiskLevel,
        code: 'TOOL_EXPLICITLY_DENIED',
        reason: `Ferramenta '${toolName}' está explicitamente negada pelo perfil '${this.activeProfile.profileName}'.`,
        parametersHash,
        evaluationTimeMs: Math.round(performance.now() - startTime),
        timestamp,
        auditId
      };
      return this.safelyLogAndReturn(result, context, parametersHash);
    }

    // 5. Verificação de risco R3 (categoricamente proibido no web preview)
    if (resolvedRiskLevel === 'R3') {
      const result: PermissionEvaluationResult = {
        decision: 'DENY',
        toolName,
        riskLevel: 'R3',
        code: 'DENY_CRITICAL_BLOCKED',
        reason: 'Operações de nível R3 são categoricamente proibidas no ambiente web preview.',
        parametersHash,
        evaluationTimeMs: Math.round(performance.now() - startTime),
        timestamp,
        auditId
      };
      return this.safelyLogAndReturn(result, context, parametersHash);
    }

    // 6. R2 — MUTAÇÃO DESTRUTIVA: permitida APENAS com consentimento HMAC válido.
    // CORREÇÃO: antes era DENY categorico ('DENY_R2_NOT_PERMITTED_IN_PHASE_6_2'),
    // o que impedia o núcleo de controle do PC (matar processos, cliques simulados,
    // exclusão de arquivos) mesmo com consentimento. Agora o R2 segue o mesmo fluxo
    // de consentimento do R1 — token HMAC anti-replay obrigatório.
    if (resolvedRiskLevel === 'R2') {
      const consented = consentToken
        ? this.consumeConsentToken(consentToken, toolName, parametersHash, context.sessionId)
        : null;
      if (consented?.success) {
        const result: PermissionEvaluationResult = {
          decision: 'ALLOW',
          toolName,
          riskLevel: 'R2',
          reason: `Operação R2 '${toolName}' autorizada via consentimento HMAC explícito do operador.`,
          parametersHash,
          consentAuditId: consented.consentAuditId,
          evaluationTimeMs: Math.round(performance.now() - startTime),
          timestamp,
          auditId
        };
        return this.safelyLogAndReturn(result, context, parametersHash);
      }
      const result: PermissionEvaluationResult = {
        decision: 'DENY',
        toolName,
        riskLevel: 'R2',
        code: 'REQUIRES_USER_CONFIRMATION',
        reason: `Operação R2 '${toolName}' é destrutiva/mutável e exige confirmação explícita do operador.`,
        parametersHash,
        requiredConfirmation: true,
        evaluationTimeMs: Math.round(performance.now() - startTime),
        timestamp,
        auditId
      };
      return this.safelyLogAndReturn(result, context, parametersHash);
    }

    // 7. R1 — AÇÃO LOCAL REVERSÍVEL: idem, exige consentimento HMAC (não mais DENY categorico).
    if (resolvedRiskLevel === 'R1') {
      const consented = consentToken
        ? this.consumeConsentToken(consentToken, toolName, parametersHash, context.sessionId)
        : null;
      if (consented?.success) {
        const result: PermissionEvaluationResult = {
          decision: 'ALLOW',
          toolName,
          riskLevel: 'R1',
          reason: `Operação R1 '${toolName}' autorizada via consentimento HMAC explícito do operador.`,
          parametersHash,
          consentAuditId: consented.consentAuditId,
          evaluationTimeMs: Math.round(performance.now() - startTime),
          timestamp,
          auditId
        };
        return this.safelyLogAndReturn(result, context, parametersHash);
      }
      const result: PermissionEvaluationResult = {
        decision: 'DENY',
        toolName,
        riskLevel: 'R1',
        code: 'REQUIRES_USER_CONFIRMATION',
        reason: `Operação R1 '${toolName}' exige confirmação interativa do operador.`,
        parametersHash,
        requiredConfirmation: true,
        evaluationTimeMs: Math.round(performance.now() - startTime),
        timestamp,
        auditId
      };
      return this.safelyLogAndReturn(result, context, parametersHash);
    }

    // 8. Verificação de risco R0 (Leitura/Consulta)
    if (resolvedRiskLevel === 'R0') {
      // Requer presença na lista branca explícita do perfil
      if (!this.activeProfile.allowedTools.includes(toolName)) {
        const result: PermissionEvaluationResult = {
          decision: 'DENY',
          toolName,
          riskLevel: 'R0',
          code: 'TOOL_NOT_IN_PROFILE_WHITELIST',
          reason: `Ferramenta R0 '${toolName}' não autorizada na lista branca do perfil '${this.activeProfile.profileName}'.`,
          parametersHash,
          evaluationTimeMs: Math.round(performance.now() - startTime),
          timestamp,
          auditId
        };
        return this.safelyLogAndReturn(result, context, parametersHash);
      }

      // Autorização positiva concedida dentro do escopo da política
      const result: PermissionEvaluationResult = {
        decision: 'ALLOW',
        toolName,
        riskLevel: 'R0',
        reason: `Operação R0 '${toolName}' autorizada pela política explícita '${this.activeProfile.profileName}'.`,
        parametersHash,
        evaluationTimeMs: Math.round(performance.now() - startTime),
        timestamp,
        auditId
      };
      return this.safelyLogAndReturn(result, context, parametersHash);
    }

    // Caso padrão: negação
    const defaultResult: PermissionEvaluationResult = {
      decision: 'DENY',
      toolName,
      riskLevel: resolvedRiskLevel,
      code: 'NO_POLICY_CONFIGURED',
      reason: 'Nenhuma regra de política configurada autorizou a operação.',
      parametersHash,
      evaluationTimeMs: Math.round(performance.now() - startTime),
      timestamp,
      auditId
    };
    return this.safelyLogAndReturn(defaultResult, context, parametersHash);
  }

  /**
   * Emite um token de consentimento opaco de uso único.
   * Armazena EXCLUSIVAMENTE o hash SHA-256 do token, nunca o segredo em claro.
   */
  public async issueConsentToken(
    toolName: string,
    parametersHash: string,
    sessionId: string
  ): Promise<{ token: string; consentAuditId: string; expiresAt: number }> {
    const rawToken = generateRandomHex(32);
    const tokenHash = sha256Sync(rawToken);
    const consentAuditId = generateUUID();
    const issuedAt = Date.now();
    const expiresAt = issuedAt + DEFAULT_CONSENT_TTL_MS;

    const record: UserConsentRecord = {
      consentAuditId,
      toolName,
      parametersHash,
      sessionId,
      tokenHash,
      issuedAt,
      expiresAt,
      consumed: false
    };

    // Indexado pelo hash do token
    this.consentRecords.set(tokenHash, record);

    // BUG FIX: GC de registros expirados — roda no máximo a cada emissão e remove
    // registros vencidos, com teto duro de 500 registros (proteção contra flood).
    if (this.consentRecords.size > PermissionEngine.MAX_CONSENT_RECORDS) {
      const now = Date.now();
      for (const [hash, rec] of this.consentRecords) {
        if (rec.expiresAt < now) this.consentRecords.delete(hash);
      }
      // Se ainda acima do teto (flood de tokens não-expirados), descarta os mais antigos
      while (this.consentRecords.size > PermissionEngine.MAX_CONSENT_RECORDS) {
        const oldestKey = this.consentRecords.keys().next().value;
        if (oldestKey === undefined) break;
        this.consentRecords.delete(oldestKey);
      }
    }

    // Registro seguro de auditoria no logger injetado (sem segredos)
    try {
      const toolDef = toolRegistry.getTool(toolName);
      const resolvedRisk: ToolRiskLevel = toolDef?.riskLevel || 'R1';
      this.logger.logEvent({
        auditId: generateUUID(),
        timestamp: new Date().toISOString(),
        eventType: 'CONSENT_ISSUED',
        toolName,
        riskLevel: resolvedRisk,
        decision: 'ALLOW',
        sessionId,
        parametersHash,
        consentAuditId,
        durationMs: 0,
        simulated: true
      });
    } catch {
      // Ignora erro em emissão de consentimento para não quebrar contrato analítico
    }

    return {
      token: rawToken,
      consentAuditId,
      expiresAt
    };
  }

  /**
   * Valida e consome atomicamente um token de consentimento.
   * Operação síncrona no loop de eventos do Node.js garantindo uso único (anti-replay).
   */
  public consumeConsentToken(
    token: string,
    toolName: string,
    parametersHash: string,
    sessionId: string
  ): { success: boolean; denialCode?: PermissionDenialCode; consentAuditId?: string } {
    if (!token || typeof token !== 'string') {
      return { success: false, denialCode: 'CONSENT_TOKEN_MISSING' };
    }

    const tokenHash = sha256Sync(token);
    const record = this.consentRecords.get(tokenHash);

    if (!record) {
      return { success: false, denialCode: 'CONSENT_TOKEN_INVALID' };
    }

    if (record.consumed) {
      return { success: false, denialCode: 'CONSENT_TOKEN_ALREADY_USED', consentAuditId: record.consentAuditId };
    }

    if (Date.now() > record.expiresAt) {
      this.consentRecords.delete(tokenHash);
      return { success: false, denialCode: 'CONSENT_TOKEN_EXPIRED', consentAuditId: record.consentAuditId };
    }

    if (record.toolName !== toolName) {
      return { success: false, denialCode: 'CONSENT_TOOL_MISMATCH', consentAuditId: record.consentAuditId };
    }

    if (record.parametersHash !== parametersHash) {
      return { success: false, denialCode: 'CONSENT_PARAMETER_MISMATCH', consentAuditId: record.consentAuditId };
    }

    if (record.sessionId !== sessionId) {
      return { success: false, denialCode: 'CONSENT_SESSION_MISMATCH', consentAuditId: record.consentAuditId };
    }

    // Consumo atômico imediato
    record.consumed = true;
    // BUG FIX: remove o registro do mapa após consumo (não cresce indefinidamente)
    // — o record local já carrega todos os dados necessários para a auditoria abaixo.
    this.consentRecords.delete(tokenHash);

    // Registro seguro de auditoria do consumo
    try {
      const toolDef = toolRegistry.getTool(toolName);
      const resolvedRisk: ToolRiskLevel = toolDef?.riskLevel || 'R1';
      this.logger.logEvent({
        auditId: generateUUID(),
        timestamp: new Date().toISOString(),
        eventType: 'CONSENT_CONSUMED',
        toolName,
        riskLevel: resolvedRisk,
        decision: 'ALLOW',
        sessionId,
        parametersHash,
        consentAuditId: record.consentAuditId,
        durationMs: 0,
        simulated: true
      });
    } catch {
      // Falha de log pós-consumo
    }

    return { success: true, consentAuditId: record.consentAuditId };
  }

  /**
   * Obtém a lista imutável dos eventos recentes de auditoria através do logger.
   */
  public getAuditEvents(): readonly SecurityAuditEvent[] {
    return this.logger.queryEvents({ limit: this.logger.maxCapacity, order: 'asc' });
  }

  /**
   * Limpa os eventos de auditoria delegando ao logger injetado.
   */
  public clearAuditEvents(): void {
    this.logger.clear();
  }

  /**
   * Registra o evento de auditoria no logger injetado e aplica política FAIL-CLOSED:
   * Se o registro de auditoria falhar por qualquer exceção, uma decisão ALLOW
   * é OBRIGATORIAMENTE revertida para DENY.
   */
  private safelyLogAndReturn(
    result: PermissionEvaluationResult,
    context?: SecurityRequestContext,
    parametersHash?: string
  ): PermissionEvaluationResult {
    try {
      this.logger.logEvent({
        auditId: result.auditId,
        timestamp: result.timestamp,
        eventType: result.decision === 'ALLOW' ? 'PERMISSION_EVALUATION' : 'SECURITY_VIOLATION',
        toolName: result.toolName,
        riskLevel: result.riskLevel,
        decision: result.decision,
        denialCode: result.code,
        sessionId: context?.sessionId || 'missing',
        clientIp: context?.clientIp,
        parametersHash: parametersHash || result.parametersHash,
        durationMs: result.evaluationTimeMs,
        simulated: true
      });
      return result;
    } catch {
      // POLÍTICA FAIL-CLOSED:
      // Falha crítica de auditoria jamais pode permitir uma operação
      if (result.decision === 'ALLOW') {
        return {
          decision: 'DENY',
          toolName: result.toolName,
          riskLevel: result.riskLevel,
          code: 'SECURITY_CONSTRAINT_VIOLATION',
          reason: 'Falha crítica no subsistema de auditoria. Operação bloqueada por política fail-closed.',
          parametersHash: result.parametersHash,
          evaluationTimeMs: result.evaluationTimeMs,
          timestamp: result.timestamp,
          auditId: result.auditId
        };
      }
      return result;
    }
  }
}

// Instância padrão do Permission Engine para o projeto
export const permissionEngine = new PermissionEngine(STRICT_PROFILE, auditLogger);

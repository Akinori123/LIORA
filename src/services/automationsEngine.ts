/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { 
  AutomationRule, 
  AutomationExecutionLog, 
  AutomationCondition, 
  IEventBus,
  AutomationStatusType
} from '../types/automations';
import { eventBus } from '../utils/eventBus';
import { permissionEngine, PermissionEngine } from '../security/permissionEngine';
import { toolRegistry } from '../tools/registry';
import { verifierEngine } from '../tools/verifier';
import { isTauriEnvironment, executeLocalTool, LocalExecutionResult } from '../security/localBridge';
import { computeParametersHash } from '../security/canonicalizer';
import { auditLogger } from '../security/auditLogger';
import { IAuditLogger } from '../security/types';

export const AUTOMATIONS_STORAGE_KEY = 'liora_automations_v1';

export interface AutomationsEngineDependencies {
  eventBus?: IEventBus;
  permissionEngine?: PermissionEngine;
  executeBridge?: (toolName: string, parameters?: Record<string, any>, sessionId?: string) => Promise<LocalExecutionResult>;
  onConsentRequired?: (data: { ruleId: string; toolName: string; parameters: Record<string, any>; reason: string }) => void;
  onActivityLog?: (log: { category: 'system' | 'tool' | 'security'; summary: string; details: string; riskLevel: 'R0' | 'R1' | 'R2' | 'R3'; status: 'success' | 'warning' | 'error' }) => void;
  auditLogger?: IAuditLogger;
  preferNative?: boolean;
  isShieldModeActive?: () => boolean;
  retryDelayMs?: number;
}

export const DEFAULT_AUTOMATIONS: AutomationRule[] = [
  {
    id: 'auto-1',
    name: 'Relatório diário de sistema',
    description: 'Coleta informações e métricas de diagnóstico do sistema às 08:00',
    enabled: true,
    trigger: {
      type: 'TIME_OF_DAY',
      config: { timeOfDay: '08:00' },
      humanReadable: 'Todos os dias às 08:00'
    },
    action: {
      type: 'EXECUTE_TOOL',
      toolName: 'system_info',
      parameters: { detailLevel: 'standard' },
      description: 'Consultar métricas de hardware e OS',
      expectedRiskLevel: 'R0'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: 'auto-2',
    name: 'Verificação periódica de ambiente seguro',
    description: 'Audita variáveis de ambiente permitidas a cada 15 minutos',
    enabled: true,
    trigger: {
      type: 'TIME_INTERVAL',
      config: { intervalMinutes: 15 },
      humanReadable: 'A cada 15 min'
    },
    action: {
      type: 'EXECUTE_TOOL',
      toolName: 'system_read_env_safe',
      parameters: { variableName: 'NODE_ENV', keys: ['NODE_ENV'] },
      description: 'Auditar variáveis de ambiente permitidas',
      expectedRiskLevel: 'R0'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: 'auto-3',
    name: 'Backup de workspace em disco',
    description: 'Gravação periódica ou por evento no workspace local',
    enabled: false,
    trigger: {
      type: 'SYSTEM_EVENT',
      config: { eventName: 'BACKUP_TRIGGERED' },
      humanReadable: 'Ao receber evento BACKUP_TRIGGERED'
    },
    action: {
      type: 'EXECUTE_TOOL',
      toolName: 'workspace_write_file',
      parameters: { filePath: 'workspace/auto_backup.txt', content: 'Backup automático de sessão LIORA' },
      description: 'Gravar arquivo de snapshot no workspace',
      expectedRiskLevel: 'R1'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
];

export class AutomationsEngine {
  private rules: Map<string, AutomationRule> = new Map();
  private logs: AutomationExecutionLog[] = [];
  private eventBus: IEventBus;
  private permissionEngine: PermissionEngine;
  private executeBridge: (toolName: string, parameters?: Record<string, any>, sessionId?: string) => Promise<LocalExecutionResult>;
  private onConsentRequired?: AutomationsEngineDependencies['onConsentRequired'];
  private onActivityLog?: AutomationsEngineDependencies['onActivityLog'];
  
  // Controle estrito de listeners por regra para evitar memory leaks
  private ruleUnsubscribers: Map<string, () => void> = new Map();

  // Mutex de concorrência por regra
  private runningRules: Set<string> = new Set();

  // Prevenção de loop recursivo
  private recursionDepth: number = 0;
  private readonly maxRecursionDepth: number = 3;

  // Integração com Shield Mode
  private isShieldModeActiveFn?: () => boolean;
  private shieldModeActive: boolean = false;

  // Configuração de retentativa
  private retryDelayMs: number = 2000;

  public readonly preferNative: boolean;
  public readonly hasCustomBridge: boolean;

  constructor(deps: AutomationsEngineDependencies = {}) {
    this.eventBus = deps.eventBus || eventBus;
    this.permissionEngine = deps.permissionEngine || permissionEngine;
    this.executeBridge = deps.executeBridge || executeLocalTool;
    this.hasCustomBridge = Boolean(deps.executeBridge);
    this.preferNative = Boolean(deps.preferNative);
    this.onConsentRequired = deps.onConsentRequired;
    this.onActivityLog = deps.onActivityLog;
    this.isShieldModeActiveFn = deps.isShieldModeActive;
    if (deps.retryDelayMs !== undefined) {
      this.retryDelayMs = deps.retryDelayMs;
    }

    // Inicializa regras a partir do LocalStorage ou default
    this.initRules();
    this.setupEventListeners();
  }

  private initRules(): void {
    if (typeof localStorage !== 'undefined') {
      try {
        const raw = localStorage.getItem(AUTOMATIONS_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            for (const rule of parsed) {
              if (rule && rule.id && rule.name && rule.trigger && rule.action) {
                // Corrige parâmetros legados para compatibilidade total
                if (rule.action.toolName === 'system_read_env_safe' && !rule.action.parameters?.variableName) {
                  rule.action.parameters = { ...rule.action.parameters, variableName: 'NODE_ENV', keys: ['NODE_ENV'] };
                }
                this.rules.set(rule.id, { ...rule });
              }
            }
            return;
          }
        }
      } catch (err) {
        console.warn('[AutomationsEngine] Erro ao restaurar regras do LocalStorage:', err);
      }
    }

    for (const rule of DEFAULT_AUTOMATIONS) {
      this.rules.set(rule.id, { ...rule });
    }
  }

  private persistToLocalStorage(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const list = Array.from(this.rules.values());
      localStorage.setItem(AUTOMATIONS_STORAGE_KEY, JSON.stringify(list));
    } catch (err) {
      console.warn('[AutomationsEngine] Falha ao persistir regras no LocalStorage:', err);
    }
  }

  /**
   * Configura ouvintes no barramento EventBus para todas as regras ativas baseadas em SYSTEM_EVENT
   */
  public setupEventListeners(): void {
    // Limpa todos os ouvintes registrados anteriormente
    for (const unsub of this.ruleUnsubscribers.values()) {
      try { unsub(); } catch {}
    }
    this.ruleUnsubscribers.clear();

    for (const rule of this.rules.values()) {
      if (rule.enabled && rule.trigger.type === 'SYSTEM_EVENT' && rule.trigger.config.eventName) {
        this.subscribeRule(rule);
      }
    }
  }

  private subscribeRule(rule: AutomationRule): void {
    this.unsubscribeRule(rule.id);

    const eventName = rule.trigger.config.eventName;
    if (!eventName) return;

    const ruleId = rule.id;
    const unsub = this.eventBus.subscribe(eventName, async (payload) => {
      const currentRule = this.rules.get(ruleId);
      if (!currentRule || !currentRule.enabled) return;

      const matchesCondition = this.evaluateConditions(currentRule.conditions, payload);
      if (matchesCondition) {
        await this.triggerRule(ruleId, {
          isManual: false,
          payload,
          sessionId: `automation-event-${eventName}`
        });
      }
    });

    this.ruleUnsubscribers.set(ruleId, unsub);
  }

  private unsubscribeRule(ruleId: string): void {
    const unsub = this.ruleUnsubscribers.get(ruleId);
    if (unsub) {
      try { unsub(); } catch {}
      this.ruleUnsubscribers.delete(ruleId);
    }
  }

  public getRules(): AutomationRule[] {
    return Array.from(this.rules.values());
  }

  public getRule(id: string): AutomationRule | undefined {
    return this.rules.get(id);
  }

  public registerRule(rule: AutomationRule): void {
    if (!rule.id || !rule.name) {
      throw new Error('Regra inválida: ID e nome são obrigatórios.');
    }
    const cloned = { ...rule, updatedAt: new Date().toISOString() };
    this.rules.set(rule.id, cloned);
    if (cloned.enabled && cloned.trigger.type === 'SYSTEM_EVENT' && cloned.trigger.config.eventName) {
      this.subscribeRule(cloned);
    } else {
      this.unsubscribeRule(rule.id);
    }
    this.persistToLocalStorage();
  }

  public unregisterRule(id: string): boolean {
    this.unsubscribeRule(id);
    const deleted = this.rules.delete(id);
    if (deleted) {
      this.persistToLocalStorage();
    }
    return deleted;
  }

  public toggleRule(id: string, enabled?: boolean): AutomationRule | undefined {
    const rule = this.rules.get(id);
    if (!rule) return undefined;

    const newEnabled = enabled !== undefined ? enabled : !rule.enabled;
    const updated: AutomationRule = {
      ...rule,
      enabled: newEnabled,
      updatedAt: new Date().toISOString()
    };
    this.rules.set(id, updated);

    if (newEnabled && updated.trigger.type === 'SYSTEM_EVENT' && updated.trigger.config.eventName) {
      this.subscribeRule(updated);
    } else {
      this.unsubscribeRule(id);
    }

    this.persistToLocalStorage();
    return updated;
  }

  /**
   * Integração e controle do Shield Mode
   */
  public isShieldMode(): boolean {
    if (this.isShieldModeActiveFn) {
      return this.isShieldModeActiveFn();
    }
    return this.shieldModeActive;
  }

  public setShieldMode(active: boolean): void {
    this.shieldModeActive = active;
  }

  /**
   * Avalia condições de predicado da regra contra o payload fornecido
   */
  public evaluateConditions(conditions: AutomationCondition[] | undefined, payload: any): boolean {
    if (!conditions || conditions.length === 0) return true;
    if (!payload || typeof payload !== 'object') return false;

    for (const cond of conditions) {
      const actualVal = this.resolveField(payload, cond.field);
      switch (cond.operator) {
        case 'EQUALS':
          if (actualVal !== cond.value) return false;
          break;
        case 'NOT_EQUALS':
          if (actualVal === cond.value) return false;
          break;
        case 'GREATER_THAN':
          if (!(Number(actualVal) > Number(cond.value))) return false;
          break;
        case 'LESS_THAN':
          if (!(Number(actualVal) < Number(cond.value))) return false;
          break;
        case 'CONTAINS':
          if (typeof actualVal === 'string') {
            if (!actualVal.includes(String(cond.value))) return false;
          } else if (Array.isArray(actualVal)) {
            if (!actualVal.includes(cond.value)) return false;
          } else {
            return false;
          }
          break;
        default:
          return false;
      }
    }
    return true;
  }

  private resolveField(obj: any, path: string): any {
    if (!obj || !path) return undefined;
    const parts = path.split('.');
    let curr = obj;
    for (const p of parts) {
      if (curr === null || curr === undefined) return undefined;
      curr = curr[p];
    }
    return curr;
  }

  /**
   * Trata um evento do sistema disparando regras associadas
   */
  public async handleSystemEvent(eventName: string, payload?: any): Promise<AutomationExecutionLog[]> {
    if (this.recursionDepth >= this.maxRecursionDepth) {
      const loopBlockedLog: AutomationExecutionLog = {
        id: `auto-log-${Date.now()}-${Date.now().toString(36)}`,
        ruleId: 'event-loop',
        ruleName: `Anti-Loop Evento: ${eventName}`,
        timestamp: new Date().toISOString(),
        timeHms: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        triggerType: 'SYSTEM_EVENT',
        actionExecuted: `event:${eventName}`,
        status: 'BLOCKED_BY_POLICY',
        riskLevel: 'R0',
        durationMs: 0,
        errorMessage: `Limite de recursão de eventos atingido (profundidade máxima: ${this.maxRecursionDepth}). Disparo cancelado para evitar loop infinito.`,
        simulated: true
      };
      this.recordLog(loopBlockedLog);
      return [loopBlockedLog];
    }

    this.recursionDepth++;
    try {
      const logs: AutomationExecutionLog[] = [];
      for (const rule of this.rules.values()) {
        if (!rule.enabled) continue;
        if (rule.trigger.type === 'SYSTEM_EVENT' && rule.trigger.config.eventName === eventName) {
          const matchesCondition = this.evaluateConditions(rule.conditions, payload);
          if (matchesCondition) {
            const log = await this.triggerRule(rule.id, {
              isManual: false,
              payload,
              sessionId: `automation-event-${eventName}`
            });
            logs.push(log);
          }
        }
      }
      return logs;
    } finally {
      this.recursionDepth = Math.max(0, this.recursionDepth - 1);
    }
  }

  /**
   * Aciona a execução de uma regra de automação (manual ou automática)
   * Blindado com: Concurrency Mutex (lock per rule), Anti-Loop, Shield Mode e Auto-Retry
   */
  public async triggerRule(
    ruleId: string, 
    options: { isManual?: boolean; payload?: any; sessionId?: string } = {}
  ): Promise<AutomationExecutionLog> {
    const startTime = performance.now();
    const now = new Date();
    const timestamp = now.toISOString();
    const timeHms = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const logId = `auto-log-${Date.now()}-${Date.now().toString(36)}`;

    const rule = this.rules.get(ruleId);
    if (!rule) {
      const failLog: AutomationExecutionLog = {
        id: logId,
        ruleId,
        ruleName: 'Regra Desconhecida',
        timestamp,
        timeHms,
        triggerType: 'MANUAL',
        actionExecuted: 'none',
        status: 'FAILED',
        riskLevel: 'R0',
        durationMs: 0,
        errorMessage: `Regra com identificador '${ruleId}' não encontrada.`,
        simulated: true
      };
      this.recordLog(failLog);
      return failLog;
    }

    const isManual = Boolean(options.isManual);
    const triggerType = isManual ? 'MANUAL' : rule.trigger.type;
    const action = rule.action;
    const sessionId = options.sessionId || (isManual ? 'manual-ui-session' : `automation-${rule.id}`);

    // 1. MUTEX DE CONCORRÊNCIA: Se a regra já estiver rodando, descarta novos disparos e registra SKIPPED_BUSY
    if (this.runningRules.has(ruleId)) {
      const busyLog: AutomationExecutionLog = {
        id: logId,
        ruleId: rule.id,
        ruleName: rule.name,
        timestamp,
        timeHms,
        triggerType,
        actionExecuted: `${action.type}: ${action.toolName || action.description}`,
        status: 'SKIPPED_BUSY',
        riskLevel: action.expectedRiskLevel,
        durationMs: 0,
        errorMessage: `Execução descartada: a regra '${rule.name}' já está em execução no momento (mutex lock ativo).`,
        simulated: true
      };
      this.recordLog(busyLog);
      return busyLog;
    }

    // 2. PREVENÇÃO DE LOOP RECURSIVO: Limite estrito de chamadas em cadeia
    if (this.recursionDepth >= this.maxRecursionDepth) {
      const loopBlockedLog: AutomationExecutionLog = {
        id: logId,
        ruleId: rule.id,
        ruleName: rule.name,
        timestamp,
        timeHms,
        triggerType,
        actionExecuted: `${action.type}: ${action.toolName || action.description}`,
        status: 'BLOCKED_BY_POLICY',
        riskLevel: action.expectedRiskLevel,
        durationMs: 0,
        errorMessage: `Limite de recursão de eventos atingido (profundidade máxima: ${this.maxRecursionDepth}). Disparo cancelado para evitar loop infinito.`,
        simulated: true
      };
      this.updateRuleStatus(rule.id, 'BLOCKED_BY_POLICY');
      this.recordLog(loopBlockedLog);
      return loopBlockedLog;
    }

    // 3. TRAVA POR SHIELD MODE (Modo de Proteção Ativo)
    // Se o Shield Mode estiver ativo, bloqueia disparos autônomos sem supervisão
    if (this.isShieldMode() && !isManual) {
      const shieldBlockedLog: AutomationExecutionLog = {
        id: logId,
        ruleId: rule.id,
        ruleName: rule.name,
        timestamp,
        timeHms,
        triggerType,
        actionExecuted: `${action.type}: ${action.toolName || action.description}`,
        status: 'BLOCKED_BY_POLICY',
        riskLevel: action.expectedRiskLevel,
        durationMs: Math.round(performance.now() - startTime),
        errorMessage: 'Execução autônoma bloqueada: Shield Mode (Proteção Ativa) impede execuções não supervisionadas.',
        simulated: true
      };

      this.updateRuleStatus(rule.id, 'BLOCKED_BY_POLICY');
      this.recordLog(shieldBlockedLog);

      if (this.onActivityLog) {
        this.onActivityLog({
          category: 'security',
          summary: `Automação Bloqueada por Shield Mode: ${rule.name}`,
          details: `Disparo autônomo contido por Shield Mode ativo. Nível: ${action.expectedRiskLevel}.`,
          riskLevel: action.expectedRiskLevel,
          status: 'warning'
        });
      }

      return shieldBlockedLog;
    }

    // Validação de condições quando executado automaticamente
    if (!isManual && rule.conditions && !this.evaluateConditions(rule.conditions, options.payload)) {
      const skippedLog: AutomationExecutionLog = {
        id: logId,
        ruleId: rule.id,
        ruleName: rule.name,
        timestamp,
        timeHms,
        triggerType,
        actionExecuted: action.description,
        status: 'BLOCKED_BY_POLICY',
        riskLevel: action.expectedRiskLevel,
        durationMs: Math.round(performance.now() - startTime),
        errorMessage: 'Condições da regra não foram satisfeitas pelo payload do evento.',
        simulated: true
      };
      this.recordLog(skippedLog);
      return skippedLog;
    }

    // REGRA DE SEGURANÇA FUNDAMENTAL (Marco 8.2):
    // Bloqueio FAIL-CLOSED automático para execuções autônomas/background de ferramentas R1, R2 ou R3
    if (!isManual && (action.expectedRiskLevel === 'R1' || action.expectedRiskLevel === 'R2' || action.expectedRiskLevel === 'R3')) {
      let parametersHash = '';
      try {
        parametersHash = computeParametersHash(action.parameters || {});
      } catch {
        parametersHash = 'hash-error';
      }

      const blockedLog: AutomationExecutionLog = {
        id: logId,
        ruleId: rule.id,
        ruleName: rule.name,
        timestamp,
        timeHms,
        triggerType,
        actionExecuted: `${action.type}: ${action.toolName || action.description}`,
        status: 'BLOCKED_BY_POLICY',
        riskLevel: action.expectedRiskLevel,
        durationMs: Math.round(performance.now() - startTime),
        errorMessage: 'Operações de nível R1/R2/R3 são bloqueadas em execuções autônomas não supervisionadas (fail-closed). Consentimento humano obrigatório.',
        parametersHash,
        simulated: true
      };

      this.updateRuleStatus(rule.id, 'BLOCKED_BY_POLICY');
      this.recordLog(blockedLog);

      try {
        (this.permissionEngine as any).logger?.logEvent({
          auditId: `audit-blocked-${Date.now()}`,
          timestamp,
          eventType: 'SECURITY_VIOLATION',
          toolName: action.toolName || 'unknown',
          riskLevel: action.expectedRiskLevel,
          decision: 'DENY',
          denialCode: 'DENY_R1_BLOCKED_IN_PHASE_6_2B',
          sessionId,
          parametersHash,
          durationMs: Math.round(performance.now() - startTime),
          simulated: true
        });
      } catch {}

      if (this.onActivityLog) {
        this.onActivityLog({
          category: 'security',
          summary: `Automação Bloqueada: ${rule.name}`,
          details: `Tentativa autônoma de executar ferramenta de risco ${action.expectedRiskLevel} (${action.toolName}) contida por política fail-closed.`,
          riskLevel: action.expectedRiskLevel,
          status: 'warning'
        });
      }

      return blockedLog;
    }

    // Aquisição do Mutex & Incremento de Profundidade
    this.runningRules.add(ruleId);
    this.recursionDepth++;

    try {
      // Execução da Ação de Ferramenta
      if (action.type === 'EXECUTE_TOOL' && action.toolName) {
        const toolName = action.toolName;
        const parameters = action.parameters || {};

        const context = {
          sessionId,
          serverTimestamp: Date.now(),
          clientIp: '127.0.0.1'
        };

        let evaluation: any;
        try {
          evaluation = await this.permissionEngine.evaluate(toolName, parameters, context, {
            riskLevel: action.expectedRiskLevel
          });
        } catch (evalErr: any) {
          const failLog: AutomationExecutionLog = {
            id: logId,
            ruleId: rule.id,
            ruleName: rule.name,
            timestamp,
            timeHms,
            triggerType,
            actionExecuted: `tool:${toolName}`,
            status: 'FAILED',
            riskLevel: action.expectedRiskLevel,
            durationMs: Math.round(performance.now() - startTime),
            errorMessage: evalErr?.message || 'Falha na avaliação do PermissionEngine.',
            simulated: true,
            isNative: false
          };
          this.updateRuleStatus(rule.id, 'FAILED');
          this.recordLog(failLog);
          return failLog;
        }

        // Se a avaliação conceder ALLOW (ex: ferramentas R0 permitidas na política ou ações validadas)
        if (evaluation.decision === 'ALLOW') {
          const isNative = isTauriEnvironment() || this.preferNative || this.hasCustomBridge;
          let executionOutput: any = null;
          let success = true;
          let errorMsg: string | undefined;
          let isSimulated = true;
          let finalParamsHash = evaluation.parametersHash;
          let finalAuditId = evaluation.auditId;

          const executeOnce = async (): Promise<boolean> => {
            try {
              if (isNative) {
                const bridgeRes = await this.executeBridge(toolName, parameters, sessionId);
                success = bridgeRes.success;
                executionOutput = bridgeRes.data;
                errorMsg = bridgeRes.error;
                isSimulated = bridgeRes.simulated ?? false;
                if (bridgeRes.parametersHash) finalParamsHash = bridgeRes.parametersHash;
                if (bridgeRes.auditId) finalAuditId = bridgeRes.auditId;
                return success;
              } else {
                const toolDef = toolRegistry.getTool(toolName);
                if (toolDef) {
                  const rawResult = await toolDef.execute(parameters, {
                    sessionId,
                    timestamp: new Date().toISOString()
                  });
                  const verifyRes = await verifierEngine.verifyExecution(toolName, parameters, rawResult);
                  if (!verifyRes.passed) {
                    success = false;
                    errorMsg = verifyRes.error || `Falha na verificação pós-execução de '${toolName}'.`;
                    return false;
                  }
                  success = true;
                  executionOutput = rawResult;
                  isSimulated = true;
                  return true;
                } else {
                  const bridgeRes = await this.executeBridge(toolName, parameters, sessionId);
                  success = bridgeRes.success;
                  executionOutput = bridgeRes.data;
                  errorMsg = bridgeRes.error;
                  isSimulated = bridgeRes.simulated ?? true;
                  if (bridgeRes.parametersHash) finalParamsHash = bridgeRes.parametersHash;
                  if (bridgeRes.auditId) finalAuditId = bridgeRes.auditId;
                  return success;
                }
              }
            } catch (execErr: any) {
              success = false;
              errorMsg = execErr?.message || 'Erro durante execução da ferramenta.';
              return false;
            }
          };

          await executeOnce();

          // Auto-Retry: até 2 tentativas adicionais se configurado e falhou
          let retriesPerformed = 0;
          const maxRetries = rule.autoRetry ? (rule.maxRetries ?? 2) : 0;
          while (!success && retriesPerformed < maxRetries) {
            retriesPerformed++;
            if (this.retryDelayMs > 0) {
              await new Promise(r => setTimeout(r, this.retryDelayMs));
            }
            await executeOnce();
          }

          const durationMs = Math.round(performance.now() - startTime);
          const successLog: AutomationExecutionLog = {
            id: logId,
            ruleId: rule.id,
            ruleName: rule.name,
            timestamp,
            timeHms,
            triggerType,
            actionExecuted: `tool:${toolName}`,
            status: success ? 'SUCCESS' : 'FAILED',
            riskLevel: action.expectedRiskLevel,
            durationMs,
            outputSummary: success 
              ? (executionOutput ? JSON.stringify(executionOutput).slice(0, 120) : 'Executado com sucesso.')
              : undefined,
            errorMessage: errorMsg,
            auditId: finalAuditId,
            parametersHash: finalParamsHash,
            simulated: isSimulated,
            isNative: !isSimulated,
            retryCount: retriesPerformed > 0 ? retriesPerformed : undefined
          };

          this.updateRuleStatus(rule.id, success ? 'SUCCESS' : 'FAILED');
          this.recordLog(successLog);

          if (this.onActivityLog) {
            this.onActivityLog({
              category: 'tool',
              summary: `Automação executada: ${rule.name}`,
              details: `Ferramenta ${toolName} (${action.expectedRiskLevel}) concluída com status ${success ? 'sucesso' : 'falha'}${!isSimulated ? ' (Nativo Real)' : ''}${retriesPerformed > 0 ? ` [${retriesPerformed} retry]` : ''}.`,
              riskLevel: action.expectedRiskLevel,
              status: success ? 'success' : 'error'
            });
          }

          return successLog;
        }

        // Se requerer consentimento ou for negado por exigir confirmação
        if (evaluation.code === 'DENY_R1_BLOCKED_IN_PHASE_6_2B' || evaluation.requiredConfirmation || evaluation.decision === 'DENY') {
          if (isManual) {
            // No modo manual na interface, sinaliza necessidade de confirmação humana
            const waitingLog: AutomationExecutionLog = {
              id: logId,
              ruleId: rule.id,
              ruleName: rule.name,
              timestamp,
              timeHms,
              triggerType,
              actionExecuted: `tool:${toolName}`,
              status: 'WAITING_CONSENT',
              riskLevel: action.expectedRiskLevel,
              durationMs: Math.round(performance.now() - startTime),
              errorMessage: 'Operação R1 requer autorização humana explícita no painel de consentimento.',
              auditId: evaluation.auditId,
              parametersHash: evaluation.parametersHash,
              simulated: true,
              isNative: false
            };

            this.updateRuleStatus(rule.id, 'WAITING_CONSENT');
            this.recordLog(waitingLog);

            if (this.onConsentRequired) {
              this.onConsentRequired({
                ruleId: rule.id,
                toolName,
                parameters,
                reason: evaluation.reason || 'Operação R1 acionada manualmente requer confirmação.'
              });
            }

            if (this.onActivityLog) {
              this.onActivityLog({
                category: 'security',
                summary: `Consentimento Solicitado: ${rule.name}`,
                details: `Acionamento manual da ferramenta ${toolName} (${action.expectedRiskLevel}) aguardando aprovação humana (TTL 60s).`,
                riskLevel: action.expectedRiskLevel,
                status: 'warning'
              });
            }

            return waitingLog;
          } else {
            // Bloqueio de fundo
            const blockedLog: AutomationExecutionLog = {
              id: logId,
              ruleId: rule.id,
              ruleName: rule.name,
              timestamp,
              timeHms,
              triggerType,
              actionExecuted: `tool:${toolName}`,
              status: 'BLOCKED_BY_POLICY',
              riskLevel: action.expectedRiskLevel,
              durationMs: Math.round(performance.now() - startTime),
              errorMessage: evaluation.reason || 'Bloqueado pelo motor de permissões.',
              auditId: evaluation.auditId,
              parametersHash: evaluation.parametersHash,
              simulated: true,
              isNative: false
            };

            this.updateRuleStatus(rule.id, 'BLOCKED_BY_POLICY');
            this.recordLog(blockedLog);
            return blockedLog;
          }
        }
      }

      // Outros tipos de ação (NOTIFICAÇÃO / UI)
      const genericLog: AutomationExecutionLog = {
        id: logId,
        ruleId: rule.id,
        ruleName: rule.name,
        timestamp,
        timeHms,
        triggerType,
        actionExecuted: action.description,
        status: 'SUCCESS',
        riskLevel: action.expectedRiskLevel,
        durationMs: Math.round(performance.now() - startTime),
        outputSummary: 'Ação de notificação disparada com sucesso.',
        simulated: true
      };

      this.updateRuleStatus(rule.id, 'SUCCESS');
      this.recordLog(genericLog);
      return genericLog;
    } finally {
      this.runningRules.delete(ruleId);
      this.recursionDepth = Math.max(0, this.recursionDepth - 1);
    }
  }

  /**
   * Executa uma regra que estava pendente de consentimento humano após a aprovação formal do token
   */
  public async executeConfirmedRule(
    ruleId: string,
    consentToken: string,
    options: { sessionId?: string } = {}
  ): Promise<AutomationExecutionLog> {
    const startTime = performance.now();
    const now = new Date();
    const timestamp = now.toISOString();
    const timeHms = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const logId = `auto-log-${Date.now()}-${Date.now().toString(36)}`;

    const rule = this.rules.get(ruleId);
    if (!rule) {
      const failLog: AutomationExecutionLog = {
        id: logId,
        ruleId,
        ruleName: 'Regra Desconhecida',
        timestamp,
        timeHms,
        triggerType: 'MANUAL',
        actionExecuted: 'none',
        status: 'FAILED',
        riskLevel: 'R0',
        durationMs: 0,
        errorMessage: `Regra com identificador '${ruleId}' não encontrada.`,
        simulated: true,
        isNative: false
      };
      this.recordLog(failLog);
      return failLog;
    }

    const action = rule.action;
    const toolName = action.toolName || 'unknown_tool';
    const parameters = action.parameters || {};
    const sessionId = options.sessionId || `confirmed-${rule.id}`;

    // Calcular hash canônico SHA-256 dos parâmetros
    let parametersHash = '';
    try {
      parametersHash = computeParametersHash(parameters);
    } catch {
      parametersHash = 'hash-error';
    }

    // Consumo atômico do token de consentimento no PermissionEngine (anti-replay)
    const consentResult = this.permissionEngine.consumeConsentToken(
      consentToken,
      toolName,
      parametersHash,
      sessionId
    );

    if (!consentResult.success) {
      const deniedLog: AutomationExecutionLog = {
        id: logId,
        ruleId: rule.id,
        ruleName: rule.name,
        timestamp,
        timeHms,
        triggerType: 'MANUAL',
        actionExecuted: `tool:${toolName}`,
        status: 'BLOCKED_BY_POLICY',
        riskLevel: action.expectedRiskLevel,
        durationMs: Math.round(performance.now() - startTime),
        errorMessage: `Token de consentimento inválido ou rejeitado: ${consentResult.denialCode}`,
        parametersHash,
        consentAuditId: consentResult.consentAuditId,
        simulated: true,
        isNative: false
      };
      this.updateRuleStatus(rule.id, 'BLOCKED_BY_POLICY');
      this.recordLog(deniedLog);
      return deniedLog;
    }

    // Com consentimento válido, despachar a ação nativa real via executeBridge (Tauri IPC)
    let executionOutput: any = null;
    let success = true;
    let errorMsg: string | undefined;
    let isSimulated = false;
    let auditId = consentResult.consentAuditId;
    let finalParamsHash = parametersHash;

    const isNative = isTauriEnvironment() || this.preferNative || this.hasCustomBridge;

    try {
      if (isNative) {
        const bridgeRes = await this.executeBridge(toolName, parameters, sessionId);
        success = bridgeRes.success;
        executionOutput = bridgeRes.data;
        errorMsg = bridgeRes.error;
        isSimulated = bridgeRes.simulated ?? false;
        if (bridgeRes.auditId) auditId = bridgeRes.auditId;
        if (bridgeRes.parametersHash) finalParamsHash = bridgeRes.parametersHash;
      } else {
        const toolDef = toolRegistry.getTool(toolName);
        if (toolDef) {
          executionOutput = await toolDef.execute(parameters, { sessionId, timestamp: new Date().toISOString() });
          const verifyRes = await verifierEngine.verifyExecution(toolName, parameters, executionOutput);
          if (!verifyRes.passed) {
            success = false;
            errorMsg = verifyRes.error || `Falha na verificação pós-execução de '${toolName}'.`;
          } else {
            success = true;
          }
          isSimulated = true;
        } else {
          const bridgeRes = await this.executeBridge(toolName, parameters, sessionId);
          success = bridgeRes.success;
          executionOutput = bridgeRes.data;
          errorMsg = bridgeRes.error;
          isSimulated = bridgeRes.simulated ?? true;
          if (bridgeRes.auditId) auditId = bridgeRes.auditId;
          if (bridgeRes.parametersHash) finalParamsHash = bridgeRes.parametersHash;
        }
      }
    } catch (err: any) {
      success = false;
      errorMsg = err?.message || 'Falha ao executar ferramenta com consentimento aprovado.';
    }

    const durationMs = Math.round(performance.now() - startTime);
    const confirmedLog: AutomationExecutionLog = {
      id: logId,
      ruleId: rule.id,
      ruleName: rule.name,
      timestamp,
      timeHms,
      triggerType: 'MANUAL',
      actionExecuted: `tool:${toolName}`,
      status: success ? 'SUCCESS' : 'FAILED',
      riskLevel: action.expectedRiskLevel,
      durationMs,
      outputSummary: success 
        ? (executionOutput ? JSON.stringify(executionOutput).slice(0, 120) : 'Executado com sucesso via consentimento.')
        : undefined,
      errorMessage: errorMsg,
      auditId,
      consentAuditId: consentResult.consentAuditId,
      parametersHash: finalParamsHash,
      simulated: isSimulated,
      isNative: !isSimulated
    };

    this.updateRuleStatus(rule.id, success ? 'SUCCESS' : 'FAILED');
    this.recordLog(confirmedLog);

    if (this.onActivityLog) {
      this.onActivityLog({
        category: 'tool',
        summary: `Ação Autorizada Executada: ${rule.name}`,
        details: `Ferramenta ${toolName} executada com consentimento humano validado. Status: ${success ? 'Sucesso' : 'Falha'}${!isSimulated ? ' (Nativo Real)' : ''}.`,
        riskLevel: action.expectedRiskLevel,
        status: success ? 'success' : 'error'
      });
    }

    return confirmedLog;
  }

  /**
   * Avalia gatilhos temporais para simulação ou loop de verificação
   */
  public async tick(currentHms?: string): Promise<AutomationExecutionLog[]> {
    const targetHms = currentHms || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const executedLogs: AutomationExecutionLog[] = [];

    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;

      if (rule.trigger.type === 'TIME_OF_DAY' && rule.trigger.config.timeOfDay) {
        if (targetHms.startsWith(rule.trigger.config.timeOfDay)) {
          const log = await this.triggerRule(rule.id, {
            isManual: false,
            sessionId: `cron-${rule.id}-${targetHms.replace(':', '')}`
          });
          executedLogs.push(log);
        }
      }
    }

    return executedLogs;
  }

  /**
   * Exporta todas as regras cadastradas em formato JSON
   */
  public exportRulesJson(): string {
    return JSON.stringify(Array.from(this.rules.values()), null, 2);
  }

  /**
   * Importa regras a partir de uma string JSON formatada
   */
  public importRulesJson(jsonStr: string, mode: 'merge' | 'replace' = 'merge'): { success: boolean; count: number; error?: string } {
    try {
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) {
        return { success: false, count: 0, error: 'O arquivo JSON deve conter uma lista (array) de regras.' };
      }

      if (mode === 'replace') {
        // Limpa ouvintes existentes
        for (const unsub of this.ruleUnsubscribers.values()) {
          try { unsub(); } catch {}
        }
        this.ruleUnsubscribers.clear();
        this.rules.clear();
      }

      let validCount = 0;
      const nowIso = new Date().toISOString();

      for (const item of parsed) {
        if (item && item.name && item.trigger && item.action) {
          const ruleId = item.id || `auto-${Date.now()}-${Date.now().toString(36)}`;
          const rule: AutomationRule = {
            ...item,
            id: ruleId,
            enabled: item.enabled ?? true,
            createdAt: item.createdAt || nowIso,
            updatedAt: nowIso
          };
          this.rules.set(ruleId, rule);
          validCount++;
        }
      }

      this.setupEventListeners();
      this.persistToLocalStorage();

      return { success: true, count: validCount };
    } catch (err: any) {
      return { success: false, count: 0, error: err?.message || 'Falha ao processar arquivo JSON.' };
    }
  }

  private updateRuleStatus(ruleId: string, status: AutomationStatusType): void {
    const rule = this.rules.get(ruleId);
    if (rule) {
      rule.lastExecutedAt = new Date().toISOString();
      rule.lastExecutionStatus = status;
      rule.updatedAt = new Date().toISOString();
      this.persistToLocalStorage();
    }
  }

  private recordLog(log: AutomationExecutionLog): void {
    this.logs.unshift(log);
    if (this.logs.length > 200) {
      this.logs.pop();
    }

    if (log.status === 'FAILED' || log.status === 'BLOCKED_BY_POLICY') {
      try {
        auditLogger.logEvent({
          auditId: `audit-auto-${log.id}`,
          timestamp: log.timestamp,
          eventType: 'SECURITY_VIOLATION',
          toolName: log.actionExecuted || 'automations_engine',
          riskLevel: log.riskLevel || 'R1',
          decision: 'DENY',
          denialCode: 'SECURITY_CONSTRAINT_VIOLATION',
          sessionId: 'automations-session',
          durationMs: log.durationMs || 0,
          simulated: true
        });
      } catch (err) {
        console.warn('[AutomationsEngine] Erro ao registrar log forense:', err);
      }
    }
  }

  public getLogs(): AutomationExecutionLog[] {
    return [...this.logs];
  }

  public clearLogs(): void {
    this.logs = [];
  }

  public destroy(): void {
    for (const unsub of this.ruleUnsubscribers.values()) {
      try { unsub(); } catch {}
    }
    this.ruleUnsubscribers.clear();
  }
}

// Singleton padrão da aplicação
export const automationsEngine = new AutomationsEngine();

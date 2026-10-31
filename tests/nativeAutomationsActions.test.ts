/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import { EventBus } from '../src/utils/eventBus';
import { AutomationsEngine } from '../src/services/automationsEngine';
import { AutomationRule } from '../src/types/automations';
import { PermissionEngine } from '../src/security/permissionEngine';
import { SecurityProfileConfig } from '../src/security/types';
import { AuditLogger } from '../src/security/auditLogger';
import { computeParametersHash } from '../src/security/canonicalizer';
import { LocalExecutionResult } from '../src/security/localBridge';

// Perfil de teste permissivo para permitir ferramentas de automação na whitelist
const TEST_DEVELOPER_PROFILE: SecurityProfileConfig = {
  profileName: 'DEVELOPER',
  allowedTools: ['system_info', 'get_system_hardware_telemetry', 'system_read_env_safe', 'system_exec_sandbox', 'workspace_write_file'],
  deniedTools: [],
  requireConfirmationForR1: true,
  allowR2: false,
  allowR3: false
};

test('NAA-01: Disparo de SYSTEM_EVENT executando telemetria nativa real via Tauri IPC', async () => {
  const bus = new EventBus();
  const testLogger = new AuditLogger(50);
  const testPermission = new PermissionEngine(TEST_DEVELOPER_PROFILE, testLogger);

  // Simular IPC nativo do Tauri com telemetria de hardware real
  const mockIpcCalls: { toolName: string; parameters: any; sessionId?: string }[] = [];
  const mockExecuteBridge = async (
    toolName: string,
    parameters: Record<string, any> = {},
    sessionId?: string
  ): Promise<LocalExecutionResult> => {
    mockIpcCalls.push({ toolName, parameters, sessionId });
    return {
      toolName,
      success: true,
      data: {
        cpu_usage_percent: 24.5,
        memory_usage_percent: 48.2,
        is_real_hardware: true,
        hostname: 'liora-native-pc'
      },
      simulated: false,
      riskLevel: 'R0',
      executionTimeMs: 14,
      timestamp: new Date().toISOString(),
      parametersHash: computeParametersHash(parameters),
      auditId: `audit-native-${Date.now()}`
    };
  };

  const engine = new AutomationsEngine({
    eventBus: bus,
    permissionEngine: testPermission,
    executeBridge: mockExecuteBridge,
    preferNative: true
  });

  const ruleTelemetry: AutomationRule = {
    id: 'rule-auto-telemetry-real',
    name: 'Coleta de Telemetria de Hardware em Tempo Real',
    description: 'Disparada por evento de sistema para monitoramento contínuo de hardware',
    enabled: true,
    trigger: {
      type: 'SYSTEM_EVENT',
      config: { eventName: 'HARDWARE_POLL_REQUESTED' },
      humanReadable: 'Ao receber HARDWARE_POLL_REQUESTED'
    },
    action: {
      type: 'EXECUTE_TOOL',
      toolName: 'get_system_hardware_telemetry',
      parameters: { detailLevel: 'full', intervalMs: 1000 },
      description: 'Coleta telemetria real via sysinfo Rust',
      expectedRiskLevel: 'R0'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  engine.registerRule(ruleTelemetry);

  // Disparar o evento no EventBus
  await bus.publish('HARDWARE_POLL_REQUESTED', { source: 'scheduler' });

  // Verificar histórico de execuções
  const logs = engine.getLogs();
  const execLog = logs.find(l => l.ruleId === 'rule-auto-telemetry-real');

  assert.ok(execLog, 'O log de execução da regra deve existir');
  assert.strictEqual(execLog.status, 'SUCCESS');
  assert.strictEqual(execLog.riskLevel, 'R0');
  assert.strictEqual(execLog.simulated, false, 'Execução nativa via IPC deve registrar simulated = false');
  assert.strictEqual(execLog.isNative, true, 'isNative deve ser true para chamadas reais do SO');
  assert.ok(execLog.outputSummary?.includes('cpu_usage_percent'), 'Deve conter resumo da saída nativa');
  assert.ok(execLog.parametersHash, 'Deve conter hash SHA-256 dos parâmetros');
  assert.strictEqual(execLog.parametersHash?.length, 64, 'Hash SHA-256 canônico deve ter 64 caracteres');

  // Verificar que o mock de IPC foi acionado com os parâmetros canônicos
  assert.strictEqual(mockIpcCalls.length, 1);
  assert.strictEqual(mockIpcCalls[0].toolName, 'get_system_hardware_telemetry');

  // Verificar registro de auditoria no AuditLogger
  const auditEvents = testLogger.queryEvents({ limit: 10 });
  const matchingAudit = auditEvents.find(e => e.toolName === 'get_system_hardware_telemetry');
  assert.ok(matchingAudit, 'Evento de auditoria deve ter sido registrado pelo PermissionEngine');
  assert.strictEqual(matchingAudit.decision, 'ALLOW');
  assert.strictEqual(matchingAudit.parametersHash, execLog.parametersHash);
});

test('NAA-02: Execução real de sandbox do SO (system_exec_sandbox) sob validação do PermissionEngine', async () => {
  const testLogger = new AuditLogger(50);
  const testPermission = new PermissionEngine(TEST_DEVELOPER_PROFILE, testLogger);

  let sandboxCommandDispatched = false;
  const mockBridge = async (
    toolName: string,
    parameters: Record<string, any> = {},
    sessionId?: string
  ): Promise<LocalExecutionResult> => {
    if (toolName === 'system_exec_sandbox') {
      sandboxCommandDispatched = true;
      return {
        toolName,
        success: true,
        data: {
          command: parameters.command,
          stdout: 'LIORA_SECURE_EXECUTION_NODE_v22.14.0\n',
          exitCode: 0
        },
        simulated: false,
        riskLevel: 'R1',
        executionTimeMs: 25,
        timestamp: new Date().toISOString(),
        parametersHash: computeParametersHash(parameters),
        auditId: `audit-sandbox-${Date.now()}`
      };
    }
    throw new Error(`Ferramenta desconhecida: ${toolName}`);
  };

  const engine = new AutomationsEngine({
    permissionEngine: testPermission,
    executeBridge: mockBridge,
    preferNative: true
  });

  const ruleSandbox: AutomationRule = {
    id: 'rule-sandbox-cli',
    name: 'Verificação de Versão Node em Sandbox Seguro',
    description: 'Executa comando whitelisted em sandbox local',
    enabled: true,
    trigger: {
      type: 'MANUAL',
      config: {},
      humanReadable: 'Acionamento manual pelo usuário'
    },
    action: {
      type: 'EXECUTE_TOOL',
      toolName: 'system_exec_sandbox',
      parameters: { command: 'node -v' },
      description: 'Executar node -v no sandbox seguro',
      expectedRiskLevel: 'R1'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  engine.registerRule(ruleSandbox);

  // Acionamento manual de ferramenta R1 deve entrar em WAITING_CONSENT
  const triggerLog = await engine.triggerRule('rule-sandbox-cli', { isManual: true });
  assert.strictEqual(triggerLog.status, 'WAITING_CONSENT');
  assert.strictEqual(triggerLog.riskLevel, 'R1');
  assert.strictEqual(sandboxCommandDispatched, false, 'Comando não pode ser executado antes da aprovação');

  // Gerar token de consentimento formal através do PermissionEngine
  const paramHash = computeParametersHash({ command: 'node -v' });
  const issued = await testPermission.issueConsentToken(
    'system_exec_sandbox',
    paramHash,
    'confirmed-rule-sandbox-cli'
  );

  // Executar a regra confirmada
  const confirmedLog = await engine.executeConfirmedRule('rule-sandbox-cli', issued.token, {
    sessionId: 'confirmed-rule-sandbox-cli'
  });

  assert.strictEqual(confirmedLog.status, 'SUCCESS');
  assert.strictEqual(confirmedLog.simulated, false, 'Execução confirmada deve ser real (simulated = false)');
  assert.strictEqual(confirmedLog.isNative, true);
  assert.strictEqual(sandboxCommandDispatched, true);
  assert.ok(confirmedLog.outputSummary?.includes('LIORA_SECURE_EXECUTION'));
  assert.strictEqual(confirmedLog.parametersHash, paramHash);
});

test('NAA-03: Bloqueio fail-closed estrito para execução autônoma de ferramenta R1 (workspace_write_file)', async () => {
  const bus = new EventBus();
  const testLogger = new AuditLogger(50);
  const testPermission = new PermissionEngine(TEST_DEVELOPER_PROFILE, testLogger);

  let bridgeCalled = false;
  const mockBridge = async (): Promise<LocalExecutionResult> => {
    bridgeCalled = true;
    throw new Error('Bridge não deveria ter sido chamada em execução autônoma não supervisionada!');
  };

  let securityAlertCount = 0;
  const engine = new AutomationsEngine({
    eventBus: bus,
    permissionEngine: testPermission,
    executeBridge: mockBridge,
    preferNative: true,
    onActivityLog: (log) => {
      if (log.category === 'security' && log.riskLevel === 'R1') {
        securityAlertCount++;
      }
    }
  });

  const ruleUnattendedWrite: AutomationRule = {
    id: 'rule-unattended-disk-write',
    name: 'Gravação Automática Não Supervisionada',
    description: 'Tentativa de gravar em disco a partir de webhook sem operador',
    enabled: true,
    trigger: {
      type: 'SYSTEM_EVENT',
      config: { eventName: 'EXTERNAL_WEBHOOK_EVENT' },
      humanReadable: 'Ao receber EXTERNAL_WEBHOOK_EVENT'
    },
    action: {
      type: 'EXECUTE_TOOL',
      toolName: 'workspace_write_file',
      parameters: { filePath: 'workspace/unattended_log.txt', content: 'Injeção de log sem supervisão' },
      description: 'Gravar arquivo no disco local',
      expectedRiskLevel: 'R1'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  engine.registerRule(ruleUnattendedWrite);

  // Disparar o webhook
  await bus.publish('EXTERNAL_WEBHOOK_EVENT', { payload: 'teste' });

  const logs = engine.getLogs();
  const blockedLog = logs.find(l => l.ruleId === 'rule-unattended-disk-write');

  assert.ok(blockedLog, 'Deve existir log da regra bloqueada');
  assert.strictEqual(blockedLog.status, 'BLOCKED_BY_POLICY');
  assert.strictEqual(blockedLog.riskLevel, 'R1');
  assert.strictEqual(bridgeCalled, false, 'Ponte de execução nativa NUNCA pode ser chamada para R1 autônomo');
  assert.strictEqual(securityAlertCount, 1, 'Deve emitir log de atividade de segurança');
  assert.ok(blockedLog.errorMessage?.includes('fail-closed'));
  assert.ok(blockedLog.parametersHash, 'O hash SHA-256 deve estar presente no log de bloqueio');
  assert.strictEqual(blockedLog.parametersHash?.length, 64);

  // Verificar que o AuditLogger registrou a tentativa bloqueada
  const audits = testLogger.queryEvents({ limit: 10 });
  const blockedAudit = audits.find(a => a.toolName === 'workspace_write_file');
  assert.ok(blockedAudit, 'Deve haver registro de auditoria para a ferramenta bloqueada');
});

test('NAA-04: Ciclo completo com proteção anti-replay de token de consentimento', async () => {
  const testLogger = new AuditLogger(50);
  const testPermission = new PermissionEngine(TEST_DEVELOPER_PROFILE, testLogger);

  let writeExecutionCount = 0;
  const mockBridge = async (toolName: string, parameters: Record<string, any> = {}): Promise<LocalExecutionResult> => {
    writeExecutionCount++;
    return {
      toolName,
      success: true,
      data: { written: true, filePath: parameters.filePath, bytes: 42 },
      simulated: false,
      riskLevel: 'R1',
      executionTimeMs: 18,
      timestamp: new Date().toISOString()
    };
  };

  const engine = new AutomationsEngine({
    permissionEngine: testPermission,
    executeBridge: mockBridge,
    preferNative: true
  });

  const ruleWrite: AutomationRule = {
    id: 'rule-disk-backup-manual',
    name: 'Backup Manual em Disco do Workspace',
    description: 'Gravação autorizada pelo operador no disco rígido',
    enabled: true,
    trigger: {
      type: 'MANUAL',
      config: {},
      humanReadable: 'Manual'
    },
    action: {
      type: 'EXECUTE_TOOL',
      toolName: 'workspace_write_file',
      parameters: { filePath: 'workspace/backup.json', content: '{"status":"ok"}' },
      description: 'Gravar backup no workspace físico',
      expectedRiskLevel: 'R1'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  engine.registerRule(ruleWrite);

  // 1. Acionamento manual entra em WAITING_CONSENT
  const initialLog = await engine.triggerRule('rule-disk-backup-manual', { isManual: true });
  assert.strictEqual(initialLog.status, 'WAITING_CONSENT');

  // 2. Emissão de token
  const expectedHash = computeParametersHash({ filePath: 'workspace/backup.json', content: '{"status":"ok"}' });
  const issued = await testPermission.issueConsentToken('workspace_write_file', expectedHash, 'confirmed-rule-disk-backup-manual');

  // 3. Primeira execução: com token válido
  const execLog1 = await engine.executeConfirmedRule('rule-disk-backup-manual', issued.token, {
    sessionId: 'confirmed-rule-disk-backup-manual'
  });
  assert.strictEqual(execLog1.status, 'SUCCESS');
  assert.strictEqual(execLog1.simulated, false);
  assert.strictEqual(writeExecutionCount, 1);

  // 4. Tentativa de re-executar com o mesmo token (Replay Attack): DEVE SER BLOQUEADA
  const execLogReplay = await engine.executeConfirmedRule('rule-disk-backup-manual', issued.token, {
    sessionId: 'confirmed-rule-disk-backup-manual'
  });
  assert.strictEqual(execLogReplay.status, 'BLOCKED_BY_POLICY');
  assert.ok(execLogReplay.errorMessage?.includes('CONSENT_TOKEN_ALREADY_USED'));
  assert.strictEqual(writeExecutionCount, 1, 'A contagem de execuções no disco NÃO pode aumentar no replay');
});

test('NAA-05: Tratamento defensivo contra falhas no Tauri IPC ou comandos de sistema', async () => {
  const testLogger = new AuditLogger(50);
  const testPermission = new PermissionEngine(TEST_DEVELOPER_PROFILE, testLogger);

  // Mock que simula erro de I/O de baixo nível no Rust IPC
  const mockBridgeFailing = async (): Promise<LocalExecutionResult> => {
    throw new Error('EACCES: Permissão negada pelo sistema operacional ao acessar descritor de arquivo');
  };

  const engine = new AutomationsEngine({
    permissionEngine: testPermission,
    executeBridge: mockBridgeFailing,
    preferNative: true
  });

  const ruleSystemInfo: AutomationRule = {
    id: 'rule-failing-system',
    name: 'Coleta com Falha de Driver',
    description: 'Simula hardware instável ou erro de dispositivo nativo',
    enabled: true,
    trigger: {
      type: 'MANUAL',
      config: {},
      humanReadable: 'Manual'
    },
    action: {
      type: 'EXECUTE_TOOL',
      toolName: 'system_info',
      parameters: { detailLevel: 'standard' },
      description: 'Consultar info do sistema',
      expectedRiskLevel: 'R0'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  engine.registerRule(ruleSystemInfo);

  // Disparo manual não deve quebrar o shell nem lançar uncaught exception
  await assert.doesNotReject(async () => {
    await engine.triggerRule('rule-failing-system', { isManual: true });
  });

  const finalLog = await engine.triggerRule('rule-failing-system', { isManual: true });
  assert.strictEqual(finalLog.status, 'FAILED');
  assert.ok(finalLog.errorMessage?.includes('EACCES') || finalLog.errorMessage?.includes('Permissão negada'));
  assert.ok(finalLog.durationMs >= 0);

  // Verificar que a regra permanece cadastrada e o motor saudável
  const rule = engine.getRule('rule-failing-system');
  assert.strictEqual(rule?.lastExecutionStatus, 'FAILED');
});

test('NAA-06: Avaliação de condições (evaluateConditions) com predicados dinâmicos e filtros de payload', async () => {
  const bus = new EventBus();
  const testLogger = new AuditLogger(50);
  const testPermission = new PermissionEngine(TEST_DEVELOPER_PROFILE, testLogger);

  let executedCount = 0;
  const mockBridge = async (toolName: string): Promise<LocalExecutionResult> => {
    executedCount++;
    return {
      toolName,
      success: true,
      data: { acknowledged: true },
      simulated: false,
      riskLevel: 'R0',
      executionTimeMs: 5,
      timestamp: new Date().toISOString()
    };
  };

  const engine = new AutomationsEngine({
    eventBus: bus,
    permissionEngine: testPermission,
    executeBridge: mockBridge,
    preferNative: true
  });

  const ruleConditional: AutomationRule = {
    id: 'rule-high-cpu-alert',
    name: 'Alerta de CPU Elevada',
    description: 'Disparada somente se o uso de CPU ultrapassar 80%',
    enabled: true,
    trigger: {
      type: 'SYSTEM_EVENT',
      config: { eventName: 'SYSINFO_METRICS_UPDATED' },
      humanReadable: 'Ao atualizar métricas'
    },
    conditions: [
      {
        field: 'metrics.cpuPercent',
        operator: 'GREATER_THAN',
        value: 80
      }
    ],
    action: {
      type: 'EXECUTE_TOOL',
      toolName: 'system_info',
      parameters: { alert: 'high_cpu' },
      description: 'Registrar diagnóstico de pico de CPU',
      expectedRiskLevel: 'R0'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  engine.registerRule(ruleConditional);

  // 1. Enviar evento com CPU em 45% (condição NÃO satisfeita)
  await bus.publish('SYSINFO_METRICS_UPDATED', { metrics: { cpuPercent: 45 } });
  assert.strictEqual(executedCount, 0, 'Não deve executar quando CPU < 80');

  // 2. Enviar evento com CPU em 92% (condição satisfeita)
  await bus.publish('SYSINFO_METRICS_UPDATED', { metrics: { cpuPercent: 92 } });
  assert.strictEqual(executedCount, 1, 'Deve executar quando CPU > 80');

  const logs = engine.getLogs();
  const successLog = logs.find(l => l.ruleId === 'rule-high-cpu-alert');
  assert.ok(successLog);
  assert.strictEqual(successLog.status, 'SUCCESS');
});

test('NAA-07: Acionamento via temporizador agendado (tick) despachando ação nativa real', async () => {
  const testLogger = new AuditLogger(50);
  const testPermission = new PermissionEngine(TEST_DEVELOPER_PROFILE, testLogger);

  let tickExecuted = false;
  const mockBridge = async (toolName: string, parameters: any): Promise<LocalExecutionResult> => {
    tickExecuted = true;
    return {
      toolName,
      success: true,
      data: { tickTime: '15:30', parameters },
      simulated: false,
      riskLevel: 'R0',
      executionTimeMs: 10,
      timestamp: new Date().toISOString(),
      parametersHash: computeParametersHash(parameters)
    };
  };

  const engine = new AutomationsEngine({
    permissionEngine: testPermission,
    executeBridge: mockBridge,
    preferNative: true
  });

  const ruleScheduled: AutomationRule = {
    id: 'rule-scheduled-1530',
    name: 'Auditoria Agendada das 15:30',
    description: 'Executa verificação de ambiente pontualmente às 15:30',
    enabled: true,
    trigger: {
      type: 'TIME_OF_DAY',
      config: { timeOfDay: '15:30' },
      humanReadable: 'Às 15:30'
    },
    action: {
      type: 'EXECUTE_TOOL',
      toolName: 'system_read_env_safe',
      parameters: { keys: ['NODE_ENV'] },
      description: 'Auditar variáveis permitidas',
      expectedRiskLevel: 'R0'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  engine.registerRule(ruleScheduled);

  // Executar tick em horário diferente (15:29)
  const logsBefore = await engine.tick('15:29');
  assert.strictEqual(logsBefore.length, 0);
  assert.strictEqual(tickExecuted, false);

  // Executar tick no horário exato (15:30)
  const logsAt = await engine.tick('15:30');
  assert.ok(logsAt.length >= 1);
  const scheduledLog = logsAt.find(l => l.ruleId === 'rule-scheduled-1530');
  assert.ok(scheduledLog);
  assert.strictEqual(scheduledLog.status, 'SUCCESS');
  assert.strictEqual(scheduledLog.simulated, false);
  assert.strictEqual(scheduledLog.isNative, true);
  assert.strictEqual(tickExecuted, true);
});

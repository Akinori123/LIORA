/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import { EventBus } from '../src/utils/eventBus';
import { AutomationsEngine, DEFAULT_AUTOMATIONS } from '../src/services/automationsEngine';
import { AutomationRule, SYSTEM_EVENTS } from '../src/types/automations';
import { useLioraStore } from '../src/store/lioraStore';
import { permissionEngine } from '../src/security/permissionEngine';

test('AUT-01: Publicação e recebimento de eventos no EventBus com isolamento de falhas', async () => {
  const bus = new EventBus();
  assert.strictEqual(bus.listenerCount('TEST_EVENT'), 0);

  const received: any[] = [];
  const unsub1 = bus.subscribe('TEST_EVENT', (data) => {
    received.push(data);
  });

  // Ouvinte com falha intencional para verificar tolerância e isolamento
  bus.subscribe('TEST_EVENT', () => {
    throw new Error('Falha simulada no ouvinte 2');
  });

  let thirdReceived = false;
  bus.subscribe('TEST_EVENT', () => {
    thirdReceived = true;
  });

  assert.strictEqual(bus.listenerCount('TEST_EVENT'), 3);

  await bus.publish('TEST_EVENT', { msg: 'primeira mensagem', code: 101 });

  assert.strictEqual(received.length, 1);
  assert.deepStrictEqual(received[0], { msg: 'primeira mensagem', code: 101 });
  assert.strictEqual(thirdReceived, true, 'O terceiro ouvinte deve ter sido executado mesmo após o erro do segundo');

  // Teste de desinscrição
  unsub1();
  assert.strictEqual(bus.listenerCount('TEST_EVENT'), 2);

  await bus.publish('TEST_EVENT', { msg: 'segunda mensagem' });
  assert.strictEqual(received.length, 1, 'O ouvinte desinscrito não deve receber mais eventos');

  // Limpeza total
  bus.clear();
  assert.strictEqual(bus.listenerCount('TEST_EVENT'), 0);
});

test('AUT-02: Execução bem-sucedida de ferramenta R0 permitida por regra agendada', async () => {
  const bus = new EventBus();
  const engine = new AutomationsEngine({
    eventBus: bus,
    permissionEngine,
    retryDelayMs: 0
  });

  const ruleR0: AutomationRule = {
    id: 'test-auto-r0',
    name: 'Coleta de Informações do Sistema R0',
    description: 'Executa a ferramenta R0 system_info de forma automatizada',
    enabled: true,
    trigger: {
      type: 'TIME_OF_DAY',
      config: { timeOfDay: '08:00' },
      humanReadable: 'Às 08:00'
    },
    action: {
      type: 'EXECUTE_TOOL',
      toolName: 'system_info',
      parameters: { detailLevel: 'standard' },
      description: 'Consultar métricas de hardware',
      expectedRiskLevel: 'R0'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  engine.registerRule(ruleR0);

  // Disparo simulando o agendador no horário exato
  const logs = await engine.tick('08:00');
  assert.ok(logs.length >= 1, 'Ao menos uma regra deve ter sido disparada no tick de 08:00');

  const targetLog = logs.find(l => l.ruleId === 'test-auto-r0');
  assert.ok(targetLog, 'O log da regra test-auto-r0 deve existir');
  assert.strictEqual(targetLog.status, 'SUCCESS', 'A ferramenta R0 permitida deve executar com sucesso');
  assert.strictEqual(targetLog.riskLevel, 'R0');
  assert.strictEqual(targetLog.simulated, true);
  assert.ok(targetLog.durationMs >= 0);
  assert.ok(targetLog.outputSummary, 'Deve haver resumo de saída da execução');

  // Verifica persistência no histórico de logs da engine
  const history = engine.getLogs();
  assert.ok(history.some(h => h.id === targetLog.id));
});

test('AUT-03: Bloqueio fail-closed automático de ferramenta R1 executada por gatilho autônomo sem supervisão', async () => {
  const bus = new EventBus();
  let activityLogged = false;

  const engine = new AutomationsEngine({
    eventBus: bus,
    permissionEngine,
    retryDelayMs: 0,
    onActivityLog: (log) => {
      if (log.category === 'security' && log.riskLevel === 'R1') {
        activityLogged = true;
      }
    }
  });

  const ruleR1Autonomous: AutomationRule = {
    id: 'test-auto-r1-blocked',
    name: 'Gravação Autônoma de Arquivo R1',
    description: 'Tentativa não supervisionada de gravar arquivo em background',
    enabled: true,
    trigger: {
      type: 'SYSTEM_EVENT',
      config: { eventName: 'TRIGGER_UNSUPERVISED_WRITE' },
      humanReadable: 'Ao evento TRIGGER_UNSUPERVISED_WRITE'
    },
    action: {
      type: 'EXECUTE_TOOL',
      toolName: 'workspace_write_file',
      parameters: { filePath: 'workspace/unattended.txt', content: 'Dado malicioso ou não supervisionado' },
      description: 'Gravar arquivo no disco',
      expectedRiskLevel: 'R1'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  engine.registerRule(ruleR1Autonomous);

  // Dispara o evento de sistema no barramento
  await bus.publish('TRIGGER_UNSUPERVISED_WRITE', { source: 'external_timer' });

  const history = engine.getLogs();
  const blockedLog = history.find(l => l.ruleId === 'test-auto-r1-blocked');

  assert.ok(blockedLog, 'Deve haver registro de log para a regra disparada');
  assert.strictEqual(blockedLog.status, 'BLOCKED_BY_POLICY', 'Operação R1 autônoma deve ser bloqueada por política');
  assert.strictEqual(blockedLog.riskLevel, 'R1');
  assert.ok(
    blockedLog.errorMessage?.includes('fail-closed') || blockedLog.errorMessage?.includes('bloqueadas'),
    'Mensagem de erro deve detalhar bloqueio fail-closed para execuções não supervisionadas'
  );

  assert.strictEqual(activityLogged, true, 'Deve ter emitido registro de segurança de atividade');

  const ruleState = engine.getRule('test-auto-r1-blocked');
  assert.strictEqual(ruleState?.lastExecutionStatus, 'BLOCKED_BY_POLICY');
});

test('AUT-04: Acionamento manual via UI com solicitação de consentimento interativo (WAITING_CONSENT)', async () => {
  const store = useLioraStore.getState();

  const ruleR1Manual: AutomationRule = {
    id: 'test-auto-r1-manual-ui',
    name: 'Snapshot Manual de Workspace R1',
    description: 'Acionamento manual feito pelo usuário na AutomationsView',
    enabled: true,
    trigger: {
      type: 'MANUAL',
      config: {},
      humanReadable: 'Acionamento manual'
    },
    action: {
      type: 'EXECUTE_TOOL',
      toolName: 'workspace_write_file',
      parameters: { filePath: 'workspace/manual_snapshot.txt', content: 'Snapshot autorizado pelo operador' },
      description: 'Gravar snapshot manual',
      expectedRiskLevel: 'R1'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  store.addAutomation(ruleR1Manual);

  // Limpa pendingConsent antes do acionamento
  store.setPendingConsent(null);
  assert.strictEqual(useLioraStore.getState().pendingConsent, null);

  // Dispara manualmente simulando o clique do usuário no botão Play da interface
  const log = await store.triggerAutomationNow('test-auto-r1-manual-ui');

  assert.ok(log, 'Deve retornar o log de execução do acionamento manual');
  assert.strictEqual(log.status, 'WAITING_CONSENT', 'Acionamento manual de ferramenta R1 deve entrar em WAITING_CONSENT');
  assert.strictEqual(log.riskLevel, 'R1');

  // Verifica que o consentimento pendente foi registrado no store para renderizar o ConsentCard
  const pending = useLioraStore.getState().pendingConsent;
  assert.ok(pending, 'Deve haver um estado de pendingConsent ativo no store');
  assert.strictEqual(pending.toolName, 'workspace_write_file');
  assert.strictEqual(pending.riskLevel, 'R1');
  assert.strictEqual(pending.status, 'PENDING');
  assert.ok(pending.expiresAt > Date.now(), 'Consentimento deve ter TTL futuro');
});

test('AUT-05: Aprovação direta de consentimento R1 na UI (approveAutomationConsent)', async () => {
  const store = useLioraStore.getState();

  const ruleId = 'test-auto-r1-approve-direct';
  const ruleR1: AutomationRule = {
    id: ruleId,
    name: 'Escrita Autorizada na UI R1',
    description: 'Regra autorizada diretamente pelo botão Aprovar Execução no card',
    enabled: true,
    trigger: {
      type: 'MANUAL',
      config: {},
      humanReadable: 'Acionamento manual'
    },
    action: {
      type: 'EXECUTE_TOOL',
      toolName: 'workspace_write_file',
      parameters: { filePath: 'workspace/approved_direct.txt', content: 'Gravado via aprovação inline' },
      description: 'Gravar com autorização inline',
      expectedRiskLevel: 'R1'
    },
    lastExecutionStatus: 'WAITING_CONSENT',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  store.addAutomation(ruleR1);

  // Dispara a aprovação direta do card (como faria o clique do botão "Aprovar Execução")
  const approvedLog = await store.approveAutomationConsent(ruleId);

  assert.ok(approvedLog, 'Deve retornar o log de execução confirmada');
  assert.strictEqual(approvedLog.status, 'SUCCESS', 'A execução deve ser concluída com SUCCESS após aprovação');
  assert.strictEqual(approvedLog.riskLevel, 'R1');
  assert.ok(approvedLog.consentAuditId, 'Deve conter consentAuditId rastreável');

  // O status da regra no store deve agora ser SUCCESS
  const updatedRule = useLioraStore.getState().automations.find(a => a.id === ruleId);
  assert.strictEqual(updatedRule?.lastExecutionStatus, 'SUCCESS');
});

test('AUT-06: Mutex de Concorrência (Lock por Regra) descartando disparos simultâneos com SKIPPED_BUSY', async () => {
  const bus = new EventBus();
  let bridgeCalled = 0;

  // Bridge com atraso controlado para simular uma tarefa assíncrona em execução
  const slowBridge = async () => {
    bridgeCalled++;
    await new Promise(r => setTimeout(r, 60));
    return {
      toolName: 'system_info',
      riskLevel: 'R0' as const,
      success: true,
      data: { status: 'ok' },
      simulated: true,
      executionTimeMs: 60,
      timestamp: new Date().toISOString()
    };
  };

  const engine = new AutomationsEngine({
    eventBus: bus,
    permissionEngine,
    executeBridge: slowBridge,
    retryDelayMs: 0
  });

  const ruleMutex: AutomationRule = {
    id: 'test-auto-mutex',
    name: 'Regra Mutex Longa',
    description: 'Testa bloqueio de disparos concorrentes',
    enabled: true,
    trigger: {
      type: 'MANUAL',
      config: {},
      humanReadable: 'Manual'
    },
    action: {
      type: 'EXECUTE_TOOL',
      toolName: 'system_info',
      parameters: {},
      description: 'Consultar dados',
      expectedRiskLevel: 'R0'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  engine.registerRule(ruleMutex);

  // Disparo 1: Inicia a execução
  const promise1 = engine.triggerRule('test-auto-mutex', { isManual: true });

  // Disparo 2 imediato: A regra ainda está rodando no lock
  const log2 = await engine.triggerRule('test-auto-mutex', { isManual: true });

  assert.strictEqual(log2.status, 'SKIPPED_BUSY', 'O segundo disparo concorrente deve retornar status SKIPPED_BUSY');
  assert.ok(log2.errorMessage?.includes('mutex') || log2.errorMessage?.includes('execução'));

  // Aguarda o término da primeira execução
  const log1 = await promise1;
  assert.strictEqual(log1.status, 'SUCCESS', 'O primeiro disparo deve terminar com sucesso');

  // Disparo 3 após liberação do lock: Deve ser aceito novamente
  const log3 = await engine.triggerRule('test-auto-mutex', { isManual: true });
  assert.strictEqual(log3.status, 'SUCCESS', 'Disparo após a liberação do lock deve executar com sucesso');
});

test('AUT-07: Prevenção de loop recursivo (Anti-Loop com maxRecursionDepth = 3)', async () => {
  const bus = new EventBus();
  const engine = new AutomationsEngine({
    eventBus: bus,
    permissionEngine,
    retryDelayMs: 0
  });

  const ruleRecursive: AutomationRule = {
    id: 'rule-recursive',
    name: 'Regra com Proteção Anti-Loop',
    description: 'Testa limite de recursão em cadeia',
    enabled: true,
    trigger: {
      type: 'SYSTEM_EVENT',
      config: { eventName: 'TRIGGER_PING' },
      humanReadable: 'Ao TRIGGER_PING'
    },
    action: {
      type: 'SEND_NOTIFICATION',
      description: 'Notificação recursiva',
      expectedRiskLevel: 'R0'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  engine.registerRule(ruleRecursive);

  // Simula limite de recursão atingido (profundidade >= 3)
  (engine as any).recursionDepth = 3;

  // Ao tentar disparar um evento com a profundidade no limite, deve bloquear imediatamente
  const logs = await engine.handleSystemEvent('TRIGGER_PING');
  assert.ok(logs.length > 0, 'Deve retornar ao menos um log de bloqueio');
  assert.strictEqual(logs[0].status, 'BLOCKED_BY_POLICY');
  assert.ok(logs[0].errorMessage?.includes('recursão'), 'Mensagem de erro deve detalhar limite de recursão de eventos');

  // Ao tentar acionar triggerRule diretamente no limite de recursão, também bloqueia
  const triggerLog = await engine.triggerRule('rule-recursive', { isManual: false });
  assert.strictEqual(triggerLog.status, 'BLOCKED_BY_POLICY');
  assert.ok(triggerLog.errorMessage?.includes('recursão'));
});

test('AUT-08: Unsubscribe limpo e prevenção de chamadas fantasma ao pausar ou deletar regras', async () => {
  const bus = new EventBus();
  let executions = 0;

  const engine = new AutomationsEngine({
    eventBus: bus,
    permissionEngine,
    retryDelayMs: 0,
    executeBridge: async () => {
      executions++;
      return {
        toolName: 'system_info',
        riskLevel: 'R0' as const,
        success: true,
        data: {},
        simulated: true,
        executionTimeMs: 5,
        timestamp: new Date().toISOString()
      };
    }
  });

  const ruleUnsub: AutomationRule = {
    id: 'test-auto-unsub',
    name: 'Regra Ouvinte EventBus',
    description: 'Testa desinscrição estrita',
    enabled: true,
    trigger: {
      type: 'SYSTEM_EVENT',
      config: { eventName: 'TEST_UNSUB_EVENT' },
      humanReadable: 'Ao TEST_UNSUB_EVENT'
    },
    action: {
      type: 'EXECUTE_TOOL',
      toolName: 'system_info',
      description: 'Consulta sistema',
      expectedRiskLevel: 'R0'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  engine.registerRule(ruleUnsub);

  // 1. Dispara evento enquanto a regra está ativa
  await bus.publish('TEST_UNSUB_EVENT', {});
  assert.strictEqual(executions, 1, 'Deve executar 1 vez quando ativa');

  // 2. Pausa a regra (toggleRule -> false)
  engine.toggleRule('test-auto-unsub', false);

  await bus.publish('TEST_UNSUB_EVENT', {});
  assert.strictEqual(executions, 1, 'Não deve executar quando pausada');

  // 3. Reativa a regra (toggleRule -> true)
  engine.toggleRule('test-auto-unsub', true);

  await bus.publish('TEST_UNSUB_EVENT', {});
  assert.strictEqual(executions, 2, 'Deve executar quando reativada');

  // 4. Remove a regra (unregisterRule)
  engine.unregisterRule('test-auto-unsub');

  await bus.publish('TEST_UNSUB_EVENT', {});
  assert.strictEqual(executions, 2, 'Não deve executar após ser deletada');
});

test('AUT-09: Respeito estrito ao Shield Mode bloqueando execuções autônomas', async () => {
  const bus = new EventBus();
  const engine = new AutomationsEngine({
    eventBus: bus,
    permissionEngine,
    retryDelayMs: 0
  });

  const ruleR0: AutomationRule = {
    id: 'test-auto-shield',
    name: 'Regra Autônoma sob Shield Mode',
    description: 'Testa contenção total pelo Shield Mode',
    enabled: true,
    trigger: {
      type: 'SYSTEM_EVENT',
      config: { eventName: 'TRIGGER_SHIELD_TEST' },
      humanReadable: 'Ao TRIGGER_SHIELD_TEST'
    },
    action: {
      type: 'EXECUTE_TOOL',
      toolName: 'system_info',
      parameters: {},
      description: 'Consulta R0',
      expectedRiskLevel: 'R0'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  engine.registerRule(ruleR0);

  // Ativa o Shield Mode
  engine.setShieldMode(true);
  assert.strictEqual(engine.isShieldMode(), true);

  // Disparo autônomo via barramento de eventos sob Shield Mode
  await bus.publish('TRIGGER_SHIELD_TEST', {});

  const history = engine.getLogs();
  const shieldLog = history.find(l => l.ruleId === 'test-auto-shield');

  assert.ok(shieldLog, 'Deve haver log para a tentativa de execução');
  assert.strictEqual(shieldLog.status, 'BLOCKED_BY_POLICY', 'Execução autônoma deve ser bloqueada quando Shield Mode estiver ativo');
  assert.ok(shieldLog.errorMessage?.includes('Shield Mode'), 'Mensagem deve indicar contenção por Shield Mode');

  // Desativa o Shield Mode
  engine.setShieldMode(false);
  assert.strictEqual(engine.isShieldMode(), false);

  // Agora o disparo autônomo deve prosseguir normalmente
  await bus.publish('TRIGGER_SHIELD_TEST', {});
  const successLog = engine.getLogs().find(l => l.ruleId === 'test-auto-shield' && l.status === 'SUCCESS');
  assert.ok(successLog, 'Deve executar com sucesso após o Shield Mode ser desativado');
});

test('AUT-10: Exportação e importação de regras em JSON com validação', () => {
  const engine = new AutomationsEngine({ retryDelayMs: 0 });

  const initialCount = engine.getRules().length;
  assert.ok(initialCount > 0, 'Deve ter regras padrão');

  // Exporta JSON
  const exportedJson = engine.exportRulesJson();
  assert.ok(typeof exportedJson === 'string');
  assert.ok(exportedJson.includes('Relatório diário de sistema'));

  // Importa com regra customizada
  const customJson = JSON.stringify([
    {
      id: 'imported-rule-1',
      name: 'Regra Importada de Backup',
      description: 'Carregada via JSON',
      enabled: true,
      trigger: {
        type: 'TIME_INTERVAL',
        config: { intervalMinutes: 60 },
        humanReadable: 'A cada 60 min'
      },
      action: {
        type: 'EXECUTE_TOOL',
        toolName: 'system_info',
        description: 'Métricas de hora em hora',
        expectedRiskLevel: 'R0'
      }
    }
  ]);

  const importResult = engine.importRulesJson(customJson, 'merge');
  assert.strictEqual(importResult.success, true);
  assert.strictEqual(importResult.count, 1);

  const found = engine.getRule('imported-rule-1');
  assert.ok(found);
  assert.strictEqual(found.name, 'Regra Importada de Backup');
});

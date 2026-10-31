import test from 'node:test';
import assert from 'node:assert';
import { 
  AuditLogger, 
  AuditLoggerError, 
  MAX_AUDIT_LOG_CAPACITY 
} from '../src/security/auditLogger';
import { 
  STRICT_PROFILE, 
  STANDARD_PROFILE, 
  DEVELOPER_PROFILE, 
  isValidSecurityProfile, 
  resolveSecurityProfile 
} from '../src/security/profiles';
import { PermissionEngine } from '../src/security/permissionEngine';
import { IAuditLogger, SecurityAuditEvent, SecurityRequestContext } from '../src/security/types';
import { toolRegistry } from '../src/tools/registry';

const createSampleEventInput = (overrides: Partial<Omit<SecurityAuditEvent, 'sequenceNumber'>> = {}) => ({
  auditId: `audit-${Math.random().toString(36).substr(2, 9)}`,
  timestamp: new Date().toISOString(),
  eventType: 'PERMISSION_EVALUATION' as const,
  toolName: 'system_info',
  riskLevel: 'R0' as const,
  decision: 'ALLOW' as const,
  sessionId: 'test-session',
  durationMs: 5,
  simulated: true as const,
  ...overrides
});

const createValidContext = (sessionId = 'valid-session-123'): SecurityRequestContext => ({
  sessionId,
  clientIp: '127.0.0.1',
  serverTimestamp: Date.now()
});

test('T-LOG-01: AuditLogger - Empty buffer and query limit boundaries', () => {
  const logger = new AuditLogger(200);
  assert.strictEqual(logger.count, 0);

  const initialEvents = logger.queryEvents();
  assert.strictEqual(initialEvents.length, 0);

  // Inserir um evento para testar sanitização de limites
  logger.logEvent(createSampleEventInput());
  assert.strictEqual(logger.count, 1);

  // Limite <= 0 deve ser sanitizado para no mínimo 1
  const zeroLimitQuery = logger.queryEvents({ limit: 0 });
  assert.strictEqual(zeroLimitQuery.length, 1);

  const negativeLimitQuery = logger.queryEvents({ limit: -5 });
  assert.strictEqual(negativeLimitQuery.length, 1);

  // Limite NaN deve usar o padrão (50)
  const nanLimitQuery = logger.queryEvents({ limit: NaN });
  assert.strictEqual(nanLimitQuery.length, 1);
});

test('T-LOG-02: AuditLogger - Preenchimento até 200 eventos e sequenceNumber monotônico', () => {
  const logger = new AuditLogger(200);

  for (let i = 1; i <= 200; i++) {
    const event = logger.logEvent(createSampleEventInput({ toolName: `tool_${i}` }));
    assert.strictEqual(event.sequenceNumber, i, `O evento ${i} deve ter sequenceNumber igual a ${i}`);
  }

  assert.strictEqual(logger.count, 200);

  // Ordem crescente
  const ascEvents = logger.queryEvents({ limit: 200, order: 'asc' });
  assert.strictEqual(ascEvents.length, 200);
  assert.strictEqual(ascEvents[0].sequenceNumber, 1);
  assert.strictEqual(ascEvents[199].sequenceNumber, 200);

  // Ordem decrescente padrão (mais recentes primeiro)
  const descEvents = logger.queryEvents({ limit: 200, order: 'desc' });
  assert.strictEqual(descEvents[0].sequenceNumber, 200);
  assert.strictEqual(descEvents[199].sequenceNumber, 1);
});

test('T-LOG-03: AuditLogger - Descarte FIFO estrito ao adicionar o 201º evento', () => {
  const logger = new AuditLogger(200);

  for (let i = 1; i <= 200; i++) {
    logger.logEvent(createSampleEventInput({ toolName: `tool_${i}` }));
  }

  assert.strictEqual(logger.count, 200);

  // Inserção do 201º evento
  const event201 = logger.logEvent(createSampleEventInput({ toolName: 'tool_201' }));
  assert.strictEqual(event201.sequenceNumber, 201);
  assert.strictEqual(logger.count, 200, 'A capacidade máxima deve permanecer em 200');

  // O evento 1 deve ter sido descartado (FIFO)
  const allEventsAsc = logger.queryEvents({ limit: 200, order: 'asc' });
  assert.strictEqual(allEventsAsc[0].sequenceNumber, 2, 'O evento mais antigo agora deve ser o 2');
  assert.strictEqual(allEventsAsc[199].sequenceNumber, 201, 'O evento mais recente deve ser o 201');
});

test('T-LOG-04: AuditLogger - Determinismo com timestamps idênticos (Desempate por sequenceNumber)', () => {
  const logger = new AuditLogger(200);
  const fixedTimestamp = '2026-10-17T21:00:00.000Z';

  for (let i = 1; i <= 5; i++) {
    logger.logEvent(createSampleEventInput({ timestamp: fixedTimestamp, toolName: `colisao_${i}` }));
  }

  const descEvents = logger.queryEvents({ limit: 10, order: 'desc' });
  assert.strictEqual(descEvents.length, 5);

  // Todos têm o mesmo timestamp exato
  for (const e of descEvents) {
    assert.strictEqual(e.timestamp, fixedTimestamp);
  }

  // Ordenação garantida estritamente por sequenceNumber
  assert.strictEqual(descEvents[0].sequenceNumber, 5);
  assert.strictEqual(descEvents[1].sequenceNumber, 4);
  assert.strictEqual(descEvents[2].sequenceNumber, 3);
  assert.strictEqual(descEvents[3].sequenceNumber, 2);
  assert.strictEqual(descEvents[4].sequenceNumber, 1);
});

test('T-LOG-05: AuditLogger - Isolamento e imutabilidade dos eventos (Frozen)', () => {
  const logger = new AuditLogger(200);
  const logged = logger.logEvent(createSampleEventInput({ toolName: 'original_tool' }));

  assert.ok(Object.isFrozen(logged), 'O evento retornado deve ser congelado');

  const queried = logger.queryEvents({ limit: 1 });
  assert.ok(Object.isFrozen(queried), 'O array de consulta deve ser congelado');
  assert.ok(Object.isFrozen(queried[0]), 'Os itens retornados devem ser congelados');

  // Tentativa de mutação externa deve falhar em strict mode
  assert.throws(() => {
    'use strict';
    (queried[0] as any).toolName = 'mutated_tool';
  });

  // O estado no logger permanece intocado
  const check = logger.queryEvents({ limit: 1 });
  assert.strictEqual(check[0].toolName, 'original_tool');
});

test('T-LOG-06: AuditLogger - Higiene absoluta de dados e rejeição de campos inválidos', () => {
  const logger = new AuditLogger(200);

  // Rejeição de campos obrigatórios ausentes
  assert.throws(() => {
    logger.logEvent({} as any);
  }, { name: 'AuditLoggerError', code: 'INVALID_EVENT_FIELD' });

  assert.throws(() => {
    logger.logEvent(createSampleEventInput({ auditId: '' }));
  }, { name: 'AuditLoggerError', code: 'INVALID_EVENT_FIELD' });

  assert.throws(() => {
    logger.logEvent(createSampleEventInput({ decision: 'INVALID' as any }));
  }, { name: 'AuditLoggerError', code: 'INVALID_EVENT_FIELD' });
});

test('T-LOG-07: AuditLogger - Consultas filtradas por eventType, decision e toolName', () => {
  const logger = new AuditLogger(200);

  logger.logEvent(createSampleEventInput({ eventType: 'PERMISSION_EVALUATION', decision: 'ALLOW', toolName: 'system_info' }));
  logger.logEvent(createSampleEventInput({ eventType: 'SECURITY_VIOLATION', decision: 'DENY', toolName: 'workspace_read_file' }));
  logger.logEvent(createSampleEventInput({ eventType: 'CONSENT_ISSUED', decision: 'ALLOW', toolName: 'system_exec_simulated' }));
  logger.logEvent(createSampleEventInput({ eventType: 'PERMISSION_EVALUATION', decision: 'DENY', toolName: 'system_info' }));

  // Filtro por decision
  const allowEvents = logger.queryEvents({ decision: 'ALLOW' });
  assert.strictEqual(allowEvents.length, 2);
  assert.ok(allowEvents.every(e => e.decision === 'ALLOW'));

  // Filtro por eventType
  const violationEvents = logger.queryEvents({ eventType: 'SECURITY_VIOLATION' });
  assert.strictEqual(violationEvents.length, 1);
  assert.strictEqual(violationEvents[0].toolName, 'workspace_read_file');

  // Filtro por toolName
  const systemInfoEvents = logger.queryEvents({ toolName: 'system_info' });
  assert.strictEqual(systemInfoEvents.length, 2);
});

test('T-PROF-01: Profiles - Validação e fallback seguro contra perfis malformados', () => {
  // Objeto malformado
  assert.strictEqual(isValidSecurityProfile(null), false);
  assert.strictEqual(isValidSecurityProfile({}), false);
  assert.strictEqual(isValidSecurityProfile({ profileName: 'UNKNOWN' }), false);
  // Violação de invariante de segurança: tentar permitir R2 ou R3
  assert.strictEqual(isValidSecurityProfile({
    profileName: 'STRICT',
    allowedTools: ['system_info'],
    requireConfirmationForR1: true,
    allowR2: true, // PROIBIDO
    allowR3: false
  }), false);

  // Resolução segura com fallback para STRICT
  const fallback = resolveSecurityProfile('INVALID_NAME');
  assert.strictEqual(fallback.profileName, 'STRICT');
  assert.strictEqual(fallback.allowedTools.includes('system_info'), true);
});

test('T-PROF-02: Profiles - STANDARD e DEVELOPER não concedem privilégios de execução', async () => {
  const engineStandard = new PermissionEngine(STANDARD_PROFILE);
  const engineDev = new PermissionEngine(DEVELOPER_PROFILE);
  const context = createValidContext();

  // R1 continua bloqueado sob STANDARD e DEVELOPER
  const resStdR1 = await engineStandard.evaluate('system_exec_simulated', { command: 'git status' }, context);
  assert.strictEqual(resStdR1.decision, 'DENY');
  assert.strictEqual(resStdR1.code, 'DENY_R1_BLOCKED_IN_PHASE_6_2B');

  const resDevR1 = await engineDev.evaluate('system_exec_simulated', { command: 'git status' }, context);
  assert.strictEqual(resDevR1.decision, 'DENY');
  assert.strictEqual(resDevR1.code, 'DENY_R1_BLOCKED_IN_PHASE_6_2B');

  // R3 permanece categoricamente proibido sob qualquer perfil
  const resDevR3 = await engineDev.evaluate('critical_tool', {}, context, { riskLevel: 'R3' });
  assert.strictEqual(resDevR3.decision, 'DENY');
  assert.strictEqual(resDevR3.code, 'DENY_CRITICAL_BLOCKED');
});

test('T-PROF-03: Profiles - STRICT preserva decisões anteriores (system_info ALLOW, workspace_read_file DENY)', async () => {
  const engine = new PermissionEngine(STRICT_PROFILE);
  const context = createValidContext();

  const resAllow = await engine.evaluate('system_info', { detailLevel: 'standard' }, context);
  assert.strictEqual(resAllow.decision, 'ALLOW');
  assert.strictEqual(resAllow.riskLevel, 'R0');

  const resDeny = await engine.evaluate('workspace_read_file', { filePath: 'docs/ROADMAP.md' }, context);
  assert.strictEqual(resDeny.decision, 'DENY');
});

test('T-INT-01: Integration - Fail-Closed: Falha no logger converte decisão ALLOW para DENY', async () => {
  // Mock do logger que simula falha crítica interna ao gravar eventos
  const faultyLogger: IAuditLogger = {
    maxCapacity: 200,
    count: 0,
    logEvent: () => {
      throw new Error('Falha simulada de I/O de auditoria');
    },
    queryEvents: () => [],
    clear: () => {}
  };

  const engine = new PermissionEngine(STRICT_PROFILE, faultyLogger);
  const context = createValidContext();

  // system_info normalmente receberia ALLOW. Com falha de auditoria, deve ser forçado a DENY!
  const res = await engine.evaluate('system_info', { detailLevel: 'standard' }, context);

  assert.strictEqual(res.decision, 'DENY', 'Falha de auditoria deve converter ALLOW para DENY (Fail-Closed)');
  assert.strictEqual(res.code, 'SECURITY_CONSTRAINT_VIOLATION');
  assert.ok(res.reason.includes('fail-closed'));
});

test('T-INT-02: Integration - Handlers de ferramentas NUNCA são executados durante avaliação ou auditoria', async () => {
  const logger = new AuditLogger(200);
  const engine = new PermissionEngine(STRICT_PROFILE, logger);
  const context = createValidContext();

  let toolHandlerCallCount = 0;
  const tool = toolRegistry.getTool('system_info');
  assert.ok(tool);

  const originalExecute = tool.execute;
  tool.execute = async (...args: any[]) => {
    toolHandlerCallCount++;
    return (originalExecute as any)(...args);
  };

  try {
    await engine.evaluate('system_info', { detailLevel: 'standard' }, context);
    await engine.evaluate('workspace_read_file', { filePath: 'docs/ROADMAP.md' }, context);
    await engine.evaluate('system_exec_simulated', { command: 'git status' }, context);

    assert.strictEqual(toolHandlerCallCount, 0, 'O handler execute() da ferramenta NUNCA deve ser chamado');
    assert.strictEqual(logger.count, 3, 'Três eventos de auditoria devem ter sido registrados');
  } finally {
    tool.execute = originalExecute;
  }
});

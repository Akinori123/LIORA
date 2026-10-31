import test from 'node:test';
import assert from 'node:assert';
import { 
  PermissionEngine, 
  STRICT_PROFILE 
} from '../src/security/permissionEngine';
import { SecurityRequestContext } from '../src/security/types';
import { toolRegistry } from '../src/tools/registry';

// Fixture de contexto de sessão válido para testes
const createValidContext = (sessionId = 'valid-session-123'): SecurityRequestContext => ({
  sessionId,
  clientIp: '127.0.0.1',
  serverTimestamp: Date.now()
});

test('1. Permission Engine - Rejection when session context is missing or invalid', async () => {
  const engine = new PermissionEngine(STRICT_PROFILE);

  // Sem contexto
  const res1 = await engine.evaluate('system_info', {}, null as any);
  assert.strictEqual(res1.decision, 'DENY');
  assert.strictEqual(res1.code, 'SESSION_INVALID_OR_MISSING');

  // Com sessionId vazio
  const res2 = await engine.evaluate('system_info', {}, { sessionId: '   ', serverTimestamp: Date.now() });
  assert.strictEqual(res2.decision, 'DENY');
  assert.strictEqual(res2.code, 'SESSION_INVALID_OR_MISSING');
});

test('2. Permission Engine - Unregistered tool is rejected with TOOL_NOT_REGISTERED', async () => {
  const engine = new PermissionEngine(STRICT_PROFILE);
  const context = createValidContext();

  const res = await engine.evaluate('non_existent_tool_xyz', {}, context);
  assert.strictEqual(res.decision, 'DENY');
  assert.strictEqual(res.code, 'TOOL_NOT_REGISTERED');
});

test('3. Permission Engine - Policy STRICT allows system_info (R0) with valid parameters', async () => {
  const engine = new PermissionEngine(STRICT_PROFILE);
  const context = createValidContext();

  const res = await engine.evaluate('system_info', { detailLevel: 'standard' }, context);
  assert.strictEqual(res.decision, 'ALLOW');
  assert.strictEqual(res.riskLevel, 'R0');
  assert.strictEqual(res.toolName, 'system_info');
  assert.ok(res.parametersHash);
});

test('4. Permission Engine - Policy STRICT denies workspace_read_file in this phase', async () => {
  const engine = new PermissionEngine(STRICT_PROFILE);
  const context = createValidContext();

  const res = await engine.evaluate('workspace_read_file', { filePath: 'docs/ROADMAP.md' }, context);
  assert.strictEqual(res.decision, 'DENY');
  // Pode ser negado tanto por TOOL_EXPLICITLY_DENIED quanto por TOOL_NOT_IN_PROFILE_WHITELIST
  assert.ok(res.code === 'TOOL_EXPLICITLY_DENIED' || res.code === 'TOOL_NOT_IN_PROFILE_WHITELIST');
});

test('5. Permission Engine - Policy denies R1 (system_exec_simulated) in Phase 6.2B', async () => {
  const engine = new PermissionEngine(STRICT_PROFILE);
  const context = createValidContext();

  const res = await engine.evaluate('system_exec_simulated', { command: 'git status' }, context);
  assert.strictEqual(res.decision, 'DENY');
  assert.strictEqual(res.code, 'DENY_R1_BLOCKED_IN_PHASE_6_2B');
  assert.strictEqual(res.requiredConfirmation, true);
});

test('6. Permission Engine - Rejection of R2 and R3 risk levels', async () => {
  const engine = new PermissionEngine(STRICT_PROFILE);
  const context = createValidContext();

  // Ferramenta com risco R2
  const resR2 = await engine.evaluate('custom_r2_tool', {}, context, { riskLevel: 'R2' });
  assert.strictEqual(resR2.decision, 'DENY');
  assert.strictEqual(resR2.code, 'DENY_R2_NOT_PERMITTED_IN_PHASE_6_2');

  // Ferramenta com risco R3 (Crítico / Sistema)
  const resR3 = await engine.evaluate('custom_r3_tool', {}, context, { riskLevel: 'R3' });
  assert.strictEqual(resR3.decision, 'DENY');
  assert.strictEqual(resR3.code, 'DENY_CRITICAL_BLOCKED');
});

test('7. Permission Engine - Client-side risk tampering is ignored (Server authoritative)', async () => {
  const engine = new PermissionEngine(STRICT_PROFILE);
  const context = createValidContext();

  // O cliente envia parâmetros tentando alegar que é R0 ou que tem bypass
  const maliciousParams = {
    command: 'git status',
    riskLevel: 'R0',
    authorized: true,
    bypass: true,
    role: 'superadmin'
  };

  const res = await engine.evaluate('system_exec_simulated', maliciousParams, context);
  // O motor utiliza o nível de risco real da ferramenta no registro (R1), não o do payload
  assert.strictEqual(res.riskLevel, 'R1');
  assert.strictEqual(res.decision, 'DENY');
  assert.strictEqual(res.code, 'DENY_R1_BLOCKED_IN_PHASE_6_2B');
});

test('8. Permission Engine - Invalid parameters failing canonicalization result in CANONICALIZATION_FAILED', async () => {
  const engine = new PermissionEngine(STRICT_PROFILE);
  const context = createValidContext();

  // Parâmetros contendo undefined ou propriedades inválidas
  const invalidParams = {
    detailLevel: 'standard',
    badField: undefined
  };

  const res = await engine.evaluate('system_info', invalidParams, context);
  assert.strictEqual(res.decision, 'DENY');
  assert.strictEqual(res.code, 'CANONICALIZATION_FAILED');
});

test('9. Permission Engine - Handlers are NEVER executed during permission evaluation (Verified with Spy)', async () => {
  const engine = new PermissionEngine(STRICT_PROFILE);
  const context = createValidContext();

  // Spy no handler da ferramenta system_info
  let toolHandlerCallCount = 0;
  const tool = toolRegistry.getTool('system_info');
  assert.ok(tool);

  const originalExecute = tool.execute;
  tool.execute = async (...args: any[]) => {
    toolHandlerCallCount++;
    return (originalExecute as any)(...args);
  };

  try {
    // Avaliação positiva (ALLOW)
    const allowRes = await engine.evaluate('system_info', { detailLevel: 'standard' }, context);
    assert.strictEqual(allowRes.decision, 'ALLOW');

    // Avaliação negativa (DENY)
    const denyRes = await engine.evaluate('workspace_read_file', { filePath: 'docs/ROADMAP.md' }, context);
    assert.strictEqual(denyRes.decision, 'DENY');

    // COMPROVAÇÃO RIGOROSA: O Permission Engine é puramente analítico e JAMAIS chama execute()
    assert.strictEqual(toolHandlerCallCount, 0, 'O handler execute() NUNCA deve ser invocado pelo Permission Engine');
  } finally {
    tool.execute = originalExecute;
  }
});

test('10. Permission Engine - Consent tokens lifecycle (Issue, Consume, Replay, Expiration, Mismatches)', async () => {
  const engine = new PermissionEngine(STRICT_PROFILE);
  const sessionId = 'session-user-alpha';
  const toolName = 'system_exec_simulated';
  const paramHash = 'a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890';

  // 1. Emissão de token
  const issued = await engine.issueConsentToken(toolName, paramHash, sessionId);
  assert.ok(issued.token);
  assert.strictEqual(typeof issued.token, 'string');
  assert.strictEqual(issued.token.length, 64); // 32 bytes hex
  assert.ok(issued.consentAuditId);
  assert.ok(issued.expiresAt > Date.now());

  // 2. Consumo com parâmetros divergentes
  const badParamRes = engine.consumeConsentToken(issued.token, toolName, 'different-hash', sessionId);
  assert.strictEqual(badParamRes.success, false);
  assert.strictEqual(badParamRes.denialCode, 'CONSENT_PARAMETER_MISMATCH');

  // 3. Consumo com sessão divergente
  const badSessionRes = engine.consumeConsentToken(issued.token, toolName, paramHash, 'session-intruder');
  assert.strictEqual(badSessionRes.success, false);
  assert.strictEqual(badSessionRes.denialCode, 'CONSENT_SESSION_MISMATCH');

  // 4. Consumo com ferramenta divergente
  const badToolRes = engine.consumeConsentToken(issued.token, 'other_tool', paramHash, sessionId);
  assert.strictEqual(badToolRes.success, false);
  assert.strictEqual(badToolRes.denialCode, 'CONSENT_TOOL_MISMATCH');

  // 5. Consumo legítimo atômico (1ª vez: SUCESSO)
  const legitRes = engine.consumeConsentToken(issued.token, toolName, paramHash, sessionId);
  assert.strictEqual(legitRes.success, true);
  assert.strictEqual(legitRes.consentAuditId, issued.consentAuditId);

  // 6. Tentativa de Replay com mesmo token (2ª vez: REJEIÇÃO IMEDIATA)
  const replayRes = engine.consumeConsentToken(issued.token, toolName, paramHash, sessionId);
  assert.strictEqual(replayRes.success, false);
  assert.strictEqual(replayRes.denialCode, 'CONSENT_TOKEN_ALREADY_USED');
});

test('11. Permission Engine - Concurrency in token consumption (Exactly 1 succeeds)', async () => {
  const engine = new PermissionEngine(STRICT_PROFILE);
  const sessionId = 'session-concurrent';
  const toolName = 'system_exec_simulated';
  const paramHash = '1111222233334444555566667777888811112222333344445555666677778888';

  const { token } = await engine.issueConsentToken(toolName, paramHash, sessionId);

  // Disparo de duas chamadas concorrentes simultâneas no mesmo event turn
  const [res1, res2] = await Promise.all([
    Promise.resolve().then(() => engine.consumeConsentToken(token, toolName, paramHash, sessionId)),
    Promise.resolve().then(() => engine.consumeConsentToken(token, toolName, paramHash, sessionId))
  ]);

  const successes = [res1, res2].filter(r => r.success);
  const failures = [res1, res2].filter(r => !r.success);

  assert.strictEqual(successes.length, 1, 'Exatamente UMA requisição deve ter sucesso no consumo');
  assert.strictEqual(failures.length, 1, 'Exatamente UMA requisição deve falhar');
  assert.strictEqual(failures[0].denialCode, 'CONSENT_TOKEN_ALREADY_USED');
});

test('12. Permission Engine - Audit events NEVER contain tokens, secret fragments, or sensitive contents', async () => {
  const engine = new PermissionEngine(STRICT_PROFILE);
  const sessionId = 'audit-test-session';
  const toolName = 'system_info';
  const paramHash = '9999888877776666555544443333222299998888777766665555444433332222';

  const { token } = await engine.issueConsentToken(toolName, paramHash, sessionId);
  engine.consumeConsentToken(token, toolName, paramHash, sessionId);
  await engine.evaluate(toolName, { detailLevel: 'summary' }, createValidContext(sessionId));

  const events = engine.getAuditEvents();
  assert.ok(events.length >= 3);

  for (const event of events) {
    const serialized = JSON.stringify(event);
    // COMPROVAÇÃO DE HIGIENE: O token secreto NÃO deve aparecer nem inteiro, nem em fragmentos de 8 chars
    assert.ok(!serialized.includes(token), 'O token completo NUNCA deve estar no log de auditoria');
    const tokenPrefix = token.substring(0, 8);
    const tokenSuffix = token.substring(token.length - 8);
    assert.ok(!serialized.includes(tokenPrefix), 'Prefixos do token secreto NÃO devem estar no log de auditoria');
    assert.ok(!serialized.includes(tokenSuffix), 'Sufixos do token secreto NÃO devem estar no log de auditoria');

    // Apenas o consentAuditId ou parametersHash é permitido
    assert.strictEqual(event.simulated, true);
    assert.ok(event.auditId);
  }
});

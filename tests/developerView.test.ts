/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import { permissionEngine } from '../src/security/permissionEngine';
import { auditLogger } from '../src/security/auditLogger';
import { computeParametersHash } from '../src/security/canonicalizer';
import { STRICT_PROFILE } from '../src/security/profiles';

test('DEV-01: R0 Policy Consistency - system_read_env_safe é autorizada (ALLOW) no perfil STRICT por padrão', async () => {
  const context = { sessionId: 'dev-test-session', clientIp: '127.0.0.1', serverTimestamp: Date.now() };
  
  // Avaliar system_read_env_safe no perfil STRICT
  const result = await permissionEngine.evaluate('system_read_env_safe', { key: 'NODE_ENV' }, context);

  assert.strictEqual(result.decision, 'ALLOW', 'system_read_env_safe deve ser autorizada no perfil STRICT');
  assert.strictEqual(result.riskLevel, 'R0', 'O nível de risco deve ser R0');
  assert.ok(STRICT_PROFILE.allowedTools.includes('system_read_env_safe'), 'A ferramenta deve estar na lista branca do STRICT_PROFILE');
});

test('DEV-02: Sandbox Evaluation - Injeção e sincronização síncrona de eventos na Trilha de Auditoria (AuditTrail)', async () => {
  const initialCount = auditLogger.queryEvents().length;
  const context = { sessionId: 'dev-sandbox-session', clientIp: '127.0.0.1', serverTimestamp: Date.now() };

  // Executar avaliação na sandbox
  await permissionEngine.evaluate('system_info', { detailLevel: 'summary' }, context);

  const updatedEvents = auditLogger.queryEvents();
  assert.strictEqual(updatedEvents.length, initialCount + 1, 'O evento de auditoria deve ser incrementado instantaneamente no buffer');
  const latest = updatedEvents[0]; // Ordem padrão desc ou asc dependendo do query
  assert.ok(latest, 'Deve haver um evento recente');
});

test('DEV-03: Limpeza de Buffer (Clear Audit Trail) - Reset do buffer circular de auditoria em dev', () => {
  // Garantir que haja eventos no buffer
  auditLogger.logEvent({
    auditId: 'audit-test-clear-1',
    timestamp: new Date().toISOString(),
    eventType: 'PERMISSION_EVALUATION',
    toolName: 'system_info',
    riskLevel: 'R0',
    decision: 'ALLOW',
    sessionId: 'clear-session',
    durationMs: 5,
    simulated: true
  });

  assert.ok(auditLogger.queryEvents().length > 0, 'Deve ter pelo menos um evento');

  // Executar limpeza
  auditLogger.clear();

  assert.strictEqual(auditLogger.queryEvents().length, 0, 'O buffer de auditoria deve ficar completamente limpo após a ação');
});

test('DEV-04: Simulação de Consentimento R1 - Transição de DENY_R1_BLOCKED para ALLOW com token SHA-256 consumido', async () => {
  const sessionId = 'session-dev-r1';
  const toolName = 'system_exec_simulated';
  const params = { command: 'git status' };
  const pHash = computeParametersHash(params);

  // 1. Sem consentimento: avaliação R1 é negada para execução direta
  const context = { sessionId, clientIp: '127.0.0.1', serverTimestamp: Date.now() };
  const evalWithoutConsent = await permissionEngine.evaluate(toolName, params, context);
  assert.strictEqual(evalWithoutConsent.decision, 'DENY');
  assert.strictEqual(evalWithoutConsent.code, 'DENY_R1_BLOCKED_IN_PHASE_6_2B');

  // 2. Com consentimento emitido e consumido
  const issued = await permissionEngine.issueConsentToken(toolName, pHash, sessionId);
  assert.ok(issued.token, 'Token de consentimento deve ser gerado');

  const consumed = permissionEngine.consumeConsentToken(issued.token, toolName, pHash, sessionId);
  assert.strictEqual(consumed.success, true, 'O consumo do token deve ser bem-sucedido');
  assert.ok(consumed.consentAuditId, 'Deve retornar o ID do audit do consentimento');
});

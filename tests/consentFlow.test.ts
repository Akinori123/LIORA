/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import { useLioraStore, PendingConsentState } from '../src/store/lioraStore';
import { permissionEngine } from '../src/security/permissionEngine';
import { auditLogger } from '../src/security/auditLogger';
import { computeParametersHash } from '../src/security/canonicalizer';

test('CNS-01: Captura do estado REQUIRES_CONSENT e validação de metadados no ConsentCard', () => {
  const store = useLioraStore.getState();
  const now = Date.now();
  const sampleParams = { filePath: 'workspace/output.txt', content: 'hello world' };
  const sampleHash = computeParametersHash(sampleParams);

  const pending: PendingConsentState = {
    auditId: `audit-test-cns-01`,
    ruleId: 'rule-test-cns-01',
    toolName: 'workspace_write_file',
    riskLevel: 'R1',
    parameters: sampleParams,
    parametersHash: sampleHash,
    consentToken: 'raw-token-cns-01',
    sessionId: 'session-cns-01',
    expiresAt: now + 60000,
    reason: 'Operação de modificação de arquivo R1 requer consentimento explícito.',
    status: 'PENDING'
  };

  store.setPendingConsent(pending);

  const current = useLioraStore.getState().pendingConsent;
  assert.ok(current, 'O estado de pendingConsent deve estar ativo');
  assert.strictEqual(current.toolName, 'workspace_write_file');
  assert.strictEqual(current.riskLevel, 'R1');
  assert.strictEqual(current.status, 'PENDING');
  assert.strictEqual(current.sessionId, 'session-cns-01');
  assert.deepStrictEqual(current.parameters, sampleParams);
  assert.ok(current.expiresAt > Date.now(), 'O TTL deve expirar no futuro (60s)');
});

test('CNS-02: Consumo do token efêmero com aprovação e bloqueio de replay', async () => {
  const params = { command: 'npm test', timeoutMs: 5000 };
  const paramsHash = computeParametersHash(params);
  const sessionId = 'session-cns-02';

  // 1. Emissão de token legítimo pelo PermissionEngine
  const issued = await permissionEngine.issueConsentToken('system_exec_sandbox', paramsHash, sessionId);
  assert.ok(issued.token, 'Token deve ser gerado');
  assert.ok(issued.expiresAt > Date.now(), 'Token deve ter validade futura');

  // 2. Consumo atômico pela primeira vez
  const consumeRes1 = permissionEngine.consumeConsentToken(issued.token, 'system_exec_sandbox', paramsHash, sessionId);
  assert.strictEqual(consumeRes1.success, true, 'O primeiro consumo deve ser bem-sucedido');

  // 3. Tentativa de reuso (Replay Attack) deve falhar
  const consumeRes2 = permissionEngine.consumeConsentToken(issued.token, 'system_exec_sandbox', paramsHash, sessionId);
  assert.strictEqual(consumeRes2.success, false, 'Replay de token consumido deve falhar');
  assert.strictEqual(consumeRes2.denialCode, 'CONSENT_TOKEN_ALREADY_USED');

  // 4. Teste de aprovação no store
  const store = useLioraStore.getState();
  store.setPendingConsent({
    auditId: 'audit-approve-test',
    ruleId: 'rule-approve-test',
    toolName: 'system_info',
    riskLevel: 'R1',
    parameters: { detailLevel: 'standard' },
    parametersHash: computeParametersHash({ detailLevel: 'standard' }),
    consentToken: 'token-approve',
    sessionId: 'session-store-approve',
    expiresAt: Date.now() + 60000,
    status: 'PENDING'
  });

  await store.approveConsent();
  const updated = useLioraStore.getState().pendingConsent;
  assert.ok(updated);
  assert.strictEqual(updated.status, 'APPROVED', 'O status do consentimento deve ser transicionado para APPROVED');

  // Verificar se gerou log de sucesso
  const logs = useLioraStore.getState().activityLogs;
  assert.ok(logs.some(l => l.summary.includes('Consentimento Aprovado: system_info')));
});

test('CNS-03: Rejeição manual pelo usuário com alteração de status e registro de atividade', () => {
  const store = useLioraStore.getState();
  store.setPendingConsent({
    auditId: 'audit-reject-test',
    ruleId: 'rule-reject-test',
    toolName: 'workspace_write_file',
    riskLevel: 'R1',
    parameters: { filePath: 'workspace/dangerous.sh', content: 'rm -rf' },
    consentToken: 'token-reject',
    sessionId: 'session-store-reject',
    expiresAt: Date.now() + 60000,
    status: 'PENDING'
  });

  store.rejectConsent();

  const current = useLioraStore.getState().pendingConsent;
  assert.ok(current);
  assert.strictEqual(current.status, 'REJECTED', 'O status deve ser atualizado para REJECTED');

  const logs = useLioraStore.getState().activityLogs;
  const rejectLog = logs.find(l => l.summary.includes('Consentimento Rejeitado: workspace_write_file'));
  assert.ok(rejectLog, 'Deve registrar atividade de rejeição');
  assert.strictEqual(rejectLog.status, 'warning');
});

test('CNS-04: Expiração de TTL (60s) resultando em negação automática DENY_CONSENT_EXPIRED', async () => {
  const params = { filePath: 'workspace/test.txt' };
  const paramsHash = computeParametersHash(params);
  const sessionId = 'session-cns-04';

  // 1. Emissão de token
  const issued = await permissionEngine.issueConsentToken('workspace_write_file', paramsHash, sessionId);

  // Simular expiração manipulando timestamp no registro de consentimento interno
  const crypto = await import('crypto');
  const tokenHash = crypto.createHash('sha256').update(issued.token, 'utf8').digest('hex');
  const record = (permissionEngine as any).consentRecords.get(tokenHash);
  assert.ok(record);
  record.expiresAt = Date.now() - 1000; // 1 segundo no passado

  // 2. Consumo deve ser rejeitado com CONSENT_TOKEN_EXPIRED
  const expiredConsume = permissionEngine.consumeConsentToken(issued.token, 'workspace_write_file', paramsHash, sessionId);
  assert.strictEqual(expiredConsume.success, false);
  assert.strictEqual(expiredConsume.denialCode, 'CONSENT_TOKEN_EXPIRED');

  // 3. Teste no Store: expiração automática
  const store = useLioraStore.getState();
  store.setPendingConsent({
    auditId: 'audit-expired-test',
    ruleId: 'rule-expired-test',
    toolName: 'workspace_write_file',
    riskLevel: 'R1',
    parameters: params,
    consentToken: 'expired-token',
    sessionId: 'session-store-expired',
    expiresAt: Date.now() - 5000, // já expirado
    status: 'PENDING'
  });

  // Chamar approveConsent com token expirado deve acionar expireConsent()
  const approveRes = await store.approveConsent();
  assert.strictEqual(approveRes, null, 'Aprovação de token expirado deve retornar null');

  const current = useLioraStore.getState().pendingConsent;
  assert.ok(current);
  assert.strictEqual(current.status, 'EXPIRED');

  const logs = useLioraStore.getState().activityLogs;
  const expireLog = logs.find(l => l.summary.includes('DENY_CONSENT_EXPIRED'));
  assert.ok(expireLog, 'Deve registrar atividade de consentimento expirado');
  assert.strictEqual(expireLog.status, 'error');
});

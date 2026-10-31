/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import { auditLogger } from '../src/security/auditLogger';
import { permissionEngine } from '../src/security/permissionEngine';
import { computeParametersHash } from '../src/security/canonicalizer';

test('DEV-AUDIT-01: Consulta correta de eventos de auditoria com filtros por decisão (ALLOW / DENY)', async () => {
  auditLogger.clear();

  // Registra eventos simulados de ALLOW e DENY
  const sampleParams = { testKey: 'value-1' };
  const paramHash = computeParametersHash(sampleParams);

  await permissionEngine.evaluate('system_info', sampleParams, {
    sessionId: 'session-audit-01',
    serverTimestamp: Date.now(),
    clientIp: '127.0.0.1'
  });

  await permissionEngine.evaluate('workspace_read_file', { filePath: 'docs/ROADMAP.md' }, {
    sessionId: 'session-audit-01',
    serverTimestamp: Date.now(),
    clientIp: '127.0.0.1'
  });

  const allEvents = auditLogger.queryEvents({ limit: 10 });
  assert.ok(allEvents.length >= 2, 'Deve haver pelo menos 2 eventos no AuditLogger');

  const allowEvents = auditLogger.queryEvents({ decision: 'ALLOW' });
  assert.ok(allowEvents.length >= 1);
  assert.strictEqual(allowEvents[0].decision, 'ALLOW');
  assert.strictEqual(allowEvents[0].toolName, 'system_info');

  const denyEvents = auditLogger.queryEvents({ decision: 'DENY' });
  assert.ok(denyEvents.length >= 1);
  assert.strictEqual(denyEvents[0].decision, 'DENY');
  assert.strictEqual(denyEvents[0].toolName, 'workspace_read_file');
});

test('DEV-AUDIT-02: Validação da presença de parâmetros canônicos SHA-256 (parametersHash) nos logs', async () => {
  const params = { foo: 'bar', num: 42 };
  const expectedHash = computeParametersHash(params);

  const evalRes = await permissionEngine.evaluate('system_info', params, {
    sessionId: 'session-audit-02',
    serverTimestamp: Date.now(),
    clientIp: '127.0.0.1'
  });

  assert.strictEqual(evalRes.parametersHash, expectedHash, 'O hash retornado deve coincidir com o cálculo canônico');

  const recentEvents = auditLogger.queryEvents({ limit: 5, toolName: 'system_info' });
  const matched = recentEvents.find(e => e.auditId === evalRes.auditId);

  assert.ok(matched, 'O evento correspondente deve ser encontrado no AuditLogger');
  assert.strictEqual(matched.parametersHash, expectedHash, 'O evento logado deve preservar o parametersHash canônico');
});

test('DEV-AUDIT-03: Simulação de execução de ferramenta via sandbox console com retorno estruturado', async () => {
  const sandboxParams = { detailLevel: 'full' };
  const context = {
    sessionId: 'sandbox-session-03',
    serverTimestamp: Date.now(),
    clientIp: '127.0.0.1'
  };

  const evaluation = await permissionEngine.evaluate('system_info', sandboxParams, context);
  assert.strictEqual(evaluation.decision, 'ALLOW');
  assert.ok(evaluation.auditId);
  assert.ok(evaluation.evaluationTimeMs >= 0);
  assert.strictEqual(evaluation.riskLevel, 'R0');
});

test('DEV-AUDIT-04: Verificação de isolamento de segredos (Redaction) nos relatórios de auditoria', async () => {
  const sensitiveParams = {
    apiKey: 'AIzaSyDb0987654321Fedcba0987654321ZyxW',
    secret: 'my-super-secret-password'
  };

  const evalRes = await permissionEngine.evaluate('system_info', sensitiveParams, {
    sessionId: 'session-redact-04',
    serverTimestamp: Date.now(),
    clientIp: '127.0.0.1'
  });

  const event = auditLogger.queryEvents({ limit: 1 }).find(e => e.auditId === evalRes.auditId);
  assert.ok(event, 'O evento deve estar registrado');

  // O AuditLogger armazena apenas o parametersHash (SHA-256), jamais os parâmetros crus
  const eventJson = JSON.stringify(event);
  assert.ok(!eventJson.includes('AIzaSyDb0987654321Fedcba0987654321ZyxW'), 'A chave de API jamais pode estar presente no log de auditoria');
  assert.ok(!eventJson.includes('my-super-secret-password'), 'A senha jamais pode estar presente no log de auditoria');
  assert.ok(event.parametersHash, 'O parametersHash SHA-256 deve estar presente');
});

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import { toolRegistry } from '../src/tools/registry';
import { permissionEngine } from '../src/security/permissionEngine';
import { auditLogger } from '../src/security/auditLogger';
import { IAuditLogger } from '../src/security/types';

// Helper para iniciar servidor Express de teste idêntico ao server.ts
function createTestApp() {
  const app = express();
  app.use(express.json());

  const executionRateLimits = new Map<string, { count: number; resetAt: number }>();
  const RATE_LIMIT_WINDOW_MS = 60 * 1000;
  const MAX_REQUESTS_PER_WINDOW = 60;

  app.get('/api/tools', (req, res) => {
    const tools = toolRegistry.listTools();
    res.json({
      tools,
      count: tools.length,
      simulated: true,
      timestamp: new Date().toISOString()
    });
  });

  app.post('/api/tools/execute', async (req, res) => {
    try {
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const clientLimit = executionRateLimits.get(clientIp);

      if (!clientLimit || now > clientLimit.resetAt) {
        executionRateLimits.set(clientIp, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      } else {
        clientLimit.count++;
        if (clientLimit.count > MAX_REQUESTS_PER_WINDOW) {
          return res.status(429).json({
            success: false,
            error: 'Limite de requisições excedido para o endpoint de ferramentas. Aguarde um momento.',
            code: 'RATE_LIMIT_EXCEEDED',
            simulated: true
          });
        }
      }

      const { toolName, parameters = {} } = req.body || {};

      if (!toolName || typeof toolName !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Parâmetro obrigatório "toolName" ausente ou inválido.',
          code: 'INVALID_INPUT',
          simulated: true
        });
      }

      if (!toolRegistry.hasTool(toolName)) {
        return res.status(404).json({
          success: false,
          error: `Ferramenta '${toolName}' não encontrada no Tool Registry.`,
          code: 'TOOL_NOT_FOUND',
          simulated: true
        });
      }

      const clientSessionId = (req.headers['x-liora-session-id'] as string) || `server-session-test`;

      const context = {
        sessionId: clientSessionId,
        clientIp,
        serverTimestamp: Date.now()
      };

      const evaluation = await permissionEngine.evaluate(toolName, parameters, context);

      if (evaluation.decision === 'ALLOW') {
        return res.status(200).json({
          success: true,
          toolName,
          decision: 'ALLOW',
          riskLevel: evaluation.riskLevel,
          simulated: true,
          parametersHash: evaluation.parametersHash,
          timestamp: evaluation.timestamp,
          auditId: evaluation.auditId,
          message: 'Operação avaliada e autorizada analiticamente pelo Permission Engine (Perfil STRICT).'
        });
      } else {
        const httpStatus = evaluation.code === 'SESSION_INVALID_OR_MISSING' ? 401 : 403;
        return res.status(httpStatus).json({
          success: false,
          toolName,
          decision: 'DENY',
          riskLevel: evaluation.riskLevel,
          code: evaluation.code || 'SECURITY_CONSTRAINT_VIOLATION',
          error: evaluation.reason,
          simulated: true,
          timestamp: evaluation.timestamp,
          auditId: evaluation.auditId
        });
      }

    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: 'Erro interno do servidor ao processar requisição de ferramentas.',
        code: 'INTERNAL_ERROR',
        simulated: true
      });
    }
  });

  return app;
}

test('SRV-01: HTTP Integration - POST /api/tools/execute allows system_info under STRICT profile', async () => {
  const app = createTestApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  try {
    const res = await fetch(`http://localhost:${port}/api/tools/execute`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-liora-session-id': 'session-test-integration-1'
      },
      body: JSON.stringify({
        toolName: 'system_info',
        parameters: { detailLevel: 'standard' }
      })
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json() as any;
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.decision, 'ALLOW');
    assert.strictEqual(data.toolName, 'system_info');
    assert.strictEqual(data.riskLevel, 'R0');
    assert.ok(data.parametersHash);
    assert.ok(data.auditId);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('SRV-02: HTTP Integration - POST /api/tools/execute denies workspace_read_file with 403 and TOOL_EXPLICITLY_DENIED', async () => {
  const app = createTestApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  try {
    const res = await fetch(`http://localhost:${port}/api/tools/execute`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-liora-session-id': 'session-test-integration-2'
      },
      body: JSON.stringify({
        toolName: 'workspace_read_file',
        parameters: { filePath: 'docs/ROADMAP.md' }
      })
    });

    assert.strictEqual(res.status, 403);
    const data = await res.json() as any;
    assert.strictEqual(data.success, false);
    assert.strictEqual(data.decision, 'DENY');
    assert.strictEqual(data.toolName, 'workspace_read_file');
    assert.ok(data.code === 'TOOL_EXPLICITLY_DENIED' || data.code === 'TOOL_NOT_IN_PROFILE_WHITELIST');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('SRV-03: HTTP Integration - POST /api/tools/execute denies R1 tool (system_exec_simulated) in current phase', async () => {
  const app = createTestApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  try {
    const res = await fetch(`http://localhost:${port}/api/tools/execute`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-liora-session-id': 'session-test-integration-3'
      },
      body: JSON.stringify({
        toolName: 'system_exec_simulated',
        parameters: { command: 'git status' }
      })
    });

    assert.strictEqual(res.status, 403);
    const data = await res.json() as any;
    assert.strictEqual(data.success, false);
    assert.strictEqual(data.decision, 'DENY');
    assert.strictEqual(data.code, 'DENY_R1_BLOCKED_IN_PHASE_6_2B');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('SRV-04: HTTP Integration - POST /api/tools/execute rejects invalid input / missing toolName with 400', async () => {
  const app = createTestApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  try {
    const res = await fetch(`http://localhost:${port}/api/tools/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parameters: {} })
    });

    assert.strictEqual(res.status, 400);
    const data = await res.json() as any;
    assert.strictEqual(data.success, false);
    assert.strictEqual(data.code, 'INVALID_INPUT');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('SRV-05: HTTP Integration - Fail-Closed behavior under AuditLogger failure converts ALLOW to DENY', async () => {
  // Criar motor com logger falho
  const faultyLogger: IAuditLogger = {
    maxCapacity: 200,
    count: 0,
    logEvent: () => { throw new Error('Database down'); },
    queryEvents: () => [],
    clear: () => {}
  };

  const isolatedEngine = new (permissionEngine.constructor as any)(permissionEngine.activeProfile, faultyLogger);

  const app = express();
  app.use(express.json());
  app.post('/api/tools/execute', async (req, res) => {
    const evaluation = await isolatedEngine.evaluate('system_info', { detailLevel: 'standard' }, { sessionId: 'fail-session', serverTimestamp: Date.now() });
    if (evaluation.decision === 'ALLOW') {
      res.json({ success: true });
    } else {
      res.status(403).json({ success: false, code: evaluation.code });
    }
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  try {
    const res = await fetch(`http://localhost:${port}/api/tools/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolName: 'system_info' })
    });

    assert.strictEqual(res.status, 403);
    const data = await res.json() as any;
    assert.strictEqual(data.success, false);
    assert.strictEqual(data.code, 'SECURITY_CONSTRAINT_VIOLATION');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

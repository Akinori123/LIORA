/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import { isTauriEnvironment, executeLocalTool } from '../src/security/localBridge';
import { toolRegistry } from '../src/tools/registry';
import { permissionEngine } from '../src/security/permissionEngine';

// Helper para iniciar servidor Express de teste para simular o backend
function createTestApp() {
  const app = express();
  app.use(express.json());

  app.post('/api/tools/execute', async (req, res) => {
    const { toolName, parameters = {} } = req.body || {};
    if (!toolName) {
      return res.status(400).json({ success: false, code: 'INVALID_INPUT', error: 'Missing toolName' });
    }

    if (toolName === 'system_info') {
      return res.status(200).json({
        success: true,
        toolName,
        decision: 'ALLOW',
        riskLevel: 'R0',
        simulated: true,
        parametersHash: 'sha256-mock-hash-123',
        auditId: 'audit-test-1',
        timestamp: new Date().toISOString()
      });
    }

    if (toolName === 'workspace_read_file') {
      return res.status(403).json({
        success: false,
        toolName,
        decision: 'DENY',
        riskLevel: 'R0',
        code: 'TOOL_EXPLICITLY_DENIED',
        error: 'Ferramenta explicitamente negada no perfil STRICT.',
        simulated: true,
        timestamp: new Date().toISOString()
      });
    }

    return res.status(404).json({ success: false, code: 'TOOL_NOT_FOUND' });
  });

  return app;
}

test('BRG-01: LocalBridge - Environment detection (Web vs Desktop)', () => {
  // No ambiente Node/Test sem global.__TAURI__, isTauriEnvironment deve retornar false
  const originalWindow = (global as any).window;
  (global as any).window = {};
  
  assert.strictEqual(isTauriEnvironment(), false);

  // Simulando __TAURI__
  (global as any).window = { __TAURI__: { core: { invoke: async () => {} } } };
  assert.strictEqual(isTauriEnvironment(), true);

  // Restaurar window
  (global as any).window = originalWindow;
});

test('BRG-02: LocalBridge - Transparent fallback for system_info under Web environment', async () => {
  const app = createTestApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  // Mock global fetch para apontar para o servidor de teste
  const originalFetch = global.fetch;
  global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const targetUrl = url.startsWith('/') ? `http://localhost:${port}${url}` : url;
    return originalFetch(targetUrl, init);
  };

  const originalWindow = (global as any).window;
  (global as any).window = {}; // Web environment

  try {
    const result = await executeLocalTool('system_info', { detailLevel: 'standard' }, 'session-brg-1');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.toolName, 'system_info');
    assert.strictEqual(result.decision, 'ALLOW');
    assert.strictEqual(result.riskLevel, 'R0');
    assert.strictEqual(result.parametersHash, 'sha256-mock-hash-123');
    assert.strictEqual(result.simulated, true);
  } finally {
    global.fetch = originalFetch;
    (global as any).window = originalWindow;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('BRG-03: LocalBridge - Structured error mapping for 403 response', async () => {
  const app = createTestApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  const originalFetch = global.fetch;
  global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const targetUrl = url.startsWith('/') ? `http://localhost:${port}${url}` : url;
    return originalFetch(targetUrl, init);
  };

  const originalWindow = (global as any).window;
  (global as any).window = {};

  try {
    const result = await executeLocalTool('workspace_read_file', { filePath: 'test.md' }, 'session-brg-2');
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.decision, 'DENY');
    assert.strictEqual(result.code, 'TOOL_EXPLICITLY_DENIED');
    assert.ok(result.error);
  } finally {
    global.fetch = originalFetch;
    (global as any).window = originalWindow;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('BRG-04: LocalBridge - Invalid input handling without network call', async () => {
  const result = await executeLocalTool('', {}, 'session-brg-3');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.code, 'INVALID_INPUT');
  assert.strictEqual(result.decision, 'DENY');
});

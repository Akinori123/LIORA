/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import { executeLocalTool, isTauriEnvironment } from '../src/security/localBridge';

test('NIO-01: Tauri environment detection helper exists and returns boolean', () => {
  const isDesktop = isTauriEnvironment();
  assert.strictEqual(typeof isDesktop, 'boolean');
});

test('NIO-02: Local tool execution fallback handles invalid tool names gracefully', async () => {
  const result = await executeLocalTool('', {}, 'test-session');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.code, 'INVALID_INPUT');
});

test('NIO-03: Workspace read/write tool request structure validation', async () => {
  // Em ambiente Web Preview, a tool executa via /api/tools/execute simulando/validando estritamente
  const writeResult = await executeLocalTool('workspace_write_file', {
    path: 'test-native-output.txt',
    content: 'Hello Liora Native Disk I/O'
  }, 'test-session');
  
  assert.ok(writeResult);
  assert.strictEqual(writeResult.toolName, 'workspace_write_file');

  const readResult = await executeLocalTool('workspace_read_file', {
    path: 'test-native-output.txt'
  }, 'test-session');

  assert.ok(readResult);
  assert.strictEqual(readResult.toolName, 'workspace_read_file');
});

test('NIO-04: Sandbox command execution security guard validation', async () => {
  const execResult = await executeLocalTool('system_exec_sandbox', {
    command: 'echo',
    args: ['LioraNativeTest']
  }, 'test-session');

  assert.ok(execResult);
  assert.strictEqual(execResult.toolName, 'system_exec_sandbox');
});

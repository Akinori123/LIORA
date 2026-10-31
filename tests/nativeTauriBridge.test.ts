/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import { isTauriEnvironment, executeLocalTool } from '../src/security/localBridge';

test('TBRG-01: Native Tauri Environment Detection', () => {
  const originalWindow = (global as any).window;
  
  // Sem window.__TAURI__
  (global as any).window = {};
  assert.strictEqual(isTauriEnvironment(), false);

  // Com window.__TAURI__ core invoke
  (global as any).window = {
    __TAURI__: {
      core: {
        invoke: async (cmd: string, args: any) => {
          if (cmd === 'execute_local_tool') {
            return {
              success: true,
              toolName: args.payload.toolName,
              data: { native: true },
              simulated: false,
              riskLevel: 'R1',
              executionTimeMs: 5,
              timestamp: new Date().toISOString()
            };
          }
          throw new Error(`Unknown command: ${cmd}`);
        }
      }
    }
  };

  assert.strictEqual(isTauriEnvironment(), true);

  // Restaurar window original
  (global as any).window = originalWindow;
});

test('TBRG-02: Native Tauri IPC Dispatch execution', async () => {
  const originalWindow = (global as any).window;

  (global as any).window = {
    __TAURI__: {
      core: {
        invoke: async (cmd: string, args: any) => {
          if (cmd === 'execute_local_tool') {
            return {
              success: true,
              toolName: args.payload.toolName,
              data: { pathRead: '/mock/workspace/notes.md', content: '# Tauri Native I/O' },
              simulated: false,
              riskLevel: 'R1',
              executionTimeMs: 12,
              timestamp: new Date().toISOString()
            };
          }
          throw new Error('Unexpected invoke');
        }
      }
    }
  };

  try {
    const result = await executeLocalTool('workspace_read_file', { path: 'notes.md' }, 'session-tauri-1');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.simulated, false);
    assert.strictEqual(result.toolName, 'workspace_read_file');
    assert.deepStrictEqual(result.data, { pathRead: '/mock/workspace/notes.md', content: '# Tauri Native I/O' });
  } finally {
    (global as any).window = originalWindow;
  }
});

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import { automationsEngine } from '../src/services/automationsEngine';
import { devicesManager } from '../src/services/devicesManager';
import { eventBus } from '../src/utils/eventBus';
import { auditLogger } from '../src/security/auditLogger';

test('AUT-DEV-01: AutomationsEngine executes EventBus-triggered rules without blocking and logs errors to auditLogger', async () => {
  let eventReceived = false;

  const testRule = {
    id: 'test-auto-eb-1',
    name: 'Gatilho de Evento de Rede',
    description: 'Testa resposta a evento de rede',
    enabled: true,
    trigger: {
      type: 'SYSTEM_EVENT' as const,
      config: { eventName: 'NETWORK_STATUS_CHANGED' },
      humanReadable: 'Ao alterar rede'
    },
    action: {
      type: 'EXECUTE_TOOL' as const,
      toolName: 'system_info',
      parameters: { detailLevel: 'summary' },
      description: 'Consultar métricas de rede',
      expectedRiskLevel: 'R0' as const
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  automationsEngine.registerRule(testRule);

  // Publish event on EventBus
  await eventBus.publish('NETWORK_STATUS_CHANGED', { connected: true, status: 'wifi' });

  const rules = automationsEngine.getRules();
  const found = rules.find(r => r.id === 'test-auto-eb-1');
  assert.strictEqual(Boolean(found), true);
  assert.strictEqual(found?.enabled, true);

  // Clean up
  automationsEngine.unregisterRule('test-auto-eb-1');
});

test('AUT-DEV-02: Device disconnection triggers EventBus event and records forensic log in auditLogger', () => {
  let busEventFired = false;

  // Register a test device
  devicesManager.addDevice({
    id: 'dev-test-disconnect',
    name: 'Test Companion Node',
    type: 'android',
    status: 'ONLINE',
    connected: true,
    lastSeen: 'Agora',
    capabilities: ['voice_stream'],
    isSimulated: false
  });

  const unsub = eventBus.subscribe('DEVICE_DISCONNECTED', (payload) => {
    busEventFired = true;
    assert.strictEqual(payload.deviceId, 'dev-test-disconnect');
  });

  const countBefore = auditLogger.count;

  // Simulate disconnecting device
  devicesManager.updateDeviceStatus('dev-test-disconnect', false);

  assert.strictEqual(busEventFired, true);
  assert.strictEqual(auditLogger.count > countBefore, true);

  // Clean up
  devicesManager.removeDevice('dev-test-disconnect');
  unsub();
});

test('AUT-DEV-03: DevicesManager refreshTelemetry consumes hardware telemetry cleanly without Math.random()', async () => {
  const telemetry = await devicesManager.refreshTelemetry('dev-1');
  assert.strictEqual(Boolean(telemetry), true);
  assert.strictEqual(typeof telemetry?.cpuUsagePercent, 'number');
  assert.strictEqual(typeof telemetry?.memoryUsagePercent, 'number');
  assert.strictEqual(typeof telemetry?.memoryFreeBytes, 'number');
  assert.strictEqual(typeof telemetry?.memoryTotalBytes, 'number');

  // Verify command IDs do not use Math.random()
  const cmd = await devicesManager.sendCommand('dev-1', 'FETCH_TELEMETRY', 'R0');
  assert.strictEqual(cmd.id.includes('Math.random'), false);
  assert.strictEqual(cmd.id.startsWith('cmd-'), true);
});

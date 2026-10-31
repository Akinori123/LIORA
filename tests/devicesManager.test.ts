/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { DevicesManager, COMMANDS_STORAGE_KEY } from '../src/services/devicesManager';
import { permissionEngine } from '../src/security/permissionEngine';
import { useLioraStore } from '../src/store/lioraStore';

// Mock localStorage for node environment if needed
if (typeof globalThis.localStorage === 'undefined') {
  const store: Record<string, string> = {};
  globalThis.localStorage = {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); },
    length: 0,
    key: (index: number) => Object.keys(store)[index] || null
  };
}

describe('Aba Dispositivos, Hardware & PULO (DevicesManager Suite)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('DEV-01: Inicialização e atualização correta de telemetria de hardware', async () => {
    const manager = new DevicesManager(permissionEngine);
    const devices = manager.getDevices();

    assert.ok(devices.length >= 4, 'Deve haver ao menos 4 dispositivos padrão registrados');
    const host = manager.getDevice('dev-1');
    assert.ok(host);
    assert.strictEqual(host.type, 'pc');
    assert.strictEqual(host.connected, true);
    assert.ok(host.telemetry);

    // Atualização de telemetria via ferramenta system_info (R0)
    const telemetry = await manager.refreshTelemetry('dev-1');
    assert.ok(telemetry, 'A telemetria deve retornar dados válidos');
    assert.ok(telemetry.cpuUsagePercent >= 0);
    assert.ok(telemetry.memoryUsagePercent >= 0);
    assert.ok(telemetry.uptimeSeconds > 0);
  });

  test('DEV-02: Execução autônoma de comandos R0 (leitura/status) e persistência no LocalStorage', async () => {
    const manager = new DevicesManager(permissionEngine);

    const cmdR0 = await manager.sendCommand('dev-1', 'FETCH_TELEMETRY', 'R0', { mode: 'fast' });
    assert.strictEqual(cmdR0.status, 'EXECUTED', 'Comando R0 deve executar com sucesso de forma autônoma');
    assert.strictEqual(cmdR0.riskLevel, 'R0');
    assert.strictEqual(cmdR0.commandType, 'FETCH_TELEMETRY');
    assert.ok(cmdR0.resultSummary?.includes('sucesso'));

    const storedRaw = localStorage.getItem(COMMANDS_STORAGE_KEY);
    assert.ok(storedRaw, 'Deveria persistir o histórico de comandos de hardware no LocalStorage');
    const parsed = JSON.parse(storedRaw!);
    assert.strictEqual(parsed[0].commandType, 'FETCH_TELEMETRY');
  });

  test('DEV-03: Exigência de consentimento para comandos de risco R1+', async () => {
    const manager = new DevicesManager(permissionEngine);

    const cmdR1 = await manager.sendCommand('dev-3', 'REBOOT', 'R1', { force: true });
    assert.ok(cmdR1.status === 'BLOCKED_BY_POLICY' || cmdR1.status === 'WAITING_CONSENT', 'Comando R1 deve exigir consentimento ou ser retido por política');
    assert.strictEqual(cmdR1.riskLevel, 'R1');
  });

  test('DEV-04: Health-Check PULO (pingDevicesHealth) atualiza estado dos nós remotos', () => {
    const manager = new DevicesManager(permissionEngine);
    const health = manager.pingDevicesHealth();

    assert.strictEqual(typeof health, 'object');
    assert.strictEqual(health['dev-1'], true, 'Host dev-1 deve responder online');
  });

  test('DEV-05: Integração no store Zustand e auditoria cruzada', async () => {
    const store = useLioraStore.getState();
    store.loadDevices();

    const initialCount = store.deviceCommands.length;
    const initialLogsCount = store.activityLogs.length;

    const cmdRes = await store.sendDeviceCommand('dev-2', 'SYNC_CONTEXT', 'R0', { target: 'mobile' });
    assert.strictEqual(cmdRes.status, 'EXECUTED');

    const updatedStore = useLioraStore.getState();
    assert.strictEqual(updatedStore.deviceCommands.length, initialCount + 1);
    assert.ok(updatedStore.activityLogs.length > initialLogsCount, 'Deve gerar log de auditoria cruzada na aba /activity');
  });
});

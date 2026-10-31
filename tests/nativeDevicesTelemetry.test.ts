/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import { DevicesManager } from '../src/services/devicesManager';
import { HardwareTelemetryResult, DeviceTelemetry } from '../src/types/devices';
import { useLioraStore } from '../src/store/lioraStore';

test('NDT-01: Contrato de dados e tipagem de HardwareTelemetryResult (sysinfo)', () => {
  const sampleSysinfoTelemetry: HardwareTelemetryResult = {
    cpu_usage_percent: 18.5,
    cpu_cores: 16,
    memory_usage_percent: 42.0,
    memory_free_bytes: 9 * 1024 * 1024 * 1024,
    memory_total_bytes: 16 * 1024 * 1024 * 1024,
    disk_usage_percent: 55.4,
    disk_total_bytes: 512 * 1024 * 1024 * 1024,
    disk_free_bytes: 228 * 1024 * 1024 * 1024,
    battery_level: 95.0,
    is_charging: true,
    temperature_celsius: 42.5,
    uptime_seconds: 43200,
    hostname: 'liora-workstation',
    os_name: 'Linux',
    os_version: 'Ubuntu 24.04 LTS',
    timestamp: new Date().toISOString(),
    is_real_hardware: true,
  };

  assert.strictEqual(typeof sampleSysinfoTelemetry.cpu_usage_percent, 'number');
  assert.ok(sampleSysinfoTelemetry.cpu_usage_percent >= 0 && sampleSysinfoTelemetry.cpu_usage_percent <= 100);
  assert.strictEqual(typeof sampleSysinfoTelemetry.cpu_cores, 'number');
  assert.ok(sampleSysinfoTelemetry.cpu_cores > 0);
  assert.strictEqual(typeof sampleSysinfoTelemetry.memory_usage_percent, 'number');
  assert.ok(sampleSysinfoTelemetry.memory_total_bytes > sampleSysinfoTelemetry.memory_free_bytes);
  assert.strictEqual(sampleSysinfoTelemetry.is_real_hardware, true);
});

test('NDT-02: Execução de refreshTelemetry em ambiente Web/Node (Fallback controlado)', async () => {
  // Garantir que window.__TAURI__ não existe
  if (typeof (globalThis as any).window !== 'undefined') {
    delete (globalThis as any).window.__TAURI__;
  }

  const manager = new DevicesManager();
  const hostBefore = manager.getDevice('dev-1');
  assert.ok(hostBefore);

  const telemetry = await manager.refreshTelemetry('dev-1');
  assert.ok(telemetry);
  assert.strictEqual(telemetry.isRealHardware, false, 'Em ambiente web fallback, isRealHardware deve ser false');

  const hostAfter = manager.getDevice('dev-1');
  assert.ok(hostAfter);
  assert.strictEqual(hostAfter.isSimulated, true, 'O dispositivo deve estar explicitamente marcado como simulado');
  assert.ok(telemetry.cpuUsagePercent >= 0);
  assert.ok(telemetry.memoryFreeBytes > 0);
});

test('NDT-03: Execução de refreshTelemetry com Tauri IPC (Dados reais de sysinfo)', async () => {
  // Configurar ambiente simulado com window.__TAURI__
  const mockTelemetry: HardwareTelemetryResult = {
    cpu_usage_percent: 24.2,
    cpu_cores: 8,
    memory_usage_percent: 61.5,
    memory_free_bytes: 6 * 1024 * 1024 * 1024,
    memory_total_bytes: 16 * 1024 * 1024 * 1024,
    disk_usage_percent: 48.0,
    disk_total_bytes: 1000 * 1024 * 1024 * 1024,
    disk_free_bytes: 520 * 1024 * 1024 * 1024,
    battery_level: 88.0,
    is_charging: true,
    temperature_celsius: 44.0,
    uptime_seconds: 72000,
    hostname: 'liora-prod-pc',
    os_name: 'Linux',
    os_version: '6.8.0-generic',
    timestamp: new Date().toISOString(),
    is_real_hardware: true,
  };

  (globalThis as any).window = (globalThis as any).window || {};
  (globalThis as any).window.__TAURI__ = {
    core: {
      invoke: async (cmd: string) => {
        if (cmd === 'get_system_hardware_telemetry') {
          return mockTelemetry;
        }
        throw new Error(`Comando desconhecido: ${cmd}`);
      }
    }
  };

  try {
    const manager = new DevicesManager();
    const telemetry = await manager.refreshTelemetry('dev-1');

    assert.ok(telemetry);
    assert.strictEqual(telemetry.cpuUsagePercent, 24.2);
    assert.strictEqual(telemetry.memoryUsagePercent, 61.5);
    assert.strictEqual(telemetry.batteryLevel, 88);
    assert.strictEqual(telemetry.isCharging, true);
    assert.strictEqual(telemetry.uptimeSeconds, 72000);
    assert.strictEqual(telemetry.isRealHardware, true, 'Em Tauri nativo, isRealHardware deve ser true');

    const host = manager.getDevice('dev-1');
    assert.ok(host);
    assert.strictEqual(host.isSimulated, false, 'Em Tauri nativo com sysinfo, isSimulated deve ser false');
    assert.strictEqual(host.battery, 88);
    assert.ok(host.osInfo?.includes('Linux'));
    assert.ok(host.osInfo?.includes('8 cores'));
  } finally {
    delete (globalThis as any).window.__TAURI__;
  }
});

test('NDT-04: Resiliência contra falha no Tauri IPC com fallback seguro', async () => {
  // Configurar window.__TAURI__ com comando que falha
  (globalThis as any).window = (globalThis as any).window || {};
  (globalThis as any).window.__TAURI__ = {
    core: {
      invoke: async () => {
        throw new Error('Falha simulada no driver IPC do SO');
      }
    }
  };

  try {
    const manager = new DevicesManager();
    const telemetry = await manager.refreshTelemetry('dev-1');

    // Não deve lançar exceção e deve retornar a telemetria segura de fallback
    assert.ok(telemetry);
    assert.strictEqual(telemetry.isRealHardware, false);
    const host = manager.getDevice('dev-1');
    assert.ok(host);
    assert.strictEqual(host.isSimulated, true, 'Deve manter o status de simulado em caso de erro');
  } finally {
    delete (globalThis as any).window.__TAURI__;
  }
});

test('NDT-05: Integração de telemetria no Store Zustand', async () => {
  const store = useLioraStore.getState();
  store.loadDevices();

  const dev1Before = store.devices.find(d => d.id === 'dev-1');
  assert.ok(dev1Before);

  await store.refreshDeviceTelemetry('dev-1');

  const updatedStore = useLioraStore.getState();
  const dev1After = updatedStore.devices.find(d => d.id === 'dev-1');
  assert.ok(dev1After);
  assert.ok(dev1After.telemetry);
  assert.ok(typeof dev1After.telemetry.cpuUsagePercent === 'number');
  assert.ok(typeof dev1After.telemetry.memoryUsagePercent === 'number');
});

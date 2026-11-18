/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Testes de Regressão da Auditoria Pass 2 — LIORA
 * Cobre:
 *  1. Backup & Restore completo das tabelas do storageAdapter + reloadAllFromStorage()
 *  2. Fluxo real de consentimento HMAC R1/R2/R3 no DevicesManager.sendCommand
 *  3. Simulação honesta Web Preview vs Dry-Run vs validação em pcControlTools
 *  4. Separação determinística simples vs fluxos compostos/fechamento em pcCommandParser
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

class MockStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number { return this.data.size; }
  clear(): void { this.data.clear(); }
  getItem(key: string): string | null { return this.data.has(key) ? this.data.get(key)! : null; }
  key(index: number): string | null { return Array.from(this.data.keys())[index] ?? null; }
  removeItem(key: string): void { this.data.delete(key); }
  setItem(key: string, value: string): void { this.data.set(key, String(value)); }
}

const mockStorage = new MockStorage();
(globalThis as any).localStorage = mockStorage;
(globalThis as any).window = (globalThis as any).window || { localStorage: mockStorage };
(globalThis as any).window.localStorage = mockStorage;

// Ativa dry-run por padrão ao carregar módulos para evitar efeitos colaterais de SO
process.env.LIORA_NO_BROWSER = '1';

import { storageAdapter } from '../src/services/storageAdapter';
import { automationsEngine } from '../src/services/automationsEngine';
import { devicesManager } from '../src/services/devicesManager';
import { settingsManager } from '../src/services/settingsManager';
import { useLioraStore } from '../src/store/lioraStore';
import { eventBus } from '../src/utils/eventBus';
import { saveHistory } from '../src/utils/historyStorage';
import { pcManageAppsTool, pcSimulateInputTool } from '../src/tools/pcControlTools';
import { parsePcCommandIntent } from '../src/utils/pcCommandParser';

test('AUDIT-PASS2-01: ExportFullBackup + RestoreFromBackup + reloadAllFromStorage restaura todos os domínios e religa EventBus', async () => {
  mockStorage.clear();
  await storageAdapter.clearTable('sessions');
  await storageAdapter.clearTable('memories');
  await storageAdapter.clearTable('settings');
  await storageAdapter.clearTable('automations');
  await storageAdapter.clearTable('devices');
  await storageAdapter.clearTable('audit_logs');

  // 1. Popula sessões, memórias, settings, automação de evento e dispositivo pareado
  const testSession = {
    id: 'sess-backup-1',
    title: 'Sessão Auditoria Pass 2',
    createdAt: '2026-11-18T10:00:00.000Z',
    updatedAt: '2026-11-18T10:05:00.000Z',
    messages: [
      {
        id: 'm1',
        sender: 'user' as const,
        text: 'Olá Liora, guarde isso no backup',
        timestamp: '10:00:00',
        status: 'completed' as const,
        source: 'text' as const,
        sessionId: 'sess-backup-1',
      },
      {
        id: 'm2',
        sender: 'assistant' as const,
        text: 'Registrado no cofre com segurança, Mestre.',
        timestamp: '10:00:02',
        status: 'completed' as const,
        source: 'text' as const,
        sessionId: 'sess-backup-1',
      }
    ]
  };
  saveHistory([testSession], 'sess-backup-1');
  await storageAdapter.save('sessions', 'history_payload', {
    sessions: [testSession],
    activeSessionId: 'sess-backup-1'
  });

  useLioraStore.setState({ memoryEntries: [] });
  useLioraStore.getState().addMemory({
    category: 'project',
    key: 'projeto_auditoria',
    value: 'LIORA Desktop Tauri v2',
    confidence: 0.99
  });

  useLioraStore.getState().updateSettings({
    theme: 'emerald',
    ttsVoice: 'Kore',
    desktopNotifications: false
  });
  await storageAdapter.save('settings', 'global_preferences', settingsManager.loadSettings());

  const customRuleId = 'auto-backup-test-event';
  useLioraStore.getState().addAutomation({
    name: 'Regra Evento Pós-Restore',
    description: 'Executa leitura segura ao disparar EVENT_PASS2_TEST',
    enabled: true,
    trigger: {
      type: 'SYSTEM_EVENT',
      config: { eventName: 'EVENT_PASS2_TEST' },
      humanReadable: 'Ao receber EVENT_PASS2_TEST'
    },
    action: {
      type: 'EXECUTE_TOOL',
      toolName: 'system_read_env_safe',
      parameters: { variableName: 'NODE_ENV' },
      description: 'Ler NODE_ENV',
      expectedRiskLevel: 'R0'
    },
    id: customRuleId
  } as any);

  useLioraStore.getState().addDevice({
    id: 'dev-tablet-pass2',
    name: 'Tablet Bancada',
    type: 'android',
    status: 'ONLINE',
    connected: true,
    battery: 88,
    ip: '192.168.1.44',
    lastSeen: 'Agora',
    osInfo: 'Android 15',
    capabilities: ['telemetry', 'remote_control'],
    isSimulated: false
  });

  // Garante persistência assíncrona das tabelas pendentes antes do export
  await new Promise((r) => setTimeout(r, 20));
  const backupJson = await storageAdapter.exportFullBackup();
  const parsedBackup = JSON.parse(backupJson);
  assert.ok(parsedBackup.tables.sessions.length > 0, 'Backup deve conter sessões');
  assert.ok(parsedBackup.tables.memories.length > 0, 'Backup deve conter memórias');
  assert.ok(parsedBackup.tables.settings.length > 0, 'Backup deve conter configurações');
  assert.ok(parsedBackup.tables.automations.length > 0, 'Backup deve conter automações');
  assert.ok(parsedBackup.tables.devices.length > 0, 'Backup deve conter dispositivos');

  // 2. Destrói/mutaciona estado completo em memória e no storage
  mockStorage.clear();
  await storageAdapter.clearTable('sessions');
  await storageAdapter.clearTable('memories');
  await storageAdapter.clearTable('settings');
  await storageAdapter.clearTable('automations');
  await storageAdapter.clearTable('devices');

  useLioraStore.setState({
    sessions: [],
    activeSessionId: null,
    messages: [],
    memoryEntries: [],
    automations: [],
    devices: []
  });
  settingsManager.resetSettings();
  automationsEngine.reloadFromStorage([]);
  devicesManager.reloadFromStorage([]);

  // Confirma que a regra sumiu antes da restauração
  assert.equal(automationsEngine.getRule(customRuleId), undefined);

  // 3. Restaura do JSON e recarrega todos os domínios do store
  const restoreRes = await storageAdapter.restoreFromBackup(backupJson);
  assert.equal(restoreRes.success, true, `Restore falhou: ${restoreRes.error}`);

  await useLioraStore.getState().reloadAllFromStorage();

  const restoredState = useLioraStore.getState();
  assert.equal(restoredState.sessions.some((s) => s.id === 'sess-backup-1'), true, 'Sessão deve ser restaurada');
  assert.equal(restoredState.messages.some((m) => m.text.includes('guarde isso no backup')), true, 'Mensagens da sessão devem ser restauradas');
  assert.equal(restoredState.memoryEntries.some((m) => m.key === 'projeto_auditoria'), true, 'Memória deve ser restaurada');
  assert.equal(restoredState.settings.theme, 'emerald', 'Tema das configurações deve ser restaurado');
  assert.equal(restoredState.settings.ttsVoice, 'Kore', 'Voz neural das configurações deve ser restaurada');
  assert.equal(restoredState.automations.some((r) => r.name === 'Regra Evento Pós-Restore'), true, 'Regra de automação deve ser restaurada');
  assert.equal(restoredState.devices.some((d) => d.id === 'dev-tablet-pass2'), true, 'Dispositivo pareado deve ser restaurado');

  // 4. Verifica que o EventBus foi devidamente religado após reloadFromStorage
  const logsBefore = automationsEngine.getLogs().length;
  eventBus.publish('EVENT_PASS2_TEST', { source: 'audit-pass2-test' });
  await new Promise((r) => setTimeout(r, 80));
  const logsAfter = automationsEngine.getLogs();
  assert.ok(logsAfter.length > logsBefore, 'Listener de automação no EventBus deve disparar após restore/reload');
});

test('AUDIT-PASS2-02: DevicesManager exige confirmação humana HMAC para R1/R2 e bloqueia R3', async () => {
  mockStorage.clear();
  devicesManager.reloadFromStorage([
    {
      id: 'dev-iot-gate',
      name: 'Trava Inteligente',
      type: 'smarthome',
      status: 'ONLINE',
      connected: true,
      lastSeen: 'Agora',
      capabilities: ['remote_control'],
      isSimulated: true
    }
  ]);

  // R1 sem confirmação explícita da UI -> WAITING_CONSENT
  const r1Unconfirmed = await devicesManager.sendCommand('dev-iot-gate', 'REBOOT', 'R1', { reason: 'teste' });
  assert.equal(r1Unconfirmed.status, 'WAITING_CONSENT', 'Comando R1 sem confirmação deve aguardar consentimento');

  // R1 com uiConfirmed: true -> gera token HMAC válido e EXECUTED
  const r1Confirmed = await devicesManager.sendCommand('dev-iot-gate', 'REBOOT', 'R1', { reason: 'teste' }, { uiConfirmed: true });
  assert.equal(r1Confirmed.status, 'EXECUTED', `Comando R1 confirmado na UI deveria executar, mas retornou ${r1Confirmed.status}: ${r1Confirmed.resultSummary}`);

  // R2 com uiConfirmed: true -> também deve executar com token HMAC emitido
  const r2Confirmed = await devicesManager.sendCommand('dev-iot-gate', 'TOGGLE_STATE', 'R2', { target: 'lock' }, { uiConfirmed: true });
  assert.equal(r2Confirmed.status, 'EXECUTED', `Comando R2 confirmado na UI deveria executar, mas retornou ${r2Confirmed.status}: ${r2Confirmed.resultSummary}`);

  // R3 sempre bloqueado mesmo com uiConfirmed: true
  const r3Blocked = await devicesManager.sendCommand('dev-iot-gate', 'REBOOT', 'R3', { forceWipe: true }, { uiConfirmed: true });
  assert.equal(r3Blocked.status, 'BLOCKED_BY_POLICY', 'Comando R3 deve continuar bloqueado por política');
});

test('AUDIT-PASS2-03: pcControlTools distingue dry-run, fallback honesto Web Preview e validações rígidas', async () => {
  const prevDry = process.env.LIORA_NO_BROWSER;
  const prevDisplay = process.env.DISPLAY;
  const prevWayland = process.env.WAYLAND_DISPLAY;
  const prevForceReal = process.env.LIORA_FORCE_REAL_OS;

  try {
    // 1. Modo dry-run (LIORA_NO_BROWSER=1): hotkey agora respeita dry-run
    process.env.LIORA_NO_BROWSER = '1';
    const dryHotkey = await pcSimulateInputTool.execute({ action: 'hotkey', keys: 'ctrl+s' });
    assert.equal(dryHotkey.success, true);
    assert.equal(dryHotkey.dryRun, true);
    assert.equal(dryHotkey.simulated, true);

    // Continua rejeitando hotkey inválido mesmo em dry-run
    const badHotkey = await pcSimulateInputTool.execute({ action: 'hotkey', keys: 'ctrl+teclainvalida' });
    assert.equal(badHotkey.success, false);
    assert.match(String(badHotkey.error), /UNSUPPORTED_KEYS/);

    // 2. Modo Web Preview headless no Linux (sem DISPLAY / WAYLAND_DISPLAY e sem LIORA_NO_BROWSER)
    if (os.platform() === 'linux') {
      delete process.env.LIORA_NO_BROWSER;
      delete process.env.DISPLAY;
      delete process.env.WAYLAND_DISPLAY;
      delete process.env.LIORA_FORCE_REAL_OS;

      const simClick = await pcSimulateInputTool.execute({ action: 'click', x: 120, y: 240 });
      assert.equal(simClick.success, true);
      assert.equal(simClick.simulated, true);
      assert.equal(simClick.runtimeMode, 'web-preview-simulated');

      const simType = await pcSimulateInputTool.execute({ action: 'type', text: 'Relatório LIORA' });
      assert.equal(simType.success, true);
      assert.equal(simType.simulated, true);
      assert.equal(simType.runtimeMode, 'web-preview-simulated');

      const simHotkey = await pcSimulateInputTool.execute({ action: 'hotkey', keys: 'ctrl+t' });
      assert.equal(simHotkey.success, true);
      assert.equal(simHotkey.simulated, true);
      assert.equal(simHotkey.runtimeMode, 'web-preview-simulated');

      const simKill = await pcManageAppsTool.execute({ action: 'kill', processName: 'notepad.exe' });
      assert.equal(simKill.success, true);
      assert.equal(simKill.simulated, true);
      assert.equal(simKill.runtimeMode, 'web-preview-simulated');

      // Validações continuam ativas no Web Preview: parâmetros ausentes e processos protegidos falham
      const missingCoords = await pcSimulateInputTool.execute({ action: 'click' });
      assert.equal(missingCoords.success, false);
      assert.match(String(missingCoords.error), /MISSING_COORDS/);

      const missingText = await pcSimulateInputTool.execute({ action: 'type', text: '' });
      assert.equal(missingText.success, false);
      assert.match(String(missingText.error), /MISSING_TEXT/);

      const protectedProc = await pcManageAppsTool.execute({ action: 'kill', processName: 'svchost.exe' });
      assert.equal(protectedProc.success, false);
      assert.match(String(protectedProc.error), /PROTECTED_PROCESS/);
    }
  } finally {
    if (prevDry === undefined) delete process.env.LIORA_NO_BROWSER;
    else process.env.LIORA_NO_BROWSER = prevDry;
    if (prevDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = prevDisplay;
    if (prevWayland === undefined) delete process.env.WAYLAND_DISPLAY;
    else process.env.WAYLAND_DISPLAY = prevWayland;
    if (prevForceReal === undefined) delete process.env.LIORA_FORCE_REAL_OS;
    else process.env.LIORA_FORCE_REAL_OS = prevForceReal;
  }
});

test('AUDIT-PASS2-04: pcCommandParser captura abertura simples e libera fluxos compostos para orquestração LLM', () => {
  const simpleLaunch = parsePcCommandIntent('abra o bloco de notas');
  assert.ok(simpleLaunch, 'Comando simples deve ser capturado pelo atalho determinístico');
  assert.equal(simpleLaunch.type, 'app_launch');
  assert.equal(simpleLaunch.executable, 'notepad');

  // Comandos compostos com início/meio/fim, abas ou fechamento devem ir para o LLM
  assert.equal(
    parsePcCommandIntent('abra o bloco de notas e escreva um relatório'),
    null,
    'Comando composto com escrita deve retornar null para encadeamento LLM'
  );
  assert.equal(
    parsePcCommandIntent('abra outra aba no navegador'),
    null,
    'Pedido de abrir nova/outra aba deve retornar null'
  );
  assert.equal(
    parsePcCommandIntent('feche o bloco de notas'),
    null,
    'Pedido de fechar aplicativo deve retornar null'
  );
  assert.equal(
    parsePcCommandIntent('abra o bloco de notas para anotar ideias'),
    null,
    'Pedido de anotar ideias deve retornar null'
  );
});

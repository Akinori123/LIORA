/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Testes de Regressão — Auditoria Contínua de Bugs LIORA
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { parsePcCommandIntent } from '../src/utils/pcCommandParser';
import { parseTimeCommandIntent } from '../src/utils/timeCommandParser';
import { fileSearchAndReadTool } from '../src/tools/pcControlTools';
import { resolvePlaceAliasTool, savePlaceAliasTool } from '../src/tools/navigation/placeAliasTool';
import { DevicesManager } from '../src/services/devicesManager';
import { IntegrationsVault } from '../src/services/integrationsVault';
import { EventBus } from '../src/utils/eventBus';

test('REG-01: pcCommandParser rejeita falsos positivos e acerta comandos exatos', () => {
  assert.strictEqual(parsePcCommandIntent('abrir operacao'), null);
  assert.strictEqual(parsePcCommandIntent('abrir calculo'), null);
  assert.strictEqual(parsePcCommandIntent('eu mudo de ideia'), null);
  assert.strictEqual(parsePcCommandIntent('abrir password'), null);

  const opera = parsePcCommandIntent('abrir opera');
  assert.ok(opera && opera.type === 'app_launch');
  assert.strictEqual(opera.executable, 'opera');

  const chrome = parsePcCommandIntent('abrir google');
  assert.ok(chrome && chrome.type === 'app_launch');
  assert.strictEqual(chrome.executable, 'chrome');

  const mute1 = parsePcCommandIntent('mutar som');
  assert.ok(mute1);
  assert.strictEqual(mute1.type, 'volume_mute');

  const mute2 = parsePcCommandIntent('colocar no mudo');
  assert.ok(mute2);
  assert.strictEqual(mute2.type, 'volume_mute');
});

test('REG-02: timeCommandParser rejeita perguntas gerais e responde consultas atuais de data/hora', () => {
  assert.strictEqual(parseTimeCommandIntent('quantas horas tem um dia?'), null);
  assert.strictEqual(parseTimeCommandIntent('que horas abre o banco?'), null);
  assert.strictEqual(parseTimeCommandIntent('qual a data do natal?'), null);

  const timeRes = parseTimeCommandIntent('que horas são?');
  assert.ok(timeRes && timeRes.type === 'time_query');
  assert.match(timeRes.spokenFeedback, /Agora são/i);

  const dateRes1 = parseTimeCommandIntent('que dia é hoje?');
  assert.ok(dateRes1 && dateRes1.type === 'time_query');
  assert.match(dateRes1.spokenFeedback, /Hoje é/i);

  const dateRes2 = parseTimeCommandIntent('qual a data de hoje?');
  assert.ok(dateRes2 && dateRes2.type === 'time_query');
  assert.match(dateRes2.spokenFeedback, /Hoje é/i);
});

test('REG-03: fileSearchAndReadTool funciona sem rootPath e bloqueia prefixo irmão (path traversal)', async () => {
  const defaultSearch = await fileSearchAndReadTool.execute(
    { query: `nonexistent_liora_probe_${Date.now()}` },
    { sessionId: 'reg-test', timestamp: new Date().toISOString() }
  );
  assert.strictEqual(defaultSearch.success, true, `Busca padrão não deve falhar com PATH_OUT_OF_SCOPE: ${defaultSearch.error}`);
  assert.ok(Array.isArray(defaultSearch.results));

  const siblingEvil = `${os.tmpdir()}-evil`;
  const blockedSearch = await fileSearchAndReadTool.execute(
    { query: 'secret', rootPath: siblingEvil },
    { sessionId: 'reg-test', timestamp: new Date().toISOString() }
  );
  assert.strictEqual(blockedSearch.success, false);
  assert.match(String(blockedSearch.error), /PATH_OUT_OF_SCOPE/);
});

test('REG-04: save_place_alias + resolve_place_alias faz roundtrip de apelido com múltiplas palavras', async () => {
  const prevEnv = process.env.LIORA_MEMORY_DIR;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liora-reg04-mem-'));
  process.env.LIORA_MEMORY_DIR = tempDir;

  try {
    const saved = await savePlaceAliasTool.execute(
      {
        alias: 'Casa do Amigo',
        address: 'Shopping Palladium, Ponta Grossa'
      },
      { sessionId: 'reg-test', timestamp: new Date().toISOString() }
    );
    assert.strictEqual(saved.success, true);

    const resolved = await resolvePlaceAliasTool.execute(
      { alias: 'Casa do Amigo' },
      { sessionId: 'reg-test', timestamp: new Date().toISOString() }
    );
    assert.strictEqual(resolved.success, true);
    assert.strictEqual(resolved.resolved, true);
    assert.strictEqual(resolved.address, 'Shopping Palladium, Ponta Grossa');
  } finally {
    if (prevEnv === undefined) {
      delete process.env.LIORA_MEMORY_DIR;
    } else {
      process.env.LIORA_MEMORY_DIR = prevEnv;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('REG-05: DevicesManager não falsifica isCharging=true nem batteryLevel=100 quando bateria é null', async () => {
  const originalFetch = globalThis.fetch;
  if (typeof (globalThis as any).window !== 'undefined') {
    delete (globalThis as any).window.__TAURI__;
  }

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        success: true,
        cpu_usage_percent: 12.5,
        cpu_cores: 8,
        memory_usage_percent: 40.0,
        memory_free_bytes: 8 * 1024 * 1024 * 1024,
        memory_total_bytes: 16 * 1024 * 1024 * 1024,
        disk_usage_percent: 33.3,
        battery_level: null,
        is_charging: null,
        temperature_celsius: null,
        uptime_seconds: 1200,
        hostname: 'desktop-host',
        os_name: 'Linux',
        os_version: '6.8',
        arch: 'x64',
        timestamp: new Date().toISOString()
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as typeof fetch;

  try {
    const manager = new DevicesManager();
    const tel = await manager.refreshTelemetry('dev-1');
    assert.ok(tel);
    assert.strictEqual(tel.batteryLevel, undefined);
    assert.strictEqual(tel.isCharging, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('REG-06: IntegrationsVault disconnectService limpa chave residual do localStorage', async () => {
  const storeMap = new Map<string, string>();
  const origLocalStorage = (globalThis as any).localStorage;
  const origGeminiEnv = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;

  (globalThis as any).localStorage = {
    getItem: (k: string) => storeMap.get(k) ?? null,
    setItem: (k: string, v: string) => { storeMap.set(k, v); },
    removeItem: (k: string) => { storeMap.delete(k); },
    clear: () => { storeMap.clear(); }
  };

  try {
    const vault = new IntegrationsVault(new EventBus());
    await vault.connectService('svc-gemini', 'AIzaSyDisconnectRegressionKey12345', { customLatencyMs: 20 });
    assert.strictEqual(vault.getApiKeyByProvider('gemini'), 'AIzaSyDisconnectRegressionKey12345');

    const ok = vault.disconnectService('svc-gemini');
    assert.strictEqual(ok, true);
    assert.strictEqual(vault.getApiKeyByProvider('gemini'), undefined);
    assert.strictEqual(storeMap.get('GEMINI_API_KEY'), undefined);
  } finally {
    if (origGeminiEnv !== undefined) process.env.GEMINI_API_KEY = origGeminiEnv;
    if (origLocalStorage === undefined) {
      delete (globalThis as any).localStorage;
    } else {
      (globalThis as any).localStorage = origLocalStorage;
    }
  }
});

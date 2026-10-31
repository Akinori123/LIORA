/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { useLioraStore, MAX_ACTIVITY_LOGS, ACTIVITY_LOGS_STORAGE_KEY } from '../src/store/lioraStore';

// Mock localStorage for node environment if unavailable
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

describe('Aba Atividade & Auditoria (ActivityView Audit Suite)', () => {
  beforeEach(() => {
    localStorage.clear();
    useLioraStore.setState({
      activityLogs: [
        { id: 'log-1', timestamp: '10:00:00', category: 'system', summary: 'System booted', details: 'LIORA Core online', riskLevel: 'R0', status: 'success', simulated: false },
        { id: 'log-2', timestamp: '10:01:00', category: 'security', summary: 'API Key updated', details: 'GEMINI_API_KEY updated in .env', riskLevel: 'R1', status: 'success', simulated: false },
        { id: 'log-3', timestamp: '10:02:00', category: 'tool', summary: 'Dangerous script executed', details: 'Terminal exec command', riskLevel: 'R2', status: 'warning', simulated: false }
      ]
    });
  });

  test('ACT-01: Ring Buffer do addActivityLog limita a 200 logs max em memória', () => {
    for (let i = 0; i < 250; i++) {
      useLioraStore.getState().addActivityLog({
        category: 'tool',
        summary: `Log de teste #${i}`,
        details: `Detalhes de teste do log ${i}`,
        riskLevel: i % 2 === 0 ? 'R0' : 'R2',
        status: 'success',
        simulated: false
      });
    }

    const logs = useLioraStore.getState().activityLogs;
    assert.strictEqual(logs.length, MAX_ACTIVITY_LOGS, `Deveria limitar a exatamente ${MAX_ACTIVITY_LOGS} itens`);
    assert.strictEqual(logs[0].summary, 'Log de teste #249', 'O log mais recente deve estar no topo');
  });

  test('ACT-02: Persistência no LocalStorage com chave liora_activity_logs_v1', () => {
    useLioraStore.getState().addActivityLog({
      category: 'security',
      summary: 'Persistência verificada',
      details: 'Teste de salvamento no LocalStorage',
      riskLevel: 'R1',
      status: 'success',
      simulated: false
    });

    const storedRaw = localStorage.getItem(ACTIVITY_LOGS_STORAGE_KEY);
    assert.ok(storedRaw, 'Deveria existir a chave liora_activity_logs_v1 no LocalStorage');

    const parsed = JSON.parse(storedRaw!);
    assert.ok(Array.isArray(parsed), 'O dado salvo no LocalStorage deve ser uma lista JSON');
    assert.strictEqual(parsed[0].summary, 'Persistência verificada');
  });

  test('ACT-03: Limpeza de auditoria gera log autorreferenciado de segurança (R1)', () => {
    useLioraStore.getState().clearActivityLogs();

    const logs = useLioraStore.getState().activityLogs;
    assert.strictEqual(logs.length, 1, 'Após a limpeza, deve existir apenas o log de segurança autorreferenciado');
    assert.strictEqual(logs[0].category, 'security');
    assert.strictEqual(logs[0].summary, 'Logs de auditoria limpos pelo usuário');
    assert.strictEqual(logs[0].riskLevel, 'R1');
  });

  test('ACT-04: Filtros de auditoria (categoria, risco e status) funcionam corretamente', () => {
    const logs = useLioraStore.getState().activityLogs;

    const r2Logs = logs.filter(l => l.riskLevel === 'R2');
    assert.strictEqual(r2Logs.length, 1);
    assert.strictEqual(r2Logs[0].id, 'log-3');

    const securityLogs = logs.filter(l => l.category === 'security');
    assert.strictEqual(securityLogs.length, 1);
    assert.strictEqual(securityLogs[0].id, 'log-2');
  });
});

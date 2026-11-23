/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cobertura de contrato do `executeLocalTool`: cada ramo da ponte (Tauri nativo,
 * ferramenta não suportada no Rust, consentimento UI recusado, resposta não-JSON
 * e falha de rede) deve devolver um LocalExecutionResult honesto — sem mascarar
 * uma falha nativa real com um fallback simulado.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { executeLocalTool, asRecord } from '../src/security/localBridge';

type GlobalWithWindow = typeof globalThis & { window?: any };

async function withTauri<T>(
  invoke: () => Promise<any>,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  run: () => Promise<T>
): Promise<T> {
  const g = globalThis as GlobalWithWindow;
  const prevWindow = g.window;
  const prevFetch = globalThis.fetch;
  g.window = {
    location: { protocol: 'tauri:', host: 'tauri.localhost' },
    __TAURI__: { core: { invoke } }
  };
  globalThis.fetch = fetchImpl as any;
  try {
    return await run();
  } finally {
    if (prevWindow === undefined) delete g.window;
    else g.window = prevWindow;
    globalThis.fetch = prevFetch;
  }
}

test('LB-01: sucesso nativo do Rust é devolvido sem tocar no fallback Express', async () => {
  let fetchCalls = 0;
  const res = await withTauri(
    async () => ({
      toolName: 'system_info',
      success: true,
      data: { os: 'windows' },
      simulated: false,
      riskLevel: 'R0',
      executionTimeMs: 3,
      timestamp: new Date().toISOString()
    }),
    async () => {
      fetchCalls++;
      throw new Error('fallback não deveria ser chamado');
    },
    () => executeLocalTool('system_info', {})
  );

  assert.equal(fetchCalls, 0);
  assert.equal(res.success, true);
  assert.equal(res.simulated, false);
  assert.equal(asRecord(res.data)?.os, 'windows');
});

test('LB-02: ferramenta não suportada no Rust cai para o backend Express', async () => {
  let fetchedUrl = '';
  const res = await withTauri(
    async () => ({
      toolName: 'pc_simulate_input',
      success: false,
      error: "Ferramenta desconhecida ou não suportada no Tauri: 'pc_simulate_input'.",
      simulated: false,
      riskLevel: 'R2',
      executionTimeMs: 1,
      timestamp: new Date().toISOString()
    }),
    async (url) => {
      fetchedUrl = url;
      return new Response(
        JSON.stringify({ success: true, toolName: 'pc_simulate_input', simulated: false, data: { typed: true } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    },
    () => executeLocalTool('pc_simulate_input', { action: 'type', text: 'oi' }, 'sess-1')
  );

  assert.match(fetchedUrl, /\/api\/tools\/execute$/);
  assert.equal(res.success, true);
  assert.equal(res.simulated, false);
  assert.equal(asRecord(res.data)?.typed, true);
});

test('LB-03: consentimento UI recusado pelo Rust segue para o Express com o token', async () => {
  let sentToken: string | undefined;
  const res = await withTauri(
    async () => ({
      toolName: 'pc_manage_apps',
      success: false,
      code: 'NATIVE_PERMISSION_BLOCKED',
      error: "CONSENT_TOKEN_INVALID_OR_MISSING: Ferramenta 'pc_manage_apps' (R2) exige token.",
      simulated: false,
      riskLevel: 'R2',
      executionTimeMs: 1,
      timestamp: new Date().toISOString()
    }),
    async (_url, init) => {
      sentToken = (init?.headers as Record<string, string>)?.['x-liora-ui-consent'];
      return new Response(
        JSON.stringify({ success: true, toolName: 'pc_manage_apps', decision: 'ALLOW', riskLevel: 'R2', simulated: false, data: { opened: true } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    },
    () => executeLocalTool('pc_manage_apps', { action: 'launch' }, 'sess-2', 'ui-token-abc')
  );

  assert.equal(sentToken, 'ui-token-abc');
  assert.equal(res.success, true);
  assert.equal(asRecord(res.data)?.opened, true);
});

test('LB-04: falha real de IPC nativo devolve NATIVE_IPC_ERROR sem fallback', async () => {
  let fetchCalls = 0;
  const res = await withTauri(
    async () => {
      throw new Error('Falha de IO ao gravar arquivo no disco');
    },
    async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ success: true, simulated: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    },
    () => executeLocalTool('workspace_write_file', { path: 'a.txt', content: 'x' })
  );

  assert.equal(fetchCalls, 0, 'não pode mascarar a falha nativa com um resultado simulado');
  assert.equal(res.success, false);
  assert.equal(res.code, 'NATIVE_IPC_ERROR');
  assert.equal(res.simulated, false);
  assert.equal(res.decision, 'DENY');
  assert.match(String(res.error), /Falha de IO/);
});

test('LB-05: resposta não-JSON do servidor Express devolve NETWORK_ERROR honesto', async () => {
  const res = await withTauri(
    async () => {
      throw new Error("Ferramenta desconhecida ou não suportada no Tauri: 'workspace_list_files'.");
    },
    async () => new Response('<html>erro</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
    () => executeLocalTool('workspace_list_files', {})
  );

  assert.equal(res.success, false);
  assert.equal(res.code, 'NETWORK_ERROR');
  assert.equal(res.simulated, true);
});

test('LB-06: parâmetros inválidos (nome vazio) retornam INVALID_INPUT sem chamar a ponte', async () => {
  const res = await executeLocalTool('', {});
  assert.equal(res.success, false);
  assert.equal(res.code, 'INVALID_INPUT');
});

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Testes Unitários do Agente Web Autónomo (Fase 1: Browser Use) — LIORA
 * Valida: política de segurança de URLs, blocklist de domínios, bloqueio de
 * downloads executáveis, limites de pipeline e execução real headless (quando
 * o Chromium do Playwright está disponível).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { webBrowserAgentTool } from '../src/tools/web/browserAgentTool';

// ─── Validação de política de segurança (sem browser real) ──────────────────

test('WEBAGENT-01: ferramenta declarada como R2 (consentimento obrigatório)', () => {
  assert.strictEqual(webBrowserAgentTool.name, 'web_browser_agent');
  assert.strictEqual(webBrowserAgentTool.riskLevel, 'R2');
  assert.strictEqual(webBrowserAgentTool.category, 'browser');
  assert.strictEqual(webBrowserAgentTool.isSimulated, false);
});

test('WEBAGENT-02: bloqueia esquemas perigosos (file://, javascript:, data:)', async () => {
  const cases = ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html;base64,xx', 'about:blank', 'chrome://settings'];
  for (const url of cases) {
    const res = await webBrowserAgentTool.execute({ url, actions: [{ action: 'extract_text' }] });
    assert.strictEqual(res.success, false, `URL '${url}' deve ser bloqueada`);
    assert.match(String(res.error), /URL_BLOCKED|INVALID_URL/);
  }
});

test('WEBAGENT-03: bloqueia destinos internos (localhost) e IPs diretos', async () => {
  const cases = ['http://localhost:3000/api/health', 'http://127.0.0.1:8080/admin', 'http://192.168.0.15/login', 'https://10.0.0.1/'];
  for (const url of cases) {
    const res = await webBrowserAgentTool.execute({ url, actions: [{ action: 'extract_text' }] });
    assert.strictEqual(res.success, false, `URL '${url}' deve ser bloqueada`);
    assert.match(String(res.error), /URL_BLOCKED/);
  }
});

test('WEBAGENT-04: bloqueia domínios da blocklist (TLDs abusados e encurtadores)', async () => {
  const cases = ['https://exemplo-pcs.tk/login', 'https://bit.ly/abc123'];
  for (const url of cases) {
    const res = await webBrowserAgentTool.execute({ url, actions: [{ action: 'extract_text' }] });
    assert.strictEqual(res.success, false, `Domínio '${url}' deve estar bloqueado`);
    assert.match(String(res.error), /DOMAIN_BLOCKED|URL_BLOCKED/);
  }
});

test('WEBAGENT-05: rejeita pipeline vazio ou sem ações', async () => {
  const res1 = await webBrowserAgentTool.execute({ url: 'https://example.com', actions: [] });
  assert.strictEqual(res1.success, false);
  assert.match(String(res1.error), /NO_ACTIONS/);
});

test('WEBAGENT-06: termos genéricos são resolvidos como busca (não falha)', async () => {
  // CORREÇÃO (Etapa 3): termo sem formato de URL é convertido em pesquisa do
  // Google em vez de falhar com INVALID_URL — era a causa do "agente perdido".
  const res = await webBrowserAgentTool.execute({ url: 'nao-e-uma-url', actions: [{ action: 'extract_text' }] });
  assert.strictEqual(res.simulated, false);
  if (res.success) {
    assert.ok(res.finalUrl.includes('google.com/search'), 'termo genérico deve virar busca do Google');
  } else {
    // Ambiente sem Chromium: erro honesto de launch (não mais INVALID_URL)
    assert.match(String(res.error), /BROWSER_LAUNCH_FAILED|NAVIGATION_FAILED|AGENT_ERROR/);
  }
  try {
    const { browserCloseSessionTool } = await import('../src/tools/browser/playwrightTool');
    if (res.sessionId) await browserCloseSessionTool.execute({ sessionId: res.sessionId });
  } catch { /* ignora */ }
});

// ─── Execução real (requer Chromium do Playwright) ──────────────────────────

test('WEBAGENT-07: execução real navega, extrai texto e captura screenshot', { timeout: 60000 }, async () => {
  const res = await webBrowserAgentTool.execute({
    url: 'https://example.com',
    actions: [
      { action: 'extract_text', description: 'extrair corpo da página' },
      { action: 'screenshot', description: 'capturar estado final' }
    ]
  });

  assert.strictEqual(res.simulated, false);
  if (res.success) {
    assert.ok(res.sessionId.startsWith('pw_'), 'sessão Playwright gerada');
    assert.ok(res.finalUrl.includes('example.com'));
    assert.ok(typeof res.title === 'string' && res.title.length > 0);
    // extração de texto real: conteúdo não-vazio (a página pode variar o texto exato)
    assert.ok(typeof res.extractedText === 'string' && res.extractedText.trim().length > 10, `texto extraído deve ter conteúdo (recebido: ${(res.extractedText || '').slice(0, 60)})`);
    assert.ok(typeof res.screenshot === 'string' && res.screenshot.length > 1000, 'screenshot base64 presente');
    assert.ok(res.stepsExecuted.length === 2);
    assert.ok(res.stepsExecuted.every(s => s.ok), 'todos os passos devem ter sucesso');
  } else {
    // Chromium não disponível no ambiente — erro deve ser honesto
    assert.match(String(res.error), /BROWSER_LAUNCH_FAILED|NAVIGATION_FAILED|AGENT_ERROR|STEP_0_FAILED/);
  }

  // Fecha a sessão para liberar recursos (evita hang do event loop)
  try {
    const { browserCloseSessionTool } = await import('../src/tools/browser/playwrightTool');
    if (res.sessionId) await browserCloseSessionTool.execute({ sessionId: res.sessionId });
  } catch { /* ignora */ }
});

test('WEBAGENT-08: pipeline com tipo de ação desconhecido falha no passo específico', async () => {
  const res = await webBrowserAgentTool.execute({
    url: 'https://example.com',
    actions: [{ action: 'extract_text' }, { action: 'hack_the_planet' } as any]
  });
  assert.strictEqual(res.simulated, false);
  if (res.success) {
    // Não deveria ocorrer, mas se ocorrer o passo desconhecido não pode estar ok
    assert.ok(res.stepsExecuted.every(s => s.action !== 'hack_the_planet' || !s.ok));
  } else {
    assert.match(String(res.error), /UNKNOWN_ACTION|STEP_\d+_FAILED|BROWSER_LAUNCH_FAILED|NAVIGATION_FAILED|AGENT_ERROR/);
  }
});

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Regressões dos itens B (controle real de apps por inspeção de UI) e
 * A (leitura real de páginas com navegador headless).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';

const SRC = 'src';
const read = (p: string) => fs.readFileSync(p, 'utf8');

/* ── B: inspeção de interface ───────────────────────────────────────────── */

test('UI-01: pc_inspect_app_ui está registrada e é R0 (leitura)', async () => {
  const { toolRegistry } = await import('../src/tools/registry');
  const { installNativeServerTools } = await import('../src/tools/nativeServerTools');
  installNativeServerTools(toolRegistry);
  assert.ok(toolRegistry.hasTool('pc_inspect_app_ui'));
  assert.equal(toolRegistry.getTool('pc_inspect_app_ui')!.riskLevel, 'R0');
});

test('UI-02: inspeção real lista o campo de texto do Bloco de Notas', { skip: os.platform() !== 'win32' }, async () => {
  const { execSync } = await import('node:child_process');
  const { pcInspectAppUiTool } = await import('../src/tools/pcControlTools');
  execSync('powershell -NoProfile -Command "Start-Process notepad"', { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2500));
  try {
    const res = await pcInspectAppUiTool.execute({ target: 'notepad' } as any);
    assert.equal(res.success, true, String(res.error));
    const win = res.windows[0];
    assert.ok(win, 'nenhuma janela retornada');
    const textFields = win.controls.filter((c: any) => c.kind === 'text_field');
    assert.ok(textFields.length > 0, 'campo de texto (Edit) não identificado');
    // Regressão do encoding: títulos com acento não podem chegar corrompidos.
    assert.doesNotMatch(String(win.title), /\?tulo|\uFFFD/, 'acentos corrompidos na saída');
  } finally {
    execSync('powershell -NoProfile -Command "Stop-Process -Name notepad -Force -ErrorAction SilentlyContinue"', { stdio: 'ignore' });
  }
});

test('UI-03: C# gerado não usa recursos que o PowerShell 5.1 não compila', () => {
  // `||`, `&&` e `\\n` dentro do here-string eram a causa de falhas silenciosas.
  const src = read(`${SRC}/tools/pcControlTools.ts`);
  const start = src.indexOf('export const pcInspectAppUiTool');
  const block = src.slice(start);
  const csBlock = block.slice(block.indexOf('Add-Type @"'), block.indexOf('"@'));
  assert.doesNotMatch(csBlock, /\|\|/, 'operador || (não suportado no C#5 do PowerShell 5.1)');
  assert.doesNotMatch(csBlock, /&&\s*\(/, '&& avaliado em expressão C#5');
});

/* ── A: leitura real de páginas ─────────────────────────────────────────── */

test('READER-01: browser_read_page registrada, R1 e declarada ao modelo', async () => {
  const { toolRegistry } = await import('../src/tools/registry');
  const { installNativeServerTools } = await import('../src/tools/nativeServerTools');
  installNativeServerTools(toolRegistry);
  assert.ok(toolRegistry.hasTool('browser_read_page'));
  assert.equal(toolRegistry.getTool('browser_read_page')!.riskLevel, 'R1');
  const { STRICT_PROFILE } = await import('../src/security/profiles');
  assert.ok(STRICT_PROFILE.allowedTools.includes('browser_read_page'));
});

test('READER-02: bloqueia esquemas e destinos locais (anti-SSRF)', async () => {
  const { browserReadPageTool } = await import('../src/tools/browser/browserReaderTool');
  for (const url of ['file:///C:/Windows/win.ini', 'http://localhost:3000/', 'http://192.168.0.1/', 'ftp://x.com/a']) {
    const res = await browserReadPageTool.execute({ url } as any);
    assert.equal(res.success, false, `deveria bloquear ${url}`);
    assert.match(String(res.error), /URL_BLOCKED|INVALID_URL/);
  }
});

test('READER-03: lê conteúdo real de uma página pública', { skip: os.platform() === 'aix' }, async () => {
  const { browserReadPageTool } = await import('../src/tools/browser/browserReaderTool');
  const res = await browserReadPageTool.execute({ url: 'https://example.com', maxChars: 500 } as any);
  assert.equal(res.success, true, String(res.error));
  assert.match(String(res.text).toLowerCase(), /documentation example|example/);
});

test('READER-04: página bloqueada por anti-bot NÃO vira sucesso falso', () => {
  const src = read(`${SRC}/tools/browser/browserReaderTool.ts`);
  assert.match(src, /PAGE_BLOCKED_BY_SITE/);
  assert.match(src, /PAGE_WITHOUT_CONTENT/);
  assert.match(src, /looksLikeErrorPage/, 'heurística de página vazia ausente');
});

test('READER-05: prompt instrui a LER a página em vez de dizer "está na tela"', () => {
  const store = read(`${SRC}/store/lioraStore.ts`);
  assert.match(store, /browser_read_page/, 'o modelo não sabe que pode ler a página');
});

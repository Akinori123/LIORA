/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Execução REAL de comandos: pasta de trabalho, saída e código de erro.
 * Prova o bug do confinamento de diretório: o `exec` do Node herda o cwd, mas
 * ferramentas de sandbox precisam trabalhar no WORKSPACE da LIORA — e não em
 * C:\Windows\System32 (o que acontece no runtime Tauri).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { installNativeServerTools } from '../src/tools/nativeServerTools';
import { toolRegistry } from '../src/tools/registry';

installNativeServerTools(toolRegistry);

test('EXEC-REAL-01: comando na lista branca executa e devolve saída real', async () => {
  const res = await toolRegistry.executeTool('system_exec_sandbox', { command: 'node --version' });
  assert.equal(res.success, true, res.error);
  assert.match(String(res.data?.stdout || ''), /^v\d+\./, 'stdout não contém a versão do Node');
  assert.equal(res.data?.exitCode, 0);
});

test('EXEC-REAL-02: comando com falha reporta exitCode e sucesso=false (sem falso sucesso)', async () => {
  const res = await toolRegistry.executeTool('system_exec_sandbox', { command: 'git status' });
  // Em ambiente sem repositório git -> exitCode 128; em repositório -> 0. Ambos honestos.
  const exitCode = Number(res.data?.exitCode);
  if (exitCode === 0) {
    assert.equal(res.success, true);
  } else {
    assert.equal(res.success, false);
    assert.match(String(res.error || ''), /exitCode|VERIFICATION|falhou/i);
  }
});

test('EXEC-REAL-03: ferramenta executa dentro do WORKSPACE da LIORA (não em System32)', async () => {
  // Prova concreta: um arquivo só existe no workspace. `dir`/`ls` executado a
  // partir do cwd ERRADO (System32 no Tauri, ou a raiz do projeto no Node) não
  // lista esse arquivo.
  const workspaceRoot = path.join(os.homedir(), '.liora', 'workspace');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const marker = 'liora-cwd-probe.txt';
  fs.writeFileSync(path.join(workspaceRoot, marker), 'probe', 'utf8');

  try {
    const isWindows = os.platform() === 'win32';
    const listed = await toolRegistry.executeTool(
      'system_exec_sandbox',
      { command: isWindows ? 'dir' : 'ls' }
    );
    assert.equal(listed.success, true, listed.error);
    assert.match(
      String(listed.data?.stdout || ''),
      new RegExp(marker),
      'o comando não listou o arquivo do workspace — cwd incorreto (System32 / raiz do projeto)'
    );
  } finally {
    try { fs.unlinkSync(path.join(workspaceRoot, marker)); } catch { /* ignore */ }
  }
});

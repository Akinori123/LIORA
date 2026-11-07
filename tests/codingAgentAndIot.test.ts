/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Suíte de Testes Unitários: Coding Agent & Módulo de Automação IoT (Portão Físico)
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import {
  codeSearchSymbolsTool,
  codeReadFileTool,
  codeApplyPatchTool,
  gitStatusTool,
  codeRunTestsTool
} from '../src/tools/coding/codingTools';
import {
  iotListDevicesTool,
  iotSendCommandTool
} from '../src/tools/iot/iotTools';
import { getLioraWorkspaceRoot } from '../src/tools/nativeServerTools';

test('COD-01: code_search_symbols busca termos e respeita filtros de extensão', async () => {
  assert.strictEqual(codeSearchSymbolsTool.name, 'code_search_symbols');
  assert.strictEqual(codeSearchSymbolsTool.riskLevel, 'R0');

  const root = getLioraWorkspaceRoot();
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });

  const testFile = path.join(root, 'teste_codigo.ts');
  fs.writeFileSync(testFile, 'export function calcularRotaSegura() {\n  return "ok";\n}\n', 'utf-8');

  try {
    const res = await codeSearchSymbolsTool.execute({
      query: 'calcularRotaSegura',
      fileExtension: '.ts',
      maxResults: 5
    });

    assert.strictEqual(res.simulated, false);
    assert.ok(res.count >= 1, 'Deve encontrar a função no arquivo criado');
    const match = res.matches.find((m: { file: string }) => m.file.includes('teste_codigo.ts'));
    assert.ok(match, 'Deve conter referência ao arquivo');
    assert.strictEqual(match.symbolType, 'function');
  } finally {
    if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  }
});

test('COD-02: code_read_file lê intervalos de linhas e bloqueia path traversal', async () => {
  assert.strictEqual(codeReadFileTool.name, 'code_read_file');
  assert.strictEqual(codeReadFileTool.riskLevel, 'R0');

  const root = getLioraWorkspaceRoot();
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });

  const testFile = path.join(root, 'teste_linhas.txt');
  fs.writeFileSync(testFile, 'Linha 1\nLinha 2\nLinha 3\nLinha 4\nLinha 5\n', 'utf-8');

  try {
    const res = await codeReadFileTool.execute({
      filePath: 'teste_linhas.txt',
      startLine: 2,
      endLine: 4
    });

    assert.strictEqual(res.simulated, false);
    assert.strictEqual(res.lines.length, 3);
    assert.strictEqual(res.lines[0].line, 2);
    assert.strictEqual(res.lines[0].text, 'Linha 2');
    assert.strictEqual(res.lines[2].line, 4);
    assert.strictEqual(res.lines[2].text, 'Linha 4');

    // Bloqueio de path traversal
    await assert.rejects(
      async () => {
        await codeReadFileTool.execute({ filePath: '../../../../etc/shadow' });
      },
      (err: Error) => err.message.includes('PATH_TRAVERSAL_BLOCKED')
    );
  } finally {
    if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  }
});

test('COD-03: code_apply_patch substitui trechos com validação e integridade', async () => {
  assert.strictEqual(codeApplyPatchTool.name, 'code_apply_patch');
  assert.strictEqual(codeApplyPatchTool.riskLevel, 'R2');

  const root = getLioraWorkspaceRoot();
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });

  const testFile = path.join(root, 'teste_patch.js');
  fs.writeFileSync(testFile, 'const versao = "1.0.0";\nconst status = "DEV";\n', 'utf-8');

  try {
    // 1. Aplica substituição
    const patchRes = await codeApplyPatchTool.execute({
      filePath: 'teste_patch.js',
      target: 'const versao = "1.0.0";',
      replacement: 'const versao = "2.0.0";'
    });
    assert.strictEqual(patchRes.success, true);

    const updated = fs.readFileSync(testFile, 'utf-8');
    assert.ok(updated.includes('const versao = "2.0.0";'));

    // 2. Erro quando o alvo não existe
    await assert.rejects(
      async () => {
        await codeApplyPatchTool.execute({
          filePath: 'teste_patch.js',
          target: 'trecho_completamente_inexistente',
          replacement: 'novo'
        });
      },
      (err: Error) => err.message.includes('TARGET_NOT_FOUND')
    );
  } finally {
    if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  }
});

test('COD-04: git_status retorna branch e lista de modificações', async () => {
  assert.strictEqual(gitStatusTool.name, 'git_status');
  assert.strictEqual(gitStatusTool.riskLevel, 'R0');

  const res = await gitStatusTool.execute({ includeDiff: false });
  assert.strictEqual(res.simulated, false);
  assert.ok(typeof res.branch === 'string');
  assert.ok(typeof res.clean === 'boolean');
  assert.ok(Array.isArray(res.staged));
  assert.ok(Array.isArray(res.unstaged));
  assert.ok(Array.isArray(res.untracked));
});

test('COD-05: code_run_tests possui contrato de execução controlada', async () => {
  assert.strictEqual(codeRunTestsTool.name, 'code_run_tests');
  assert.strictEqual(codeRunTestsTool.riskLevel, 'R1');

  // Executa teste leve (ex: nosso próprio navigationParser test)
  const res = await codeRunTestsTool.execute({
    framework: 'npm',
    testPath: 'tests/navigationParser.test.ts',
    timeoutMs: 15000
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.simulated, false);
  assert.strictEqual(res.passed, true);
  assert.ok(typeof res.durationMs === 'number');
});

test('IOT-01: iot_list_devices lista atuadores e suporta filtro por categoria', async () => {
  assert.strictEqual(iotListDevicesTool.name, 'iot_list_devices');
  assert.strictEqual(iotListDevicesTool.riskLevel, 'R0');

  // 1. Lista todos os dispositivos
  const allRes = await iotListDevicesTool.execute({ category: 'all' });
  assert.strictEqual(allRes.simulated, false);
  assert.ok(allRes.count >= 3);
  assert.ok(allRes.devices.some((d: { type: string }) => d.type === 'gate'));

  // 2. Filtra por portão físico
  const gateRes = await iotListDevicesTool.execute({ category: 'gate' });
  assert.ok(gateRes.count >= 1);
  assert.ok(gateRes.devices.every((d: { type: string }) => d.type === 'gate'));
});

test('IOT-02: iot_send_command aciona portão com transição de estado e modo simulado transparente', async () => {
  assert.strictEqual(iotSendCommandTool.name, 'iot_send_command');
  assert.strictEqual(iotSendCommandTool.riskLevel, 'R2');

  // 1. Abrir portão principal — 'gate-main' é ATUADOR FÍSICO (isSimulated:false)
  // Sem credencial HA no cofre do ambiente de teste, o atuador é inalcançável:
  // BLINDAGEM DE SEGURANÇA FÍSICA — o comando deve FALHAR honestamente com o
  // estado PERMANECENDO (nunca 'abriu' fictício em portão real fechado).
  const openRes = await iotSendCommandTool.execute({
    deviceId: 'gate-main',
    command: 'open_gate'
  });

  if (!openRes.success) {
    assert.match(String(openRes.error), /ACTUATOR_UNREACHABLE/);
    assert.strictEqual(openRes.stateUnchanged, true, 'estado físico NÃO deve mudar em falha');
    assert.match(String(openRes.currentState), /CLOSED/, 'portão permanece fechado');
  } else {
    // Ambiente com hardware real conectado: transição válida
    assert.strictEqual(openRes.newState, 'OPEN');
  }

  // 2. Fechar portão principal — mesma lógica honesta da abertura
  const closeRes = await iotSendCommandTool.execute({
    deviceId: 'gate-main',
    command: 'close_gate'
  });

  if (!closeRes.success) {
    assert.match(String(closeRes.error), /ACTUATOR_UNREACHABLE/);
    assert.strictEqual(closeRes.stateUnchanged, true);
  } else {
    assert.strictEqual(closeRes.newState, 'CLOSED');
  }
});


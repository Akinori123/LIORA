/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — FASE 3: EXECUÇÃO ASSÍNCRONA E SUB-AGENTES (Background Workers)
 *
 * Gestor central de tarefas em segundo plano do processo Node:
 *  - Fila com concorrência limitada (máx N tarefas simultâneas)
 *  - Estados persistidos localmente (~/.liora/background/tasks.json)
 *  - Cancelamento seguro (AbortController + kill de child processes)
 *  - Eventos em tempo real via eventBus (frontend + canal Live)
 *
 * Tipos de tarefas suportadas:
 *  - 'shell'      : comando executável (whitelist do sandbox) — child process
 *  - 'file_scan'  : varredura profunda de diretório (contagem/indexação)
 *  - 'wait_test'  : tarefa sintética de teste (não usada em produção)
 *
 * Cada tarefa registra log incremental para consulta parcial em execução.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { eventBus } from '../utils/eventBus';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export type BackgroundTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type BackgroundTaskKind = 'shell' | 'file_scan' | 'wait_test';

export interface BackgroundTask {
  id: string;
  kind: BackgroundTaskKind;
  /** Título em linguagem natural exibido ao usuário */
  title: string;
  /** Parâmetros da tarefa (ex: command, dir, ms) */
  params: Record<string, any>;
  status: BackgroundTaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Rota de execução */
  exitCode?: number;
  result?: any;
  error?: string;
  /** Log incremental (últimas N linhas) */
  logs: string[];
  /** Percentual estimado de progresso (0-100) — quando aplicável */
  progress?: number;
}

const TASKS_FILE = path.join(os.homedir(), '.liora', 'background', 'tasks.json');
const MAX_CONCURRENT = 3;
const MAX_TASKS_HISTORY = 100;
const MAX_LOG_LINES = 200;
const TASK_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

class BackgroundWorkerManager {
  private tasks = new Map<string, BackgroundTask>();
  private processes = new Map<string, ChildProcess>();
  private abortControllers = new Map<string, AbortController>();
  private timers = new Map<string, NodeJS.Timeout>();
  private loaded = false;

  /** Garante carregamento lazy do histórico persistido */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (fs.existsSync(TASKS_FILE)) {
        const raw = fs.readFileSync(TASKS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const t of parsed) {
            // Tarefas 'running' no momento do desligamento são marcadas como failed
            // (processo não sobrevive a restart — honestidade de estado)
            if (t.status === 'running' || t.status === 'pending') {
              t.status = 'failed';
              t.error = t.error || 'INTERRUPTED: processo da LIORA reiniciou durante a execução.';
              t.finishedAt = t.finishedAt || new Date().toISOString();
            }
            this.tasks.set(t.id, t);
          }
        }
      }
    } catch (err) {
      console.warn('[BackgroundWorkers] Falha ao carregar histórico de tarefas:', err);
    }
  }

  private async persist(): Promise<void> {
    try {
      await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true });
      const list = Array.from(this.tasks.values()).slice(0, MAX_TASKS_HISTORY);
      const tmp = `${TASKS_FILE}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8');
      await fsp.rename(tmp, TASKS_FILE);
    } catch (err) {
      console.warn('[BackgroundWorkers] Falha ao persistir tarefas:', err);
    }
  }

  private log(taskId: string, line: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.logs.push(`[${new Date().toISOString()}] ${line}`);
    if (task.logs.length > MAX_LOG_LINES) {
      task.logs.splice(0, task.logs.length - MAX_LOG_LINES);
    }
  }

  private emit(taskId: string, event: 'started' | 'progress' | 'completed' | 'failed' | 'cancelled', extra: any = {}): void {
    const task = this.tasks.get(taskId);
    eventBus.publish('liora:background_task_event', {
      taskId,
      taskTitle: task?.title,
      kind: task?.kind,
      status: task?.status,
      event,
      ...extra,
      timestamp: new Date().toISOString()
    });
  }

  /** Poda histórico antigo mantendo o teto */
  private prune(): void {
    if (this.tasks.size <= MAX_TASKS_HISTORY) return;
    const sorted = Array.from(this.tasks.values())
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    for (const old of sorted.slice(MAX_TASKS_HISTORY)) {
      if (old.status === 'running' || old.status === 'pending') continue;
      this.tasks.delete(old.id);
    }
  }

  /** Enfileira uma nova tarefa */
  public async enqueue(
    kind: BackgroundTaskKind,
    title: string,
    params: Record<string, any>
  ): Promise<{ success: boolean; taskId?: string; error?: string }> {
    this.ensureLoaded();

    // Validação por tipo
    if (kind === 'shell') {
      const cmd = String(params.command || '').trim();
      if (!cmd) return { success: false, error: 'MISSING_COMMAND: informe o comando para a tarefa shell.' };
      // Whitelist do sandbox (mesma política do system_exec_sandbox)
      const ALLOWED = ['git', 'node', 'npm', 'cargo', 'tsc', 'echo', 'python'];
      const bin = cmd.split(/\s+/)[0];
      if (!ALLOWED.includes(bin)) {
        return { success: false, error: `COMMAND_NOT_IN_WHITELIST: binário '${bin}' não autorizado (permitidos: ${ALLOWED.join(', ')}).` };
      }
      if (/[;&|`$<>]/.test(cmd)) {
        return { success: false, error: 'COMMAND_INJECTION_BLOCKED: metacaracteres de shell não são permitidos.' };
      }
    }
    if (kind === 'file_scan') {
      const dir = String(params.dir || '').trim();
      if (!dir) return { success: false, error: 'MISSING_DIR: informe o diretório para a varredura.' };
    }

    const running = Array.from(this.tasks.values()).filter(t => t.status === 'running' || t.status === 'pending').length;
    if (running >= MAX_CONCURRENT) {
      return { success: false, error: `QUEUE_FULL: máximo de ${MAX_CONCURRENT} tarefas simultâneas. Cancele uma antes de iniciar outra.` };
    }

    const id = `btask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const task: BackgroundTask = {
      id,
      kind,
      title: title.slice(0, 120),
      params,
      status: 'pending',
      createdAt: new Date().toISOString(),
      logs: []
    };
    this.tasks.set(id, task);
    this.prune();
    await this.persist();

    this.log(id, `Tarefa enfileirada: ${title} (${kind})`);
    // Início assíncrono — não bloqueia o chamador
    setImmediate(() => void this.run(id));
    return { success: true, taskId: id };
  }

  /** Executa a tarefa (dispatcher interno) */
  private async run(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'pending') return;

    task.status = 'running';
    task.startedAt = new Date().toISOString();
    const controller = new AbortController();
    this.abortControllers.set(taskId, controller);
    this.emit(taskId, 'started', {});
    await this.persist();

    // Timeout global de segurança
    const timer = setTimeout(() => {
      this.log(taskId, `TIMEOUT: tarefa excedeu ${TASK_TIMEOUT_MS / 60000} min e foi interrompida.`);
      this.cancel(taskId, 'timeout').catch(() => { });
    }, TASK_TIMEOUT_MS);
    this.timers.set(taskId, timer);

    try {
      switch (task.kind) {
        case 'shell':
          await this.runShell(taskId, task, controller.signal);
          break;
        case 'file_scan':
          await this.runFileScan(taskId, task, controller.signal);
          break;
        case 'wait_test':
          await this.runWaitTest(taskId, task, controller.signal);
          break;
        default:
          throw new Error(`UNKNOWN_KIND: '${task.kind}'`);
      }
    } catch (err: any) {
      // O status pode ter sido alterado por cancel() concorrente — leitura dinâmica
      // com cast explícito (o TS estreita task.status para 'running' após a atribuição)
      const currentStatus: BackgroundTaskStatus | undefined = this.tasks.get(taskId)?.status as BackgroundTaskStatus | undefined;
      if (currentStatus === 'cancelled') {
        // cancel() já registrou o estado
      } else if (controller.signal.aborted) {
        task.status = 'cancelled';
        task.error = task.error || 'CANCELLED: interrompida via AbortController.';
        task.finishedAt = new Date().toISOString();
        this.emit(taskId, 'cancelled', {});
      } else {
        task.status = 'failed';
        task.error = String(err?.message || err || 'falha desconhecida').slice(0, 500);
        task.finishedAt = new Date().toISOString();
        this.log(taskId, `ERRO: ${task.error}`);
        this.emit(taskId, 'failed', { error: task.error });
      }
    } finally {
      this.timers.delete(taskId);
      clearTimeout(timer);
      this.processes.delete(taskId);
      this.abortControllers.delete(taskId);
      await this.persist();
    }
  }

  /** Tarefa: comando shell real (child process com stream de logs) */
  private async runShell(taskId: string, task: BackgroundTask, signal: AbortSignal): Promise<void> {
    const cmd = String(task.params.command);
    const cwd = String(task.params.cwd || path.join(os.homedir(), '.liora', 'workspace'));

    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, { shell: true, cwd, windowsHide: true, signal });
      this.processes.set(taskId, child);

      child.stdout?.on('data', (d) => this.log(taskId, String(d).trim().slice(0, 500)));
      child.stderr?.on('data', (d) => this.log(taskId, `STDERR: ${String(d).trim().slice(0, 500)}`));

      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        task.exitCode = code ?? -1;
        if (code === 0) {
          task.status = 'completed';
          task.result = { exitCode: 0, message: 'Comando concluído com sucesso.' };
        } else {
          task.status = 'failed';
          task.error = `EXIT_CODE_${code}: comando terminou com falha (verifique os logs).`;
        }
        task.finishedAt = new Date().toISOString();
        this.emit(taskId, task.status === 'completed' ? 'completed' : 'failed', { exitCode: task.exitCode });
        resolve();
      });
    });
  }

  /** Tarefa: varredura profunda de diretório (conta arquivos e soma tamanhos) */
  private async runFileScan(taskId: string, task: BackgroundTask, signal: AbortSignal): Promise<void> {
    const root = String(task.params.dir);
    if (!fs.existsSync(root)) throw new Error(`DIR_NOT_FOUND: '${root}' não existe.`);
    if (!fs.statSync(root).isDirectory()) throw new Error(`NOT_A_DIRECTORY: '${root}' não é um diretório.`);

    let files = 0, dirs = 0, totalBytes = 0;
    const stack: string[] = [root];
    let visited = 0;

    while (stack.length > 0) {
      if (signal.aborted) throw new Error('CANCELLED');
      const dir = stack.pop()!;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (signal.aborted) throw new Error('CANCELLED');
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { dirs++; stack.push(full); }
        else { files++; try { totalBytes += fs.statSync(full).size; } catch { /* ignore */ } }
        visited++;
        // Progresso incremental a cada 500 itens
        if (visited % 500 === 0) {
          task.progress = Math.min(95, Math.round((visited % 5000) / 50));
          this.log(taskId, `Varridos ${visited} itens... (${files} arquivos, ${dirs} pastas)`);
          this.emit(taskId, 'progress', { visited, files, dirs, totalBytes });
        }
      }
    }

    task.progress = 100;
    task.status = 'completed';
    task.result = { files, dirs, totalBytes, visited };
    task.finishedAt = new Date().toISOString();
    this.log(taskId, `Varredura concluída: ${files} arquivos, ${dirs} pastas, ${(totalBytes / 1024 / 1024).toFixed(1)} MB.`);
    this.emit(taskId, 'completed', { files, dirs, totalBytes });
  }

  /** Tarefa sintética de teste (dorme em incrementos, respeita cancelamento) */
  private async runWaitTest(taskId: string, task: BackgroundTask, signal: AbortSignal): Promise<void> {
    const ms = Math.max(100, Math.min(60000, task.params.ms || 1000));
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      if (signal.aborted) throw new Error('CANCELLED');
      await new Promise(r => setTimeout(r, ms / steps));
      task.progress = Math.round((i / steps) * 100);
      this.log(taskId, `passo ${i}/${steps} (${task.progress}%)`);
      this.emit(taskId, 'progress', { progress: task.progress });
    }
    task.status = 'completed';
    task.result = { sleptMs: ms };
    task.finishedAt = new Date().toISOString();
  }

  /** Cancela uma tarefa (seguro: mata processo e marca cancelled) */
  public async cancel(taskId: string, reason: string = 'solicitado pelo operador'): Promise<{ success: boolean; error?: string }> {
    this.ensureLoaded();
    const task = this.tasks.get(taskId);
    if (!task) return { success: false, error: `TASK_NOT_FOUND: '${taskId}' não existe.` };
    if (task.status !== 'running' && task.status !== 'pending') {
      return { success: false, error: `NOT_RUNNING: tarefa está '${task.status}' — não pode ser cancelada.` };
    }

    task.status = 'cancelled';
    task.error = `CANCELLED (${reason})`;
    task.finishedAt = new Date().toISOString();
    this.log(taskId, `CANCELADA: ${reason}`);

    // Mata o child process se existir
    const proc = this.processes.get(taskId);
    if (proc && proc.pid) {
      try {
        // Windows: taskkill na árvore; Unix: kill
        if (process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
        } else {
          proc.kill('SIGTERM');
        }
      } catch { /* ignore */ }
    }

    // Aborta timers/promessas internas
    this.abortControllers.get(taskId)?.abort();
    const timer = this.timers.get(taskId);
    if (timer) { clearTimeout(timer); this.timers.delete(taskId); }

    this.emit(taskId, 'cancelled', { reason });
    await this.persist();
    return { success: true };
  }

  /** Consulta estado e logs de uma tarefa */
  public getStatus(taskId: string): BackgroundTask | null {
    this.ensureLoaded();
    return this.tasks.get(taskId) || null;
  }

  /** Lista todas as tarefas (mais recentes primeiro) */
  public listTasks(limit: number = 20): BackgroundTask[] {
    this.ensureLoaded();
    return Array.from(this.tasks.values())
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }
}

/** Singleton global do gestor de background workers */
export const backgroundWorkerManager = new BackgroundWorkerManager();

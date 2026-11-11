/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — Módulo de Desenvolvimento & Código (Coding Agent)
 *
 * Ferramentas nativas seguras para inspeção, leitura com intervalos de linhas,
 * modificação controlada, status do Git e execução de testes.
 */

import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { ToolDefinition } from '../types';
import { getLioraWorkspaceRoot } from '../nativeServerTools';

/** Valida e resolve caminho seguro contra path traversal */
function resolveSafePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) throw new Error('INVALID_PATH: Caminho do arquivo não fornecido.');
  if (trimmed.includes('..') || path.isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    throw new Error('PATH_TRAVERSAL_BLOCKED: Apenas caminhos relativos ao workspace são permitidos.');
  }
  const root = getLioraWorkspaceRoot();
  const resolved = path.resolve(root, trimmed);
  if (!resolved.startsWith(root)) {
    throw new Error('PATH_TRAVERSAL_BLOCKED: O caminho resolvido escapou da raiz do workspace.');
  }
  return resolved;
}

/** Executa comando real via child_process com timeout e sem vazar processos */
function execCommand(cmd: string, timeoutMs: number, customCwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let cwd = customCwd;
  if (!cwd) {
    const ws = getLioraWorkspaceRoot();
    cwd = (fs.existsSync(ws) && (fs.existsSync(path.join(ws, 'package.json')) || fs.existsSync(path.join(ws, '.git'))))
      ? ws
      : process.cwd();
  }
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const exitCode = err && typeof (err as any).code === 'number' ? (err as any).code : (err ? 1 : 0);
      resolve({ stdout: stdout || '', stderr: stderr || '', exitCode });
    });
  });
}

/**
 * 1. code_search_symbols / code_grep (R0)
 * Busca rápida por funções, classes, variáveis ou termos em arquivos do projeto.
 */
export const codeSearchSymbolsTool: ToolDefinition<{
  query: string;
  fileExtension?: string;
  maxResults?: number;
}, any> = {
  name: 'code_search_symbols',
  description: 'Busca rápida por símbolos (funções, classes, variáveis) ou termos em arquivos de código do workspace. Risco R0.',
  category: 'workspace',
  riskLevel: 'R0',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Termo, símbolo ou expressão a ser pesquisada no código.'
      },
      fileExtension: {
        type: 'string',
        description: 'Filtro opcional por extensão (ex: ".ts", ".rs", ".tsx", ".py").'
      },
      maxResults: {
        type: 'number',
        description: 'Número máximo de ocorrências retornadas (padrão: 50, máx: 100).',
        default: 50
      }
    },
    required: ['query'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['matches', 'count', 'simulated']
  },
  execute: async ({ query, fileExtension, maxResults }) => {
    const root = getLioraWorkspaceRoot();
    if (!fs.existsSync(root)) {
      return { matches: [], count: 0, simulated: false };
    }

    const limit = Math.min(100, Math.max(1, maxResults || 50));
    const term = query.toLowerCase().trim();
    const extFilter = fileExtension ? fileExtension.toLowerCase().trim() : null;

    const matches: Array<{ file: string; line: number; text: string; symbolType?: string }> = [];

    const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'target', 'build', '.gemini', 'coverage']);

    function walk(dir: string, depth = 0) {
      if (depth > 8 || matches.length >= limit) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (matches.length >= limit) break;
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) {
            walk(path.join(dir, entry.name), depth + 1);
          }
          continue;
        }

        if (extFilter && !entry.name.toLowerCase().endsWith(extFilter)) {
          continue;
        }

        const fullPath = path.join(dir, entry.name);
        try {
          // Ignora arquivos maiores que 1MB
          const stat = fs.statSync(fullPath);
          if (stat.size > 1024 * 1024) continue;

          const content = fs.readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');
          const relPath = path.relative(root, fullPath).replace(/\\/g, '/');

          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= limit) break;
            const lineText = lines[i];
            if (lineText.toLowerCase().includes(term)) {
              let symbolType: string | undefined;
              if (/\b(function|fn|def)\b/.test(lineText)) symbolType = 'function';
              else if (/\b(class|struct|interface|type|enum)\b/.test(lineText)) symbolType = 'type';
              else if (/\b(const|let|var)\b/.test(lineText)) symbolType = 'variable';

              matches.push({
                file: relPath,
                line: i + 1,
                text: lineText.trim().slice(0, 200),
                symbolType
              });
            }
          }
        } catch {
          // Ignora arquivos binários ou ilegíveis
        }
      }
    }

    walk(root);

    return {
      matches,
      count: matches.length,
      simulated: false
    };
  }
};

/**
 * 2. code_read_file (R0)
 * Leitura controlada de arquivos de código com suporte a intervalos de linhas.
 */
export const codeReadFileTool: ToolDefinition<{
  filePath: string;
  startLine?: number;
  endLine?: number;
  maxLines?: number;
}, any> = {
  name: 'code_read_file',
  description: 'Leitura controlada de arquivos de código no workspace com suporte a intervalo de linhas específico (startLine e endLine). Risco R0.',
  category: 'workspace',
  riskLevel: 'R0',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Caminho relativo do arquivo de código no workspace.'
      },
      startLine: {
        type: 'number',
        description: 'Linha inicial de leitura (1-indexed, padrão: 1).',
        default: 1
      },
      endLine: {
        type: 'number',
        description: 'Linha final de leitura (inclusive).'
      },
      maxLines: {
        type: 'number',
        description: 'Máximo de linhas retornadas (padrão: 200, máx: 1000).',
        default: 200
      }
    },
    required: ['filePath'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['filePath', 'lines', 'totalLines', 'simulated']
  },
  execute: async ({ filePath, startLine = 1, endLine, maxLines = 200 }) => {
    const safePath = resolveSafePath(filePath);
    if (!fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
      throw new Error(`FILE_NOT_FOUND: Arquivo '${filePath}' não encontrado no workspace.`);
    }

    const content = fs.readFileSync(safePath, 'utf-8');
    const allLines = content.split('\n');
    const totalLines = allLines.length;

    const start = Math.max(1, startLine);
    if (endLine !== undefined && endLine < start) {
      throw new Error(`INVALID_RANGE: endLine (${endLine}) não pode ser menor que startLine (${start}).`);
    }
    const end = endLine ? Math.min(totalLines, endLine) : Math.min(totalLines, start + maxLines - 1);

    const sliced = allLines.slice(start - 1, end).map((text, idx) => ({
      line: start + idx,
      text
    }));

    return {
      filePath: filePath.trim().replace(/^[./\\]+/, ''),
      lines: sliced,
      startLine: start,
      endLine: end,
      totalLines,
      simulated: false
    };
  }
};

/**
 * 3. code_apply_patch / code_modify (R2)
 * Aplicação de alterações ou substituições estruturadas no código com validação e integridade.
 */
export const codeApplyPatchTool: ToolDefinition<{
  filePath: string;
  target: string;
  replacement: string;
  consentToken?: string;
}, any> = {
  name: 'code_apply_patch',
  description: 'Aplica uma alteração estruturada (substituição de bloco de código) em um arquivo do workspace. Risco R2 — requer confirmação explícita.',
  category: 'workspace',
  riskLevel: 'R2',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Caminho relativo do arquivo no workspace.'
      },
      target: {
        type: 'string',
        description: 'Texto exato a ser substituído no arquivo.'
      },
      replacement: {
        type: 'string',
        description: 'Novo texto que substituirá o alvo.'
      }
    },
    required: ['filePath', 'target', 'replacement'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['success', 'filePath', 'simulated']
  },
  execute: async ({ filePath, target, replacement }) => {
    const safePath = resolveSafePath(filePath);
    if (!fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
      throw new Error(`FILE_NOT_FOUND: O arquivo '${filePath}' não existe.`);
    }

    const content = fs.readFileSync(safePath, 'utf-8');
    if (!content.includes(target)) {
      throw new Error(`TARGET_NOT_FOUND: O trecho alvo não foi encontrado exatamente no arquivo '${filePath}'. Verifique indentação e quebras de linha.`);
    }

    const occurrences = content.split(target).length - 1;
    const updated = content.replace(target, replacement);

    // Gravação segura via arquivo temporário com limpeza no catch
    const tmpPath = `${safePath}.tmp.${Date.now()}`;
    try {
      fs.writeFileSync(tmpPath, updated, 'utf-8');
      fs.renameSync(tmpPath, safePath);
    } catch (writeErr) {
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
      throw writeErr;
    }

    return {
      success: true,
      filePath: filePath.trim().replace(/^[./\\]+/, ''),
      occurrencesReplaced: 1,
      totalOccurrencesFound: occurrences,
      simulated: false
    };
  }
};

/**
 * 4. git_status / git_diff (R0)
 * Verificação de status do repositório Git local, branches ativas e modificações.
 */
export const gitStatusTool: ToolDefinition<{
  includeDiff?: boolean;
  maxDiffLines?: number;
}, any> = {
  name: 'git_status',
  description: 'Verifica o status do repositório Git local (branches ativas, arquivos modificados, pendências). Risco R0.',
  category: 'workspace',
  riskLevel: 'R0',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      includeDiff: {
        type: 'boolean',
        description: 'Incluir resumo de git diff das alterações não comitadas (padrão: false).',
        default: false
      },
      maxDiffLines: {
        type: 'number',
        description: 'Número máximo de linhas de diff a retornar (padrão: 50).',
        default: 50
      }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['branch', 'clean', 'simulated']
  },
  execute: async ({ includeDiff = false, maxDiffLines = 50 }) => {
    const { stdout: statusOut, exitCode: statusExit } = await execCommand('git status --porcelain=v1 -b', 5000);
    if (statusExit !== 0) {
      return {
        branch: 'unknown',
        clean: true,
        staged: [],
        unstaged: [],
        untracked: [],
        isGitRepo: false,
        notice: 'O diretório atual não é um repositório Git ou o binário git não está disponível.',
        simulated: false
      };
    }

    const lines = statusOut.split('\n').filter(Boolean);
    const branchLine = lines[0] || '## unknown';
    const branchMatch = branchLine.match(/^##\s+([\w\d/._-]+)/);
    const branch = branchMatch ? branchMatch[1] : 'unknown';

    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const indexCode = line[0];
      const workCode = line[1];
      const file = line.slice(3).trim();

      if (indexCode === '?') {
        untracked.push(file);
      } else {
        if (indexCode && indexCode !== ' ') staged.push(`${indexCode} ${file}`);
        if (workCode && workCode !== ' ') unstaged.push(`${workCode} ${file}`);
      }
    }

    let diff: string | undefined;
    if (includeDiff && (staged.length > 0 || unstaged.length > 0)) {
      const { stdout: diffOut } = await execCommand('git diff --stat', 5000);
      diff = diffOut.split('\n').slice(0, maxDiffLines).join('\n');
    }

    const clean = staged.length === 0 && unstaged.length === 0 && untracked.length === 0;

    return {
      branch,
      clean,
      staged,
      unstaged,
      untracked,
      diff,
      isGitRepo: true,
      simulated: false
    };
  }
};

/**
 * 5. code_run_tests (R1)
 * Execução controlada de testes automatizados com retorno de log resumido.
 */
export const codeRunTestsTool: ToolDefinition<{
  framework?: 'npm' | 'cargo' | 'vitest' | 'auto';
  testPath?: string;
  timeoutMs?: number;
}, any> = {
  name: 'code_run_tests',
  description: 'Executa testes automatizados controlados (npm test, cargo test, etc.) e resume os resultados. Risco R1.',
  category: 'workspace',
  riskLevel: 'R1',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      framework: {
        type: 'string',
        enum: ['npm', 'cargo', 'vitest', 'auto'],
        description: 'Framework de testes a utilizar (padrão: auto).',
        default: 'auto'
      },
      testPath: {
        type: 'string',
        description: 'Caminho específico do arquivo de teste a executar (opcional).'
      },
      timeoutMs: {
        type: 'number',
        description: 'Timeout máximo em milissegundos (padrão: 30000).',
        default: 30000
      }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['success', 'passed', 'durationMs', 'simulated']
  },
  execute: async ({ framework = 'auto', testPath, timeoutMs = 30000 }) => {
    let cmd = 'npm test';

    if (framework === 'cargo') {
      cmd = testPath ? `cargo test --test ${testPath}` : 'cargo test';
    } else if (framework === 'vitest') {
      cmd = testPath ? `npx vitest run ${testPath}` : 'npx vitest run';
    } else if (testPath) {
      cmd = `npx tsx --test ${testPath}`;
    }

    const startTime = Date.now();
    const { stdout, stderr, exitCode } = await execCommand(cmd, timeoutMs);
    const durationMs = Date.now() - startTime;

    const passed = exitCode === 0;

    // Trunca a saída para evitar payloads imensos no LLM
    const truncatedStdout = stdout.length > 4000 ? `${stdout.slice(0, 4000)}\n... [saída truncada]` : stdout;
    const truncatedStderr = stderr.length > 2000 ? `${stderr.slice(0, 2000)}\n... [saída truncada]` : stderr;

    return {
      success: true,
      passed,
      exitCode,
      command: cmd,
      stdout: truncatedStdout,
      stderr: truncatedStderr,
      durationMs,
      simulated: false
    };
  }
};

export const allCodingTools: ToolDefinition<any, any>[] = [
  codeSearchSymbolsTool,
  codeReadFileTool,
  codeApplyPatchTool,
  gitStatusTool,
  codeRunTestsTool
];


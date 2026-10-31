/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolDefinition } from './types';

/**
 * Catálogo estrito de fixtures virtuais em memória para o preview da LIORA.
 * Nenhum arquivo do host ou disco físico é lido por esta ferramenta.
 */
export const VIRTUAL_WORKSPACE_CATALOG: Record<string, string> = {
  'docs/ROADMAP.md': `# ROADMAP.md (Fixture Virtual)

- [x] Fase 0: Reconhecimento e governança
- [x] Fase 1: Fundação de interface preto/branco/vermelho
- [x] Fase 2: LIORA CORE 3D
- [x] Fase 3: Chat textual e streaming SSE
- [x] Fase 4: Gestão de credenciais
- [ ] Fase 5: Voz em tempo real
- [ ] Fase 6: Planner, Tool Registry e Permission Engine (Marco 6.1.2)
- [ ] Fase 7: Ponte nativa Tauri e ferramentas de sistema local`,

  'metadata.json': `{\n  "name": "LIORA Core",\n  "version": "1.0.0",\n  "environment": "virtual-simulated-preview",\n  "sandbox": true\n}`,

  'workspace/config.json': `{\n  "platform": "LIORA Simulated Desktop",\n  "securityMode": "R0-R3 Protected",\n  "fixtures": true\n}`,

  'workspace/sample.txt': `LIORA Virtual Workspace Sample File.\nEsta é uma fixture simulada estritamente em memória no web preview.\nNenhum arquivo do host físico é acessado.`
};

/**
 * 1. system_info (R0: Leitura / Consulta)
 */
export const systemInfoTool: ToolDefinition<
  { detailLevel?: 'summary' | 'standard' | 'full' },
  any
> = {
  name: 'system_info',
  description: 'Retorna informações de hardware, sistema operacional e status de recursos simulados da LIORA.',
  category: 'system',
  riskLevel: 'R0',
  isSimulated: true,
  parameters: {
    type: 'object',
    properties: {
      detailLevel: {
        type: 'string',
        description: 'Nível de detalhamento das informações do sistema.',
        enum: ['summary', 'standard', 'full'],
        default: 'standard'
      }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    mustBeSimulated: true,
    requiredFields: ['os', 'platform', 'cpu', 'memory', 'simulated']
  },
  execute: async (params) => {
    const detail = params.detailLevel || 'standard';
    const uptime = 14 * 3600 + 22 * 60 + 45;

    return {
      os: 'LIORA Desktop OS (Ambiente Web Preview)',
      platform: 'linux-x86_64-simulated',
      arch: 'x86_64',
      uptimeSeconds: uptime,
      cpu: {
        cores: 8,
        model: 'Neural Processing Core v3 (Simulado)',
        usagePercent: detail === 'summary' ? 12.5 : 18.4
      },
      memory: {
        totalBytes: 16 * 1024 * 1024 * 1024,
        freeBytes: 10.4 * 1024 * 1024 * 1024,
        usagePercent: 35.0
      },
      battery: detail !== 'summary' ? {
        level: 96,
        charging: true
      } : undefined,
      simulated: true,
      mode: 'SIMULATED_PREVIEW',
      notice: 'Ambiente simulado no web preview da LIORA conforme diretrizes de AGENTS.md (Regra 4).'
    };
  }
};

/**
 * 2. workspace_read_file (R0: Leitura / Consulta)
 */
export const workspaceReadFileTool: ToolDefinition<
  { filePath: string; maxLines?: number },
  any
> = {
  name: 'workspace_read_file',
  description: 'Lê fixtures textuais virtuais em memória do catálogo seguro da LIORA (Zero acesso ao disco real).',
  category: 'workspace',
  riskLevel: 'R0',
  isSimulated: true,
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Caminho virtual da fixture (ex: "docs/ROADMAP.md", "metadata.json", "workspace/sample.txt").',
        minLength: 1,
        maxLength: 256
      },
      maxLines: {
        type: 'number',
        description: 'Número máximo de linhas a serem retornadas.',
        minimum: 1,
        maximum: 1000,
        default: 100
      }
    },
    required: ['filePath'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    mustBeSimulated: true,
    requiredFields: ['filePath', 'content', 'lineCount', 'sizeBytes', 'simulated']
  },
  execute: async (params) => {
    const rawPath = params.filePath;
    const maxLines = params.maxLines || 100;
    const normalized = rawPath.trim().replace(/^[./\\]+/, '');

    const virtualContent = VIRTUAL_WORKSPACE_CATALOG[normalized];
    if (typeof virtualContent !== 'string') {
      throw new Error(`Arquivo virtual '${rawPath}' não encontrado no catálogo seguro de demonstração.`);
    }

    const lines = virtualContent.split('\n');
    const truncated = lines.length > maxLines;
    const finalLines = lines.slice(0, maxLines);
    const sizeBytes = Buffer.byteLength(virtualContent, 'utf-8');

    return {
      filePath: normalized,
      content: finalLines.join('\n'),
      lineCount: finalLines.length,
      sizeBytes,
      truncated,
      simulated: true
    };
  }
};

/**
 * 3. system_exec_simulated (R1: Reversível e Local)
 */
export const systemExecSimulatedTool: ToolDefinition<
  { command: string; timeoutMs?: number },
  any
> = {
  name: 'system_exec_simulated',
  description: 'Simula a execução de um comando CLI seguro no ambiente isolado (R1: Reversível e Local).',
  category: 'system',
  riskLevel: 'R1',
  isSimulated: true,
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Comando a ser simulado (ex: "git status", "node -v", "uptime").',
        minLength: 1,
        maxLength: 500
      },
      timeoutMs: {
        type: 'number',
        description: 'Tempo limite simulado em milissegundos.',
        minimum: 100,
        maximum: 30000,
        default: 5000
      }
    },
    required: ['command'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    mustBeSimulated: true,
    requiredFields: ['command', 'exitCode', 'stdout', 'simulated', 'sandbox']
  },
  execute: async (params) => {
    const cmd = params.command.trim();
    let stdout = '';
    const stderr = '';
    const exitCode = 0;
    const durationMs = 15;

    if (cmd.startsWith('git status')) {
      stdout = 'On branch main\nYour branch is up to date with \'origin/main\'.\n\nnothing to commit, working tree clean (simulated)';
    } else if (cmd.startsWith('git branch')) {
      stdout = '* main\n  feature/tool-registry-fase6';
    } else if (cmd.startsWith('node -v') || cmd.startsWith('node --version')) {
      stdout = 'v22.14.0 (simulated)';
    } else if (cmd.startsWith('uptime')) {
      stdout = ' 16:55:00 up 14:22,  1 user,  load average: 0.18, 0.22, 0.15';
    } else if (cmd.startsWith('echo')) {
      stdout = cmd.replace(/^echo\s+/, '').replace(/["']/g, '');
    } else if (cmd.startsWith('ls')) {
      stdout = 'docs/  metadata.json  workspace/';
    } else {
      stdout = `[LIORA-SIMULATED-SHELL] Comando simulado com sucesso: '${cmd}'\nModo: Sandbox Seguro R1\nNenhuma alteração real foi feita no host físico.`;
    }

    return {
      command: cmd,
      exitCode,
      stdout,
      stderr,
      durationMs,
      simulated: true,
      sandbox: 'LIORA-SIMULATED-SHELL'
    };
  }
};

/**
 * 4. workspace_write_file (R1: Modificação Controlada de Arquivo Virtual)
 * Escreve ou modifica arquivos estritamente dentro do workspace virtual em memória.
 * Rejeita path traversal (../) ou tentativas de escapar do workspace.
 */
export const workspaceWriteFileTool: ToolDefinition<
  { filePath: string; content: string; createDirs?: boolean },
  any
> = {
  name: 'workspace_write_file',
  description: 'Escreve ou modifica arquivos estritamente dentro do workspace virtual em memória (R1).',
  category: 'workspace',
  riskLevel: 'R1',
  isSimulated: true,
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Caminho relativo do arquivo no workspace (ex: "workspace/notes.txt").',
        minLength: 1,
        maxLength: 256
      },
      content: {
        type: 'string',
        description: 'Conteúdo de texto a ser gravado.',
        maxLength: 50000
      },
      createDirs: {
        type: 'boolean',
        description: 'Criar diretórios pai se não existirem.',
        default: false
      }
    },
    required: ['filePath', 'content'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    mustBeSimulated: true,
    requiredFields: ['success', 'filePath', 'bytesWritten', 'simulated']
  },
  execute: async (params) => {
    const rawPath = params.filePath.trim();
    const content = params.content;

    // Verificação estrita contra Path Traversal
    if (rawPath.includes('..') || rawPath.startsWith('/') || rawPath.includes(':\\')) {
      throw new Error('PATH_TRAVERSAL_BLOCKED: Tentativa de acesso a caminho absoluto ou fora do workspace virtual.');
    }

    const normalized = rawPath.replace(/^[./\\]+/, '');
    if (!normalized) {
      throw new Error('INVALID_PATH: Caminho de arquivo inválido.');
    }

    // Gravar no catálogo virtual em memória
    VIRTUAL_WORKSPACE_CATALOG[normalized] = content;
    const bytesWritten = Buffer.byteLength(content, 'utf-8');

    return {
      success: true,
      filePath: normalized,
      bytesWritten,
      simulated: true,
      timestamp: new Date().toISOString()
    };
  }
};

/**
 * 5. system_exec_sandbox (R1: Execução Isolada de CLI com Lista Branca)
 * Executa comandos CLI permitidos em lista branca estrita, bloqueando injeção de comandos.
 */
export const systemExecSandboxTool: ToolDefinition<
  { command: string; timeoutMs?: number },
  any
> = {
  name: 'system_exec_sandbox',
  description: 'Executa comandos CLI permitidos em lista branca estrita no sandbox R1.',
  category: 'system',
  riskLevel: 'R1',
  isSimulated: true,
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Comando CLI (ex: "git status", "npm test", "python --version", "node -v").',
        minLength: 1,
        maxLength: 200
      },
      timeoutMs: {
        type: 'number',
        description: 'Timeout máximo em milissegundos.',
        minimum: 100,
        maximum: 10000,
        default: 5000
      }
    },
    required: ['command'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    mustBeSimulated: true,
    requiredFields: ['success', 'command', 'stdout', 'exitCode', 'simulated']
  },
  execute: async (params) => {
    const cmd = params.command.trim();

    // Verificação de Injeção de Comandos (caracteres perigosos)
    const dangerousPattern = /[;&|`$<>\\()\n]/;
    if (dangerousPattern.test(cmd)) {
      throw new Error('COMMAND_INJECTION_BLOCKED: Caracteres de encadeamento ou injeção detectados e bloqueados.');
    }

    // Lista branca estrita de prefixos permitidos
    const allowedPrefixes = [
      'git status',
      'git branch',
      'npm test',
      'npm run build',
      'python --version',
      'node -v',
      'node --version',
      'uptime',
      'ls'
    ];

    const isAllowed = allowedPrefixes.some(prefix => cmd === prefix || cmd.startsWith(prefix + ' '));
    if (!isAllowed) {
      throw new Error(`COMMAND_NOT_IN_WHITELIST: O comando '${cmd}' não faz parte da lista branca autorizada para execução no sandbox R1.`);
    }

    let stdout = '';
    if (cmd.startsWith('git status')) {
      stdout = 'On branch main\nworking tree clean (sandboxed)';
    } else if (cmd.startsWith('git branch')) {
      stdout = '* main';
    } else if (cmd.startsWith('npm test')) {
      stdout = '94 tests passed successfully in sandboxed CLI.';
    } else if (cmd.startsWith('npm run build')) {
      stdout = 'vite build completed successfully (sandboxed).';
    } else if (cmd.startsWith('python --version')) {
      stdout = 'Python 3.11.4 (sandboxed)';
    } else if (cmd.startsWith('node --version') || cmd.startsWith('node -v')) {
      stdout = 'v22.14.0 (sandboxed)';
    } else if (cmd.startsWith('uptime')) {
      stdout = 'up 5 days, sandboxed';
    } else if (cmd.startsWith('ls')) {
      stdout = 'docs/ metadata.json workspace/';
    }

    return {
      success: true,
      command: cmd,
      stdout,
      stderr: '',
      exitCode: 0,
      simulated: true,
      sandbox: 'LIORA-SECURE-SANDBOX'
    };
  }
};

/**
 * 6. system_read_env_safe (R0: Leitura Higienizada de Variáveis de Ambiente)
 * Lê variáveis de ambiente filtrando automaticamente chaves sensíveis (API keys, secrets, tokens).
 */
export const systemReadEnvSafeTool: ToolDefinition<
  { variableName?: string; keys?: string[] },
  any
> = {
  name: 'system_read_env_safe',
  description: 'Lê variáveis de ambiente do sistema com mascaramento automático de segredos (R0).',
  category: 'system',
  riskLevel: 'R0',
  isSimulated: true,
  parameters: {
    type: 'object',
    properties: {
      variableName: {
        type: 'string',
        description: 'Nome da variável de ambiente (ex: "NODE_ENV", "PUBLIC_VERSION").',
        minLength: 1,
        maxLength: 100
      },
      keys: {
        type: 'array',
        items: { type: 'string' },
        description: 'Lista de chaves de variáveis permitidas a serem consultadas.'
      }
    },
    required: [],
    additionalProperties: true
  },
  outputSchema: {
    type: 'object',
    mustBeSimulated: true,
    requiredFields: ['success', 'variableName', 'value', 'simulated']
  },
  execute: async (params: any = {}) => {
    let rawKey = params?.variableName;
    if (!rawKey && Array.isArray(params?.keys) && params.keys.length > 0) {
      rawKey = params.keys[0];
    }
    const varName = (rawKey || 'NODE_ENV').trim();

    // Verificação de Padrões Sensíveis
    const sensitiveKeywords = ['KEY', 'SECRET', 'PASSWORD', 'TOKEN', 'AUTH', 'PRIVATE', 'API', 'CREDENTIAL'];
    const upperName = varName.toUpperCase();
    const isSensitive = sensitiveKeywords.some(kw => upperName.includes(kw));

    if (isSensitive) {
      throw new Error('SECRET_LEAK_PREVENTED: Tentativa de leitura de variável de ambiente sensível bloqueada por segurança.');
    }

    // Leitura simulada ou de process.env seguro
    let value = (typeof process !== 'undefined' && process.env) ? process.env[varName] || '' : '';
    if (!value && varName === 'NODE_ENV') {
      value = 'development';
    } else if (!value) {
      value = '[UNSET_OR_DEFAULT]';
    }

    return {
      success: true,
      variableName: varName,
      value,
      simulated: true,
      timestamp: new Date().toISOString()
    };
  }
};

/**
 * 7. navigateToTab (R0: Controle de Interface e Navegação)
 */
export const navigateToTabTool: ToolDefinition<
  { tab: string },
  any
> = {
  name: 'navigateToTab',
  description: "Navega instantaneamente para qualquer aba da interface do LIORA. Abas válidas: 'home', 'conversation', 'activity', 'automations', 'integrations', 'devices', 'memory', 'developer', 'settings'.",
  category: 'system',
  riskLevel: 'R0',
  isSimulated: true,
  parameters: {
    type: 'object',
    properties: {
      tab: {
        type: 'string',
        description: "Aba para qual navegar.",
        enum: ['home', 'conversation', 'activity', 'automations', 'integrations', 'devices', 'memory', 'developer', 'settings']
      }
    },
    required: ['tab'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['success', 'activeTab']
  },
  execute: async (params) => {
    return {
      success: true,
      activeTab: params.tab,
      message: `Navegado para a aba '${params.tab}'.`
    };
  }
};

/**
 * 8. openSettings (R0: Atalho de Configurações)
 */
export const openSettingsTool: ToolDefinition<
  { section?: string },
  any
> = {
  name: 'openSettings',
  description: 'Abre diretamente a aba de Configurações do sistema LIORA.',
  category: 'system',
  riskLevel: 'R0',
  isSimulated: true,
  parameters: {
    type: 'object',
    properties: {
      section: {
        type: 'string',
        description: 'Seção específica das configurações.'
      }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['success', 'activeTab']
  },
  execute: async () => {
    return {
      success: true,
      activeTab: 'settings',
      message: "Navegado para a aba 'settings'."
    };
  }
};

/**
 * 9. triggerAutomation (R1: Execução de Automação)
 */
export const triggerAutomationTool: ToolDefinition<
  { ruleId: string },
  any
> = {
  name: 'triggerAutomation',
  description: 'Executa uma regra de automação no motor de automações do LIORA.',
  category: 'automation',
  riskLevel: 'R1',
  isSimulated: true,
  parameters: {
    type: 'object',
    properties: {
      ruleId: {
        type: 'string',
        description: 'ID da regra de automação a ser executada.'
      }
    },
    required: ['ruleId'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['success', 'ruleId']
  },
  execute: async (params) => {
    return {
      success: true,
      ruleId: params.ruleId,
      message: `Automação '${params.ruleId}' disparada.`
    };
  }
};

/**
 * 10. getSystemStatus (R0: Status do Sistema)
 */
export const getSystemStatusTool: ToolDefinition<
  Record<string, never>,
  any
> = {
  name: 'getSystemStatus',
  description: 'Retorna o status consolidado do sistema LIORA, abas, mic e serviços.',
  category: 'system',
  riskLevel: 'R0',
  isSimulated: true,
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['status', 'ready']
  },
  execute: async () => {
    return {
      status: 'OPERATIONAL',
      ready: true,
      message: 'LIORA Core operacional em ambiente seguro.'
    };
  }
};

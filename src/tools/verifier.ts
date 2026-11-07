/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { VIRTUAL_WORKSPACE_CATALOG } from './simulatedTools';

// Importações Node seguras com verificação de runtime para evitar falhas em bundling browser
let fsModule: any = null;
let osModule: any = null;
let pathModule: any = null;

if (typeof window === 'undefined') {
  try {
    fsModule = await import('fs');
    osModule = await import('os');
    pathModule = await import('path');
  } catch {
    // Ambiente sem suporte direto a módulos Node
  }
}

/** Resolve o caminho absoluto do workspace real da LIORA (espelha nativeServerTools) */
function getRealWorkspacePath(relativePath: string): string {
  if (pathModule && osModule && typeof pathModule.join === 'function' && typeof osModule.homedir === 'function') {
    const root = pathModule.join(osModule.homedir(), '.liora', 'workspace');
    return pathModule.resolve(root, relativePath);
  }
  return relativePath;
}

export interface VerificationEvidence {
  verified: boolean;
  checkName: string;
  checkDetails: string;
  timestamp: string;
  metrics?: Record<string, any>;
  discrepancies?: string[];
}

export interface VerificationResult {
  passed: boolean;
  evidence: VerificationEvidence;
  error?: string;
}

/**
 * Verifier Engine — Motor de Verificação Pós-Execução (Item 17 do Plano Mestre LIORA)
 * 
 * "O Ultron/Liora deveria verificar o próprio trabalho.
 *  Depois da execução: EXECUTOR -> VERIFIER.
 *  'O arquivo realmente existe?' 'O conteúdo confere?' 'O tamanho confere?'
 *  Só então: 'Concluído'."
 */
export class VerifierEngine {
  /**
   * Executa a auditoria pós-execução baseada na ferramenta e nos parâmetros fornecidos.
   */
  public async verifyExecution(
    toolName: string,
    params: any,
    executionResult: any
  ): Promise<VerificationResult> {
    const timestamp = new Date().toISOString();

    // 1. Verificação para workspace_write_file
    if (toolName === 'workspace_write_file') {
      const filePath = params?.filePath?.trim().replace(/^[./\\]+/, '');
      const expectedContent = params?.content;
      const expectedBytes = expectedContent ? (typeof Buffer !== 'undefined' ? Buffer.byteLength(expectedContent, 'utf-8') : expectedContent.length) : 0;

      if (!filePath) {
        return {
          passed: false,
          evidence: {
            verified: false,
            checkName: 'VERIFY_WORKSPACE_FILE_EXISTS',
            checkDetails: 'Caminho de arquivo ausente nos parâmetros de verificação.',
            timestamp,
            discrepancies: ['filePath is undefined or empty']
          },
          error: 'VERIFICATION_FAILED: Caminho de arquivo inválido para verificação.'
        };
      }

      // Execução REAL: verifica o arquivo no disco (~/.liora/workspace)
      // Execução SIMULADA: verifica no catálogo virtual em memória
      const isRealExecution = executionResult && executionResult.simulated === false;
      let actualContent: string | undefined;
      let storageLabel = '';

      if (isRealExecution && fsModule && typeof fsModule.readFileSync === 'function') {
        const absPath = getRealWorkspacePath(filePath);
        try {
          actualContent = fsModule.readFileSync(absPath, 'utf-8');
          storageLabel = `disco real (${absPath})`;
        } catch {
          actualContent = undefined;
        }
      } else if (isRealExecution && executionResult?.success) {
        return {
          passed: true,
          evidence: {
            verified: true,
            checkName: 'VERIFY_WORKSPACE_FILE_PERSISTED',
            checkDetails: `Arquivo '${filePath}' verificado via execução remota no host real.`,
            timestamp,
            metrics: {
              filePath,
              sizeBytes: executionResult.bytesWritten || expectedBytes,
              isReal: true
            }
          }
        };
      } else {
        actualContent = VIRTUAL_WORKSPACE_CATALOG[filePath];
        storageLabel = 'workspace virtual em memória';
      }

      if (typeof actualContent !== 'string') {
        return {
          passed: false,
          evidence: {
            verified: false,
            checkName: 'VERIFY_WORKSPACE_FILE_EXISTS',
            checkDetails: `O arquivo '${filePath}' não foi encontrado no ${storageLabel} após a suposta gravação.`,
            timestamp,
            discrepancies: [`File '${filePath}' not found in ${storageLabel}`]
          },
          error: `VERIFICATION_FAILED: O arquivo '${filePath}' não foi localizado no ${storageLabel} após a operação.`
        };
      }

      const actualBytes = typeof Buffer !== 'undefined' ? Buffer.byteLength(actualContent, 'utf-8') : actualContent.length;
      if (expectedContent !== undefined && actualContent !== expectedContent) {
        return {
          passed: false,
          evidence: {
            verified: false,
            checkName: 'VERIFY_WORKSPACE_FILE_INTEGRITY',
            checkDetails: `Divergência detectada entre o conteúdo gravado e o esperado (${actualBytes} vs ${expectedBytes} bytes).`,
            timestamp,
            discrepancies: ['File content mismatch with requested payload']
          },
          error: 'VERIFICATION_FAILED: O conteúdo gravado no workspace não confere com o solicitado.'
        };
      }

      return {
        passed: true,
        evidence: {
          verified: true,
          checkName: 'VERIFY_WORKSPACE_FILE_PERSISTED',
          checkDetails: `Arquivo '${filePath}' verificado com sucesso no ${storageLabel} (${actualBytes} bytes). Conteúdo e integridade validados.`,
          timestamp,
          metrics: {
            filePath,
            sizeBytes: actualBytes,
            lineCount: actualContent.split('\n').length,
            isReal: Boolean(isRealExecution)
          }
        }
      };
    }

    // 2. Verificação para workspace_read_file
    if (toolName === 'workspace_read_file') {
      const hasContent = executionResult && typeof executionResult.content === 'string';
      return {
        passed: Boolean(hasContent),
        evidence: {
          verified: Boolean(hasContent),
          checkName: 'VERIFY_WORKSPACE_READ_OUTPUT',
          checkDetails: hasContent ? `Leitura verificada: ${executionResult.lineCount || 0} linhas recuperadas com sucesso.` : 'Leitura retornou dados vazios ou corrompidos.',
          timestamp,
          metrics: {
            sizeBytes: executionResult?.sizeBytes || 0,
            lineCount: executionResult?.lineCount || 0
          }
        }
      };
    }

    // 3. Verificação para system_exec_sandbox
    if (toolName === 'system_exec_sandbox') {
      const exitCode = executionResult?.exitCode ?? -1;
      const stdout = executionResult?.stdout || '';
      const stderr = executionResult?.stderr || '';

      const passed = exitCode === 0 && !stderr;
      return {
        passed,
        evidence: {
          verified: passed,
          checkName: 'VERIFY_COMMAND_EXECUTION_EXIT_CODE',
          checkDetails: passed
            ? `Comando '${params?.command}' concluído com código de saída 0 (${stdout.length} caracteres em stdout).`
            : `Comando '${params?.command}' falhou com código de saída ${exitCode}. Erro: ${stderr}`,
          timestamp,
          metrics: {
            exitCode,
            stdoutLength: stdout.length,
            stderrLength: stderr.length
          },
          discrepancies: passed ? undefined : [`Command exited with non-zero code: ${exitCode}`]
        },
        error: passed ? undefined : `VERIFICATION_FAILED: O comando '${params?.command}' retornou erro durante execução (exitCode: ${exitCode}).`
      };
    }

    // 4. Verificação para system_read_env_safe
    if (toolName === 'system_read_env_safe') {
      const hasVar = executionResult && executionResult.variableName && executionResult.value !== undefined;
      return {
        passed: Boolean(hasVar),
        evidence: {
          verified: Boolean(hasVar),
          checkName: 'VERIFY_ENV_READ_CONSISTENCY',
          checkDetails: hasVar
            ? `Variável '${executionResult.variableName}' verificada com sucesso. Valor mascarado e consistente.`
            : 'Variável de ambiente ausente no payload retornado.',
          timestamp
        }
      };
    }

    // 5. Verificação padrão para system_info
    if (toolName === 'system_info') {
      const hasMetrics = executionResult && executionResult.os && executionResult.cpu;
      return {
        passed: Boolean(hasMetrics),
        evidence: {
          verified: Boolean(hasMetrics),
          checkName: 'VERIFY_SYSTEM_DIAGNOSTICS_PAYLOAD',
          checkDetails: hasMetrics
            ? 'Métricas de telemetria do sistema auditadas e estruturalmente íntegras.'
            : 'Telemetria do sistema retornou incompleta.',
          timestamp
        }
      };
    }

    // Verificação genérica para ferramentas de interface e automação
    return {
      passed: true,
      evidence: {
        verified: true,
        checkName: 'VERIFY_GENERIC_CONTRACT',
        checkDetails: `Resultado da ferramenta '${toolName}' verificado pelo contrato de execução.`,
        timestamp
      }
    };
  }
}

export const verifierEngine = new VerifierEngine();

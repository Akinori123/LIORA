/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface CodeFileSample {
  path: string;
  language: string;
  sizeBytes: number;
  originalContent: string;
  modifiedContent: string;
  description: string;
}

export interface ReaInspectionTarget {
  id: string;
  name: string;
  targetType: 'binary' | 'library' | 'script' | 'manifest';
  path: string;
  architecture: string;
  securityVerdict: 'CLEAN' | 'NEEDS_REVIEW' | 'SUSPICIOUS';
  symbolsFound: number;
  dependencies: string[];
  permissionsRequested: string[];
  analysisNotes: string;
}

/**
 * Calcula um diff unificado linha a linha de forma puramente determinística
 */
export function computeUnifiedDiff(original: string, modified: string): DiffLine[] {
  if (original === modified) {
    if (!original) return [];
    return original.split('\n').map((content, idx) => ({
      type: 'unchanged',
      content,
      oldLineNumber: idx + 1,
      newLineNumber: idx + 1
    }));
  }

  if (!original) {
    return modified.split('\n').map((content, idx) => ({
      type: 'added',
      content,
      newLineNumber: idx + 1
    }));
  }

  if (!modified) {
    return original.split('\n').map((content, idx) => ({
      type: 'removed',
      content,
      oldLineNumber: idx + 1
    }));
  }

  const oldLines = original.split('\n');
  const newLines = modified.split('\n');
  const result: DiffLine[] = [];

  let oldIdx = 0;
  let newIdx = 0;

  while (oldIdx < oldLines.length || newIdx < newLines.length) {
    const oldLine = oldLines[oldIdx];
    const newLine = newLines[newIdx];

    if (oldIdx < oldLines.length && newIdx < newLines.length) {
      if (oldLine === newLine) {
        result.push({
          type: 'unchanged',
          content: oldLine,
          oldLineNumber: oldIdx + 1,
          newLineNumber: newIdx + 1
        });
        oldIdx++;
        newIdx++;
      } else {
        // Encontra se a linha antiga foi removida ou a nova foi adicionada
        const nextMatchInNew = newLines.indexOf(oldLine, newIdx);
        const nextMatchInOld = oldLines.indexOf(newLine, oldIdx);

        if (nextMatchInNew !== -1 && (nextMatchInOld === -1 || nextMatchInNew - newIdx <= nextMatchInOld - oldIdx)) {
          // Linhas adicionadas no novo arquivo
          while (newIdx < nextMatchInNew) {
            result.push({
              type: 'added',
              content: newLines[newIdx],
              newLineNumber: newIdx + 1
            });
            newIdx++;
          }
        } else {
          // Linha removida do arquivo original
          result.push({
            type: 'removed',
            content: oldLine,
            oldLineNumber: oldIdx + 1
          });
          oldIdx++;
        }
      }
    } else if (oldIdx < oldLines.length) {
      result.push({
        type: 'removed',
        content: oldLines[oldIdx],
        oldLineNumber: oldIdx + 1
      });
      oldIdx++;
    } else if (newIdx < newLines.length) {
      result.push({
        type: 'added',
        content: newLines[newIdx],
        newLineNumber: newIdx + 1
      });
      newIdx++;
    }
  }

  return result;
}

/**
 * Catálogo de arquivos de código da LIORA disponíveis para inspeção e testes de diff
 */
export const SAMPLE_CODE_FILES: CodeFileSample[] = [
  {
    path: 'src/tools/verifier.ts',
    language: 'typescript',
    sizeBytes: 4620,
    description: 'Motor de verificação pós-execução (Item 17 do Plano Mestre)',
    originalContent: `// Versão 1.0 - Execução sem verificação
export class VerifierEngine {
  public async verifyExecution(toolName: string, params: any, result: any) {
    return { passed: true, evidence: { verified: true } };
  }
}`,
    modifiedContent: `// Versão 2.0 - Auditoria rigorosa com verificação de arquivos e hashes
export class VerifierEngine {
  public async verifyExecution(toolName: string, params: any, result: any) {
    if (toolName === 'workspace_write_file') {
      const exists = VIRTUAL_WORKSPACE_CATALOG[params.filePath];
      if (!exists) return { passed: false, error: 'FILE_NOT_FOUND' };
    }
    return { passed: true, evidence: { verified: true } };
  }
}`
  },
  {
    path: 'src-tauri/src/main.rs',
    language: 'rust',
    sizeBytes: 3120,
    description: 'Ponte IPC nativa Rust para comandos de sistema operacional',
    originalContent: `// Versão Inicial - Stubs
#[tauri::command]
fn get_system_metrics() -> String {
    "{\\"cpu\\": 24.5, \\"ram\\": 62}".to_string()
}`,
    modifiedContent: `// Versão com Validação de Risco e Sandbox
#[tauri::command]
fn get_system_metrics() -> Result<SystemMetrics, String> {
    let metrics = sys_info::probe()?;
    security_guard::audit_call("get_system_metrics", RiskLevel::R0);
    Ok(metrics)
}`
  },
  {
    path: 'src/security/permissionEngine.ts',
    language: 'typescript',
    sizeBytes: 14200,
    description: 'Motor de autorização analítica de risco R0–R3 (Zero Trust)',
    originalContent: `export class PermissionEngine {
  public evaluate(tool: string) {
    return { decision: 'ALLOW', riskLevel: 'R0' };
  }
}`,
    modifiedContent: `export class PermissionEngine {
  public evaluate(tool: string, params: any, context: SecurityRequestContext) {
    if (this.activeProfile.deniedTools.includes(tool)) {
      return { decision: 'DENY', code: 'TOOL_EXPLICITLY_DENIED' };
    }
    const hash = computeParametersHash(params);
    return { decision: 'ALLOW', riskLevel: 'R0', parametersHash: hash };
  }
}`
  }
];

/**
 * Alvos de inspeção para a ferramenta REA (Reverse Engineer Anything)
 */
export const SAMPLE_REA_TARGETS: ReaInspectionTarget[] = [
  {
    id: 'rea-1',
    name: 'liora-core-desktop.exe',
    targetType: 'binary',
    path: 'target/release/liora-core-desktop.exe',
    architecture: 'x86_64-pc-windows-msvc',
    securityVerdict: 'CLEAN',
    symbolsFound: 842,
    dependencies: ['tauri-core', 'serde_json', 'tokio-runtime', 'windows-sys'],
    permissionsRequested: ['PROCESS_QUERY_LIMITED_INFORMATION', 'LOCAL_STORAGE_READ_WRITE'],
    analysisNotes: 'Assinatura digital válida. Nenhum export suspeito ou injeção de DLL detectada. Modo sandboxed ativo.'
  },
  {
    id: 'rea-2',
    name: 'audio_meter_bridge.node',
    targetType: 'library',
    path: 'native/addons/audio_meter_bridge.node',
    architecture: 'x86_64-win32-cdecl',
    securityVerdict: 'CLEAN',
    symbolsFound: 156,
    dependencies: ['winmm.dll', 'kernel32.dll', 'user32.dll'],
    permissionsRequested: ['RECORD_AUDIO_RMS', 'HIGH_RESOLUTION_TIMER'],
    analysisNotes: 'Driver de leitura de nível de áudio (VU meter) estritamente local sem conexões de rede ativas.'
  },
  {
    id: 'rea-3',
    name: 'device_agent_listener.py',
    targetType: 'script',
    path: 'scripts/integrations/device_agent_listener.py',
    architecture: 'python3-bytecode',
    securityVerdict: 'NEEDS_REVIEW',
    symbolsFound: 64,
    dependencies: ['websockets', 'cryptography', 'aiohttp'],
    permissionsRequested: ['LOCAL_NETWORK_BROADCAST', 'WAKE_ON_LAN_MAGIC_PACKET'],
    analysisNotes: 'Módulo de comunicação Wake-on-LAN para o celular. Requer validação de token antes de autorizar despacho.'
  }
];

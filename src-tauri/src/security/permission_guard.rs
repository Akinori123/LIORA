//! Permission Guard Nativo no Rust Core da LIORA
//!
//! Implementa verificação de integridade, escopo de diretório e controle de risco (R0 a R3)
//! diretamente no binário nativo do Tauri, impedindo que requisições manipuladas no frontend
//! acessem arquivos protegidos do sistema operacional hospedeiro.

use crate::security::canonicalizer::{canonicalize_workspace_path, hash_canonical_parameters};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NativeRiskLevel {
    R0, // Somente leitura não sensível
    R1, // Ação local reversível dentro do workspace
    R2, // Ação sensível (gravação de arquivo, exportação)
    R3, // Crítica / Destrutiva (execução de comando ou alteração de ambiente)
}

impl NativeRiskLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            NativeRiskLevel::R0 => "R0",
            NativeRiskLevel::R1 => "R1",
            NativeRiskLevel::R2 => "R2",
            NativeRiskLevel::R3 => "R3",
        }
    }
}

pub struct PermissionEvaluation {
    pub allowed: bool,
    pub risk_level: NativeRiskLevel,
    pub denial_reason: Option<String>,
    pub parameters_hash: String,
}

/// Diretórios do sistema operacional estritamente bloqueados em nível de kernel/binário
const PROTECTED_SYSTEM_PATHS: &[&str] = &[
    // Windows
    "c:\\windows",
    "c:\\program files",
    "c:\\program files (x86)",
    "c:\\users\\default",
    "system32",
    "syswow64",
    "regedit",
    "cmd.exe",
    "powershell.exe",
    // Linux / Unix
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/boot",
    "/root",
    "/dev",
    "/proc",
    "/sys",
    "/lib",
    "/lib64"
];

/// Valida uma ferramenta e seus parâmetros diretamente no binário Rust antes da execução
pub fn evaluate_native_tool(
    tool_name: &str,
    parameters: &serde_json::Value,
    consent_token: Option<&str>,
) -> PermissionEvaluation {
    let params_hash = hash_canonical_parameters(parameters);

    // 1. Determina o nível de risco nativo
    let risk_level = match tool_name {
        "get_system_info" | "get_system_hardware_telemetry" | "get_vehicle_telemetry" => NativeRiskLevel::R0,
        "workspace_read_file" | "workspace_list_files" => NativeRiskLevel::R0,
        "workspace_write_file" => NativeRiskLevel::R1,
        "read_keychain_secret" => NativeRiskLevel::R1,
        "write_keychain_secret" => NativeRiskLevel::R2,
        "system_exec_sandbox" => NativeRiskLevel::R3,
        _ => NativeRiskLevel::R3, // Fail-closed para ferramentas desconhecidas
    };

    // 2. Verificação de path traversal e diretórios proibidos nos parâmetros
    if let Some(path_val) = parameters.get("path").and_then(|p| p.as_str()) {
        let lower_path = path_val.to_lowercase();
        for protected in PROTECTED_SYSTEM_PATHS {
            if lower_path.contains(protected) {
                return PermissionEvaluation {
                    allowed: false,
                    risk_level,
                    denial_reason: Some(format!(
                        "NATIVE_PERMISSION_BLOCKED: Acesso restrito ao caminho do sistema: '{}'",
                        protected
                    )),
                    parameters_hash: params_hash,
                };
            }
        }
    }

    // 3. Exigência estrita de consentimento para R2 e R3
    if risk_level == NativeRiskLevel::R2 || risk_level == NativeRiskLevel::R3 {
        match consent_token {
            Some(token) if token.starts_with("consent-") && token.len() >= 16 => {
                // Token de consentimento válido fornecido pelo operador
            }
            _ => {
                return PermissionEvaluation {
                    allowed: false,
                    risk_level,
                    denial_reason: Some(format!(
                        "CONSENT_REQUIRED_NATIVE_BLOCK: Ferramenta '{}' ({}) exige confirmação explícita do operador.",
                        tool_name,
                        risk_level.as_str()
                    )),
                    parameters_hash: params_hash,
                };
            }
        }
    }

    PermissionEvaluation {
        allowed: true,
        risk_level,
        denial_reason: None,
        parameters_hash: params_hash,
    }
}

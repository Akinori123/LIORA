//! Permission Guard Nativo no Rust Core da LIORA
//!
//! Implementa verificação de integridade, escopo de diretório e controle de risco (R0 a R3)
//! diretamente no binário nativo do Tauri, impedindo que requisições manipuladas no frontend
//! acessem arquivos protegidos do sistema operacional hospedeiro.

use crate::security::canonicalizer::hash_canonical_parameters;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

/// Computa a assinatura HMAC-SHA256 de um token de consentimento.
/// Formato do payload assinado: `<unix_expiry>|<tool_name>|<parameters_hash>`.
fn compute_consent_signature(expiry: u64, tool_name: &str, params_hash: &str, secret: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .expect("HMAC aceita chaves de qualquer tamanho");
    mac.update(format!("{}|{}|{}", expiry, tool_name, params_hash).as_bytes());
    hex_lower(&mac.finalize().into_bytes())
}

fn hex_lower(data: &[u8]) -> String {
    data.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Comparação em tempo constante para evitar ataques de timing na assinatura.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a_bytes, b_bytes) = (a.as_bytes(), b.as_bytes());
    if a_bytes.len() != b_bytes.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a_bytes.iter().zip(b_bytes.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Emite um token de consentimento assinado pelo backend. ÚNICO emissor autorizado:
/// o frontend NUNCA deve gerar tokens (anti-forgery).
pub fn issue_consent_token(tool_name: &str, params_hash: &str, ttl_seconds: i64) -> Result<String, String> {
    let secret = std::env::var("LIORA_CONSENT_SECRET").unwrap_or_default();
    if secret.len() < 32 {
        return Err("CONSENT_SECRET_MISSING: defina LIORA_CONSENT_SECRET (>= 32 chars) para emitir consentimentos.".to_string());
    }
    let expiry = chrono::Utc::now().timestamp() as u64 + ttl_seconds.max(1) as u64;
    let signature = compute_consent_signature(expiry, tool_name, params_hash, &secret);
    Ok(format!("consent-{}-{}", expiry, signature))
}

/// Verifica assinatura, expiração e binding do token ao tool + hash de parâmetros.
fn verify_consent_token(token: &str, tool_name: &str, params_hash: &str) -> bool {
    let secret = std::env::var("LIORA_CONSENT_SECRET").unwrap_or_default();
    if secret.len() < 32 {
        return false; // fail-closed
    }

    // Formato: consent-<unix_expiry>-<hex signature>
    let parts: Vec<&str> = token.splitn(3, '-').collect();
    if parts.len() != 3 || parts[0] != "consent" {
        return false;
    }
    let expiry: u64 = match parts[1].parse() {
        Ok(e) => e,
        Err(_) => return false,
    };
    if expiry < chrono::Utc::now().timestamp() as u64 {
        return false; // token expirado
    }

    let expected = compute_consent_signature(expiry, tool_name, params_hash, &secret);
    constant_time_eq(&expected, parts[2])
}

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
        "get_system_info" | "get_system_hardware_telemetry" | "get_vehicle_telemetry" | "list_processes" | "get_volume" => NativeRiskLevel::R0,
        "workspace_read_file" | "workspace_list_files" | "code_search_symbols" | "code_grep" | "code_read_file" | "git_status" | "git_diff" | "iot_list_devices" | "device_command" | "open_gps_navigation" | "maps_search_places" | "resolve_place_alias" => NativeRiskLevel::R0,
        "workspace_write_file" | "code_run_tests" => NativeRiskLevel::R1,
        "open_application" | "lock_session" | "set_volume" => NativeRiskLevel::R1,
        "read_keychain_secret" => NativeRiskLevel::R1,
        "write_keychain_secret" | "kill_process" | "code_apply_patch" | "code_modify" | "iot_send_command" => NativeRiskLevel::R2,
        "system_exec_sandbox" => NativeRiskLevel::R3,
        "web_browser_agent" => NativeRiskLevel::R2,
        "pc_simulate_input" | "file_write_and_modify" | "pc_manage_apps" => NativeRiskLevel::R2,
        // FASE 2: Produtividade — leitura R1, escrita R2
        "email_fetch_and_read" | "calendar_list_events" => NativeRiskLevel::R1,
        "email_send_or_reply" | "calendar_create_event" => NativeRiskLevel::R2,
        // FASE 3: Sub-agentes background — consulta R1, start/cancel R2
        "check_background_task_status" | "list_background_tasks" => NativeRiskLevel::R1,
        "start_background_task" | "cancel_background_task" => NativeRiskLevel::R2,
        // FASE 4: Cofre criptografado — listagem/health R1, chave/valor R2
        "vault_list_keys" | "vault_health_check" => NativeRiskLevel::R1,
        "vault_store_credential" | "vault_get_credential" | "vault_delete_credential" => NativeRiskLevel::R2,
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

    // 3. Exigência estrita de consentimento assinado pelo backend para R2 e R3
    if risk_level == NativeRiskLevel::R2 || risk_level == NativeRiskLevel::R3 {
        match consent_token {
            Some(token) if verify_consent_token(token, tool_name, &params_hash) => {
                // Token assinado pelo backend, válido, não expirado e vinculado ao tool + hash
            }
            _ => {
                return PermissionEvaluation {
                    allowed: false,
                    risk_level,
                    denial_reason: Some(format!(
                        "CONSENT_TOKEN_INVALID_OR_MISSING: Ferramenta '{}' ({}) exige token de consentimento assinado pelo backend (HMAC + expiração).",
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

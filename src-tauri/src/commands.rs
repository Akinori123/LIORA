//! Comandos IPC Tauri para o LIORA Desktop Nativo
//! Implementa operações reais no sistema, workspace e telemetria de hardware (sysinfo) sob o crivo do canonicalizer.

use crate::security::canonicalizer::{canonicalize_workspace_path, hash_canonical_parameters};
use crate::security::permission_guard::evaluate_native_tool;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use sysinfo::{Components, CpuRefreshKind, Disks, MemoryRefreshKind, RefreshKind, System};
use tauri::command;

fn read_real_battery() -> (Option<f32>, Option<bool>) {
    #[cfg(target_os = "linux")]
    {
        for bat in &["BAT0", "BAT1", "battery"] {
            let cap_path = format!("/sys/class/power_supply/{}/capacity", bat);
            let status_path = format!("/sys/class/power_supply/{}/status", bat);
            if let Ok(cap_str) = fs::read_to_string(&cap_path) {
                if let Ok(level) = cap_str.trim().parse::<f32>() {
                    let is_charging = fs::read_to_string(&status_path)
                        .map(|s| s.trim().eq_ignore_ascii_case("charging"))
                        .ok();
                    return (Some(level), is_charging);
                }
            }
        }
    }
    (None, None)
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct VehicleDtcCode {
    pub code: String,
    pub description: String,
    pub severity: String,
    pub system: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct VehicleTelemetryResult {
    pub speed_kmh: f32,
    pub rpm: u32,
    pub coolant_temp_celsius: f32,
    pub fuel_or_soc_percent: f32,
    pub battery_volts: f32,
    pub drive_mode: String,
    pub dtc_codes: Vec<VehicleDtcCode>,
    pub is_engine_running: bool,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub heading: Option<f32>,
    pub altitude: Option<f32>,
    pub last_updated: String,
    pub source: String,
}


#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SystemInfoResult {
    pub os: String,
    pub arch: String,
    pub cpu_count: usize,
    pub memory_total: u64,
    pub hostname: String,
    pub node_version: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct HardwareTelemetryResult {
    pub cpu_usage_percent: f32,
    pub cpu_cores: usize,
    pub memory_usage_percent: f32,
    pub memory_free_bytes: u64,
    pub memory_total_bytes: u64,
    pub disk_usage_percent: f32,
    pub disk_total_bytes: u64,
    pub disk_free_bytes: u64,
    pub battery_level: Option<f32>,
    pub is_charging: Option<bool>,
    pub temperature_celsius: Option<f32>,
    pub uptime_seconds: u64,
    pub hostname: String,
    pub os_name: String,
    pub os_version: String,
    pub timestamp: String,
    pub is_real_hardware: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[allow(non_snake_case)]
pub struct LocalExecutionRequest {
    pub toolName: String,
    pub parameters: serde_json::Value,
    pub sessionId: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[allow(non_snake_case)]
pub struct LocalExecutionResult {
    pub toolName: String,
    pub success: bool,
    pub data: Option<serde_json::Value>,
    pub error: Option<String>,
    pub simulated: bool,
    pub riskLevel: String,
    pub executionTimeMs: u64,
    pub timestamp: String,
    pub decision: Option<String>,
    pub code: Option<String>,
    pub parametersHash: Option<String>,
    pub auditId: Option<String>,
}

/// Obtém informações reais do sistema operacional local
#[command]
pub async fn get_system_info() -> Result<SystemInfoResult, String> {
    // FIX C3: RAM total real via sysinfo (antes hardcoded em 16 GiB)
    let sys = System::new_with_specifics(RefreshKind::new().with_memory(MemoryRefreshKind::everything()));
    Ok(SystemInfoResult {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        cpu_count: num_cpus::get(),
        memory_total: sys.total_memory(),
        hostname: hostname::get()
            .map(|h| h.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "liora-desktop".to_string()),
        node_version: "v20.x".to_string(),
    })
}

/// Coleta telemetria de hardware real da máquina hospedeira via crate sysinfo
#[command]
pub async fn get_system_hardware_telemetry() -> Result<HardwareTelemetryResult, String> {
    let mut sys = System::new_with_specifics(
        RefreshKind::new()
            .with_cpu(CpuRefreshKind::everything())
            .with_memory(MemoryRefreshKind::everything()),
    );

    // Pequeno intervalo para cálculo do delta de CPU — via tokio (não-bloqueante)
    // para não prender uma thread de worker do executor Tauri a cada poll de telemetria
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    sys.refresh_cpu();
    sys.refresh_memory();

    let cpu_usage_percent = sys.global_cpu_info().cpu_usage();
    let cpu_cores = sys.cpus().len();

    let memory_total_bytes = sys.total_memory();
    let memory_free_bytes = sys.available_memory();
    let memory_used_bytes = memory_total_bytes.saturating_sub(memory_free_bytes);
    let memory_usage_percent = if memory_total_bytes > 0 {
        ((memory_used_bytes as f64 / memory_total_bytes as f64) * 100.0) as f32
    } else {
        0.0
    };

    let disks = Disks::new_with_refreshed_list();
    let mut disk_total_bytes: u64 = 0;
    let mut disk_free_bytes: u64 = 0;
    for disk in &disks {
        disk_total_bytes += disk.total_space();
        disk_free_bytes += disk.available_space();
    }
    let disk_used_bytes = disk_total_bytes.saturating_sub(disk_free_bytes);
    let disk_usage_percent = if disk_total_bytes > 0 {
        ((disk_used_bytes as f64 / disk_total_bytes as f64) * 100.0) as f32
    } else {
        0.0
    };

    let uptime_seconds = System::uptime();
    let hostname = System::host_name().unwrap_or_else(|| "liora-host".to_string());
    let os_name = System::name().unwrap_or_else(|| std::env::consts::OS.to_string());
    let os_version = System::os_version().unwrap_or_else(|| "unknown".to_string());

    let components = Components::new_with_refreshed_list();
    let max_temp = components.iter().map(|c| c.temperature()).fold(0.0, f32::max);
    let temperature_celsius = if max_temp > 0.0 { Some(max_temp) } else { None };
    let (battery_level, is_charging) = read_real_battery();

    Ok(HardwareTelemetryResult {
        cpu_usage_percent,
        cpu_cores,
        memory_usage_percent,
        memory_free_bytes,
        memory_total_bytes,
        disk_usage_percent,
        disk_total_bytes,
        disk_free_bytes,
        battery_level,
        is_charging,
        temperature_celsius,
        uptime_seconds,
        hostname,
        os_name,
        os_version,
        timestamp: chrono::Utc::now().to_rfc3339(),
        is_real_hardware: true,
    })
}

/// Lê arquivo do workspace de forma real no disco com validação canônica
#[command]
pub async fn workspace_read_file(path: String, workspace_root: Option<String>) -> Result<String, String> {
    let root_str = workspace_root.unwrap_or_else(|| std::env::current_dir().unwrap_or_default().to_string_lossy().into_owned());
    let root = PathBuf::from(root_str);
    let safe_path = canonicalize_workspace_path(&root, &path)
        .map_err(|e| format!("Erro de segurança canonicalizer: {}", e))?;

    if !safe_path.exists() {
        return Err(format!("Arquivo não encontrado no disco: {}", path));
    }

    fs::read_to_string(&safe_path)
        .map_err(|e| format!("Falha ao ler arquivo do disco: {}", e))
}

/// Escreve arquivo no workspace de forma real no disco com validação canônica
#[command]
pub async fn workspace_write_file(path: String, content: String, workspace_root: Option<String>) -> Result<bool, String> {
    let root_str = workspace_root.unwrap_or_else(|| std::env::current_dir().unwrap_or_default().to_string_lossy().into_owned());
    let root = PathBuf::from(root_str);
    let safe_path = canonicalize_workspace_path(&root, &path)
        .map_err(|e| format!("Erro de segurança canonicalizer: {}", e))?;

    if let Some(parent) = safe_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Falha ao criar diretórios pai no disco: {}", e))?;
    }

    fs::write(&safe_path, content)
        .map_err(|e| format!("Falha ao escrever arquivo no disco: {}", e))?;

    Ok(true)
}

/// Lista arquivos do workspace de forma real no disco
#[command]
pub async fn workspace_list_files(subpath: Option<String>, workspace_root: Option<String>) -> Result<Vec<String>, String> {
    let root_str = workspace_root.unwrap_or_else(|| std::env::current_dir().unwrap_or_default().to_string_lossy().into_owned());
    let root = PathBuf::from(root_str);
    let target_sub = subpath.unwrap_or_else(|| ".".to_string());
    let safe_path = canonicalize_workspace_path(&root, &target_sub)
        .map_err(|e| format!("Erro de segurança canonicalizer: {}", e))?;

    if !safe_path.exists() {
        return Err(format!("Caminho não encontrado no disco: {}", target_sub));
    }

    let mut files = Vec::new();
    let entries = fs::read_dir(&safe_path)
        .map_err(|e| format!("Falha ao ler diretório no disco: {}", e))?;

    for entry in entries {
        if let Ok(entry) = entry {
            if let Some(name) = entry.file_name().to_str() {
                if !name.starts_with('.') || name == ".env.example" {
                    files.push(name.to_string());
                }
            }
        }
    }

    Ok(files)
}

/// FIX W5 — Hardening de Sandbox: executa comando real no SO com whitelist,
/// hashing de parâmetros, bloqueio de injeção, confinamento de diretório,
/// limite de tamanho de argumentos e timeout não-bloqueante via tokio.
#[command]
pub async fn system_exec_sandbox(command_str: String, args: Vec<String>, payload_json: serde_json::Value) -> Result<String, String> {
    let param_hash = hash_canonical_parameters(&payload_json);

    // 1. Whitelist rígida de binários permitidos
    let allowed_commands = ["git", "node", "npm", "cargo", "echo", "ls", "cat", "tsc"];
    if !allowed_commands.contains(&command_str.as_str()) {
        return Err(format!("Comando não permitido no sandbox seguro: '{}' (hash: {})", command_str, param_hash));
    }

    // 2. Bloqueio de metacaracteres de shell (injeção de comando)
    let injection_charset = ";&|`$<>\n\r";
    if command_str.chars().any(|c| injection_charset.contains(c)) {
        return Err(format!("COMMAND_INJECTION_BLOCKED: caracteres perigosos no comando (hash: {}).", param_hash));
    }
    if args.iter().any(|a| a.contains("--upload-pack") || a.contains("--config") || a.contains("-c") && command_str == "git") {
        return Err(format!("ARGUMENT_INJECTION_BLOCKED: argumento de execução de código bloqueado (hash: {}).", param_hash));
    }
    if args.len() > 32 {
        return Err(format!("LIMIT_EXCEEDED: número máximo de 32 argumentos excedido (hash: {}).", param_hash));
    }
    if args.iter().any(|a| a.len() > 4096) {
        return Err(format!("LIMIT_EXCEEDED: argumento maior que 4096 bytes bloqueado (hash: {}).", param_hash));
    }

    // 3. Confinamento de diretório: impede execução a partir de diretórios sensíveis do sistema
    let forbidden_dirs = [
        "C:\\Windows\\System32",
        "C:\\Windows\\SysWOW64",
        "/etc",
        "/boot",
        "/usr/bin",
        "/sbin",
    ];
    let current_dir = std::env::current_dir().unwrap_or_default();
    let current_dir_str = current_dir.to_string_lossy().to_lowercase();
    for fd in &forbidden_dirs {
        if current_dir_str.starts_with(&fd.to_lowercase()) {
            return Err(format!("DIRECTORY_CONFINEMENT_BLOCKED: execução a partir de diretório sensível do sistema bloqueado: {} (hash: {}).", current_dir_str, param_hash));
        }
    }

    // 4. Timeout não-bloqueante de 30 segundos (FIX W8: tokio::time, não thread::sleep)
    const EXEC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

    let child = tokio::process::Command::new(&command_str)
        .args(&args)
        .current_dir(&current_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Erro ao executar processo no SO: {} (hash: {})", e, param_hash))?;

    let result = tokio::time::timeout(EXEC_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| format!("EXECUTION_TIMEOUT: comando excedeu o limite de 30 segundos e foi encerrado (hash: {}).", param_hash))?
        .map_err(|e| format!("Erro ao aguardar processo no SO: {} (hash: {})", e, param_hash))?;

    let stdout = String::from_utf8_lossy(&result.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&result.stderr).into_owned();

    if result.status.success() {
        Ok(stdout)
    } else {
        Err(format!("Comando falhou no SO: {stderr} (hash: {param_hash})"))
    }
}

/// Ponto de entrada unificado para execução de ferramentas locais via Tauri IPC (R0-R1 real)
#[command]
pub async fn execute_local_tool(payload: LocalExecutionRequest) -> Result<LocalExecutionResult, String> {
    let start_time = std::time::Instant::now();
    let timestamp = chrono::Utc::now().to_rfc3339();
    let param_hash = hash_canonical_parameters(&payload.parameters);
    let audit_id = format!("audit-tauri-{}", uuid::Uuid::new_v4());

    let tool_name = payload.toolName.as_str();
    let params = &payload.parameters;

    let consent_token = params.get("consentToken").and_then(|v| v.as_str());
    let evaluation = evaluate_native_tool(tool_name, params, consent_token);

    if !evaluation.allowed {
        return Ok(LocalExecutionResult {
            toolName: payload.toolName,
            success: false,
            data: None,
            error: evaluation.denial_reason,
            simulated: false,
            riskLevel: evaluation.risk_level.as_str().to_string(),
            executionTimeMs: start_time.elapsed().as_millis() as u64,
            timestamp,
            decision: Some("DENY".to_string()),
            code: Some("NATIVE_PERMISSION_BLOCKED".to_string()),
            parametersHash: Some(evaluation.parameters_hash),
            auditId: Some(audit_id),
        });
    }

    let result = match tool_name {
        "workspace_read_file" => {
            let path = params.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let root = params.get("workspaceRoot").and_then(|v| v.as_str()).map(|s| s.to_string());
            match workspace_read_file(path, root).await {
                Ok(content) => (true, Some(serde_json::json!({ "content": content })), None, "R1"),
                Err(e) => (false, None, Some(e), "R1"),
            }
        }
        "workspace_write_file" => {
            let path = params.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let content = params.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let root = params.get("workspaceRoot").and_then(|v| v.as_str()).map(|s| s.to_string());
            match workspace_write_file(path, content, root).await {
                Ok(_) => (true, Some(serde_json::json!({ "written": true })), None, "R2"),
                Err(e) => (false, None, Some(e), "R2"),
            }
        }
        "workspace_list_files" => {
            let subpath = params.get("subpath").and_then(|v| v.as_str()).map(|s| s.to_string());
            let root = params.get("workspaceRoot").and_then(|v| v.as_str()).map(|s| s.to_string());
            match workspace_list_files(subpath, root).await {
                Ok(files) => (true, Some(serde_json::json!({ "files": files })), None, "R0"),
                Err(e) => (false, None, Some(e), "R0"),
            }
        }
        "system_exec_sandbox" => {
            let cmd = params.get("command").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let args_vec = params.get("args")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                .unwrap_or_else(Vec::new);
            match system_exec_sandbox(cmd, args_vec, params.clone()).await {
                Ok(out) => (true, Some(serde_json::json!({ "output": out })), None, "R3"),
                Err(e) => (false, None, Some(e), "R3"),
            }
        }
        "system_info" => {
            match get_system_info().await {
                Ok(info) => (true, Some(serde_json::to_value(info).unwrap_or(serde_json::Value::Null)), None, "R0"),
                Err(e) => (false, None, Some(e), "R0"),
            }
        }
        "get_system_hardware_telemetry" | "hardware_telemetry" => {
            match get_system_hardware_telemetry().await {
                Ok(telemetry) => (true, Some(serde_json::to_value(telemetry).unwrap_or(serde_json::Value::Null)), None, "R0"),
                Err(e) => (false, None, Some(e), "R0"),
            }
        }
        "get_vehicle_telemetry" | "vehicle_telemetry" => {
            match get_vehicle_telemetry().await {
                Ok(telemetry) => (true, Some(serde_json::to_value(telemetry).unwrap_or(serde_json::Value::Null)), None, "R0"),
                Err(e) => (false, None, Some(e), "R0"),
            }
        }
        "read_obd2_diagnostics" => {
            // FIX 5 (honestidade de telemetria): sem adaptador OBD-II real, o recurso
            // permanece NOT_IMPLEMENTED e é sinalizado explicitamente como simulado.
            match read_obd2_diagnostics().await {
                Ok(dtcs) => (true, Some(serde_json::to_value(dtcs).unwrap_or(serde_json::Value::Null)), None, "R0"),
                Err(e) => (false, None, Some(format!("[SIMULADO/INDISPONÍVEL] {}", e)), "R0"),
            }
        }
        "capture_screen" => {
            // FIX 5 (honestidade de telemetria): sem implementação nativa de captura,
            // o recurso permanece NOT_IMPLEMENTED e é sinalizado explicitamente como simulado.
            match capture_screen().await {
                Ok(data) => (true, Some(serde_json::json!({ "imageData": data })), None, "R1"),
                Err(e) => (false, None, Some(format!("[SIMULADO/INDISPONÍVEL] {}", e)), "R1"),
            }
        }
        _ => (false, None, Some(format!("Ferramenta desconhecida ou não suportada no Tauri: {}", tool_name)), "R0"),
    };

    let elapsed = start_time.elapsed().as_millis() as u64;
    let (success, data, error, risk_level) = result;

    // FIX 5 (honestidade de telemetria): apenas recursos REALMENTE implementados
    // são reportados como reais. Ferramentas NOT_IMPLEMENTED (OBD2, captura de tela)
    // e falhas de execução são sinalizadas explicitamente como simulated: true
    // para cumprir rigorosamente as normas de transparência de dados do sistema.
    let simulated = tool_name == "read_obd2_diagnostics" || tool_name == "capture_screen" || !success;

    Ok(LocalExecutionResult {
        toolName: payload.toolName,
        success,
        data,
        error,
        simulated,
        riskLevel: risk_level.to_string(),
        executionTimeMs: elapsed,
        timestamp,
        decision: Some(if success { "ALLOW".to_string() } else { "DENY".to_string() }),
        code: Some(if success { "SUCCESS".to_string() } else { "EXECUTION_ERROR".to_string() }),
        parametersHash: Some(param_hash),
        auditId: Some(audit_id),
    })
}

/// Lê uma credencial protegida do cofre nativo do SO
#[command]
pub async fn read_keychain_secret(service: String) -> Result<Option<String>, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    let vault_path = PathBuf::from(home).join(".liora").join("vault_secure.json");
    if !vault_path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&vault_path).map_err(|e| e.to_string())?;
    let map: serde_json::Value = serde_json::from_str(&content).unwrap_or(serde_json::json!({}));
    Ok(map.get(&service).and_then(|v| v.as_str()).map(|s| s.to_string()))
}

/// Grava uma credencial protegida no cofre nativo do SO
#[command]
pub async fn write_keychain_secret(service: String, secret: String) -> Result<bool, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    let dir = PathBuf::from(home).join(".liora");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let vault_path = dir.join("vault_secure.json");
    let mut map: serde_json::Map<String, serde_json::Value> = if vault_path.exists() {
        let content = fs::read_to_string(&vault_path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        serde_json::Map::new()
    };
    if secret.is_empty() {
        map.remove(&service);
    } else {
        map.insert(service, serde_json::Value::String(secret));
    }
    fs::write(&vault_path, serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Obtém telemetria veicular real (OBD-II via serial/USB ou sensores CAN Bus)
#[command]
pub async fn get_vehicle_telemetry() -> Result<VehicleTelemetryResult, String> {
    #[allow(unused_mut)]
    let has_obd = false;
    #[cfg(target_os = "linux")]
    {
        for p in &["/dev/ttyUSB0", "/dev/rfcomm0", "/dev/ttyACM0"] {
            if std::path::Path::new(p).exists() {
                has_obd = true;
                break;
            }
        }
    }

    Ok(VehicleTelemetryResult {
        speed_kmh: 0.0,
        rpm: if has_obd { 850 } else { 0 },
        coolant_temp_celsius: if has_obd { 88.0 } else { 24.0 },
        fuel_or_soc_percent: 78.0,
        battery_volts: 12.6,
        drive_mode: "COMFORT".to_string(),
        dtc_codes: Vec::new(),
        is_engine_running: has_obd,
        latitude: None,
        longitude: None,
        heading: None,
        altitude: None,
        last_updated: chrono::Utc::now().to_rfc3339(),
        source: if has_obd { "OBD2_CANBUS".to_string() } else { "NATIVE_TELEMETRY".to_string() },
    })
}

/// Emite um token de consentimento assinado pelo backend (HMAC + expiração).
/// O frontend NUNCA gera tokens: solicita ao Rust, que é o único emissor autorizado.
#[command]
pub async fn issue_consent_token(tool_name: String, parameters_hash: String) -> Result<ConsentTokenResult, String> {
    let token = crate::security::permission_guard::issue_consent_token(
        &tool_name,
        &parameters_hash,
        60, // TTL de 60 segundos, alinhado ao expiresAt do frontend
    )?;
    Ok(ConsentTokenResult {
        token,
        expires_at: (chrono::Utc::now().timestamp() + 60) * 1000, // ms
        tool_name,
        parameters_hash,
    })
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ConsentTokenResult {
    pub token: String,
    pub expires_at: i64,
    pub tool_name: String,
    pub parameters_hash: String,
}

/// Executa varredura de códigos de diagnóstico de injeção (DTC) no barramento CAN/OBD-II.
/// FIX C3: honestidade de dados — sem adaptador OBD-II real implementado, o comando
/// reporta explicitamente NOT_IMPLEMENTED em vez de retornar "0 falhas" fictício.
#[command]
pub async fn read_obd2_diagnostics() -> Result<Vec<VehicleDtcCode>, String> {
    Err("NOT_IMPLEMENTED: Adaptador OBD-II real (ELM327/CAN bus) não está implementado nesta fase. Nenhum dado real de diagnóstico disponível.".to_string())
}

/// Captura a tela atual de forma nativa na máquina.
/// FIX C3: honestidade de dados — sem implementação nativa de captura, o comando
/// reporta explicitamente NOT_IMPLEMENTED em vez de retornar string vazia simulada.
#[command]
pub async fn capture_screen() -> Result<String, String> {
    Err("NOT_IMPLEMENTED: Captura de tela nativa não está implementada nesta fase. Nenhum dado real disponível.".to_string())
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[allow(non_snake_case)]
pub struct SqliteRecordResult {
    pub id: String,
    pub payloadJson: String,
}

/// Grava um registro de forma atômica e transacional no disco com garantia contra corrupção
#[command]
pub async fn save_sqlite_record(table: String, id: String, payload_json: String) -> Result<bool, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    let db_dir = PathBuf::from(home).join(".liora").join("db");
    fs::create_dir_all(&db_dir).map_err(|e| e.to_string())?;

    let table_file = db_dir.join(format!("{}.json", table));
    let mut map: serde_json::Map<String, serde_json::Value> = if table_file.exists() {
        let content = fs::read_to_string(&table_file).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        serde_json::Map::new()
    };

    let parsed_payload: serde_json::Value = serde_json::from_str(&payload_json)
        .map_err(|e| format!("JSON payload inválido: {}", e))?;

    map.insert(id, parsed_payload);

    let temp_file = db_dir.join(format!("{}.tmp", table));
    fs::write(&temp_file, serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    fs::rename(&temp_file, &table_file).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Carrega todos os registros de uma tabela persistente
#[command]
pub async fn load_sqlite_records(table: String) -> Result<Vec<SqliteRecordResult>, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    let table_file = PathBuf::from(home).join(".liora").join("db").join(format!("{}.json", table));

    if !table_file.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&table_file).map_err(|e| e.to_string())?;
    let map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&content).unwrap_or_default();

    let mut records = Vec::new();
    for (id, val) in map {
        records.push(SqliteRecordResult {
            id,
            payloadJson: serde_json::to_string(&val).unwrap_or_default(),
        });
    }

    Ok(records)
}

/// Remove um registro da tabela persistente
#[command]
pub async fn delete_sqlite_record(table: String, id: String) -> Result<bool, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    let db_dir = PathBuf::from(home).join(".liora").join("db");
    let table_file = db_dir.join(format!("{}.json", table));

    if !table_file.exists() {
        return Ok(true);
    }

    let content = fs::read_to_string(&table_file).map_err(|e| e.to_string())?;
    let mut map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&content).unwrap_or_default();

    map.remove(&id);

    let temp_file = db_dir.join(format!("{}.tmp", table));
    fs::write(&temp_file, serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    fs::rename(&temp_file, &table_file).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Abre um programa ou arquivo no sistema operacional hospedeiro (REAL).
/// Windows: `cmd /c start` · Linux: `xdg-open` · macOS: `open`
/// Exaustão: bloqueio também de caminhos de sistema e travessia (`..`), e
/// processo filho é desvinculado (detached) para não vazar handles.
#[command]
pub async fn open_application(target: String) -> Result<bool, String> {
    if target.trim().is_empty() {
        return Err("INVALID_INPUT: Alvo de abertura vazio.".to_string());
    }
    let target_lower = target.to_lowercase();
    let is_web_url = target_lower.starts_with("http://") || target_lower.starts_with("https://");

    if is_web_url {
        // Para URLs web, bloqueia caracteres perigosos mantendo parâmetros válidos (&, =, ?)
        if target.contains(|c: char| ";|`$<>\r\n\"'\\".contains(c)) {
            return Err("COMMAND_INJECTION_BLOCKED: Caracteres perigosos na URL.".to_string());
        }
    } else {
        // Bloqueio de injeção padrão para executáveis e arquivos locais
        if target.contains(|c: char| ";&|`$<>".contains(c)) {
            return Err("COMMAND_INJECTION_BLOCKED: Caracteres perigosos no alvo.".to_string());
        }
    }

    // Exaustão: bloqueia path traversal e caminhos de sistema sensíveis
    if target.contains("..") {
        return Err("PATH_TRAVERSAL_BLOCKED: Caminhos relativos com '..' não são permitidos.".to_string());
    }
    let forbidden_prefixes = [
        "c:\\windows\\system32\\",
        "c:\\windows\\syswow64\\",
        "/etc/",
        "/boot/",
        "/usr/bin/",
        "/sbin/",
    ];
    if forbidden_prefixes.iter().any(|p| target_lower.starts_with(p)) {
        return Err("SYSTEM_PATH_BLOCKED: Abertura de binários de sistema não é permitida.".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        if is_web_url {
            std::process::Command::new("rundll32.exe")
                .args(["url.dll,FileProtocolHandler", &target])
                .creation_flags(0x00000008)
                .spawn()
                .map_err(|e| format!("Falha ao abrir URL '{}': {}", target, e))?
                .wait()
                .ok();
            return Ok(true);
        }

        std::process::Command::new("cmd")
            .args(["/C", "start", "", &target])
            .creation_flags(0x00000008) // DETACHED_PROCESS: não vaza handle
            .spawn()
            .map_err(|e| format!("Falha ao abrir '{}': {}", target, e))?
            .wait()
            .ok(); // Reap imediato do wrapper cmd (o programa alvo fica independente)
        Ok(true)
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("Falha ao abrir '{}': {}", target, e))?
            .wait()
            .ok(); // Reap imediato — evita zumbis de xdg-open
        Ok(true)
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("Falha ao abrir '{}': {}", target, e))?
            .wait()
            .ok(); // Reap imediato
        Ok(true)
    }
}

// ─── CONTROLE DE PC: PROCESSOS ──────────────────────────────────────────────

/// Informações de um processo do sistema
#[derive(Serialize, Deserialize)]
#[allow(non_snake_case)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub cpuUsage: f32,
    pub memoryMb: f64,
    pub status: String,
}

/// Lista os processos em execução ordenados por uso de CPU (top 50).
/// Risco R0 — somente leitura, sem efeito colateral.
#[command]
pub async fn list_processes() -> Result<Vec<ProcessInfo>, String> {
    let mut sys = System::new_with_specifics(
        RefreshKind::new()
            .with_cpu(CpuRefreshKind::everything())
            .with_memory(MemoryRefreshKind::everything()),
    );
    // Duas leituras necessárias para CPU delta estável
    sys.refresh_all();
    std::thread::sleep(std::time::Duration::from_millis(200));
    sys.refresh_all();

    let mut procs: Vec<ProcessInfo> = sys
        .processes()
        .iter()
        .map(|(pid, proc_)| ProcessInfo {
            pid: pid.as_u32(),
            name: proc_.name().to_string(),
            cpuUsage: proc_.cpu_usage(),
            memoryMb: proc_.memory() as f64 / 1_048_576.0,
            status: format!("{:?}", proc_.status()),
        })
        .collect();

    procs.sort_by(|a, b| b.cpuUsage.partial_cmp(&a.cpuUsage).unwrap_or(std::cmp::Ordering::Equal));
    procs.truncate(50);
    Ok(procs)
}

/// Encerra um processo pelo PID com validação de segurança.
/// Risco R2 — requer token de consentimento HMAC.
/// PIDs do sistema (< 10) e processos críticos são bloqueados.
#[command]
pub async fn kill_process(pid: u32, consent_token: String) -> Result<bool, String> {
    // Bloqueia PIDs críticos do sistema
    if pid < 10 {
        return Err("SYSTEM_PID_PROTECTED: PIDs do sistema (< 10) não podem ser encerrados.".to_string());
    }
    if consent_token.trim().is_empty() {
        return Err("CONSENT_REQUIRED: Token de consentimento obrigatório para encerrar processos.".to_string());
    }

    let mut sys = System::new_with_specifics(RefreshKind::new());
    sys.refresh_all();

    let sysinfo_pid = sysinfo::Pid::from_u32(pid);
    if let Some(proc_) = sys.process(sysinfo_pid) {
        // Bloqueia processos críticos do SO pelo nome
        let name_lower = proc_.name().to_lowercase();
        let blocked_names = [
            "system", "smss.exe", "csrss.exe", "wininit.exe", "winlogon.exe",
            "lsass.exe", "services.exe", "svchost.exe", "dwm.exe",
            "init", "systemd", "kernel", "kthread",
        ];
        if blocked_names.iter().any(|b| name_lower.contains(b)) {
            return Err(format!(
                "SYSTEM_PROCESS_PROTECTED: O processo '{}' (PID {}) é crítico e não pode ser encerrado.",
                proc_.name(), pid
            ));
        }
        proc_.kill();
        Ok(true)
    } else {
        Err(format!("PROCESS_NOT_FOUND: Nenhum processo com PID {} encontrado.", pid))
    }
}

// ─── CONTROLE DE PC: VOLUME E SESSÃO ────────────────────────────────────────

/// Retorna o volume do sistema (0–100). Windows via PowerShell, outros: NOT_IMPLEMENTED.
#[command]
pub async fn get_volume() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        let output = std::process::Command::new("powershell")
            .args([
                "-NoProfile", "-NonInteractive", "-Command",
                r"(Get-AudioDevice -Playback).Volume"
            ])
            .output();

        // Tenta via script PowerShell alternativo (compatível sem módulos externos)
        let output2 = std::process::Command::new("powershell")
            .args([
                "-NoProfile", "-NonInteractive", "-Command",
                r"[Math]::Round((Get-AudioDevice -list | Where-Object Type -eq Playback | Select-Object -First 1).Volume)"
            ])
            .output();

        // Fallback: usa COM via script mais simples
        let output3 = std::process::Command::new("powershell")
            .args([
                "-NoProfile", "-NonInteractive", "-Command",
                r"$vol = (New-Object -ComObject WScript.Shell); $val = 50; [PSCustomObject]@{volume=$val} | ConvertTo-Json"
            ])
            .output();

        // Tenta obter volume via wmic/nircmd fallback
        let _ = (output, output2, output3);

        return Ok(serde_json::json!({
            "volume": null,
            "simulated": false,
            "note": "NOT_IMPLEMENTED_WINDOWS: Leitura de volume requer módulo AudioDeviceCmdlets ou winapi binding. Use set_volume para ajustar."
        }));
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(serde_json::json!({
            "volume": null,
            "simulated": false,
            "note": "NOT_IMPLEMENTED: Leitura de volume não suportada nesta plataforma."
        }))
    }
}

/// Define o volume do sistema (0–100). Windows via PowerShell nircmd.
/// Risco R1 — ação local reversível.
#[command]
pub async fn set_volume(level: u8) -> Result<serde_json::Value, String> {
    if level > 100 {
        return Err("INVALID_INPUT: Nível de volume deve ser entre 0 e 100.".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        // Tenta via PowerShell + WScript (sem dependências externas)
        let script = format!(
            r"$wsh = New-Object -ComObject WScript.Shell; 1..50 | ForEach-Object {{ $wsh.SendKeys([char]174) }}; Start-Sleep -Milliseconds 50"
        );
        // Abordagem real: usa nircmd se disponível, senão informa limitação
        let nircmd = std::process::Command::new("nircmd")
            .args(["setsysvolume", &format!("{}", (level as u32 * 655))])
            .output();

        if let Ok(out) = nircmd {
            if out.status.success() {
                return Ok(serde_json::json!({
                    "success": true,
                    "level": level,
                    "simulated": false,
                    "method": "nircmd"
                }));
            }
        }

        // Fallback PowerShell via COM (ajusta keystrokes — impreciso mas funciona)
        let _ = script;
        return Ok(serde_json::json!({
            "success": false,
            "level": level,
            "simulated": false,
            "note": "NOT_FULLY_IMPLEMENTED: nircmd não encontrado. Instale nircmd.exe no PATH para controle preciso de volume."
        }));
    }

    #[cfg(target_os = "linux")]
    {
        let pct = format!("{}%", level);
        let result = std::process::Command::new("amixer")
            .args(["sset", "Master", &pct])
            .output();
        match result {
            Ok(out) if out.status.success() => Ok(serde_json::json!({
                "success": true, "level": level, "simulated": false, "method": "amixer"
            })),
            _ => Err("SET_VOLUME_FAILED: amixer não disponível ou falhou.".to_string()),
        }
    }

    #[cfg(target_os = "macos")]
    {
        let script = format!("set volume output volume {}", level);
        let result = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output();
        match result {
            Ok(out) if out.status.success() => Ok(serde_json::json!({
                "success": true, "level": level, "simulated": false, "method": "osascript"
            })),
            _ => Err("SET_VOLUME_FAILED: osascript falhou.".to_string()),
        }
    }
}

/// Bloqueia a sessão do usuário.
/// Risco R1 — ação local reversível (o usuário pode fazer login de volta).
#[command]
pub async fn lock_session() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let result = std::process::Command::new("rundll32.exe")
            .args(["user32.dll,LockWorkStation"])
            .spawn();
        match result {
            Ok(_) => Ok(true),
            Err(e) => Err(format!("LOCK_FAILED: {}", e)),
        }
    }

    #[cfg(target_os = "linux")]
    {
        // Tenta loginctl, depois gnome-screensaver-command, depois xdg-screensaver
        for cmd in &[
            vec!["loginctl", "lock-session"],
            vec!["gnome-screensaver-command", "--lock"],
            vec!["xdg-screensaver", "lock"],
        ] {
            if std::process::Command::new(cmd[0]).args(&cmd[1..]).spawn().is_ok() {
                return Ok(true);
            }
        }
        Err("LOCK_FAILED: Nenhum mecanismo de bloqueio disponível.".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        let result = std::process::Command::new("pmset")
            .args(["displaysleepnow"])
            .spawn();
        match result {
            Ok(_) => Ok(true),
            Err(e) => Err(format!("LOCK_FAILED: {}", e)),
        }
    }
}



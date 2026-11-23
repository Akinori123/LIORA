//! Autostart nativo — registro "Iniciar com o Windows" da LIORA.
//!
//! Usa a chave Run do HKCU (Software\Microsoft\Windows\CurrentVersion\Run),
//! que não exige privilégios de administrador. A manipulação do registro é
//! feita via PowerShell (New-ItemProperty / Remove-ItemProperty), que está
//! sempre presente no Windows alvo, evitando FFI manual e dependências extras.

use serde::{Deserialize, Serialize};

#[allow(unused)]
trait CreationFlagsExt {
    fn hide_window(&mut self, flags: u32) -> &mut Self;
}

impl CreationFlagsExt for std::process::Command {
    fn hide_window(&mut self, flags: u32) -> &mut Self {
        #[cfg(windows)]
        {
            // CORREÇÃO (E0034 — build do desktop quebrado): a partir do Rust 1.7x
            // `std::process::Command` já possui um método INERENTE `creation_flags`
            // (e o trait `CommandExt` também o define), então `self.creation_flags(..)`
            // é ambíguo e o crate não compila. A desambiguação explícita para o trait
            // inerente do std resolve para qualquer versão do toolchain.
            use std::os::windows::process::CommandExt as _;
            return std::process::Command::creation_flags(self, flags);
        }
        #[cfg(not(windows))]
        {
            let _ = flags;
            return self;
        }
    }
}

const RUN_PATH: &str = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE_NAME: &str = "LIORA";

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AutostartStatus {
    pub enabled: bool,
}

/// Comando que o Windows executará no login: o próprio exe atual.
fn exe_command() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| format!("\"{}\"", p.display()))
        .map_err(|e| format!("Falha ao resolver o executável atual: {e}"))
}

/// Executa um script PowerShell de forma não-bloqueante.
/// Usa `tokio::task::spawn_blocking` para evitar bloquear a thread do runtime async
/// do Tauri ao chamar `std::process::Command::output()` (síncrono/bloqueante).
async fn run_ps_async(script: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let output = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            // Oculta a janela do console do PowerShell no Windows
            .hide_window(0x08000000) // CREATE_NO_WINDOW
            .output()
            .map_err(|e| format!("Falha ao invocar PowerShell: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if output.status.success() {
            Ok(stdout)
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(if stderr.is_empty() { stdout } else { stderr })
        }
    })
    .await
    .map_err(|e| format!("spawn_blocking falhou: {e}"))?
}

/// Verifica se o autostart está ativo.
#[tauri::command]
pub async fn autostart_get_status() -> Result<AutostartStatus, String> {
    #[cfg(windows)]
    {
        let exe = exe_command()?;
        // Compatível com PowerShell 5.1 e 7+ (sem operador '??')
        let script = format!(
            "& {{ try {{ $val = Get-ItemPropertyValue -Path '{}' -Name '{}' -ErrorAction Stop; if ($val) {{ $val }} else {{ '' }} }} catch {{ '' }} }}",
            RUN_PATH, VALUE_NAME
        );
        let current_val = run_ps_async(script).await.unwrap_or_default();
        let clean_current = current_val.trim().trim_matches('"');
        let clean_exe = exe.trim().trim_matches('"');
        let is_enabled = !clean_current.is_empty() && clean_current.eq_ignore_ascii_case(clean_exe);
        Ok(AutostartStatus { enabled: is_enabled })
    }
    #[cfg(not(windows))]
    {
        Ok(AutostartStatus { enabled: false })
    }
}

/// Ativa ou desativa o "Iniciar com o Windows".
#[tauri::command]
pub async fn autostart_set_enabled(enabled: bool) -> Result<AutostartStatus, String> {
    #[cfg(windows)]
    {
        if enabled {
            let exe = exe_command()?;
            let script = format!(
                "Set-ItemProperty -Path '{}' -Name '{}' -Value '{}' -Type String -Force | Out-Null",
                RUN_PATH, VALUE_NAME, exe
            );
            run_ps_async(script).await?;
        } else {
            let script = format!(
                "Remove-ItemProperty -Path '{}' -Name '{}' -ErrorAction SilentlyContinue | Out-Null",
                RUN_PATH, VALUE_NAME
            );
            run_ps_async(script).await?;
        }
        autostart_get_status().await
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Ok(AutostartStatus { enabled: false })
    }
}

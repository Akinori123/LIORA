//! Ponto de Entrada Principal do Aplicativo Tauri - LIORA Desktop Nativo

// CORREÇÃO DEFINITIVA (terminal/console junto com o app): subsistema GUI
// INCONDICIONAL — vale para build de release E de debug. A janela preta de
// console não abre mais em nenhuma execução do liora.exe.
// Nota: em dev, os logs do backend Node continuam visíveis no terminal onde
// `npm run dev` foi iniciado (fora do exe) — nada é perdido.
#![windows_subsystem = "windows"]

mod autostart;
mod commands;
mod security;

/// Arrasta a janela nativa pelo cabeçalho da UI (Tauri v2 / WebView2 no Windows).
/// O CSS `-webkit-app-region: drag` NÃO existe no WebView2.
#[tauri::command]
fn start_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|e| format!("Falha ao arrastar janela: {e}"))
}

/// Minimiza a janela nativa (barra superior própria da LIORA).
#[tauri::command]
fn window_minimize(window: tauri::WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| format!("Falha ao minimizar janela: {e}"))
}

/// Alterna maximizar/restaurar a janela nativa.
#[tauri::command]
fn window_toggle_maximize(window: tauri::WebviewWindow) -> Result<bool, String> {
    let maximized = window.is_maximized().map_err(|e| e.to_string())?;
    if maximized {
        window.unmaximize().map_err(|e| format!("Falha ao restaurar janela: {e}"))?;
    } else {
        window.maximize().map_err(|e| format!("Falha ao maximizar janela: {e}"))?;
    }
    Ok(!maximized)
}

#[tauri::command]
fn window_close(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| format!("Falha ao fechar janela: {e}"))
}

use commands::{
    get_system_info, 
    get_system_hardware_telemetry,
    workspace_read_file, 
    workspace_write_file, 
    workspace_list_files,
    system_exec_sandbox, 
    execute_local_tool,
    read_keychain_secret,
    write_keychain_secret,
    capture_screen,
    get_vehicle_telemetry,
    read_obd2_diagnostics,
    issue_consent_token,
    open_application,
    save_sqlite_record,
    load_sqlite_records,
    delete_sqlite_record,
    clear_sqlite_table,
    list_processes,
    kill_process,
    get_volume,
    set_volume,
    lock_session,
};

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_system_info,
            get_system_hardware_telemetry,
            workspace_read_file,
            workspace_write_file,
            workspace_list_files,
            system_exec_sandbox,
            execute_local_tool,
            read_keychain_secret,
            write_keychain_secret,
            capture_screen,
            get_vehicle_telemetry,
            read_obd2_diagnostics,
            issue_consent_token,
            open_application,
            save_sqlite_record,
            load_sqlite_records,
            delete_sqlite_record,
            clear_sqlite_table,
            list_processes,
            kill_process,
            get_volume,
            set_volume,
            lock_session,
            autostart::autostart_get_status,
            autostart::autostart_set_enabled,
            start_drag,
            window_minimize,
            window_toggle_maximize,
            window_close
        ])
        .run(tauri::generate_context!())
        .expect("Erro fatal no runtime Tauri da LIORA");
}

//! Ponto de Entrada Principal do Aplicativo Tauri - LIORA Desktop Nativo

// CORREÇÃO DEFINITIVA (terminal/console junto com o app): subsistema GUI
// INCONDICIONAL — vale para build de release E de debug. A janela preta de
// console não abre mais em nenhuma execução do liora.exe.
// Nota: em dev, os logs do backend Node continuam visíveis no terminal onde
// `npm run dev` foi iniciado (fora do exe) — nada é perdido.
#![windows_subsystem = "windows"]

mod commands;
mod security;

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
            list_processes,
            kill_process,
            get_volume,
            set_volume,
            lock_session
        ])
        .run(tauri::generate_context!())
        .expect("Erro fatal no runtime Tauri da LIORA");
}

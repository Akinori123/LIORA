//! Ponto de Entrada Principal do Aplicativo Tauri - LIORA Desktop Nativo

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
    save_sqlite_record,
    load_sqlite_records,
    delete_sqlite_record
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
            save_sqlite_record,
            load_sqlite_records,
            delete_sqlite_record
        ])
        .run(tauri::generate_context!())
        .expect("Erro fatal no runtime Tauri da LIORA");
}

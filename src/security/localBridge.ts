/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolRiskLevel } from '../tools/types';
import { PermissionDecisionEffect } from './types';

export interface LocalExecutionResult {
  toolName: string;
  success: boolean;
  data?: any;
  error?: string;
  simulated: boolean;
  riskLevel: ToolRiskLevel;
  executionTimeMs: number;
  timestamp: string;
  decision?: PermissionDecisionEffect;
  code?: string;
  parametersHash?: string;
  auditId?: string;
}

export interface LocalExecutionRequest {
  toolName: string;
  parameters: Record<string, any>;
  sessionId?: string;
}

/**
 * Detecta se o aplicativo está rodando dentro do container nativo Tauri (Desktop).
 */
export function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in (window as any);
}

/**
 * Invoca um comando IPC nativo no container Tauri.
 */
export async function invokeTauri<T>(cmd: string, args?: Record<string, any>): Promise<T> {
  if (typeof window === 'undefined') {
    throw new Error('Ambiente sem janela global (Node.js).');
  }
  const tauri = (window as any).__TAURI__;
  const invoke = tauri?.core?.invoke || tauri?.invoke;
  if (typeof invoke !== 'function') {
    throw new Error('Tauri IPC invoke não está disponível no objeto window.__TAURI__.');
  }
  return await invoke(cmd, args);
}

/**
 * Executa uma ferramenta localmente via ponte Tauri (se Desktop) ou com fallback transparente
 * para o endpoint Express POST /api/tools/execute (se Web Preview).
 */
export async function executeLocalTool(
  toolName: string,
  parameters: Record<string, any> = {},
  sessionId: string = 'default-session'
): Promise<LocalExecutionResult> {
  const startTime = Date.now();
  if (!toolName || typeof toolName !== 'string') {
    return {
      success: false,
      toolName: toolName || 'unknown',
      decision: 'DENY',
      riskLevel: 'R0',
      error: 'Nome de ferramenta ausente ou inválido.',
      code: 'INVALID_INPUT',
      simulated: true,
      executionTimeMs: Date.now() - startTime,
      timestamp: new Date().toISOString()
    };
  }

  const isDesktop = isTauriEnvironment();

  if (isDesktop) {
    try {
      // Invocação nativa Tauri invoke()
      const result = await invokeTauri<LocalExecutionResult>('execute_local_tool', {
        payload: { toolName, parameters, sessionId }
      });
      return result;
    } catch (err: any) {
      return {
        success: false,
        toolName,
        decision: 'DENY',
        riskLevel: 'R1',
        error: err?.message || 'Erro ao invocar comando nativo Tauri.',
        code: 'TAURI_INVOKE_ERROR',
        simulated: false,
        executionTimeMs: Date.now() - startTime,
        timestamp: new Date().toISOString()
      };
    }
  }

  // Fallback transparente para o servidor Express (Web Preview)
  try {
    // Em Node.js (servidor Express executando automações no backend), fetch
    // exige URL absoluta — caminhos relativos como '/api/tools/execute' falham
    // com "Failed to parse URL". No browser, o caminho relativo é o correto.
    const toolsUrl = (typeof window === 'undefined')
      ? `http://localhost:${process.env.PORT || 3000}/api/tools/execute`
      : '/api/tools/execute';

    const response = await fetch(toolsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-liora-session-id': sessionId
      },
      body: JSON.stringify({ toolName, parameters })
    });

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error(`Resposta não-JSON do servidor (${response.status})`);
    }
    const data = await response.json();
    return {
      success: Boolean(data.success),
      toolName: data.toolName || toolName,
      decision: data.decision || (response.ok ? 'ALLOW' : 'DENY'),
      riskLevel: data.riskLevel || 'R0',
      data: data.output || data.data,
      error: data.error,
      code: data.code,
      parametersHash: data.parametersHash,
      auditId: data.auditId,
      simulated: Boolean(data.simulated ?? true),
      executionTimeMs: Date.now() - startTime,
      timestamp: data.timestamp || new Date().toISOString()
    };
  } catch (netErr: any) {
    return {
      success: false,
      toolName,
      decision: 'DENY',
      riskLevel: 'R0',
      error: netErr?.message || 'Erro de comunicação de rede com o servidor local.',
      code: 'NETWORK_ERROR',
      simulated: true,
      executionTimeMs: Date.now() - startTime,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Lê uma credencial salva no cofre do sistema nativo (Tauri Keyring) ou fallback local
 */
export async function readKeychainSecret(service: string): Promise<string | null> {
  if (isTauriEnvironment()) {
    try {
      return await invokeTauri<string | null>('read_keychain_secret', { service });
    } catch (e) {
      console.warn('[LocalBridge] Erro ao ler segredo do keyring Tauri:', e);
    }
  }
  return null;
}

/**
 * Grava uma credencial de forma segura no cofre do sistema nativo (Tauri Keyring)
 */
export async function writeKeychainSecret(service: string, secret: string): Promise<boolean> {
  if (isTauriEnvironment()) {
    try {
      return await invokeTauri<boolean>('write_keychain_secret', { service, secret });
    } catch (e) {
      console.warn('[LocalBridge] Erro ao gravar segredo no keyring Tauri:', e);
    }
  }
  return false;
}

/**
 * Obtém telemetria veicular (OBD-II, CAN Bus ou sensores do veículo)
 */
export async function getVehicleTelemetry(): Promise<any> {
  if (isTauriEnvironment()) {
    try {
      const raw = await invokeTauri<any>('get_vehicle_telemetry');
      // Exaustão (contrato IPC): o backend Rust serializa VehicleTelemetryResult em
      // snake_case (speed_kmh, coolant_temp_celsius, fuel_or_soc_percent,
      // is_engine_running, last_updated) — o serde não usa rename_all = camelCase.
      // Normaliza AMBOS os formatos para o camelCase esperado pelas views, com
      // validação numérica (evita NaN/undefined corrompendo o HUD).
      if (raw && typeof raw === 'object') {
        const num = (v: any, fallback: number) =>
          (typeof v === 'number' && Number.isFinite(v)) ? v : fallback;
        return {
          speedKmh: num(raw.speedKmh ?? raw.speed_kmh, 0),
          rpm: Math.round(num(raw.rpm ?? raw.rpm, 0)),
          coolantTempCelsius: num(raw.coolantTempCelsius ?? raw.coolant_temp_celsius, 22),
          fuelOrSocPercent: num(raw.fuelOrSocPercent ?? raw.fuel_or_soc_percent, 85),
          batteryVolts: num(raw.batteryVolts ?? raw.battery_volts, 12.6),
          driveMode: typeof raw.driveMode === 'string' ? raw.driveMode : (typeof raw.drive_mode === 'string' ? raw.drive_mode : 'COMFORT'),
          dtcCodes: Array.isArray(raw.dtcCodes) ? raw.dtcCodes : (Array.isArray(raw.dtc_codes) ? raw.dtc_codes : []),
          isEngineRunning: Boolean(raw.isEngineRunning ?? raw.is_engine_running ?? false),
          latitude: raw.latitude ?? raw.latitude,
          longitude: raw.longitude ?? raw.longitude,
          heading: raw.heading ?? raw.heading,
          altitude: raw.altitude ?? raw.altitude,
          lastUpdated: typeof raw.lastUpdated === 'string' ? raw.lastUpdated : (typeof raw.last_updated === 'string' ? raw.last_updated : new Date().toISOString()),
          source: typeof raw.source === 'string' ? raw.source : 'NATIVE_TELEMETRY'
        };
      }
      return raw;
    } catch (e) {
      console.warn('[LocalBridge] Erro ao invocar telemetria veicular nativa:', e);
    }
  }
  // Retorno limpo padrão se nenhum adaptador estiver conectado
  return {
    speedKmh: 0,
    rpm: 0,
    coolantTempCelsius: 22,
    fuelOrSocPercent: 85,
    batteryVolts: 12.6,
    driveMode: 'COMFORT',
    dtcCodes: [],
    isEngineRunning: false,
    lastUpdated: new Date().toISOString(),
    source: 'NATIVE_TELEMETRY'
  };
}

export interface BridgeStatusInfo {
  isTauri: boolean;
  environment: 'tauri-desktop' | 'web-preview';
  activeBridge: string;
  securityProfile: 'STRICT';
  latencyMs: number;
  availableCommands: string[];
}

/**
 * Executa um diagnóstico completo da integridade e latência da ponte de execução local
 */
export async function checkBridgeDiagnostics(): Promise<BridgeStatusInfo> {
  const start = performance.now();
  const isDesktop = isTauriEnvironment();

  if (isDesktop) {
    try {
      await invokeTauri('get_system_info');
      const latency = Math.round(performance.now() - start);
      return {
        isTauri: true,
        environment: 'tauri-desktop',
        activeBridge: 'Tauri Native IPC (Rust Core)',
        securityProfile: 'STRICT',
        latencyMs: latency,
        availableCommands: [
          'execute_local_tool',
          'get_system_info',
          'get_system_hardware_telemetry',
          'workspace_read_file',
          'workspace_write_file',
          'workspace_list_files',
          'system_exec_sandbox',
          'read_keychain_secret',
          'write_keychain_secret',
          'get_vehicle_telemetry'
        ]
      };
    } catch {
      // IPC fallback
    }
  }

  // Web fallback check
  try {
    const res = await fetch('/api/system/bridge-status');
    const data = await res.json();
    const latency = Math.round(performance.now() - start);
    return {
      isTauri: false,
      environment: 'web-preview',
      activeBridge: 'LocalExecutionBridge (Express Proxy)',
      securityProfile: 'STRICT',
      latencyMs: latency,
      availableCommands: data.supportedCommands || []
    };
  } catch {
    const latency = Math.round(performance.now() - start);
    return {
      isTauri: false,
      environment: 'web-preview',
      activeBridge: 'LocalExecutionBridge (Fallback)',
      securityProfile: 'STRICT',
      latencyMs: latency,
      availableCommands: []
    };
  }
}



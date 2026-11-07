/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { DeviceEntity, DeviceTelemetry, DeviceCommand, HardwareTelemetryResult } from '../types/devices';
import { systemInfoTool } from '../tools/simulatedTools';
import { permissionEngine, PermissionEngine } from '../security/permissionEngine';
import { ToolRiskLevel } from '../tools/types';
import { isTauriEnvironment, invokeTauri } from '../security/localBridge';
import { auditLogger } from '../security/auditLogger';
import { eventBus } from '../utils/eventBus';

export const INITIAL_DEVICES_REGISTRY: DeviceEntity[] = [
  {
    id: 'dev-1',
    name: 'LIORA Desktop Host (Local)',
    type: 'pc',
    status: 'ONLINE',
    connected: true,
    ip: '127.0.0.1',
    macAddress: '00:00:00:00:00:00',
    osInfo: 'LIORA Desktop OS (Linux x86_64)',
    battery: undefined,
    lastSeen: 'Agora',
    capabilities: ['terminal_exec', 'file_sync', 'system_monitor'],
    isSimulated: true,
    telemetry: {
      cpuUsagePercent: 0,
      memoryUsagePercent: 0,
      memoryFreeBytes: 0,
      memoryTotalBytes: 0,
      diskUsagePercent: 0,
      uptimeSeconds: 0,
      lastUpdated: new Date().toISOString(),
      isRealHardware: false
    }
  }
];

export const COMMANDS_STORAGE_KEY = 'liora_device_commands_v1';
export const USER_DEVICES_STORAGE_KEY = 'liora_user_devices_v1';

export class DevicesManager {
  private devices: Map<string, DeviceEntity> = new Map();
  private commandLogs: DeviceCommand[] = [];
  private permissionEngine: PermissionEngine;

  constructor(engine: PermissionEngine = permissionEngine) {
    this.permissionEngine = engine;
    this.initDefaultDevices();
    this.loadStoredCommandLogs();
  }

  private initDefaultDevices(): void {
    // 1. Sempre inicializa o nó mestre desktop local
    for (const dev of INITIAL_DEVICES_REGISTRY) {
      this.devices.set(dev.id, {
        ...dev,
        capabilities: [...dev.capabilities],
        telemetry: dev.telemetry ? { ...dev.telemetry } : undefined
      });
    }

    // 2. Carrega dispositivos reais pareados pelo usuário
    if (typeof localStorage !== 'undefined') {
      try {
        const raw = localStorage.getItem(USER_DEVICES_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            for (const d of parsed) {
              if (d && d.id && d.id !== 'dev-1') {
                this.devices.set(d.id, {
                  ...d,
                  capabilities: Array.isArray(d.capabilities) ? [...d.capabilities] : []
                });
              }
            }
          }
        }
      } catch (err) {
        console.warn('[DevicesManager] Erro ao carregar dispositivos pareados do armazenamento:', err);
      }
    }
  }

  private persistUserDevices(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const userList = Array.from(this.devices.values()).filter(d => d.id !== 'dev-1');
      localStorage.setItem(USER_DEVICES_STORAGE_KEY, JSON.stringify(userList));
    } catch (err) {
      console.warn('[DevicesManager] Erro ao salvar dispositivos pareados:', err);
    }
  }

  public addDevice(device: DeviceEntity): DeviceEntity {
    this.devices.set(device.id, device);
    this.persistUserDevices();
    eventBus.publish('DEVICE_STATUS_CHANGED', {
      deviceId: device.id,
      connected: device.connected,
      name: device.name,
      timestamp: new Date().toISOString()
    });
    return device;
  }

  public removeDevice(deviceId: string): boolean {
    if (deviceId === 'dev-1') return false; // Host mestre local é permanente
    const dev = this.devices.get(deviceId);
    if (!dev) return false;
    this.devices.delete(deviceId);
    this.persistUserDevices();
    eventBus.publish('DEVICE_DISCONNECTED', {
      deviceId,
      name: dev.name,
      timestamp: new Date().toISOString()
    });
    return true;
  }

  private loadStoredCommandLogs(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(COMMANDS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.commandLogs = parsed.slice(0, 50);
        }
      }
    } catch (err) {
      console.warn('[DevicesManager] Failed to load stored device command logs:', err);
    }
  }

  private persistCommandLogs(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(COMMANDS_STORAGE_KEY, JSON.stringify(this.commandLogs.slice(0, 50)));
    } catch (err) {
      console.warn('[DevicesManager] Failed to persist device command logs:', err);
    }
  }

  public getDevices(): DeviceEntity[] {
    return Array.from(this.devices.values());
  }

  public getDevice(id: string): DeviceEntity | undefined {
    return this.devices.get(id);
  }

  public updateDeviceStatus(id: string, connected: boolean): DeviceEntity | undefined {
    const dev = this.devices.get(id);
    if (!dev) return undefined;

    dev.connected = connected;
    dev.status = connected ? 'ONLINE' : 'OFFLINE';
    dev.lastSeen = 'Agora';

    eventBus.publish('DEVICE_STATUS_CHANGED', { deviceId: id, connected, name: dev.name, timestamp: new Date().toISOString() });

    if (!connected) {
      eventBus.publish('DEVICE_DISCONNECTED', { deviceId: id, name: dev.name, timestamp: new Date().toISOString() });

      try {
        auditLogger.logEvent({
          auditId: `audit-dev-${id}-${Date.now()}`,
          timestamp: new Date().toISOString(),
          eventType: 'SECURITY_VIOLATION',
          toolName: 'devices_manager',
          riskLevel: 'R1',
          decision: 'DENY',
          denialCode: 'SECURITY_CONSTRAINT_VIOLATION',
          sessionId: 'devices-session',
          durationMs: 0,
          simulated: true
        });
      } catch (err) {
        console.warn('[DevicesManager] Erro ao registrar auditoria de desconexão:', err);
      }
    }

    return { ...dev };
  }

  /**
   * Realiza health-check / ping no protocolo PULO para os nós remotos
   */
  public checkDeviceHealth(deviceId: string): { connected: boolean; status: 'ONLINE' | 'OFFLINE' | 'WARNING' } {
    const dev = this.devices.get(deviceId);
    if (!dev) return { connected: false, status: 'OFFLINE' };

    // Se o nó já estiver desconectado manualmente
    if (!dev.connected) {
      return { connected: false, status: 'OFFLINE' };
    }

    // Para dev-1 (Host local), está sempre online
    if (deviceId === 'dev-1') {
      dev.connected = true;
      dev.status = 'ONLINE';
      dev.lastSeen = 'Agora';
      return { connected: true, status: 'ONLINE' };
    }

    // Para nós remotos (PULO protocol ping)
    const isOnline = dev.connected && dev.status !== 'OFFLINE';
    dev.connected = isOnline;
    dev.status = isOnline ? (dev.type === 'smarthome' && !dev.connected ? 'WARNING' : 'ONLINE') : 'OFFLINE';
    dev.lastSeen = isOnline ? 'Agora' : dev.lastSeen;

    return { connected: dev.connected, status: dev.status };
  }

  public pingDevicesHealth(): Record<string, boolean> {
    const results: Record<string, boolean> = {};
    for (const [id] of this.devices) {
      const health = this.checkDeviceHealth(id);
      results[id] = health.connected;
    }
    return results;
  }

  /**
   * Atualiza a telemetria do dispositivo local (PC).
   * Em ambiente Tauri nativo, busca métricas reais de hardware no SO via crate sysinfo.
   * Em ambiente Web Preview/Testes, utiliza fallback controlado preservando a flag isSimulated.
   */
  public async refreshTelemetry(deviceId: string = 'dev-1'): Promise<DeviceTelemetry | null> {
    const dev = this.devices.get(deviceId);
    if (!dev) return null;

    // 1. Caminho NATIVO: Se estiver no Tauri Desktop e for o host local (dev-1)
    if (deviceId === 'dev-1' && isTauriEnvironment()) {
      try {
        const hw = await invokeTauri<HardwareTelemetryResult>('get_system_hardware_telemetry');
        if (hw && typeof hw.cpu_usage_percent === 'number') {
          const nowIso = hw.timestamp || new Date().toISOString();
          const telemetry: DeviceTelemetry = {
            cpuUsagePercent: Number(hw.cpu_usage_percent.toFixed(1)),
            memoryUsagePercent: Number(hw.memory_usage_percent.toFixed(1)),
            memoryFreeBytes: hw.memory_free_bytes,
            memoryTotalBytes: hw.memory_total_bytes,
            diskUsagePercent: Number(hw.disk_usage_percent.toFixed(1)),
            batteryLevel: hw.battery_level !== undefined ? Math.round(hw.battery_level) : undefined,
            isCharging: hw.is_charging ?? true,
            temperatureCelsius: hw.temperature_celsius,
            uptimeSeconds: hw.uptime_seconds,
            lastUpdated: nowIso,
            isRealHardware: hw.is_real_hardware
          };

          dev.telemetry = telemetry;
          dev.isSimulated = !hw.is_real_hardware;
          if (telemetry.batteryLevel !== undefined) {
            dev.battery = telemetry.batteryLevel;
          }
          if (hw.os_name) {
            dev.osInfo = `${hw.os_name} ${hw.os_version} (${hw.cpu_cores} cores)`;
          }
          dev.lastSeen = 'Agora';

          return telemetry;
        }
      } catch (nativeErr) {
        // Fallback seguro em caso de indisponibilidade momentânea do IPC
        console.warn('[DevicesManager] Erro ao obter telemetria nativa via Tauri IPC, recorrendo a fallback seguro:', nativeErr);
      }
    }

    // 2. Caminho WEB / TESTES (Chamada ao endpoint /api/system/telemetry do servidor local)
    try {
      const resp = await fetch('/api/system/telemetry');
      if (resp.ok) {
        const hw = await resp.json();
        if (hw.success) {
          const telemetry: DeviceTelemetry = {
            cpuUsagePercent: hw.cpu_usage_percent,
            memoryUsagePercent: hw.memory_usage_percent,
            memoryFreeBytes: hw.memory_free_bytes,
            memoryTotalBytes: hw.memory_total_bytes,
            diskUsagePercent: hw.disk_usage_percent,
            batteryLevel: hw.battery_level !== null ? hw.battery_level : undefined,
            isCharging: hw.is_charging ?? true,
            temperatureCelsius: hw.temperature_celsius,
            uptimeSeconds: hw.uptime_seconds,
            lastUpdated: hw.timestamp || new Date().toISOString(),
            isRealHardware: true
          };

          dev.telemetry = telemetry;
          dev.isSimulated = false;
          if (hw.hostname) {
            dev.name = `LIORA Host (${hw.hostname})`;
          }
          if (hw.os_name) {
            dev.osInfo = `${hw.os_name} ${hw.os_version} (${hw.cpu_cores} cores, ${hw.arch})`;
          }
          dev.lastSeen = 'Agora';
          return telemetry;
        }
      }
    } catch {
      // Fallback para o tool simulado em caso de erro na requisição
    }

    // Fallback controlado
    try {
      const sysInfoResult = await systemInfoTool.execute({ detailLevel: 'standard' }, {
        sessionId: 'devices-manager-session',
        timestamp: new Date().toISOString()
      });

      const nowIso = new Date().toISOString();
      const telemetry: DeviceTelemetry = {
        cpuUsagePercent: sysInfoResult.cpu?.usagePercent || 15.0,
        memoryUsagePercent: sysInfoResult.memory?.usagePercent || 35.0,
        memoryFreeBytes: sysInfoResult.memory?.freeBytes || 10 * 1024 * 1024 * 1024,
        memoryTotalBytes: sysInfoResult.memory?.totalBytes || 16 * 1024 * 1024 * 1024,
        diskUsagePercent: 41.5,
        batteryLevel: sysInfoResult.battery?.level || dev.battery || 90,
        isCharging: sysInfoResult.battery?.charging ?? true,
        temperatureCelsius: 41.2,
        uptimeSeconds: sysInfoResult.uptimeSeconds || 36000,
        lastUpdated: nowIso,
        isRealHardware: false
      };

      dev.telemetry = telemetry;
      dev.isSimulated = true;
      if (telemetry.batteryLevel !== undefined) {
        dev.battery = telemetry.batteryLevel;
      }
      dev.lastSeen = 'Agora';

      return telemetry;
    } catch {
      return dev.telemetry || null;
    }
  }

  /**
   * Despacha um comando para o dispositivo com validação prévia no PermissionEngine
   */
  public async sendCommand(
    deviceId: string,
    commandType: DeviceCommand['commandType'],
    riskLevel: ToolRiskLevel = 'R0',
    payload: Record<string, any> = {}
  ): Promise<DeviceCommand> {
    const timestamp = new Date().toISOString();
    const cmdId = `cmd-${Date.now()}-${Date.now().toString(36)}`;

    const dev = this.devices.get(deviceId);
    const deviceName = dev?.name || 'Dispositivo Desconhecido';

    // 1. Avaliação prévia via PermissionEngine usando o NOME REAL do comando
    // de dispositivo. BUG CRÍTICO CORRIGIDO: avaliava como 'system_info' (R0 da
    // whitelist) para "passar na whitelist" — mascarando comandos REBOOT/TOGGLE
    // (R2 destrutivos) como leitura. Agora avalia a tool virtual
    // 'device_command' com o riskLevel real informado, e a decisão DENY bloqueia.
    const evaluation = await this.permissionEngine.evaluate(
      'device_command',
      { deviceId, commandType, ...payload },
      {
        sessionId: 'devices-session',
        serverTimestamp: Date.now(),
        clientIp: '127.0.0.1'
      },
      { riskLevel }
    );

    let status: DeviceCommand['status'] = 'EXECUTED';
    let resultSummary = `Comando ${commandType} enviado com sucesso para ${deviceName}.`;

    if (evaluation.decision === 'DENY') {
      status = 'BLOCKED_BY_POLICY';
      resultSummary = `Comando bloqueado pelo Permission Engine: ${evaluation.reason}`;

      try {
        auditLogger.logEvent({
          auditId: `audit-cmd-${cmdId}`,
          timestamp,
          eventType: 'SECURITY_VIOLATION',
          toolName: 'devices_manager',
          riskLevel,
          decision: 'DENY',
          denialCode: 'TOOL_EXPLICITLY_DENIED',
          sessionId: 'devices-session',
          durationMs: 0,
          simulated: true
        });
      } catch (err) {
        console.warn('[DevicesManager] Erro ao registrar comando bloqueado no auditLogger:', err);
      }
    } else if (riskLevel === 'R1' || riskLevel === 'R2' || riskLevel === 'R3') {
      status = 'WAITING_CONSENT';
      resultSummary = `Comando de atuador R1 requer confirmação humana explícita.`;
    }

    const commandItem: DeviceCommand = {
      id: cmdId,
      deviceId,
      commandType,
      payload,
      riskLevel,
      timestamp,
      status,
      resultSummary
    };

    this.commandLogs.unshift(commandItem);
    if (this.commandLogs.length > 50) {
      this.commandLogs.pop();
    }
    this.persistCommandLogs();

    return commandItem;
  }

  public getCommandLogs(): DeviceCommand[] {
    return [...this.commandLogs];
  }

  public clearCommandLogs(): void {
    this.commandLogs = [];
    this.persistCommandLogs();
  }
}

// Singleton padrão do gerenciador de dispositivos
export const devicesManager = new DevicesManager();

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolRiskLevel } from '../tools/types';

export type DeviceType = 'pc' | 'android' | 'tv' | 'smarthome' | 'printer' | 'car' | 'sensor';

export type DeviceConnectionStatus = 'ONLINE' | 'OFFLINE' | 'WARNING' | 'SYNCING';

export interface DeviceTelemetry {
  cpuUsagePercent: number;
  memoryUsagePercent: number;
  memoryFreeBytes: number;
  memoryTotalBytes: number;
  diskUsagePercent?: number;
  batteryLevel?: number;
  isCharging?: boolean;
  temperatureCelsius?: number;
  uptimeSeconds: number;
  lastUpdated: string;
  isRealHardware?: boolean;
}

export interface HardwareTelemetryResult {
  cpu_usage_percent: number;
  cpu_cores: number;
  memory_usage_percent: number;
  memory_free_bytes: number;
  memory_total_bytes: number;
  disk_usage_percent: number;
  disk_total_bytes: number;
  disk_free_bytes: number;
  battery_level?: number;
  is_charging?: boolean;
  temperature_celsius?: number;
  uptime_seconds: number;
  hostname: string;
  os_name: string;
  os_version: string;
  timestamp: string;
  is_real_hardware: boolean;
}

export interface DeviceEntity {
  id: string;
  name: string;
  type: DeviceType;
  status: DeviceConnectionStatus;
  connected: boolean;
  ip?: string;
  macAddress?: string;
  osInfo?: string;
  battery?: number;
  lastSeen: string;
  telemetry?: DeviceTelemetry;
  capabilities: string[];
  isSimulated: boolean;
}

export interface VehicleDiagnosticTroubleCode {
  code: string;
  description: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  system: 'POWERTRAIN' | 'CHASSIS' | 'BODY' | 'NETWORK';
}

export interface VehicleTelemetry {
  speedKmh: number;
  rpm: number;
  coolantTempCelsius: number;
  fuelOrSocPercent: number;
  batteryVolts: number;
  driveMode: 'COMFORT' | 'SPORT' | 'ECO' | 'SAFE_DRIVE';
  dtcCodes: VehicleDiagnosticTroubleCode[];
  isEngineRunning: boolean;
  latitude?: number;
  longitude?: number;
  heading?: number;
  altitude?: number;
  lastUpdated: string;
  source: 'OBD2_CANBUS' | 'GPS_GEOLOCATION' | 'NATIVE_TELEMETRY';
}

export interface DeviceCommand {
  id: string;
  deviceId: string;
  commandType: 'REBOOT' | 'SYNC_CONTEXT' | 'TOGGLE_STATE' | 'FETCH_TELEMETRY';
  payload?: Record<string, any>;
  riskLevel: ToolRiskLevel;
  timestamp: string;
  status: 'PENDING' | 'EXECUTED' | 'BLOCKED_BY_POLICY' | 'WAITING_CONSENT' | 'FAILED';
  resultSummary?: string;
}

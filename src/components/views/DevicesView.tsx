/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { useLioraStore } from '../../store/lioraStore';
import { 
  Smartphone, 
  Laptop, 
  Tv, 
  Home, 
  Printer, 
  RefreshCw, 
  Wifi, 
  Cpu, 
  HardDrive, 
  BatteryCharging, 
  ShieldCheck, 
  Terminal, 
  Activity, 
  CheckCircle2, 
  AlertTriangle, 
  Power, 
  Send,
  X,
  Lock,
  Plus,
  Trash2,
  Car,
  Gauge,
  Layers,
  Radio
} from 'lucide-react';
import { DeviceEntity, DeviceType } from '../../types/devices';
import { ToolRiskLevel } from '../../types';
import { DevicePairingModal } from '../devices/DevicePairingModal';
import { checkBridgeDiagnostics, BridgeStatusInfo } from '../../security/localBridge';

export const DevicesView: React.FC = () => {
  const { 
    devices, 
    deviceCommands, 
    updateDeviceStatus, 
    removeDevice,
    refreshDeviceTelemetry, 
    sendDeviceCommand,
    pingDevicesHealth,
    setActiveTab
  } = useLioraStore();

  const [selectedDevice, setSelectedDevice] = useState<DeviceEntity | null>(devices[0] || null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isPairingModalOpen, setIsPairingModalOpen] = useState(false);
  const [commandFeedback, setCommandFeedback] = useState<string | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatusInfo | null>(null);
  const [isTestingBridge, setIsTestingBridge] = useState(false);

  // Modal de consentimento para comandos R1+
  const [pendingConsentCommand, setPendingConsentCommand] = useState<{
    deviceId: string;
    deviceName: string;
    commandType: 'REBOOT' | 'SYNC_CONTEXT' | 'TOGGLE_STATE' | 'FETCH_TELEMETRY';
    riskLevel: ToolRiskLevel;
  } | null>(null);

  const runBridgeTest = async () => {
    setIsTestingBridge(true);
    try {
      const diag = await checkBridgeDiagnostics();
      setBridgeStatus(diag);
      setCommandFeedback(`Ponte validada: ${diag.activeBridge} (${diag.latencyMs}ms de latência)`);
    } catch {
      setCommandFeedback('Falha ao comunicar com a ponte local.');
    } finally {
      setIsTestingBridge(false);
      setTimeout(() => setCommandFeedback(null), 4000);
    }
  };

  // Polling automático de telemetria e checagem inicial da ponte IPC
  useEffect(() => {
    refreshDeviceTelemetry('dev-1');
    pingDevicesHealth();
    runBridgeTest();

    const interval = setInterval(() => {
      refreshDeviceTelemetry('dev-1');
      pingDevicesHealth();
    }, 4000);

    return () => clearInterval(interval);
  }, [refreshDeviceTelemetry, pingDevicesHealth]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await refreshDeviceTelemetry('dev-1');
      pingDevicesHealth();
      await runBridgeTest();
    } finally {
      setTimeout(() => setIsRefreshing(false), 500);
    }
  };

  const handleCommandClick = (
    deviceId: string, 
    commandType: 'REBOOT' | 'SYNC_CONTEXT' | 'TOGGLE_STATE' | 'FETCH_TELEMETRY', 
    riskLevel: ToolRiskLevel = 'R0'
  ) => {
    const dev = devices.find(d => d.id === deviceId);
    const deviceName = dev?.name || deviceId;

    // Comandos de Risco R1+ exigem modal de consentimento explícito
    if (riskLevel === 'R1' || riskLevel === 'R2' || riskLevel === 'R3') {
      setPendingConsentCommand({
        deviceId,
        deviceName,
        commandType,
        riskLevel
      });
      return;
    }

    // Comandos R0 disparam imediatamente
    executeCommandDispatch(deviceId, commandType, riskLevel);
  };

  const executeCommandDispatch = async (
    deviceId: string, 
    commandType: 'REBOOT' | 'SYNC_CONTEXT' | 'TOGGLE_STATE' | 'FETCH_TELEMETRY', 
    riskLevel: ToolRiskLevel
  ) => {
    setCommandFeedback(null);
    try {
      const res = await sendDeviceCommand(deviceId, commandType, riskLevel);
      if (res.status === 'EXECUTED') {
        setCommandFeedback(`Comando ${commandType} executado com sucesso.`);
      } else if (res.status === 'BLOCKED_BY_POLICY') {
        setCommandFeedback(`Comando bloqueado pelo Permission Engine: ${res.resultSummary}`);
      } else if (res.status === 'WAITING_CONSENT') {
        setCommandFeedback(`Comando enviado para fila de consentimento do operador.`);
      } else {
        setCommandFeedback(`Comando despachado: ${res.resultSummary}`);
      }
    } catch {
      setCommandFeedback('Erro ao despachar comando para o dispositivo.');
    } finally {
      setTimeout(() => setCommandFeedback(null), 4000);
    }
  };

  const getDeviceIcon = (type: DeviceType) => {
    switch (type) {
      case 'pc': return <Laptop className="w-5 h-5 text-[var(--accent-primary)]" />;
      case 'android': return <Smartphone className="w-5 h-5 text-blue-400" />;
      case 'tv': return <Tv className="w-5 h-5 text-purple-400" />;
      case 'smarthome': return <Home className="w-5 h-5 text-emerald-400" />;
      case 'printer': return <Printer className="w-5 h-5 text-amber-400" />;
      case 'car': return <Car className="w-5 h-5 text-[var(--accent-primary)]" />;
      default: return <Wifi className="w-5 h-5 text-gray-400" />;
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-y-auto p-4 sm:p-6 md:p-8 space-y-6 max-w-6xl mx-auto w-full">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-display font-bold text-white">Dispositivos, Hardware & Telemetria</h2>
            <span className="px-2.5 py-0.5 rounded text-[10px] font-mono uppercase bg-[#141414] border border-[#222222] text-[#A8A8A8]">
              Marco 9.2 • Hardware Ativo
            </span>
          </div>
          <p className="text-xs sm:text-sm text-[#A8A8A8] mt-1">
            Monitoramento em tempo real (polling 4s), protocolo PULO cross-device e governança de atuadores via Permission Engine.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button 
            type="button"
            onClick={() => setIsPairingModalOpen(true)}
            className="px-4 py-2 bg-[var(--accent-primary)] hover:opacity-90 rounded-xl text-xs font-bold text-white flex items-center gap-2 transition-all shadow-md shadow-[var(--accent-glow)] shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span>+ Conectar Dispositivo</span>
          </button>

          <button 
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="px-4 py-2 bg-[#171717] hover:bg-[#222222] border border-[#333333] rounded-xl text-xs font-semibold text-white flex items-center gap-2 transition-colors disabled:opacity-50 shrink-0"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-[var(--accent-primary)]' : ''}`} />
            <span>{isRefreshing ? 'Atualizando...' : 'Atualizar Telemetria'}</span>
          </button>
        </div>
      </div>

      {/* Ponte Nativa & Diagnóstico Tauri IPC (Passo 4 do Plano Mestre) */}
      <div className="bg-[#111111] border border-[#222222] rounded-2xl p-5 shadow-xl space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-[#1E1E1E] pb-3 gap-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-[var(--accent-bg)] border border-[var(--accent-border)] rounded-xl text-[var(--accent-primary)]">
              <Radio className="w-4 h-4 animate-pulse" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <span>Ponte de Execução Local & Despachante IPC</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#171717] border border-[#2B2B2B] text-[#A8A8A8]">
                  Passo 4 • Rust Core
                </span>
              </h3>
              <p className="text-xs text-[#888888]">
                Canal seguro de comandos nativos do sistema operacional em conformidade com Zero Trust.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span className={`px-2.5 py-1 rounded-xl text-[10px] font-mono font-bold uppercase border ${
              bridgeStatus?.isTauri
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                : 'bg-amber-500/10 border-amber-500/30 text-amber-400'
            }`}>
              {bridgeStatus?.isTauri ? '● TAURI DESKTOP NATIVO (RUST CORE)' : '○ WEB PREVIEW (SIMULADO / PROXY)'}
            </span>

            <button
              onClick={runBridgeTest}
              disabled={isTestingBridge}
              className="px-3 py-1.5 bg-[#171717] hover:bg-[#222222] border border-[#2E2E2E] rounded-xl text-xs font-mono text-[#CCCCCC] hover:text-white flex items-center gap-1.5 transition-colors disabled:opacity-50"
              title="Testar resposta e latência da ponte IPC"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isTestingBridge ? 'animate-spin text-[var(--accent-primary)]' : ''}`} />
              <span>{isTestingBridge ? 'Testando...' : 'Testar IPC'}</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 text-xs font-mono">
          <div className="p-3 bg-[#141414] rounded-xl border border-[#222222] space-y-1">
            <span className="text-[10px] text-[#777777] uppercase">Ponte Ativa</span>
            <p className="text-white font-bold truncate">{bridgeStatus?.activeBridge || 'LocalExecutionBridge'}</p>
          </div>

          <div className="p-3 bg-[#141414] rounded-xl border border-[#222222] space-y-1">
            <span className="text-[10px] text-[#777777] uppercase">Latência IPC / Despacho</span>
            <p className="text-emerald-400 font-bold">
              {bridgeStatus ? `${bridgeStatus.latencyMs} ms` : 'Verificando...'}
            </p>
          </div>

          <div className="p-3 bg-[#141414] rounded-xl border border-[#222222] space-y-1">
            <span className="text-[10px] text-[#777777] uppercase">Perfil de Segurança</span>
            <p className="text-[var(--accent-primary)] font-bold">{bridgeStatus?.securityProfile || 'STRICT (Zero Trust)'}</p>
          </div>

          <div className="p-3 bg-[#141414] rounded-xl border border-[#222222] space-y-1">
            <span className="text-[10px] text-[#777777] uppercase">Comandos Rust Mapeados</span>
            <p className="text-blue-400 font-bold">{bridgeStatus?.availableCommands?.length || 10} Comandos IPC</p>
          </div>
        </div>
      </div>

      {/* Local Host Hardware Telemetry Banner (dev-1) */}
      {devices.find(d => d.id === 'dev-1')?.telemetry && (() => {
        const hostDev = devices.find(d => d.id === 'dev-1')!;
        const tel = hostDev.telemetry!;
        const isReal = hostDev.isSimulated === false || tel.isRealHardware === true;
        const freeGb = (tel.memoryFreeBytes / (1024 * 1024 * 1024)).toFixed(1);
        const totalGb = Math.max(1, Math.round(tel.memoryTotalBytes / (1024 * 1024 * 1024)));

        return (
          <div className="bg-[#111111] border border-[#222222] rounded-2xl p-5 sm:p-6 space-y-4 shadow-xl">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-[#1E1E1E] pb-3 gap-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-[#888888]">Status da Telemetria Host:</span>
                <span className={`px-2.5 py-0.5 rounded text-[10px] font-mono font-semibold uppercase ${
                  isReal 
                    ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400' 
                    : 'bg-amber-500/10 border border-amber-500/30 text-amber-400'
                }`}>
                  {isReal ? '● NATIVO REAL • SYSINFO (RUST IPC)' : '○ SIMULADO / PREVIEW (MOCK SEGURO)'}
                </span>
              </div>
              <span className="text-[10px] font-mono text-[#666666]">
                Polling Ativo: {new Date(tel.lastUpdated).toLocaleTimeString()}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
              <div className="flex items-center gap-4 bg-[#141414] p-3.5 rounded-xl border border-[#222222]">
                <div className="p-3 bg-[#171717] border border-[#2E2E2E] rounded-xl text-[var(--accent-primary)]">
                  <Cpu className="w-6 h-6" />
                </div>
                <div>
                  <span className="text-xs text-[#888888] uppercase font-mono">Uso de CPU</span>
                  <h3 className="text-xl font-bold text-white mt-0.5 font-mono">{tel.cpuUsagePercent}%</h3>
                  <span className="text-[10px] text-emerald-400 font-mono">
                    {tel.cpuUsagePercent < 75 ? 'Operação Nominal' : 'Carga Elevada'}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-4 bg-[#141414] p-3.5 rounded-xl border border-[#222222]">
                <div className="p-3 bg-[#171717] border border-[#2E2E2E] rounded-xl text-blue-400">
                  <HardDrive className="w-6 h-6" />
                </div>
                <div>
                  <span className="text-xs text-[#888888] uppercase font-mono">Memória RAM</span>
                  <h3 className="text-xl font-bold text-white mt-0.5 font-mono">{tel.memoryUsagePercent}%</h3>
                  <span className="text-[10px] text-[#A8A8A8] font-mono">
                    {freeGb} GB livres / {totalGb} GB
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-4 bg-[#141414] p-3.5 rounded-xl border border-[#222222]">
                <div className="p-3 bg-[#171717] border border-[#2E2E2E] rounded-xl text-emerald-400">
                  <BatteryCharging className="w-6 h-6" />
                </div>
                <div>
                  <span className="text-xs text-[#888888] uppercase font-mono">Bateria / Energia</span>
                  <h3 className="text-xl font-bold text-white mt-0.5 font-mono">{tel.batteryLevel ?? 100}%</h3>
                  <span className="text-[10px] text-emerald-400 font-mono">
                    {tel.isCharging ? 'Conectado à tomada (AC)' : 'Em bateria'}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-4 bg-[#141414] p-3.5 rounded-xl border border-[#222222]">
                <div className="p-3 bg-[#171717] border border-[#2E2E2E] rounded-xl text-amber-400">
                  <Activity className="w-6 h-6" />
                </div>
                <div>
                  <span className="text-xs text-[#888888] uppercase font-mono">Uptime do Sistema</span>
                  <h3 className="text-xl font-bold text-white mt-0.5 font-mono">
                    {Math.floor(tel.uptimeSeconds / 3600)}h {Math.floor((tel.uptimeSeconds % 3600) / 60)}m
                  </h3>
                  <span className="text-[10px] text-[#A8A8A8] font-mono">Estável</span>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Devices Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {devices.map((dev) => {
          const isSelected = selectedDevice?.id === dev.id;
          const isHost = dev.id === 'dev-1';

          return (
            <div 
              key={dev.id} 
              onClick={() => setSelectedDevice(dev)}
              className={`bg-[#111111] border rounded-2xl p-5 flex flex-col justify-between cursor-pointer transition-all shadow-lg relative group ${
                isSelected ? 'border-[var(--accent-primary)] shadow-lg shadow-[var(--accent-glow)]' : 'border-[#222222] hover:border-[#333333]'
              }`}
            >
              <div>
                <div className="flex items-center justify-between">
                  <div className="p-3 bg-[#171717] border border-[#2E2E2E] rounded-xl">
                    {getDeviceIcon(dev.type)}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {isHost ? (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-mono border bg-white/10 border-white/20 text-white font-bold">
                        MESTRE
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-mono border bg-blue-500/10 border-blue-500/30 text-blue-400 font-bold">
                        PULO • R1
                      </span>
                    )}

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        updateDeviceStatus(dev.id, !dev.connected);
                      }}
                      className={`px-2.5 py-1 rounded-full text-[10px] font-mono border transition-all ${
                        dev.connected 
                          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' 
                          : 'bg-[#1A1A1A] border-[#333333] text-[#888888]'
                      }`}
                    >
                      {dev.connected ? '● Online' : '○ Offline'}
                    </button>
                  </div>
                </div>

                <h3 className="mt-4 font-semibold text-white text-base truncate">{dev.name}</h3>
                <div className="mt-2 space-y-1 text-xs text-[#888888] font-mono">
                  {dev.ip && <div>IP: {dev.ip}</div>}
                  {dev.battery !== undefined && <div>Bateria: {dev.battery}%</div>}
                  <div>Contato: {dev.lastSeen}</div>
                </div>
              </div>

              <div className="mt-5 pt-3 border-t border-[#222222] flex items-center justify-between">
                <span className="text-[10px] font-mono text-[#A8A8A8]">ID: {dev.id}</span>
                <div className="flex items-center gap-2">
                  {!isHost && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeDevice(dev.id);
                        if (selectedDevice?.id === dev.id) {
                          setSelectedDevice(devices[0] || null);
                        }
                      }}
                      title="Desconectar e remover dispositivo"
                      className="p-1 text-[#666666] hover:text-red-400 hover:bg-[#1C1C1C] rounded transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <span className="text-xs font-semibold text-[var(--accent-primary)]">Selecionar</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Selected Device Control & Command Center */}
      {selectedDevice && (
        <div className="bg-[#111111] border border-[#222222] rounded-2xl p-5 sm:p-6 space-y-5 shadow-xl">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-[#222222] pb-4 gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-[#171717] border border-[#2E2E2E] rounded-xl text-[var(--accent-primary)]">
                {getDeviceIcon(selectedDevice.type)}
              </div>
              <div>
                <h3 className="font-bold text-white text-base">Gerenciamento: {selectedDevice.name}</h3>
                <p className="text-xs text-[#888888] font-mono">
                  OS: {selectedDevice.osInfo || 'Desconhecido'} • IP: {selectedDevice.ip || 'N/A'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0 flex-wrap">
              <button
                onClick={() => handleCommandClick(selectedDevice.id, 'FETCH_TELEMETRY', 'R0')}
                className="px-3 py-2 bg-[#171717] hover:bg-[#222222] border border-[#2E2E2E] rounded-xl text-xs font-mono text-white flex items-center gap-1.5 transition-colors"
              >
                <Activity className="w-3.5 h-3.5 text-blue-400" />
                <span>Sincronizar (R0)</span>
              </button>

              <button
                onClick={() => handleCommandClick(selectedDevice.id, 'REBOOT', 'R1')}
                className="px-3 py-2 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 rounded-xl text-xs font-mono text-amber-400 flex items-center gap-1.5 transition-colors"
                title="Requer confirmação de risco R1"
              >
                <Power className="w-3.5 h-3.5" />
                <span>Reiniciar Atuador (R1)</span>
              </button>

              {selectedDevice.type === 'car' && (
                <button
                  type="button"
                  onClick={() => setActiveTab('cockpit')}
                  className="px-3.5 py-2 bg-[var(--accent-primary)] hover:opacity-90 rounded-xl text-xs font-mono font-bold text-white flex items-center gap-1.5 transition-all shadow-md shadow-[var(--accent-glow)]"
                >
                  <Gauge className="w-3.5 h-3.5" />
                  <span>Abrir Cockpit HUD Veicular</span>
                </button>
              )}

              {selectedDevice.id !== 'dev-1' && (
                <button
                  type="button"
                  onClick={() => {
                    removeDevice(selectedDevice.id);
                    setSelectedDevice(devices[0] || null);
                  }}
                  className="px-3 py-2 bg-red-950/50 hover:bg-red-900/70 border border-red-800/60 rounded-xl text-xs font-mono text-red-300 flex items-center gap-1.5 transition-colors"
                  title="Encerrar vínculo e remover do registro PULO"
                >
                  <Trash2 className="w-3.5 h-3.5 text-red-400" />
                  <span>Desconectar Nó</span>
                </button>
              )}
            </div>
          </div>

          {commandFeedback && (
            <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-xl text-xs font-mono text-blue-300">
              {commandFeedback}
            </div>
          )}

          {/* Capabilities */}
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-[#A8A8A8] block mb-2">
              Capacidades Suportadas pelo Dispositivo
            </span>
            <div className="flex flex-wrap gap-2">
              {selectedDevice.capabilities.map((cap, idx) => (
                <span key={idx} className="px-3 py-1 bg-[#171717] border border-[#2A2A2A] rounded-xl text-xs font-mono text-white">
                  {cap}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Command History Logs */}
      <div className="space-y-4 pt-4 border-t border-[#222222]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-[var(--accent-primary)]" />
            <h3 className="text-base font-bold text-white">Histórico de Comandos de Hardware</h3>
          </div>
          <span className="text-xs font-mono text-[#888888]">
            {deviceCommands.length} comandos registrados
          </span>
        </div>

        {deviceCommands.length === 0 ? (
          <div className="bg-[#111111] border border-[#222222] rounded-2xl p-8 text-center text-xs text-[#888888]">
            Nenhum comando enviado para dispositivos ainda.
          </div>
        ) : (
          <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
            {deviceCommands.slice(0, 15).map((cmd) => (
              <div 
                key={cmd.id}
                className="bg-[#141414] border border-[#222222] rounded-xl px-4 py-3 flex items-center justify-between text-xs"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${
                    cmd.status === 'EXECUTED' ? 'bg-emerald-400' :
                    cmd.status === 'WAITING_CONSENT' ? 'bg-amber-400' :
                    'bg-red-400'
                  }`} />
                  <div className="min-w-0">
                    <span className="font-semibold text-white uppercase">{cmd.commandType}</span>
                    <span className="ml-2 font-mono text-[#888888]">Device: {cmd.deviceId}</span>
                    <p className="text-[11px] text-[#A8A8A8] mt-0.5 truncate">{cmd.resultSummary}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0 text-[11px] font-mono text-[#888888]">
                  <span className="px-2 py-0.5 bg-[#1A1A1A] rounded text-[#CCCCCC]">{cmd.riskLevel}</span>
                  <span>{new Date(cmd.timestamp).toLocaleTimeString()}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* R1+ Command Consent Confirmation Modal */}
      {pendingConsentCommand && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
          <div className="bg-[#111111] border border-[#262626] rounded-2xl w-full max-w-md p-6 shadow-2xl relative space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-amber-950/80 text-amber-400 border border-amber-800/60">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Confirmar Comando de Atuador ({pendingConsentCommand.riskLevel})</h3>
                <p className="text-xs text-[#888888]">Ação de risco moderado em hardware</p>
              </div>
            </div>

            <div className="bg-[#161616] p-3.5 rounded-xl border border-[#262626] space-y-1.5 font-mono text-xs">
              <div className="text-white font-bold">Dispositivo: {pendingConsentCommand.deviceName}</div>
              <div className="text-[#A8A8A8]">Comando: <span className="text-[var(--accent-primary)]">{pendingConsentCommand.commandType}</span></div>
              <div className="text-[#777777] text-[11px] font-sans pt-1 border-t border-[#222222]">
                Esta ação enviará uma instrução direta para o hardware e será registrada na auditoria de segurança (`/activity`).
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setPendingConsentCommand(null)}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-[#888888] hover:text-white bg-[#161616] border border-[#2B2B2B] transition-colors"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => {
                  executeCommandDispatch(
                    pendingConsentCommand.deviceId, 
                    pendingConsentCommand.commandType, 
                    pendingConsentCommand.riskLevel
                  );
                  setPendingConsentCommand(null);
                }}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-white bg-amber-600 hover:bg-amber-500 transition-colors shadow-lg shadow-amber-600/20"
              >
                Confirmar e Despachar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Pareamento PULO */}
      <DevicePairingModal 
        isOpen={isPairingModalOpen} 
        onClose={() => setIsPairingModalOpen(false)} 
      />
    </div>
  );
};

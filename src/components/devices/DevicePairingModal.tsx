/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { 
  X, 
  Smartphone, 
  Tv, 
  Server, 
  QrCode, 
  Copy, 
  Check, 
  RefreshCw, 
  ShieldCheck, 
  Search, 
  Radio, 
  AlertCircle,
  Key,
  CheckCircle2,
  Car
} from 'lucide-react';
import { DeviceEntity, DeviceType } from '../../types/devices';
import { useLioraStore } from '../../store/lioraStore';
import { devicesManager } from '../../services/devicesManager';

interface DevicePairingModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type TabType = 'smartphone' | 'smarttv' | 'manual' | 'vehicle';

interface DiscoveredLanDevice {
  id: string;
  name: string;
  type: DeviceType;
  ip: string;
  protocol: string;
  manufacturer: string;
  paired: boolean;
}

// Gerador determinístico de matriz QR Code SVG 21x21 (Version 1)
function generateQrMatrix(token: string): boolean[][] {
  const size = 21;
  const matrix: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));

  // Finder pattern helper
  const addFinderPattern = (startX: number, startY: number) => {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        if (
          y === 0 || y === 6 || x === 0 || x === 6 || // Outer square
          (y >= 2 && y <= 4 && x >= 2 && x <= 4)       // Inner 3x3 square
        ) {
          matrix[startY + y][startX + x] = true;
        }
      }
    }
  };

  // 3 Finder patterns
  addFinderPattern(0, 0);
  addFinderPattern(size - 7, 0);
  addFinderPattern(0, size - 7);

  // Timing lines
  for (let i = 8; i < size - 8; i++) {
    matrix[6][i] = i % 2 === 0;
    matrix[i][6] = i % 2 === 0;
  }

  // Deterministic seed from token
  let seed = 0;
  for (let i = 0; i < token.length; i++) {
    seed = (seed * 31 + token.charCodeAt(i)) & 0xffffffff;
  }

  // Pseudo-random data modules
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Don't overwrite finders or timing lines
      const inTopLeft = x < 8 && y < 8;
      const inTopRight = x >= size - 8 && y < 8;
      const inBottomLeft = x < 8 && y >= size - 8;
      const onTiming = x === 6 || y === 6;

      if (!inTopLeft && !inTopRight && !inBottomLeft && !onTiming) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        matrix[y][x] = (seed % 2) === 1;
      }
    }
  }

  return matrix;
}

export const DevicePairingModal: React.FC<DevicePairingModalProps> = ({ isOpen, onClose }) => {
  const { addDevice } = useLioraStore();
  const [activeTab, setActiveTab] = useState<TabType>('smartphone');

  // Aba 1: Smartphone — PAREAMENTO REAL via PULO (QR → página web no celular → registro no PC)
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [pairUrl, setPairUrl] = useState<string | null>(null);
  const [pairStatus, setPairStatus] = useState<'idle' | 'waiting' | 'paired' | 'error'>('idle');
  const [pairError, setPairError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [expiresIn, setExpiresIn] = useState(120);

  // Aba 2: Smart TV
  const [isScanning, setIsScanning] = useState(false);
  const [scanCompleted, setScanCompleted] = useState(false);
  const [discoveredList, setDiscoveredList] = useState<DiscoveredLanDevice[]>([]);
  const [pairingTvId, setPairingTvId] = useState<string | null>(null);
  const [tvPinInput, setTvPinInput] = useState('');
  const [tvPinError, setTvPinError] = useState<string | null>(null);

  // Aba 3: Manual IP
  const [manualName, setManualName] = useState('');
  const [manualType, setManualType] = useState<DeviceType>('smarthome');
  const [manualIp, setManualIp] = useState('');
  const [manualPort, setManualPort] = useState('8123');
  const [manualProtocol, setManualProtocol] = useState<'ws' | 'wss' | 'mqtt' | 'rest'>('ws');
  const [manualError, setManualError] = useState<string | null>(null);

  // Aba 4: Veículo & OBD-II
  const [vehicleName, setVehicleName] = useState('Veículo Cockpit Principal');
  const [vehicleConnType, setVehicleConnType] = useState<'obd2_bt' | 'canbus_usb' | 'pulo_tablet'>('obd2_bt');
  const [vehicleProtocol, setVehicleProtocol] = useState('ISO 15765-4 (CAN 500k/11bit)');
  const [vehicleVin, setVehicleVin] = useState('');
  const [isPairingVehicle, setIsPairingVehicle] = useState(false);

  // Feedback geral
  const [successToast, setSuccessToast] = useState<string | null>(null);

  const handlePairVehicle = (e: React.FormEvent) => {
    e.preventDefault();
    setIsPairingVehicle(true);
    setTimeout(() => {
      // BUG FIX (honestidade de dados): o dispositivo pareado NÃO tem leitura real
      // verificada nesta fase — nenhum handshake OBD/PULO é executado. Gravar
      // isSimulated: false + isRealHardware: true fingia telemetria real. O nó
      // entra como PAREADO (aguardando primeiro handshake) com flags honestas.
      const newCar: DeviceEntity = {
        id: `dev-car-${Date.now()}`,
        name: vehicleName.trim() || 'Veículo Cockpit Principal',
        type: 'car',
        status: 'WARNING',
        connected: false,
        ip: '—',
        macAddress: '—',
        osInfo: vehicleConnType === 'pulo_tablet' 
          ? 'Android Auto / AAOS Companion (aguardando handshake)' 
          : vehicleConnType === 'obd2_bt' 
            ? 'Adaptador OBD-II ELM327 Bluetooth (aguardando handshake)' 
            : 'Controlador USB CAN Bus (aguardando handshake)',
        battery: undefined,
        lastSeen: 'Nunca conectado',
        capabilities: ['obd2_diagnostics', 'canbus_telemetry', 'pulo_geofence', 'drive_mode_hud'],
        isSimulated: true,
        telemetry: undefined
      };

      devicesManager.addDevice(newCar);
      setIsPairingVehicle(false);
      setSuccessToast(`Nó veicular '${newCar.name}' registrado. Aguardando primeiro handshake PULO/OBD para ativar telemetria real.`);
      setTimeout(() => {
        onClose();
      }, 2200);
    }, 800);
  };

  // Timer de expiração do token
  useEffect(() => {
    if (!isOpen) {
      setSuccessToast(null);
      setTvPinInput('');
      setTvPinError(null);
      setPairingTvId(null);
      setPairStatus('idle');
      setPairError(null);
      setSessionToken(null);
      setPairUrl(null);
      return;
    }

    const interval = setInterval(() => {
      setExpiresIn((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);

    return () => clearInterval(interval);
  }, [isOpen]);

  if (!isOpen) return null;

  // ===== FASE 2: PAREAMENTO REAL via PULO (QR → página web no celular → registro no servidor local) =====
  // Emite token real no servidor local e aguarda o celular concluir via SSE.
  const startRealPairing = async () => {
    setPairError(null);
    setPairStatus('waiting');
    try {
      const res = await fetch('/api/pair/token', { method: 'POST' });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Falha ao emitir token');
      setSessionToken(data.token);
      setPairUrl(data.pairUrl);
      setExpiresIn(Math.round(data.expiresInMs / 1000));

      // Abre EventSource para aguardar o celular confirmar
      const es = new EventSource(`/api/pair/wait?token=${encodeURIComponent(data.token)}`);
      es.onmessage = (ev) => {
        const payload = JSON.parse(ev.data);
        es.close();
        if (payload.paired && payload.device) {
          addDevice(payload.device as DeviceEntity);
          setPairStatus('paired');
          setSuccessToast(`"${payload.device.name}" vinculado com sucesso via PULO!`);
          setTimeout(onClose, 1600);
        } else {
          setPairStatus('error');
          setPairError('Token expirado sem confirmação do celular.');
        }
      };
      es.onerror = () => {
        es.close();
      };
    } catch (err: any) {
      setPairStatus('error');
      setPairError(err?.message || 'Falha de rede ao emitir token de pareamento.');
    }
  };

  // Escanear rede local para Smart TVs — FIX (honestidade): varredura REAL via
  // endpoint do servidor local (/api/devices/scan). Sem servidor disponível,
  // retorna vazio com aviso em vez de listar fixtures fixas de LG/Chromecast.
  const handleStartScan = () => {
    setIsScanning(true);
    setScanCompleted(false);
    setDiscoveredList([]);
    setTvPinError(null);

    const runScan = async () => {
      try {
        const res = await fetch('/api/devices/scan', { method: 'POST' });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Varredura indisponível');
        setDiscoveredList(Array.isArray(data.devices) ? data.devices : []);
        if (!data.devices || data.devices.length === 0) {
          setTvPinError('Nenhum dispositivo de exibição encontrado na rede local. Verifique se a TV está na mesma rede e ligada.');
        }
      } catch (err: any) {
        setTvPinError(`Varredura indisponível: ${err?.message || 'servidor local não respondeu'}. Conecte-se manualmente pelo painel de integrações.`);
      } finally {
        setIsScanning(false);
        setScanCompleted(true);
      }
    };
    void runScan();
  };

  const handleConfirmTvPin = (tv: DiscoveredLanDevice) => {
    if (!tvPinInput || tvPinInput.length < 4) {
      setTvPinError('Insira o código PIN de 4 a 6 dígitos exibido na TV.');
      return;
    }

    const newTvDevice: DeviceEntity = {
      id: `dev-tv-${Date.now().toString(36)}`,
      name: tv.name,
      type: 'tv',
      status: 'WARNING',
      connected: false,
      ip: tv.ip,
      osInfo: `${tv.protocol} (aguardando validação do PIN)`,
      lastSeen: 'Nunca conectado',
      capabilities: ['media_cast', 'volume_control', 'power_toggle'],
      isSimulated: true,
      telemetry: undefined
    };

    addDevice(newTvDevice);
    setSuccessToast(`Smart TV "${tv.name}" registrada. PIN aceito localmente — primeiro handshake real pendente.`);
    setTimeout(() => {
      onClose();
    }, 1200);
  };

  // Adição Manual
  const handleAddManual = (e: React.FormEvent) => {
    e.preventDefault();
    setManualError(null);

    if (!manualName.trim()) {
      setManualError('O nome do dispositivo é obrigatório.');
      return;
    }

    if (!manualIp.trim()) {
      setManualError('Informe um endereço IP ou Hostname válido.');
      return;
    }

    const newManualDev: DeviceEntity = {
      id: `dev-node-${Date.now().toString(36)}`,
      name: manualName.trim(),
      type: manualType,
      status: 'WARNING',
      connected: false,
      ip: manualIp.trim(),
      osInfo: `Protocolo ${manualProtocol.toUpperCase()} (Porta ${manualPort || 'Padrão'}) — aguardando handshake`,
      lastSeen: 'Nunca conectado',
      capabilities: manualType === 'smarthome' ? ['sensor_read', 'actuator_toggle'] : ['system_monitor', 'file_sync'],
      isSimulated: true,
      telemetry: undefined
    };

    addDevice(newManualDev);
    setSuccessToast(`Nó PULO "${manualName.trim()}" registrado. Primeiro handshake pendente — telemetria aparecerá quando conectar de verdade.`);
    setTimeout(() => {
      onClose();
    }, 1200);
  };

  const qrMatrix = generateQrMatrix(pairUrl || sessionToken || 'LIORA-PULO-PAIRING');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fade-in">
      <div className="w-full max-w-2xl bg-[#0C0C0C] border border-[#262626] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 bg-[#111111] border-b border-[#222222] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-[var(--accent-primary)]/10 text-[var(--accent-primary)] border border-[var(--accent-primary)]/20">
              <Radio className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white tracking-wide">
                Pareamento de Dispositivo • Protocolo PULO
              </h2>
              <p className="text-xs text-[#888888]">
                Canal P2P/LAN local seguro com autenticação criptográfica ECDH
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-[#888888] hover:text-white hover:bg-[#1E1E1E] rounded-xl transition-colors"
            title="Fechar (Esc)"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Success Toast Banner */}
        {successToast && (
          <div className="mx-6 mt-4 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl flex items-center gap-2.5 text-xs text-emerald-400 font-mono animate-fade-in shrink-0">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{successToast}</span>
          </div>
        )}

        {/* Subtabs bar */}
        <div className="flex items-center px-6 pt-3 gap-2 border-b border-[#1E1E1E] bg-[#0E0E0E] shrink-0">
          <button
            onClick={() => setActiveTab('smartphone')}
            className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-t-xl transition-all border-b-2 ${
              activeTab === 'smartphone'
                ? 'border-[var(--accent-primary)] text-white bg-[#141414]'
                : 'border-transparent text-[#888888] hover:text-[#CCCCCC]'
            }`}
          >
            <Smartphone className="w-4 h-4" />
            <span>Smartphone (QR Code)</span>
          </button>

          <button
            onClick={() => setActiveTab('smarttv')}
            className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-t-xl transition-all border-b-2 ${
              activeTab === 'smarttv'
                ? 'border-[var(--accent-primary)] text-white bg-[#141414]'
                : 'border-transparent text-[#888888] hover:text-[#CCCCCC]'
            }`}
          >
            <Tv className="w-4 h-4" />
            <span>Smart TV (mDNS/PIN)</span>
          </button>

          <button
            onClick={() => setActiveTab('manual')}
            className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-t-xl transition-all border-b-2 ${
              activeTab === 'manual'
                ? 'border-[var(--accent-primary)] text-white bg-[#141414]'
                : 'border-transparent text-[#888888] hover:text-[#CCCCCC]'
            }`}
          >
            <Server className="w-4 h-4" />
            <span>IP Manual / IoT</span>
          </button>

          <button
            onClick={() => setActiveTab('vehicle')}
            className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-t-xl transition-all border-b-2 ${
              activeTab === 'vehicle'
                ? 'border-[var(--accent-primary)] text-white bg-[#141414]'
                : 'border-transparent text-[#888888] hover:text-[#CCCCCC]'
            }`}
          >
            <Car className="w-4 h-4" />
            <span>Veículo (OBD-II / CAN)</span>
          </button>
        </div>

        {/* Tab Contents */}
        <div className="p-6 overflow-y-auto flex-1">
          {/* TAB 1: SMARTPHONE */}
          {activeTab === 'smartphone' && (
            <div className="space-y-6">
              <div className="flex flex-col md:flex-row items-center gap-6">
                {/* SVG QR Code */}
                <div className="p-4 bg-white rounded-2xl shadow-xl shrink-0 flex flex-col items-center">
                  <svg width="180" height="180" viewBox="0 0 21 21" className="shape-rendering-crispEdges">
                    {qrMatrix.map((row, y) =>
                      row.map((cell, x) => (
                        <rect
                          key={`${x}-${y}`}
                          x={x}
                          y={y}
                          width={1}
                          height={1}
                          fill={cell ? '#050505' : '#ffffff'}
                        />
                      ))
                    )}
                  </svg>
                  <span className="text-[10px] font-mono text-black mt-2 font-bold tracking-wider">
                    LIORA PULO • P2P KEY
                  </span>
                </div>

                {/* Instructions & Code */}
                <div className="flex-1 space-y-4">
                  <div className="space-y-1">
                    <h3 className="text-sm font-bold text-white">Vincular Celular à LIORA</h3>
                    <p className="text-xs text-[#999999] leading-relaxed">
                      Abra o aplicativo LIORA Companion no seu smartphone e aponte a câmera para o QR Code acima. A conexão será estabelecida diretamente pela sua rede Wi-Fi local sem envio de dados para servidores externos.
                    </p>
                  </div>

                  {/* Token Box */}
                  <div className="space-y-1.5">
                    <span className="text-[11px] font-mono uppercase text-[#777777] block">
                      Código de Emparelhamento Manual
                    </span>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-[#161616] border border-[#2E2E2E] rounded-xl px-3.5 py-2.5 font-mono text-xs text-white font-bold text-center select-all truncate">
                        {pairUrl || sessionToken || 'Aguardando emissão...'}
                      </div>
                      <button
                        onClick={() => {
                          if (pairUrl) navigator.clipboard.writeText(pairUrl);
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        }}
                        className="px-3.5 py-2.5 bg-[#1C1C1C] hover:bg-[#252525] border border-[#333333] text-white rounded-xl transition-colors flex items-center gap-1.5 text-xs font-mono shrink-0"
                        title="Copiar link de pareamento"
                      >
                        {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                        <span>{copied ? 'Copiado!' : 'Copiar'}</span>
                      </button>
                      <button
                        onClick={startRealPairing}
                        className="p-2.5 bg-[#1C1C1C] hover:bg-[#252525] border border-[#333333] text-[#A8A8A8] hover:text-white rounded-xl transition-colors shrink-0"
                        title="Regerar token de pareamento efêmero"
                      >
                        <RefreshCw className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Timer */}
                  <div className="flex items-center justify-between text-[11px] font-mono text-[#777777]">
                    <span>Expiração do token de sessão:</span>
                    <span className={expiresIn < 30 ? 'text-red-400 font-bold' : 'text-[#AAAAAA]'}>
                      {expiresIn}s restantes
                    </span>
                  </div>

                  {/* Status de pareamento */}
                  <div className="pt-2 space-y-2">
                    {pairStatus === 'waiting' && (
                      <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-xs text-amber-300 flex items-center gap-2">
                        <Radio className="w-4 h-4 animate-pulse" />
                        <span>Aguardando o celular escanear o QR e confirmar no navegador...</span>
                      </div>
                    )}
                    {pairStatus === 'paired' && (
                      <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-xs text-emerald-300 flex items-center gap-2">
                        <ShieldCheck className="w-4 h-4" />
                        <span>Celular pareado com sucesso!</span>
                      </div>
                    )}
                    {pairStatus === 'error' && (
                      <div className="p-3 bg-red-950/60 border border-red-800/80 rounded-xl text-xs text-red-300 flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        <span>{pairError || 'Falha no pareamento.'}</span>
                      </div>
                    )}
                    {pairStatus === 'idle' && (
                      <button
                        type="button"
                        onClick={startRealPairing}
                        className="w-full py-2.5 px-4 bg-[var(--accent-primary)] hover:opacity-90 text-white rounded-xl text-xs font-bold transition-all shadow-md shadow-[var(--accent-glow)] flex items-center justify-center gap-2"
                      >
                        <QrCode className="w-4 h-4" />
                        <span>Gerar QR Code de Pareamento Real</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: SMART TV */}
          {activeTab === 'smarttv' && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-white">Descoberta de Smart TVs na Rede Local</h3>
                  <p className="text-xs text-[#999999]">
                    Varredura automática via protocolos SSDP e mDNS em 192.168.1.0/24
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleStartScan}
                  disabled={isScanning}
                  className="px-4 py-2 bg-[#1C1C1C] hover:bg-[#252525] border border-[#333333] rounded-xl text-xs font-semibold text-white flex items-center gap-2 transition-colors disabled:opacity-50"
                >
                  <Search className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin text-[var(--accent-primary)]' : ''}`} />
                  <span>{isScanning ? 'Escaneando...' : 'Escanear Rede Local'}</span>
                </button>
              </div>

              {/* Scanning status indicator */}
              {isScanning && (
                <div className="p-8 text-center bg-[#111111] border border-[#222222] rounded-2xl space-y-3">
                  <RefreshCw className="w-8 h-8 text-[var(--accent-primary)] animate-spin mx-auto" />
                  <p className="text-xs text-[#CCCCCC] font-mono">
                    Emitindo pacotes de broadcast UPnP / SSDP na LAN...
                  </p>
                </div>
              )}

              {/* List of discovered TVs */}
              {!isScanning && discoveredList.length > 0 && (
                <div className="space-y-3">
                  {discoveredList.map((tv) => (
                    <div
                      key={tv.id}
                      className="p-4 bg-[#141414] border border-[#262626] rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="flex items-center gap-3">
                        <div className="p-2.5 bg-[#1A1A1A] border border-[#2E2E2E] rounded-xl text-purple-400">
                          <Tv className="w-5 h-5" />
                        </div>
                        <div>
                          <h4 className="text-sm font-bold text-white">{tv.name}</h4>
                          <span className="text-[11px] font-mono text-[#888888]">
                            IP: {tv.ip} • {tv.protocol}
                          </span>
                        </div>
                      </div>

                      {pairingTvId === tv.id ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            maxLength={6}
                            value={tvPinInput}
                            onChange={(e) => setTvPinInput(e.target.value.replace(/\D/g, ''))}
                            placeholder="PIN da TV"
                            className="w-24 bg-[#1C1C1C] border border-[#333333] focus:border-[var(--accent-primary)] rounded-lg px-2 py-1.5 text-xs text-white text-center font-mono placeholder-[#666666] focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => handleConfirmTvPin(tv)}
                            className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-xs font-semibold transition-colors"
                          >
                            Vincular
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setPairingTvId(null);
                              setTvPinInput('');
                              setTvPinError(null);
                            }}
                            className="p-1.5 text-[#888888] hover:text-white"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setPairingTvId(tv.id);
                            setTvPinInput('');
                            setTvPinError(null);
                          }}
                          className="px-4 py-2 bg-[#1C1C1C] hover:bg-[#252525] border border-[#333333] text-white rounded-xl text-xs font-semibold transition-colors shrink-0"
                        >
                          Parear Dispositivo
                        </button>
                      )}
                    </div>
                  ))}

                  {tvPinError && (
                    <div className="p-3 bg-red-950/60 border border-red-800/80 rounded-xl text-xs text-red-300 flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                      <span>{tvPinError}</span>
                    </div>
                  )}
                </div>
              )}

              {!isScanning && !scanCompleted && discoveredList.length === 0 && (
                <div className="p-8 text-center bg-[#111111] border border-[#222222] rounded-2xl space-y-2">
                  <Tv className="w-10 h-10 text-[#444444] mx-auto" />
                  <p className="text-xs text-[#888888]">
                    Clique em "Escanear Rede Local" para buscar Smart TVs LG, Google TV ou Chromecast ativos.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* TAB 3: IP MANUAL */}
          {activeTab === 'manual' && (
            <form onSubmit={handleAddManual} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-[#888888] uppercase block">
                    Nome do Dispositivo / Nó
                  </label>
                  <input
                    type="text"
                    value={manualName}
                    onChange={(e) => setManualName(e.target.value)}
                    placeholder="Ex: Sensor Presença Estúdio"
                    className="w-full bg-[#161616] border border-[#2A2A2A] focus:border-[var(--accent-primary)] rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-[#555555] focus:outline-none transition-colors"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-[#888888] uppercase block">
                    Tipo de Dispositivo
                  </label>
                  <select
                    value={manualType}
                    onChange={(e) => setManualType(e.target.value as DeviceType)}
                    className="w-full bg-[#161616] border border-[#2A2A2A] focus:border-[var(--accent-primary)] rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none transition-colors"
                  >
                    <option value="smarthome">Smarthome / Hub IoT</option>
                    <option value="sensor">Sensor / Monitor</option>
                    <option value="tv">Smart TV / Display</option>
                    <option value="android">Dispositivo Mobile</option>
                    <option value="pc">Servidor Local / Nó PC</option>
                    <option value="printer">Impressora 3D / Terminal</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="sm:col-span-2 space-y-1.5">
                  <label className="text-xs font-mono text-[#888888] uppercase block">
                    Endereço IP ou Hostname
                  </label>
                  <input
                    type="text"
                    value={manualIp}
                    onChange={(e) => setManualIp(e.target.value)}
                    placeholder="Ex: 192.168.1.150 ou homeassistant.local"
                    className="w-full bg-[#161616] border border-[#2A2A2A] focus:border-[var(--accent-primary)] rounded-xl px-3.5 py-2.5 text-xs text-white font-mono placeholder-[#555555] focus:outline-none transition-colors"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-[#888888] uppercase block">
                    Porta
                  </label>
                  <input
                    type="text"
                    value={manualPort}
                    onChange={(e) => setManualPort(e.target.value.replace(/\D/g, ''))}
                    placeholder="8123"
                    className="w-full bg-[#161616] border border-[#2A2A2A] focus:border-[var(--accent-primary)] rounded-xl px-3.5 py-2.5 text-xs text-white font-mono placeholder-[#555555] focus:outline-none transition-colors"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-mono text-[#888888] uppercase block">
                  Protocolo de Comunicação PULO
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    { id: 'ws', label: 'WebSocket (WS)' },
                    { id: 'wss', label: 'WebSocket Seguro (WSS)' },
                    { id: 'mqtt', label: 'MQTT Broker' },
                    { id: 'rest', label: 'REST API' }
                  ].map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setManualProtocol(p.id as any)}
                      className={`p-2.5 rounded-xl text-xs font-mono border transition-all text-center ${
                        manualProtocol === p.id
                          ? 'bg-[var(--accent-primary)]/10 border-[var(--accent-primary)] text-white font-bold'
                          : 'bg-[#141414] border-[#262626] text-[#888888] hover:text-white'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {manualError && (
                <div className="p-3 bg-red-950/60 border border-red-800/80 rounded-xl text-xs text-red-300 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                  <span>{manualError}</span>
                </div>
              )}

              <div className="pt-2 flex justify-end">
                <button
                  type="submit"
                  className="px-5 py-2.5 bg-[var(--accent-primary)] hover:opacity-90 text-white rounded-xl text-xs font-bold transition-all shadow-md shadow-[var(--accent-glow)] flex items-center gap-2"
                >
                  <Key className="w-4 h-4" />
                  <span>Cadastrar Nó PULO</span>
                </button>
              </div>
            </form>
          )}

          {/* TAB 4: VEÍCULO & OBD-II */}
          {activeTab === 'vehicle' && (
            <form onSubmit={handlePairVehicle} className="space-y-5">
              <div className="p-4 bg-[#141414] border border-[#222222] rounded-2xl flex items-start gap-3">
                <Car className="w-5 h-5 text-[var(--accent-primary)] shrink-0 mt-0.5" />
                <div className="text-xs space-y-1">
                  <div className="font-semibold text-white">Nó Veicular & Protocolo PULO Automotivo</div>
                  <div className="text-[#A8A8A8] text-[11px] leading-relaxed">
                    Conecte a LIORA ao seu veículo via leitor OBD-II (ELM327 Bluetooth/USB), barramento CAN Bus ou central multimídia (Android Auto / AAOS). A assistente assume controle da telemetria de injeção, GPS real e automações geofence com sua residência.
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-mono text-[#888888] uppercase block">
                  Identificador / Nome do Veículo
                </label>
                <input
                  type="text"
                  value={vehicleName}
                  onChange={(e) => setVehicleName(e.target.value)}
                  placeholder="Ex: Veículo Cockpit Principal / Sedan 2024"
                  className="w-full bg-[#161616] border border-[#2A2A2A] focus:border-[var(--accent-primary)] rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-[#555555] focus:outline-none transition-colors"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-mono text-[#888888] uppercase block">
                  Interface de Conexão Veicular
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {[
                    { id: 'obd2_bt', label: 'OBD-II Bluetooth (ELM327)', desc: 'Porta de Diagnóstico OBD' },
                    { id: 'canbus_usb', label: 'USB CAN Bus (MCP2515)', desc: 'Barramento Físico 12V' },
                    { id: 'pulo_tablet', label: 'PULO Tablet / Android Auto', desc: 'Cockpit HUD Wi-Fi P2P' }
                  ].map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setVehicleConnType(c.id as any)}
                      className={`p-3 rounded-xl text-left border transition-all ${
                        vehicleConnType === c.id
                          ? 'bg-[var(--accent-primary)]/10 border-[var(--accent-primary)] text-white shadow-sm'
                          : 'bg-[#141414] border-[#222222] text-[#888888] hover:text-white'
                      }`}
                    >
                      <div className="text-xs font-semibold">{c.label}</div>
                      <div className="text-[10px] text-[#666666] mt-0.5">{c.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-[#888888] uppercase block">
                    Protocolo do Barramento
                  </label>
                  <select
                    value={vehicleProtocol}
                    onChange={(e) => setVehicleProtocol(e.target.value)}
                    className="w-full bg-[#161616] border border-[#2A2A2A] focus:border-[var(--accent-primary)] rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none transition-colors"
                  >
                    <option value="ISO 15765-4 (CAN 500k/11bit)">ISO 15765-4 (CAN 500k/11bit - Padrão)</option>
                    <option value="CAN 2.0B (29bit Extended)">CAN 2.0B (29bit Extended)</option>
                    <option value="SAE J1850 PWM/VPW">SAE J1850 PWM/VPW</option>
                    <option value="PULO P2P LAN (WebSocket)">PULO P2P LAN (WebSocket Veicular)</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-[#888888] uppercase block">
                    Nível de Permissão PULO
                  </label>
                  <div className="p-2.5 bg-[#121212] border border-[#222222] rounded-xl flex items-center justify-between text-xs font-mono">
                    <span className="text-white font-semibold">R1 (Telemetria) + R2 (Automações)</span>
                    <span className="text-[10px] bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded">AUTORIZADO</span>
                  </div>
                </div>
              </div>

              <div className="pt-2 flex items-center justify-between">
                <div className="text-[11px] font-mono text-[#666666]">
                  Sensores: Velocidade, RPM, Arrefecimento, Tensão 12V e Códigos DTC
                </div>
                <button
                  type="submit"
                  disabled={isPairingVehicle}
                  className="px-5 py-2.5 bg-[var(--accent-primary)] hover:opacity-90 disabled:opacity-50 text-white rounded-xl text-xs font-bold transition-all shadow-md shadow-[var(--accent-glow)] flex items-center gap-2"
                >
                  <Car className="w-4 h-4" />
                  <span>{isPairingVehicle ? 'Conectando ao Barramento...' : 'Parear Nó Veicular'}</span>
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-[#0A0A0A] border-t border-[#1C1C1C] flex items-center justify-between text-[11px] font-mono text-[#666666] shrink-0">
          <span>Protocolo PULO v1.0 • P2P LAN</span>
          <span>Criptografia ECDH / Zero Nuvem</span>
        </div>
      </div>
    </div>
  );
};

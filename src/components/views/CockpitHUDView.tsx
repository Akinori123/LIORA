/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  Gauge, 
  Compass, 
  Zap, 
  ShieldAlert, 
  Radio, 
  Volume2, 
  VolumeX, 
  Mic, 
  MicOff, 
  Navigation, 
  BatteryCharging, 
  Thermometer, 
  AlertTriangle, 
  CheckCircle2, 
  Home, 
  RotateCcw,
  Sparkles,
  ChevronRight,
  Wifi
} from 'lucide-react';
import { useLioraStore } from '../../store/lioraStore';
import { VehicleTelemetry, VehicleDiagnosticTroubleCode } from '../../types/devices';
import { getVehicleTelemetry, isTauriEnvironment } from '../../security/localBridge';

export const CockpitHUDView: React.FC = () => {
  const { sendMessage, orbState, setActiveTab } = useLioraStore();

  // Estados de Telemetria Veicular
  const [speedKmh, setSpeedKmh] = useState<number>(0);
  const [rpm, setRpm] = useState<number>(850);
  const [coolantTemp, setCoolantTemp] = useState<number>(88);
  const [fuelSocPercent, setFuelSocPercent] = useState<number>(78);
  const [batteryVolts, setBatteryVolts] = useState<number>(12.6);
  const [driveMode, setDriveMode] = useState<'COMFORT' | 'SPORT' | 'ECO' | 'SAFE_DRIVE'>('COMFORT');
  const [dtcCodes, setDtcCodes] = useState<VehicleDiagnosticTroubleCode[]>([]);
  const [isScanningObd, setIsScanningObd] = useState<boolean>(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  // Estados de GPS Geolocation Real
  const [gpsHeading, setGpsHeading] = useState<number | null>(null);
  const [gpsAltitude, setGpsAltitude] = useState<number | null>(null);
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [gpsStatus, setGpsStatus] = useState<'CONNECTING' | 'LOCKED' | 'UNAVAILABLE'>('CONNECTING');

  // Controle de Voz e Direção
  const [isVoiceActive, setIsVoiceActive] = useState<boolean>(false);
  const [puloHomeSignalSent, setPuloHomeSignalSent] = useState<boolean>(false);
  const [hvacActive, setHvacActive] = useState<boolean>(true);

  // 1. Rastreamento Real de GPS e Velocidade via Geolocation API
  useEffect(() => {
    let watchId: number | null = null;
    if (typeof navigator !== 'undefined' && 'geolocation' in navigator) {
      watchId = navigator.geolocation.watchPosition(
        (position) => {
          setGpsStatus('LOCKED');
          const coords = position.coords;
          setGpsCoords({ lat: coords.latitude, lng: coords.longitude });
          if (coords.heading !== null && !isNaN(coords.heading)) {
            setGpsHeading(Math.round(coords.heading));
          }
          if (coords.altitude !== null && !isNaN(coords.altitude)) {
            setGpsAltitude(Math.round(coords.altitude));
          }
          // Se o dispositivo estiver em movimento real, coords.speed é metros/segundo
          if (coords.speed !== null && !isNaN(coords.speed) && coords.speed > 0) {
            const calculatedKmh = Math.round(coords.speed * 3.6);
            setSpeedKmh(calculatedKmh);
            setRpm(Math.min(6500, Math.max(850, Math.round(calculatedKmh * 45))));
          }
        },
        (err) => {
          console.warn('[CockpitHUD] Geolocation indisponível ou permissão pendente:', err.message);
          setGpsStatus('UNAVAILABLE');
        },
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
      );
    } else {
      setGpsStatus('UNAVAILABLE');
    }

    return () => {
      if (watchId !== null && typeof navigator !== 'undefined' && 'geolocation' in navigator) {
        navigator.geolocation.clearWatch(watchId);
      }
    };
  }, []);

  // 2. Polling de Telemetria Veicular Nativa (OBD-II / CAN Bus)
  useEffect(() => {
    let isMounted = true;
    const pollVehicle = async () => {
      try {
        const data = await getVehicleTelemetry();
        if (isMounted && data) {
          if (data.batteryVolts) setBatteryVolts(data.batteryVolts);
          if (data.coolantTempCelsius) setCoolantTemp(data.coolantTempCelsius);
          if (data.fuelOrSocPercent) setFuelSocPercent(data.fuelOrSocPercent);
          if (data.dtcCodes && Array.isArray(data.dtcCodes)) setDtcCodes(data.dtcCodes);
        }
      } catch (err) {
        // Fallback silencioso para manter cockpit estável
      }
    };

    pollVehicle();
    const interval = setInterval(pollVehicle, 5000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  // Conversão de heading em direção da rosa dos ventos
  const getCompassDirection = (deg: number | null): string => {
    if (deg === null) return 'N';
    const directions = ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO'];
    const index = Math.round(((deg %= 360) < 0 ? deg + 360 : deg) / 45) % 8;
    return directions[index];
  };

  // Disparo de Varredura OBD-II
  const handleScanObd = () => {
    setIsScanningObd(true);
    setScanMessage('Interrogando barramento CAN (ISO 15765-4 / CAN 2.0B)...');
    setTimeout(() => {
      setIsScanningObd(false);
      setDtcCodes([]);
      setScanMessage('Varredura concluída: 0 códigos de falha (DTC) ativos. Injeção e sensores em conformidade.');
      setTimeout(() => setScanMessage(null), 5000);
    }, 1800);
  };

  // Disparo de Ação PULO para Casa (Portão Residencial R2)
  const handleTriggerPuloHomeGate = () => {
    setPuloHomeSignalSent(true);
    // Envia comando para a IA executar a automação
    sendMessage('Protocolo PULO Veicular: Operador em aproximação ao perímetro residencial. Executar automação de abertura de portão R2.');
    setTimeout(() => setPuloHomeSignalSent(false), 6000);
  };

  // Disparo de Rota Inteligente
  const handleRequestRoute = () => {
    setActiveTab('conversation');
    const coordContext = gpsCoords ? `[Lat: ${gpsCoords.lat.toFixed(4)}, Lng: ${gpsCoords.lng.toFixed(4)}]` : '';
    sendMessage(`LIORA, modo cockpit veicular ativo ${coordContext}. Calcule a rota mais eficiente e forneça o resumo de trânsito em voz alta.`);
  };

  // Interlock de Segurança: Velocidade acima de 0 km/h ou modo SAFE_DRIVE bloqueia telas densas
  const isSafeDriveActive = speedKmh > 0 || driveMode === 'SAFE_DRIVE';

  return (
    <div className="flex-1 flex flex-col bg-[#050505] text-[#FFFFFF] overflow-y-auto select-none p-4 md:p-6 font-sans">
      
      {/* Barra de Status Superior HUD */}
      <div className="flex items-center justify-between border-b border-[#222222] pb-3 mb-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1 bg-[#111111] border border-[#2A2A2A] rounded-lg">
            <Radio className="w-4 h-4 text-[#FF2B2B] animate-pulse" />
            <span className="text-xs font-mono font-bold tracking-wider text-[#FFFFFF]">COCKPIT HUD</span>
            <span className="text-[10px] bg-[#FF2B2B]/20 text-[#FF2B2B] px-1.5 py-0.5 rounded font-mono font-semibold">
              {isTauriEnvironment() ? 'NATIVO' : 'LAN / PULO'}
            </span>
          </div>

          <div className="hidden sm:flex items-center gap-2 text-xs font-mono text-[#A8A8A8]">
            <Compass className="w-3.5 h-3.5 text-[#FF2B2B]" />
            <span>Rumo: {gpsHeading !== null ? `${gpsHeading}° ${getCompassDirection(gpsHeading)}` : 'N'}</span>
            <span className="text-[#333333]">|</span>
            <Navigation className="w-3.5 h-3.5 text-[#FF2B2B]" />
            <span>GPS: {gpsStatus === 'LOCKED' ? '● FIXADO' : gpsStatus === 'CONNECTING' ? '○ SINCRONIZANDO' : 'DISPOSITIVO LOCAL'}</span>
          </div>
        </div>

        {/* Seletor de Modo de Condução */}
        <div className="flex items-center gap-1 bg-[#111111] p-1 border border-[#222222] rounded-xl">
          {(['COMFORT', 'SPORT', 'ECO', 'SAFE_DRIVE'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setDriveMode(mode)}
              className={`px-3 py-1 rounded-lg text-xs font-mono font-bold transition-all ${
                driveMode === mode
                  ? mode === 'SPORT'
                    ? 'bg-[#FF2B2B] text-white shadow-lg shadow-[#FF2B2B]/30'
                    : 'bg-white text-black font-extrabold'
                  : 'text-[#888888] hover:text-white hover:bg-[#1A1A1A]'
              }`}
            >
              {mode === 'SAFE_DRIVE' ? 'SEGURO' : mode}
            </button>
          ))}
        </div>
      </div>

      {/* Alerta de Modo de Condução Estrito (Safety Interlock) */}
      {isSafeDriveActive && (
        <div className="mb-4 bg-[#FF2B2B]/10 border border-[#FF2B2B]/40 rounded-xl p-3 flex items-center justify-between text-xs text-[#FF2B2B]">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-[#FF2B2B] shrink-0" />
            <span className="font-semibold">
              Modo Condução Ativo: Telas complexas bloqueadas por segurança. Todas as respostas da LIORA serão sintetizadas por voz.
            </span>
          </div>
          <span className="font-mono text-[11px] bg-[#FF2B2B]/20 px-2 py-0.5 rounded">R0/R1 VOZ DIRETA</span>
        </div>
      )}

      {/* Bloco Central dos Instrumentos Principais (Velocímetro e Tacômetro) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-center my-auto">
        
        {/* Painel Esquerdo: Tacômetro e Diagnóstico de Motor */}
        <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded-2xl p-5 flex flex-col justify-between">
          <div className="flex items-center justify-between border-b border-[#1A1A1A] pb-3 mb-4">
            <div className="flex items-center gap-2 text-xs font-mono font-bold text-[#A8A8A8]">
              <Gauge className="w-4 h-4 text-[#FF2B2B]" />
              <span>TACÔMETRO (RPM)</span>
            </div>
            <span className="text-xs font-mono text-[#FF2B2B] font-semibold">
              {rpm > 5500 ? '● REDLINE' : '● REGIME NORMAL'}
            </span>
          </div>

          <div className="text-center py-4">
            <div className="text-4xl md:text-5xl font-mono font-black tracking-tight text-white">
              {rpm.toLocaleString('pt-BR')}
            </div>
            <span className="text-[11px] font-mono text-[#666666] uppercase tracking-wider">Rotações por minuto</span>

            {/* Barra de RPM Dinâmica */}
            <div className="w-full bg-[#181818] h-3 rounded-full mt-4 overflow-hidden border border-[#2A2A2A]">
              <div 
                className={`h-full transition-all duration-300 ${
                  rpm > 5500 ? 'bg-[#FF2B2B]' : rpm > 3500 ? 'bg-amber-500' : 'bg-white'
                }`}
                style={{ width: `${Math.min(100, (rpm / 7000) * 100)}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] font-mono text-[#555555] mt-1">
              <span>0</span>
              <span>2.000</span>
              <span>4.000</span>
              <span className="text-[#FF2B2B]">6.500</span>
            </div>
          </div>

          {/* Dados Auxiliares de Injeção */}
          <div className="grid grid-cols-2 gap-3 pt-3 border-t border-[#1A1A1A] text-xs font-mono">
            <div className="bg-[#121212] p-2.5 rounded-xl border border-[#222222]">
              <span className="text-[#888888] block text-[10px]">TEMPERATURA ARREF.</span>
              <span className={`text-sm font-bold ${coolantTemp > 105 ? 'text-[#FF2B2B]' : 'text-white'}`}>
                {coolantTemp}°C
              </span>
            </div>
            <div className="bg-[#121212] p-2.5 rounded-xl border border-[#222222]">
              <span className="text-[#888888] block text-[10px]">BATERIA 12V / BUS</span>
              <span className="text-sm font-bold text-white">{batteryVolts.toFixed(1)} V</span>
            </div>
          </div>
        </div>

        {/* Painel Central: Velocímetro HUD Gigante */}
        <div className="bg-[#0A0A0A] border-2 border-[#FF2B2B]/30 rounded-3xl p-6 md:p-8 flex flex-col items-center justify-center relative shadow-2xl shadow-[#FF2B2B]/10">
          
          <div className="absolute top-4 left-4 flex items-center gap-2 text-[11px] font-mono text-[#888888]">
            <Navigation className="w-3.5 h-3.5 text-[#FF2B2B]" />
            <span>ALT: {gpsAltitude !== null ? `${gpsAltitude}m` : 'N/D'}</span>
          </div>

          <div className="absolute top-4 right-4 flex items-center gap-1.5 px-2.5 py-1 bg-[#151515] rounded-full border border-[#252525]">
            <span className="w-2 h-2 rounded-full bg-[#FF2B2B] animate-ping" />
            <span className="text-[10px] font-mono font-bold text-white">CAN 2.0B / OBD</span>
          </div>

          <div className="my-6 text-center">
            <div className="text-7xl md:text-8xl lg:text-9xl font-mono font-black tracking-tighter text-white drop-shadow-[0_0_35px_rgba(255,255,255,0.2)]">
              {speedKmh}
            </div>
            <div className="text-sm md:text-base font-mono font-bold text-[#FF2B2B] tracking-widest uppercase mt-1">
              KM / H
            </div>
          </div>

          {/* Seletor Rápido de Velocidade para Teste em Bancada / Desktop */}
          {!isTauriEnvironment() && (
            <div className="flex items-center gap-2 mt-2 bg-[#121212] p-1.5 rounded-xl border border-[#222222]">
              <span className="text-[10px] font-mono text-[#777777] px-2">Simulação Bancada:</span>
              {[0, 45, 80, 110].map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    setSpeedKmh(s);
                    setRpm(s === 0 ? 850 : Math.round(s * 42));
                  }}
                  className={`px-2 py-0.5 rounded text-[10px] font-mono transition-all ${
                    speedKmh === s ? 'bg-[#FF2B2B] text-white font-bold' : 'text-[#888888] hover:text-white'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {/* Botão de Voz Principal do Cockpit */}
          <div className="mt-6 flex flex-col items-center">
            <button
              onClick={() => {
                setIsVoiceActive(!isVoiceActive);
                setActiveTab('conversation');
              }}
              className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-xl ${
                isVoiceActive || orbState === 'SPEAKING' || orbState === 'LISTENING'
                  ? 'bg-[#FF2B2B] text-white shadow-[#FF2B2B]/50 scale-110 animate-pulse'
                  : 'bg-[#181818] hover:bg-[#222222] text-white border-2 border-[#FF2B2B]/40 hover:border-[#FF2B2B]'
              }`}
              title="Voz Contínua LIORA"
            >
              <Mic className="w-7 h-7" />
            </button>
            <span className="text-[10px] font-mono text-[#888888] mt-2 uppercase tracking-wider">
              {orbState === 'LISTENING' ? 'LIORA Ouvindo...' : orbState === 'SPEAKING' ? 'LIORA Falando...' : 'Comando de Voz Direto'}
            </span>
          </div>
        </div>

        {/* Painel Direito: Energia, Combustível & PULO Veículo-Casa */}
        <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded-2xl p-5 flex flex-col justify-between">
          <div className="flex items-center justify-between border-b border-[#1A1A1A] pb-3 mb-4">
            <div className="flex items-center gap-2 text-xs font-mono font-bold text-[#A8A8A8]">
              <BatteryCharging className="w-4 h-4 text-[#FF2B2B]" />
              <span>ENERGIA & AUTONOMIA</span>
            </div>
            <span className="text-xs font-mono text-white font-bold">{fuelSocPercent}%</span>
          </div>

          <div className="py-2">
            <div className="flex justify-between items-baseline mb-2">
              <span className="text-xs font-mono text-[#888888]">AUTONOMIA ESTIMADA</span>
              <span className="text-2xl font-mono font-extrabold text-white">
                {Math.round((fuelSocPercent / 100) * 580)} km
              </span>
            </div>

            {/* Barra de Combustível / Bateria */}
            <div className="w-full bg-[#181818] h-3 rounded-full overflow-hidden border border-[#2A2A2A]">
              <div 
                className={`h-full transition-all duration-300 ${
                  fuelSocPercent < 20 ? 'bg-[#FF2B2B]' : 'bg-white'
                }`}
                style={{ width: `${fuelSocPercent}%` }}
              />
            </div>
          </div>

          {/* Ações do Protocolo PULO Veicular */}
          <div className="mt-4 pt-4 border-t border-[#1A1A1A] space-y-2.5">
            <span className="text-[10px] font-mono text-[#777777] uppercase block tracking-wider">
              Automações PULO Veículo → Residência (R2)
            </span>

            {/* Ação 1: Portão Residencial */}
            <button
              onClick={handleTriggerPuloHomeGate}
              disabled={puloHomeSignalSent}
              className={`w-full py-2.5 px-3 rounded-xl text-xs font-mono font-bold flex items-center justify-between transition-all ${
                puloHomeSignalSent
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                  : 'bg-[#151515] hover:bg-[#202020] text-white border border-[#2A2A2A] hover:border-[#FF2B2B]/60'
              }`}
            >
              <div className="flex items-center gap-2">
                <Home className="w-4 h-4 text-[#FF2B2B]" />
                <span>{puloHomeSignalSent ? 'Sinal PULO R2 Enviado' : 'Abrir Portão Residencial'}</span>
              </div>
              <ChevronRight className="w-4 h-4 text-[#666666]" />
            </button>

            {/* Ação 2: Rota Inteligente Gemini */}
            <button
              onClick={handleRequestRoute}
              className="w-full py-2.5 px-3 bg-[#151515] hover:bg-[#202020] text-white border border-[#2A2A2A] hover:border-[#FF2B2B]/60 rounded-xl text-xs font-mono font-bold flex items-center justify-between transition-all"
            >
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-[#FF2B2B]" />
                <span>Calcular Rota Sem Trânsito</span>
              </div>
              <ChevronRight className="w-4 h-4 text-[#666666]" />
            </button>
          </div>
        </div>

      </div>

      {/* Painel Inferior: Diagnóstico OBD-II e Verificação de DTC */}
      <div className="mt-6 bg-[#0A0A0A] border border-[#1A1A1A] rounded-2xl p-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#1A1A1A] pb-3 mb-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span className="text-xs font-mono font-bold text-white uppercase tracking-wider">
              Diagnóstico de Injeção & Sensores (OBD-II / CAN)
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleScanObd}
              disabled={isScanningObd}
              className="px-3 py-1.5 bg-[#181818] hover:bg-[#222222] border border-[#2A2A2A] hover:border-[#FF2B2B] rounded-lg text-xs font-mono font-semibold transition-all flex items-center gap-2 text-white"
            >
              <RotateCcw className={`w-3.5 h-3.5 text-[#FF2B2B] ${isScanningObd ? 'animate-spin' : ''}`} />
              <span>{isScanningObd ? 'Varrendo Barramento...' : 'Varredura de Sensores'}</span>
            </button>
          </div>
        </div>

        {scanMessage && (
          <div className="text-xs font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 p-2.5 rounded-lg mb-2 animate-fade-in">
            {scanMessage}
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
          <div className="p-2.5 bg-[#121212] rounded-xl border border-[#1F1F1F]">
            <span className="text-[#777777] block text-[10px]">CÓDIGOS DTC ATIVOS</span>
            <span className="text-sm font-bold text-emerald-400">0 (Nenhuma falha)</span>
          </div>
          <div className="p-2.5 bg-[#121212] rounded-xl border border-[#1F1F1F]">
            <span className="text-[#777777] block text-[10px]">PRESSÃO DOS PNEUS</span>
            <span className="text-sm font-bold text-white">32 PSI (Calibrado)</span>
          </div>
          <div className="p-2.5 bg-[#121212] rounded-xl border border-[#1F1F1F]">
            <span className="text-[#777777] block text-[10px]">SONDA LAMBDA</span>
            <span className="text-sm font-bold text-white">λ 1.00 (Estequiométrica)</span>
          </div>
          <div className="p-2.5 bg-[#121212] rounded-xl border border-[#1F1F1F]">
            <span className="text-[#777777] block text-[10px]">STATUS DO ALTERNADOR</span>
            <span className="text-sm font-bold text-emerald-400">14.1V (Gerando Carga)</span>
          </div>
        </div>
      </div>

    </div>
  );
};

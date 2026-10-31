/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useRef } from 'react';
import { useLioraStore } from '../../store/lioraStore';
import { speechService } from '../../services/speechService';
import { voiceLiveClient } from '../../services/voiceLiveClient';
import { 
  Activity, 
  Mic, 
  Volume2, 
  Wifi, 
  WifiOff, 
  Cpu, 
  ShieldCheck, 
  AlertTriangle, 
  CheckCircle2, 
  X, 
  RefreshCw, 
  Play, 
  Key, 
  ExternalLink,
  Sliders,
  Radio,
  Zap
} from 'lucide-react';

interface AudioDiagnosticPanelProps {
  onClose?: () => void;
  compact?: boolean;
}

export const AudioDiagnosticPanel: React.FC<AudioDiagnosticPanelProps> = ({ onClose, compact = false }) => {
  const { 
    isVoiceActive, 
    orbState, 
    isVaultKeyMissing, 
    vaultDiagnosticMessage, 
    setActiveTab, 
    runVaultDiagnostics 
  } = useLioraStore();

  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [peakLevel, setPeakLevel] = useState<number>(0);
  const [frequencyBins, setFrequencyBins] = useState<number[]>([0, 0, 0, 0, 0, 0, 0, 0]);
  const [speechDiag, setSpeechDiag] = useState(speechService.getDiagnosticData());
  const [liveDiag, setLiveDiag] = useState(voiceLiveClient.getDiagnosticData());
  const [testNotice, setTestNotice] = useState<string | null>(null);
  const [isTestingAudio, setIsTestingAudio] = useState(false);
  const peakRef = useRef<number>(0);
  const peakTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Intervalo de atualização de telemetria em tempo real (10Hz)
  useEffect(() => {
    const interval = setInterval(() => {
      setSpeechDiag(speechService.getDiagnosticData());
      setLiveDiag(voiceLiveClient.getDiagnosticData());
    }, 100);

    return () => clearInterval(interval);
  }, []);

  // Monitora nível de áudio e espectro de frequência com inscrição estável
  useEffect(() => {
    const unsubLevel = speechService.onAudioLevel((lvl) => {
      setAudioLevel(lvl);
      if (lvl > peakRef.current) {
        peakRef.current = lvl;
        setPeakLevel(lvl);
        if (peakTimerRef.current) clearTimeout(peakTimerRef.current);
        peakTimerRef.current = setTimeout(() => {
          peakRef.current = 0;
          setPeakLevel(0);
        }, 1500);
      }
    });

    const unsubFreq = speechService.onFrequencyData((bins) => {
      setFrequencyBins(bins);
    });

    return () => {
      unsubLevel();
      unsubFreq();
      if (peakTimerRef.current) clearTimeout(peakTimerRef.current);
    };
  }, []);

  const calculateDbfs = (lvl: number): string => {
    if (lvl <= 0) return '-60.0 dBFS';
    const db = Math.max(-60, Math.round(20 * Math.log10(lvl / 100) * 10) / 10);
    return `${db > 0 ? '+' : ''}${db.toFixed(1)} dBFS`;
  };

  const handleReactivateAudioContext = async () => {
    speechService.unlockAudio();
    const ctx = speechService.getOrCreateAudioContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    await speechService.requestMicrophonePermission();
    setSpeechDiag(speechService.getDiagnosticData());
    setTestNotice('AudioContext e microfone reativados com sucesso.');
    setTimeout(() => setTestNotice(null), 3000);
  };

  const handleTestTtsSound = async () => {
    setIsTestingAudio(true);
    setTestNotice(null);
    speechService.unlockAudio();
    
    try {
      await speechService.speak(
        'Diagnóstico de áudio da LIORA: Pipeline de síntese e reprodução operacional.',
        () => setTestNotice('Reproduzindo áudio de teste...'),
        () => {
          setIsTestingAudio(false);
          setTestNotice('Teste de reprodução concluído com sucesso.');
          setTimeout(() => setTestNotice(null), 3000);
        }
      );
    } catch (e: any) {
      setIsTestingAudio(false);
      setTestNotice(`Falha no teste: ${e?.message || 'Erro de síntese'}`);
    }
  };

  const isHealthy = speechDiag.audioContextState === 'running' && !isVaultKeyMissing;

  return (
    <div className={`bg-[#050505]/95 backdrop-blur-2xl border border-[#222222] rounded-2xl p-5 text-white shadow-2xl space-y-5 animate-in fade-in duration-200 ${compact ? 'max-w-xl' : 'max-w-3xl w-full'}`}>
      {/* Header Diagnóstico */}
      <div className="flex items-center justify-between pb-3 border-b border-[#222222]">
        <div className="flex items-center gap-3 min-w-0">
          <div className={`p-2.5 rounded-xl border shrink-0 ${isHealthy ? 'bg-emerald-950/80 border-emerald-500/40 text-emerald-400' : 'bg-red-950/80 border-red-500/40 text-red-400'}`}>
            <Activity className="w-5 h-5 animate-pulse" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-sm text-white font-mono uppercase tracking-wider truncate">
                Painel Diagnóstico de Áudio (Live Telemetry)
              </h3>
              <span className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase font-bold shrink-0 ${isHealthy ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
                {isHealthy ? '● Pipeline Saudável' : '▲ Atenção'}
              </span>
            </div>
            <p className="text-[11px] text-[#888888] truncate">
              Monitoramento em tempo real do microfone, taxa de amostragem e WebSockets.
            </p>
          </div>
        </div>

        {onClose && (
          <button
            onClick={onClose}
            className="p-2 hover:bg-[#1A1A1A] text-[#888888] hover:text-white rounded-xl transition-colors shrink-0"
            title="Fechar Painel Diagnóstico"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Alerta se houver aviso de chave ou contexto */}
      {isVaultKeyMissing && (
        <div className="p-3 bg-red-950/80 border border-red-700/60 rounded-xl text-red-200 text-xs flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
            <span className="font-medium">{vaultDiagnosticMessage || 'Chave do Gemini ausente no Cofre.'}</span>
          </div>
          <button
            onClick={() => setActiveTab('integrations')}
            className="px-2.5 py-1 bg-red-600 hover:bg-red-500 text-white rounded text-[11px] font-bold shrink-0 flex items-center gap-1"
          >
            <span>Configurar</span>
            <ExternalLink className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Feedback de Teste Direto */}
      {testNotice && (
        <div className="p-2.5 bg-[#121212] border border-[#282828] rounded-xl text-xs text-emerald-400 flex items-center gap-2 animate-in fade-in">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{testNotice}</span>
        </div>
      )}

      {/* Grade de Métricas Principais (4 Colunas) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Metric 1: VU Meter / Nível de Entrada */}
        <div className="bg-[#0A0A0A] border border-[#222222] rounded-xl p-3 space-y-2">
          <div className="flex items-center justify-between text-xs text-[#888888]">
            <span className="flex items-center gap-1.5 font-medium text-white">
              <Mic className="w-3.5 h-3.5 text-red-400" />
              Volume Entrada
            </span>
            <span className="font-mono text-[10px] text-red-400">{calculateDbfs(audioLevel)}</span>
          </div>
          <div className="space-y-1">
            <div className="h-3 bg-[#141414] rounded-full overflow-hidden border border-[#262626] relative">
              <div 
                className="h-full bg-gradient-to-r from-emerald-500 via-amber-500 to-red-500"
                style={{ width: `${Math.min(100, Math.max(0, audioLevel))}%` }}
              />
              {peakLevel > 0 && (
                <span 
                  className="absolute top-0 bottom-0 w-1 bg-white shadow-[0_0_8px_#ffffff]"
                  style={{ left: `${Math.min(100, Math.max(0, peakLevel))}%` }}
                />
              )}
            </div>
            <div className="flex justify-between text-[9px] font-mono text-[#666666]">
              <span>-60 dB</span>
              <span>-24 dB</span>
              <span>0 dB</span>
            </div>
          </div>
          <p className="text-[10px] text-[#777777] truncate">
            {speechDiag.usingFallbackMeter ? 'Sintetizador Espectral (Simulado)' : speechDiag.hasMediaStream ? 'Microfone Físico Ativo' : 'Microfone Inativo'}
          </p>
        </div>

        {/* Metric 2: AudioContext & Sample Rate */}
        <div className="bg-[#0A0A0A] border border-[#222222] rounded-xl p-3 space-y-2">
          <div className="flex items-center justify-between text-xs text-[#888888]">
            <span className="flex items-center gap-1.5 font-medium text-white">
              <Cpu className="w-3.5 h-3.5 text-blue-400" />
              Taxa Amostragem
            </span>
            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${speechDiag.audioContextState === 'running' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'}`}>
              {speechDiag.audioContextState}
            </span>
          </div>
          <div className="font-mono text-base font-bold text-white">
            {speechDiag.sampleRate.toLocaleString()} <span className="text-xs font-normal text-[#888888]">Hz (PCM16)</span>
          </div>
          <div className="text-[10px] text-[#777777] flex items-center justify-between">
            <span>Latência Base: {speechDiag.baseLatencyMs}ms</span>
            <span>WAV 16kHz</span>
          </div>
        </div>

        {/* Metric 3: WebSocket & Stream State */}
        <div className="bg-[#0A0A0A] border border-[#222222] rounded-xl p-3 space-y-2">
          <div className="flex items-center justify-between text-xs text-[#888888]">
            <span className="flex items-center gap-1.5 font-medium text-white">
              <Wifi className="w-3.5 h-3.5 text-emerald-400" />
              WebSocket
            </span>
            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${liveDiag.wsStateLabel === 'CONNECTED' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
              {liveDiag.wsStateLabel}
            </span>
          </div>
          <div className="font-mono text-xs font-bold text-white truncate">
            {liveDiag.wsUrl}
          </div>
          <div className="text-[10px] text-[#777777] flex items-center justify-between">
            <span>Saída: {liveDiag.outputSampleRate.toLocaleString()} Hz</span>
            <span>{liveDiag.isSimulated ? 'Modo Simulado' : 'Nativo'}</span>
          </div>
        </div>

        {/* Metric 4: Cofre & Motor STT */}
        <div className="bg-[#0A0A0A] border border-[#222222] rounded-xl p-3 space-y-2">
          <div className="flex items-center justify-between text-xs text-[#888888]">
            <span className="flex items-center gap-1.5 font-medium text-white">
              <Key className="w-3.5 h-3.5 text-amber-400" />
              Cofre / STT
            </span>
            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${!isVaultKeyMissing ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
              {!isVaultKeyMissing ? 'OK' : 'Ausente'}
            </span>
          </div>
          <div className="text-xs font-semibold text-white truncate">
            {speechDiag.hasWebSpeechSupport ? 'Web Speech API + Gemini' : 'Gemini Transcribe Audio'}
          </div>
          <div className="text-[10px] text-[#777777] flex items-center justify-between">
            <span>Cache de Voz: {speechDiag.cachedPhrasesCount} frases</span>
          </div>
        </div>
      </div>

      {/* Espectro de Frequência em Tempo Real (20 Bandas) */}
      <div className="bg-[#080808] border border-[#1E1E1E] rounded-xl p-3 space-y-2">
        <div className="flex items-center justify-between text-xs text-[#888888]">
          <span className="font-medium text-white flex items-center gap-1.5">
            <Radio className="w-3.5 h-3.5 text-[#FF2B2B]" />
            Analisador de Espectro Físico (20 Bins Hz)
          </span>
          <span className="font-mono text-[10px] text-[#666666]">Web Audio API FFT 64</span>
        </div>
        <div className="flex items-end justify-between gap-1 h-12 pt-1 px-1">
          {Array.from({ length: 20 }).map((_, idx) => {
            const val = frequencyBins[idx] !== undefined ? frequencyBins[idx] : 0;
            const hPx = Math.max(4, Math.min(36, Math.round((val / 100) * 36)));
            const isHigh = val > 60;
            const isMid = val > 20;
            const barColor = isHigh ? '#FF2B2B' : isMid ? '#EAB308' : val > 5 ? '#22C55E' : '#2A2A2A';
            return (
              <div 
                key={idx} 
                className="flex-1 rounded-sm"
                style={{ 
                  height: `${hPx}px`, 
                  backgroundColor: barColor,
                  boxShadow: val > 20 ? `0 0 6px ${barColor}` : 'none'
                }}
              />
            );
          })}
        </div>
      </div>

      {/* Ações e Ferramentas Diagnósticas */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#222222]">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleReactivateAudioContext}
            className="px-3 py-1.5 bg-[#181818] hover:bg-[#252525] border border-[#333333] text-white rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer"
            title="Força o áudio do navegador a reativar caso o autoplay tenha sido bloqueado"
          >
            <Zap className="w-3.5 h-3.5 text-amber-400" />
            <span>Desbloquear Áudio</span>
          </button>

          <button
            onClick={handleTestTtsSound}
            disabled={isTestingAudio}
            className="px-3 py-1.5 bg-[#181818] hover:bg-[#252525] border border-[#333333] text-white rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            title="Sintetiza uma frase curta de teste"
          >
            {isTestingAudio ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Volume2 className="w-3.5 h-3.5 text-blue-400" />}
            <span>Testar Voz (TTS)</span>
          </button>

          <button
            onClick={() => runVaultDiagnostics()}
            className="px-3 py-1.5 bg-[#181818] hover:bg-[#252525] border border-[#333333] text-white rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer"
            title="Re-executa a validação de chaves do Cofre"
          >
            <RefreshCw className="w-3.5 h-3.5 text-emerald-400" />
            <span>Reverificar Cofre</span>
          </button>
        </div>

        <button
          onClick={() => setActiveTab('integrations')}
          className="px-3 py-1.5 bg-[#FF2B2B] hover:bg-red-600 text-white rounded-lg text-xs font-bold transition-all shadow-md hover:scale-105 flex items-center gap-1.5 cursor-pointer ml-auto"
        >
          <Sliders className="w-3.5 h-3.5" />
          <span>Configurar no Cofre</span>
        </button>
      </div>
    </div>
  );
};

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useRef } from 'react';
import { useLioraStore } from '../store/lioraStore';
import { speechService } from '../services/speechService';
import { voiceLiveClient } from '../services/voiceLiveClient';
import { 
  Mic, 
  MicOff, 
  Send, 
  MessageSquare,
  AlertCircle,
  Volume2,
  ExternalLink,
  Activity
} from 'lucide-react';
import { AudioDiagnosticPanel } from './voice/AudioDiagnosticPanel';

export const GlobalVoiceBar: React.FC = () => {
  const { 
    isVoiceActive, 
    orbState,
    toggleVoice, 
    sendMessage, 
    setOrbState, 
    setActiveTab,
    isGenerating,
    isSidebarExpanded,
    isTelemetryOpen,
    activeTab,
    isVaultKeyMissing,
    vaultDiagnosticMessage,
    runVaultDiagnostics
  } = useLioraStore();

  const [transcript, setTranscript] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [frequencyBins, setFrequencyBins] = useState<number[]>([0, 0, 0, 0, 0, 0, 0, 0]);
  const [showDiagnosticModal, setShowDiagnosticModal] = useState(false);
  const [windowWidth, setWindowWidth] = useState<number>(typeof window !== 'undefined' ? window.innerWidth : 1280);
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    runVaultDiagnostics();
  }, [isVoiceActive, runVaultDiagnostics]);

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    voiceLiveClient.setCallbacks({
      onAudioLevel: (lvl) => {
        if (speechService.isUsingFallbackMeter() || !speechService.isListening()) {
          setAudioLevel(Math.round(lvl * 100));
        }
      },
      onTranscription: (text, role) => {
        if (role === 'user') {
          setTranscript(text);
        }
      },
      onError: (err) => {
        setErrorMessage(err);
      }
    });
  }, []);

  const vadSpeakingRef = useRef<boolean>(false);
  const vadStartTimeRef = useRef<number>(0);
  const isDispatchingRef = useRef<boolean>(false);

  const transcriptRef = useRef(transcript);
  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  // Envio consolidado e atômico com trava contra duplicidade de voz
  const dispatchVoiceCommand = async (text: string, audioBlob?: { data: string; mimeType: string }) => {
    if (isDispatchingRef.current) return;
    const store = useLioraStore.getState();
    if (store.isGenerating) return;

    isDispatchingRef.current = true;
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    vadSpeakingRef.current = false;
    setTranscript('');
    setOrbState('THINKING');

    // Interrompe imediatamente qualquer escuta ativa para evitar recaptura da própria fala da assistente
    speechService.stopListening();

    try {
      speechService.unlockAudio();
      speechService.playInstantAcknowledgment();
      await sendMessage(text, undefined, audioBlob);
    } catch (err) {
      console.error('[GlobalVoiceBar] Erro ao enviar comando de voz:', err);
      setOrbState('LISTENING');
    } finally {
      setTimeout(() => {
        isDispatchingRef.current = false;
      }, 800);
    }
  };

  // Monitora nível de áudio e espectro de frequência em tempo real (Web Audio API VAD)
  useEffect(() => {
    if (!isVoiceActive) {
      setAudioLevel(0);
      setFrequencyBins([0, 0, 0, 0, 0, 0, 0, 0]);
      vadSpeakingRef.current = false;
      return;
    }

    const unsubLevel = speechService.onAudioLevel((lvl) => {
      setAudioLevel(lvl);

      const store = useLioraStore.getState();
      if (store.isGenerating || store.orbState === 'THINKING' || store.orbState === 'SPEAKING' || isDispatchingRef.current) {
        vadSpeakingRef.current = false;
        return;
      }

      // Somente ativa auto-VAD se o microfone real estiver conectado (não sintetizador/fallback)
      if (speechService.isUsingFallbackMeter()) {
        return;
      }

      // Detecção de voz no headset (nível >= 14)
      if (lvl >= 14) {
        if (!vadSpeakingRef.current) {
          vadSpeakingRef.current = true;
          vadStartTimeRef.current = Date.now();
        }
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = null;
        }
      } 
      // Detecção de silêncio após frase falada no headset (nível < 8) - Apenas se não houver texto do STT ativo
      else if (lvl < 8 && vadSpeakingRef.current && !transcriptRef.current.trim()) {
        const duration = Date.now() - vadStartTimeRef.current;
        if (!silenceTimerRef.current && duration >= 400) {
          silenceTimerRef.current = setTimeout(async () => {
            if (isDispatchingRef.current) return;
            const audioBlob = await speechService.getRecordedAudioBlob();
            if (audioBlob) {
              try {
                speechService.unlockAudio();
                speechService.playInstantAcknowledgment();
                const transRes = await speechService.transcribeAudio(audioBlob);
                if (transRes.success && transRes.text && transRes.hasSpeech) {
                  await dispatchVoiceCommand(transRes.text, audioBlob);
                } else {
                  console.info('[GlobalVoiceBar VAD] Áudio capturado sem fala reconhecível.');
                  setOrbState('LISTENING');
                }
              } catch (err) {
                console.error('[GlobalVoiceBar VAD] Erro na transcrição de áudio:', err);
                setOrbState('LISTENING');
              }
            }
          }, 750);
        }
      }
    });

    const unsubFreq = speechService.onFrequencyData((bins) => {
      setFrequencyBins(bins);
    });

    return () => {
      unsubLevel();
      unsubFreq();
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    };
  }, [isVoiceActive, sendMessage, setOrbState]);

  // Iniciar ou pausar reconhecimento de voz quando isVoiceActive ou orbState mudar
  useEffect(() => {
    if (!isVoiceActive) {
      speechService.stopListening();
      voiceLiveClient.stop();
      setTranscript('');
      setErrorMessage(null);
      return;
    }

    // Se a LIORA estiver processando raciocínio ou falando em voz alta, pausa a escuta do mic
    if (orbState === 'THINKING' || orbState === 'SPEAKING') {
      speechService.stopListening();
      return;
    }

    setErrorMessage(null);

    // Iniciar imediatamente o cliente WebSocket Gemini Live para duplex em tempo real
    voiceLiveClient.start();

    // Tentar inicializar o Web Speech API para transcrição complementar
    const started = speechService.startListening(
      (text, isFinal) => {
        setTranscript(text);
        if (useLioraStore.getState().orbState !== 'THINKING') {
          setOrbState('LISTENING');
        }
        setErrorMessage(null);

        // Resetar timer de silêncio
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
        }

        // Reconhece palavras curtas como "oi", mas permite continuidade natural da fala sem corte prematuro
        const clean = text.trim();
        if (clean.length >= 2) {
          // Limiar calibrado de 750ms para resultado final ou 1200ms para texto parcial
          const delayMs = isFinal ? 750 : 1200;
          silenceTimerRef.current = setTimeout(async () => {
            const promptToSend = clean;
            setTranscript('');
            try {
              speechService.unlockAudio();
              await dispatchVoiceCommand(promptToSend);
            } catch (err) {
              console.error('[GlobalVoiceBar] Erro ao enviar prompt de voz:', err);
              setOrbState('LISTENING');
            }
          }, delayMs);
        }
      },
      (error) => {
        console.warn('[GlobalVoiceBar] Erro ou aviso no microfone:', error);
        setErrorMessage(error);
      },
      () => {
        // Reinício automático tratado internamente em speechService
      }
    );

    return () => {
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
      }
      speechService.stopListening();
    };
  }, [isVoiceActive, orbState, sendMessage, setOrbState]);

  if (!isVoiceActive) {
    return null;
  }

  const handleManualSend = async () => {
    if (!transcript.trim() || isGenerating) return;
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
    }
    const textToSend = transcript.trim();
    setTranscript('');
    setOrbState('THINKING');
    speechService.unlockAudio();
    try {
      await sendMessage(textToSend);
    } catch (err) {
      console.error('[GlobalVoiceBar] Erro ao enviar transcrição manual:', err);
    }
  };

  const handleStopVoice = () => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
    }
    speechService.stopListening();
    speechService.stopSpeaking();
    voiceLiveClient.stop();
    toggleVoice();
  };

  // Alinhamento horizontal preciso com o canvas do Orb central
  const getHorizontalCenterStyle = (): React.CSSProperties => {
    let offsetPx = 0;
    const isDesktop = windowWidth >= 768;
    const isXl = windowWidth >= 1280;

    if (isDesktop) {
      const sidebarWidth = isSidebarExpanded ? 256 : 80;
      const telemetryWidth = (activeTab === 'home' && isTelemetryOpen && isXl) ? 384 : 0;
      offsetPx = (sidebarWidth - telemetryWidth) / 2;
    }

    return {
      left: offsetPx !== 0 ? `calc(50% + ${offsetPx}px)` : '50%',
      transform: 'translateX(-50%)',
      transition: 'left 0.3s cubic-bezier(0.16, 1, 0.3, 1), transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
      boxShadow: '0 10px 30px rgba(0,0,0,0.8), 0 0 25px var(--accent-glow)'
    };
  };

  const handleGrantMicPermission = async () => {
    setErrorMessage(null);
    const result = await speechService.requestMicrophonePermission();
    if (result.success) {
      setOrbState('LISTENING');
    } else if (result.error) {
      setErrorMessage(result.error);
    }
  };

  const getStatusLabel = () => {
    if (orbState === 'THINKING' || isGenerating) return 'LIORA Processando...';
    if (orbState === 'SPEAKING') return 'LIORA Respondendo...';
    return 'LIORA Ouvindo';
  };

  return (
    <aside 
      aria-label="Controle de Voz Global LIORA"
      className="fixed bottom-5 z-50 w-[94%] max-w-2xl sm:max-w-3xl bg-[#050505]/95 backdrop-blur-2xl border border-[#262626] shadow-[0_20px_50px_rgba(0,0,0,0.95),0_0_30px_rgba(255,43,43,0.2)] rounded-2xl p-4 text-white animate-in slide-in-from-bottom duration-300 pointer-events-auto"
      style={getHorizontalCenterStyle()}
    >
      {/* Alerta Visual Persistente se a Chave do Cofre estiver ausente */}
      {isVaultKeyMissing && (
        <div className="mb-3.5 p-3 rounded-xl bg-red-950/80 border border-[#FF2B2B]/60 text-red-200 flex items-center justify-between gap-3 shadow-[0_0_15px_rgba(255,43,43,0.15)] animate-pulse">
          <div className="flex items-center gap-2.5 min-w-0">
            <AlertCircle className="w-5 h-5 text-[#FF2B2B] shrink-0" />
            <p className="text-xs font-semibold leading-tight truncate">
              {vaultDiagnosticMessage || 'Chave de API do Gemini ausente ou não configurada no Cofre.'}
            </p>
          </div>
          <button
            onClick={() => setActiveTab('integrations')}
            className="shrink-0 px-3 py-1.5 bg-[#FF2B2B] hover:bg-red-600 text-white text-xs font-bold rounded-lg shadow transition-all hover:scale-105 flex items-center gap-1"
            title="Ir para o Cofre de Integrações para configurar a chave"
          >
            <span>Configurar no Cofre</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="flex items-center justify-between gap-4">
        {/* Indicador Visual Prominente do Status da LIORA */}
        <div className="flex items-center gap-4 flex-1 min-w-0">
          <div 
            className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 shadow-xl relative bg-[#FF2B2B] border border-red-400/40"
          >
            {orbState === 'SPEAKING' ? (
              <Volume2 className="w-6 h-6 text-white animate-bounce" />
            ) : (
              <Mic className="w-6 h-6 text-white animate-pulse" />
            )}
            
            {/* Anel de Pulsar Ativo */}
            <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-80"></span>
              <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-[#FF2B2B] border-2 border-[#050505]"></span>
            </span>
          </div>

          <div className="flex-1 min-w-0 flex items-center gap-4">
            <span className="text-sm font-bold uppercase tracking-widest text-white font-mono shrink-0 hidden sm:inline-block">
              {getStatusLabel()}
            </span>

            {/* Espectro de Frequência Extenso e Prominente (Web Audio API) */}
            <div 
              className="flex-1 flex items-end justify-between gap-1 sm:gap-1.5 px-4 py-2 bg-[#080808] rounded-2xl border border-[#282828] h-11 cursor-pointer hover:border-[#FF2B2B] transition-all shadow-inner min-w-[180px] max-w-md"
              onClick={handleGrantMicPermission}
              title="Clique para autorizar ou calibrar o microfone"
            >
              {Array.from({ length: 20 }).map((_, idx) => {
                const val = frequencyBins[idx] !== undefined ? frequencyBins[idx] : 0;
                const hPx = Math.max(4, Math.min(28, Math.round((val / 100) * 28)));
                const isHigh = val > 60;
                const isMid = val > 20;
                const barColor = isHigh ? '#FF2B2B' : isMid ? '#EAB308' : val > 5 ? '#22C55E' : '#333333';
                return (
                  <span 
                    key={idx}
                    className="flex-1 rounded-sm min-w-[2px]"
                    style={{ 
                      height: `${hPx}px`, 
                      backgroundColor: barColor,
                      boxShadow: val > 15 ? `0 0 8px ${barColor}` : 'none'
                    }}
                  />
                );
              })}
            </div>
          </div>
        </div>

        {/* Ações Diretas */}
        <div className="flex items-center gap-2.5 shrink-0">
          <button
            onClick={() => setShowDiagnosticModal(!showDiagnosticModal)}
            className={`p-3 border rounded-2xl transition-all hover:scale-105 ${
              showDiagnosticModal 
                ? 'bg-[#FF2B2B] border-[#FF2B2B] text-white shadow-[0_0_15px_rgba(255,43,43,0.4)]' 
                : 'bg-[#121212] hover:bg-[#1E1E1E] text-[#A8A8A8] hover:text-white border-[#2A2A2A]'
            }`}
            title="Abrir Painel Diagnóstico de Áudio (Volume, Sample Rate e WebSockets)"
          >
            <Activity className="w-4.5 h-4.5" />
          </button>

          <button
            onClick={() => setActiveTab('conversation')}
            className="p-3 bg-[#121212] hover:bg-[#1E1E1E] text-[#A8A8A8] hover:text-white border border-[#2A2A2A] rounded-2xl transition-all hover:scale-105"
            title="Abrir tela de conversa completa"
          >
            <MessageSquare className="w-4.5 h-4.5" />
          </button>

          <button
            onClick={handleStopVoice}
            className="flex items-center gap-1.5 px-4 py-2.5 bg-red-950/90 hover:bg-red-900 border border-red-700/60 text-red-200 rounded-2xl text-xs font-bold transition-all shadow-md hover:scale-105"
            title="Encerrar microfone e sessão de voz"
          >
            <MicOff className="w-4 h-4 text-red-400" />
            <span className="hidden sm:inline">Pausar Voz</span>
          </button>
        </div>
      </div>

      {/* Modal Diagnóstico de Áudio Flutuante */}
      {showDiagnosticModal && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 w-[96%] max-w-2xl sm:max-w-3xl animate-in slide-in-from-bottom duration-200 pointer-events-auto">
          <AudioDiagnosticPanel onClose={() => setShowDiagnosticModal(false)} />
        </div>
      )}
    </aside>
  );
};

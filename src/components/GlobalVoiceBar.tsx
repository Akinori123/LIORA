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
import { eventBus } from '../utils/eventBus';
import { parseNavigationIntent, parseRouteIntent, parsePlacesSearchIntent, NavigationMatch, RouteIntent, PlacesSearchIntent } from '../utils/navigationParser';
import { launchGpsNavigation, launchPlacesSearch } from '../tools/navigation/navigationActionTool';

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

  // FIX C2: espelho do orbState em ref para o ciclo de vida da voz NÃO depender
  // de estados que mudam durante a sessão (orbState). Sem isso, o effect de voz
  // reinicializava o voiceLiveClient/microfone a cada transição do Orbe.
  const orbStateRef = useRef(orbState);
  useEffect(() => { orbStateRef.current = orbState; }, [orbState]);

  useEffect(() => {
    runVaultDiagnostics();
  }, [isVoiceActive, runVaultDiagnostics]);

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Interceptação determinística e imediata de comandos de navegação de voz (Live e VAD)
  const handleDeterministicNavigation = (navMatch: NavigationMatch) => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    vadSpeakingRef.current = false;
    isDispatchingRef.current = false;

    // 1. Troca imediata de aba na UI
    setActiveTab(navMatch.tab);
    setTranscript('');
    setErrorMessage(null);

    // 2. Interrompe modelo Live e escuta anterior para liberar o ciclo
    voiceLiveClient.interrupt();
    speechService.stopListening();

    // 3. Feedback falado curto e elegante
    setOrbState('SPEAKING');
    speechService.unlockAudio();
    speechService.speak(navMatch.spokenFeedback);

    // 4. Retorno limpo para estado de escuta, impedindo travamento em THINKING/EXECUTING
    setTimeout(() => {
      const currentVoiceActive = useLioraStore.getState().isVoiceActive;
      setOrbState(currentVoiceActive ? 'LISTENING' : 'IDLE');
    }, 1200);

    // 5. Registro forense de auditoria
    useLioraStore.getState().addActivityLog({
      category: 'system',
      summary: `Navegação de Voz: ${navMatch.label}`,
      details: `Comando "${navMatch.rawInput}" reconhecido determinísticamente pelo canal de voz.`,
      riskLevel: 'R0',
      status: 'success',
      simulated: false
    });
  };

  // Interceptação determinística e imediata de rotas veiculares (Google Maps / Waze)
  const handleDeterministicRoute = async (routeIntent: RouteIntent) => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    vadSpeakingRef.current = false;
    isDispatchingRef.current = false;

    setTranscript('');
    setErrorMessage(null);

    // 1. Interrompe modelo Live e escuta anterior para liberar o ciclo
    voiceLiveClient.interrupt();
    speechService.stopListening();

    // 2. Feedback falado veicular imediato
    setOrbState('SPEAKING');
    speechService.unlockAudio();
    speechService.speak(routeIntent.spokenFeedback);

    // 3. Abertura do Google Maps ou Waze
    try {
      await launchGpsNavigation(routeIntent.destination, routeIntent.provider, routeIntent.origin);
    } catch (err) {
      console.warn('[GlobalVoiceBar] Falha ao acionar rota de GPS:', err);
    }

    // 4. Retorno limpo para estado de escuta
    setTimeout(() => {
      const currentVoiceActive = useLioraStore.getState().isVoiceActive;
      setOrbState(currentVoiceActive ? 'LISTENING' : 'IDLE');
    }, 1500);

    // 5. Registro forense de auditoria sem alterar a aba ativa
    const appName = routeIntent.provider === 'waze' ? 'Waze' : 'Google Maps';
    useLioraStore.getState().addActivityLog({
      category: 'tool',
      summary: `Navegação GPS Ativa (${appName})`,
      details: `Comando "${routeIntent.rawInput}" executado. Destino: "${routeIntent.destination}"${routeIntent.origin ? ` | Origem: "${routeIntent.origin}"` : ' | Origem: GPS Atual'}.`,
      riskLevel: 'R0',
      status: 'success',
      simulated: false
    });
  };

  // Interceptação determinística e imediata de busca de locais (Google Maps Places)
  const handleDeterministicPlacesSearch = async (placesIntent: PlacesSearchIntent) => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    vadSpeakingRef.current = false;
    isDispatchingRef.current = false;

    setTranscript('');
    setErrorMessage(null);

    // 1. Interrompe modelo Live e escuta anterior para liberar o ciclo
    voiceLiveClient.interrupt();
    speechService.stopListening();

    // 2. Feedback falado veicular/assistente imediato
    setOrbState('SPEAKING');
    speechService.unlockAudio();
    speechService.speak(placesIntent.spokenFeedback);

    // 3. Abertura do Google Maps Places nativamente
    try {
      await launchPlacesSearch(placesIntent.query, placesIntent.nearLocation);
    } catch (err) {
      console.warn('[GlobalVoiceBar] Falha ao acionar busca de locais:', err);
    }

    // 4. Retorno limpo para estado de escuta
    setTimeout(() => {
      const currentVoiceActive = useLioraStore.getState().isVoiceActive;
      setOrbState(currentVoiceActive ? 'LISTENING' : 'IDLE');
    }, 1500);

    // 5. Registro forense de auditoria
    useLioraStore.getState().addActivityLog({
      category: 'tool',
      summary: 'Busca de Locais (Google Maps)',
      details: `Comando "${placesIntent.rawInput}" executado. Termo: "${placesIntent.query}"${placesIntent.nearLocation ? ` | Referência: "${placesIntent.nearLocation}"` : ' | Perto da localização atual'}.`,
      riskLevel: 'R0',
      status: 'success',
      simulated: false
    });
  };

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
          // P1: publica a fala do usuário no eventBus — o GlobalConsentOverlay
          // escuta por "confirmar"/"cancelar" enquanto há consentimento pendente.
          eventBus.publish('liora:voice_transcript', { text, role });

          // Interceptação determinística IMEDIATA no modo Live antes de qualquer chamada do LLM
          const navMatch = parseNavigationIntent(text);
          if (navMatch) {
            handleDeterministicNavigation(navMatch);
            return;
          }

          const routeIntent = parseRouteIntent(text);
          if (routeIntent) {
            handleDeterministicRoute(routeIntent);
            return;
          }

          const placesIntent = parsePlacesSearchIntent(text);
          if (placesIntent) {
            handleDeterministicPlacesSearch(placesIntent);
            return;
          }
        }
      },
      onError: (err) => {
        setErrorMessage(err);
      }
    });
  }, []);

  useEffect(() => {
    // ETAPA D (anti-silêncio): banner visual para avisos de voz/quota/microfone
    return eventBus.subscribe('liora:voice_warning', (payload: any) => {
      if (payload?.message) setErrorMessage(String(payload.message));
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

    // Bug hunt (race condition): durante o consentimento pendente, a fala do usuário
    // ("confirmar"/"cancelar") deve ir APENAS ao GlobalConsentOverlay — se também
    // fosse despachada como nova mensagem de chat, geraria resposta duplicada e
    //consumiria o turno. Aqui o VAD cede a palavra ao overlay.
    if (store.pendingConsent?.status === 'PENDING') {
      eventBus.publish('liora:voice_transcript', { text, role: 'user' });
      return;
    }

    // Interceptação determinística de navegação ANTES de invocar o LLM
    const navMatch = parseNavigationIntent(text);
    if (navMatch) {
      handleDeterministicNavigation(navMatch);
      return;
    }

    const routeIntent = parseRouteIntent(text);
    if (routeIntent) {
      handleDeterministicRoute(routeIntent);
      return;
    }

    const placesIntent = parsePlacesSearchIntent(text);
    if (placesIntent) {
      handleDeterministicPlacesSearch(placesIntent);
      return;
    }

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
      // R1: não descarta a fala se há consentimento pendente — é uma janela de
      // "escuta de decisão priorizada". "Confirmar" dito durante SPEAKING deve ser capturado.
      const hasPendingConsent = store.pendingConsent?.status === 'PENDING';
      if (!hasPendingConsent && (store.isGenerating || store.orbState === 'THINKING' || store.orbState === 'SPEAKING' || isDispatchingRef.current)) {
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
      // BUG CRÍTICO CORRIGIDO (A — troca de modo): ao desativar a voz, a fila de
      // streaming TTS e o áudio do Live continuavam tocando frases antigas sobre-
      // postas ao novo comando escrito. Cancelamento explícito de tudo:
      speechService.stopSpeaking();      // esvazia fila de streaming + cancela utterance/atual
      speechService.resetStreamingQueue(); // zera buffer parcial + isStreamDone
      voiceLiveClient.interrupt();       // corta áudio recebido do Gemini
      voiceLiveClient.stop();            // fecha WS duplex
      setTranscript('');
      setErrorMessage(null);
      return;
    }

    // Se a LIORA estiver processando raciocínio ou falando em voz alta, pausa a escuta do mic
    // FIX C2: leitura de estado via ref — o effect só reinicia quando isVoiceActive muda de verdade
    // R1: EXCETO se há consentimento pendente — escuta de decisão priorizada
    // permanece com o mic aberto para capturar "confirmar/cancelar" na primeira sílaba.
    const storeState = useLioraStore.getState();
    const hasPendingConsent = storeState.pendingConsent?.status === 'PENDING';
    if (!hasPendingConsent && (orbStateRef.current === 'THINKING' || orbStateRef.current === 'SPEAKING')) {
      speechService.stopListening();
      return;
    }

    setErrorMessage(null);

    // Exaustão: inicia o Live de forma fire-and-forget mas CONTIDA — start() é
    // idempotente internamente (retorna true se já ativo) e a reconexão R3
    // reusa o mesmo fluxo, sem duplicar microfone/WS.
    void voiceLiveClient.start().catch((startErr) => {
      console.warn('[GlobalVoiceBar] start() do Live falhou:', startErr);
    });

    // Tentar inicializar o Web Speech API para transcrição complementar
    const started = speechService.startListening(
      (text, isFinal) => {
        setTranscript(text);
        // P1: publica também a transcrição do Web Speech API para o overlay de consentimento
        if (isFinal) {
          eventBus.publish('liora:voice_transcript', { text, role: 'user' });
        }
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
          // Interceptação determinística imediata de navegação no STT antes do timer de silêncio
          const navMatch = parseNavigationIntent(clean);
          if (navMatch) {
            if (silenceTimerRef.current) {
              clearTimeout(silenceTimerRef.current);
              silenceTimerRef.current = null;
            }
            handleDeterministicNavigation(navMatch);
            return;
          }

          const routeIntent = parseRouteIntent(clean);
          if (routeIntent) {
            if (silenceTimerRef.current) {
              clearTimeout(silenceTimerRef.current);
              silenceTimerRef.current = null;
            }
            handleDeterministicRoute(routeIntent);
            return;
          }

          const placesIntent = parsePlacesSearchIntent(clean);
          if (placesIntent) {
            if (silenceTimerRef.current) {
              clearTimeout(silenceTimerRef.current);
              silenceTimerRef.current = null;
            }
            handleDeterministicPlacesSearch(placesIntent);
            return;
          }

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
  }, [isVoiceActive, sendMessage, setOrbState]);

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

      {/* ETAPA D (anti-silêncio): banner de erro de voz/microfone/quota — o usuário
          nunca fica às cegas sem saber se a LIORA travou ou está respondendo. */}
      {!isVaultKeyMissing && errorMessage && (
        <div className="mb-3.5 p-3 rounded-xl bg-amber-950/70 border border-amber-600/50 text-amber-200 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 animate-pulse" />
            <p className="text-xs font-semibold leading-tight truncate">{errorMessage}</p>
          </div>
          <button
            onClick={() => setErrorMessage(null)}
            className="shrink-0 px-2.5 py-1 bg-amber-600 hover:bg-amber-500 text-white text-[10px] font-bold rounded-lg"
          >
            Entendi
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

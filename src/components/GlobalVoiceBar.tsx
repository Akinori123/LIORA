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
import { parsePcCommandIntent, PcCommandMatch } from '../utils/pcCommandParser';
import { parseTimeCommandIntent, TimeQueryMatch } from '../utils/timeCommandParser';
import { launchGpsNavigation, launchPlacesSearch } from '../tools/navigation/navigationActionTool';
import { executePcAction } from '../tools/pc/pcActionLauncher';

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
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vadSpeakingRef = useRef<boolean>(false);
  const vadStartTimeRef = useRef<number>(0);
  const isDispatchingRef = useRef<boolean>(false);
  const transcriptRef = useRef<string>(transcript);
  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);
  const setOrbStateRef = useRef(setOrbState);
  useEffect(() => {
    setOrbStateRef.current = setOrbState;
  }, [setOrbState]);
  const lastExecutedCommandRef = useRef<{ key: string; time: number }>({ key: '', time: 0 });

  // FIX C2: espelho do orbState em ref para o ciclo de vida da voz NÃO depender
  // de estados que mudam durante a sessão (orbState). Sem isso, o effect de voz
  // reinicializava o voiceLiveClient/microfone a cada transição do Orbe.
  const orbStateRef = useRef(orbState);
  useEffect(() => { 
    orbStateRef.current = orbState; 
    if (orbState === 'LISTENING' && isVoiceActive) {
      speechService.ensureAudioMeterRunning();
    }
  }, [orbState, isVoiceActive]);

  useEffect(() => {
    runVaultDiagnostics();
  }, [isVoiceActive, runVaultDiagnostics]);

  const voiceTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const orbResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleVoiceTimer = (cb: () => void, ms: number) => {
    const id = setTimeout(() => {
      voiceTimersRef.current.delete(id);
      cb();
    }, ms);
    voiceTimersRef.current.add(id);
    return id;
  };
  const scheduleOrbReset = (ms: number, ensureMeter = false) => {
    if (orbResetTimerRef.current) {
      clearTimeout(orbResetTimerRef.current);
      orbResetTimerRef.current = null;
    }
    orbResetTimerRef.current = setTimeout(() => {
      orbResetTimerRef.current = null;
      if (speechService.isSpeaking()) return;
      const currentVoiceActive = useLioraStore.getState().isVoiceActive;
      setOrbState(currentVoiceActive ? 'LISTENING' : 'IDLE');
      if (ensureMeter && currentVoiceActive) {
        speechService.ensureAudioMeterRunning();
      }
    }, ms);
  };

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      voiceTimersRef.current.forEach(t => clearTimeout(t));
      voiceTimersRef.current.clear();
      if (orbResetTimerRef.current) {
        clearTimeout(orbResetTimerRef.current);
        orbResetTimerRef.current = null;
      }
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
    };
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

    // 2. Interrompe modelo Live e áudio anterior para liberar a fala
    voiceLiveClient.interrupt();
    voiceLiveClient.extendSuppression(8000);
    speechService.stopSpeaking();

    // 3. Feedback falado curto e elegante
    setOrbState('SPEAKING');
    speechService.unlockAudio();
    speechService.speak(navMatch.spokenFeedback);

    // 4. Retorno limpo para estado de escuta, impedindo travamento em THINKING/EXECUTING
    scheduleOrbReset(4000);

    // 5. Injeta no histórico de mensagens (memória de curto prazo) e canal Live
    const store = useLioraStore.getState();
    store.recordVoiceExchange(navMatch.rawInput, navMatch.spokenFeedback);
    voiceLiveClient.sendContextUpdate(navMatch.rawInput, navMatch.spokenFeedback);

    // 6. Registro forense de auditoria
    store.addActivityLog({
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

    // 1. Interrompe modelo Live e áudio anterior para liberar a fala
    voiceLiveClient.interrupt();
    voiceLiveClient.extendSuppression(8000);
    speechService.stopSpeaking();

    // 2. Executa abertura do Google Maps / Waze ANTES de confirmar por voz
    setOrbState('EXECUTING');
    let routeResult: { success: boolean; url: string; provider: string; originMode: string; dryRun?: boolean; simulated?: boolean } = {
      success: false,
      url: '',
      provider: routeIntent.provider,
      originMode: 'current_gps'
    };
    try {
      routeResult = await launchGpsNavigation(routeIntent.destination, routeIntent.provider, routeIntent.origin);
    } catch (err) {
      console.warn('[GlobalVoiceBar] Falha ao acionar rota de GPS:', err);
    }

    const appName = routeIntent.provider === 'waze' ? 'Waze' : 'Google Maps';
    const isSimulated = Boolean((routeResult as any).simulated || routeResult.dryRun);
    const spokenMessage = routeResult.success
      ? (isSimulated ? `Modo Web Preview simulado: ${routeIntent.spokenFeedback}` : routeIntent.spokenFeedback)
      : `Mestre, não consegui abrir a rota no ${appName}.`;

    if (!routeResult.success) {
      setErrorMessage(spokenMessage);
    }

    // 3. Feedback falado apenas após confirmação real do resultado
    setOrbState('SPEAKING');
    speechService.unlockAudio();
    speechService.speak(spokenMessage, undefined, () => {
      voiceLiveClient.extendSuppression(2000);
    }, { isDeterministicOverride: true });

    // 4. Retorno limpo para estado de escuta
    scheduleOrbReset(1500);

    // 5. Registro forense de auditoria sem alterar a aba ativa
    useLioraStore.getState().recordVoiceExchange(routeIntent.rawInput, spokenMessage);
    voiceLiveClient.sendContextUpdate(routeIntent.rawInput, spokenMessage);
    useLioraStore.getState().addActivityLog({
      category: 'tool',
      summary: `Navegação GPS ${routeResult.success ? 'Ativa' : 'Falhou'} (${appName})`,
      details: `Comando "${routeIntent.rawInput}" ${routeResult.success ? 'executado' : 'falhou'}. Destino: "${routeIntent.destination}"${routeIntent.origin ? ` | Origem: "${routeIntent.origin}"` : ' | Origem: GPS Atual'}.`,
      riskLevel: 'R0',
      status: routeResult.success ? 'success' : 'error',
      simulated: isSimulated
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

    // 1. Interrompe modelo Live e áudio anterior para liberar a fala
    voiceLiveClient.interrupt();
    voiceLiveClient.extendSuppression(8000);
    speechService.stopSpeaking();

    // 2. Executa busca no Google Maps ANTES de falar confirmação
    setOrbState('EXECUTING');
    let searchResult: { success: boolean; url: string; query: string; dryRun?: boolean; simulated?: boolean } = {
      success: false,
      url: '',
      query: placesIntent.query
    };
    try {
      searchResult = await launchPlacesSearch(placesIntent.query, placesIntent.nearLocation);
    } catch (err) {
      console.warn('[GlobalVoiceBar] Falha ao acionar busca de locais:', err);
    }

    const isSimulated = Boolean((searchResult as any).simulated || searchResult.dryRun);
    const spokenMessage = searchResult.success
      ? (isSimulated ? `Modo Web Preview simulado: ${placesIntent.spokenFeedback}` : placesIntent.spokenFeedback)
      : 'Mestre, não consegui abrir a busca de locais no Google Maps.';

    if (!searchResult.success) {
      setErrorMessage(spokenMessage);
    }

    // 3. Feedback falado apenas após resultado confirmado
    setOrbState('SPEAKING');
    speechService.unlockAudio();
    speechService.speak(spokenMessage, undefined, () => {
      voiceLiveClient.extendSuppression(2000);
    }, { isDeterministicOverride: true });

    // 4. Retorno limpo para estado de escuta
    scheduleOrbReset(1500);

    // 5. Registro forense de auditoria
    useLioraStore.getState().recordVoiceExchange(placesIntent.rawInput, spokenMessage);
    voiceLiveClient.sendContextUpdate(placesIntent.rawInput, spokenMessage);
    useLioraStore.getState().addActivityLog({
      category: 'tool',
      summary: `Busca de Locais (${searchResult.success ? 'Google Maps' : 'Falhou'})`,
      details: `Comando "${placesIntent.rawInput}" ${searchResult.success ? 'executado' : 'falhou'}. Termo: "${placesIntent.query}"${placesIntent.nearLocation ? ` | Referência: "${placesIntent.nearLocation}"` : ' | Perto da localização atual'}.`,
      riskLevel: 'R0',
      status: searchResult.success ? 'success' : 'error',
      simulated: isSimulated
    });
  };

  // Interceptação determinística e imediata de comandos do computador (abrir apps, volume, bloqueio)
  const handleDeterministicPcCommand = async (pcMatch: PcCommandMatch) => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    vadSpeakingRef.current = false;
    isDispatchingRef.current = false;

    setTranscript('');
    setErrorMessage(null);

    // 1. Interrompe modelo Live e áudio anterior para liberar o canal
    voiceLiveClient.interrupt();
    voiceLiveClient.extendSuppression(8000);
    speechService.stopSpeaking();

    // 2. Execução REAL da ação no computador hospedeiro ANTES de afirmar sucesso
    setOrbState('EXECUTING');
    let result: Awaited<ReturnType<typeof executePcAction>>;
    try {
      result = await executePcAction(pcMatch);
    } catch (pcErr: any) {
      result = {
        success: false,
        message: 'Erro inesperado ao executar ação no PC.',
        error: pcErr?.message || 'Erro desconhecido'
      };
    }

    const store = useLioraStore.getState();

    // 3. Se bloqueado por consentimento R1/R2, abre o overlay de consentimento e informa por voz
    if (!result.success && result.requiresConsent && result.consentToolName) {
      const now = Date.now();
      store.setPendingConsent({
        auditId: `consent-${now}`,
        ruleId: 'voice-pc-rule',
        toolName: result.consentToolName,
        riskLevel: 'R2',
        parameters: result.consentParams || {},
        consentToken: '',
        sessionId: store.activeSessionId || 'operator-voice-session',
        expiresAt: now + 60000,
        reason: result.message || `Autorizar execução de ${result.consentToolName}`,
        status: 'PENDING'
      });
      setOrbState('LISTENING');
      return;
    }

    // 4. Monta resposta honesta estritamente baseada no retorno do backend
    const appOrAction = pcMatch.type === 'app_launch' ? pcMatch.appName : pcMatch.action;
    const isSimulated = Boolean(result.simulated);
    const spokenMessage = result.success
      ? (isSimulated ? `Modo Web Preview simulado: ${pcMatch.spokenFeedback}` : pcMatch.spokenFeedback)
      : `Mestre, não consegui executar o comando: ${result.error || result.message || 'verifique se o aplicativo está instalado'}.`;

    if (!result.success) {
      setErrorMessage(spokenMessage);
    }

    setOrbState('SPEAKING');
    speechService.unlockAudio();
    speechService.speak(
      spokenMessage,
      undefined,
      () => {
        voiceLiveClient.extendSuppression(2000);
        const currentVoiceActive = useLioraStore.getState().isVoiceActive;
        setOrbState(currentVoiceActive ? 'LISTENING' : 'IDLE');
        if (currentVoiceActive) speechService.ensureAudioMeterRunning();
      },
      { isDeterministicOverride: true }
    );

    // 5. Retorno limpo para estado de escuta de segurança
    scheduleOrbReset(4000, true);

    // 6. Injeta no histórico de mensagens (memória de curto prazo) e canal Live
    const assistantReply = result.success
      ? (isSimulated
          ? `${spokenMessage} (Simulado no ambiente Web Preview sem desktop físico).`
          : `${pcMatch.spokenFeedback} (Aplicativo '${appOrAction}' iniciado com confirmação real).`)
      : spokenMessage;

    store.recordVoiceExchange(pcMatch.rawInput, assistantReply);
    voiceLiveClient.sendContextUpdate(pcMatch.rawInput, assistantReply);

    // 7. Registro forense de auditoria
    store.addActivityLog({
      category: 'tool',
      summary: pcMatch.type === 'app_launch' ? `💻 Executar App: ${pcMatch.appName}` : `💻 Ação de Sistema: ${pcMatch.action}`,
      details: `${result.message} (Executável: ${pcMatch.type === 'app_launch' ? pcMatch.executable : pcMatch.action})`,
      riskLevel: 'R1',
      status: result.success ? 'success' : 'error',
      simulated: isSimulated
    });
  };

  // Interceptação determinística de data e hora do relógio real
  const handleDeterministicTimeQuery = (timeMatch: TimeQueryMatch) => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    vadSpeakingRef.current = false;
    isDispatchingRef.current = false;

    setTranscript('');
    setErrorMessage(null);

    // 1. Interrompe modelo Live
    voiceLiveClient.interrupt();
    voiceLiveClient.extendSuppression(8000);
    speechService.stopSpeaking();

    // 2. Feedback falado instantâneo
    setOrbState('SPEAKING');
    speechService.unlockAudio();
    speechService.speak(
      timeMatch.spokenFeedback,
      undefined,
      () => {
        voiceLiveClient.extendSuppression(2000);
        const currentVoiceActive = useLioraStore.getState().isVoiceActive;
        setOrbState(currentVoiceActive ? 'LISTENING' : 'IDLE');
        if (currentVoiceActive) speechService.ensureAudioMeterRunning();
      }
    );

    // 3. Retorno limpo para estado de escuta de segurança
    scheduleOrbReset(4000, true);

    // 4. Injeta no histórico de mensagens (memória de curto prazo) e canal Live
    const store = useLioraStore.getState();
    store.recordVoiceExchange(timeMatch.rawInput, timeMatch.spokenFeedback);
    voiceLiveClient.sendContextUpdate(timeMatch.rawInput, timeMatch.spokenFeedback);

    // 5. Registro na auditoria
    store.addActivityLog({
      category: 'ai',
      summary: '🕒 Consulta de Data/Hora Local',
      details: `Pergunta: "${timeMatch.rawInput}" | Resposta: "${timeMatch.spokenFeedback}"`,
      riskLevel: 'R0',
      status: 'success',
      simulated: false
    });
  };

  useEffect(() => {
    voiceLiveClient.setCallbacks({
      onStatusChange: (status) => {
        if (status === 'SPEAKING') {
          setOrbStateRef.current('SPEAKING');
          useLioraStore.getState().addActivityLog({
            category: 'voice',
            summary: '🔊 Gemini Live Falando',
            details: 'Reproduzindo áudio recebido em streaming pelo canal duplex.',
            riskLevel: 'R0',
            status: 'success',
            simulated: false
          });
        } else if (status === 'LISTENING') {
          const currentVoiceActive = useLioraStore.getState().isVoiceActive;
          setOrbStateRef.current(currentVoiceActive ? 'LISTENING' : 'IDLE');
          speechService.ensureAudioMeterRunning();
        }
      },
      onAudioLevel: (lvl) => {
        const pct = Math.round(lvl * 100);
        if (pct > 0 || speechService.isUsingFallbackMeter() || !speechService.isListening()) {
          setAudioLevel(pct);
        }
      },
      onTranscription: (text, role) => {
        if (role === 'user') {
          setTranscript(text);
          // P1: publica a fala do usuário no eventBus — o GlobalConsentOverlay
          // escuta por "confirmar"/"cancelar" enquanto há consentimento pendente.
          eventBus.publish('liora:voice_transcript', { text, role });

          // Interceptação determinística secundária (redundância para o canal Live)
          const navMatch = parseNavigationIntent(text);
          if (navMatch) {
            handleDeterministicNavigation(navMatch);
            return;
          }

          const pcMatch = parsePcCommandIntent(text);
          if (pcMatch) {
            void handleDeterministicPcCommand(pcMatch);
            return;
          }

          const timeMatch = parseTimeCommandIntent(text);
          if (timeMatch) {
            handleDeterministicTimeQuery(timeMatch);
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
        useLioraStore.getState().addActivityLog({
          category: 'voice',
          summary: '⚠️ Erro no Canal de Voz Live',
          details: String(err),
          riskLevel: 'R1',
          status: 'error',
          simulated: false
        });
      }
    });
  }, []);

  useEffect(() => {
    // ETAPA D (anti-silêncio): banner visual para avisos de voz/quota/microfone
    return eventBus.subscribe('liora:voice_warning', (payload: any) => {
      if (payload?.message) setErrorMessage(String(payload.message));
    });
  }, []);



  // Envio consolidado e atômico com trava contra duplicidade de voz
  const dispatchVoiceCommand = async (text: string, audioBlob?: { data: string; mimeType: string }) => {
    if (isDispatchingRef.current) return;
    const store = useLioraStore.getState();
    // FIX BUG-5: Quando isGenerating=true, não descarta silenciosamente —
    // dá feedback visual para o usuário saber que a LIORA ainda está processando.
    if (store.isGenerating) {
      setErrorMessage('Aguarde... A LIORA ainda está processando a resposta anterior.');
      scheduleVoiceTimer(() => setErrorMessage(null), 2500);
      return;
    }

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

    const pcMatch = parsePcCommandIntent(text);
    if (pcMatch) {
      void handleDeterministicPcCommand(pcMatch);
      return;
    }

    const timeMatch = parseTimeCommandIntent(text);
    if (timeMatch) {
      handleDeterministicTimeQuery(timeMatch);
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

    // BUG FIX (duplicação de voz): Se o canal Gemini Live duplex estiver ativo,
    // o áudio do usuário já foi enviado e é respondido diretamente pelo Live via WebSocket.
    // Despachar simultaneamente para o chat HTTP gerava duas vozes sobrepostas (Live + TTS).
    const liveStatus = voiceLiveClient.getStatus();
    const isLiveActive = liveStatus === 'LISTENING' || liveStatus === 'SPEAKING' || liveStatus === 'CONNECTING';
    if (isLiveActive) {
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

    // Interrompe imediatamente qualquer áudio anterior
    speechService.stopSpeaking();

    try {
      speechService.unlockAudio();
      speechService.playInstantAcknowledgment();
      await sendMessage(text, undefined, audioBlob);
    } catch (err) {
      console.error('[GlobalVoiceBar] Erro ao enviar comando de voz:', err);
      setOrbState('LISTENING');
    } finally {
      scheduleVoiceTimer(() => {
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
            silenceTimerRef.current = null;
            if (isDispatchingRef.current) return;
            // Garante que a sessão de voz ainda está ativa; se o Live estiver conectado, evita envio paralelo ao chat HTTP.
            if (!useLioraStore.getState().isVoiceActive) {
              return;
            }
            const currentLiveStatus = voiceLiveClient.getStatus();
            if (currentLiveStatus === 'LISTENING' || currentLiveStatus === 'SPEAKING' || currentLiveStatus === 'CONNECTING') {
              return;
            }
            const audioBlob = await speechService.getRecordedAudioBlob();
            if (audioBlob) {
              try {
                speechService.unlockAudio();
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
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
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

    // Garante que o microfone e medidor de frequências (VU meter) permaneçam vivos durante toda a sessão.
    // O cancelamento acústico e interrupção (barge-in) já são tratados nativamente pelo Web Audio e VAD.
    speechService.ensureAudioMeterRunning();

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
          // Telemetria forense: registra fala reconhecida no painel de Atividade
          if (text.trim().length >= 2) {
            useLioraStore.getState().addActivityLog({
              category: 'voice',
              summary: `🎤 Fala Reconhecida: "${text.trim().slice(0, 45)}"`,
              details: `Texto: "${text.trim()}" | Canal de voz ativo.`,
              riskLevel: 'R0',
              status: 'success',
              simulated: false
            });
          }
        }
        if (useLioraStore.getState().orbState !== 'THINKING') {
          setOrbStateRef.current('LISTENING');
        }
        setErrorMessage(null);

        // Resetar timer de silêncio
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = null;
        }

        const clean = text.trim();
        if (clean.length >= 2) {
          // ══════════════════════════════════════════════════════════════════════
          // INTERCEPTAÇÃO DETERMINÍSTICA UNIVERSAL (PC, NAVEGAÇÃO, HORÁRIO & MAPAS):
          // O Web Speech API é a fonte primária de transcrição textual do microfone.
          // Comandos de PC ("abra o bloco de notas", "abra a calculadora", "abra o chrome",
          // "painel de controle"), abas ("abrir configurações", "automações"), relógio
          // e mapas SÃO EXECUTADOS IMEDIATAMENTE no host com verificação real e honesta.
          // O Gemini Live é interrompido (CLIENT_INTERRUPTED) com supressão de áudio
          // de 6 segundos para blindar totalmente contra voz duplicada.
          // ══════════════════════════════════════════════════════════════════════
          const navMatch = parseNavigationIntent(clean);
          const pcMatch = !navMatch ? parsePcCommandIntent(clean) : null;
          const timeMatch = (!navMatch && !pcMatch) ? parseTimeCommandIntent(clean) : null;
          const routeIntent = (!navMatch && !pcMatch && !timeMatch) ? parseRouteIntent(clean) : null;
          const placesIntent = (!navMatch && !pcMatch && !timeMatch && !routeIntent) ? parsePlacesSearchIntent(clean) : null;

          const matchedKey = navMatch 
            ? `nav:${navMatch.tab}` 
            : pcMatch 
              ? `pc:${pcMatch.type}:${pcMatch.type === 'app_launch' ? pcMatch.executable : pcMatch.action}` 
              : timeMatch
                ? `time:${timeMatch.spokenFeedback}`
                : routeIntent 
                  ? `route:${routeIntent.destination}` 
                  : placesIntent 
                    ? `places:${placesIntent.query}` 
                    : null;

          if (matchedKey) {
            // Guarda anti-fala-parcial (interim): se o usuário ainda está falando, bloqueia apps genéricos desconhecidos
            const KNOWN_EXES = ['notepad', 'calc', 'control', 'ms-settings:', 'taskmgr', 'explorer', 'chrome', 'msedge', 'spotify', 'code', 'powershell', 'mspaint', 'steam', 'discord', 'whatsapp', 'winword', 'excel', 'powerpnt', 'opera', 'telegram', 'vlc', 'obs64'];
            if (!isFinal && pcMatch && pcMatch.type === 'app_launch' && !KNOWN_EXES.includes(pcMatch.executable)) {
              return;
            }

            const now = Date.now();
            if (now - lastExecutedCommandRef.current.time < 2500 && lastExecutedCommandRef.current.key === matchedKey) {
              // Deduplicação: descarta disparo repetido da mesma frase entre interim e final
              return;
            }
            lastExecutedCommandRef.current = { key: matchedKey, time: now };

            if (silenceTimerRef.current) {
              clearTimeout(silenceTimerRef.current);
              silenceTimerRef.current = null;
            }

            if (navMatch) {
              handleDeterministicNavigation(navMatch);
              return;
            }
            if (pcMatch) {
              void handleDeterministicPcCommand(pcMatch);
              return;
            }
            if (timeMatch) {
              handleDeterministicTimeQuery(timeMatch);
              return;
            }
            if (routeIntent) {
              void handleDeterministicRoute(routeIntent);
              return;
            }
            if (placesIntent) {
              void handleDeterministicPlacesSearch(placesIntent);
              return;
            }
          }

          // Se for fala conversacional comum (não-determinística):
          // No modo Live ativo, a fala já foi transmitida por áudio PCM ao Gemini Live duplex.
          // Não despacha para o chat HTTP para evitar duplicar respostas e vozes.
          const liveStatusNow = voiceLiveClient.getStatus();
          const liveIsActive = liveStatusNow === 'LISTENING' || liveStatusNow === 'SPEAKING' || liveStatusNow === 'CONNECTING';
          if (liveIsActive) {
            useLioraStore.getState().addActivityLog({
              category: 'ai',
              summary: `🌐 Conversa Livre Gemini Live: "${clean.slice(0, 40)}"`,
              details: `Fala transmitida via áudio PCM duplex para o Gemini Live.`,
              riskLevel: 'R0',
              status: 'success',
              simulated: false
            });
            return;
          }

          // Modo sem Live (fallback HTTP): aguarda silêncio e despacha para o chat HTTP
          const delayMs = isFinal ? 750 : 1200;
          silenceTimerRef.current = setTimeout(async () => {
            silenceTimerRef.current = null;
            const promptToSend = clean;
            setTranscript('');

            try {
              speechService.unlockAudio();
              await dispatchVoiceCommand(promptToSend);
            } catch (err) {
              console.error('[GlobalVoiceBar] Erro ao enviar prompt de voz:', err);
              setOrbStateRef.current('LISTENING');
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
        silenceTimerRef.current = null;
      }
      speechService.stopListening();
    };
  }, [isVoiceActive]);

  if (!isVoiceActive) {
    return null;
  }

  const handleManualSend = async () => {
    if (!transcript.trim() || isGenerating) return;
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
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
      silenceTimerRef.current = null;
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
              role="button"
              tabIndex={0}
              aria-label="Autorizar ou calibrar o microfone"
              className="flex-1 flex items-end justify-between gap-1 sm:gap-1.5 px-4 py-2 bg-[#080808] rounded-2xl border border-[#282828] h-11 cursor-pointer hover:border-[#FF2B2B] transition-all shadow-inner min-w-[180px] max-w-md"
              onClick={handleGrantMicPermission}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  void handleGrantMicPermission();
                }
              }}
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
            aria-label="Abrir painel diagnóstico de áudio"
            title="Abrir Painel Diagnóstico de Áudio (Volume, Sample Rate e WebSockets)"
          >
            <Activity className="w-4.5 h-4.5" />
          </button>

          <button
            onClick={() => setActiveTab('conversation')}
            className="p-3 bg-[#121212] hover:bg-[#1E1E1E] text-[#A8A8A8] hover:text-white border border-[#2A2A2A] rounded-2xl transition-all hover:scale-105"
            aria-label="Abrir tela de conversa completa"
            title="Abrir tela de conversa completa"
          >
            <MessageSquare className="w-4.5 h-4.5" />
          </button>

          <button
            onClick={handleStopVoice}
            className="flex items-center gap-1.5 px-4 py-2.5 bg-red-950/90 hover:bg-red-900 border border-red-700/60 text-red-200 rounded-2xl text-xs font-bold transition-all shadow-md hover:scale-105"
            aria-label="Pausar voz e encerrar microfone"
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

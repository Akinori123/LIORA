/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
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
import { commandDeduplicator, DEFAULT_COMMAND_DEDUPE_WINDOW_MS } from '../utils/commandDeduplicator';
import { parseConsentVoiceDecision } from '../utils/consentVoiceParser';
import { gestureService } from '../services/gestureService';

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
  } = useLioraStore(
    useShallow((s) => ({
      isVoiceActive: s.isVoiceActive,
      orbState: s.orbState,
      toggleVoice: s.toggleVoice,
      sendMessage: s.sendMessage,
      setOrbState: s.setOrbState,
      setActiveTab: s.setActiveTab,
      isGenerating: s.isGenerating,
      isSidebarExpanded: s.isSidebarExpanded,
      isTelemetryOpen: s.isTelemetryOpen,
      activeTab: s.activeTab,
      isVaultKeyMissing: s.isVaultKeyMissing,
      vaultDiagnosticMessage: s.vaultDiagnosticMessage,
      runVaultDiagnostics: s.runVaultDiagnostics
    }))
  );

  const [transcript, setTranscript] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [frequencyBins, setFrequencyBins] = useState<number[]>([0, 0, 0, 0, 0, 0, 0, 0]);
  const [showDiagnosticModal, setShowDiagnosticModal] = useState(false);
  const [windowWidth, setWindowWidth] = useState<number>(typeof window !== 'undefined' ? window.innerWidth : 1280);
  const isMountedRef = useRef<boolean>(true);
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
      if (isMountedRef.current) cb();
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
      if (!isMountedRef.current) return;
      if (speechService.isSpeaking()) return;
      const currentVoiceActive = useLioraStore.getState().isVoiceActive;
      setOrbState(currentVoiceActive ? 'LISTENING' : 'IDLE');
      if (ensureMeter && currentVoiceActive) {
        speechService.ensureAudioMeterRunning();
      }
    }, ms);
  };

  useEffect(() => {
    isMountedRef.current = true;
    const handleResize = () => {
      if (isMountedRef.current) setWindowWidth(window.innerWidth);
    };
    window.addEventListener('resize', handleResize);
    return () => {
      isMountedRef.current = false;
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
    if (!isMountedRef.current) return;

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
    if (!isMountedRef.current) return;

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
    if (!isMountedRef.current) return;

    const store = useLioraStore.getState();

    // 3. Se bloqueado por consentimento R1/R2, abre o overlay de consentimento e informa por voz
    if (!result.success && result.requiresConsent && result.consentToolName) {
      const now = Date.now();
      store.setPendingConsent({
        auditId: `consent-${now}`,
        ruleId: 'voice-pc-rule',
        toolName: result.consentToolName,
        riskLevel: result.consentRiskLevel || 'R1',
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
    const appOrAction = pcMatch.type === 'app_launch' 
      ? pcMatch.appName 
      : (pcMatch.type === 'camera_toggle' ? 'Câmera / Visão Computacional' : pcMatch.action);
    const isSimulated = Boolean(result.simulated);
    const spokenMessage = result.success
      ? (isSimulated ? `Modo Web Preview simulado: ${pcMatch.spokenFeedback}` : pcMatch.spokenFeedback)
      : `Mestre, não consegui executar o comando: ${result.error || result.message || 'verifique as permissões de acesso'}.`;

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
          : (pcMatch.type === 'camera_toggle'
              ? `${pcMatch.spokenFeedback}`
              : `${pcMatch.spokenFeedback} (Aplicativo '${appOrAction}' iniciado com confirmação real).`))
      : spokenMessage;

    store.recordVoiceExchange(pcMatch.rawInput, assistantReply);
    voiceLiveClient.sendContextUpdate(pcMatch.rawInput, assistantReply);

    // 7. Registro forense de auditoria
    store.addActivityLog({
      category: 'tool',
      summary: pcMatch.type === 'app_launch' 
        ? `💻 Executar App: ${pcMatch.appName}` 
        : (pcMatch.type === 'camera_toggle' 
            ? `👁️ Visão Computacional (${pcMatch.enable ? 'Ativada' : 'Desativada'})` 
            : `💻 Ação de Sistema: ${pcMatch.action}`),
      details: `${result.message} (Executável: ${pcMatch.type === 'app_launch' ? pcMatch.executable : (pcMatch.type === 'camera_toggle' ? 'gestureService' : pcMatch.action)})`,
      riskLevel: result.consentRiskLevel || 'R0',
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

  // Interceptação priorizada de confirmação/recusa falada durante consentimento pendente R1/R2
  const handlePendingConsentVoice = (rawText: string, isFinalSpeech: boolean): boolean => {
    const store = useLioraStore.getState();
    if (store.pendingConsent?.status !== 'PENDING') {
      return false;
    }

    const clean = String(rawText || '').trim();
    if (!clean) return true;

    const decision = parseConsentVoiceDecision(clean);
    if (!decision && !isFinalSpeech) {
      // Aguarda frase concluir se fala parcial ainda não contém palavra-chave de decisão
      return true;
    }

    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    if (decision) {
      const dedupeKey = `voice_consent:${store.pendingConsent.auditId}:${decision}`;
      const lock = commandDeduplicator.checkAndLock(dedupeKey, Date.now(), DEFAULT_COMMAND_DEDUPE_WINDOW_MS);
      if (lock.isDuplicate) {
        return true;
      }
      setTranscript('');
      setErrorMessage(null);

      if (decision === 'APPROVE') {
        speechService.stopSpeaking();
        // Dispara aprovação real — o feedback falado vem do resultado da execução em approveConsent
        void store.approveConsent();
        eventBus.publish('liora:voice_transcript', { text: clean, role: 'user' });
        return true;
      } else if (decision === 'REJECT') {
        speechService.stopSpeaking();
        store.rejectConsent();
        speechService.speak("Entendido, Mestre. Ação cancelada imediatamente como você pediu.", undefined, undefined, { isDeterministicOverride: true });
        eventBus.publish('liora:voice_transcript', { text: clean, role: 'user' });
        return true;
      }
    }

    eventBus.publish('liora:voice_transcript', { text: clean, role: 'user' });
    return true;
  };

  // Dispatcher determinístico unificado com janela de idempotência de 3000ms
  const tryDispatchDeterministicVoiceCommand = (clean: string, isFinal: boolean): boolean => {
    const navMatch = parseNavigationIntent(clean);
    const pcMatch = !navMatch ? parsePcCommandIntent(clean) : null;
    const timeMatch = !navMatch && !pcMatch ? parseTimeCommandIntent(clean) : null;
    const routeIntent = !navMatch && !pcMatch && !timeMatch ? parseRouteIntent(clean) : null;
    const placesIntent = !navMatch && !pcMatch && !timeMatch && !routeIntent ? parsePlacesSearchIntent(clean) : null;

    const matchedKey = navMatch
      ? `voice_dispatch:nav:${navMatch.tab}`
      : pcMatch
        ? `voice_dispatch:pc:${pcMatch.type}:${pcMatch.type === 'app_launch' ? pcMatch.executable : (pcMatch.type === 'camera_toggle' ? String(pcMatch.enable) : pcMatch.action)}`
        : timeMatch
          ? `voice_dispatch:time:${timeMatch.spokenFeedback}`
          : routeIntent
            ? `voice_dispatch:route:${routeIntent.provider}:${routeIntent.destination.toLowerCase()}`
            : placesIntent
              ? `voice_dispatch:places:${placesIntent.query.toLowerCase()}`
              : null;

    if (!matchedKey) return false;

    const KNOWN_EXES = ['notepad', 'calc', 'control', 'ms-settings:', 'taskmgr', 'explorer', 'chrome', 'msedge', 'spotify', 'code', 'powershell', 'mspaint', 'steam', 'discord', 'whatsapp', 'winword', 'excel', 'powerpnt', 'opera', 'telegram', 'vlc', 'obs64'];
    if (!isFinal && pcMatch && pcMatch.type === 'app_launch' && !KNOWN_EXES.includes(pcMatch.executable)) {
      return true;
    }

    const lock = commandDeduplicator.checkAndLock(matchedKey, Date.now(), DEFAULT_COMMAND_DEDUPE_WINDOW_MS);
    if (lock.isDuplicate) {
      console.info(`[GlobalVoiceBar] Comando de voz duplicado bloqueado na janela de ${DEFAULT_COMMAND_DEDUPE_WINDOW_MS}ms: ${matchedKey}`);
      return true;
    }

    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    if (navMatch) {
      handleDeterministicNavigation(navMatch);
      return true;
    }
    if (pcMatch) {
      void handleDeterministicPcCommand(pcMatch);
      return true;
    }
    if (timeMatch) {
      handleDeterministicTimeQuery(timeMatch);
      return true;
    }
    if (routeIntent) {
      void handleDeterministicRoute(routeIntent);
      return true;
    }
    if (placesIntent) {
      void handleDeterministicPlacesSearch(placesIntent);
      return true;
    }

    return false;
  };

  const liveHandlersRef = useRef({
    handlePendingConsentVoice,
    tryDispatchDeterministicVoiceCommand
  });
  liveHandlersRef.current = {
    handlePendingConsentVoice,
    tryDispatchDeterministicVoiceCommand
  };

  useEffect(() => {
    const unsubscribe = voiceLiveClient.subscribeCallbacks({
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
          const clean = String(text || '').trim();
          setTranscript(text);

          // Se há consentimento R1/R2 pendente, intercepta com prioridade máxima e impede comandos extras
          if (liveHandlersRef.current.handlePendingConsentVoice(clean, true)) {
            return;
          }

          // Publica transcrição para listeners auxiliares quando não está em janela de bloqueio
          eventBus.publish('liora:voice_transcript', { text: clean, role });

          // Interceptação determinística secundária com trava compartilhada de 3000ms
          if (clean.length >= 2 && liveHandlersRef.current.tryDispatchDeterministicVoiceCommand(clean, true)) {
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
    return unsubscribe;
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

    // Durante o consentimento pendente, a fala vai apenas ao GlobalConsentOverlay
    if (handlePendingConsentVoice(text, true)) {
      return;
    }

    // Interceptação determinística com trava compartilhada de 3000ms ANTES do LLM
    if (tryDispatchDeterministicVoiceCommand(text.trim(), true)) {
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

      // Visão Computacional: Se o comando envolver tela/câmera/ver objetos, captura snapshot automaticamente
      let imagePayload: { data: string; mimeType: string } | undefined = undefined;
      const isScreenRequest = /\b(tela|monitor|print|desktop|janela|screenshot)\b/i.test(text);
      const isCameraRequest = /\b(c[aâ]mera|webcam|mostrando|este objeto|segurando|o que [ée] isso|que objeto [ée] esse|pe[çc]a|documento|foto)\b/i.test(text);
      const isGenericVision = /\b(olh[ae]|veja|analis[ae]|leia)\b/i.test(text);

      if (isScreenRequest || (isGenericVision && !isCameraRequest && !gestureService.getState().isActive)) {
        try {
          const { captureScreen } = await import('../tools/screenCapture');
          const screenShot = await captureScreen();
          if (screenShot && screenShot.base64Data) {
            imagePayload = { data: screenShot.base64Data, mimeType: screenShot.mimeType };
          }
        } catch { /* fallback */ }
      } else if (isCameraRequest || (isGenericVision && gestureService.getState().isActive)) {
        let snap = gestureService.captureSnapshotBase64();
        if (!snap && isCameraRequest) {
          const started = await gestureService.start();
          if (started) {
            await new Promise(r => setTimeout(r, 600));
            snap = gestureService.captureSnapshotBase64();
          }
        }
        if (snap) {
          imagePayload = { data: snap, mimeType: 'image/jpeg' };
        }
      }

      await sendMessage(text, imagePayload, audioBlob);
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
            if (!isMountedRef.current || !useLioraStore.getState().isVoiceActive) return;
            if (audioBlob) {
              try {
                speechService.unlockAudio();
                const transRes = await speechService.transcribeAudio(audioBlob);
                if (!isMountedRef.current || !useLioraStore.getState().isVoiceActive) return;
                if (transRes.success && transRes.text && transRes.hasSpeech) {
                  await dispatchVoiceCommand(transRes.text, audioBlob);
                } else if (isMountedRef.current) {
                  console.info('[GlobalVoiceBar VAD] Áudio capturado sem fala reconhecível.');
                  setOrbState('LISTENING');
                }
              } catch (err) {
                console.error('[GlobalVoiceBar VAD] Erro na transcrição de áudio:', err);
                if (isMountedRef.current) setOrbState('LISTENING');
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
      voiceLiveClient.clearAttention();  // volta ao modo "não escuta tudo"
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
    // Ativa a atenção: ligar o microfone é intenção explícita de falar.
    voiceLiveClient.primeAttention();
    const started = speechService.startListening(
      (text, isFinal) => {
        setTranscript(text);
        // Alimenta o gate de atenção do Live: só fala dirigida à LIORA
        // (nome mencionado) libera o envio do áudio ao Gemini.
        if (text) voiceLiveClient.feedUserTranscript(text);
        // Turno da Web Speech encerrado (frase final): limpa a última transcrição
        // para o gate de atenção não bloquear a PRÓXIMA fala por causa de um texto
        // antigo (a atenção é reaberta por primeAttention/fim da resposta Live).
        if (isFinal && text) voiceLiveClient.clearUserTranscript();
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
          // Prioridade máxima: se há overlay R1/R2 aberto, reconhece "autorizar"/"confirmar"/"sim"/"cancelar"
          // mesmo em resultados parciais (interim) e bloqueia disparo paralelo de comandos/chat.
          if (handlePendingConsentVoice(clean, isFinal)) {
            return;
          }

          // Anti-Echo / Isolamento Acústico: se a LIORA estiver falando (Live ou TTS),
          // qualquer fala captada pelo microfone é eco acústico vindo dos alto-falantes da máquina.
          // Descarta completamente para evitar que a IA se auto-interrompa em loop infinito.
          const isLioraSpeaking = voiceLiveClient.getStatus() === 'SPEAKING' || speechService.isSpeaking() || orbState === 'SPEAKING';
          if (isLioraSpeaking) {
            return;
          }

          // Interceptação determinística unificada com deduplicação de 3000ms
          if (tryDispatchDeterministicVoiceCommand(clean, isFinal)) {
            return;
          }

          // Se for fala conversacional comum (não-determinística):
          // No modo Live ativo, a fala é transmitida por áudio PCM duplex ao Gemini Live.
          const liveStatusNow = voiceLiveClient.getStatus();
          if (liveStatusNow === 'LISTENING') {
            useLioraStore.getState().addActivityLog({
              category: 'ai',
              summary: `🌐 Conversa Livre Gemini Live: "${clean.slice(0, 40)}"`,
              details: `Fala transmitida via áudio PCM duplex para o Gemini Live.`,
              riskLevel: 'R0',
              status: 'success',
              simulated: false
            });

            // CRÍTICO: Quando o turno de fala é finalizado (isFinal) e a atenção está ativa
            // (ou o usuário chamou pelo nome), envia a transcrição diretamente para a sessão
            // Live via LIVE_MESSAGE (sendClientContent com turnComplete: true).
            // Isso garante que a LIORA sempre responda com áudio duplex, mesmo se o ganho do
            // microfone PCM em desktop/Tauri estiver baixo ou o VAD acústico da nuvem hesitar.
            if (isFinal) {
              const shouldSend = voiceLiveClient.isAttentionActive() || voiceLiveClient.isWakeWordHeard(clean);
              if (shouldSend) {
                voiceLiveClient.sendLiveMessage(clean);
              }
            }
            return;
          }
          if (liveStatusNow === 'CONNECTING') {
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
        // Ignora erros transitórios de rede do Web Speech API (pois o áudio real PCM e VAD continuam operando)
        if (typeof error === 'string' && (error.includes('network') || error.includes('no-speech'))) {
          return;
        }
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
      let imagePayload: { data: string; mimeType: string } | undefined = undefined;
      const isVisionRequest = /\b(c[aâ]mera|olh[ae]|veja|mostrando|este objeto|segurando|o que [ée] isso|que objeto [ée] esse|leia|foto|imagem)\b/i.test(textToSend);
      if (isVisionRequest) {
        const snap = gestureService.captureSnapshotBase64();
        if (snap) {
          imagePayload = { data: snap, mimeType: 'image/jpeg' };
        }
      }
      await sendMessage(textToSend, imagePayload);
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
    if (!isMountedRef.current) return;
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
            type="button"
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
            type="button"
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
            <button
              type="button"
              aria-label="Autorizar ou calibrar o microfone"
              className="flex-1 flex items-end justify-between gap-1 sm:gap-1.5 px-4 py-2 bg-[#080808] rounded-2xl border border-[#282828] h-11 cursor-pointer hover:border-[#FF2B2B] transition-all shadow-inner min-w-[180px] max-w-md text-left"
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
            </button>
          </div>
        </div>

        {/* Ações Diretas */}
        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
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
            type="button"
            onClick={() => setActiveTab('conversation')}
            className="p-3 bg-[#121212] hover:bg-[#1E1E1E] text-[#A8A8A8] hover:text-white border border-[#2A2A2A] rounded-2xl transition-all hover:scale-105"
            aria-label="Abrir tela de conversa completa"
            title="Abrir tela de conversa completa"
          >
            <MessageSquare className="w-4.5 h-4.5" />
          </button>

          <button
            type="button"
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

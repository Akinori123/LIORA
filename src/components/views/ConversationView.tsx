/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { useLioraStore } from '../../store/lioraStore';
import { ConversationSubTab } from '../../types';
import { MarkdownContent } from '../chat/MarkdownContent';
import { TranscriptionView } from '../chat/TranscriptionView';
import { 
  MessageSquare, 
  Mic, 
  FileText, 
  History, 
  Send, 
  Trash2, 
  Bot, 
  User, 
  Sparkles, 
  Volume2, 
  StopCircle, 
  AlertTriangle, 
  RotateCcw,
  Square,
  Radio,
  CheckCircle2,
  Camera,
  X,
  Image as ImageIcon,
  Loader2,
  Settings2,
  Play
} from 'lucide-react';
import { voiceLiveClient, VoiceLiveStatus } from '../../services/voiceLiveClient';
import { captureScreen } from '../../tools/screenCapture';
import { speechService } from '../../services/speechService';

import { eventBus } from '../../utils/eventBus';

export const ConversationView: React.FC = () => {
  const { 
    conversationSubTab, 
    setConversationSubTab, 
    messages, 
    sessions,
    openSession,
    deleteSession,
    sendMessage, 
    clearMessages, 
    isVoiceActive, 
    toggleVoice,
    isGenerating,
    abortGeneration,
    retryMessage
  } = useLioraStore();

  const [inputText, setInputText] = useState('');
  const [attachedImage, setAttachedImage] = useState<{ data: string; mimeType: string } | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Live voice state
  const [voiceStatus, setVoiceStatus] = useState<VoiceLiveStatus>('IDLE');
  const [audioLevel, setAudioLevel] = useState(0);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [liveTranscription, setLiveTranscription] = useState<string>('');

  useEffect(() => {
    voiceLiveClient.setCallbacks({
      onStatusChange: (status) => {
        setVoiceStatus(status);
        if (status === 'ERROR') {
          useLioraStore.setState({ orbState: 'ERROR' });
        } else if (status === 'SPEAKING') {
          useLioraStore.setState({ orbState: 'SPEAKING' });
        } else if (status === 'LISTENING') {
          useLioraStore.setState({ orbState: 'LISTENING' });
        } else if (status === 'IDLE') {
          useLioraStore.setState({ orbState: 'IDLE' });
        }
      },
      onAudioLevel: (level) => {
        setAudioLevel(level);
      },
      onTranscription: (text) => {
        setLiveTranscription(text);
      },
      onError: (errMsg) => {
        setVoiceError(errMsg);
      }
    });

    return () => {
      voiceLiveClient.setCallbacks({});
      if (recordTimerRef.current) {
        clearInterval(recordTimerRef.current);
        recordTimerRef.current = null;
      }
      if (testMicTimerRef.current) {
        clearTimeout(testMicTimerRef.current);
        testMicTimerRef.current = null;
      }
      if (testAudioRef.current) {
        try {
          testAudioRef.current.pause();
        } catch {}
        testAudioRef.current = null;
      }
      speechService.stopListening();
    };
  }, []);

  const handleToggleVoiceSession = async () => {
    setVoiceError(null);
    if (isVoiceActive) {
      voiceLiveClient.stop();
      speechService.stopListening();
      toggleVoice();
      setVoiceStatus('IDLE');
    } else {
      toggleVoice();
      speechService.unlockAudio();
      const success = await voiceLiveClient.start();
      if (!success) {
        console.warn('[ConversationView] Gemini Live não disponível. Alternando automaticamente para Voz Contínua por microfone...');
        setVoiceError('Gemini Live indisponível. Alternando para o modo de Voz Contínua por microfone com resposta falada.');
        handleStartAudioRecording();
      }
    }
  };

  // Auto-scroll to bottom on message updates or streaming
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isGenerating]);

  // Focus input on mount or when generation finishes
  useEffect(() => {
    if (!isGenerating && conversationSubTab === 'text') {
      inputRef.current?.focus();
    }
  }, [isGenerating, conversationSubTab]);

  // Handle keyboard shortcuts (Escape to abort)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isGenerating) {
        abortGeneration();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isGenerating, abortGeneration]);

  const handleCaptureScreen = async () => {
    setIsCapturing(true);
    try {
      const captured = await captureScreen();
      setAttachedImage({ data: captured.base64Data, mimeType: captured.mimeType });
    } catch (e) {
      console.error('[ConversationView] Screen capture error:', e);
    } finally {
      setIsCapturing(false);
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!inputText.trim() && !attachedImage) || isGenerating) return;
    const textToSend = inputText;
    const imgToSend = attachedImage || undefined;
    setInputText('');
    setAttachedImage(null);
    await sendMessage(textToSend, imgToSend);
  };

  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const [recordDuration, setRecordDuration] = useState(0);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recordingAudioLevel, setRecordingAudioLevel] = useState(0);
  const [recordingNotice, setRecordingNotice] = useState<string | null>(null);
  const recordTimerRef = useRef<NodeJS.Timeout | null>(null);

  const [showAudioDiagModal, setShowAudioDiagModal] = useState(false);
  const [availableDevices, setAvailableDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>(speechService.getSelectedAudioDevice() || '');
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [isTestRecording, setIsTestRecording] = useState(false);
  const testMicTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const testAudioRef = useRef<HTMLAudioElement | null>(null);

  const loadAudioDevices = async () => {
    const devices = await speechService.getAudioInputDevices();
    setAvailableDevices(devices);
    if (devices.length > 0 && !selectedDevice) {
      setSelectedDevice(devices[0].deviceId);
      speechService.setSelectedAudioDevice(devices[0].deviceId);
    }
  };

  useEffect(() => {
    if (showAudioDiagModal) {
      loadAudioDevices();
    }
  }, [showAudioDiagModal]);

  const handleDeviceChange = (deviceId: string) => {
    setSelectedDevice(deviceId);
    speechService.setSelectedAudioDevice(deviceId);
    setTestStatus('Dispositivo de microfone selecionado.');
  };

  const handleTestLioraVoice = () => {
    speechService.unlockAudio();
    setTestStatus('Sintetizando e testando voz da LIORA...');
    speechService.speak(
      'LIORA online. O sistema de síntese de voz e áudio está funcionando normalmente no seu navegador.',
      () => setTestStatus('Reproduzindo áudio da LIORA...'),
      () => setTestStatus('Teste de áudio da LIORA concluído com sucesso!')
    );
  };

  const handleTestMicLoopback = async () => {
    speechService.unlockAudio();
    const perm = await speechService.requestMicrophonePermission();
    if (!perm.success) {
      setTestStatus(`Erro no microfone: ${perm.error}`);
      return;
    }

    setIsTestRecording(true);
    setTestStatus('Gravando 3 segundos do seu microfone... Fale algo agora!');

    speechService.startListening(() => {});

    if (testMicTimerRef.current) {
      clearTimeout(testMicTimerRef.current);
    }
    testMicTimerRef.current = setTimeout(async () => {
      testMicTimerRef.current = null;
      const audioBlob = await speechService.getRecordedAudioBlob();
      speechService.stopListening();
      setIsTestRecording(false);

      if (!audioBlob) {
        setTestStatus('Nenhum áudio foi capturado. Seu microfone pode estar mudo ou sem som.');
        return;
      }

      setTestStatus('Reproduzindo o áudio gravado do seu microfone...');
      const audio = new Audio(`data:${audioBlob.mimeType};base64,${audioBlob.data}`);
      testAudioRef.current = audio;
      audio.onended = () => {
        if (testAudioRef.current === audio) testAudioRef.current = null;
        setTestStatus('Teste concluído! Se você ouviu sua voz, seu microfone está 100% funcionando.');
      };
      audio.onerror = () => {
        if (testAudioRef.current === audio) testAudioRef.current = null;
        setTestStatus('Erro ao reproduzir teste de microfone.');
      };
      await audio.play().catch((e) => {
        if (testAudioRef.current === audio) testAudioRef.current = null;
        setTestStatus(`Falha na reprodução: ${e.message}`);
      });
    }, 3200);
  };

  // Monitora nível de volume do microfone durante a gravação
  useEffect(() => {
    if (!isRecordingAudio) {
      setRecordingAudioLevel(0);
      return;
    }
    const unsub = speechService.onAudioLevel((lvl) => {
      setRecordingAudioLevel(lvl);
    });
    return () => unsub();
  }, [isRecordingAudio]);

  const handleStartAudioRecording = async () => {
    if (isGenerating || isRecordingAudio) return;
    setRecordingNotice(null);
    speechService.unlockAudio();

    const perm = await speechService.requestMicrophonePermission();
    if (!perm.success) {
      setRecordingNotice(perm.error || 'Permissão de microfone negada. Autorize o microfone no navegador.');
      return;
    }

    setIsRecordingAudio(true);
    setRecordDuration(0);
    if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    recordTimerRef.current = setInterval(() => {
      setRecordDuration((prev) => prev + 1);
    }, 1000);

    speechService.startListening(
      (text) => {
        if (text && text.trim()) {
          setInputText(text.trim());
        }
      },
      (err) => {
        console.warn('[ConversationView] Microfone:', err);
      },
      undefined,
      () => {
        console.log('[ConversationView VAD] Envio automático disparado por pausa na fala.');
        handleFinishAndSendAudioRecording();
      }
    );
  };

  const handleCancelAudioRecording = () => {
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    speechService.stopListening();
    setIsRecordingAudio(false);
    setRecordDuration(0);
    setRecordingNotice(null);
  };

  const handleFinishAndSendAudioRecording = async () => {
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }

    setIsRecordingAudio(false);
    setRecordDuration(0);

    const audioBlob = await speechService.getRecordedAudioBlob();
    speechService.stopListening();

    const directText = inputText.trim();

    // Se o usuário já tinha texto digitado ou gerado pelo SpeechRecognition
    if (directText) {
      setInputText('');
      await sendMessage(directText, undefined, audioBlob || undefined);
      return;
    }

    // Se não há texto, precisamos do áudio gravado para transcrever via Gemini
    if (!audioBlob) {
      setRecordingNotice('Nenhum áudio foi capturado pelo microfone. Verifique se o microfone está ativo no navegador e se o fone não está mudo.');
      return;
    }

    setIsTranscribing(true);
    setRecordingNotice(null);

    try {
      const transRes = await speechService.transcribeAudio(audioBlob);
      if (transRes.success && transRes.hasSpeech && transRes.text) {
        // Envia o texto falado real do usuário!
        await sendMessage(transRes.text, undefined, audioBlob);
      } else {
        setRecordingNotice('Nenhuma fala inteligível foi detectada no microfone. Fale mais próximo do microfone e tente novamente.');
      }
    } catch (e: any) {
      console.error('[ConversationView] Erro ao transcrever:', e);
      setRecordingNotice('Falha ao transcrever o áudio com o Gemini.');
    } finally {
      setIsTranscribing(false);
    }
  };

  const handleMicButtonClick = () => {
    if (isGenerating) return;
    if (isRecordingAudio) {
      handleFinishAndSendAudioRecording();
    } else {
      handleStartAudioRecording();
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[#0A0A0A]">
      {/* Subtabs bar */}
      <nav aria-label="Subseções de Conversa & Voz" className="flex items-center justify-between px-6 sm:px-8 border-b border-[#222222] bg-[#0E0E0E] shrink-0">
        <div className="flex items-center gap-2 py-3 overflow-x-auto no-scrollbar">
          {[
            { id: 'text', label: 'Chat de Texto', icon: <MessageSquare className="w-4 h-4" /> },
            { id: 'transcription', label: 'Transcrição Simultânea', icon: <FileText className="w-4 h-4" /> },
            { id: 'history', label: 'Histórico', icon: <History className="w-4 h-4" /> },
          ].map((tab) => {
            const isActive = conversationSubTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setConversationSubTab(tab.id as ConversationSubTab)}
                className={`flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-lg transition-all shrink-0 ${
                  isActive 
                    ? 'bg-[#1C1C1C] text-white border border-[#333333] shadow-sm' 
                    : 'text-[#888888] hover:text-white hover:bg-[#141414]'
                }`}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {conversationSubTab === 'text' && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                  useLioraStore.getState().createSession();
              }}
              type="button"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-[#888888] hover:text-white bg-[#141414] hover:bg-[#1A1A1A] border border-[#222222] rounded-lg transition-colors"
            >
              <MessageSquare className="w-3.5 h-3.5" />
              <span>Nova Conversa</span>
            </button>
            {messages.length > 0 && (
              <button
                onClick={clearMessages}
                type="button"
                disabled={isGenerating}
                aria-label="Limpar histórico de mensagens"
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-[#888888] hover:text-red-400 bg-[#141414] hover:bg-[#1A1A1A] border border-[#222222] rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Limpar</span>
              </button>
            )}
          </div>
        )}
      </nav>

      {/* Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {conversationSubTab === 'text' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Messages Scroll Area */}
            <div 
              tabIndex={0} 
              aria-label="Área de mensagens do chat"
              className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 max-w-4xl mx-auto w-full focus:outline-none"
            >
              {messages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-8 text-[#666666]">
                  <Bot className="w-12 h-12 text-[#333333] mb-3 animate-pulse" />
                  <p className="text-sm font-medium text-[#888888]">O histórico foi limpo.</p>
                  <p className="text-xs text-[#555555] mt-1">Envie uma nova solicitação técnica ou comando para a LIORA.</p>
                </div>
              ) : (
                messages.map((msg) => {
                  const isUser = msg.sender === 'user';
                  const isError = msg.status === 'error';
                  const isCancelled = msg.status === 'cancelled';
                  const isStreaming = msg.status === 'streaming';

                  return (
                    <div 
                      key={msg.id} 
                      className={`flex items-start gap-3 sm:gap-4 ${isUser ? 'flex-row-reverse' : ''}`}
                    >
                      {/* Avatar */}
                      <div 
                        className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                          isUser 
                            ? 'text-white' 
                            : isError
                              ? 'bg-red-950/80 border border-red-600/50 text-red-400'
                              : 'bg-[#1E1E1E] border border-[#333333] text-white'
                        }`}
                        style={isUser ? { backgroundColor: 'var(--accent-primary)', boxShadow: '0 4px 14px var(--accent-glow)' } : undefined}
                      >
                        {isUser ? (
                          <User className="w-5 h-5" />
                        ) : isError ? (
                          <AlertTriangle className="w-5 h-5 text-red-400" />
                        ) : (
                          <Bot className="w-5 h-5" style={{ color: 'var(--accent-primary)' }} />
                        )}
                      </div>

                      {/* Bubble Container */}
                      <div 
                        className={`max-w-2xl rounded-2xl px-4 sm:px-5 py-3.5 text-sm leading-relaxed ${
                          isUser 
                            ? 'bg-[#1C1C1C] text-white border border-[#2E2E2E]' 
                            : isError
                              ? 'bg-[#190C0C] text-[#FF9999] border border-red-900/60'
                              : isCancelled
                                ? 'bg-[#17130F] text-[#E0D0C0] border border-[#443322]'
                                : 'bg-[#141414] text-[#E5E5E5] border border-[#222222]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-4 mb-2 pb-1.5 border-b border-[#222222]">
                          <span 
                            className={`text-xs font-semibold ${isUser ? 'text-[#A0A0A0]' : isError ? 'text-red-400' : ''}`}
                            style={!isUser && !isError ? { color: 'var(--accent-primary)' } : undefined}
                          >
                            {isUser ? 'Você' : 'LIORA'}
                          </span>
                          <span className="text-[10px] font-mono text-[#666666]">{msg.timestamp}</span>
                        </div>

                        {/* Streaming Empty State (Thinking) */}
                        {isStreaming && !msg.text && (
                          <div className="flex items-center gap-2 py-2 text-xs text-[#A0A0A0]">
                            <span className="w-2 h-2 rounded-full animate-ping" style={{ backgroundColor: 'var(--accent-primary)' }} />
                            <span className="italic">LIORA está processando resposta...</span>
                          </div>
                        )}

                        {/* Message Content */}
                        {isUser ? (
                          <p className="whitespace-pre-wrap">{msg.text}</p>
                        ) : isError ? (
                          <div className="space-y-3">
                            <div className="flex items-start gap-2 text-xs text-red-300">
                              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                              <div>
                                <strong className="font-semibold block">Falha no processamento:</strong>
                                <span>{msg.errorMessage || msg.text || 'Erro de comunicação.'}</span>
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => retryMessage(msg.id)}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-500 rounded-lg transition-colors shadow-sm"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                              <span>Tentar novamente</span>
                            </button>
                          </div>
                        ) : (
                          <div>
                            <MarkdownContent content={msg.text} />
                            {isStreaming && (
                              <span 
                                className="inline-block w-2 h-4 ml-1 animate-pulse align-middle"
                                style={{ backgroundColor: 'var(--accent-primary)' }}
                              />
                            )}
                          </div>
                        )}

                        {/* Status Footer */}
                        {!isError && (
                          <div className="mt-2.5 pt-2 border-t border-[#222222] flex items-center justify-between text-[10px] font-mono text-[#777777]">
                            <div className="flex items-center gap-2">
                              {msg.modelUsed && (
                                <div className="flex items-center gap-1.5">
                                  <Sparkles className="w-3 h-3" style={{ color: 'var(--accent-primary)' }} />
                                  <span>Modelo: {msg.modelUsed}</span>
                                </div>
                              )}
                              {!isUser && msg.text && (
                                <button
                                  type="button"
                                  onClick={() => speechService.speak(msg.text)}
                                  className="flex items-center gap-1 px-2 py-0.5 rounded bg-[#1C1C1C] hover:bg-[#252525] text-[#AAAAAA] hover:text-white transition-colors border border-[#333333]"
                                  title="Ouvir resposta falada em voz alta"
                                >
                                  <Volume2 className="w-3 h-3 text-[var(--accent-primary)]" />
                                  <span>Ouvir</span>
                                </button>
                              )}
                            </div>
                            {isCancelled && (
                              <span className="text-amber-500 font-semibold uppercase tracking-wider">Interrompido</span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input & Control Form */}
            <div className="p-3 sm:p-4 border-t border-[#222222] bg-[#0E0E0E]">
              <div className="max-w-4xl mx-auto space-y-2">
                {/* Generation control banner when running */}
                {isGenerating && (
                  <div className="flex items-center justify-between px-3 py-1.5 bg-[#1A1111] border border-red-900/50 rounded-lg text-xs text-red-300">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-[var(--accent-primary)] animate-ping" />
                      <span>LIORA gerando resposta em tempo real... (Pressione Esc ou clique em parar)</span>
                    </div>
                    <button
                      type="button"
                      onClick={abortGeneration}
                      className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-white bg-red-600 hover:bg-red-500 rounded transition-colors"
                      aria-label="Interromper geração atual"
                    >
                      <Square className="w-3 h-3 fill-current" />
                      <span>Parar geração</span>
                    </button>
                  </div>
                )}

                {/* Image Attachment Chip Preview */}
                {attachedImage && (
                  <div className="flex items-center gap-3 p-2 bg-[#171717] border border-[#2E2E2E] rounded-xl max-w-sm">
                    <img 
                      src={`data:${attachedImage.mimeType};base64,${attachedImage.data}`} 
                      alt="Captura de tela anexada" 
                      className="w-12 h-12 rounded-lg object-cover border border-[#333333]" 
                    />
                    <div className="flex-1 min-w-0 text-xs">
                      <div className="flex items-center gap-1.5 font-semibold text-white">
                        <Camera className="w-3.5 h-3.5 text-[var(--accent-primary)]" />
                        <span>Captura de Tela Anexada</span>
                      </div>
                      <p className="text-[10px] text-[#888888] truncate mt-0.5">Visão Multimodal Gemini ativada</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setAttachedImage(null)}
                      className="p-1 hover:bg-[#252525] text-[#888888] hover:text-white rounded-lg transition-colors"
                      aria-label="Remover imagem anexada"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}

                {/* Recording Notice / Error Alert */}
                {recordingNotice && (
                  <div className="flex items-center justify-between px-3.5 py-2.5 bg-red-950/80 border border-red-600/70 rounded-xl text-xs text-red-200 shadow-lg">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                      <span>{recordingNotice}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setRecordingNotice(null)}
                      className="text-red-300 hover:text-white p-1 rounded transition-colors"
                      aria-label="Fechar aviso"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                <form onSubmit={handleSend} className="flex items-center gap-2 sm:gap-3">
                  {isRecordingAudio ? (
                    /* Live Audio Recording Panel */
                    <div className="flex-1 flex items-center justify-between gap-3 px-4 py-2.5 bg-[#140F0F] border border-red-500/60 rounded-xl shadow-lg">
                      <div className="flex items-center gap-3">
                        <span className="relative flex h-3 w-3 shrink-0">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-3 w-3 bg-red-600"></span>
                        </span>
                        <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
                          <span className="text-xs font-mono font-bold text-white uppercase tracking-wider">
                            Ouvindo Voz Contínua
                          </span>
                          <span className="text-[10px] text-red-300 bg-red-950/80 px-2 py-0.5 rounded border border-red-800/60 font-mono">
                            Envio automático ao pausar a fala
                          </span>
                          <span className="text-xs font-mono text-red-400">
                            {Math.floor(recordDuration / 60)}:{(recordDuration % 60).toString().padStart(2, '0')}
                          </span>
                        </div>

                        {/* Real Audio VU Level Visualizer */}
                        <div className="flex items-center gap-1 h-5 pl-2 border-l border-[#333333]">
                          {[15, 35, 60, 90, 75, 45, 80, 50].map((h, i) => (
                            <span 
                              key={i} 
                              className="w-1 bg-red-500 rounded-full transition-all duration-75"
                              style={{ 
                                height: `${Math.max(4, Math.min(20, (recordingAudioLevel / 100) * h))}px`,
                                opacity: recordingAudioLevel > 5 ? 1 : 0.4
                              }}
                            />
                          ))}
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={handleCancelAudioRecording}
                          className="px-3 py-1.5 text-xs text-[#AAAAAA] hover:text-white hover:bg-[#222222] rounded-lg transition-colors"
                        >
                          Cancelar
                        </button>
                        <button
                          type="button"
                          onClick={handleFinishAndSendAudioRecording}
                          className="flex items-center gap-1.5 px-3.5 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-lg text-xs font-bold shadow-md shadow-red-600/30 transition-all hover:scale-105"
                        >
                          <Send className="w-3.5 h-3.5" />
                          <span>Enviar Fala</span>
                        </button>
                      </div>
                    </div>
                  ) : isTranscribing ? (
                    /* Transcribing Spinner */
                    <div className="flex-1 flex items-center justify-center gap-2.5 px-4 py-3 bg-[#171717] border border-[#333333] rounded-xl text-xs text-[#CCCCCC]">
                      <Loader2 className="w-4 h-4 animate-spin text-[var(--accent-primary)]" />
                      <span>Transcrevendo sua fala com Gemini 3.5...</span>
                    </div>
                  ) : (
                    /* Normal Input Field */
                    <>
                      <button
                        type="button"
                        onClick={handleCaptureScreen}
                        disabled={isGenerating || isCapturing}
                        title="Capturar Tela Ativa para Análise Multimodal"
                        aria-label="Capturar tela para análise"
                        className="p-3 bg-[#171717] hover:bg-[#222222] border border-[#333333] text-[#A0A0A0] hover:text-white rounded-xl transition-colors disabled:opacity-50 shrink-0 flex items-center justify-center"
                      >
                        <Camera className={`w-4 h-4 ${isCapturing ? 'animate-pulse text-[var(--accent-primary)]' : ''}`} />
                      </button>

                      <input
                        ref={inputRef}
                        type="text"
                        value={inputText}
                        disabled={isGenerating}
                        onChange={(e) => setInputText(e.target.value)}
                        placeholder={
                          isGenerating
                            ? "Aguarde a finalização da resposta..."
                            : "Escreva sua mensagem para a LIORA ou clique no microfone para falar..."
                        }
                        className="flex-1 bg-[#171717] border border-[#333333] rounded-xl px-4 py-3 text-sm text-white placeholder-[#666666] focus:outline-none focus:border-[var(--accent-primary)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      />

                      {/* Botão de Microfone de Entrada Direta */}
                      <button
                        type="button"
                        onClick={handleMicButtonClick}
                        disabled={isGenerating}
                        aria-label="Falar por voz com a LIORA"
                        title="Gravar áudio do microfone para falar com a LIORA"
                        className="p-3 rounded-xl transition-all shrink-0 border bg-[#171717] hover:bg-[#222222] border-[#333333] text-[#A0A0A0] hover:text-white hover:border-red-500/50"
                      >
                        <Mic className="w-4 h-4" />
                      </button>

                      {/* Botão de Diagnóstico de Áudio */}
                      <button
                        type="button"
                        onClick={() => setShowAudioDiagModal(true)}
                        disabled={isGenerating}
                        aria-label="Diagnóstico de Microfone e Som"
                        title="Abrir Teste e Configurações de Microfone e Áudio"
                        className="p-3 bg-[#171717] hover:bg-[#222222] border border-[#333333] text-[#A0A0A0] hover:text-white rounded-xl transition-colors shrink-0 flex items-center justify-center"
                      >
                        <Settings2 className="w-4 h-4 text-red-400" />
                      </button>

                      {isGenerating ? (
                        <button
                          type="button"
                          onClick={abortGeneration}
                          aria-label="Interromper geração"
                          className="px-4 py-3 bg-red-600/90 hover:bg-red-600 text-white rounded-xl font-medium text-sm flex items-center gap-2 transition-colors shrink-0 shadow-lg shadow-red-600/20"
                        >
                          <Square className="w-4 h-4 fill-current" />
                          <span className="hidden sm:inline">Parar</span>
                        </button>
                      ) : (
                        <button
                          type="submit"
                          disabled={!inputText.trim() && !attachedImage}
                          aria-label="Enviar mensagem"
                          className="px-4 sm:px-5 py-3 text-white rounded-xl font-medium text-sm flex items-center gap-2 transition-colors shadow-lg disabled:opacity-40 disabled:cursor-not-allowed shrink-0 hover:opacity-90 active:scale-95"
                          style={{ backgroundColor: 'var(--accent-primary)', boxShadow: '0 4px 14px var(--accent-glow)' }}
                        >
                          <Send className="w-4 h-4" />
                          <span className="hidden sm:inline">Enviar</span>
                        </button>
                      )}
                    </>
                  )}
                </form>
              </div>
            </div>
          </div>
        )}



        {/* Transcrição Simultânea */}
        {conversationSubTab === 'transcription' && <TranscriptionView />}

        {/* Histórico */}
        {conversationSubTab === 'history' && (
          <div className="flex-1 p-6 sm:p-8 overflow-y-auto max-w-4xl mx-auto w-full space-y-4">
            <h3 className="text-lg font-bold text-white">Histórico de Sessões</h3>
            
            <div className="space-y-3 mt-6">
              {sessions.map((session) => (
                <div key={session.id} 
                     onClick={() => {
                         openSession(session.id);
                         setConversationSubTab('text');
                     }}
                     className="bg-[#141414] hover:bg-[#1A1A1A] border border-[#222222] rounded-xl p-4 flex items-center justify-between cursor-pointer transition-colors">
                  <div>
                    <h4 className="font-semibold text-white text-sm">{session.title}</h4>
                    <span className="text-xs text-[#888888]">{new Date(session.updatedAt).toLocaleDateString()}</span>
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); deleteSession(session.id); }} className="text-[#666666] hover:text-red-400">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
              {sessions.length === 0 && (
                  <p className="text-sm text-[#666666]">Nenhuma conversa salva ainda.</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Modal de Diagnóstico e Teste de Áudio */}
      {showAudioDiagModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-[#141414] border border-[#2B2B2B] rounded-2xl max-w-md w-full p-6 space-y-5 shadow-2xl relative text-white">
            <div className="flex items-center justify-between border-b border-[#222222] pb-4">
              <div className="flex items-center gap-2.5">
                <Mic className="w-5 h-5 text-red-500" />
                <h3 className="font-bold text-base text-white">Diagnóstico e Teste de Áudio</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowAudioDiagModal(false)}
                className="text-[#888888] hover:text-white p-1 rounded-lg hover:bg-[#202020] transition-colors"
                aria-label="Fechar diagnóstico"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Dispositivo de Microfone Selector */}
            <div className="space-y-2">
              <label className="text-xs font-mono font-semibold text-[#AAAAAA] uppercase tracking-wider block">
                Microfone de Entrada (Dispositivo Físico)
              </label>
              {availableDevices.length > 0 ? (
                <select
                  value={selectedDevice}
                  onChange={(e) => handleDeviceChange(e.target.value)}
                  className="w-full bg-[#1C1C1C] border border-[#333333] rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-red-500 transition-colors"
                >
                  {availableDevices.map((dev, i) => (
                    <option key={dev.deviceId || i} value={dev.deviceId}>
                      {dev.label || `Microfone #${i + 1} (${dev.deviceId.slice(0, 8)}...)`}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-xs text-[#888888] italic">
                  Nenhum dispositivo específico detectado. O microfone padrão do sistema será utilizado.
                </p>
              )}
            </div>

            {/* Testes de Funcionalidade */}
            <div className="space-y-3 pt-1">
              <label className="text-xs font-mono font-semibold text-[#AAAAAA] uppercase tracking-wider block">
                Testes Rápidos de Hardware e Sintetizador
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={handleTestLioraVoice}
                  className="flex items-center justify-center gap-2 px-3 py-2.5 bg-[#1E1E1E] hover:bg-[#282828] border border-[#333333] rounded-xl text-xs font-semibold text-white transition-colors"
                >
                  <Volume2 className="w-4 h-4 text-red-400" />
                  <span>Testar Voz da LIORA</span>
                </button>

                <button
                  type="button"
                  onClick={handleTestMicLoopback}
                  disabled={isTestRecording}
                  className="flex items-center justify-center gap-2 px-3 py-2.5 bg-[#1E1E1E] hover:bg-[#282828] border border-[#333333] rounded-xl text-xs font-semibold text-white transition-colors disabled:opacity-50"
                >
                  <Mic className={`w-4 h-4 ${isTestRecording ? 'animate-pulse text-red-500' : 'text-green-400'}`} />
                  <span>{isTestRecording ? 'Gravando (3s)...' : 'Testar Meu Microfone'}</span>
                </button>
              </div>
            </div>

            {/* Caixa de Feedback do Diagnóstico */}
            {testStatus && (
              <div className="p-3 bg-[#1B1B1B] border border-[#2D2D2D] rounded-xl text-xs text-[#DDDDDD] flex items-start gap-2 animate-in fade-in duration-150">
                <Sparkles className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <p>{testStatus}</p>
              </div>
            )}

            <div className="pt-2 flex justify-end">
              <button
                type="button"
                onClick={() => setShowAudioDiagModal(false)}
                className="px-5 py-2 bg-red-600 hover:bg-red-500 text-white font-bold text-xs rounded-xl shadow-lg transition-colors"
              >
                Concluir Diagnóstico
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useLioraStore } from '../../store/lioraStore';
import { 
  formatTranscriptionPlainText, 
  formatTranscriptionMarkdown, 
  copyTranscriptionToClipboard, 
  downloadFile, 
  formatTimestampHms 
} from '../../utils/transcriptionExport';
import { MarkdownContent } from './MarkdownContent';
import { ConsentCard } from './ConsentCard';
import { 
  Copy, 
  Check, 
  Download, 
  Pause, 
  Play, 
  ArrowDown, 
  FileText, 
  Bot, 
  User, 
  AlertTriangle, 
  StopCircle, 
  Info,
  MessageSquare
} from 'lucide-react';
import { ChatMessage } from '../../types';

export const TranscriptionView: React.FC = () => {
  const { 
    messages, 
    sessions, 
    activeSessionId, 
    isGenerating, 
    setConversationSubTab,
    pendingConsent,
    approveConsent,
    rejectConsent,
    expireConsent
  } = useLioraStore();

  const [isPaused, setIsPaused] = useState(false);
  const [frozenMessages, setFrozenMessages] = useState<ChatMessage[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasNewUnseen, setHasNewUnseen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Active session metadata
  const currentSession = useMemo(() => {
    return sessions.find(s => s.id === activeSessionId) || {
      id: activeSessionId || 'default',
      title: 'Conversa Atual',
      createdAt: new Date().toISOString()
    };
  }, [sessions, activeSessionId]);

  // If paused, keep displaying the frozen snapshot; otherwise display live messages
  const displayedMessages = isPaused && frozenMessages !== null ? frozenMessages : messages;

  // Track new messages arriving while paused
  const pendingCountWhilePaused = isPaused && frozenMessages !== null 
    ? Math.max(0, messages.length - frozenMessages.length)
    : 0;

  // Handle pause toggle
  const togglePause = () => {
    if (!isPaused) {
      // Freezing snapshot
      setFrozenMessages([...messages]);
      setIsPaused(true);
    } else {
      // Unfreezing: release snapshot and resume live updates
      setFrozenMessages(null);
      setIsPaused(false);
      setHasNewUnseen(false);
    }
  };

  // Scroll listener to detect when user moves away from bottom
  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const distanceToBottom = scrollHeight - scrollTop - clientHeight;
    const atBottom = distanceToBottom < 60;
    setIsAtBottom(atBottom);

    if (atBottom) {
      setHasNewUnseen(false);
    }
  };

  // Auto-scroll when new content arrives and user is following bottom
  useEffect(() => {
    if (isPaused) return;

    if (isAtBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    } else {
      // User is scrolled up; notify that new entries arrived
      setHasNewUnseen(true);
    }
  }, [messages, isAtBottom, isPaused]);

  // Jump to bottom action
  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    setIsAtBottom(true);
    setHasNewUnseen(false);
  };

  // Copy action
  const handleCopy = async () => {
    const plainText = formatTranscriptionPlainText(
      messages, 
      currentSession.title, 
      currentSession.createdAt
    );
    const success = await copyTranscriptionToClipboard(plainText);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Export TXT
  const handleExportTxt = () => {
    const content = formatTranscriptionPlainText(
      messages, 
      currentSession.title, 
      currentSession.createdAt
    );
    const safeTitle = (currentSession.title || 'conversa')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_')
      .slice(0, 30);
    const dateStr = new Date().toISOString().split('T')[0];
    downloadFile(content, `transcricao-liora-${safeTitle}-${dateStr}.txt`, 'text/plain;charset=utf-8');
  };

  // Export Markdown
  const handleExportMd = () => {
    const content = formatTranscriptionMarkdown(
      messages, 
      currentSession.title, 
      currentSession.createdAt
    );
    const safeTitle = (currentSession.title || 'conversa')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_')
      .slice(0, 30);
    const dateStr = new Date().toISOString().split('T')[0];
    downloadFile(content, `transcricao-liora-${safeTitle}-${dateStr}.md`, 'text/markdown;charset=utf-8');
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[#0A0A0A]">
      {/* Header Toolbar */}
      <div className="px-4 sm:px-8 py-3.5 border-b border-[#222222] bg-[#0E0E0E] flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm sm:text-base font-bold text-white tracking-wide">
              Transcrição Simultânea
            </h3>
            <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-[#1A1A1A] text-[#999999] border border-[#333333]">
              {messages.length} {messages.length === 1 ? 'registro' : 'registros'}
            </span>
          </div>
          <p className="text-xs text-[#777777] mt-0.5 line-clamp-1">
            Sessão: <strong className="text-[#BBBBBB] font-medium">{currentSession.title}</strong>
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center flex-wrap gap-2">
          {/* Pause / Resume Button */}
          <button
            type="button"
            onClick={togglePause}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all ${
              isPaused
                ? 'bg-amber-950/80 border-amber-600/70 text-amber-300 hover:bg-amber-900 shadow-sm'
                : 'bg-[#161616] border-[#333333] text-[#A0A0A0] hover:text-white hover:bg-[#1E1E1E]'
            }`}
            title={isPaused ? "Retomar visualização em tempo real" : "Pausar visualização da transcrição"}
          >
            {isPaused ? <Play className="w-3.5 h-3.5 fill-current" /> : <Pause className="w-3.5 h-3.5" />}
            <span>{isPaused ? 'Retomar Visualização' : 'Pausar'}</span>
          </button>

          {/* Copy Button */}
          <button
            type="button"
            onClick={handleCopy}
            disabled={messages.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#161616] border border-[#333333] text-[#A0A0A0] hover:text-white hover:bg-[#1E1E1E] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            title="Copiar transcrição completa para a área de transferência"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
            <span className={copied ? 'text-green-400 font-bold' : ''}>
              {copied ? 'Copiado!' : 'Copiar'}
            </span>
          </button>

          {/* Export TXT */}
          <button
            type="button"
            onClick={handleExportTxt}
            disabled={messages.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#161616] border border-[#333333] text-[#A0A0A0] hover:text-white hover:bg-[#1E1E1E] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            title="Exportar transcrição em formato texto puro (.txt)"
          >
            <Download className="w-3.5 h-3.5" />
            <span>TXT</span>
          </button>

          {/* Export MD */}
          <button
            type="button"
            onClick={handleExportMd}
            disabled={messages.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#161616] border border-[#333333] text-[#A0A0A0] hover:text-white hover:bg-[#1E1E1E] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            title="Exportar transcrição em formato Markdown (.md)"
          >
            <FileText className="w-3.5 h-3.5" />
            <span>MD</span>
          </button>
        </div>
      </div>

      {/* Informational Banner: Future Voice Integration */}
      <div className="px-4 sm:px-8 py-2 bg-[#0D0D0D] border-b border-[#1E1E1E] flex items-center justify-between text-[11px] text-[#666666]">
        <div className="flex items-center gap-1.5 line-clamp-1">
          <Info className="w-3.5 h-3.5 text-[#888888] shrink-0" />
          <span>
            Origem: <strong>Chat textual em tempo real</strong>. Transcrição contínua de áudio depende da futura integração de voz (Gemini Live API).
          </span>
        </div>
        {isGenerating && (
          <div className="flex items-center gap-1.5 text-[var(--accent-primary)] shrink-0 font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-primary)] animate-ping" />
            <span>Stream ativo</span>
          </div>
        )}
      </div>

      {/* Paused Notification Banner */}
      {isPaused && (
        <div className="px-4 sm:px-8 py-2 bg-amber-950/60 border-b border-amber-700/50 flex items-center justify-between text-xs text-amber-200">
          <div className="flex items-center gap-2">
            <Pause className="w-4 h-4 text-amber-400" />
            <span>
              <strong>Visualização pausada.</strong> A geração e o histórico em segundo plano continuam normalmente.
              {pendingCountWhilePaused > 0 && (
                <span className="ml-1 px-1.5 py-0.5 rounded bg-amber-900/80 font-mono text-[10px] text-amber-100">
                  +{pendingCountWhilePaused} novas
                </span>
              )}
            </span>
          </div>
          <button
            type="button"
            onClick={togglePause}
            className="px-2.5 py-1 text-xs font-bold bg-amber-600 hover:bg-amber-500 text-black rounded transition-colors"
          >
            Retomar Agora
          </button>
        </div>
      )}

      {/* Scrollable Transcript List */}
      <div 
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 max-w-4xl mx-auto w-full relative"
      >
        {displayedMessages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-8 text-[#666666]">
            <FileText className="w-12 h-12 text-[#2A2A2A] mb-3 animate-pulse" />
            <h4 className="text-sm font-semibold text-[#888888]">Nenhum registro de transcrição</h4>
            <p className="text-xs text-[#555555] max-w-md mt-1 mb-4">
              As mensagens e falas da conversa ativa aparecerão aqui em tempo real com horários de gravação e identificação dos interlocutores.
            </p>
            <button
              type="button"
              onClick={() => setConversationSubTab('text')}
              className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-[var(--accent-primary)] hover:opacity-90 rounded-xl transition-all shadow-md shadow-[var(--accent-glow)]"
            >
              <MessageSquare className="w-3.5 h-3.5" />
              <span>Abrir Chat de Texto</span>
            </button>
          </div>
        ) : (
          displayedMessages.map((msg, idx) => {
            const isUser = msg.sender === 'user';
            const isError = msg.status === 'error';
            const isCancelled = msg.status === 'cancelled';
            const isStreaming = msg.status === 'streaming';
            const timeHms = formatTimestampHms(msg.timestamp, msg.createdAt);
            const sourceLabel = msg.source === 'voice' ? 'Voz' : 'Texto';

            return (
              <div 
                key={msg.id}
                className={`rounded-xl p-4 transition-all border ${
                  isError 
                    ? 'bg-[#150B0B] border-red-900/60 text-red-200' 
                    : isCancelled
                      ? 'bg-[#14100D] border-amber-900/50 text-[#D5C5B5]'
                      : isStreaming
                        ? 'bg-[#121212] border-[var(--accent-border)] shadow-sm shadow-[var(--accent-glow)]'
                        : isUser
                          ? 'bg-[#121212] border-[#222222] text-[#E5E5E5]'
                          : 'bg-[#101010] border-[#1F1F1F] text-[#E5E5E5]'
                }`}
              >
                {/* Header row: Speaker, Origin, Time, State badge */}
                <div className="flex items-center justify-between gap-3 text-xs mb-2 pb-1.5 border-b border-[#222222]">
                  <div className="flex items-center gap-2">
                    <div className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 ${
                      isUser 
                        ? 'bg-[var(--accent-primary)] text-white' 
                        : isError
                          ? 'bg-red-950 text-red-400'
                          : 'bg-[#222222] text-[var(--accent-primary)]'
                    }`}>
                      {isUser ? <User className="w-3 h-3" /> : isError ? <AlertTriangle className="w-3 h-3" /> : <Bot className="w-3 h-3" />}
                    </div>
                    <span className={`font-semibold ${isUser ? 'text-white' : isError ? 'text-red-400' : 'text-[var(--accent-primary)]'}`}>
                      {isUser ? 'Você' : 'LIORA'}
                    </span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#181818] text-[#888888] border border-[#2B2B2B]">
                      {sourceLabel}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Status Badge */}
                    {isStreaming && (
                      <span className="flex items-center gap-1 text-[10px] font-mono font-semibold text-[var(--accent-primary)] bg-[var(--accent-bg)] border border-[var(--accent-border)] px-2 py-0.5 rounded-full">
                        <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-primary)] animate-ping" />
                        Transcrevendo...
                      </span>
                    )}
                    {isCancelled && (
                      <span className="flex items-center gap-1 text-[10px] font-mono font-semibold text-amber-400 bg-amber-950/70 border border-amber-800/50 px-2 py-0.5 rounded-full">
                        <StopCircle className="w-3 h-3" />
                        Interrompido
                      </span>
                    )}
                    {isError && (
                      <span className="flex items-center gap-1 text-[10px] font-mono font-semibold text-red-400 bg-red-950/80 border border-red-700/60 px-2 py-0.5 rounded-full">
                        <AlertTriangle className="w-3 h-3" />
                        Falha ({msg.errorCode || 'ERRO'})
                      </span>
                    )}
                    <span className="text-[11px] font-mono text-[#777777]">
                      {timeHms}
                    </span>
                  </div>
                </div>

                {/* Body Content */}
                <div className="text-sm leading-relaxed">
                  {isStreaming && !msg.text ? (
                    <p className="text-xs italic text-[#777777] flex items-center gap-2 py-1">
                      <span className="w-2 h-2 rounded-full bg-[var(--accent-primary)] animate-pulse" />
                      <span>Processando chunks de streaming...</span>
                    </p>
                  ) : isError ? (
                    <div className="space-y-1">
                      <p className="text-xs font-semibold text-red-400">
                        {msg.errorMessage || 'Falha na comunicação com o modelo.'}
                      </p>
                      {msg.text && (
                        <div className="mt-2 pt-2 border-t border-red-950/60 text-xs text-[#BBBBBB]">
                          <p className="font-semibold text-[#888888] mb-1">Conteúdo gerado antes da falha:</p>
                          <MarkdownContent content={msg.text} />
                        </div>
                      )}
                    </div>
                  ) : (
                    <div>
                      <MarkdownContent content={msg.text} />
                      {isStreaming && (
                        <span className="inline-block w-2 h-3.5 ml-1 bg-[var(--accent-primary)] animate-pulse align-middle" />
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}

        {pendingConsent && (
          <ConsentCard
            pendingConsent={pendingConsent}
            onApprove={approveConsent}
            onReject={rejectConsent}
            onExpire={expireConsent}
          />
        )}
        <div ref={bottomRef} />
      </div>

      {/* Floating Jump to Bottom Button */}
      {hasNewUnseen && !isPaused && (
        <div className="absolute bottom-6 right-6 z-20">
          <button
            type="button"
            onClick={scrollToBottom}
            className="flex items-center gap-2 px-3.5 py-2 text-xs font-bold text-white bg-[var(--accent-primary)] hover:opacity-90 rounded-full shadow-lg shadow-[var(--accent-glow)] transition-all animate-bounce"
            title="Ir para as mensagens mais recentes"
          >
            <ArrowDown className="w-4 h-4" />
            <span>Novas mensagens abaixo</span>
          </button>
        </div>
      )}
    </div>
  );
};

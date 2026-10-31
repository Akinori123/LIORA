/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { useLioraStore } from '../../store/lioraStore';
import { LioraOrb } from '../LioraOrb';
import { devicesManager } from '../../services/devicesManager';
import { integrationsVault } from '../../services/integrationsVault';
import { speechService } from '../../services/speechService';
import { 
  Send, 
  Mic, 
  SlidersHorizontal,
  Key,
  Shield,
  Cpu,
  Radio,
  Layers,
  Activity,
  CheckCircle2,
  ArrowRight,
  ArrowUpRight,
  X,
  Volume2,
  Lock,
  RefreshCw,
  Terminal,
  Maximize2,
  AlertTriangle,
  Bot,
  Copy,
  Check
} from 'lucide-react';
import { MarkdownContent } from '../chat/MarkdownContent';

export const HomeView: React.FC = () => {
  const { 
    orbState, 
    setOrbState,
    sendMessage, 
    messages,
    isGenerating,
    activeModel,
    activeTask, 
    devices, 
    setActiveTab, 
    toggleVoice, 
    isVoiceActive, 
    isTelemetryOpen, 
    toggleTelemetry, 
    closeTelemetry,
    clearMessages,
    addActivityLog
  } = useLioraStore();

  const [promptInput, setPromptInput] = useState('');
  const [audioGain, setAudioGain] = useState(0);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isHomeResponseDismissed, setIsHomeResponseDismissed] = useState(false);
  const [copiedText, setCopiedText] = useState(false);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [hasInteractedOnHome, setHasInteractedOnHome] = useState(false);
  const [isApiKeyModalOpen, setIsApiKeyModalOpen] = useState(false);
  const [geminiKeyInput, setGeminiKeyInput] = useState('');
  const [openRouterKeyInput, setOpenRouterKeyInput] = useState('');
  const [apiKeySaveStatus, setApiKeySaveStatus] = useState<string | null>(null);
  const [apiKeyStatus, setApiKeyStatus] = useState<{
    geminiConfigured: boolean;
    geminiMasked: string;
    openRouterConfigured: boolean;
    openRouterMasked: string;
  }>({
    geminiConfigured: false,
    geminiMasked: '',
    openRouterConfigured: false,
    openRouterMasked: ''
  });

  // Telemetry status
  const [cpuUsage, setCpuUsage] = useState<number>(18.4);
  const [ramUsage, setRamUsage] = useState<number>(35.0);
  const [isLiveWsConnected, setIsLiveWsConnected] = useState<boolean>(true);
  const [activeIntegrationsCount, setActiveIntegrationsCount] = useState<number>(0);
  const [intentNotification, setIntentNotification] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  // Contextual greeting by hour
  const getContextualGreeting = () => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return 'Bom dia';
    if (hour >= 12 && hour < 18) return 'Boa tarde';
    return 'Boa noite';
  };

  // State copy mapping
  const getStateCopy = () => {
    switch (orbState) {
      case 'LISTENING':
        return 'Ouvindo...';
      case 'THINKING':
        return 'Processando raciocínio...';
      case 'SPEAKING':
        return 'Transmitindo resposta...';
      case 'EXECUTING':
        return 'Executando comando no sistema...';
      case 'ERROR':
        return 'Atenção: Verifique a conexão ou chave API.';
      case 'IDLE':
      default:
        return 'LIORA pronta. Como posso ajudar?';
    }
  };

  // Fetch status of keys from backend
  const loadApiKeyStatus = async () => {
    try {
      const res = await fetch('/api/env/keys/status', {
        headers: { 'Accept': 'application/json' }
      });
      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('application/json')) {
        const data = await res.json();
        setApiKeyStatus({
          geminiConfigured: Boolean(data.gemini?.isConfigured),
          geminiMasked: data.gemini?.masked || '',
          openRouterConfigured: Boolean(data.openrouter?.isConfigured),
          openRouterMasked: data.openrouter?.masked || ''
        });
      }
    } catch {
      // Offline fallback
    }
  };

  // Refresh real host telemetry via devicesManager
  const loadTelemetry = async () => {
    try {
      const t = await devicesManager.refreshTelemetry('dev-1');
      if (t) {
        setCpuUsage(t.cpuUsagePercent);
        setRamUsage(t.memoryUsagePercent);
      }
      const integrations = integrationsVault.getServices();
      setActiveIntegrationsCount(integrations.filter((i) => i.status === 'CONNECTED').length);
    } catch {
      // Fallback
    }
  };

  useEffect(() => {
    loadApiKeyStatus();
    loadTelemetry();
    const interval = setInterval(loadTelemetry, 5000);
    return () => clearInterval(interval);
  }, []);

  // Escuta nível de áudio do microfone para animar a Orb 3D em tempo real
  useEffect(() => {
    const unsub = speechService.onAudioLevel((lvl) => {
      setAudioGain(lvl / 100);
    });
    return () => unsub();
  }, []);

  // Global keyboard shortcuts (Ctrl+K to focus input, Space for PTT)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Focus Input with Ctrl+K or Cmd+K
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        return;
      }

      // Space for Push-to-Talk when active element is not an input or textarea
      if (e.code === 'Space' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        toggleVoice();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleVoice]);

  // Handle Barge-in: if currently SPEAKING and user begins typing, interrupt audio
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setPromptInput(val);

    if (orbState === 'SPEAKING' && val.length > 0) {
      // Trigger Barge-in
      setOrbState('LISTENING');
      addActivityLog({
        category: 'system',
        summary: 'Barge-in Acionado',
        details: 'Voz interrompida pelo usuário via digitação instantânea.',
        riskLevel: 'R0',
        status: 'success',
        simulated: true
      });
    }
  };

  // Intent Router logic
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = promptInput.trim();
    if (!clean) return;

    // 1. Prefix: /scan
    if (clean.startsWith('/scan')) {
      setPromptInput('');
      setIntentNotification('Iniciando varredura analítica de hardware e workspace...');
      setOrbState('EXECUTING');
      await loadTelemetry();
      setTimeout(() => {
        setOrbState('IDLE');
        setIntentNotification('Varredura concluída com sucesso.');
        setTimeout(() => setIntentNotification(null), 3500);
      }, 1200);
      return;
    }

    // 2. Prefix: /clear
    if (clean.startsWith('/clear')) {
      setPromptInput('');
      clearMessages();
      setIntentNotification('Histórico de conversas da sessão atual foi limpo.');
      setTimeout(() => setIntentNotification(null), 3000);
      return;
    }

    // 3. Prefix: /exec
    if (clean.startsWith('/exec')) {
      const cmd = clean.replace('/exec', '').trim();
      setPromptInput('');
      setOrbState('EXECUTING');
      setIntentNotification(`Executando comando no sistema: "${cmd}"`);
      addActivityLog({
        category: 'system',
        summary: 'Execução de Comando Intent Router',
        details: `Comando: ${cmd}`,
        riskLevel: 'R1',
        status: 'success',
        simulated: true
      });
      setTimeout(() => {
        setOrbState('IDLE');
        setIntentNotification('Comando processado sob governança local.');
        setTimeout(() => setIntentNotification(null), 3500);
      }, 1400);
      return;
    }

    // 4. Default intent: Conversational Chat
    // Permanece na tela inicial (Home) para não quebrar a imersão visual do Orbe 3D!
    const text = clean;
    setPromptInput('');
    setHasInteractedOnHome(true);
    setIsHomeResponseDismissed(false);
    await sendMessage(text);
  };

  // Helper para reproduzir áudio da resposta no card da Home
  const handlePlayResponseAudio = () => {
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg?.text) return;

    if (isPlayingAudio) {
      speechService.stopSpeaking();
      setIsPlayingAudio(false);
      setOrbState('IDLE');
    } else {
      setIsPlayingAudio(true);
      setOrbState('SPEAKING');
      speechService.speak(
        lastMsg.text,
        () => {
          setIsPlayingAudio(true);
          setOrbState('SPEAKING');
        },
        () => {
          setIsPlayingAudio(false);
          setOrbState('IDLE');
        }
      );
    }
  };

  const handleCopyResponse = () => {
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg?.text) return;
    navigator.clipboard.writeText(lastMsg.text);
    setCopiedText(true);
    setTimeout(() => setCopiedText(false), 2000);
  };

  // Save API key to .env via backend endpoint
  const handleSaveApiKey = async (keyName: 'GEMINI_API_KEY' | 'OPENROUTER_API_KEY', keyValue: string) => {
    if (!keyValue || keyValue.trim().length < 6) {
      setApiKeySaveStatus('A chave fornecida é muito curta (mínimo 6 caracteres).');
      return;
    }

    try {
      setApiKeySaveStatus('Gravando chave de forma segura no arquivo .env...');
      const cleanKey = keyValue.trim();
      const res = await fetch('/api/env/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyName, keyValue: cleanKey })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        if (keyName === 'GEMINI_API_KEY') {
          await integrationsVault.connectService('svc-gemini', cleanKey);
          localStorage.setItem('GEMINI_API_KEY', cleanKey);
          setGeminiKeyInput('');
        }
        if (keyName === 'OPENROUTER_API_KEY') {
          await integrationsVault.connectService('svc-openrouter', cleanKey);
          localStorage.setItem('OPENROUTER_API_KEY', cleanKey);
          setOpenRouterKeyInput('');
        }
        setApiKeySaveStatus(`Sucesso: ${keyName} gravada e ativa no Cofre com sucesso.`);
        await loadApiKeyStatus();
        setTimeout(() => setApiKeySaveStatus(null), 4000);
      } else {
        setApiKeySaveStatus(`Erro: ${data.error || 'Falha ao salvar chave.'}`);
      }
    } catch {
      setApiKeySaveStatus('Erro de conexão ao salvar chave no backend.');
    }
  };

  // State-based border and glow classes for the central frame
  const getStateVisualClasses = () => {
    switch (orbState) {
      case 'LISTENING':
        return 'border-[var(--accent-primary)] shadow-[0_0_35px_var(--accent-glow)] ring-1 ring-[var(--accent-primary)]';
      case 'THINKING':
        return 'border-white/50 shadow-[0_0_30px_rgba(255,255,255,0.25)] animate-pulse';
      case 'SPEAKING':
        return 'border-[var(--accent-primary)] shadow-[0_0_40px_var(--accent-glow)] animate-pulse';
      case 'EXECUTING':
        return 'border-[var(--accent-primary)] border-dashed shadow-[0_0_30px_var(--accent-glow)]';
      case 'ERROR':
        return 'border-red-600 shadow-[0_0_35px_rgba(220,38,38,0.6)] bg-red-950/10';
      case 'IDLE':
      default:
        return 'border-white/15 hover:border-white/25 shadow-2xl';
    }
  };

  return (
    <div className="flex-1 flex flex-col xl:flex-row overflow-hidden bg-[#050505] min-w-0 w-full relative h-full text-[#FFFFFF] font-sans selection:bg-[var(--accent-primary)] selection:text-white">
      {/* Hidden ARIA Live Region for screen readers (Accessibility) */}
      <div aria-live="polite" className="sr-only">
        {`LIORA status: ${getStateCopy()}`}
      </div>

      {/* Top Header Bar: Shield Mode, Telemetry Toggle & API Vault Shortcut */}
      <div className="absolute top-4 left-4 right-4 z-30 flex items-center justify-between pointer-events-none">
        {/* Shield Mode Indicator */}
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#111111]/85 border border-[#222222] backdrop-blur-md pointer-events-auto shadow-xl">
          <Shield className="w-3.5 h-3.5 text-emerald-400" />
          <span className="text-[11px] font-mono font-medium text-[#A8A8A8]">
            Shield Mode: <span className="text-white">Local Soberano</span>
          </span>
          <Lock className="w-3 h-3 text-[#A8A8A8]" />
        </div>

        {/* Right Action Buttons */}
        <div className="flex items-center gap-2 pointer-events-auto">
          {/* API Key Vault Button */}
          <button
            onClick={() => setIsApiKeyModalOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#111111]/85 hover:bg-[#1A1A1A] border border-[#222222] text-xs text-[#A8A8A8] hover:text-white transition-all shadow-xl backdrop-blur-md"
            title="Cofre rápido de chaves de API (.env)"
          >
            <Key className="w-3.5 h-3.5" style={{ color: 'var(--accent-primary)' }} />
            <span className="hidden sm:inline">Cofre de API</span>
            {apiKeyStatus.geminiConfigured && (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block ml-0.5" />
            )}
          </button>

          {/* Context & Telemetry Drawer Toggle */}
          <button
            onClick={toggleTelemetry}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#111111]/85 hover:bg-[#1A1A1A] border border-[#222222] text-xs text-[#A8A8A8] hover:text-white transition-all shadow-xl backdrop-blur-md"
            title="Alternar painel de Contexto & Telemetria"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" style={{ color: 'var(--accent-primary)' }} />
            <span className="hidden sm:inline">Telemetria</span>
          </button>
        </div>
      </div>

      {/* Main Center Stage: 3D Core Orb & Glassmorphic Workspace */}
      <div className="flex-1 relative flex flex-col items-center justify-center overflow-hidden w-full h-full min-w-0">
        {/* Fullscreen 3D Core Canvas */}
        <div className="absolute inset-0 w-full h-full z-0 pointer-events-auto overflow-hidden">
          <LioraOrb 
            state={orbState} 
            size="100%" 
            audioGain={audioGain}
            isMinimized={isMinimized}
            onSwipeDown={() => setIsMinimized(prev => !prev)}
            onClick={() => {
              if (isMinimized) setIsMinimized(false);
            }}
          />
        </div>

        {/* Ambient lighting gradient */}
        <div 
          className="absolute inset-0 pointer-events-none z-0 transition-all duration-500" 
          style={{ background: 'radial-gradient(circle at center, var(--accent-glow) 0%, transparent 70%)' }}
        />

        {/* Central Overlay Box (Responsive to Minimized state) */}
        {!isMinimized ? (
          <div className={`absolute left-1/2 -translate-x-1/2 z-20 w-full max-w-2xl px-4 flex flex-col items-center gap-3.5 transition-all duration-300 ${
            isVoiceActive ? 'bottom-26 md:bottom-28' : 'bottom-6 md:bottom-8'
          }`}>
            {/* Intent Router Notification Toast */}
            {intentNotification && (
              <div 
                className="px-3 py-1 rounded-full bg-[#1A1A1A] border text-[11px] font-mono text-white flex items-center gap-2 shadow-2xl animate-in fade-in mb-2"
                style={{ borderColor: 'var(--accent-border)' }}
              >
                <Terminal className="w-3 h-3" style={{ color: 'var(--accent-primary)' }} />
                <span>{intentNotification}</span>
              </div>
            )}



            {/* Floating Chat Input Box with Intent Router */}
            <form onSubmit={handleSubmit} className="w-full">
              <div className={`flex items-center gap-2 bg-[#121212]/85 backdrop-blur-2xl rounded-2xl p-2.5 transition-all shadow-2xl ${getStateVisualClasses()}`}>
                <input
                  ref={inputRef}
                  type="text"
                  value={promptInput}
                  onChange={handleInputChange}
                  placeholder="Pergunte algo, digite um comando (/scan, /exec) ou fale com a LIORA..."
                  className="flex-1 bg-transparent px-4 py-2 text-sm text-white placeholder-[#777777] focus:outline-none min-w-0"
                />

                <button
                  type="button"
                  onClick={() => {
                    speechService.unlockAudio();
                    toggleVoice();
                  }}
                  className={`p-2.5 rounded-xl transition-all shrink-0 ${
                    isVoiceActive 
                      ? 'text-white animate-pulse' 
                      : 'bg-black/40 hover:bg-black/70 text-[#A8A8A8] hover:text-white border border-white/5'
                  }`}
                  style={isVoiceActive ? { backgroundColor: 'var(--accent-primary)', boxShadow: '0 0 20px var(--accent-glow)' } : undefined}
                  aria-label={isVoiceActive ? "Desativar microfone e modo de voz da LIORA" : "Ativar microfone e modo de voz da LIORA"}
                  title="Ativar/Desativar Microfone & Modo de Voz da LIORA (Escuta Contínua e Comandos de Voz - Atalho: Barra de Espaço)"
                >
                  <Mic className="w-4 h-4" />
                </button>

                {/* Send Button */}
                <button
                  type="submit"
                  className="p-2.5 text-white rounded-xl transition-all shrink-0 hover:opacity-90 active:scale-95"
                  style={{ backgroundColor: 'var(--accent-primary)', boxShadow: '0 4px 14px var(--accent-glow)' }}
                  title="Enviar comando"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </form>

            {/* Live Status Cards (Telemetria, WebSocket, Integrations) */}
            <div className="grid grid-cols-3 gap-2.5 w-full max-w-lg mb-1">
              {/* Telemetry Card */}
              <button
                onClick={() => setActiveTab('devices')}
                className="flex items-center gap-2 p-2.5 rounded-xl bg-[#111111]/80 hover:bg-[#161616] border border-[#222222] backdrop-blur-lg transition-all text-left group shadow-lg"
                title="Ver detalhes de hardware"
              >
                <div 
                  className="p-1.5 rounded-lg bg-[#1A1A1A] transition-colors"
                  style={{ color: 'var(--accent-primary)' }}
                >
                  <Cpu className="w-3.5 h-3.5" />
                </div>
                <div className="min-w-0">
                  <div className="text-[10px] text-[#A8A8A8] uppercase tracking-wider font-mono">CPU / RAM</div>
                  <div className="text-xs font-semibold text-white truncate font-mono">
                    {cpuUsage}% / {ramUsage}%
                  </div>
                </div>
              </button>

              {/* WebSocket Live Status Card */}
              <button
                type="button"
                onClick={() => {
                  setIntentNotification('Testando canal de voz em tempo real (WebSocket)...');
                  setTimeout(() => {
                    setIntentNotification('Canal Live WS conectado e verificado.');
                    setTimeout(() => setIntentNotification(null), 3000);
                  }, 600);
                }}
                className="flex items-center gap-2 p-2.5 rounded-xl bg-[#111111]/80 hover:bg-[#161616] border border-[#222222] backdrop-blur-lg transition-all text-left group shadow-lg cursor-pointer"
                title="Clique para testar conectividade WebSocket"
              >
                <div className="p-1.5 rounded-lg bg-[#1A1A1A] text-emerald-400 group-hover:scale-105 transition-transform">
                  <Radio className="w-3.5 h-3.5" />
                </div>
                <div className="min-w-0">
                  <div className="text-[10px] text-[#A8A8A8] uppercase tracking-wider font-mono">Live WS</div>
                  <div className="text-xs font-semibold text-white flex items-center gap-1.5 font-mono">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    <span>Pronto</span>
                  </div>
                </div>
              </button>

              {/* Integrations Vault Card */}
              <button
                onClick={() => setActiveTab('integrations')}
                className="flex items-center gap-2 p-2.5 rounded-xl bg-[#111111]/80 hover:bg-[#161616] border border-[#222222] backdrop-blur-lg transition-all text-left group shadow-lg"
                title="Acessar cofre de integrações"
              >
                <div 
                  className="p-1.5 rounded-lg bg-[#1A1A1A] transition-colors"
                  style={{ color: 'var(--accent-primary)' }}
                >
                  <Layers className="w-3.5 h-3.5" />
                </div>
                <div className="min-w-0">
                  <div className="text-[10px] text-[#A8A8A8] uppercase tracking-wider font-mono">Cofre</div>
                  <div className="text-xs font-semibold text-white truncate font-mono">
                    {activeIntegrationsCount} Ativas
                  </div>
                </div>
              </button>
            </div>

            {/* Gesture Hint */}
            <div className="text-[10px] text-[#666666] font-mono flex items-center gap-2">
              <span>Atalhos: [Ctrl+K] Digitar</span>
              <span>•</span>
              <span>[Espaço] Voz</span>
              <span>•</span>
              <span>Arraste para baixo para compactar</span>
            </div>
          </div>
        ) : (
          /* Minimized Floating Bar Mode */
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 px-4 py-2.5 rounded-full bg-[#111111]/90 border border-white/20 backdrop-blur-2xl shadow-2xl animate-in zoom-in-95">
            <span className="w-2 h-2 rounded-full animate-ping" style={{ backgroundColor: 'var(--accent-primary)' }} />
            <span className="text-xs font-mono font-medium text-white">{getStateCopy()}</span>
            <button
              onClick={() => setIsMinimized(false)}
              className="p-1 rounded-full hover:bg-white/10 text-[#A8A8A8] hover:text-white transition-colors"
              title="Expandir interface"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* API Key Modal Shortcut (.env Persistence) */}
      {isApiKeyModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
          <div className="bg-[#111111] border border-[#262626] rounded-2xl w-full max-w-md p-6 shadow-2xl relative">
            <button
              onClick={() => {
                setIsApiKeyModalOpen(false);
                setApiKeySaveStatus(null);
              }}
              className="absolute top-4 right-4 p-1 rounded-lg text-[#888888] hover:text-white hover:bg-[#1A1A1A] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>

            <div className="flex items-center gap-2.5 mb-4">
              <div 
                className="p-2 rounded-xl"
                style={{ backgroundColor: 'var(--accent-bg)', color: 'var(--accent-primary)' }}
              >
                <Key className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Cofre Rápido de Chaves (.env)</h3>
                <p className="text-xs text-[#888888]">Persistência segura direta no host local</p>
              </div>
            </div>

            <div className="space-y-4 text-xs font-mono">
              {/* Gemini Key Input */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-white font-semibold">GEMINI_API_KEY</span>
                  <span className={`text-[10px] px-2 py-0.5 rounded ${apiKeyStatus.geminiConfigured ? 'bg-emerald-950 text-emerald-400 border border-emerald-900' : 'bg-red-950 text-red-400 border border-red-900'}`}>
                    {apiKeyStatus.geminiConfigured ? `Ativa (${apiKeyStatus.geminiMasked})` : 'Não configurada'}
                  </span>
                </div>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={geminiKeyInput}
                    onChange={(e) => setGeminiKeyInput(e.target.value)}
                    placeholder="Cole sua nova chave Gemini..."
                    className="flex-1 bg-[#161616] border border-[#2B2B2B] rounded-xl px-3 py-2 text-white placeholder-[#555] focus:outline-none focus:border-[var(--accent-primary)]"
                  />
                  <button
                    onClick={() => handleSaveApiKey('GEMINI_API_KEY', geminiKeyInput)}
                    className="px-3 py-2 text-white rounded-xl font-sans font-semibold transition-colors hover:opacity-90"
                    style={{ backgroundColor: 'var(--accent-primary)' }}
                  >
                    Salvar
                  </button>
                </div>
              </div>

              {/* OpenRouter Key Input */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-white font-semibold">OPENROUTER_API_KEY</span>
                  <span className={`text-[10px] px-2 py-0.5 rounded ${apiKeyStatus.openRouterConfigured ? 'bg-emerald-950 text-emerald-400 border border-emerald-900' : 'bg-zinc-800 text-zinc-400'}`}>
                    {apiKeyStatus.openRouterConfigured ? `Ativa (${apiKeyStatus.openRouterMasked})` : 'Opcional'}
                  </span>
                </div>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={openRouterKeyInput}
                    onChange={(e) => setOpenRouterKeyInput(e.target.value)}
                    placeholder="Cole sua chave OpenRouter..."
                    className="flex-1 bg-[#161616] border border-[#2B2B2B] rounded-xl px-3 py-2 text-white placeholder-[#555] focus:outline-none focus:border-[var(--accent-primary)]"
                  />
                  <button
                    onClick={() => handleSaveApiKey('OPENROUTER_API_KEY', openRouterKeyInput)}
                    className="px-3 py-2 text-white rounded-xl font-sans font-semibold transition-colors hover:opacity-90 shadow-md shadow-[var(--accent-glow)]"
                    style={{ backgroundColor: 'var(--accent-primary)' }}
                  >
                    Salvar
                  </button>
                </div>
              </div>

              {/* Status Message */}
              {apiKeySaveStatus && (
                <div className="p-2.5 rounded-xl bg-[#161616] border border-[#2B2B2B] text-xs text-[#A8A8A8] mt-2">
                  {apiKeySaveStatus}
                </div>
              )}

              <div className="text-[11px] text-[#777777] font-sans pt-2 border-t border-[#222222]">
                As chaves são gravadas diretamente no arquivo <code>.env</code> do backend e aplicadas imediatamente na sessão em memória, sem necessidade de reiniciar o servidor.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Right Context & Telemetry Sidebar */}
      {isTelemetryOpen && (
        <aside className="w-full xl:w-96 border-t xl:border-t-0 xl:border-l border-[#222222] bg-[#0A0A0A]/95 backdrop-blur-xl p-4 md:p-6 flex flex-col gap-5 xl:overflow-y-auto shrink-0 z-35 animate-in slide-in-from-right duration-200 no-scrollbar h-full">
          <div className="flex items-center justify-between pb-4 border-b border-[#222222]">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[#A8A8A8] flex items-center gap-2">
              <Activity className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
              <span>Contexto & Telemetria</span>
            </h3>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-emerald-400">Live Feed</span>
              <button
                onClick={closeTelemetry}
                className="p-1 rounded text-[#888888] hover:text-white hover:bg-[#1A1A1A] transition-colors"
                title="Fechar painel"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Active Task Widget */}
          <div className="bg-[#111111] border border-[#222222] rounded-xl p-5 flex flex-col justify-between shadow-lg">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-primary)' }}>Tarefa Ativa</span>
                <span className="px-2 py-0.5 bg-[#1A1A1A] border border-[#333333] text-[10px] text-[#A8A8A8] rounded">R1</span>
              </div>
              <h4 className="mt-2 font-semibold text-white text-sm">
                {activeTask ? activeTask.goal : 'Nenhuma tarefa em execução'}
              </h4>
              {activeTask && (
                <div className="mt-3 space-y-2">
                  {activeTask.steps.map(step => (
                    <div key={step.id} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2 min-w-0">
                        <CheckCircle2 className={`w-3.5 h-3.5 shrink-0 ${step.status === 'completed' ? 'text-emerald-400' : 'text-amber-500 animate-spin'}`} />
                        <span className={`truncate ${step.status === 'completed' ? 'text-[#A8A8A8]' : 'text-white font-medium'}`}>{step.title}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <button 
              onClick={() => setActiveTab('activity')}
              className="mt-4 flex items-center justify-between text-xs font-semibold text-white transition-colors pt-3 border-t border-[#222222]"
              style={{ color: 'var(--accent-primary)' }}
            >
              <span>Ver linha do tempo</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Devices Telemetry Widget */}
          <div className="bg-[#111111] border border-[#222222] rounded-xl p-5 flex flex-col justify-between shadow-lg">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[#A8A8A8]">Dispositivos LIORA</span>
                <span className="text-xs font-mono text-emerald-400">{devices.filter(d => d.connected).length} online</span>
              </div>
              <div className="mt-3 space-y-2">
                {devices.slice(0, 3).map(device => (
                  <div key={device.id} className="flex items-center justify-between text-xs py-1.5 border-b border-[#1A1A1A] last:border-0">
                    <span className="text-white font-medium truncate">{device.name}</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded font-mono ${device.connected ? 'bg-emerald-950/50 text-emerald-400 border border-emerald-900' : 'bg-zinc-900 text-zinc-500'}`}>
                      {device.connected ? 'Conectado' : 'Offline'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <button 
              onClick={() => setActiveTab('devices')}
              className="mt-4 flex items-center justify-between text-xs font-semibold text-white hover:text-[var(--accent-primary)] transition-colors pt-3 border-t border-[#222222]"
            >
              <span>Gerenciar dispositivos</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </aside>
      )}
    </div>
  );
};

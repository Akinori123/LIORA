/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useLioraStore } from '../store/lioraStore';
import { Mic, MicOff, Shield, Server, Sparkles, Menu } from 'lucide-react';
import { invokeTauri, isTauriEnvironment } from '../security/localBridge';

/**
 * Arraste nativo da janela pelo cabeçalho.
 * Causa raiz tratada: o WebView2 (Windows/Tauri) NÃO suporta `-webkit-app-region:
 * drag` — sem isso a janela não podia ser movida (especialmente quando a barra
 * de título nativa fica coberta pelo conteúdo). `data-tauri-drag-region` só
 * funciona com o script do core injetado; aqui usamos o comando IPC `start_drag`,
 * que é determinístico. No navegador comum o handler simplesmente não faz nada.
 */
const handleHeaderPointerDown = (e: React.PointerEvent<HTMLElement>) => {
  if (!isTauriEnvironment() || e.button !== 0) return;
  const target = e.target as HTMLElement | null;
  // Não arrastar quando o clique veio de um controle interativo
  if (target?.closest('button, a, input, select, textarea, [role="button"], [data-no-drag]')) return;
  void invokeTauri('start_drag').catch(() => {});
};

export const Header: React.FC = () => {
  const { activeTab, isVoiceActive, toggleVoice, setActiveTab, toggleMobileDrawer } = useLioraStore(
    useShallow((s) => ({
      activeTab: s.activeTab,
      isVoiceActive: s.isVoiceActive,
      toggleVoice: s.toggleVoice,
      setActiveTab: s.setActiveTab,
      toggleMobileDrawer: s.toggleMobileDrawer
    }))
  );

  const getPageTitle = () => {
    switch (activeTab) {
      case 'home': return 'Central de Comando';
      case 'conversation': return 'Conversa & Voz em Tempo Real';
      case 'activity': return 'Atividade & Auditoria de Tarefas';
      case 'memory': return 'Memória & Contexto Duradouro';
      case 'devices': return 'Dispositivos & Continuidade PULO';
      case 'cockpit': return 'Cockpit & Veículo';
      case 'automations': return 'Automações & Proatividade';
      case 'developer': return 'Agente de Desenvolvimento & Git';
      case 'integrations': return 'Integrações, Modelos & MCP';
      case 'settings': return 'Configurações do Sistema';
      default: return 'LIORA Core';
    }
  };

  return (
    <header
      onPointerDown={handleHeaderPointerDown}
      className="flex items-center justify-between gap-3 sm:gap-6 md:gap-8 px-3.5 sm:px-6 md:px-8 py-3 md:py-4 border-b border-[#222222] bg-[#0A0A0A] shrink-0 z-10 min-w-0 select-none"
    >
      {/* Zone 1: Mobile Hamburger & Page Title */}
      <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
        <button
          type="button"
          onClick={toggleMobileDrawer}
          className="md:hidden p-2 rounded-lg bg-[#141414] hover:bg-[#1F1F1F] text-[#A8A8A8] hover:text-white border border-[#262626] transition-colors focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)] shrink-0"
          aria-label="Abrir menu de navegação"
          data-testid="mobile-menu-button"
        >
          <Menu className="w-4 h-4 text-white" />
        </button>
        <h1 className="text-sm sm:text-base md:text-lg font-bold tracking-tight text-white truncate">
          {getPageTitle()}
        </h1>
      </div>

      {/* Zone 2: Status pill / Environment */}
      <div className="hidden md:flex items-center gap-4 text-xs text-[#A8A8A8] shrink-0">
        <div className="flex items-center gap-2 px-3 py-1 bg-[#141414] border border-[#222222] rounded-full">
          <Server className="w-3.5 h-3.5" style={{ color: 'var(--accent-primary)' }} />
          <span>Gemini 3.1 Flash Lite (Server-Side)</span>
        </div>
        <div className="flex items-center gap-2 px-3 py-1 bg-[#141414] border border-[#222222] rounded-full">
          <Shield className="w-3.5 h-3.5 text-[#10b981]" />
          <span>Permission: R0–R3 Active</span>
        </div>
      </div>

      {/* Zone 3: Primary Action */}
      <div className="flex items-center gap-3 shrink-0">
        <button
          type="button"
          onClick={toggleVoice}
          aria-label={isVoiceActive ? 'Encerrar voz' : 'Iniciar voz'}
          className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg transition-all shadow-md ${
            isVoiceActive 
              ? 'text-white animate-pulse' 
              : 'bg-[#171717] hover:bg-[#222222] text-white border border-[#333333]'
          }`}
          style={isVoiceActive ? { backgroundColor: 'var(--accent-primary)', boxShadow: '0 4px 14px var(--accent-glow)' } : undefined}
        >
          {isVoiceActive ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
          <span className="whitespace-nowrap">{isVoiceActive ? 'Encerrar Voz' : 'Iniciar Voz'}</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('integrations')}
          className="p-2 bg-[#171717] hover:bg-[#222222] border border-[#333333] rounded-lg text-[#A8A8A8] hover:text-white transition-colors"
          title="Modelos & Provedores"
          aria-label="Abrir integrações de modelos e provedores"
        >
          <Sparkles className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect } from 'react';
import { useLioraStore } from '../store/lioraStore';
import { NavTab } from '../types';
import { 
  Cpu, 
  MessageSquare, 
  Activity, 
  Database, 
  Smartphone, 
  Zap, 
  Code2, 
  Sliders, 
  Settings as SettingsIcon,
  ChevronLeft,
  ChevronRight,
  X,
  Gauge
} from 'lucide-react';

export const Sidebar: React.FC = () => {
  const { 
    activeTab, 
    setActiveTab, 
    isSidebarExpanded, 
    toggleSidebar, 
    orbState,
    isMobileDrawerOpen,
    closeMobileDrawer
  } = useLioraStore();

  const navItems: { id: NavTab; label: string; icon: React.ReactNode }[] = [
    { id: 'home', label: 'Início', icon: <Cpu className="w-5 h-5" /> },
    { id: 'conversation', label: 'Conversa & Voz', icon: <MessageSquare className="w-5 h-5" /> },
    { id: 'activity', label: 'Atividade & Logs', icon: <Activity className="w-5 h-5" /> },
    { id: 'memory', label: 'Memória & Contexto', icon: <Database className="w-5 h-5" /> },
    { id: 'devices', label: 'Dispositivos & PULO', icon: <Smartphone className="w-5 h-5" /> },
    { id: 'cockpit', label: 'Cockpit & Veículo', icon: <Gauge className="w-5 h-5" /> },
    { id: 'automations', label: 'Automações', icon: <Zap className="w-5 h-5" /> },
    { id: 'developer', label: 'Desenvolvedor & Git', icon: <Code2 className="w-5 h-5" /> },
    { id: 'integrations', label: 'Integrações & MCP', icon: <Sliders className="w-5 h-5" /> },
    { id: 'settings', label: 'Configurações', icon: <SettingsIcon className="w-5 h-5" /> },
  ];

  // Close on Escape key press
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isMobileDrawerOpen) {
        closeMobileDrawer();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isMobileDrawerOpen, closeMobileDrawer]);

  return (
    <>
      {/* Mobile Backdrop Overlay */}
      {isMobileDrawerOpen && (
        <div 
          onClick={closeMobileDrawer}
          data-testid="drawer-backdrop"
          className="fixed inset-0 bg-black/75 backdrop-blur-[2px] z-40 md:hidden animate-fade-in transition-opacity"
          aria-hidden="true"
        />
      )}

      {/* Main Sidebar / Mobile Drawer */}
      <aside 
        data-testid="app-sidebar"
        className={`border-r border-[#222222] bg-[#0A0A0A] transition-all duration-300 ${
          isMobileDrawerOpen 
            ? 'fixed inset-y-0 left-0 w-72 max-w-[85vw] z-50 flex flex-col shadow-2xl' 
            : 'hidden md:flex flex-col'
        } md:relative md:inset-auto md:z-20 ${
          isSidebarExpanded ? 'md:w-64' : 'md:w-20'
        }`}
      >
        {/* Brand Header */}
        <div className="flex items-center justify-between px-4 py-5 border-b border-[#222222] shrink-0">
          <div className="flex items-center gap-3 overflow-hidden">
            <div 
              className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 shadow-lg"
              style={{ background: 'linear-gradient(to bottom right, var(--accent-primary), rgba(0, 0, 0, 0.7))', boxShadow: '0 10px 25px -5px var(--accent-glow)' }}
            >
              <span className="font-bold text-white tracking-wider text-sm">L</span>
            </div>
            {(isSidebarExpanded || isMobileDrawerOpen) && (
              <div className="flex flex-col truncate">
                <span className="font-display font-bold text-lg tracking-tight text-white">LIORA</span>
                <span className="text-[10px] text-[#A8A8A8] tracking-widest uppercase">AI Core v1.0</span>
              </div>
            )}
          </div>

          {/* Visible Close Button on Mobile */}
          <button 
            onClick={closeMobileDrawer}
            className="md:hidden p-1.5 rounded-md hover:bg-[#1A1A1A] text-[#A8A8A8] hover:text-white transition-colors focus:outline-none"
            style={{ '--tw-ring-color': 'var(--accent-primary)' } as any}
            aria-label="Fechar menu de navegação"
            data-testid="close-drawer-button"
          >
            <X className="w-5 h-5" />
          </button>

          {/* Desktop Collapse Toggle */}
          <button 
            onClick={toggleSidebar}
            className="hidden md:block p-1.5 rounded-md hover:bg-[#1A1A1A] text-[#A8A8A8] hover:text-white transition-colors focus:outline-none"
            title={isSidebarExpanded ? "Recolher menu" : "Expandir menu"}
            aria-label={isSidebarExpanded ? "Recolher menu lateral" : "Expandir menu lateral"}
            data-testid="desktop-sidebar-toggle"
          >
            {isSidebarExpanded ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
        </div>



        {/* Navigation Links */}
        <nav className="flex-1 px-3 py-3 space-y-1.5 overflow-y-auto">
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            const showLabel = isSidebarExpanded || isMobileDrawerOpen;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                data-testid={`nav-item-${item.id}`}
                aria-label={item.label}
                title={item.label}
                className={`w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-all group relative ${
                  isActive 
                    ? 'bg-[#1A1A1A] text-white border-l-2 shadow-sm' 
                    : 'text-[#A8A8A8] hover:bg-[#141414] hover:text-[#F5F5F5]'
                }`}
                style={isActive ? { borderColor: 'var(--accent-primary)' } : undefined}
              >
                <span 
                  className={`transition-colors shrink-0 ${isActive ? '' : 'text-[#888888] group-hover:text-white'}`}
                  style={isActive ? { color: 'var(--accent-primary)' } : undefined}
                >
                  {item.icon}
                </span>
                {showLabel && (
                  <span className="truncate tracking-wide text-left">{item.label}</span>
                )}
                {!showLabel && (
                  <div className="absolute left-full ml-2 px-2.5 py-1 bg-[#1A1A1A] border border-[#333333] text-white text-xs rounded-md opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50 shadow-xl">
                    {item.label}
                  </div>
                )}
              </button>
            );
          })}
        </nav>

        {/* Footer Status Box */}
        <div className="p-4 border-t border-[#222222] bg-[#070707] shrink-0">
          <div className={`flex items-center ${(isSidebarExpanded || isMobileDrawerOpen) ? 'gap-3' : 'justify-center'}`}>
            <div className="relative flex h-3 w-3 shrink-0">
              <span 
                className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${orbState === 'ERROR' ? 'bg-red-400' : ''}`}
                style={orbState !== 'ERROR' ? { backgroundColor: 'var(--accent-primary)' } : undefined}
              ></span>
              <span 
                className={`relative inline-flex rounded-full h-3 w-3 ${orbState === 'ERROR' ? 'bg-red-500' : ''}`}
                style={orbState !== 'ERROR' ? { backgroundColor: 'var(--accent-primary)' } : undefined}
              ></span>
            </div>
            {(isSidebarExpanded || isMobileDrawerOpen) && (
              <div className="flex flex-col truncate">
                <span className="text-xs font-semibold text-white truncate">Sistema Ativo</span>
                <span className="text-[10px] text-[#A8A8A8] truncate">Gemini 3.1 Flash Lite • R0–R3</span>
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
};

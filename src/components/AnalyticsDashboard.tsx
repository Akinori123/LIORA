/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { 
  Activity, 
  Cpu, 
  Zap, 
  Clock, 
  BarChart3, 
  RefreshCw, 
  Layers, 
  Server,
  ArrowUpRight
} from 'lucide-react';
import { tokenAnalytics, TokenUsageStats } from '../services/tokenAnalytics';

export const AnalyticsDashboard: React.FC = () => {
  const [stats, setStats] = useState<TokenUsageStats>(tokenAnalytics.getStats());

  useEffect(() => {
    const unsub = tokenAnalytics.subscribe((newStats) => {
      setStats(newStats);
    });
    return unsub;
  }, []);

  const geminiPercent = stats.totalCalls > 0 
    ? Math.round((stats.geminiCalls / stats.totalCalls) * 100) 
    : 100;

  const openRouterPercent = stats.totalCalls > 0 
    ? Math.round((stats.openRouterCalls / stats.totalCalls) * 100) 
    : 0;

  return (
    <div className="bg-[#111111] border border-[#222222] rounded-xl p-6 space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-4 border-b border-[#222222]">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-[var(--accent-bg)] border border-[var(--accent-border)] rounded-lg text-[var(--accent-primary)]">
            <BarChart3 className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-bold text-white text-base">Dashboard de Consumo de Tokens & Latência</h3>
            <p className="text-xs text-[#A8A8A8]">Métricas em tempo real de chamadas de IA e tempo de resposta das APIs</p>
          </div>
        </div>

        <button
          onClick={() => setStats(tokenAnalytics.getStats())}
          className="p-1.5 bg-[#171717] hover:bg-[#222222] border border-[#2E2E2E] rounded-lg text-[#A8A8A8] hover:text-white transition-colors"
          title="Atualizar estatísticas"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Grid de Cards Principais */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
        {/* Card 1: Total de Tokens */}
        <div className="bg-[#141414] border border-[#222222] rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between text-[#888888]">
            <span className="text-xs font-semibold uppercase tracking-wider">Total de Tokens</span>
            <Zap className="w-4 h-4 text-[var(--accent-primary)]" />
          </div>
          <div className="text-2xl font-bold font-mono text-white">
            {stats.totalTokens.toLocaleString('pt-BR')}
          </div>
          <p className="text-[11px] text-[#A8A8A8]">Sessão ativa contínua</p>
        </div>

        {/* Card 2: Chamadas Gemini */}
        <div className="bg-[#141414] border border-[#222222] rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between text-[#888888]">
            <span className="text-xs font-semibold uppercase tracking-wider">Provedor Gemini</span>
            <Cpu className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-emerald-400">
            {stats.geminiCalls} <span className="text-xs text-[#888888] font-normal">reqs</span>
          </div>
          <p className="text-[11px] text-[#A8A8A8]">
            {stats.geminiTokens.toLocaleString('pt-BR')} tokens
          </p>
        </div>

        {/* Card 3: Failover OpenRouter */}
        <div className="bg-[#141414] border border-[#222222] rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between text-[#888888]">
            <span className="text-xs font-semibold uppercase tracking-wider">Backup OpenRouter</span>
            <Layers className="w-4 h-4 text-purple-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-purple-400">
            {stats.openRouterCalls} <span className="text-xs text-[#888888] font-normal">reqs</span>
          </div>
          <p className="text-[11px] text-[#A8A8A8]">
            {stats.openRouterTokens.toLocaleString('pt-BR')} tokens
          </p>
        </div>

        {/* Card 4: Latência Média */}
        <div className="bg-[#141414] border border-[#222222] rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between text-[#888888]">
            <span className="text-xs font-semibold uppercase tracking-wider">Latência Média</span>
            <Clock className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-amber-400">
            {stats.averageLatencyMs}ms
          </div>
          <p className="text-[11px] text-[#A8A8A8]">Aferição HTTP/SSE móvel</p>
        </div>
      </div>

      {/* Distribuição de Chamadas & Histórico de Latência */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
        {/* Distribuição Gemini vs OpenRouter */}
        <div className="bg-[#141414] border border-[#222222] rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-white">
              Distribuição de Provedores
            </h4>
            <span className="text-[10px] font-mono text-[#888888]">Total: {stats.totalCalls} chamadas</span>
          </div>

          <div className="space-y-2 pt-1">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-emerald-400 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400" /> Gemini Provedor Nativo
              </span>
              <span className="text-white font-bold">{geminiPercent}%</span>
            </div>
            <div className="w-full bg-[#222222] h-2 rounded-full overflow-hidden">
              <div 
                className="bg-emerald-400 h-full transition-all duration-300" 
                style={{ width: `${geminiPercent}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-xs font-mono pt-2">
              <span className="text-purple-400 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-purple-400" /> OpenRouter Failover
              </span>
              <span className="text-white font-bold">{openRouterPercent}%</span>
            </div>
            <div className="w-full bg-[#222222] h-2 rounded-full overflow-hidden">
              <div 
                className="bg-purple-400 h-full transition-all duration-300" 
                style={{ width: `${openRouterPercent}%` }}
              />
            </div>
          </div>
        </div>

        {/* Gráfico Visual de Histórico de Latência */}
        <div className="bg-[#141414] border border-[#222222] rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-white">
              Histórico de Latência Recente (ms)
            </h4>
            <span className="text-[10px] font-mono text-amber-400">{stats.averageLatencyMs}ms médio</span>
          </div>

          <div className="flex items-end gap-1.5 h-20 pt-2 border-b border-[#222222] pb-1">
            {stats.latencyHistory.map((lat, idx) => {
              const maxLat = Math.max(...stats.latencyHistory, 500);
              const heightPercent = Math.min(100, Math.max(15, Math.round((lat / maxLat) * 100)));
              return (
                <div key={idx} className="flex-1 flex flex-col items-center gap-1 group relative">
                  <div 
                    className="w-full bg-[var(--accent-primary)] rounded-t hover:opacity-100 opacity-80 transition-all"
                    style={{ height: `${heightPercent}%` }}
                  />
                  <span className="absolute -top-6 bg-[#222222] text-white text-[9px] font-mono px-1 rounded opacity-0 group-hover:opacity-100 transition-opacity">
                    {lat}ms
                  </span>
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between text-[10px] font-mono text-[#777777]">
            <span>Mais Antigo</span>
            <span>Última chamada: {stats.lastCallTimestamp ? new Date(stats.lastCallTimestamp).toLocaleTimeString() : 'N/A'}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

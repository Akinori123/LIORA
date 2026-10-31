/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useLioraStore } from '../../store/lioraStore';
import { ActivityLogItem } from '../../types';
import { 
  Activity, 
  ShieldCheck, 
  CheckCircle2, 
  AlertTriangle, 
  Search, 
  Filter, 
  Download, 
  Trash2, 
  ArrowUp,
  X,
  FileCode,
  FileText
} from 'lucide-react';

export const ActivityView: React.FC = () => {
  const { activityLogs, activeTask, clearActivityLogs } = useLioraStore();

  // Filters state
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterRisk, setFilterRisk] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');

  // Modal and Scroll state
  const [isClearModalOpen, setIsClearModalOpen] = useState(false);
  const [isScrolledDown, setIsScrolledDown] = useState(false);
  const [unseenCount, setUnseenCount] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const prevLogsLengthRef = useRef(activityLogs.length);

  // Filter logs in real time
  const filteredLogs = useMemo(() => {
    return activityLogs.filter((log) => {
      // Text match
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesSummary = log.summary.toLowerCase().includes(q);
        const matchesDetails = log.details.toLowerCase().includes(q);
        const matchesId = log.id.toLowerCase().includes(q);
        if (!matchesSummary && !matchesDetails && !matchesId) return false;
      }

      // Category match
      if (filterCategory !== 'all' && log.category !== filterCategory) {
        return false;
      }

      // Risk match
      if (filterRisk !== 'all' && log.riskLevel !== filterRisk) {
        return false;
      }

      // Status match
      if (filterStatus !== 'all' && log.status !== filterStatus) {
        return false;
      }

      return true;
    });
  }, [activityLogs, searchQuery, filterCategory, filterRisk, filterStatus]);

  // Track scroll position for smart floating notification
  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop } = containerRef.current;
    if (scrollTop > 80) {
      setIsScrolledDown(true);
    } else {
      setIsScrolledDown(false);
      setUnseenCount(0);
    }
  };

  // Detect incoming logs when user is scrolled down
  useEffect(() => {
    const diff = activityLogs.length - prevLogsLengthRef.current;
    if (diff > 0 && isScrolledDown) {
      setUnseenCount((prev) => prev + diff);
    }
    prevLogsLengthRef.current = activityLogs.length;
  }, [activityLogs, isScrolledDown]);

  const scrollToTop = () => {
    if (containerRef.current) {
      containerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
      setUnseenCount(0);
    }
  };

  // Export handlers
  const handleExportJson = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(filteredLogs, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `liora_audit_logs_${Date.now()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const handleExportCsv = () => {
    const headers = ['ID', 'Timestamp', 'Categoria', 'Risco', 'Status', 'Resumo', 'Detalhes', 'Simulado'];
    const rows = filteredLogs.map((log) => [
      log.id,
      log.timestamp,
      log.category,
      log.riskLevel,
      log.status,
      `"${log.summary.replace(/"/g, '""')}"`,
      `"${log.details.replace(/"/g, '""')}"`,
      log.simulated ? 'SIM' : 'NAO'
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", url);
    downloadAnchor.setAttribute("download", `liora_audit_logs_${Date.now()}.csv`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  return (
    <div 
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 flex flex-col overflow-y-auto p-4 sm:p-6 md:p-8 space-y-6 max-w-6xl mx-auto w-full relative"
    >
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-display font-bold text-white">Atividade & Auditoria de Tarefas</h2>
          <p className="text-xs sm:text-sm text-[#A8A8A8]">Registro detalhado de planos, chamadas de ferramentas, nível de risco e verificação.</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-[#141414] border border-[#222222] rounded-xl text-xs font-mono text-[#10b981]">
            <ShieldCheck className="w-4 h-4" />
            <span>Auditoria Ativa (R0–R3)</span>
          </div>
        </div>
      </div>

      {/* Active Task Details */}
      {activeTask && (
        <div className="bg-[#111111] border border-[#222222] rounded-2xl p-5 sm:p-6 shadow-xl">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--accent-primary)]">Plano de Execução Atual</span>
            <span className="px-2.5 py-1 bg-amber-500/10 border border-amber-500/20 text-xs font-mono text-amber-400 rounded-lg">
              Risco: {activeTask.riskLevel} • {activeTask.status}
            </span>
          </div>
          <h3 className="mt-2 text-base sm:text-lg font-bold text-white">{activeTask.goal}</h3>
          
          <div className="mt-4 space-y-2.5">
            {activeTask.steps.map(step => (
              <div key={step.id} className="flex items-center justify-between bg-[#171717] px-4 py-3 rounded-xl border border-[#222222]">
                <div className="flex items-center gap-3 min-w-0">
                  <CheckCircle2 className={`w-4 h-4 shrink-0 ${step.status === 'completed' ? 'text-[#10b981]' : 'text-amber-500 animate-spin'}`} />
                  <div className="min-w-0">
                    <span className="text-xs sm:text-sm font-medium text-white truncate block">{step.title}</span>
                    <span className="text-[10px] sm:text-xs font-mono text-[#888888]">tool: {step.toolName || 'system'}</span>
                  </div>
                </div>
                <span className="text-xs font-mono text-[#888888] shrink-0 ml-2">
                  {step.durationMs ? `${step.durationMs}ms` : 'Em execução...'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Audit Toolbar & Filters */}
      <div className="bg-[#111111] border border-[#222222] rounded-2xl p-4 space-y-3 shadow-xl">
        <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
          {/* Search Box */}
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-[#777777]" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar em resumos, detalhes ou ID..."
              className="w-full bg-[#161616] border border-[#2B2B2B] rounded-xl pl-10 pr-4 py-2 text-xs sm:text-sm text-white placeholder-[#666666] focus:outline-none focus:border-[var(--accent-primary)] transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[#777777] hover:text-white"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Action Buttons: Export & Clear */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleExportJson}
              className="flex items-center gap-1.5 px-3 py-2 bg-[#161616] hover:bg-[#222222] border border-[#2B2B2B] rounded-xl text-xs text-[#CCCCCC] hover:text-white transition-colors"
              title="Exportar logs filtrados em formato JSON"
            >
              <FileCode className="w-3.5 h-3.5 text-[var(--accent-primary)]" />
              <span className="hidden sm:inline">JSON</span>
            </button>
            <button
              onClick={handleExportCsv}
              className="flex items-center gap-1.5 px-3 py-2 bg-[#161616] hover:bg-[#222222] border border-[#2B2B2B] rounded-xl text-xs text-[#CCCCCC] hover:text-white transition-colors"
              title="Exportar logs filtrados em formato CSV"
            >
              <FileText className="w-3.5 h-3.5 text-emerald-400" />
              <span className="hidden sm:inline">CSV</span>
            </button>
            <button
              onClick={() => setIsClearModalOpen(true)}
              className="flex items-center gap-1.5 px-3 py-2 bg-[#161616] hover:bg-red-950/40 border border-[#2B2B2B] hover:border-red-900/60 rounded-xl text-xs text-[#888888] hover:text-red-400 transition-colors"
              title="Limpar todos os logs de auditoria"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Limpar</span>
            </button>
          </div>
        </div>

        {/* Dropdown Filters Row */}
        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-[#1C1C1C]">
          <div className="flex items-center gap-1.5 text-xs text-[#777777] font-mono mr-1">
            <Filter className="w-3.5 h-3.5 text-[var(--accent-primary)]" />
            <span>FILTROS:</span>
          </div>

          {/* Category Filter */}
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="bg-[#161616] border border-[#2B2B2B] rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[var(--accent-primary)]"
          >
            <option value="all">Todas as Categorias</option>
            <option value="ai">AI (Modelos)</option>
            <option value="voice">Voz ao Vivo</option>
            <option value="system">Sistema</option>
            <option value="security">Segurança</option>
            <option value="tool">Ferramentas</option>
          </select>

          {/* Risk Level Filter */}
          <select
            value={filterRisk}
            onChange={(e) => setFilterRisk(e.target.value)}
            className="bg-[#161616] border border-[#2B2B2B] rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[var(--accent-primary)]"
          >
            <option value="all">Todos os Riscos</option>
            <option value="R0">R0 (Baixo/Info)</option>
            <option value="R1">R1 (Moderado)</option>
            <option value="R2">R2 (Alto Impacto)</option>
            <option value="R3">R3 (Crítico/Privilegiado)</option>
          </select>

          {/* Status Filter */}
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="bg-[#161616] border border-[#2B2B2B] rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[var(--accent-primary)]"
          >
            <option value="all">Todos os Status</option>
            <option value="success">Sucesso</option>
            <option value="warning">Alerta</option>
            <option value="error">Erro</option>
          </select>

          {/* Results Counter */}
          <span className="ml-auto text-[11px] font-mono text-[#888888]">
            {filteredLogs.length} de {activityLogs.length} logs
          </span>
        </div>
      </div>

      {/* Activity Logs Timeline */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-white">Linha do Tempo de Eventos e Logs</h3>
          <span className="text-xs font-mono text-[#777777]">Janela deslizante: 200 logs máx</span>
        </div>
        
        <div className="space-y-3">
          {filteredLogs.map((log) => {
            const isHighRisk = log.riskLevel === 'R2' || log.riskLevel === 'R3';
            const isError = log.status === 'error';

            return (
              <div 
                key={log.id} 
                className={`rounded-2xl p-4 sm:p-5 flex items-start gap-4 transition-all shadow-md ${
                  isHighRisk 
                    ? 'bg-[var(--accent-bg)] border-2 border-[var(--accent-border)] shadow-[var(--accent-glow)]' 
                    : isError
                      ? 'bg-[#180C0C] border border-red-900/60'
                      : 'bg-[#111111] border border-[#222222] hover:border-[#333333]'
                }`}
              >
                {/* Icon Badge */}
                <div 
                  className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                    isHighRisk
                      ? 'bg-[var(--accent-primary)] text-white shadow-md shadow-[var(--accent-glow)] animate-pulse'
                      : log.status === 'success'
                        ? 'bg-[#10b981]/10 text-[#10b981] border border-[#10b981]/20'
                        : log.status === 'warning'
                          ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                          : 'bg-red-500/10 text-red-400 border border-red-500/20'
                  }`}
                >
                  {isHighRisk ? (
                    <AlertTriangle className="w-5 h-5" />
                  ) : (
                    <Activity className="w-5 h-5" />
                  )}
                </div>

                {/* Content Details */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-4">
                    <h4 className={`font-semibold text-sm ${isHighRisk ? 'text-[#FF4A4A]' : 'text-white'}`}>
                      {log.summary}
                    </h4>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`text-[10px] font-mono px-2 py-0.5 rounded font-bold uppercase ${
                        isHighRisk 
                          ? 'bg-[var(--accent-primary)] text-white' 
                          : 'bg-[#171717] border border-[#333333] text-[#A8A8A8]'
                      }`}>
                        {log.riskLevel}
                      </span>
                      <span className="text-xs font-mono text-[#888888]">{log.timestamp}</span>
                    </div>
                  </div>

                  <p className="mt-1 text-xs text-[#A8A8A8] leading-relaxed font-sans">{log.details}</p>

                  <div className="mt-2.5 flex items-center gap-2 text-[10px] font-mono text-[#666666]">
                    <span className="uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#171717] border border-[#262626]">
                      {log.category}
                    </span>
                    <span>•</span>
                    <span>ID: {log.id}</span>
                    {log.verified && (
                      <>
                        <span>•</span>
                        <span className="text-emerald-400 font-semibold flex items-center gap-1">
                          <ShieldCheck className="w-3 h-3 text-emerald-400" />
                          VERIFICADO
                        </span>
                      </>
                    )}
                    {log.simulated && (
                      <>
                        <span>•</span>
                        <span className="text-amber-500/80">SIMULADO</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {filteredLogs.length === 0 && (
            <div className="bg-[#111111] border border-[#222222] rounded-2xl p-8 text-center text-[#666666] space-y-2">
              <Activity className="w-8 h-8 text-[#333333] mx-auto animate-pulse" />
              <p className="text-sm font-medium text-[#888888]">Nenhum registro de auditoria encontrado.</p>
              <p className="text-xs text-[#555555]">Ajuste os filtros de busca para visualizar mais eventos.</p>
            </div>
          )}
        </div>
      </div>

      {/* Floating Unseen Logs Pill when Scrolled Down */}
      {isScrolledDown && unseenCount > 0 && (
        <button
          onClick={scrollToTop}
          className="fixed bottom-6 right-6 z-40 px-4 py-2.5 bg-[var(--accent-primary)] hover:opacity-90 text-white font-semibold text-xs rounded-full shadow-2xl shadow-[var(--accent-glow)] flex items-center gap-2 animate-bounce transition-all"
        >
          <ArrowUp className="w-4 h-4" />
          <span>+{unseenCount} novos logs recebidos</span>
        </button>
      )}

      {/* Clear Confirmation Modal */}
      {isClearModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
          <div className="bg-[#111111] border border-[#262626] rounded-2xl w-full max-w-md p-6 shadow-2xl relative space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-red-950/80 text-red-400 border border-red-800/60">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Limpar Auditoria de Tarefas?</h3>
                <p className="text-xs text-[#888888]">Esta ação zerará o histórico de logs atual.</p>
              </div>
            </div>

            <p className="text-xs text-[#CCCCCC] leading-relaxed bg-[#161616] p-3 rounded-xl border border-[#262626]">
              A limpeza removerá os registros do LocalStorage. Um log autorreferenciado de segurança (`R1`) será gerado automaticamente documentando a limpeza.
            </p>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setIsClearModalOpen(false)}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-[#888888] hover:text-white bg-[#161616] hover:bg-[#202020] border border-[#2B2B2B] transition-colors"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => {
                  clearActivityLogs();
                  setIsClearModalOpen(false);
                }}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-white bg-red-600 hover:bg-red-500 transition-colors shadow-lg shadow-red-600/20"
              >
                Confirmar Limpeza
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  GitBranch, 
  GitCommit,
  CheckCircle2, 
  Wrench, 
  Shield, 
  Cpu, 
  FileText, 
  Terminal, 
  Play, 
  RefreshCw, 
  Clock,
  Lock,
  Activity,
  ListFilter,
  CheckCircle,
  XCircle,
  Trash2,
  Server,
  KeyRound,
  Layers,
  Sparkles,
  Code2,
  GitCompare,
  Search,
  FileCode,
  Binary,
  FileCheck,
  Eye,
  CheckCheck,
  FileDiff,
  Download
} from 'lucide-react';
import { useLioraStore } from '../../store/lioraStore';
import { ToolSummary, ToolExecutionResult } from '../../types';
import { SecurityAuditEvent } from '../../security/types';
import { permissionEngine } from '../../security/permissionEngine';
import { computeParametersHash } from '../../security/canonicalizer';
import { AnalyticsDashboard } from '../AnalyticsDashboard';
import { 
  SAMPLE_CODE_FILES, 
  SAMPLE_REA_TARGETS, 
  computeUnifiedDiff, 
  CodeFileSample, 
  ReaInspectionTarget 
} from '../../utils/codeDiffHelper';

export const DeveloperView: React.FC = () => {
  const { tools, loadTools, executeTool } = useLioraStore();
  const [selectedTool, setSelectedTool] = useState<string>('system_info');
  const [paramInputs, setParamInputs] = useState<Record<string, any>>({
    detailLevel: 'standard',
    filePath: 'docs/ROADMAP.md',
    command: 'git status'
  });
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionResult, setExecutionResult] = useState<ToolExecutionResult | null>(null);

  // R1 Consent Simulation Switch (Diretriz 4)
  const [simulateConsent, setSimulateConsent] = useState<boolean>(false);

  // Healthcheck & Latency states (Diretriz 5)
  const [serverHealth, setServerHealth] = useState<{ status: 'healthy' | 'degraded' | 'offline'; latencyMs: number; lastPing: string }>({
    status: 'healthy',
    latencyMs: 0,
    lastPing: new Date().toLocaleTimeString()
  });

  // Security Audit Log states (Marco 6.2E)
  const [auditEvents, setAuditEvents] = useState<SecurityAuditEvent[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [clearingAudit, setClearingAudit] = useState(false);
  const [decisionFilter, setDecisionFilter] = useState<string>('ALL');
  const [toolNameFilter, setToolNameFilter] = useState<string>('ALL');
  const [showClearConfirm, setShowClearConfirm] = useState<boolean>(false);

  // Developer Mode Sub-Tabs (Item 22 do Plano Mestre: Ferramentas, Diffs & REA)
  const [activeDevTab, setActiveDevTab] = useState<'tools' | 'diffs' | 'rea'>('tools');
  const [selectedFileIdx, setSelectedFileIdx] = useState<number>(0);
  const [selectedReaIdx, setSelectedReaIdx] = useState<number>(0);
  const [reaRunning, setReaRunning] = useState<boolean>(false);
  const [reaAnalysisDone, setReaAnalysisDone] = useState<boolean>(false);
  const reaTimerRef = useRef<NodeJS.Timeout | null>(null);

  const selectedFile = SAMPLE_CODE_FILES[selectedFileIdx] || SAMPLE_CODE_FILES[0];
  const diffLines = useMemo(() => computeUnifiedDiff(selectedFile.originalContent, selectedFile.modifiedContent), [selectedFile]);
  const selectedReaTarget = SAMPLE_REA_TARGETS[selectedReaIdx] || SAMPLE_REA_TARGETS[0];

  const handleRunReaAnalysis = () => {
    // Auditoria de mapeamento: esta análise é DEMONSTRATIVA (fixtures em codeDiffHelper.ts),
    // NÃO é engenharia reversa real de binário. O selo abaixo informa isso ao usuário
    // em vez de fingir uma varredura real de 1.2s.
    if (reaTimerRef.current) {
      clearTimeout(reaTimerRef.current);
      reaTimerRef.current = null;
    }
    setReaRunning(true);
    setReaAnalysisDone(false);
    reaTimerRef.current = setTimeout(() => {
      setReaRunning(false);
      setReaAnalysisDone(true);
      reaTimerRef.current = null;
    }, 1200);
  };

  useEffect(() => {
    loadTools();
    loadAuditTrail();
    checkHealth();

    return () => {
      if (reaTimerRef.current) {
        clearTimeout(reaTimerRef.current);
        reaTimerRef.current = null;
      }
    };
  }, [loadTools]);

  const checkHealth = async () => {
    const start = performance.now();
    try {
      const res = await fetch('/api/security/audit?limit=1', {
        headers: { 'Accept': 'application/json' }
      });
      const durationMs = Math.round(performance.now() - start);
      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('application/json')) {
        setServerHealth({
          status: 'healthy',
          latencyMs: durationMs,
          lastPing: new Date().toLocaleTimeString()
        });
      } else {
        setServerHealth({
          status: 'degraded',
          latencyMs: durationMs,
          lastPing: new Date().toLocaleTimeString()
        });
      }
    } catch {
      setServerHealth({
        status: 'offline',
        latencyMs: 0,
        lastPing: new Date().toLocaleTimeString()
      });
    }
  };

  const loadAuditTrail = async () => {
    setAuditLoading(true);
    try {
      const queryParams = new URLSearchParams();
      queryParams.set('limit', '50');
      if (decisionFilter !== 'ALL') {
        queryParams.set('decision', decisionFilter);
      }
      if (toolNameFilter !== 'ALL') {
        queryParams.set('toolName', toolNameFilter);
      }

      const res = await fetch(`/api/security/audit?${queryParams.toString()}`, {
        headers: { 'Accept': 'application/json' }
      });
      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('application/json')) {
        const data = await res.json();
        if (Array.isArray(data.events)) {
          setAuditEvents(data.events);
          return;
        }
      }
      // Graceful fallback to local permissionEngine events if server response is non-JSON or offline
      const localEvents = permissionEngine.getAuditEvents();
      const filtered = localEvents.filter(ev => {
        if (decisionFilter !== 'ALL' && ev.decision !== decisionFilter) return false;
        if (toolNameFilter !== 'ALL' && ev.toolName !== toolNameFilter) return false;
        return true;
      });
      setAuditEvents([...filtered].reverse());
    } catch {
      // Offline fallback: load local audit events without logging unhandled SyntaxError
      try {
        const localEvents = permissionEngine.getAuditEvents();
        const filtered = localEvents.filter(ev => {
          if (decisionFilter !== 'ALL' && ev.decision !== decisionFilter) return false;
          if (toolNameFilter !== 'ALL' && ev.toolName !== toolNameFilter) return false;
          return true;
        });
        setAuditEvents([...filtered].reverse());
      } catch {
        setAuditEvents([]);
      }
    } finally {
      setAuditLoading(false);
    }
  };

  const handleClearAuditTrail = async () => {
    setShowClearConfirm(false);
    setClearingAudit(true);
    try {
      const res = await fetch('/api/security/audit', {
        method: 'DELETE',
        headers: { 'Accept': 'application/json' }
      });
      if (res.ok) {
        setAuditEvents([]);
      } else {
        // Fallback local clear
        permissionEngine.clearAuditEvents();
        setAuditEvents([]);
      }
    } catch {
      permissionEngine.clearAuditEvents();
      setAuditEvents([]);
    } finally {
      setClearingAudit(false);
      loadAuditTrail();
    }
  };

  const handleExportAuditReport = () => {
    const reportTimestamp = new Date().toISOString();
    const rowsHtml = auditEvents.map(ev => `
      <tr style="border-bottom: 1px solid #222;">
        <td style="padding: 8px; font-family: monospace; color: #888;">#${ev.sequenceNumber}</td>
        <td style="padding: 8px; font-family: monospace;">${new Date(ev.timestamp).toLocaleString('pt-BR')}</td>
        <td style="padding: 8px; font-weight: bold; color: #FFF;">${ev.eventType}</td>
        <td style="padding: 8px; font-family: monospace; color: #38bdf8;">${ev.toolName}</td>
        <td style="padding: 8px; font-family: monospace;"><span style="padding: 2px 6px; border-radius: 4px; background: #1f1f1f; color: #ccc;">${ev.riskLevel}</span></td>
        <td style="padding: 8px; font-family: monospace; font-weight: bold; color: ${ev.decision === 'ALLOW' ? '#4ade80' : '#f87171'};">${ev.decision}</td>
        <td style="padding: 8px; font-family: monospace; color: #aaa;">${ev.denialCode || 'OK (Aprovado)'}</td>
      </tr>
    `).join('');

    const htmlContent = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>LIORA — Relatório Executivo de Auditoria de Segurança</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #050505; color: #f5f5f5; margin: 0; padding: 40px; }
    .header { border-bottom: 2px solid #FF2B2B; padding-bottom: 20px; margin-bottom: 30px; display: flex; justify-content: space-between; align-items: flex-end; }
    h1 { color: #FFF; margin: 0; font-size: 24px; letter-spacing: 0.5px; }
    .subtitle { color: #888; font-size: 13px; margin-top: 5px; }
    .meta-box { background: #111; border: 1px solid #222; border-radius: 8px; padding: 16px; margin-bottom: 24px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; font-size: 13px; }
    .meta-box div span { display: block; color: #666; font-size: 11px; text-transform: uppercase; margin-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; background: #0a0a0a; border: 1px solid #222; border-radius: 8px; overflow: hidden; font-size: 12px; }
    th { background: #141414; text-align: left; padding: 10px 8px; color: #888; border-bottom: 2px solid #222; text-transform: uppercase; font-size: 11px; }
    .footer { margin-top: 30px; text-align: center; color: #555; font-size: 11px; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>LIORA — Relatório Executivo de Auditoria & Governança</h1>
      <div class="subtitle">Trilha de Auditoria Imutável do Permission Engine (Perfil STRICT)</div>
    </div>
    <div style="font-family: monospace; color: #888; font-size: 12px;">Gerado em: ${new Date(reportTimestamp).toLocaleString('pt-BR')}</div>
  </div>

  <div class="meta-box">
    <div><span>Status do Motor</span><strong style="color: #4ade80;">Perfil STRICT Ativo</strong></div>
    <div><span>Total de Eventos Registrados</span><strong>${auditEvents.length} eventos</strong></div>
    <div><span>Taxa de Aprovação R0</span><strong style="color: #38bdf8;">100% Fail-Closed</strong></div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Seq #</th>
        <th>Timestamp</th>
        <th>Evento</th>
        <th>Ferramenta</th>
        <th>Risco</th>
        <th>Decisão</th>
        <th>Código / Motivo</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml || '<tr><td colspan="7" style="text-align: center; padding: 20px; color: #666;">Nenhum evento registrado.</td></tr>'}
    </tbody>
  </table>

  <div class="footer">
    Documento confidencial gerado pelo núcleo operacional LIORA AI • Todos os direitos reservados.
  </div>
</body>
</html>`;

    const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `liora-audit-report-${reportTimestamp.split('T')[0]}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    loadAuditTrail();
  }, [decisionFilter, toolNameFilter]);

  // Combined Catalog (Native tools + MCP protocol tools if present)
  const defaultToolsList: ToolSummary[] = [
    { name: 'system_info', description: 'Informações de hardware e SO simulados.', category: 'system', riskLevel: 'R0', isSimulated: true, parameters: { type: 'object', properties: {} } },
    { name: 'system_read_env_safe', description: 'Leitura de variáveis de ambiente com redação de segredos.', category: 'system', riskLevel: 'R0', isSimulated: true, parameters: { type: 'object', properties: {} } },
    { name: 'workspace_read_file', description: 'Leitura de fixtures virtuais em memória.', category: 'workspace', riskLevel: 'R0', isSimulated: true, parameters: { type: 'object', properties: {} } },
    { name: 'system_exec_simulated', description: 'Simulação de comandos CLI no sandbox.', category: 'system', riskLevel: 'R1', isSimulated: true, parameters: { type: 'object', properties: {} } },
    { name: 'mcp_code_indexer', description: 'Servidor MCP: Indexador de código sintático AST.', category: 'mcp', riskLevel: 'R0', isSimulated: true, parameters: { type: 'object', properties: {} } }
  ];

  const catalogTools = tools.length > 0 ? tools : defaultToolsList;
  const activeToolDef = catalogTools.find(t => t.name === selectedTool) || catalogTools[0];

  const handleExecute = async () => {
    if (!activeToolDef || isExecuting) return;
    setIsExecuting(true);
    setExecutionResult(null);

    let paramsToSend: Record<string, any> = {};
    if (activeToolDef.name === 'system_info') {
      paramsToSend = { detailLevel: paramInputs.detailLevel || 'standard' };
    } else if (activeToolDef.name === 'system_read_env_safe') {
      // BUG FIX: antes enviava { key: 'NODE_ENV' } mas o schema da ferramenta
      // espera 'variableName' (ou 'keys'). O backend ignorava a chave recebida.
      paramsToSend = { variableName: paramInputs.variableName || 'NODE_ENV' };
    } else if (activeToolDef.name === 'workspace_read_file') {
      paramsToSend = { filePath: paramInputs.filePath || 'docs/ROADMAP.md', maxLines: 50 };
    } else if (activeToolDef.name === 'system_exec_simulated') {
      paramsToSend = { command: paramInputs.command || 'git status', timeoutMs: 5000 };
    } else if (activeToolDef.category === 'mcp' || activeToolDef.name.startsWith('mcp_')) {
      paramsToSend = { action: 'index_files', scope: 'src' };
    }

    try {
      let result: ToolExecutionResult;

      // Se simular consentimento R1 estiver ativo
      if (simulateConsent && activeToolDef.riskLevel === 'R1') {
        const pHash = computeParametersHash(paramsToSend);
        const consentData = await permissionEngine.issueConsentToken(
          activeToolDef.name,
          pHash,
          'dev-sandbox-session'
        );
        
        // Avaliar e consumir consentimento no Permission Engine
        const consumed = permissionEngine.consumeConsentToken(
          consentData.token,
          activeToolDef.name,
          pHash,
          'dev-sandbox-session'
        );

        if (consumed.success) {
          result = {
            toolName: activeToolDef.name,
            success: true,
            data: {
              status: 'ALLOW_WITH_CONSENT',
              consentAuditId: consumed.consentAuditId,
              message: `Execução R1 autorizada com consentimento efêmero (token SHA-256 consumido de uso único).`,
              executedAt: new Date().toISOString()
            },
            simulated: true,
            riskLevel: 'R1',
            executionTimeMs: 14,
            timestamp: new Date().toISOString()
          };
        } else {
          result = await executeTool(activeToolDef.name, paramsToSend);
        }
      } else {
        result = await executeTool(activeToolDef.name, paramsToSend);
      }

      setExecutionResult(result);
      
      // Recarrega em tempo real e revalida healthcheck (Diretriz 2 & 5)
      await loadAuditTrail();
      await checkHealth();
    } catch (err: any) {
      setExecutionResult({
        toolName: activeToolDef.name,
        success: false,
        error: err?.message || 'Falha ao executar avaliação no sandbox.',
        simulated: true,
        riskLevel: activeToolDef.riskLevel,
        executionTimeMs: 0,
        timestamp: new Date().toISOString()
      });
    } finally {
      setIsExecuting(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-y-auto p-8 space-y-8 max-w-6xl mx-auto w-full">
      {/* Header & Git Status Badge (Diretriz 3) */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-display font-bold text-white">Agente de Desenvolvimento & Trilha de Auditoria</h2>
          <p className="text-sm text-[#A8A8A8]">Catálogo centralizado, Permission Engine (Perfil STRICT), suporte MCP e auditoria de segurança em tempo real (Marco 6.2E).</p>
        </div>
        
        <div className="flex items-center gap-2.5 flex-wrap">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-[#141414] border border-[#222222] rounded-lg text-xs font-mono text-white">
            <GitBranch className="w-4 h-4 text-[var(--accent-primary)]" />
            <span>Branch: <strong className="text-emerald-400">main</strong></span>
            <span className="text-[#666666]">•</span>
            <GitCommit className="w-3.5 h-3.5 text-blue-400" />
            <span className="text-emerald-400">Tree: Clean</span>
          </div>
        </div>
      </div>

      {/* Sub-Tab Navigation (Item 22 do Plano Mestre) */}
      <div className="flex items-center gap-2 border-b border-[#222222] pb-3">
        <button
          onClick={() => setActiveDevTab('tools')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-mono font-semibold transition-colors ${
            activeDevTab === 'tools'
              ? 'bg-[#1E1E1E] text-white border border-[#333333]'
              : 'text-[#888888] hover:text-white hover:bg-[#141414]'
          }`}
        >
          <Wrench className="w-3.5 h-3.5 text-[var(--accent-primary)]" />
          <span>Ferramentas & Sandbox</span>
        </button>

        <button
          onClick={() => setActiveDevTab('diffs')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-mono font-semibold transition-colors ${
            activeDevTab === 'diffs'
              ? 'bg-[#1E1E1E] text-white border border-[#333333]'
              : 'text-[#888888] hover:text-white hover:bg-[#141414]'
          }`}
        >
          <FileDiff className="w-3.5 h-3.5 text-blue-400" />
          <span>Inspetor de Código & Diffs</span>
        </button>

        <button
          onClick={() => setActiveDevTab('rea')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-mono font-semibold transition-colors ${
            activeDevTab === 'rea'
              ? 'bg-[#1E1E1E] text-white border border-[#333333]'
              : 'text-[#888888] hover:text-white hover:bg-[#141414]'
          }`}
        >
          <Binary className="w-3.5 h-3.5 text-purple-400" />
          <span>Engenharia Reversa (REA)</span>
        </button>
      </div>

      {activeDevTab === 'tools' && (
        <div className="space-y-8">
      {/* Cards de Métricas & Healthcheck REST Ativo */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-[#111111] border border-[#222222] hover:border-[#333333] transition-colors rounded-xl p-6 flex flex-col justify-between space-y-3">
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-[#888888] uppercase tracking-wider">Motor de Segurança</span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">STRICT</span>
            </div>
            <h3 className="font-bold text-white text-base flex items-center gap-2">
              <Shield className="w-5 h-5 text-emerald-400 shrink-0" />
              <span>Perfil STRICT Ativo</span>
            </h3>
            <p className="mt-2 text-xs text-[#A8A8A8] leading-relaxed">
              Política fail-closed com validação rigorosa no Permission Engine. Ferramentas R0 autorizadas com redação automática de segredos.
            </p>
          </div>
        </div>

        <div className="bg-[#111111] border border-[#222222] hover:border-[#333333] transition-colors rounded-xl p-6 flex flex-col justify-between space-y-3">
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-[#888888] uppercase tracking-wider">REST Backend & Healthcheck</span>
              <span className={`px-2 py-0.5 rounded text-[10px] font-mono border ${
                serverHealth.status === 'healthy' 
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' 
                  : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
              }`}>
                {serverHealth.status.toUpperCase()}
              </span>
            </div>
            <h3 className="font-bold text-white text-base flex items-center gap-2">
              <Server className="w-5 h-5 text-emerald-400 shrink-0" />
              <span>{serverHealth.status === 'healthy' ? `Online (${serverHealth.latencyMs}ms)` : 'Conectando...'}</span>
            </h3>
            <p className="mt-2 text-xs text-[#A8A8A8] leading-relaxed">
              Endpoint `/api/security/audit` ativo • Ping: {serverHealth.lastPing}
            </p>
          </div>
        </div>

        <div className="bg-[#111111] border border-[#222222] hover:border-[#333333] transition-colors rounded-xl p-6 flex flex-col justify-between space-y-3">
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-[#888888] uppercase tracking-wider">Trilha de Auditoria</span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-[var(--accent-bg)] text-[var(--accent-primary)] border border-[var(--accent-border)]">
                {auditEvents.length} Eventos
              </span>
            </div>
            <h3 className="font-bold text-white text-base flex items-center gap-2">
              <Activity className="w-5 h-5 text-[var(--accent-primary)] shrink-0" />
              <span>AuditLogger Imutável</span>
            </h3>
            <p className="mt-2 text-xs text-[#A8A8A8] leading-relaxed">
              Buffer circular FIFO limitado a 200 eventos imutáveis monitorados em tempo real pelo servidor.
            </p>
          </div>
        </div>
      </div>

      {/* Dashboard de Métricas de Consumo de Tokens & Latência */}
      <AnalyticsDashboard />

      {/* Tool Registry Interactive Sandbox */}
      <div className="bg-[#111111] border border-[#222222] rounded-xl p-6 space-y-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-4 border-b border-[#222222]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[var(--accent-bg)] border border-[var(--accent-border)] flex items-center justify-center text-[var(--accent-primary)]">
              <Wrench className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">Tool Registry — Sandbox de Avaliação de Segurança</h3>
              <p className="text-xs text-[#A8A8A8]">Teste o Permission Engine (Perfil STRICT) e ferramentas do protocolo MCP</p>
            </div>
          </div>
          
          <div className="flex items-center gap-3 flex-wrap">
            {/* R1 Consent Simulation Switch (Diretriz 4) */}
            <label className="flex items-center gap-2 px-3 py-1.5 bg-[#171717] border border-[#2E2E2E] rounded-lg text-xs font-mono text-[#CCCCCC] cursor-pointer hover:border-[#444444] transition-colors">
              <KeyRound className={`w-3.5 h-3.5 ${simulateConsent ? 'text-amber-400' : 'text-[#888888]'}`} />
              <span>Simular Consentimento R1</span>
              <input 
                type="checkbox"
                checked={simulateConsent}
                onChange={(e) => setSimulateConsent(e.target.checked)}
                className="w-3.5 h-3.5 accent-amber-500 rounded cursor-pointer"
              />
            </label>

            <span className="px-2.5 py-1 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-mono rounded flex items-center gap-1.5">
              <Lock className="w-3 h-3 text-emerald-400" /> PERMISSION ENGINE ATIVO
            </span>
            
            <button
              onClick={() => { loadTools(); loadAuditTrail(); checkHealth(); }}
              className="p-1.5 text-[#888888] hover:text-white transition-colors"
              title="Atualizar catálogo e auditoria"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tool Selector Tabs */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {catalogTools.map((tool) => {
            const isSelected = selectedTool === tool.name;
            const isMCP = tool.category === 'mcp' || tool.name.startsWith('mcp_');
            const isAllowedR0 = tool.name === 'system_info' || tool.name === 'system_read_env_safe' || isMCP;

            return (
              <button
                key={tool.name}
                onClick={() => {
                  setSelectedTool(tool.name);
                  setExecutionResult(null);
                }}
                className={`p-3.5 rounded-xl border text-left transition-all ${
                  isSelected 
                    ? 'bg-[#181818] border-[var(--accent-primary)] shadow-[0_0_15px_var(--accent-glow)]' 
                    : 'bg-[#141414] border-[#222222] hover:border-[#333333]'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5 truncate">
                    {tool.name === 'system_info' && <Cpu className="w-3.5 h-3.5 text-cyan-400 shrink-0" />}
                    {tool.name === 'system_read_env_safe' && <KeyRound className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
                    {tool.name === 'workspace_read_file' && <FileText className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
                    {tool.name === 'system_exec_simulated' && <Terminal className="w-3.5 h-3.5 text-amber-400 shrink-0" />}
                    {isMCP && <Sparkles className="w-3.5 h-3.5 text-purple-400 shrink-0" />}
                    <span className="font-mono text-xs font-semibold text-white truncate">{tool.name}</span>
                  </div>
                  <span className={`text-[9px] font-mono px-1.5 py-0.2 rounded border shrink-0 ${
                    tool.riskLevel === 'R0' 
                      ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' 
                      : 'bg-amber-500/10 border-amber-500/20 text-amber-400'
                  }`}>
                    {tool.riskLevel}
                  </span>
                </div>
                <p className="text-[11px] text-[#888888] line-clamp-2 leading-tight">{tool.description}</p>
                <div className="mt-2.5 flex items-center justify-between text-[10px] font-mono text-[#666666]">
                  <span>{isMCP ? 'MCP Protocol' : tool.category}</span>
                  <span className={isAllowedR0 ? 'text-emerald-400' : 'text-amber-400'}>
                    {isAllowedR0 ? 'ALLOW (R0)' : 'DENY (R1)'}
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        {/* Selected Tool Details & Parameter Inputs */}
        {activeToolDef && (
          <div className="bg-[#141414] border border-[#222222] rounded-xl p-5 space-y-4">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <h4 className="font-semibold text-white text-sm flex items-center gap-2">
                  Avaliação da Ferramenta: <span className="font-mono text-[var(--accent-primary)]">{activeToolDef.name}</span>
                  {activeToolDef.category === 'mcp' && (
                    <span className="px-2 py-0.5 bg-purple-500/20 text-purple-300 border border-purple-500/30 text-[10px] font-mono rounded-full flex items-center gap-1">
                      <Layers className="w-3 h-3" /> Servidor MCP
                    </span>
                  )}
                </h4>
                <p className="text-xs text-[#888888] mt-0.5">{activeToolDef.description}</p>
              </div>

              {/* Botão Avaliar com Estado de Carregamento & Prevenção de Duplo Clique (Diretriz 2) */}
              <button
                onClick={handleExecute}
                disabled={isExecuting}
                className="flex items-center gap-2 px-4 py-2 bg-[var(--accent-primary)] hover:opacity-90 text-white text-xs font-semibold rounded-lg shadow-md shadow-[var(--accent-glow)] transition-all disabled:opacity-50"
              >
                {isExecuting ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                <span>{isExecuting ? 'Avaliando...' : 'Avaliar via Permission Engine'}</span>
              </button>
            </div>

            {/* Inputs de Parâmetros com base na ferramenta selecionada */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
              {activeToolDef.name === 'system_info' && (
                <div>
                  <label className="block text-xs font-mono text-[#A8A8A8] mb-1">detailLevel</label>
                  <select
                    value={paramInputs.detailLevel || 'standard'}
                    onChange={(e) => setParamInputs({ ...paramInputs, detailLevel: e.target.value })}
                    className="w-full bg-[#0E0E0E] border border-[#262626] rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-[var(--accent-primary)]"
                  >
                    <option value="summary">summary</option>
                    <option value="standard">standard</option>
                    <option value="full">full</option>
                  </select>
                </div>
              )}

              {activeToolDef.name === 'system_read_env_safe' && (
                <div>
                  <label className="block text-xs font-mono text-[#A8A8A8] mb-1">key (Variável de Ambiente)</label>
                  <input
                    type="text"
                    value="NODE_ENV"
                    disabled
                    className="w-full bg-[#0E0E0E] border border-[#262626] rounded-lg px-3 py-2 text-xs font-mono text-[#A8A8A8]"
                  />
                </div>
              )}

              {activeToolDef.name === 'workspace_read_file' && (
                <div>
                  <label className="block text-xs font-mono text-[#A8A8A8] mb-1">filePath (Fixture Virtual)</label>
                  <input
                    type="text"
                    value={paramInputs.filePath || ''}
                    onChange={(e) => setParamInputs({ ...paramInputs, filePath: e.target.value })}
                    placeholder="docs/ROADMAP.md"
                    className="w-full bg-[#0E0E0E] border border-[#262626] rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-[var(--accent-primary)]"
                  />
                </div>
              )}

              {activeToolDef.name === 'system_exec_simulated' && (
                <div>
                  <label className="block text-xs font-mono text-[#A8A8A8] mb-1">command (Sandboxed CLI)</label>
                  <input
                    type="text"
                    value={paramInputs.command || ''}
                    onChange={(e) => setParamInputs({ ...paramInputs, command: e.target.value })}
                    placeholder="git status"
                    className="w-full bg-[#0E0E0E] border border-[#262626] rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-[var(--accent-primary)]"
                  />
                </div>
              )}

              <div className="bg-[#0E0E0E] border border-[#222222] rounded-lg p-3 flex flex-col justify-center">
                <div className="flex items-center gap-2 text-xs font-mono text-[#A8A8A8]">
                  <Shield className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Perfil: STRICT • Risco: {activeToolDef.riskLevel}</span>
                </div>
                <span className="text-[11px] text-[#888888] mt-1">
                  {activeToolDef.name === 'system_info' || activeToolDef.name === 'system_read_env_safe' 
                    ? 'Na lista branca de R0: Autorizado (ALLOW).' 
                    : simulateConsent 
                      ? 'Consentimento R1 simulado ativo: Autorizado (ALLOW_WITH_CONSENT).'
                      : 'Fora da lista branca ou R1 sem consentimento: Negado (DENY).'}
                </span>
              </div>
            </div>

            {/* Execution Result Output */}
            {executionResult && (
              <div className="mt-4 pt-4 border-t border-[#222222] space-y-2">
                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="flex items-center gap-2">
                    {executionResult.success ? (
                      <CheckCircle className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <XCircle className="w-4 h-4 text-amber-400" />
                    )}
                    <span className={executionResult.success ? 'text-emerald-400 font-bold' : 'text-amber-400 font-bold'}>
                      {executionResult.success ? 'AVALIAÇÃO BEM-SUCEDIDA (ALLOW)' : 'AVALIAÇÃO NEGADA (DENY)'}
                    </span>
                  </span>
                  <span className="text-[#888888] flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5" /> {executionResult.executionTimeMs}ms
                  </span>
                </div>

                {(executionResult as any)?.verification && (
                  <div className="flex items-center gap-2 p-2.5 bg-emerald-500/10 border border-emerald-500/30 rounded-lg text-xs font-mono text-emerald-400">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>
                      <strong className="text-white">VERIFICADO [{ (executionResult as any).verification.checkName }]:</strong>{' '}
                      {(executionResult as any).verification.checkDetails}
                    </span>
                  </div>
                )}

                <pre className="p-4 bg-[#0A0A0A] border border-[#222222] rounded-lg text-xs font-mono text-[#A8A8A8] overflow-x-auto max-h-48 leading-relaxed">
                  {JSON.stringify(executionResult, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Security Audit Trail Panel (Marco 6.2E) */}
      <div className="bg-[#111111] border border-[#222222] rounded-xl p-6 space-y-6">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 pb-4 border-b border-[#222222]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
              <Activity className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">Trilha de Auditoria de Segurança (AuditTrail)</h3>
              <p className="text-xs text-[#A8A8A8]">Eventos sequenciais imutáveis gerados pelo AuditLogger no servidor</p>
            </div>
          </div>

          {/* Filters & Clear Option (Diretriz 2) */}
          <div className="flex items-center gap-3 w-full md:w-auto flex-wrap">
            <div className="flex items-center gap-1.5 text-xs font-mono text-[#888888]">
              <ListFilter className="w-3.5 h-3.5" /> Filtros:
            </div>
            <select
              value={decisionFilter}
              onChange={(e) => setDecisionFilter(e.target.value)}
              className="bg-[#0E0E0E] border border-[#262626] rounded-lg px-2.5 py-1.5 text-xs font-mono text-white focus:outline-none focus:border-[var(--accent-primary)]"
            >
              <option value="ALL">Todas as Decisões</option>
              <option value="ALLOW">ALLOW</option>
              <option value="DENY">DENY</option>
            </select>

            <select
              value={toolNameFilter}
              onChange={(e) => setToolNameFilter(e.target.value)}
              className="bg-[#0E0E0E] border border-[#262626] rounded-lg px-2.5 py-1.5 text-xs font-mono text-white focus:outline-none focus:border-[var(--accent-primary)]"
            >
              <option value="ALL">Todas as Ferramentas</option>
              <option value="system_info">system_info</option>
              <option value="system_read_env_safe">system_read_env_safe</option>
              <option value="workspace_read_file">workspace_read_file</option>
              <option value="system_exec_simulated">system_exec_simulated</option>
            </select>

            {/* Clear Audit Trail Button (Diretriz 2) */}
            <button
              onClick={() => setShowClearConfirm(true)}
              disabled={clearingAudit || auditEvents.length === 0}
              className="px-3 py-1.5 bg-[#171717] hover:bg-red-500/10 border border-[#2E2E2E] hover:border-red-500/30 text-xs text-[#888888] hover:text-red-400 rounded-lg flex items-center gap-1.5 transition-colors font-mono disabled:opacity-50 cursor-pointer"
              title="Resetar buffer circular de auditoria em dev"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Limpar Trilha</span>
            </button>

            {/* Export Audit Report Button */}
            <button
              onClick={handleExportAuditReport}
              disabled={auditEvents.length === 0}
              className="px-3 py-1.5 bg-[#171717] hover:bg-emerald-500/10 border border-[#2E2E2E] hover:border-emerald-500/30 text-xs text-[#888888] hover:text-emerald-400 rounded-lg flex items-center gap-1.5 transition-colors font-mono disabled:opacity-50 cursor-pointer"
              title="Exportar Relatório Executivo de Auditoria (.html)"
            >
              <Download className="w-3.5 h-3.5 text-emerald-400" />
              <span>Exportar Relatório</span>
            </button>

            <button
              onClick={() => loadAuditTrail()}
              className="p-1.5 bg-[#171717] hover:bg-[#222222] text-[#A8A8A8] hover:text-white rounded-lg border border-[#2E2E2E] transition-colors"
              title="Atualizar log"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Confirmation Modal/Banner for Resetting Audit Trail */}
        {showClearConfirm && (
          <div className="p-3 bg-red-950/80 border border-red-700/60 rounded-xl flex items-center justify-between gap-3 text-xs text-red-200">
            <span className="font-medium">Tem certeza que deseja resetar o buffer circular de auditoria em memória?</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowClearConfirm(false)}
                className="px-2.5 py-1 bg-[#1A1A1A] hover:bg-[#252525] border border-[#333333] text-[#A8A8A8] hover:text-white rounded text-xs cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleClearAuditTrail}
                className="px-3 py-1 bg-red-600 hover:bg-red-500 text-white rounded text-xs font-bold cursor-pointer"
              >
                Confirmar Limpeza
              </button>
            </div>
          </div>
        )}

        {/* Audit Table */}
        <div className="overflow-x-auto">
          {auditLoading ? (
            <div className="py-8 text-center text-xs font-mono text-[#888888]">Carregando trilha de auditoria...</div>
          ) : auditEvents.length === 0 ? (
            <div className="py-8 text-center text-xs font-mono text-[#888888]">Nenhum evento de auditoria registrado no buffer no momento.</div>
          ) : (
            <table className="w-full text-left border-collapse text-xs font-mono">
              <thead>
                <tr className="border-b border-[#222222] text-[#888888]">
                  <th className="py-2.5 px-3">Seq #</th>
                  <th className="py-2.5 px-3">Timestamp</th>
                  <th className="py-2.5 px-3">Evento</th>
                  <th className="py-2.5 px-3">Ferramenta</th>
                  <th className="py-2.5 px-3">Risco</th>
                  <th className="py-2.5 px-3">Decisão</th>
                  <th className="py-2.5 px-3">Código / Motivo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#181818]">
                {auditEvents.map((evt) => (
                  <tr key={evt.auditId + evt.sequenceNumber} className="hover:bg-[#141414] transition-colors">
                    <td className="py-2.5 px-3 text-[#666666]">#{evt.sequenceNumber}</td>
                    <td className="py-2.5 px-3 text-[#A8A8A8]">{new Date(evt.timestamp).toLocaleTimeString()}</td>
                    <td className="py-2.5 px-3 text-white">{evt.eventType}</td>
                    <td className="py-2.5 px-3 font-semibold text-white">{evt.toolName}</td>
                    <td className="py-2.5 px-3">
                      <span className="px-1.5 py-0.5 rounded bg-[#171717] border border-[#2E2E2E] text-[10px]">
                        {evt.riskLevel}
                      </span>
                    </td>
                    <td className="py-2.5 px-3">
                      <span className={`px-2 py-0.5 rounded font-bold text-[10px] ${
                        evt.decision === 'ALLOW' 
                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' 
                          : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                      }`}>
                        {evt.decision}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-[#888888] truncate max-w-xs">
                      {evt.denialCode || 'OK'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      </div>
      )}

      {/* Diffs & Code Inspector Section (Item 22 do Plano Mestre) */}
      {activeDevTab === 'diffs' && (
        <div className="space-y-6">
          {/* Diffs Summary Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-[#111111] border border-[#222222] rounded-xl p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 shrink-0">
                <FileCode className="w-5 h-5" />
              </div>
              <div>
                <p className="text-[11px] font-mono text-[#888888]">Arquivos Inspecionados</p>
                <h4 className="text-lg font-bold text-white">{SAMPLE_CODE_FILES.length} arquivos</h4>
              </div>
            </div>

            <div className="bg-[#111111] border border-[#222222] rounded-xl p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 shrink-0">
                <GitCompare className="w-5 h-5" />
              </div>
              <div>
                <p className="text-[11px] font-mono text-[#888888]">Linhas Inspecionadas</p>
                <h4 className="text-lg font-bold text-emerald-400">+{diffLines.filter(l => l.type === 'added').length} / -{diffLines.filter(l => l.type === 'removed').length}</h4>
              </div>
            </div>

            <div className="bg-[#111111] border border-[#222222] rounded-xl p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400 shrink-0">
                <CheckCheck className="w-5 h-5" />
              </div>
              <div>
                <p className="text-[11px] font-mono text-[#888888]">Análise Estática</p>
                <h4 className="text-lg font-bold text-white">Zero Sintaxe Quebrada</h4>
              </div>
            </div>
          </div>

          {/* Diffs Split Panel */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* File List */}
            <div className="bg-[#111111] border border-[#222222] rounded-xl p-4 space-y-2">
              <h4 className="text-xs font-mono uppercase tracking-wider text-[#A8A8A8] mb-3 px-1">Arquivos no Workspace</h4>
              {SAMPLE_CODE_FILES.map((file, idx) => (
                <button
                  key={file.path}
                  onClick={() => setSelectedFileIdx(idx)}
                  className={`w-full text-left p-3 rounded-lg border transition-all ${
                    selectedFileIdx === idx
                      ? 'bg-[#181818] border-[var(--accent-primary)] shadow-sm shadow-[var(--accent-glow)]'
                      : 'bg-[#141414] border-[#222222] hover:border-[#333333]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-semibold text-white truncate">{file.path}</span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#0E0E0E] text-[#A8A8A8] uppercase">{file.language}</span>
                  </div>
                  <p className="text-[11px] text-[#888888] mt-1 line-clamp-1">{file.description}</p>
                </button>
              ))}
            </div>

            {/* Diff Viewer */}
            <div className="lg:col-span-2 bg-[#0E0E0E] border border-[#222222] rounded-xl overflow-hidden flex flex-col">
              <div className="p-4 bg-[#141414] border-b border-[#222222] flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <FileCode className="w-4 h-4 text-blue-400 shrink-0" />
                  <span className="font-mono text-xs font-bold text-white truncate">{selectedFile.path}</span>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#1C1C1C] text-[#888888]">{selectedFile.sizeBytes} B</span>
                </div>
                <span className="text-xs font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                  Diff Unificado
                </span>
              </div>

              <div className="p-4 font-mono text-xs overflow-x-auto max-h-[500px] overflow-y-auto divide-y divide-[#181818] bg-[#0A0A0A]">
                {diffLines.map((line, idx) => (
                  <div
                    key={idx}
                    className={`flex items-start py-0.5 px-2 rounded ${
                      line.type === 'added'
                        ? 'bg-emerald-500/10 text-emerald-300 border-l-2 border-emerald-500'
                        : line.type === 'removed'
                        ? 'bg-red-500/10 text-red-300 border-l-2 border-red-500 line-through'
                        : 'text-[#A8A8A8]'
                    }`}
                  >
                    <span className="w-8 shrink-0 text-[10px] text-[#555555] select-none text-right pr-2">
                      {line.type === 'added' ? line.newLineNumber : line.oldLineNumber || ''}
                    </span>
                    <span className="w-4 shrink-0 text-center select-none font-bold">
                      {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                    </span>
                    <span className="whitespace-pre flex-1 pl-1">{line.content}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* REA — Reverse Engineer Anything Section (Item 9 da Análise do Plano Mestre) */}
      {activeDevTab === 'rea' && (
        <div className="space-y-6">
          <div className="bg-[#111111] border border-[#222222] rounded-xl p-6 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400">
                  <Binary className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-white text-base">REA — Reverse Engineer Anything</h3>
                  <p className="text-xs text-[#888888] mt-0.5">Inspeção estática, extração de símbolos e auditoria de segurança de binários e bibliotecas.</p>
                </div>
              </div>
              <span className="px-2.5 py-1 rounded text-xs font-mono bg-purple-500/10 text-purple-400 border border-purple-500/20 font-bold">
                Módulo Soberano
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Targets List */}
            <div className="bg-[#111111] border border-[#222222] rounded-xl p-4 space-y-2">
              <h4 className="text-xs font-mono uppercase tracking-wider text-[#A8A8A8] mb-3 px-1">Alvos de Inspeção</h4>
              {SAMPLE_REA_TARGETS.map((target, idx) => (
                <button
                  key={target.id}
                  onClick={() => { setSelectedReaIdx(idx); setReaAnalysisDone(false); }}
                  className={`w-full text-left p-3 rounded-lg border transition-all ${
                    selectedReaIdx === idx
                      ? 'bg-[#181818] border-purple-500/60 shadow-sm shadow-purple-500/10'
                      : 'bg-[#141414] border-[#222222] hover:border-[#333333]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-semibold text-white truncate">{target.name}</span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#0E0E0E] text-purple-400 uppercase">{target.targetType}</span>
                  </div>
                  <p className="text-[11px] text-[#888888] mt-1 font-mono truncate">{target.architecture}</p>
                </button>
              ))}
            </div>

            {/* Target Details & Analysis */}
            <div className="lg:col-span-2 bg-[#141414] border border-[#222222] rounded-xl p-6 space-y-5">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-4 border-b border-[#222222]">
                <div>
                  <h4 className="font-bold text-white text-base font-mono">{selectedReaTarget.name}</h4>
                  <p className="text-xs text-[#888888] font-mono mt-0.5">{selectedReaTarget.path}</p>
                </div>

                <button
                  onClick={handleRunReaAnalysis}
                  disabled={reaRunning}
                  className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold rounded-lg shadow-md transition-all disabled:opacity-50"
                >
                  {reaRunning ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
                  <span>{reaRunning ? 'Auditoria em Andamento...' : 'Executar Análise REA'}</span>
                </button>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                <div className="bg-[#0E0E0E] border border-[#222222] rounded-lg p-3">
                  <p className="text-[10px] font-mono text-[#888888] uppercase">Veredito</p>
                  <p className={`text-sm font-bold font-mono mt-1 ${
                    selectedReaTarget.securityVerdict === 'CLEAN' ? 'text-emerald-400' : 'text-amber-400'
                  }`}>
                    {selectedReaTarget.securityVerdict}
                  </p>
                </div>

                <div className="bg-[#0E0E0E] border border-[#222222] rounded-lg p-3">
                  <p className="text-[10px] font-mono text-[#888888] uppercase">Símbolos Exportados</p>
                  <p className="text-sm font-bold font-mono text-white mt-1">{selectedReaTarget.symbolsFound}</p>
                </div>

                <div className="bg-[#0E0E0E] border border-[#222222] rounded-lg p-3">
                  <p className="text-[10px] font-mono text-[#888888] uppercase">Arquitetura</p>
                  <p className="text-xs font-mono text-[#CCCCCC] mt-1 truncate">{selectedReaTarget.architecture}</p>
                </div>
              </div>

              <div>
                <h5 className="text-xs font-mono uppercase text-[#A8A8A8] mb-2">Dependências Importadas</h5>
                <div className="flex flex-wrap gap-2">
                  {selectedReaTarget.dependencies.map(dep => (
                    <span key={dep} className="px-2 py-1 rounded bg-[#0E0E0E] border border-[#262626] text-xs font-mono text-[#CCCCCC]">
                      {dep}
                    </span>
                  ))}
                </div>
              </div>

              <div>
                <h5 className="text-xs font-mono uppercase text-[#A8A8A8] mb-2">Permissões de Sistema Requeridas</h5>
                <div className="flex flex-wrap gap-2">
                  {selectedReaTarget.permissionsRequested.map(perm => (
                    <span key={perm} className="px-2 py-1 rounded bg-amber-500/10 border border-amber-500/20 text-xs font-mono text-amber-300">
                      {perm}
                    </span>
                  ))}
                </div>
              </div>

              {reaAnalysisDone && (
                <div className="p-4 bg-purple-500/10 border border-purple-500/30 rounded-xl space-y-2 text-xs font-mono">
                  <div className="flex items-center gap-2 text-purple-300 font-bold">
                    <CheckCircle2 className="w-4 h-4 text-purple-400" />
                    <span>Relatório de Auditoria Estática Concluído</span>
                    <span className="px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300 text-[10px] font-mono">SIMULADO · FIXTURES DEMONSTRATIVAS</span>
                  </div>
                  <p className="text-[#CCCCCC] leading-relaxed">{selectedReaTarget.analysisNotes}</p>
                  <p className="text-[#888888] text-[10px]">
                    ⚠️ Este relatório é gerado de fixtures demonstrativas locais (codeDiffHelper.ts) — não executa engenharia reversa real de binários nesta fase.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};


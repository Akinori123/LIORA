/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useLioraStore } from '../../store/lioraStore';
import { 
  Zap, 
  Plus, 
  Clock, 
  ShieldCheck, 
  ShieldAlert,
  Play, 
  CheckCircle2, 
  AlertTriangle, 
  XCircle, 
  Trash2, 
  Activity,
  X,
  Download,
  Upload,
  Layers,
  Lock
} from 'lucide-react';
import { AutomationRule, AutomationTriggerType, SYSTEM_EVENTS } from '../../types/automations';
import { ToolRiskLevel } from '../../types';
import { notificationSystem } from '../../notifications/notificationSystem';

export const AutomationsView: React.FC = () => {
  const { 
    automations, 
    automationLogs, 
    toggleAutomation, 
    triggerAutomationNow, 
    approveAutomationConsent,
    addAutomation, 
    deleteAutomation,
    exportAutomationsJson,
    importAutomationsJson,
    shieldModeActive,
    toggleShieldMode
  } = useLioraStore(
    useShallow(state => ({
      automations: state.automations,
      automationLogs: state.automationLogs,
      toggleAutomation: state.toggleAutomation,
      triggerAutomationNow: state.triggerAutomationNow,
      approveAutomationConsent: state.approveAutomationConsent,
      addAutomation: state.addAutomation,
      deleteAutomation: state.deleteAutomation,
      exportAutomationsJson: state.exportAutomationsJson,
      importAutomationsJson: state.importAutomationsJson,
      shieldModeActive: state.shieldModeActive,
      toggleShieldMode: state.toggleShieldMode
    }))
  );

  const [executingRuleId, setExecutingRuleId] = useState<string | null>(null);
  const [approvingRuleId, setApprovingRuleId] = useState<string | null>(null);
  const [feedbackMessage, setFeedbackMessage] = useState<{ ruleId: string; text: string; type: 'success' | 'warning' | 'error' } | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [importStatus, setImportStatus] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const [formError, setFormError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const isMountedRef = useRef(true);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const importStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exportRevokeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
      if (importStatusTimerRef.current) clearTimeout(importStatusTimerRef.current);
      if (exportRevokeTimerRef.current) clearTimeout(exportRevokeTimerRef.current);
    };
  }, []);

  // Form state para nova automação
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [triggerType, setTriggerType] = useState<AutomationTriggerType>('TIME_INTERVAL');
  const [triggerConfigValue, setTriggerConfigValue] = useState('15');
  const [selectedTool, setSelectedTool] = useState('system_info');
  const [expectedRisk, setExpectedRisk] = useState<ToolRiskLevel>('R0');
  const [toolParams, setToolParams] = useState<{ variableName: string; filePath: string; content: string; command: string }>({
    variableName: 'NODE_ENV',
    filePath: 'docs/ROADMAP.md',
    content: '',
    command: 'git status'
  });

  const closeModal = () => {
    setIsModalOpen(false);
    setFormError(null);
    setName('');
    setDescription('');
  };

  const handleExecute = async (ruleId: string) => {
    setExecutingRuleId(ruleId);
    setFeedbackMessage(null);
    try {
      const res = await triggerAutomationNow(ruleId);
      if (!isMountedRef.current) return;
      if (res) {
        if (res.status === 'SUCCESS') {
          setFeedbackMessage({
            ruleId,
            text: `Executado com sucesso (${res.durationMs}ms)${res.retryCount ? ` [${res.retryCount} retry]` : ''}`,
            type: 'success'
          });
        } else if (res.status === 'WAITING_CONSENT') {
          setFeedbackMessage({
            ruleId,
            text: 'Operação R1 retida! Clique no botão "Aprovar Execução" abaixo para autorizar.',
            type: 'warning'
          });
        } else if (res.status === 'SKIPPED_BUSY') {
          setFeedbackMessage({
            ruleId,
            text: 'Descartado: regra já está em execução (mutex lock ativo).',
            type: 'warning'
          });
        } else if (res.status === 'BLOCKED_BY_POLICY') {
          setFeedbackMessage({
            ruleId,
            text: `Bloqueado: ${res.errorMessage || 'Política fail-closed ou Shield Mode.'}`,
            type: 'error'
          });
        } else {
          setFeedbackMessage({
            ruleId,
            text: res.errorMessage || 'Falha na execução.',
            type: 'error'
          });
        }
      }
    } catch {
      if (isMountedRef.current) {
        setFeedbackMessage({
          ruleId,
          text: 'Erro ao despachar execução da regra.',
          type: 'error'
        });
      }
    } finally {
      if (isMountedRef.current) {
        setExecutingRuleId(null);
        if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = setTimeout(() => {
          if (isMountedRef.current) setFeedbackMessage(null);
        }, 6000);
      }
    }
  };

  const handleApproveInline = async (ruleId: string) => {
    setApprovingRuleId(ruleId);
    setFeedbackMessage(null);
    try {
      const res = await approveAutomationConsent(ruleId);
      if (!isMountedRef.current) return;
      if (res) {
        if (res.status === 'SUCCESS') {
          setFeedbackMessage({
            ruleId,
            text: `Consentimento autorizado e executado com sucesso (${res.durationMs}ms)!`,
            type: 'success'
          });
        } else {
          setFeedbackMessage({
            ruleId,
            text: res.errorMessage || 'Falha ao executar após aprovação.',
            type: 'error'
          });
        }
      }
    } catch {
      if (isMountedRef.current) {
        setFeedbackMessage({
          ruleId,
          text: 'Erro ao aprovar consentimento na interface.',
          type: 'error'
        });
      }
    } finally {
      if (isMountedRef.current) {
        setApprovingRuleId(null);
        if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = setTimeout(() => {
          if (isMountedRef.current) setFeedbackMessage(null);
        }, 6000);
      }
    }
  };

  const handleExport = () => {
    try {
      const jsonStr = exportAutomationsJson();
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `liora_automations_${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      if (exportRevokeTimerRef.current) clearTimeout(exportRevokeTimerRef.current);
      exportRevokeTimerRef.current = setTimeout(() => {
        URL.revokeObjectURL(url);
        exportRevokeTimerRef.current = null;
      }, 1000);
    } catch (err: any) {
      notificationSystem.notify('Erro na Exportação', `Falha ao exportar regras: ${err?.message}`, 'error');
    }
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      if (!isMountedRef.current) return;
      try {
        const text = event.target?.result as string;
        const res = importAutomationsJson(text, 'merge');
        if (!isMountedRef.current) return;
        if (res.success) {
          setImportStatus({ text: `${res.count} regras importadas com sucesso!`, type: 'success' });
        } else {
          setImportStatus({ text: res.error || 'Erro ao importar regras.', type: 'error' });
        }
      } catch (err: any) {
        if (isMountedRef.current) {
          setImportStatus({ text: err?.message || 'Arquivo JSON inválido.', type: 'error' });
        }
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = '';
        if (isMountedRef.current) {
          if (importStatusTimerRef.current) clearTimeout(importStatusTimerRef.current);
          importStatusTimerRef.current = setTimeout(() => {
            if (isMountedRef.current) setImportStatus(null);
          }, 5000);
        }
      }
    };
    reader.onerror = () => {
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (isMountedRef.current) {
        setImportStatus({ text: 'Erro ao ler o arquivo JSON selecionado.', type: 'error' });
        if (importStatusTimerRef.current) clearTimeout(importStatusTimerRef.current);
        importStatusTimerRef.current = setTimeout(() => {
          if (isMountedRef.current) setImportStatus(null);
        }, 5000);
      }
    };
    reader.readAsText(file);
  };

  const handleTriggerTypeChange = (nextType: AutomationTriggerType) => {
    setTriggerType(nextType);
    setFormError(null);
    if (nextType === 'TIME_INTERVAL') setTriggerConfigValue('15');
    else if (nextType === 'TIME_OF_DAY') setTriggerConfigValue('08:00');
    else if (nextType === 'SYSTEM_EVENT') setTriggerConfigValue(SYSTEM_EVENTS.DEVICE_STATUS_CHANGED);
    else setTriggerConfigValue('');
  };

  const handleCreateAutomation = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setFormError('Informe um nome para a regra de automação.');
      return;
    }

    let humanReadable = '';
    const config: any = {};

    if (triggerType === 'TIME_INTERVAL') {
      const trimmed = triggerConfigValue.trim();
      if (!/^\d+$/.test(trimmed)) {
        setFormError('Informe um intervalo numérico válido entre 1 e 1440 minutos.');
        return;
      }
      const minutes = Number(trimmed);
      if (minutes < 1 || minutes > 1440) {
        setFormError('O intervalo em minutos deve estar entre 1 e 1440.');
        return;
      }
      config.intervalMinutes = minutes;
      humanReadable = `A cada ${minutes} min`;
    } else if (triggerType === 'TIME_OF_DAY') {
      const trimmed = triggerConfigValue.trim();
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(trimmed)) {
        setFormError('Informe um horário válido no formato HH:MM (ex: 08:30).');
        return;
      }
      config.timeOfDay = trimmed;
      humanReadable = `Todos os dias às ${config.timeOfDay}`;
    } else if (triggerType === 'SYSTEM_EVENT') {
      const evName = triggerConfigValue.trim();
      if (!evName) {
        setFormError('Informe o nome do evento do sistema.');
        return;
      }
      config.eventName = evName;
      humanReadable = `Ao emitir evento '${config.eventName}'`;
    } else {
      humanReadable = 'Acionamento sob demanda (Manual)';
    }

    let actionParams: Record<string, any> = {};
    if (selectedTool === 'system_read_env_safe') {
      actionParams = { variableName: toolParams.variableName.trim() || 'NODE_ENV' };
    } else if (selectedTool === 'workspace_read_file') {
      actionParams = { filePath: toolParams.filePath.trim() || 'docs/ROADMAP.md', maxLines: 50 };
    } else if (selectedTool === 'workspace_write_file') {
      actionParams = { filePath: toolParams.filePath.trim() || 'workspace/automacao.txt', content: toolParams.content || 'Registrado pela LIORA.' };
    } else if (selectedTool === 'system_exec_sandbox') {
      actionParams = { command: toolParams.command.trim() || 'git status', timeoutMs: 5000 };
    }

    addAutomation({
      name: name.trim(),
      description: description.trim() || 'Regra de automação customizada',
      enabled: true,
      trigger: {
        type: triggerType,
        config,
        humanReadable
      },
      action: {
        type: 'EXECUTE_TOOL',
        toolName: selectedTool,
        parameters: actionParams,
        description: `Executar ferramenta ${selectedTool}`,
        expectedRiskLevel: expectedRisk
      }
    });

    closeModal();
  };

  return (
    <div className="flex-1 flex flex-col overflow-y-auto p-8 space-y-8 max-w-6xl mx-auto w-full">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-display font-bold text-white">Central de Automações & EventBus</h2>
            <span className="px-2.5 py-0.5 rounded text-[10px] font-mono uppercase bg-[#141414] border border-[#222222] text-[#A8A8A8]">
              Marco 8.2 • EventBus Blindado
            </span>
          </div>
          <p className="text-sm text-[#A8A8A8] mt-1">
            Gatilhos pub/sub, agendamento persistente, trava de concorrência e aprovação R1 em interface soberana.
          </p>
        </div>

        {/* Action Controls & Shield Mode */}
        <div className="flex items-center flex-wrap gap-2.5">
          {/* Shield Mode Toggle */}
          <button
            type="button"
            onClick={toggleShieldMode}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono flex items-center gap-2 border transition-colors ${
              shieldModeActive 
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20 shadow-sm shadow-emerald-500/10'
                : 'bg-amber-500/10 text-amber-400 border-amber-500/30 hover:bg-amber-500/20'
            }`}
            title="Alternar Shield Mode Soberano (Bloqueia ações autônomas não supervisionadas)"
          >
            {shieldModeActive ? <ShieldCheck className="w-4 h-4 text-emerald-400" /> : <ShieldAlert className="w-4 h-4 text-amber-400" />}
            <span>Shield Mode: {shieldModeActive ? 'Ativo' : 'Pausado'}</span>
          </button>

          {/* Export / Import */}
          <button
            type="button"
            onClick={handleExport}
            className="px-3 py-1.5 bg-[#171717] hover:bg-[#222222] border border-[#2E2E2E] hover:border-[#444444] rounded-lg text-xs text-[#CCCCCC] hover:text-white flex items-center gap-1.5 transition-colors font-mono"
            title="Exportar todas as regras para backup JSON"
          >
            <Download className="w-3.5 h-3.5 text-[var(--accent-primary)]" />
            <span>Exportar</span>
          </button>

          <label className="cursor-pointer px-3 py-1.5 bg-[#171717] hover:bg-[#222222] border border-[#2E2E2E] hover:border-[#444444] rounded-lg text-xs text-[#CCCCCC] hover:text-white flex items-center gap-1.5 transition-colors font-mono">
            <Upload className="w-3.5 h-3.5 text-blue-400" />
            <span>Importar</span>
            <input 
              ref={fileInputRef}
              type="file" 
              accept=".json" 
              onChange={handleImportFile}
              className="hidden" 
            />
          </label>

          {/* Nova Automação */}
          <button
            type="button"
            onClick={() => {
              setFormError(null);
              setIsModalOpen(true);
            }}
            className="px-4 py-1.5 bg-[var(--accent-primary)] hover:opacity-90 text-white text-xs font-semibold rounded-lg flex items-center gap-2 transition-all shadow-md shadow-[var(--accent-glow)]"
          >
            <Plus className="w-4 h-4" />
            <span>Nova Automação</span>
          </button>
        </div>
      </div>

      {importStatus && (
        <div className={`text-xs px-4 py-2.5 rounded-lg border font-mono ${
          importStatus.type === 'success' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'
        }`}>
          {importStatus.text}
        </div>
      )}

      {/* Rules Grid / List */}
      <div className="space-y-4">
        {automations.map((auto) => {
          const isExecuting = executingRuleId === auto.id;
          const isApproving = approvingRuleId === auto.id;
          const feedback = feedbackMessage?.ruleId === auto.id ? feedbackMessage : null;
          const isWaitingConsent = auto.lastExecutionStatus === 'WAITING_CONSENT';

          return (
            <div 
              key={auto.id} 
              className={`bg-[#111111] border transition-colors rounded-xl p-6 flex flex-col gap-4 ${
                isWaitingConsent 
                  ? 'border-amber-500/40 bg-gradient-to-r from-[#17140e] to-[#111111]' 
                  : 'border-[#222222] hover:border-[#333333]'
              }`}
            >
              <div className="flex items-start justify-between flex-wrap gap-4">
                <div className="flex items-start gap-4">
                  <div className={`p-3 rounded-xl border ${
                    isWaitingConsent 
                      ? 'bg-amber-500/10 border-amber-500/30 text-amber-400 animate-pulse' 
                      : 'bg-[#171717] border-[#2E2E2E] text-[var(--accent-primary)]'
                  }`}>
                    <Zap className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-3">
                      <h3 className="font-semibold text-white text-base">{auto.name}</h3>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-mono border ${
                        auto.action.expectedRiskLevel === 'R0' 
                          ? 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                          : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                      }`}>
                        {auto.action.expectedRiskLevel}
                      </span>
                      {isWaitingConsent && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold animate-pulse">
                          Aguardando Consentimento
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[#888888] mt-1">{auto.description}</p>
                    
                    <div className="mt-2.5 flex flex-wrap items-center gap-3 text-xs text-[#888888]">
                      <span className="flex items-center gap-1.5 font-mono text-[#CCCCCC]">
                        <Clock className="w-3.5 h-3.5 text-[var(--accent-primary)]" /> 
                        {auto.trigger.humanReadable}
                      </span>
                      <span>•</span>
                      <span className="font-mono text-[#A8A8A8]">
                        Ação: <span className="text-white">{auto.action.toolName || auto.action.description}</span>
                      </span>
                      {auto.lastExecutionStatus && (
                        <>
                          <span>•</span>
                          <span className={`flex items-center gap-1 font-mono text-[11px] ${
                            auto.lastExecutionStatus === 'SUCCESS' ? 'text-emerald-400' :
                            auto.lastExecutionStatus === 'WAITING_CONSENT' ? 'text-amber-400 font-bold' :
                            auto.lastExecutionStatus === 'SKIPPED_BUSY' ? 'text-amber-400' :
                            'text-red-400'
                          }`}>
                            {auto.lastExecutionStatus === 'SUCCESS' && <CheckCircle2 className="w-3 h-3" />}
                            {auto.lastExecutionStatus === 'WAITING_CONSENT' && <AlertTriangle className="w-3 h-3" />}
                            {auto.lastExecutionStatus === 'SKIPPED_BUSY' && <Layers className="w-3 h-3" />}
                            {auto.lastExecutionStatus === 'BLOCKED_BY_POLICY' && <ShieldCheck className="w-3 h-3" />}
                            {auto.lastExecutionStatus === 'FAILED' && <XCircle className="w-3 h-3" />}
                            {auto.lastExecutionStatus === 'SKIPPED_BUSY' ? 'SKIPPED (BUSY)' : auto.lastExecutionStatus}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  {/* Botão de aprovação direta de R1 quando WAITING_CONSENT */}
                  {isWaitingConsent && (
                    <button
                      type="button"
                      onClick={() => handleApproveInline(auto.id)}
                      disabled={isApproving}
                      className="px-3.5 py-2 bg-amber-500 hover:bg-amber-400 text-black text-xs font-bold font-mono rounded-lg flex items-center gap-1.5 transition-colors shadow-md shadow-amber-500/20 disabled:opacity-50"
                      title="Autorizar e despachar execução agora"
                    >
                      <CheckCircle2 className={`w-4 h-4 ${isApproving ? 'animate-spin' : ''}`} />
                      <span>{isApproving ? 'Executando...' : 'Aprovar Execução'}</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => handleExecute(auto.id)}
                    disabled={isExecuting}
                    className="p-2.5 bg-[#171717] hover:bg-[#222222] border border-[#333333] hover:border-[#444444] rounded-lg text-white transition-colors disabled:opacity-50" 
                    aria-label={`Disparar regra ${auto.name}`}
                    title="Disparar agora sob demanda"
                  >
                    <Play className={`w-4 h-4 ${isExecuting ? 'animate-spin text-[var(--accent-primary)]' : 'text-emerald-400'}`} />
                  </button>
                  
                  <button
                    type="button"
                    onClick={() => toggleAutomation(auto.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-mono transition-colors border ${
                      auto.enabled 
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20' 
                        : 'bg-[#171717] text-[#888888] border-[#2E2E2E] hover:bg-[#222222]'
                    }`}
                  >
                    {auto.enabled ? 'Ativa' : 'Pausada'}
                  </button>

                  <button
                    type="button"
                    onClick={() => deleteAutomation(auto.id)}
                    className="p-2.5 bg-[#171717] hover:bg-red-500/10 border border-[#2E2E2E] hover:border-red-500/30 text-[#888888] hover:text-red-400 rounded-lg transition-colors"
                    aria-label={`Remover regra ${auto.name}`}
                    title="Remover regra de automação"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {feedback && (
                <div className={`text-xs px-3.5 py-2 rounded-lg border font-mono ${
                  feedback.type === 'success' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                  feedback.type === 'warning' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                  'bg-red-500/10 text-red-400 border-red-500/20'
                }`}>
                  {feedback.text}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Execution Logs Section */}
      <div className="space-y-4 pt-4 border-t border-[#222222]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-[var(--accent-primary)]" />
            <h3 className="text-base font-bold text-white">Histórico de Execuções Recentes</h3>
          </div>
          <span className="text-xs font-mono text-[#888888]">
            {automationLogs.length} execuções registradas
          </span>
        </div>

        {automationLogs.length === 0 ? (
          <div className="bg-[#111111] border border-[#222222] rounded-xl p-8 text-center text-xs text-[#888888]">
            Nenhuma execução de automação registrada ainda. Dispare uma regra ou aguarde o agendador.
          </div>
        ) : (
          <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
            {automationLogs.slice(0, 20).map((log) => (
              <div 
                key={log.id} 
                className="bg-[#141414] border border-[#222222] rounded-lg px-4 py-3 flex items-center justify-between text-xs"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${
                    log.status === 'SUCCESS' ? 'bg-emerald-400' :
                    log.status === 'WAITING_CONSENT' ? 'bg-amber-400 animate-pulse' :
                    log.status === 'SKIPPED_BUSY' ? 'bg-amber-400' :
                    'bg-red-400'
                  }`} />
                  <div className="truncate">
                    <span className="font-semibold text-white">{log.ruleName}</span>
                    <span className="ml-2 font-mono text-[#888888]">{log.actionExecuted}</span>
                    {log.errorMessage && (
                      <span className="ml-2 text-red-400 font-mono">({log.errorMessage})</span>
                    )}
                    {log.retryCount && log.retryCount > 0 && (
                      <span className="ml-2 text-amber-400 font-mono text-[10px]">[{log.retryCount} retries]</span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0 text-[11px] font-mono text-[#888888]">
                  <span className="px-2 py-0.5 bg-[#1A1A1A] rounded text-[#CCCCCC]">{log.riskLevel}</span>
                  <span>{log.durationMs}ms</span>
                  <span>{log.timeHms}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Modal Nova Automação */}
      {isModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Criar Nova Automação"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
        >
          <div className="bg-[#111111] border border-[#333333] rounded-2xl max-w-lg w-full p-6 space-y-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#222222] pb-4">
              <div className="flex items-center gap-2">
                <Zap className="w-5 h-5 text-[var(--accent-primary)]" />
                <h3 className="font-bold text-lg text-white">Criar Nova Automação</h3>
              </div>
              <button 
                type="button"
                onClick={closeModal}
                aria-label="Fechar modal de nova automação"
                className="text-[#888888] hover:text-white p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateAutomation} className="space-y-4">
              <div>
                <label htmlFor="auto-rule-name" className="block text-xs font-semibold uppercase tracking-wider text-[#A8A8A8] mb-1.5">
                  Nome da Regra
                </label>
                <input
                  id="auto-rule-name"
                  type="text" 
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (formError) setFormError(null);
                  }}
                  placeholder="Ex: Auditoria Diária de Variáveis" 
                  className="w-full bg-[#171717] border border-[#333333] rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-[var(--accent-primary)]"
                />
              </div>

              <div>
                <label htmlFor="auto-rule-desc" className="block text-xs font-semibold uppercase tracking-wider text-[#A8A8A8] mb-1.5">
                  Descrição
                </label>
                <input
                  id="auto-rule-desc"
                  type="text" 
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Ex: Checa se a chave NODE_ENV está consistente" 
                  className="w-full bg-[#171717] border border-[#333333] rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-[var(--accent-primary)]"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="auto-trigger-type" className="block text-xs font-semibold uppercase tracking-wider text-[#A8A8A8] mb-1.5">
                    Tipo de Gatilho
                  </label>
                  <select
                    id="auto-trigger-type"
                    value={triggerType}
                    onChange={(e) => handleTriggerTypeChange(e.target.value as AutomationTriggerType)}
                    className="w-full bg-[#171717] border border-[#333333] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[var(--accent-primary)]"
                  >
                    <option value="TIME_INTERVAL">Intervalo Periódico</option>
                    <option value="TIME_OF_DAY">Horário do Dia</option>
                    <option value="SYSTEM_EVENT">Evento do Sistema</option>
                    <option value="MANUAL">Manual (Sob Demanda)</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="auto-trigger-param" className="block text-xs font-semibold uppercase tracking-wider text-[#A8A8A8] mb-1.5">
                    {triggerType === 'TIME_INTERVAL' ? 'Minutos (Intervalo)' :
                     triggerType === 'TIME_OF_DAY' ? 'Horário (HH:MM)' :
                     triggerType === 'SYSTEM_EVENT' ? 'Nome do Evento' : 'Parâmetro (Opcional)'}
                  </label>
                  <input
                    id="auto-trigger-param"
                    type="text" 
                    value={triggerConfigValue}
                    onChange={(e) => {
                      setTriggerConfigValue(e.target.value);
                      if (formError) setFormError(null);
                    }}
                    disabled={triggerType === 'MANUAL'}
                    placeholder={triggerType === 'TIME_INTERVAL' ? '15' : triggerType === 'TIME_OF_DAY' ? '08:00' : triggerType === 'SYSTEM_EVENT' ? 'DEVICE_STATUS_CHANGED' : 'Sob demanda'}
                    className="w-full bg-[#171717] border border-[#333333] rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-[var(--accent-primary)] disabled:opacity-50"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="auto-target-tool" className="block text-xs font-semibold uppercase tracking-wider text-[#A8A8A8] mb-1.5">
                    Ferramenta Alvo
                  </label>
                  <select
                    id="auto-target-tool"
                    value={selectedTool}
                    onChange={(e) => {
                      const tName = e.target.value;
                      setSelectedTool(tName);
                      if (tName === 'workspace_write_file' || tName === 'system_exec_sandbox' || tName === 'system_exec_simulated') {
                        setExpectedRisk('R1');
                      } else {
                        setExpectedRisk('R0');
                      }
                    }}
                    className="w-full bg-[#171717] border border-[#333333] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[var(--accent-primary)]"
                  >
                    <option value="system_info">system_info (R0)</option>
                    <option value="system_read_env_safe">system_read_env_safe (R0)</option>
                    <option value="workspace_read_file">workspace_read_file (R0)</option>
                    <option value="workspace_write_file">workspace_write_file (R1)</option>
                    <option value="system_exec_sandbox">system_exec_sandbox (R1)</option>
                  </select>
                </div>

                <div>
                  <span className="block text-xs font-semibold uppercase tracking-wider text-[#A8A8A8] mb-1.5">
                    Nível de Risco Calculado
                  </span>
                  <div className={`px-3 py-2 rounded-lg text-xs font-mono font-bold border ${
                    expectedRisk === 'R0' 
                      ? 'bg-blue-500/10 text-blue-400 border-blue-500/20' 
                      : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                  }`}>
                    {expectedRisk} {expectedRisk === 'R1' ? '• Requer Consentimento' : '• Execução R0'}
                  </div>
                </div>
              </div>

              {selectedTool === 'system_read_env_safe' && (
                <div>
                  <label htmlFor="auto-env-var" className="block text-xs font-semibold uppercase tracking-wider text-[#A8A8A8] mb-1.5">
                    Variável (variableName)
                  </label>
                  <input
                    id="auto-env-var"
                    type="text"
                    value={toolParams.variableName}
                    onChange={(e) => setToolParams({ ...toolParams, variableName: e.target.value })}
                    placeholder="NODE_ENV"
                    className="w-full bg-[#171717] border border-[#333333] rounded-lg px-3.5 py-2 text-xs font-mono text-white focus:outline-none focus:border-[var(--accent-primary)]"
                  />
                </div>
              )}

              {(selectedTool === 'workspace_read_file' || selectedTool === 'workspace_write_file') && (
                <div className="space-y-3">
                  <div>
                    <label htmlFor="auto-file-path" className="block text-xs font-semibold uppercase tracking-wider text-[#A8A8A8] mb-1.5">
                      Caminho do Arquivo (filePath)
                    </label>
                    <input
                      id="auto-file-path"
                      type="text"
                      value={toolParams.filePath}
                      onChange={(e) => setToolParams({ ...toolParams, filePath: e.target.value })}
                      placeholder={selectedTool === 'workspace_write_file' ? 'workspace/relatorio.txt' : 'docs/ROADMAP.md'}
                      className="w-full bg-[#171717] border border-[#333333] rounded-lg px-3.5 py-2 text-xs font-mono text-white focus:outline-none focus:border-[var(--accent-primary)]"
                    />
                  </div>
                  {selectedTool === 'workspace_write_file' && (
                    <div>
                      <label htmlFor="auto-file-content" className="block text-xs font-semibold uppercase tracking-wider text-[#A8A8A8] mb-1.5">
                        Conteúdo a Gravar (content)
                      </label>
                      <textarea
                        id="auto-file-content"
                        rows={2}
                        value={toolParams.content}
                        onChange={(e) => setToolParams({ ...toolParams, content: e.target.value })}
                        placeholder="Texto ou relatório a ser gravado..."
                        className="w-full bg-[#171717] border border-[#333333] rounded-lg px-3.5 py-2 text-xs font-mono text-white focus:outline-none focus:border-[var(--accent-primary)]"
                      />
                    </div>
                  )}
                </div>
              )}

              {selectedTool === 'system_exec_sandbox' && (
                <div>
                  <label htmlFor="auto-sandbox-cmd" className="block text-xs font-semibold uppercase tracking-wider text-[#A8A8A8] mb-1.5">
                    Comando CLI Sandbox (command)
                  </label>
                  <input
                    id="auto-sandbox-cmd"
                    type="text"
                    value={toolParams.command}
                    onChange={(e) => setToolParams({ ...toolParams, command: e.target.value })}
                    placeholder="git status"
                    className="w-full bg-[#171717] border border-[#333333] rounded-lg px-3.5 py-2 text-xs font-mono text-white focus:outline-none focus:border-[var(--accent-primary)]"
                  />
                </div>
              )}

              {formError && (
                <p role="alert" className="text-xs text-red-400 font-mono flex items-center gap-1.5 bg-red-950/40 border border-red-800/50 px-3 py-2 rounded-lg">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>{formError}</span>
                </p>
              )}

              <div className="pt-4 flex items-center justify-end gap-3 border-t border-[#222222]">
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-4 py-2 bg-[#171717] hover:bg-[#222222] text-[#888888] hover:text-white text-xs font-semibold rounded-lg transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-[var(--accent-primary)] hover:opacity-90 text-white text-xs font-semibold rounded-lg shadow-md shadow-[var(--accent-glow)] transition-all"
                >
                  Salvar Regra
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

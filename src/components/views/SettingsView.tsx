/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useLioraStore } from '../../store/lioraStore';
import { Settings as SettingsIcon, Shield, Volume2, Cpu, Download, RefreshCw, Palette, Globe, Bell, CheckCircle2, FolderOpen, Play, Key, Check, Database, Upload } from 'lucide-react';
import { LogVerbosity, TTSModelChoice } from '../../types/settings';
import { eventBus } from '../../utils/eventBus';
import { THEME_PALETTES } from '../../utils/themeColors';
import { storageAdapter } from '../../services/storageAdapter';
import { isTauriEnvironment } from '../../security/localBridge';

import { speechService } from '../../services/speechService';
import { integrationsVault } from '../../services/integrationsVault';
import { VaultManagerPanel } from '../security/VaultManagerPanel';

export const SettingsView: React.FC = () => {
  const {
    settings,
    updateSettings,
    resetSettingsToDefault,
    syncServicesFromEnv,
    reloadAllFromStorage
  } = useLioraStore(
    useShallow(state => ({
      settings: state.settings,
      updateSettings: state.updateSettings,
      resetSettingsToDefault: state.resetSettingsToDefault,
      syncServicesFromEnv: state.syncServicesFromEnv,
      reloadAllFromStorage: state.reloadAllFromStorage
    }))
  );
  const [successToast, setSuccessToast] = React.useState<string | null>(null);
  const [isTestingVoice, setIsTestingVoice] = React.useState(false);
  const [geminiKeyInput, setGeminiKeyInput] = React.useState<string>(() => {
    return integrationsVault.getApiKeyByProvider('gemini') || 
           (typeof localStorage !== 'undefined' ? localStorage.getItem('GEMINI_API_KEY') || '' : '');
  });
  const [isSavingKey, setIsSavingKey] = React.useState(false);

  // CORREÇÃO (bug de falsa promessa): botão de IMPORTAR backup — havia export
  // mas nunca restore. Lê o JSON exportado e grava registro a registro via
  // restoreFromBackup (Desktop SQLite ou localStorage) e sincroniza o Zustand store.
  const handleImportBackup = async () => {
    try {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const json = await file.text();
          const result = await storageAdapter.restoreFromBackup(json);
          if (!isMountedRef.current) return;
          if (result.success) {
            await reloadAllFromStorage();
            if (!isMountedRef.current) return;
            const total = Object.values(result.restored).reduce((a: number, b: any) => a + (Number(b) || 0), 0);
            notifyChange(`Backup restaurado e sincronizado: ${total} registro(s) importados com sucesso.`);
          } else {
            notifyChange(`Falha ao restaurar backup: ${result.error || 'erro desconhecido'}`);
          }
        } catch (err: any) {
          if (isMountedRef.current) {
            notifyChange(`Arquivo inválido: ${err?.message || 'não é um backup LIORA válido'}`);
          }
        }
      };
      input.click();
    } catch (err: any) {
      if (isMountedRef.current) {
        notifyChange(`Falha ao abrir seletor de arquivo: ${err?.message || 'erro'}`);
      }
    }
  };

  const [openRouterKeyInput, setOpenRouterKeyInput] = React.useState<string>(() => {
    return integrationsVault.getApiKeyByProvider('openrouter') || 
           (typeof localStorage !== 'undefined' ? localStorage.getItem('OPENROUTER_API_KEY') || '' : '');
  });
  const [isSavingOpenRouterKey, setIsSavingOpenRouterKey] = React.useState(false);

  const [isEditingWorkspace, setIsEditingWorkspace] = React.useState(false);
  const [workspaceInput, setWorkspaceInput] = React.useState('');
  const [timeoutDraft, setTimeoutDraft] = React.useState<string>(() => String(settings.requestTimeoutMs));

  React.useEffect(() => {
    setTimeoutDraft(String(settings.requestTimeoutMs));
  }, [settings.requestTimeoutMs]);

  const toastTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const exportRevokeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = React.useRef(true);
  const testAudioRef = React.useRef<HTMLAudioElement | null>(null);

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      if (exportRevokeTimerRef.current) clearTimeout(exportRevokeTimerRef.current);
      if (testAudioRef.current) {
        try {
          testAudioRef.current.pause();
          testAudioRef.current.src = '';
        } catch {}
        testAudioRef.current = null;
      }
    };
  }, []);

  const notifyChange = (msg: string) => {
    if (!isMountedRef.current) return;
    setSuccessToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      if (isMountedRef.current) setSuccessToast(null);
    }, 3000);
  };

  const activeGeminiKey = integrationsVault.getApiKeyByProvider('gemini') || 
                          (typeof localStorage !== 'undefined' ? localStorage.getItem('GEMINI_API_KEY') : null);

  const activeOpenRouterKey = integrationsVault.getApiKeyByProvider('openrouter') || 
                              (typeof localStorage !== 'undefined' ? localStorage.getItem('OPENROUTER_API_KEY') : null);

  const handleSaveGeminiKey = async (directKey?: string) => {
    const keyToSave = (directKey || geminiKeyInput).trim();
    if (!keyToSave || keyToSave.length < 5) {
      notifyChange('Forneça uma chave de API válida para o Gemini (mínimo 5 caracteres).');
      return false;
    }

    setIsSavingKey(true);
    try {
      await integrationsVault.connectService('svc-gemini', keyToSave);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('GEMINI_API_KEY', keyToSave);
      }
      await fetch('/api/env/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyName: 'GEMINI_API_KEY', keyValue: keyToSave })
      }).catch(() => {});
      await syncServicesFromEnv();
      if (!isMountedRef.current) return true;

      notifyChange('Chave de API do Gemini gravada e ativada no Cofre com sucesso.');
      return true;
    } catch (err: any) {
      if (isMountedRef.current) {
        notifyChange(`Erro ao salvar chave: ${err?.message || 'Falha de conexão'}`);
      }
      return false;
    } finally {
      if (isMountedRef.current) setIsSavingKey(false);
    }
  };

  const handleSaveOpenRouterKey = async (directKey?: string) => {
    const keyToSave = (directKey || openRouterKeyInput).trim();
    if (!keyToSave || keyToSave.length < 5) {
      notifyChange('Forneça uma chave de API válida para o OpenRouter (sk-or-...).');
      return false;
    }

    setIsSavingOpenRouterKey(true);
    try {
      await integrationsVault.connectService('svc-openrouter', keyToSave);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('OPENROUTER_API_KEY', keyToSave);
      }
      await fetch('/api/env/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyName: 'OPENROUTER_API_KEY', keyValue: keyToSave })
      }).catch(() => {});
      await syncServicesFromEnv();
      if (!isMountedRef.current) return true;

      notifyChange('Chave de API do OpenRouter gravada e ativada no Cofre para contingência.');
      return true;
    } catch (err: any) {
      if (isMountedRef.current) {
        notifyChange(`Erro ao salvar chave do OpenRouter: ${err?.message || 'Falha de conexão'}`);
      }
      return false;
    } finally {
      if (isMountedRef.current) setIsSavingOpenRouterKey(false);
    }
  };

  const handleExportFullBackup = async () => {
    try {
      const jsonStr = await storageAdapter.exportFullBackup();
      if (!isMountedRef.current) return;
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `liora-full-backup-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (exportRevokeTimerRef.current) clearTimeout(exportRevokeTimerRef.current);
      exportRevokeTimerRef.current = setTimeout(() => {
        URL.revokeObjectURL(url);
        exportRevokeTimerRef.current = null;
      }, 1000);
      notifyChange('Backup transacional de todas as 6 tabelas exportado com sucesso.');
    } catch (err: any) {
      if (isMountedRef.current) {
        notifyChange(`Falha ao exportar backup: ${err?.message || 'Erro desconhecido'}`);
      }
    }
  };

  const handleTestVoice = async () => {
    if (isTestingVoice) return;
    setIsTestingVoice(true);
    speechService.unlockAudio();

    try {
      let keyToUse = geminiKeyInput.trim() || activeGeminiKey;

      if (geminiKeyInput.trim() && geminiKeyInput.trim() !== activeGeminiKey) {
        const saved = await handleSaveGeminiKey(geminiKeyInput.trim());
        if (!isMountedRef.current) return;
        if (saved) {
          keyToUse = geminiKeyInput.trim();
        }
      }

      notifyChange(`Sintetizando voz neural Gemini (${settings.ttsVoice})...`);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };
      if (keyToUse) {
        headers['Authorization'] = `Bearer ${keyToUse}`;
        headers['x-gemini-key'] = keyToUse;
      }

      const res = await fetch('/api/gemini/tts', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text: `LIORA online com voz sintética avançada ${settings.ttsVoice}.`,
          voice: settings.ttsVoice,
          model: settings.ttsModel
        })
      });

      const data = await res.json().catch(() => ({}));
      if (!isMountedRef.current) return;

      if (!res.ok || !data.success || !data.audioBase64) {
        notifyChange(data?.error || 'Chave de API do Gemini ausente ou inválida no Cofre para teste de áudio');
        return;
      }

      const audioUrl = `data:${data.mimeType || 'audio/wav'};base64,${data.audioBase64}`;
      const audio = new Audio(audioUrl);
      testAudioRef.current = audio;
      await audio.play();
      if (!isMountedRef.current) return;
      notifyChange(`Amostra da voz ${settings.ttsVoice} (${settings.ttsModel}) reproduzida via API do Gemini.`);
    } catch (err: any) {
      if (isMountedRef.current) {
        notifyChange(err?.message || 'Chave de API do Gemini ausente ou inválida no Cofre para teste de áudio');
      }
    } finally {
      if (isMountedRef.current) setIsTestingVoice(false);
    }
  };

  const handleSelectWorkspace = () => {
    setWorkspaceInput(settings.workspacePath);
    setIsEditingWorkspace(true);
  };

  const handleSaveWorkspace = () => {
    if (workspaceInput && workspaceInput.trim()) {
      updateSettings({ workspacePath: workspaceInput.trim() });
      notifyChange('Caminho do workspace atualizado com sucesso.');
    }
    setIsEditingWorkspace(false);
  };

  const commitTimeoutDraft = () => {
    const parsed = parseInt(timeoutDraft.trim(), 10);
    if (Number.isNaN(parsed)) {
      setTimeoutDraft(String(settings.requestTimeoutMs));
      return;
    }
    const clamped = Math.max(1000, Math.min(60000, parsed));
    setTimeoutDraft(String(clamped));
    if (clamped !== settings.requestTimeoutMs) {
      updateSettings({ requestTimeoutMs: clamped });
      notifyChange(`Timeout de requisições ajustado para ${clamped}ms.`);
    }
  };

  const handleNotificationToggle = async (checked: boolean) => {
    if (checked && typeof window !== 'undefined' && 'Notification' in window) {
      try {
        const perm = await Notification.requestPermission();
        if (!isMountedRef.current) return;
        if (perm !== 'granted') {
          updateSettings({ desktopNotifications: false });
          notifyChange('Permissão de notificações negada pelo sistema operacional.');
          return;
        }
      } catch (err) {
        console.warn('Erro ao solicitar permissão de notificação:', err);
        if (!isMountedRef.current) return;
        updateSettings({ desktopNotifications: false });
        notifyChange('Não foi possível solicitar permissão de notificações ao navegador.');
        return;
      }
    }
    if (!isMountedRef.current) return;
    updateSettings({ desktopNotifications: checked });
    notifyChange(`Notificações desktop ${checked ? 'ativadas' : 'desativadas'}.`);
  };

  const handleSecurityLevelChange = (level: any) => {
    updateSettings({ securityEnforcementLevel: level });
    eventBus.publish('SECURITY_LEVEL_CHANGED', { level, timestamp: new Date().toISOString() });
    notifyChange('Nível de segurança e governança atualizado.');
  };

  return (
    <div className="flex-1 flex flex-col overflow-y-auto p-8 space-y-8 max-w-6xl mx-auto w-full">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-display font-bold text-white flex items-center gap-3">
            <SettingsIcon className="w-7 h-7" style={{ color: 'var(--accent-primary)' }} />
            Configurações Globais do Sistema
          </h2>
          <p className="text-sm text-[#A8A8A8]">Preferências de comportamento, perfis de temas visuais, segurança e integração desktop.</p>
        </div>
        <button
          type="button"
          onClick={() => {
            resetSettingsToDefault();
            notifyChange('Configurações restauradas para os padrões normativos.');
          }}
          className="flex items-center gap-2 px-4 py-2 bg-[#1A1A1A] hover:bg-[#262626] border border-[#333333] rounded-lg text-xs font-medium text-white transition-colors"
        >
          <RefreshCw className="w-4 h-4 text-[#A8A8A8]" />
          Restaurar Padrões
        </button>
      </div>

      {/* Toast Notification */}
      {successToast && (
        <div className="flex items-center gap-3 p-4 bg-[#10b981]/10 border border-[#10b981]/30 rounded-xl text-emerald-400 text-xs animate-fade-in">
          <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
          <span>{successToast}</span>
        </div>
      )}

      {/* CORREÇÃO (UI): items-start impede que cards de uma mesma linha se estiquem
          à altura do card vizinho — antes, 'Segurança & Governança' alongava até
          a altura do card de Áudio (muito alto), criando um bloco enorme vazio. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
        {/* Visual Themes & Identity */}
        <div className="bg-[#111111] border border-[#222222] rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-3">
            <Palette className="w-5 h-5" style={{ color: 'var(--accent-primary)' }} />
            <h3 className="font-semibold text-white text-base">Identidade Visual & Temas</h3>
          </div>
          <p className="text-xs text-[#A8A8A8]">Selecione o perfil de cores e variáveis CSS dinâmicas da interface.</p>
          
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
            {Object.values(THEME_PALETTES).map(t => {
              const active = settings.theme === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    updateSettings({ theme: t.id });
                    notifyChange(`Tema alterado para ${t.label}`);
                  }}
                  className={`flex flex-col p-3 rounded-lg border text-left transition-all relative ${
                    active 
                      ? 'bg-[#1C1C1C]' 
                      : 'bg-[#0A0A0A] border-[#222222] hover:border-[#333333]'
                  }`}
                  style={active ? { borderColor: t.hex, boxShadow: `0 0 16px ${t.hex}35` } : undefined}
                >
                  <div className="flex items-center justify-between gap-2 w-full mb-1">
                    <span className="font-medium text-xs text-white flex items-center gap-1.5 min-w-0 truncate">
                      {active && <CheckCircle2 className="w-3.5 h-3.5 shrink-0" style={{ color: t.hex }} />}
                      <span className="truncate">{t.label}</span>
                    </span>
                    <span className="w-3.5 h-3.5 rounded-full ring-2 ring-black shrink-0" style={{ backgroundColor: t.hex }} />
                  </div>
                  <span className="text-[10px] text-[#A8A8A8] line-clamp-2">{t.desc}</span>
                  {active && (
                    <span 
                      className="mt-2 inline-flex items-center self-start text-[9px] font-mono uppercase tracking-wider font-bold px-1.5 py-0.5 rounded"
                      style={{ backgroundColor: `${t.hex}20`, color: t.hex }}
                    >
                      Tema Ativo
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* General & Performance */}
        <div className="bg-[#111111] border border-[#222222] rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-3">
            <Cpu className="w-5 h-5" style={{ color: 'var(--accent-primary)' }} />
            <h3 className="font-semibold text-white text-base">Geral & Desempenho</h3>
          </div>

          <div className="space-y-4 pt-2 text-xs">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="settings-language" className="text-[#A8A8A8] flex items-center gap-2">
                <Globe className="w-4 h-4 text-[#A8A8A8]" />
                Idioma Principal (IA & UI)
              </label>
              <select
                id="settings-language"
                value={settings.language}
                onChange={e => {
                  updateSettings({ language: e.target.value as any });
                  notifyChange('Idioma atualizado com sucesso.');
                }}
                className="bg-[#0A0A0A] border border-[#333333] rounded px-3 py-1.5 text-white font-medium focus:outline-none focus:border-[var(--accent-primary)]"
              >
                <option value="pt-BR">Português Brasileiro (pt-BR)</option>
                <option value="en-US">English (en-US)</option>
                <option value="es-ES">Español (es-ES)</option>
              </select>
            </div>

            <div className="flex items-center justify-between gap-3">
              <label htmlFor="settings-orbQuality" className="text-[#A8A8A8]">Qualidade da Orb 3D (VRAM)</label>
              <select
                id="settings-orbQuality"
                value={settings.orbQuality}
                onChange={e => {
                  updateSettings({ orbQuality: e.target.value as any });
                  notifyChange('Qualidade da Orb atualizada.');
                }}
                className="bg-[#0A0A0A] border border-[#333333] rounded px-3 py-1.5 text-white font-medium focus:outline-none focus:border-[var(--accent-primary)]"
              >
                <option value="auto">Automática (WebGL)</option>
                <option value="high">Alta Fidelidade</option>
                <option value="balanced">Balanceada</option>
                <option value="low">Baixo Consumo</option>
              </select>
            </div>

            <div className="flex items-center justify-between gap-3">
              <label htmlFor="settings-timeout" className="text-[#A8A8A8]">Timeout de Requisições (ms) [1s-60s]</label>
              <input
                id="settings-timeout"
                type="number"
                min="1000"
                max="60000"
                step="1000"
                value={timeoutDraft}
                onChange={e => setTimeoutDraft(e.target.value)}
                onBlur={commitTimeoutDraft}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    commitTimeoutDraft();
                  }
                }}
                className="w-24 bg-[#0A0A0A] border border-[#333333] rounded px-3 py-1.5 text-white font-mono text-right focus:outline-none focus:border-[var(--accent-primary)]"
              />
            </div>
          </div>
        </div>

        {/* Security & Enforcement — self-start: nunca estica para a altura do card vizinho */}
        <div className="bg-[#111111] border border-[#222222] rounded-xl p-6 space-y-4 self-start">
          <div className="flex items-center gap-3">
            <Shield className="w-5 h-5 text-emerald-400" />
            <h3 className="font-semibold text-white text-base">Segurança & Governança (R0–R3)</h3>
          </div>

          <div className="space-y-4 pt-2 text-xs">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="settings-security" className="text-[#A8A8A8]">Nível de Execução de Políticas</label>
              <select
                id="settings-security"
                value={settings.securityEnforcementLevel}
                onChange={e => handleSecurityLevelChange(e.target.value)}
                className="bg-[#0A0A0A] border border-[#333333] rounded px-3 py-1.5 text-white font-medium focus:outline-none focus:border-[var(--accent-primary)]"
              >
                <option value="strict">Estrito (Padrão LIORA)</option>
                <option value="balanced">Balanceado</option>
                <option value="permissive">Permissivo (Atenção)</option>
              </select>
            </div>

            <div className="flex items-center justify-between gap-3">
              <label htmlFor="settings-logVerbosity" className="text-[#A8A8A8]">Verbosidade de Logs de Auditoria</label>
              <select
                id="settings-logVerbosity"
                value={settings.logVerbosity}
                onChange={e => {
                  updateSettings({ logVerbosity: e.target.value as LogVerbosity });
                  notifyChange('Verbosidade de logs atualizada.');
                }}
                className="bg-[#0A0A0A] border border-[#333333] rounded px-3 py-1.5 text-white font-medium focus:outline-none focus:border-[var(--accent-primary)]"
              >
                <option value="error">Apenas Erros</option>
                <option value="warn">Avisos e Erros</option>
                <option value="info">Padrão (Info)</option>
                <option value="debug">Completo (Debug)</option>
              </select>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-[#222222]">
              <label htmlFor="settings-notifications" className="text-[#A8A8A8] flex items-center gap-2 cursor-pointer">
                <Bell className="w-4 h-4 text-[#A8A8A8]" />
                Notificações Desktop (SO)
              </label>
              <input
                id="settings-notifications"
                type="checkbox"
                checked={settings.desktopNotifications}
                onChange={e => handleNotificationToggle(e.target.checked)}
                className="w-4 h-4 rounded cursor-pointer"
                style={{ accentColor: 'var(--accent-primary)' }}
              />
            </div>
          </div>
        </div>

        {/* Audio & Voice */}
        <div className="bg-[#111111] border border-[#222222] rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-3">
            <Volume2 className="w-5 h-5 text-blue-400" />
            <h3 className="font-semibold text-white text-base">Áudio, Voz & Transcrição</h3>
          </div>

          <div className="space-y-4 pt-2 text-xs">
            {/* Gemini API Key direct config */}
            <div className="p-3 bg-[#0A0A0A] border border-[#222222] rounded-lg space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-white font-medium flex items-center gap-1.5">
                  <Key className="w-3.5 h-3.5" style={{ color: 'var(--accent-primary)' }} />
                  Chave de API do Gemini (Cofre & Voz)
                </span>
                <span className={`text-[10px] px-2 py-0.5 rounded font-mono ${
                  activeGeminiKey ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                }`}>
                  {activeGeminiKey ? '● Configurada e Ativa' : '○ Pendente no Cofre'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  aria-label="Chave de API do Gemini"
                  value={geminiKeyInput}
                  onChange={e => setGeminiKeyInput(e.target.value)}
                  placeholder="Cole sua chave AIzaSy..."
                  className="flex-1 bg-[#141414] border border-[#333333] rounded px-3 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-[var(--accent-primary)] placeholder:text-[#555555]"
                />
                <button
                  type="button"
                  onClick={() => handleSaveGeminiKey()}
                  disabled={isSavingKey || !geminiKeyInput.trim()}
                  className="px-3 py-1.5 bg-[#222222] hover:bg-[#333333] border border-[#444444] rounded text-white font-medium text-xs transition-colors shrink-0 disabled:opacity-50 flex items-center gap-1 cursor-pointer"
                >
                  {isSavingKey ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3 text-emerald-400" />}
                  <span>Salvar</span>
                </button>
              </div>
            </div>

            {/* OpenRouter API Key direct config */}
            <div className="p-3 bg-[#0A0A0A] border border-[#222222] rounded-lg space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-white font-medium flex items-center gap-1.5">
                  <Key className="w-3.5 h-3.5 text-blue-400" />
                  Chave de API do OpenRouter (Backup / Contingência)
                </span>
                <span className={`text-[10px] px-2 py-0.5 rounded font-mono ${
                  activeOpenRouterKey ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20' : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                }`}>
                  {activeOpenRouterKey ? '● Contingência Ativa' : '○ Opcional'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  aria-label="Chave de API do OpenRouter"
                  value={openRouterKeyInput}
                  onChange={e => setOpenRouterKeyInput(e.target.value)}
                  placeholder="Cole sua chave sk-or-..."
                  className="flex-1 bg-[#141414] border border-[#333333] rounded px-3 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-blue-400 placeholder:text-[#555555]"
                />
                <button
                  type="button"
                  onClick={() => handleSaveOpenRouterKey()}
                  disabled={isSavingOpenRouterKey || !openRouterKeyInput.trim()}
                  className="px-3 py-1.5 bg-[#222222] hover:bg-[#333333] border border-[#444444] rounded text-white font-medium text-xs transition-colors shrink-0 disabled:opacity-50 flex items-center gap-1 cursor-pointer"
                >
                  {isSavingOpenRouterKey ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3 text-emerald-400" />}
                  <span>Salvar</span>
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3">
              <label htmlFor="settings-ttsModel" className="text-[#A8A8A8]">Modelo TTS Padrão</label>
              <select
                id="settings-ttsModel"
                value={settings.ttsModel === 'gemini-3.8-flash' ? 'gemini-3.8-flash-tts' : settings.ttsModel}
                onChange={e => {
                  updateSettings({ ttsModel: e.target.value as TTSModelChoice });
                  notifyChange('Modelo TTS atualizado.');
                }}
                className="bg-[#0A0A0A] border border-[#333333] rounded px-3 py-1.5 text-white font-mono focus:outline-none focus:border-[var(--accent-primary)]"
              >
                <option value="gemini-3.8-flash-lite-tts">gemini-3.8-flash-lite-tts (Neural Rápido)</option>
                <option value="gemini-3.8-flash-tts">gemini-3.8-flash-tts (Alta Fidelidade)</option>
                <option value="system-speech">API de Voz do Sistema (Nativo)</option>
              </select>
            </div>

            <div className="flex items-center justify-between gap-3">
              <label htmlFor="settings-ttsVoice" className="text-[#A8A8A8]">Voz da Assistente</label>
              <div className="flex items-center gap-2">
                <select
                  id="settings-ttsVoice"
                  value={settings.ttsVoice}
                  onChange={e => {
                    updateSettings({ ttsVoice: e.target.value as any });
                    notifyChange('Voz da assistente atualizada.');
                  }}
                  className="bg-[#0A0A0A] border border-[#333333] rounded px-3 py-1.5 text-white font-medium focus:outline-none focus:border-[var(--accent-primary)]"
                >
                  <option value="Aoede">Aoede (Expressiva / Recomendada)</option>
                  <option value="Kore">Kore (Feminina / Suave)</option>
                  <option value="Puck">Puck (Masculina / Amigável)</option>
                  <option value="Fenrir">Fenrir (Masculina / Firme)</option>
                  <option value="Charon">Charon (Neutro / Profundo)</option>
                </select>
                <button
                  type="button"
                  onClick={handleTestVoice}
                  disabled={isTestingVoice}
                  className="px-3.5 py-1.5 rounded-lg font-semibold transition-all duration-200 flex items-center gap-1.5 shadow-md hover:opacity-90 active:scale-95 cursor-pointer text-xs disabled:opacity-50"
                  style={{
                    backgroundColor: 'var(--accent-primary)',
                    color: '#000000',
                    boxShadow: '0 0 12px var(--accent-glow)'
                  }}
                  title="Testar Voz via API Gemini"
                >
                  {isTestingVoice ? <RefreshCw className="w-3.5 h-3.5 animate-spin text-black" /> : <Play className="w-3.5 h-3.5 fill-black text-black" />}
                  <span>{isTestingVoice ? 'Sintetizando...' : 'Testar'}</span>
                </button>
              </div>
            </div>

            <div className="pt-2 border-t border-[#222222] flex items-center justify-between text-[11px] text-[#A8A8A8]">
              <span className="truncate">Workspace: <code className="text-white font-mono">{settings.workspacePath}</code></span>
              <button
                type="button"
                onClick={handleSelectWorkspace}
                className="flex items-center gap-1.5 px-2.5 py-1 bg-[#1A1A1A] hover:bg-[#262626] border border-[#333333] rounded text-[11px] text-white transition-colors shrink-0 cursor-pointer"
              >
                <FolderOpen className="w-3.5 h-3.5" style={{ color: 'var(--accent-primary)' }} />
                Alterar...
              </button>
            </div>

            {/* Modal Inline para Alterar Workspace (Elimina window.prompt) */}
            {isEditingWorkspace && (
              <div className="p-3 bg-[#0E0E0E] border border-[#333333] rounded-lg space-y-2 mt-2">
                <label htmlFor="settings-workspace" className="text-[11px] text-[#CCCCCC] block font-medium">Novo Caminho do Workspace:</label>
                <input
                  id="settings-workspace"
                  type="text"
                  value={workspaceInput}
                  onChange={e => setWorkspaceInput(e.target.value)}
                  placeholder="./workspace ou C:\projetos"
                  className="w-full bg-[#181818] border border-[#444444] rounded px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-[var(--accent-primary)]"
                />
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setIsEditingWorkspace(false)}
                    className="px-2.5 py-1 bg-[#1A1A1A] hover:bg-[#252525] border border-[#333333] text-xs text-[#888888] rounded cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveWorkspace}
                    className="px-3 py-1 bg-[var(--accent-primary)] hover:opacity-90 text-xs font-semibold text-white rounded shadow cursor-pointer"
                  >
                    Salvar
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Banco de Dados & Backup Unificado (Fase 4) */}
      <div className="bg-[#111111] border border-[#222222] rounded-xl p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Database className="w-5 h-5" style={{ color: 'var(--accent-primary)' }} />
            <div>
              <h3 className="font-semibold text-white text-base">Banco de Dados Local & Backup Transacional (Fase 4)</h3>
              <p className="text-xs text-[#A8A8A8]">
                Motor de persistência soberano: {isTauriEnvironment() ? 'SQLite Nativo (Desktop Tauri)' : 'Cache Transacional Estruturado (Web Preview)'}.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={handleExportFullBackup}
              className="flex items-center gap-2 px-4 py-2 bg-[#1A1A1A] hover:bg-[#252525] border border-[#333333] hover:border-[var(--accent-primary)] rounded-lg text-white font-medium text-xs transition-colors shrink-0 shadow-sm cursor-pointer"
            >
              <Download className="w-4 h-4 text-emerald-400" />
              <span>Exportar Backup Completo (.json)</span>
            </button>
            {/* CORREÇÃO (falsa promessa): botão de IMPORTAR backup — restauração real
                de todos os registros via storageAdapter.restoreFromBackup */}
            <button
              type="button"
              onClick={() => void handleImportBackup()}
              className="flex items-center gap-2 px-4 py-2 bg-[#1A1A1A] hover:bg-[#252525] border border-[#333333] hover:border-[var(--accent-primary)] rounded-lg text-white font-medium text-xs transition-colors shrink-0 shadow-sm cursor-pointer"
            >
              <Upload className="w-4 h-4 text-blue-400" />
              <span>Restaurar Backup (.json)</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3 pt-2">
          {['sessions', 'memories', 'settings', 'automations', 'devices', 'audit_logs'].map(table => (
            <div key={table} className="p-3 bg-[#0A0A0A] border border-[#222222] rounded-lg text-center">
              <span className="text-[10px] text-[#888888] uppercase tracking-wider block font-mono">Tabela</span>
              <span className="text-xs font-semibold text-white font-mono">{table}</span>
              <span className="inline-block mt-1 text-[9px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded font-mono">
                Sincronizada
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* UI do Cofre — painel independente e compacto (fora dos cards para não
          inflar a altura da página): listar/apagar/adicionar credenciais */}
      <details className="bg-[#111111] border border-[#222222] rounded-xl overflow-hidden">
        <summary className="flex items-center justify-between px-6 py-3 cursor-pointer select-none group">
          <span className="flex items-center gap-2.5 text-sm font-semibold text-white">
            <Key className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
            Gerenciamento do Cofre Criptografado
          </span>
          <span className="text-[10px] font-mono text-[#A8A8A8] group-open:hidden">clique para expandir ▾</span>
        </summary>
        <div className="px-6 pb-5">
          <VaultManagerPanel />
        </div>
      </details>


    </div>
  );
};

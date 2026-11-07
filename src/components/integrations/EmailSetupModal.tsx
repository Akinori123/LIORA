/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — MODAL GUIADO DE CONFIGURAÇÃO DE E-MAIL IMAP/SMTP (Etapa A da auditoria UI)
 *
 * Problema corrigido: a aba de Integrações mostrava um selo "DISCONNECTED" e um
 * campo genérico "cole o token" — o usuário precisava saber montar à mão a string
 * criptografada `imap://user:pass@host:port|smtp://user:pass@host:port` que o
 * backend espera. Este formulário guiado coleta os campos ESSENCIAIS separados
 * (Servidor IMAP, Porta, Servidor SMTP, Porta, E-mail, Senha), monta a string no
 * formato correto automaticamente e grava no Cofre via connectService — o status
 * do card muda para CONNECTED em tempo real.
 *
 * Presets incluídos para os provedores mais comuns (Gmail, Outlook, Yahoo).
 */

import React, { useState, useMemo } from 'react';
import { Mail, Lock, Server, X, Eye, EyeOff, ChevronDown, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';

interface EmailSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Grava a credencial montada no cofre (via connectService do store) */
  onConnect: (rawKey: string) => Promise<boolean>;
  serviceId: string;
  serviceName: string;
}

/** Presets de provedores comuns — o usuário só digita e-mail + senha */
const PROVIDER_PRESETS: Array<{
  id: string;
  label: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
}> = [
  { id: 'gmail', label: 'Gmail', imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 },
  { id: 'outlook', label: 'Outlook / Hotmail', imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587 },
  { id: 'yahoo', label: 'Yahoo Mail', imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465 },
  { id: 'icloud', label: 'iCloud', imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587 },
  { id: 'custom', label: 'Outro provedor (personalizado)', imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 587 }
];

export const EmailSetupModal: React.FC<EmailSetupModalProps> = ({ isOpen, onClose, onConnect, serviceName }) => {
  const [presetId, setPresetId] = useState('gmail');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [imapHost, setImapHost] = useState(PROVIDER_PRESETS[0].imapHost);
  const [imapPort, setImapPort] = useState(String(PROVIDER_PRESETS[0].imapPort));
  const [smtpHost, setSmtpHost] = useState(PROVIDER_PRESETS[0].smtpHost);
  const [smtpPort, setSmtpPort] = useState(String(PROVIDER_PRESETS[0].smtpPort));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preset = useMemo(() => PROVIDER_PRESETS.find(p => p.id === presetId)!, [presetId]);
  const isCustom = presetId === 'custom';

  const applyPreset = (id: string) => {
    setPresetId(id);
    const p = PROVIDER_PRESETS.find(x => x.id === id)!;
    setImapHost(p.imapHost);
    setImapPort(String(p.imapPort));
    setSmtpHost(p.smtpHost);
    setSmtpPort(String(p.smtpPort));
  };

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!EMAIL_RE.test(email.trim())) {
      setError('Informe um e-mail válido (ex: nome@gmail.com).');
      return;
    }
    if (!password || password.length < 4) {
      setError('Informe a senha (ou senha de aplicativo, se o provedor exigir).');
      return;
    }
    if (!imapHost.trim() || !smtpHost.trim()) {
      setError('Informe os servidores IMAP e SMTP (escolha um provedor ou preencha manualmente).');
      return;
    }

    const imapPortNum = parseInt(imapPort, 10) || 993;
    const smtpPortNum = parseInt(smtpPort, 10) || 587;
    if (imapPortNum < 1 || imapPortNum > 65535 || smtpPortNum < 1 || smtpPortNum > 65535) {
      setError('As portas devem estar entre 1 e 65535.');
      return;
    }

    // Monta a string no formato esperado pelo backend:
    // imap://user:pass@host:port|smtp://user:pass@host:port
    const rawKey = [
      `imap://${encodeURIComponent(email.trim())}:${encodeURIComponent(password)}@${imapHost.trim()}:${imapPortNum}`,
      `smtp://${encodeURIComponent(email.trim())}:${encodeURIComponent(password)}@${smtpHost.trim()}:${smtpPortNum}`
    ].join('|');

    setIsSubmitting(true);
    try {
      const success = await onConnect(rawKey);
      if (success) {
        onClose();
      } else {
        setError('O cofre recusou a conexão. Verifique os dados e tente novamente.');
      }
    } catch (err: any) {
      setError(err?.message || 'Falha de rede ao gravar no cofre.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-[#111111] border border-[#333333] rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#222222] p-4 sticky top-0 bg-[#111111] z-10">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-xl bg-[var(--accent-bg)] border border-[var(--accent-border)]/30">
              <Mail className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
            </div>
            <div>
              <h3 className="font-bold text-white">Conectar {serviceName}</h3>
              <p className="text-[10px] text-[#888888]">Configuração guiada IMAP / SMTP</p>
            </div>
          </div>
          <button onClick={onClose} className="text-[#888888] hover:text-white p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Preset de provedor */}
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#A8A8A8] mb-1.5">
              Provedor
            </label>
            <div className="relative">
              <select
                value={presetId}
                onChange={(e) => applyPreset(e.target.value)}
                className="w-full appearance-none bg-[#171717] border border-[#333333] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[var(--accent-primary)] pr-9"
              >
                {PROVIDER_PRESETS.map(p => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-3 top-2.5 w-4 h-4 text-[#888888] pointer-events-none" />
            </div>
            <p className="text-[10px] text-[#777777] mt-1">
              Os servidores são preenchidos automaticamente. Gmail exige "senha de aplicativo" (não a senha normal).
            </p>
          </div>

          {/* E-mail */}
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#A8A8A8] mb-1.5">
              Endereço de E-mail
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="seu.nome@gmail.com"
              className="w-full bg-[#171717] border border-[#333333] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[var(--accent-primary)]"
              required
            />
          </div>

          {/* Senha */}
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#A8A8A8] mb-1.5">
              Senha / Senha de Aplicativo
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full bg-[#171717] border border-[#333333] rounded-lg px-3 py-2 pr-10 text-sm text-white focus:outline-none focus:border-[var(--accent-primary)]"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-2.5 text-[#888888] hover:text-white"
                title={showPassword ? 'Ocultar' : 'Mostrar'}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-[10px] text-[#777777] mt-1 flex items-start gap-1">
              <Lock className="w-3 h-3 mt-0.5 shrink-0" />
              <span>A senha é gravada criptografada (AES-256-GCM) no cofre local e nunca sai da sua máquina.</span>
            </p>
          </div>

          {/* Servidores (colapsáveis — pré-preenchidos pelo preset) */}
          <details className="group">
            <summary className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-[#A8A8A8] cursor-pointer select-none">
              <Server className="w-3.5 h-3.5" />
              <span>Servidores {isCustom ? '(preenchimento manual obrigatório)' : '(avançado — já configurados)'}</span>
              <ChevronDown className="w-3.5 h-3.5 ml-auto group-open:rotate-180 transition-transform" />
            </summary>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <div>
                <label className="block text-[10px] text-[#888888] mb-1">Servidor IMAP</label>
                <input
                  type="text"
                  value={imapHost}
                  onChange={(e) => setImapHost(e.target.value)}
                  placeholder="imap.provedor.com"
                  className="w-full bg-[#171717] border border-[#333333] rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[var(--accent-primary)] font-mono"
                />
              </div>
              <div>
                <label className="block text-[10px] text-[#888888] mb-1">Porta IMAP</label>
                <input
                  type="number"
                  value={imapPort}
                  onChange={(e) => setImapPort(e.target.value)}
                  min="1" max="65535"
                  className="w-full bg-[#171717] border border-[#333333] rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[var(--accent-primary)] font-mono"
                />
              </div>
              <div>
                <label className="block text-[10px] text-[#888888] mb-1">Servidor SMTP</label>
                <input
                  type="text"
                  value={smtpHost}
                  onChange={(e) => setSmtpHost(e.target.value)}
                  placeholder="smtp.provedor.com"
                  className="w-full bg-[#171717] border border-[#333333] rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[var(--accent-primary)] font-mono"
                />
              </div>
              <div>
                <label className="block text-[10px] text-[#888888] mb-1">Porta SMTP</label>
                <input
                  type="number"
                  value={smtpPort}
                  onChange={(e) => setSmtpPort(e.target.value)}
                  min="1" max="65535"
                  className="w-full bg-[#171717] border border-[#333333] rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[var(--accent-primary)] font-mono"
                />
              </div>
            </div>
          </details>

          {/* Erro */}
          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs font-mono text-red-400">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={isSubmitting || !email.trim() || !password}
            className="w-full py-2.5 rounded-xl text-sm font-bold text-white transition-all disabled:opacity-40 flex items-center justify-center gap-2"
            style={{ backgroundColor: 'var(--accent-primary)' }}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Gravando no cofre...</span>
              </>
            ) : (
              <>
                <CheckCircle2 className="w-4 h-4" />
                <span>Conectar e Ativar</span>
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
};

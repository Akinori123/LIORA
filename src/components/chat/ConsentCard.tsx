/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { 
  ShieldAlert, 
  Clock, 
  Check, 
  X, 
  AlertTriangle, 
  CheckCircle2, 
  XCircle,
  Lock,
  Mic,
  ChevronDown
} from 'lucide-react';
import { PendingConsentState } from '../../store/lioraStore';
import { humanizeToolAction } from '../../utils/toolHumanizer';

export interface ConsentCardProps {
  pendingConsent: PendingConsentState;
  onApprove: () => Promise<any> | void;
  onReject: () => void;
  onExpire?: () => void;
}

export const ConsentCard: React.FC<ConsentCardProps> = ({
  pendingConsent,
  onApprove,
  onReject,
  onExpire
}) => {
  // BUG FIX: garantir mínimo de 1s para evitar false-positive de expiração imediata
  // causada por clock skew entre servidor/frontend ou delay de render.
  const [secondsRemaining, setSecondsRemaining] = useState<number>(() => {
    const rem = Math.floor((pendingConsent.expiresAt - Date.now()) / 1000);
    return Math.max(1, rem); // mínimo 1s para nunca iniciar já expirado
  });
  const [isActioning, setIsActioning] = useState(false);
  // hasExpiredByTimer: só chama onExpire após o intervalo confirmar esgotamento (nunca no mount)
  const hasExpiredByTimerRef = React.useRef(false);

  const onExpireRef = React.useRef(onExpire);
  useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);

  useEffect(() => {
    if (pendingConsent.status !== 'PENDING') return;

    hasExpiredByTimerRef.current = false;
    setSecondsRemaining(Math.max(1, Math.floor((pendingConsent.expiresAt - Date.now()) / 1000)));

    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.floor((pendingConsent.expiresAt - Date.now()) / 1000));
      setSecondsRemaining(remaining);

      if (remaining <= 0 && !hasExpiredByTimerRef.current) {
        hasExpiredByTimerRef.current = true;
        clearInterval(interval);
        onExpireRef.current?.();
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [pendingConsent.expiresAt, pendingConsent.status]);

  const handleApprove = async () => {
    if (isActioning || pendingConsent.status !== 'PENDING') return;
    setIsActioning(true);
    try {
      await onApprove();
    } finally {
      setIsActioning(false);
    }
  };

  const handleReject = () => {
    if (isActioning || pendingConsent.status !== 'PENDING') return;
    onReject();
  };

  // Status Handlers
  if (pendingConsent.status === 'APPROVED') {
    return (
      <div className="my-3 p-4 bg-[#141414] border border-emerald-500/30 rounded-xl flex items-center justify-between text-xs font-mono shadow-lg shadow-emerald-500/5">
        <div className="flex items-center gap-3 text-emerald-400">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <div>
            <span className="font-bold">EXECUÇÃO APROVADA</span>
            <span className="text-[#A8A8A8] ml-2">Ferramenta: {pendingConsent.toolName}</span>
          </div>
        </div>
        <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          AUTORIZADO
        </span>
      </div>
    );
  }

  if (pendingConsent.status === 'REJECTED') {
    return (
      <div className="my-3 p-4 bg-[#141414] border border-amber-500/30 rounded-xl flex items-center justify-between text-xs font-mono shadow-lg shadow-amber-500/5">
        <div className="flex items-center gap-3 text-amber-400">
          <XCircle className="w-4 h-4 text-amber-400 shrink-0" />
          <div>
            <span className="font-bold">EXECUÇÃO RECUSADA</span>
            <span className="text-[#A8A8A8] ml-2">Ferramenta: {pendingConsent.toolName}</span>
          </div>
        </div>
        <span className="text-[10px] px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
          BLOQUEADO PELO USUÁRIO
        </span>
      </div>
    );
  }

  // BUG FIX: só renderiza EXPIRED se o store confirmou status='EXPIRED'
  // NÃO usa secondsRemaining <= 0 como gatilho — evita false-positive no mount
  // quando expiresAt tem clock skew leve. O interval chama onExpire, que atualiza o store.
  if (pendingConsent.status === 'EXPIRED') {
    return (
      <div className="my-3 p-4 bg-[#141414] border border-red-500/30 rounded-xl flex items-center justify-between text-xs font-mono shadow-lg shadow-red-500/5">
        <div className="flex items-center gap-3 text-red-400">
          <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
          <div>
            <span className="font-bold">CONSENTIMENTO EXPIRADO (DENY_CONSENT_EXPIRED)</span>
            <p className="text-[#888888] text-[11px] mt-0.5">O tempo limite de 60s expirou antes da confirmação humana.</p>
          </div>
        </div>
        <span className="text-[10px] px-2 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20">
          TIMEOUT TTL
        </span>
      </div>
    );
  }

  const human = humanizeToolAction(pendingConsent.toolName, pendingConsent.parameters, pendingConsent.riskLevel);
  const friendlyTitle = pendingConsent.friendlyTitle || human.title;
  const friendlyDescription = pendingConsent.friendlyDescription || human.friendlyDescription;

  // Active Pending Consent Card
  return (
    <div className="my-4 p-5 bg-[#141414] border border-[#2B2B2B] rounded-2xl shadow-2xl shadow-black/60 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-[#222222]">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
            <ShieldAlert className="w-4 h-4" />
          </div>
          <div>
            <h4 className="text-sm font-bold text-white flex items-center gap-2">
              {friendlyTitle}
              <span className="text-[10px] font-mono px-2 py-0.5 bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded-md">
                NÍVEL {pendingConsent.riskLevel}
              </span>
            </h4>
            <p className="text-xs text-[#A8A8A8] mt-0.5 font-sans">
              {friendlyDescription}
            </p>
          </div>
        </div>

        {/* TTL Timer */}
        <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#0E0E0E] border border-[#262626] text-xs font-mono text-amber-400">
          <Clock className="w-3.5 h-3.5 animate-pulse" />
          <span>{secondsRemaining}s</span>
        </div>
      </div>

      {/* Voice Instruction Pill */}
      <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-blue-950/20 border border-blue-900/40 text-xs text-blue-300 font-sans">
        <Mic className="w-4 h-4 text-blue-400 shrink-0 animate-pulse" />
        <span>Diga <strong>"autorizar"</strong> ou <strong>"cancelar"</strong> por voz a qualquer momento, ou use os botões abaixo.</span>
      </div>

      {/* Collapsible Technical Details for Developer / Transparency */}
      <details className="group border border-[#222222] rounded-xl overflow-hidden bg-[#0A0A0A]/60">
        <summary className="flex items-center justify-between px-3 py-2 text-[11px] font-mono text-[#888888] cursor-pointer hover:text-white select-none">
          <span>Detalhes técnicos do comando ({pendingConsent.toolName})</span>
          <ChevronDown className="w-3.5 h-3.5 transition-transform group-open:rotate-180" />
        </summary>
        <div className="p-3 pt-1 border-t border-[#1C1C1C] space-y-2 text-[11px] font-mono">
          {pendingConsent.reason && (
            <div className="text-[#A8A8A8] bg-[#121212] p-2 rounded border border-[#222222]">
              <span className="text-amber-400/90 font-semibold">Motivo: </span>
              {pendingConsent.reason}
            </div>
          )}
          <pre className="p-2.5 bg-[#080808] border border-[#1F1F1F] rounded text-[#888888] overflow-x-auto max-h-32 text-[10px]">
            {JSON.stringify(pendingConsent.parameters, null, 2)}
          </pre>
        </div>
      </details>

      {/* Action Buttons */}
      <div className="flex items-center justify-end gap-3 pt-1">
        <button
          type="button"
          onClick={handleReject}
          disabled={isActioning}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#1C1C1C] hover:bg-red-950/40 text-[#CCCCCC] hover:text-red-400 border border-[#2E2E2E] hover:border-red-900/60 text-xs font-medium transition-colors disabled:opacity-50 cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
          <span>Cancelar</span>
        </button>

        <button
          type="button"
          onClick={handleApprove}
          disabled={isActioning}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-white font-medium text-xs transition-colors disabled:opacity-50 shadow-md cursor-pointer hover:opacity-90 active:scale-95"
          style={{ backgroundColor: 'var(--accent-primary)' }}
        >
          {isActioning ? (
            <Clock className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Check className="w-3.5 h-3.5" />
          )}
          <span>{isActioning ? 'Processando...' : 'Autorizar'}</span>
        </button>
      </div>
    </div>
  );
};

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
  Lock
} from 'lucide-react';
import { PendingConsentState } from '../../store/lioraStore';

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
  const [secondsRemaining, setSecondsRemaining] = useState<number>(() => {
    const rem = Math.max(0, Math.floor((pendingConsent.expiresAt - Date.now()) / 1000));
    return rem;
  });
  const [isActioning, setIsActioning] = useState(false);

  const onExpireRef = React.useRef(onExpire);
  useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);

  useEffect(() => {
    if (pendingConsent.status !== 'PENDING') return;

    setSecondsRemaining(Math.max(0, Math.floor((pendingConsent.expiresAt - Date.now()) / 1000)));

    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.floor((pendingConsent.expiresAt - Date.now()) / 1000));
      setSecondsRemaining(remaining);

      if (remaining <= 0) {
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

  if (pendingConsent.status === 'EXPIRED' || secondsRemaining <= 0) {
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

  // Active Pending Consent Card
  return (
    <div className="my-4 p-5 bg-[#141414] border border-[#262626] rounded-xl shadow-xl shadow-black/40 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-[#222222]">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
            <ShieldAlert className="w-4 h-4" />
          </div>
          <div>
            <h4 className="text-sm font-bold text-white flex items-center gap-2">
              Confirmação de Consentimento Humano
              <span className="text-[10px] font-mono px-2 py-0.5 bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded">
                RISCO {pendingConsent.riskLevel}
              </span>
            </h4>
            <p className="text-xs text-[#888888] mt-0.5">
              Uma ferramenta do sistema requer sua autorização explícita para prosseguir.
            </p>
          </div>
        </div>

        {/* TTL Timer */}
        <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#0E0E0E] border border-[#262626] text-xs font-mono text-amber-400">
          <Clock className="w-3.5 h-3.5 animate-pulse" />
          <span>{secondsRemaining}s</span>
        </div>
      </div>

      {/* Tool & Parameters Details */}
      <div className="space-y-2 text-xs font-mono">
        <div className="flex items-center justify-between text-[#888888]">
          <span>Ferramenta Solicitada:</span>
          <span className="text-white font-bold">{pendingConsent.toolName}</span>
        </div>
        {pendingConsent.reason && (
          <div className="text-[11px] text-[#A8A8A8] bg-[#0E0E0E] p-2.5 rounded border border-[#222222]">
            <span className="text-amber-400/90 font-semibold">Motivo: </span>
            {pendingConsent.reason}
          </div>
        )}
        
        <div>
          <span className="text-[#888888] block mb-1">Parâmetros Solicitados:</span>
          <pre className="p-3 bg-[#0A0A0A] border border-[#222222] rounded text-[11px] text-[#A8A8A8] overflow-x-auto max-h-36">
            {JSON.stringify(pendingConsent.parameters, null, 2)}
          </pre>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={handleReject}
          disabled={isActioning}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-neutral-900 hover:bg-neutral-800 text-red-400 hover:text-red-300 border border-red-900/40 text-xs font-medium transition-colors disabled:opacity-50"
        >
          <X className="w-3.5 h-3.5" />
          <span>Recusar / Bloquear</span>
        </button>

        <button
          type="button"
          onClick={handleApprove}
          disabled={isActioning}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs transition-colors shadow-lg shadow-emerald-600/20 disabled:opacity-50"
        >
          {isActioning ? (
            <Clock className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Check className="w-3.5 h-3.5" />
          )}
          <span>{isActioning ? 'Processando...' : 'Aprovar Execução'}</span>
        </button>
      </div>
    </div>
  );
};

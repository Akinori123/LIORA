/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef } from 'react';
import { CONSENT_AUTO_DISMISS_MS, useLioraStore } from '../../store/lioraStore';
import { speechService } from '../../services/speechService';
import { voiceLiveClient } from '../../services/voiceLiveClient';
import { eventBus } from '../../utils/eventBus';
import { parseConsentVoiceDecision } from '../../utils/consentVoiceParser';
import { ConsentCard } from './ConsentCard';

/**
 * P1 (consentimento por voz): overlay GLOBAL fixo visível de qualquer aba.
 * Aceita confirmação/recusa falada via `parseConsentVoiceDecision` e fecha
 * automaticamente após 2500ms quando resolvido (APPROVED / REJECTED / EXPIRED).
 */
export const GlobalConsentOverlay: React.FC = () => {
  const pendingConsent = useLioraStore((s) => s.pendingConsent);
  const approveConsent = useLioraStore((s) => s.approveConsent);
  const rejectConsent = useLioraStore((s) => s.rejectConsent);
  const expireConsent = useLioraStore((s) => s.expireConsent);
  const setPendingConsent = useLioraStore((s) => s.setPendingConsent);
  const isVoiceActive = useLioraStore((s) => s.isVoiceActive);

  const pendingRef = useRef(pendingConsent);
  pendingRef.current = pendingConsent;

  // Confirmação falada: quando um consentimento R1+ está pendente e a voz está
  // ativa, a LIORA pede aprovação em voz alta e escuta por comandos de voz
  // ("autorizar", "pode executar", "confirmar", "pode fazer", "sim" / "cancelar", "negar", "não").
  useEffect(() => {
    if (!pendingConsent || pendingConsent.status !== 'PENDING') return;

    const spoken = pendingConsent.spokenPrompt || `Mestre, para executar a ação de ${pendingConsent.friendlyTitle || pendingConsent.toolName}, preciso da sua autorização. Posso prosseguir? Diga autorizar ou cancelar.`;

    if (isVoiceActive) {
      voiceLiveClient.extendSuppression(8000);
      speechService.speak(spoken, () => {}, () => {}, { isDeterministicOverride: true });
    }

    let resolvedByVoice = false;
    const unsubscribe = eventBus.subscribe('liora:voice_transcript', (payload: any) => {
      if (resolvedByVoice) return;
      const latest = pendingRef.current;
      if (!latest || latest.status !== 'PENDING') return;

      const decision = parseConsentVoiceDecision(String(payload?.text || ''));
      if (decision === 'APPROVE') {
        resolvedByVoice = true;
        speechService.stopSpeaking();
        // Executa com validação real — approveConsent fala o resultado verdadeiro (sucesso ou erro)
        void approveConsent();
      } else if (decision === 'REJECT') {
        resolvedByVoice = true;
        speechService.stopSpeaking();
        rejectConsent();
        speechService.speak("Entendido, Mestre. Operação cancelada como você pediu.", undefined, undefined, { isDeterministicOverride: true });
      }
    });

    return () => {
      unsubscribe();
      // Só silencia fala se ainda estava pendente no store (evita apagar feedback pós-aprovação)
      if (useLioraStore.getState().pendingConsent?.status === 'PENDING') {
        speechService.stopSpeaking();
      }
    };
  }, [pendingConsent?.auditId, pendingConsent?.status, pendingConsent?.spokenPrompt, pendingConsent?.friendlyTitle, pendingConsent?.toolName, isVoiceActive, approveConsent, rejectConsent]);

  // Failsafe visual de auto-fechamento: garante que o banner nunca fique preso
  // quando o status mudar para APPROVED, REJECTED ou EXPIRED.
  useEffect(() => {
    if (!pendingConsent || pendingConsent.status === 'PENDING') return;

    const resolvedAuditId = pendingConsent.auditId;
    const timer = setTimeout(() => {
      const current = useLioraStore.getState().pendingConsent;
      if (current && current.auditId === resolvedAuditId && current.status !== 'PENDING') {
        setPendingConsent(null);
      }
    }, CONSENT_AUTO_DISMISS_MS);

    return () => clearTimeout(timer);
  }, [pendingConsent?.auditId, pendingConsent?.status, setPendingConsent]);

  if (!pendingConsent) return null;

  // BUG FIX: removida a supressão por aba — o overlay de consentimento deve
  // ser SEMPRE visível independente da aba ativa, pois o usuário pode estar em
  // qualquer tela quando uma ferramenta R1+ é bloqueada. Suprimir o overlay
  // causava o sintoma de "desaparecimento em 1-2s" quando a aba era 'conversation'.
  // O ConsentCard inline na TranscriptionView permanece para conforto visual,
  // mas o overlay global nunca é suprimido.

  return (
    <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[60] w-[94%] max-w-md animate-in slide-in-from-top duration-200 pointer-events-auto">
      <ConsentCard
        pendingConsent={pendingConsent}
        onApprove={approveConsent}
        onReject={rejectConsent}
        onExpire={expireConsent}
      />
    </div>
  );
};

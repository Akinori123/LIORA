/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef } from 'react';
import { useLioraStore } from '../../store/lioraStore';
import { speechService } from '../../services/speechService';
import { eventBus } from '../../utils/eventBus';
import { ConsentCard } from './ConsentCard';

/**
 * P1 (consentimento por voz): o card de consentimento R1+ antes só renderizava
 * dentro da TranscriptionView. Agora é um overlay GLOBAL fixo — visível de
 * qualquer aba (Home, Cockpit, Automações...) — e aceita confirmação FALADA
 * ("confirmar"/"cancelar") pelo microfone, eliminando o deadlock de comandos
 * de voz de risco que expiravam silenciosamente após 60s.
 */
export const GlobalConsentOverlay: React.FC = () => {
  const pendingConsent = useLioraStore((s) => s.pendingConsent);
  const approveConsent = useLioraStore((s) => s.approveConsent);
  const rejectConsent = useLioraStore((s) => s.rejectConsent);
  const expireConsent = useLioraStore((s) => s.expireConsent);
  const isVoiceActive = useLioraStore((s) => s.isVoiceActive);
  const activeTab = useLioraStore((s) => s.activeTab);
  const conversationSubTab = useLioraStore((s) => s.conversationSubTab);

  const pendingRef = useRef(pendingConsent);
  useEffect(() => {
    pendingRef.current = pendingConsent;
  }, [pendingConsent]);

  // Confirmação falada: quando um consentimento R1+ está pendente e a voz está
  // ativa, a LIORA pede aprovação em voz alta e escuta por "confirmar"/"cancelar".
  useEffect(() => {
    if (!pendingConsent || pendingConsent.status !== 'PENDING') return;

    const announcement = pendingConsent.reason || `Operação ${pendingConsent.riskLevel} requer aprovação.`;
    const spoken = `Atenção. ${announcement} Diga confirmar para autorizar, ou cancelar para recusar.`;

    if (isVoiceActive) {
      speechService.speak(spoken, () => { }, () => { });
    }

    // Listener falado: aceita confirmação via canal de transcrição existente
    const unsubscribe = eventBus.subscribe('liora:voice_transcript', (payload: any) => {
      const text = String(payload?.text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (!text) return;

      const isApprove = /\b(confirmar?|autoriz[oa]r?|aprovar?|sim|ok|pode)\b/.test(text);
      const isReject = /\b(cancelar?|recusar?|negar?|nao|parar?|stop)\b/.test(text);

      if (isApprove) {
        speechService.stopSpeaking();
        approveConsent();
      } else if (isReject) {
        speechService.stopSpeaking();
        rejectConsent();
      }
    });

    return () => {
      unsubscribe();
      speechService.stopSpeaking();
    };
  }, [pendingConsent, isVoiceActive, approveConsent, rejectConsent]);

  // Publica no eventBus quando a voz reconhece fala do usuário (integrado via
  // GlobalVoiceBar que já tem acesso à transcrição)
  useEffect(() => {
    if (!pendingConsent || pendingConsent.status !== 'PENDING') return;
    // Bridge de input manual: permite aprovar/rejeitar por clique no overlay também
  }, [pendingConsent]);

  if (!pendingConsent) return null;

  // Se o consentimento já está sendo mostrado dentro da TranscriptionView
  // (aba conversation ativa), não duplica o overlay global.
  if (activeTab === 'conversation' && conversationSubTab === 'transcription') {
    return null;
  }

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

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — Parser Determinístico de Decisões de Consentimento por Voz
 * Reconhece comandos falados de aprovação ou recusa enquanto o overlay R1/R2 está aberto,
 * filtrando ecos da própria fala da assistente.
 */

export type ConsentVoiceDecision = 'APPROVE' | 'REJECT' | null;

function normalizeSpeech(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const REJECT_REGEX =
  /\b(nao|cancelar?|cancela|cancelo|recusar?|recusa|recuso|negar?|nega|nego|rejeitar?|rejeita|rejeito|parar?|pare|abortar?|aborta|stop|bloquear?|bloqueia|deixa\s+quieto|esquece|nao\s+quero|negativo|cancela\s+isso)\b/;

const APPROVE_REGEX =
  /\b(autoriz[aeo]r?|confirm[aeo]r?|aprov[aeo]r?|pode\s+executar|pode\s+fazer|pode\s+sim|sim|ok|liber[aeo]r?|pode|prosseguir|prossiga|permita|permitir|permitido|com\s+certeza|claro|vai\s+em\s+frente|manda\s+ver|manda\s+bala|positivo)\b/;

/**
 * Analisa uma transcrição de voz durante uma janela de consentimento pendente.
 * Retorna 'APPROVE', 'REJECT' ou null.
 */
export function parseConsentVoiceDecision(rawText: string): ConsentVoiceDecision {
  const text = normalizeSpeech(rawText);
  if (!text) return null;

  // Proteção anti-eco: ignora a própria pergunta falada pela LIORA captada pelo microfone
  if (
    text.includes('diga confirmar para autorizar') ||
    text.includes('ou cancelar para recusar') ||
    text.includes('requer aprovacao') ||
    text.includes('requer confirmacao')
  ) {
    return null;
  }

  // Rejeição avaliada primeiro (fail-closed: ex. "não autorizar" / "não confirmar" -> REJECT)
  if (REJECT_REGEX.test(text)) {
    return 'REJECT';
  }

  if (APPROVE_REGEX.test(text)) {
    return 'APPROVE';
  }

  return null;
}

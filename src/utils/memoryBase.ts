/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export const STOPWORDS_PT_EN = new Set([
  'de', 'a', 'o', 'que', 'e', 'do', 'da', 'em', 'um', 'para', 'com', 'nao', 'uma', 'os', 'no',
  'se', 'na', 'por', 'mais', 'as', 'dos', 'como', 'mas', 'foi', 'ao', 'ele', 'das', 'tem', 'seu',
  'sua', 'ou', 'ser', 'quando', 'muito', 'ha', 'nos', 'ja', 'esta', 'eu', 'tambem', 'so', 'pelo',
  'pela', 'ate', 'isso', 'ela', 'entre', 'era', 'depois', 'sem', 'mesmo', 'aos', 'ter', 'seus',
  'quem', 'nas', 'me', 'esse', 'eles', 'estao', 'voce', 'tinha', 'foram', 'essa', 'num', 'nem',
  'suas', 'meu', 'minha', 'numa', 'pelos', 'elas', 'qual', 'sera', 'tenho', 'lhe',
  'the', 'is', 'at', 'which', 'on', 'and', 'to', 'for', 'with', 'in', 'of', 'an'
]);

export const SENSITIVE_PATTERNS = [
  /AIzaSy[0-9A-Za-z_-]{33}/i,
  /sk-[a-zA-Z0-9_-]{20,}/i,
  /ghp_[a-zA-Z0-9]{36}/i,
  /bearer\s+[a-zA-Z0-9._-]+/i
];

export const SENSITIVE_KEYWORDS = [
  'KEY', 'SECRET', 'PASSWORD', 'TOKEN', 'AUTH', 'PRIVATE', 'BEARER', 'CREDENTIAL', 'API'
];

/**
 * Remove acentuação e converte string para minúsculas
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Tokeniza o texto removendo pontuação e stopwords
 */
export function tokenizeText(text: string): string[] {
  const normalized = normalizeText(text);
  const rawTokens = normalized
    .replace(/[^a-z0-9_-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);

  return rawTokens.filter(t => !STOPWORDS_PT_EN.has(t));
}

/**
 * Sanitiza valores de memória mascarando segredos e credenciais conhecidas
 */
export function sanitizeMemoryValue(key: string, value: string): { sanitizedKey: string; sanitizedValue: string; isRedacted: boolean } {
  const upperKey = key.toUpperCase();
  const isKeySensitive = SENSITIVE_KEYWORDS.some(kw => upperKey.includes(kw));

  if (isKeySensitive) {
    return {
      sanitizedKey: key,
      sanitizedValue: '[REDACTED_SECURITY_SECRET]',
      isRedacted: true
    };
  }

  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(value)) {
      return {
        sanitizedKey: key,
        sanitizedValue: '[REDACTED_SECURITY_SECRET]',
        isRedacted: true
      };
    }
  }

  // Sanitização de prompt injection básico
  const cleanedValue = value
    .replace(/ignore\s+(todas\s+as\s+)?instru[cç][oõ]es/gi, '[INSTRUCTION_OVERRIDE_REMOVED]')
    .replace(/system\s*instruction/gi, '[RESTRICTED_TAG]');

  return {
    sanitizedKey: key,
    sanitizedValue: cleanedValue,
    isRedacted: false
  };
}

import { MemoryEntry } from '../types';
import { 
  normalizeText, 
  tokenizeText, 
  sanitizeMemoryValue, 
  STOPWORDS_PT_EN, 
  SENSITIVE_PATTERNS, 
  SENSITIVE_KEYWORDS 
} from './memoryBase';
import { semanticMemoryEngine } from '../services/semanticMemoryEngine';

export { 
  normalizeText, 
  tokenizeText, 
  sanitizeMemoryValue, 
  STOPWORDS_PT_EN, 
  SENSITIVE_PATTERNS, 
  SENSITIVE_KEYWORDS 
};

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
  matchedTokens: string[];
  semanticScore?: number;
  matchReason?: string;
}

export interface MemoryRankerConfig {
  minScoreThreshold?: number; // Padrão: 0.35
  maxInjectedMemories?: number; // Padrão: 4
  maxCharacterBudget?: number; // Padrão: 400
  enableSemanticBoosting?: boolean; // Padrão: true
}

/**
 * Calcula a similaridade e rankeia as memórias com base na consulta do usuário
 * Combina busca léxica de alta precisão com impulsão vetorial semântica
 */
export function rankMemories(
  query: string,
  memories: MemoryEntry[],
  config: MemoryRankerConfig = {}
): MemorySearchResult[] {
  const {
    minScoreThreshold = 0.35,
    maxInjectedMemories = 4,
    enableSemanticBoosting = true
  } = config;

  const queryTokens = tokenizeText(query);
  if (queryTokens.length === 0 || memories.length === 0) {
    return [];
  }

  const queryTokenSet = new Set(queryTokens);
  const scoredResults: MemorySearchResult[] = [];

  const categoryWeights: Record<string, number> = {
    preference: 1.4,
    project: 1.3,
    routine: 1.1,
    fact: 1.0,
    journal: 0.9
  };

  const queryVector = enableSemanticBoosting ? semanticMemoryEngine.generateEmbedding(query) : null;

  for (const entry of memories) {
    const keyTokens = tokenizeText(entry.key);
    const valueTokens = tokenizeText(entry.value);
    const categoryTokens = tokenizeText(entry.category);

    let rawScore = 0;
    const matchedTokens: string[] = [];

    for (const qToken of queryTokenSet) {
      let tokenMatched = false;

      // Correspondência na chave (peso maior: 3.0)
      if (keyTokens.some(kt => kt.includes(qToken) || qToken.includes(kt))) {
        rawScore += 3.0;
        tokenMatched = true;
      }

      // Correspondência no valor (peso médio: 1.5)
      if (valueTokens.some(vt => vt.includes(qToken) || qToken.includes(vt))) {
        rawScore += 1.5;
        tokenMatched = true;
      }

      // Correspondência na categoria (peso auxiliar: 0.5)
      if (categoryTokens.includes(qToken)) {
        rawScore += 0.5;
        tokenMatched = true;
      }

      if (tokenMatched) {
        matchedTokens.push(qToken);
      }
    }

    // Similaridade semântica vetorial
    let semanticScore = 0;
    if (queryVector) {
      const entryVector = semanticMemoryEngine.generateEmbedding(`${entry.category} ${entry.key} ${entry.value}`);
      semanticScore = semanticMemoryEngine.cosineSimilarity(queryVector, entryVector);
    }

    // Se não houver correspondência léxica e a similaridade vetorial for baixa, ignora
    if (rawScore === 0 && semanticScore < 0.42) {
      continue;
    }

    // Normalização pelo comprimento da consulta
    const normalizedLexicalScore = queryTokenSet.size > 0 
      ? rawScore / Math.sqrt(queryTokenSet.size) 
      : 0;

    // Multiplicador de categoria
    const categoryMult = categoryWeights[entry.category] || 1.0;

    // Multiplicador por confiança
    const confidenceMult = typeof entry.confidence === 'number' ? Math.max(0.1, entry.confidence) : 1.0;

    // Fusão híbrida (60% semântica vetorial + 40% lexical normalizado)
    const hybridBase = queryVector 
      ? (normalizedLexicalScore > 0 ? (normalizedLexicalScore * 0.4 + semanticScore * 2.0 * 0.6) : (semanticScore * 2.0))
      : normalizedLexicalScore;

    const finalScore = hybridBase * categoryMult * confidenceMult;

    if (finalScore >= minScoreThreshold) {
      // Sanitização de dados sensíveis
      const { sanitizedKey, sanitizedValue } = sanitizeMemoryValue(entry.key, entry.value);
      const sanitizedEntry: MemoryEntry = {
        ...entry,
        key: sanitizedKey,
        value: sanitizedValue
      };

      let matchReason = '';
      if (semanticScore > 0.65 && rawScore === 0) {
        matchReason = 'Afinidade conceitual vetorial (sem termos exatos)';
      } else if (rawScore > 0 && semanticScore > 0.5) {
        matchReason = 'Correspondência híbrida ideal (termos + conceito)';
      } else if (rawScore > 0) {
        matchReason = 'Correspondência direta por palavras-chave';
      } else {
        matchReason = 'Afinidade semântica contextual';
      }

      scoredResults.push({
        entry: sanitizedEntry,
        score: finalScore,
        matchedTokens,
        semanticScore,
        matchReason
      });
    }
  }

  // Ordenação decrescente por score
  scoredResults.sort((a, b) => b.score - a.score);

  return scoredResults.slice(0, maxInjectedMemories);
}

/**
 * Formata o bloco de memória contextual para injeção no systemInstruction do prompt
 */
export function formatMemoryContextBlock(
  rankedMemories: MemorySearchResult[],
  maxCharacterBudget: number = 400
): string {
  if (!rankedMemories || rankedMemories.length === 0) {
    return '';
  }

  const header = '\n\n[SISTEMA - MEMÓRIA CONTEXTUAL RECUPERADA]\n';
  const footer = '\nDiretriz: Utilize essas informações de forma natural.';

  let memoryLines = '';
  for (const item of rankedMemories) {
    let line = `- [${item.entry.category.toUpperCase()}] ${item.entry.key}: ${item.entry.value}\n`;
    
    const available = maxCharacterBudget - (header.length + memoryLines.length + footer.length);
    if (available <= 10) {
      break;
    }
    if (line.length > available) {
      line = line.slice(0, Math.max(0, available - 4)) + '...\n';
    }

    memoryLines += line;
  }

  if (!memoryLines) {
    return '';
  }

  const result = header + memoryLines + footer;
  return result.length > maxCharacterBudget ? result.slice(0, maxCharacterBudget) : result;
}

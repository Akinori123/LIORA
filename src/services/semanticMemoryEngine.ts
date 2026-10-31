/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { MemoryEntry } from '../types';
import { normalizeText, tokenizeText, sanitizeMemoryValue } from '../utils/memoryBase';

export type SearchMode = 'hybrid' | 'semantic' | 'lexical';

export interface SemanticSearchResult {
  entry: MemoryEntry;
  score: number;             // Score final normalizado (0.0 a 1.0)
  semanticScore: number;     // Similaridade de cosseno vetorial (0.0 a 1.0)
  lexicalScore: number;      // Correspondência léxica/tokens (0.0 a 1.0)
  matchReason: string;       // Justificativa semântica
  matchedTokens: string[];
  cluster: string;           // Cluster temático da memória
}

export interface SemanticSearchOptions {
  mode?: SearchMode;
  threshold?: number;        // Limite mínimo (0.0 a 1.0, padrão: 0.25)
  maxResults?: number;       // Padrão: 8
  alpha?: number;            // Peso vetorial no híbrido (0.0 a 1.0, padrão: 0.65)
}

export interface SemanticCluster {
  id: string;
  name: string;
  description: string;
  color: string;
  entriesCount: number;
}

// Dicionário de sinônimos e conceitos semânticos mapeados para expansão vetorial
const CONCEPT_ANCHORS: Record<string, { cluster: string; keywords: string[]; dimensions: number[] }> = {
  software_dev: {
    cluster: 'Desenvolvimento & Código',
    keywords: [
      'codigo', 'programar', 'programacao', 'desenvolvimento', 'editor', 'vscode', 'ide', 
      'script', 'rust', 'typescript', 'react', 'git', 'terminal', 'workspace', 'repo', 
      'software', 'bugs', 'build', 'compilador', 'linguagens'
    ],
    dimensions: [0, 1, 2, 3]
  },
  user_identity: {
    cluster: 'Identidade & Perfil',
    keywords: [
      'nome', 'usuario', 'chamo', 'identificacao', 'eu', 'sou', 'perfil', 'aniversario', 
      'idade', 'cargo', 'funcao', 'autor', 'dono', 'mestre'
    ],
    dimensions: [4, 5, 6, 7]
  },
  ai_personality: {
    cluster: 'Comunicação & Comportamento',
    keywords: [
      'resposta', 'modo', 'tom', 'falar', 'direto', 'resumido', 'detalhado', 'estilo', 
      'educado', 'formal', 'tecnico', 'comportamento', 'personalidade', 'jarvis', 'audio', 'voz'
    ],
    dimensions: [8, 9, 10, 11]
  },
  schedule_routines: {
    cluster: 'Rotinas & Horários',
    keywords: [
      'horario', 'rotina', 'silencioso', 'dormir', 'acordar', 'trabalho', 'foco', 'tempo', 
      'alarme', 'agenda', 'lembrete', 'manha', 'noite', 'madrugada', 'pausa'
    ],
    dimensions: [12, 13, 14, 15]
  },
  hardware_devices: {
    cluster: 'Dispositivos & Hardware',
    keywords: [
      'computador', 'pc', 'celular', 'smartphone', 'mouse', 'teclado', 'monitor', 'tv', 
      'placa', 'gpu', 'cpu', 'rede', 'wifi', 'bluetooth', 'bateria', 'impressora'
    ],
    dimensions: [16, 17, 18, 19]
  },
  environment_theme: {
    cluster: 'Ambiente & Interface',
    keywords: [
      'tema', 'visual', 'cor', 'crimson', 'vermelho', 'escuro', 'black', 'dark', 'hud', 
      'fonte', 'layout', 'orb', 'brilho', 'contraste', 'interface'
    ],
    dimensions: [20, 21, 22, 23]
  },
  security_governance: {
    cluster: 'Segurança & Governança',
    keywords: [
      'permissao', 'bloqueio', 'autorizacao', 'consentimento', 'segredo', 'chave', 'token', 
      'cofre', 'sandbox', 'restricao', 'shield', 'blindagem', 'risco'
    ],
    dimensions: [24, 25, 26, 27]
  }
};

const VECTOR_DIMENSIONS = 32;

/**
 * Motor de Busca Semântica e Embeddings Locais da LIORA
 * Permite encontrar memórias por afinidade conceitual mesmo que os termos exatos não coincidam.
 */
class SemanticMemoryEngine {
  private embeddingCache = new Map<string, number[]>();

  /**
   * Gera um vetor denso normalizado de 32 dimensões para qualquer texto.
   * Utiliza projeção estocástica determinística de n-gramas e ativação de âncoras conceituais.
   */
  public generateEmbedding(text: string): number[] {
    const cacheKey = text.trim().toLowerCase();
    if (this.embeddingCache.has(cacheKey)) {
      return this.embeddingCache.get(cacheKey)!;
    }

    const vector = new Array<number>(VECTOR_DIMENSIONS).fill(0);
    const normalized = normalizeText(text);
    const tokens = tokenizeText(normalized);

    // 1. Projeção de n-gramas e subpalavras (Hashing Trick determinístico)
    for (const token of tokens) {
      let hash = 0;
      for (let i = 0; i < token.length; i++) {
        hash = (hash << 5) - hash + token.charCodeAt(i);
        hash |= 0;
      }
      const dim = Math.abs(hash) % VECTOR_DIMENSIONS;
      vector[dim] += 1.0;

      // Trigramas de caracteres
      for (let i = 0; i <= token.length - 3; i++) {
        const tri = token.substring(i, i + 3);
        let triHash = 0;
        for (let j = 0; j < 3; j++) {
          triHash = (triHash << 3) + tri.charCodeAt(j);
        }
        const triDim = Math.abs(triHash) % VECTOR_DIMENSIONS;
        vector[triDim] += 0.35;
      }
    }

    // 2. Ativação de âncoras conceituais (Semantic Anchors)
    for (const [conceptKey, anchor] of Object.entries(CONCEPT_ANCHORS)) {
      let anchorHits = 0;
      for (const kw of anchor.keywords) {
        if (normalized.includes(kw)) {
          anchorHits += 1.5;
        }
      }

      if (anchorHits > 0) {
        for (const dim of anchor.dimensions) {
          if (dim < VECTOR_DIMENSIONS) {
            vector[dim] += anchorHits * 1.8;
          }
        }
      }
    }

    // 3. Normalização L2 (comprimento unitário para cosseno direto)
    let norm = 0;
    for (let i = 0; i < VECTOR_DIMENSIONS; i++) {
      norm += vector[i] * vector[i];
    }
    norm = Math.sqrt(norm);

    const normalizedVector = norm > 0 
      ? vector.map(v => v / norm)
      : new Array<number>(VECTOR_DIMENSIONS).fill(1 / Math.sqrt(VECTOR_DIMENSIONS));

    this.embeddingCache.set(cacheKey, normalizedVector);
    return normalizedVector;
  }

  /**
   * Calcula a similaridade de cosseno entre dois vetores normalizados (retorno 0.0 a 1.0).
   */
  public cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;

    let dot = 0;
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i];
    }

    // Mapeia de [-1, 1] para [0, 1] com threshold de piso
    const bounded = Math.max(0, Math.min(1, (dot + 1) / 2));
    return bounded;
  }

  /**
   * Identifica o cluster conceitual correspondente a uma entrada de memória
   */
  public detectCluster(entry: MemoryEntry): string {
    const text = `${entry.category} ${entry.key} ${entry.value}`.toLowerCase();
    let bestCluster = 'Geral';
    let maxHits = 0;

    for (const anchor of Object.values(CONCEPT_ANCHORS)) {
      let hits = 0;
      for (const kw of anchor.keywords) {
        if (text.includes(kw)) hits++;
      }
      if (hits > maxHits) {
        maxHits = hits;
        bestCluster = anchor.cluster;
      }
    }

    return bestCluster;
  }

  /**
   * Realiza busca semântica, léxica ou híbrida sobre o conjunto de memórias da LIORA
   */
  public search(
    query: string,
    memories: MemoryEntry[],
    options: SemanticSearchOptions = {}
  ): SemanticSearchResult[] {
    const {
      mode = 'hybrid',
      threshold = 0.25,
      maxResults = 10,
      alpha = 0.65 // 65% vetorial semântico, 35% léxico
    } = options;

    const trimmedQuery = query.trim();
    if (!trimmedQuery || memories.length === 0) {
      return [];
    }

    const queryEmbedding = this.generateEmbedding(trimmedQuery);
    const queryTokens = tokenizeText(trimmedQuery);
    const queryTokenSet = new Set(queryTokens);

    const results: SemanticSearchResult[] = [];

    for (const entry of memories) {
      const fullText = `${entry.key} ${entry.value} ${entry.category}`;
      const entryEmbedding = this.generateEmbedding(fullText);

      // 1. Similaridade vetorial de cosseno
      const semanticScore = this.cosineSimilarity(queryEmbedding, entryEmbedding);

      // 2. Similaridade léxica (Jaccard ponderada por chave e valor)
      const keyTokens = tokenizeText(entry.key);
      const valTokens = tokenizeText(entry.value);
      const matchedTokens: string[] = [];

      let tokenMatches = 0;
      for (const qToken of queryTokenSet) {
        if (keyTokens.some(kt => kt.includes(qToken) || qToken.includes(kt))) {
          tokenMatches += 2.0; // Peso extra para chave
          matchedTokens.push(qToken);
        } else if (valTokens.some(vt => vt.includes(qToken) || qToken.includes(vt))) {
          tokenMatches += 1.0;
          matchedTokens.push(qToken);
        }
      }

      const lexicalScore = queryTokenSet.size > 0 
        ? Math.min(1.0, tokenMatches / (queryTokenSet.size * 1.5))
        : 0;

      // 3. Cálculo do score final baseado no modo selecionado
      let finalScore = 0;
      if (mode === 'semantic') {
        finalScore = semanticScore;
      } else if (mode === 'lexical') {
        finalScore = lexicalScore;
      } else {
        // Modo Híbrido
        finalScore = (alpha * semanticScore) + ((1 - alpha) * lexicalScore);
      }

      // Multiplicador leve de confiança da memória
      const conf = typeof entry.confidence === 'number' ? Math.max(0.2, entry.confidence) : 1.0;
      finalScore = Math.min(1.0, finalScore * conf);

      if (finalScore >= threshold) {
        const cluster = this.detectCluster(entry);
        
        // Determina a razão de correspondência
        let matchReason = '';
        if (semanticScore > 0.65 && lexicalScore < 0.2) {
          matchReason = `Afinidade conceitual alta (${cluster})`;
        } else if (lexicalScore > 0.5 && semanticScore > 0.5) {
          matchReason = `Correspondência híbrida perfeita (Conceito + Termos)`;
        } else if (lexicalScore > 0.6) {
          matchReason = `Correspondência direta por palavras-chave`;
        } else {
          matchReason = `Similaridade semântica moderada`;
        }

        const { sanitizedKey, sanitizedValue } = sanitizeMemoryValue(entry.key, entry.value);

        results.push({
          entry: {
            ...entry,
            key: sanitizedKey,
            value: sanitizedValue
          },
          score: finalScore,
          semanticScore,
          lexicalScore,
          matchReason,
          matchedTokens,
          cluster
        });
      }
    }

    // Ordenação decrescente por relevância
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, maxResults);
  }

  /**
   * Lista todos os clusters conceituais ativos e a contagem de memórias associadas
   */
  public getClusters(memories: MemoryEntry[]): SemanticCluster[] {
    const clusterMap = new Map<string, number>();

    for (const entry of memories) {
      const cluster = this.detectCluster(entry);
      clusterMap.set(cluster, (clusterMap.get(cluster) || 0) + 1);
    }

    const clusterColors: Record<string, string> = {
      'Desenvolvimento & Código': '#3B82F6',
      'Identidade & Perfil': '#8B5CF6',
      'Comunicação & Comportamento': '#EC4899',
      'Rotinas & Horários': '#10B981',
      'Dispositivos & Hardware': '#F59E0B',
      'Ambiente & Interface': '#FF2B2B',
      'Segurança & Governança': '#06B6D4',
      'Geral': '#888888'
    };

    return Array.from(clusterMap.entries()).map(([name, count], idx) => ({
      id: `cluster-${idx}`,
      name,
      description: `Agrupamento semântico ativo com ${count} memórias mapeadas`,
      color: clusterColors[name] || '#FF2B2B',
      entriesCount: count
    }));
  }
}

export const semanticMemoryEngine = new SemanticMemoryEngine();

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — Vector Store Local (Embeddings + Cosine Similarity)
 *
 * Fornece indexação vetorial em memória com persistência estruturada
 * (SQLite via StorageAdapter / fallback JSON local).
 */

import { semanticMemoryEngine } from '../semanticMemoryEngine';
import { storageAdapter } from '../storageAdapter';

export interface VectorRecord<T = Record<string, any>> {
  id: string;
  text: string;
  vector: number[];
  category: string;
  cluster: string;
  metadata: T;
  createdAt: string;
  updatedAt: string;
}

export interface VectorSearchOptions {
  topK?: number;
  threshold?: number;
  category?: string;
  cluster?: string;
}

export interface VectorSearchResult<T = Record<string, any>> {
  record: VectorRecord<T>;
  similarity: number;
}

export class VectorStore<T = Record<string, any>> {
  private tableName: string;
  private records = new Map<string, VectorRecord<T>>();
  private initialized = false;

  constructor(tableName = 'vector_embeddings') {
    this.tableName = tableName;
  }

  /**
   * Inicializa o VectorStore carregando registros persistidos
   */
  public async init(): Promise<void> {
    if (this.initialized) return;
    try {
      const saved = await storageAdapter.loadAll<VectorRecord<T>>(this.tableName);
      if (Array.isArray(saved)) {
        for (const item of saved) {
          if (item && item.id && Array.isArray(item.vector)) {
            this.records.set(item.id, item);
          }
        }
      }
    } catch (e) {
      console.warn(`[VectorStore] Erro ao carregar registros de '${this.tableName}':`, e);
    }
    this.initialized = true;
  }

  /**
   * Insere ou atualiza um registro com seu vetor de embedding gerado
   */
  public async upsert(
    id: string,
    text: string,
    category = 'general',
    metadata: T = {} as T
  ): Promise<VectorRecord<T>> {
    const vector = semanticMemoryEngine.generateEmbedding(text);
    const cluster = semanticMemoryEngine.detectCluster({
      id,
      category: category as any,
      key: text.slice(0, 32),
      value: text,
      confidence: 1.0,
      updatedAt: new Date().toISOString()
    });

    const now = new Date().toISOString();
    const existing = this.records.get(id);

    const record: VectorRecord<T> = {
      id,
      text,
      vector,
      category,
      cluster,
      metadata,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now
    };

    this.records.set(id, record);

    // Persiste assincronamente no storageAdapter (SQLite)
    storageAdapter.save(this.tableName, id, record).catch((err) => {
      console.warn(`[VectorStore] Falha ao persistir vetor '${id}':`, err);
    });

    return record;
  }

  /**
   * Remove um registro do banco vetorial
   */
  public async delete(id: string): Promise<boolean> {
    const existed = this.records.delete(id);
    if (existed) {
      storageAdapter.delete(this.tableName, id).catch(() => {});
    }
    return existed;
  }

  /**
   * Busca os K vizinhos mais próximos por similaridade de cosseno
   */
  public search(query: string, options: VectorSearchOptions = {}): VectorSearchResult<T>[] {
    const { topK = 5, threshold = 0.25, category, cluster } = options;
    const queryVector = semanticMemoryEngine.generateEmbedding(query);

    const results: VectorSearchResult<T>[] = [];

    for (const record of this.records.values()) {
      if (category && record.category !== category) continue;
      if (cluster && record.cluster !== cluster) continue;

      const similarity = semanticMemoryEngine.cosineSimilarity(queryVector, record.vector);

      if (similarity >= threshold) {
        results.push({ record, similarity });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  /**
   * Retorna um registro pelo ID
   */
  public get(id: string): VectorRecord<T> | undefined {
    return this.records.get(id);
  }

  /**
   * Retorna todos os registros indexados
   */
  public listAll(): VectorRecord<T>[] {
    return Array.from(this.records.values());
  }

  /**
   * Limpa o banco vetorial
   */
  public async clear(): Promise<void> {
    this.records.clear();
  }

  /**
   * Contagem de vetores armazenados
   */
  public get size(): number {
    return this.records.size;
  }
}

export const defaultVectorStore = new VectorStore();


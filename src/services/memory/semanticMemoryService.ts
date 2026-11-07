/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — Serviço Unificado de Memória Semântica Avançada
 *
 * Coordena a camada híbrida de persistência:
 *  - SQLite / StorageAdapter (relacional/transacional)
 *  - VectorStore (busca vetorial semântica por similaridade de cosseno)
 *  - MarkdownMemorySync (arquivos canônicos legíveis em ~/.liora/memory)
 */

import { MemoryEntry } from '../../types';
import { defaultVectorStore, VectorStore } from './vectorStore';
import { markdownMemorySync, MarkdownMemorySync } from './markdownSync';
import { semanticMemoryEngine, SemanticSearchOptions, SemanticSearchResult } from '../semanticMemoryEngine';
import { storageAdapter } from '../storageAdapter';
import { formatMemoryContextBlock, rankMemories } from '../../utils/memoryRanker';

export class SemanticMemoryService {
  private vectorStore: VectorStore;
  private markdownSync: MarkdownMemorySync;
  private memoryCache = new Map<string, MemoryEntry>();
  private initialized = false;

  constructor(
    vectorStore: VectorStore = defaultVectorStore,
    markdownSync: MarkdownMemorySync = markdownMemorySync
  ) {
    this.vectorStore = vectorStore;
    this.markdownSync = markdownSync;
  }

  /**
   * Inicializa o serviço carregando memórias do SQLite, VectorStore e Markdown
   */
  public async init(): Promise<void> {
    if (this.initialized) return;

    await this.vectorStore.init();

    // 1. Carrega do SQLite (ou StorageAdapter)
    try {
      const records = await storageAdapter.loadAll<MemoryEntry>('memories');
      if (Array.isArray(records)) {
        for (const item of records) {
          if (item && item.id) {
            this.memoryCache.set(item.id, item);
            await this.vectorStore.upsert(
              item.id,
              `${item.category} ${item.key}: ${item.value}`,
              item.category,
              { key: item.key, value: item.value, confidence: item.confidence }
            );
          }
        }
      }
    } catch (e) {
      console.warn('[SemanticMemoryService] Falha ao carregar do storageAdapter:', e);
    }

    // 2. Sincroniza com arquivos Markdown do disco (se disponíveis)
    try {
      const mdEntries = await this.markdownSync.syncFromDisk();
      for (const entry of mdEntries) {
        if (!this.memoryCache.has(entry.id)) {
          this.memoryCache.set(entry.id, entry);
          await this.vectorStore.upsert(
            entry.id,
            `${entry.category} ${entry.key}: ${entry.value}`,
            entry.category,
            { key: entry.key, value: entry.value, confidence: entry.confidence }
          );
        }
      }
    } catch (e) {
      console.warn('[SemanticMemoryService] Falha na sincronização com Markdown:', e);
    }

    this.initialized = true;
  }

  /**
   * Armazena estruturadamente um novo fato, preferência ou nota
   */
  public async storeFact(
    category: MemoryEntry['category'],
    key: string,
    value: string,
    confidence = 1.0
  ): Promise<MemoryEntry> {
    await this.init();

    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const entry: MemoryEntry = {
      id,
      category,
      key: key.trim(),
      value: value.trim(),
      confidence: Math.max(0.1, Math.min(1.0, confidence)),
      updatedAt: new Date().toISOString()
    };

    // 1. Cache em memória
    this.memoryCache.set(id, entry);

    // 2. Persistência relacional no SQLite
    await storageAdapter.save('memories', id, entry);

    // 3. Indexação no banco vetorial
    await this.vectorStore.upsert(
      id,
      `${category} ${entry.key}: ${entry.value}`,
      category,
      { key: entry.key, value: entry.value, confidence: entry.confidence }
    );

    // 4. Sincronização assíncrona com os arquivos Markdown
    this.markdownSync.syncToDisk(Array.from(this.memoryCache.values())).catch((err) => {
      console.warn('[SemanticMemoryService] Falha ao atualizar arquivos Markdown:', err);
    });

    return entry;
  }

  /**
   * Realiza busca semântica híbrida (vetores de cosseno + lexical)
   */
  public search(query: string, options: SemanticSearchOptions = {}): SemanticSearchResult[] {
    const entries = Array.from(this.memoryCache.values());
    return semanticMemoryEngine.search(query, entries, options);
  }

  /**
   * Busca vetorial pura via VectorStore
   */
  public vectorSearch(query: string, topK = 5, threshold = 0.25) {
    return this.vectorStore.search(query, { topK, threshold });
  }

  /**
   * Constrói o bloco de prompt de contexto de longo prazo para injeção no LLM
   */
  public getContextPrompt(query: string, maxCharacterBudget = 500): string {
    const entries = Array.from(this.memoryCache.values());
    if (entries.length === 0) return '';

    const ranked = rankMemories(query, entries, {
      maxInjectedMemories: 5,
      maxCharacterBudget,
      enableSemanticBoosting: true,
      minScoreThreshold: 0.25
    });

    return formatMemoryContextBlock(ranked, maxCharacterBudget);
  }

  /**
   * Retorna todas as memórias ativas
   */
  public getAllMemories(): MemoryEntry[] {
    return Array.from(this.memoryCache.values());
  }

  /**
   * Remove uma memória pelo ID
   */
  public async deleteMemory(id: string): Promise<boolean> {
    const existed = this.memoryCache.delete(id);
    if (existed) {
      await this.vectorStore.delete(id);
      await storageAdapter.delete('memories', id);
      this.markdownSync.syncToDisk(Array.from(this.memoryCache.values())).catch(() => {});
    }
    return existed;
  }
}

export const semanticMemoryService = new SemanticMemoryService();


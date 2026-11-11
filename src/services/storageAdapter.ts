/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { isTauriEnvironment, invokeTauri } from '../security/localBridge';

export interface StorageRecord<T = any> {
  id: string;
  table: string;
  payload: T;
  version: number;
  updatedAt: string;
}

/**
 * Adaptador Transacional de Armazenamento da LIORA (Item 2 & Fase 4 do Plano de Ação)
 * Substitui o acoplamento frágil com localStorage puro, oferecendo interface assíncrona
 * pronta para conexão com SQLite local via plugin Tauri no ambiente desktop nativo.
 */
class StorageAdapter {
  private memoryCache = new Map<string, Map<string, any>>();

  /**
   * Grava um registro de forma segura (SQLite no Desktop ou LocalStorage transacional no Web)
   */
  public async save<T>(table: string, id: string, data: T): Promise<boolean> {
    const now = new Date().toISOString();
    const record: StorageRecord<T> = {
      id,
      table,
      payload: data,
      version: 1,
      updatedAt: now
    };

    // Atualiza cache em memória
    if (!this.memoryCache.has(table)) {
      this.memoryCache.set(table, new Map());
    }
    this.memoryCache.get(table)!.set(id, record);

    // 1. Caminho Desktop Nativo: Invocação SQLite via Tauri IPC
    if (isTauriEnvironment()) {
      try {
        return await invokeTauri<boolean>('save_sqlite_record', {
          table,
          id,
          payloadJson: JSON.stringify(data)
        });
      } catch (err) {
        console.warn(`[StorageAdapter] Erro no SQLite nativo para tabela '${table}':`, err);
      }
    }

    // 2. Caminho Web Preview: Armazenamento estruturado particionado
    if (typeof localStorage !== 'undefined') {
      try {
        const storageKey = `liora_db_${table}`;
        const existingRaw = localStorage.getItem(storageKey);
        const records: Record<string, any> = existingRaw ? JSON.parse(existingRaw) : {};
        records[id] = record;
        localStorage.setItem(storageKey, JSON.stringify(records));
        return true;
      } catch (e) {
        console.warn(`[StorageAdapter] Falha ao persistir dados na tabela '${table}':`, e);
        return false;
      }
    }

    // 3. Fallback para ambiente sem localStorage (ex: Node test runner, worker, SSR)
    return true;
  }

  /**
   * Carrega todos os registros de uma tabela
   */
  public async loadAll<T>(table: string): Promise<T[]> {
    // 1. Caminho Desktop Nativo (SQLite)
    if (isTauriEnvironment()) {
      try {
        const results = await invokeTauri<Array<{ payloadJson: string }>>('load_sqlite_records', { table });
        if (Array.isArray(results)) {
          const list: T[] = [];
          for (const r of results) {
            try {
              if (r?.payloadJson) {
                list.push(JSON.parse(r.payloadJson) as T);
              }
            } catch {}
          }
          return list;
        }
      } catch (err) {
        console.warn(`[StorageAdapter] Erro ao ler SQLite na tabela '${table}':`, err);
      }
    }

    // 2. Caminho Web Preview
    if (typeof localStorage !== 'undefined') {
      try {
        const storageKey = `liora_db_${table}`;
        const raw = localStorage.getItem(storageKey);
        if (raw) {
          const records: Record<string, StorageRecord<T>> = JSON.parse(raw);
          return Object.values(records)
            .map(r => r?.payload)
            .filter((p): p is T => p !== undefined && p !== null);
        }
      } catch (e) {
        console.warn(`[StorageAdapter] Erro ao ler tabela '${table}':`, e);
      }
    }

    // Fallback para cache de memória
    if (this.memoryCache.has(table)) {
      return Array.from(this.memoryCache.get(table)!.values()).map((r: StorageRecord<T>) => r.payload);
    }

    return [];
  }

  /**
   * Remove um registro de uma tabela
   */
  public async remove(table: string, id: string): Promise<boolean> {
    let memoryExisted = false;
    if (this.memoryCache.has(table)) {
      memoryExisted = this.memoryCache.get(table)!.delete(id);
    }

    if (isTauriEnvironment()) {
      try {
        return await invokeTauri<boolean>('delete_sqlite_record', { table, id });
      } catch (err) {
        console.warn(`[StorageAdapter] Erro ao deletar no SQLite:`, err);
      }
    }

    if (typeof localStorage !== 'undefined') {
      try {
        const storageKey = `liora_db_${table}`;
        const existingRaw = localStorage.getItem(storageKey);
        if (existingRaw) {
          const records: Record<string, any> = JSON.parse(existingRaw);
          const existed = id in records;
          delete records[id];
          localStorage.setItem(storageKey, JSON.stringify(records));
          return existed;
        }
      } catch (e) {
        console.warn(`[StorageAdapter] Erro ao remover id '${id}' da tabela '${table}':`, e);
      }
    }

    return memoryExisted;
  }

  /** Alias para remove */
  public async delete(table: string, id: string): Promise<boolean> {
    return this.remove(table, id);
  }

  /**
   * Exporta um backup transacional completo de todas as tabelas em formato JSON unificado
   */
  public async exportFullBackup(): Promise<string> {
    const backup: Record<string, any> = {
      timestamp: new Date().toISOString(),
      schemaVersion: '1.0.0',
      tables: {}
    };

    const tables = ['sessions', 'memories', 'settings', 'automations', 'devices', 'audit_logs'];
    for (const table of tables) {
      backup.tables[table] = await this.loadAll(table);
    }

    return JSON.stringify(backup, null, 2);
  }
}

export const storageAdapter = new StorageAdapter();

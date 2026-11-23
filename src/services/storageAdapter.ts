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
   * Remove todos os registros de uma tabela (memória e localStorage) para restauração limpa
   */
  public async clearTable(table: string): Promise<void> {
    if (this.memoryCache.has(table)) {
      this.memoryCache.get(table)!.clear();
    }

    if (isTauriEnvironment()) {
      try {
        await invokeTauri<boolean>('clear_sqlite_table', { table });
      } catch (err) {
        // Fallback defensivo: tenta remover individualmente se comando nativo falhar
        try {
          const records = await invokeTauri<Array<{ id: string; payloadJson: string }>>('load_sqlite_records', { table });
          if (Array.isArray(records)) {
            for (const r of records) {
              if (r?.id) {
                await invokeTauri<boolean>('delete_sqlite_record', { table, id: r.id }).catch(() => {});
              }
            }
          }
        } catch {}
      }
    }

    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(`liora_db_${table}`);
      } catch (e) {
        console.warn(`[StorageAdapter] Falha ao limpar tabela '${table}':`, e);
      }
    }
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

  /**
   * CORREÇÃO (bug de falsa promessa — havia export mas NUNCA import): restaura
   * um backup JSON completo gerado por exportFullBackup. Estratégia por tabela:
   * limpa registros obsoletos da tabela antes de gravar, grava cada registro
   * no Desktop (SQLite) ou Web (localStorage) e atualiza o cache em memória.
   */
  public async restoreFromBackup(backupJson: string): Promise<{ success: boolean; restored: Record<string, number>; error?: string }> {
    const restored: Record<string, number> = {};
    try {
      const backup = JSON.parse(backupJson);
      if (!backup || typeof backup !== 'object' || !backup.tables || typeof backup.tables !== 'object') {
        return { success: false, restored, error: 'BACKUP_INVALID: arquivo sem a estrutura esperada { tables: {...} }.' };
      }

      for (const [table, records] of Object.entries(backup.tables as Record<string, any[]>)) {
        if (!Array.isArray(records)) continue;
        await this.clearTable(table);
        let count = 0;
        for (const payload of records) {
          if (payload === null || payload === undefined) continue;
          const defaultKey =
            table === 'sessions'
              ? 'history_payload'
              : table === 'settings'
                ? 'global_preferences'
                : table === 'memories' && Array.isArray(payload)
                  ? 'collection'
                  : table === 'automations' && Array.isArray(payload)
                    ? 'rules_collection'
                    : table === 'devices' && Array.isArray(payload)
                      ? 'paired_list'
                      : `restore-${table}-${count}`;
          const id = (payload as any)?.id || defaultKey;
          try {
            await this.save(table, String(id), payload);
            count++;
          } catch { /* registro individual falho não aborta o restore */ }
        }
        restored[table] = count;
      }

      return { success: true, restored };
    } catch (err: any) {
      return { success: false, restored, error: err?.message || 'BACKUP_PARSE_FAILED: JSON inválido.' };
    }
  }
}

export const storageAdapter = new StorageAdapter();

/**
 * Lê uma lista JSON persistida no localStorage de forma tolerante a falhas.
 * Retorna `[]` quando a chave não existe, o JSON é inválido ou não é um array —
 * os callers nunca precisam repetir try/catch + Array.isArray.
 */
export function readJsonList<T = unknown>(key: string): T[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (err) {
    console.warn(`[StorageAdapter] Falha ao ler lista JSON '${key}':`, err);
    return [];
  }
}

/**
 * Grava uma lista JSON no localStorage aplicando um limite de itens (os mais
 * recentes ficam no início). Silencioso quando não há localStorage.
 */
export function writeJsonList<T = unknown>(key: string, list: T[], limit?: number): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    const payload = typeof limit === 'number' ? list.slice(0, limit) : list;
    localStorage.setItem(key, JSON.stringify(payload));
    return true;
  } catch (err) {
    console.warn(`[StorageAdapter] Falha ao gravar lista JSON '${key}':`, err);
    return false;
  }
}

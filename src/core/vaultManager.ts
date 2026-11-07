/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — FASE 4: COFRE CRIPTOGRAFADO LOCAL (Security Vault)
 *
 * Armazenamento ultra-seguro de credenciais em ~/.liora/security/vault.enc.
 *
 * Arquitetura criptográfica:
 *  - AES-256-GCM (autenticado: confidencialidade + integridade)
 *  - Derivação de chave: scrypt (N=16384, r=8, p=1) com salt único aleatório
 *    de 32 bytes por cofre — resistente a brute-force/dicionário
 *  - IV de 12 bytes aleatório por gravação (nunca reutilizado)
 *  - AuthTag de 16 bytes verificado a cada abertura (tamper-evident)
 *
 * Gestão da chave mestra:
 *  - LIORA_VAULT_MASTER_KEY (env) tem prioridade — para usuários avançados
 *  - Caso ausente, gera/usa ~/.liora/security/.vaultkey (chmod 600 no POSIX),
 *    chave aleatória de 32 bytes gerada por crypto.randomBytes na primeira
 *    execução. O cofre fica restrito à máquina (a chave não sai do disco local).
 *
 * Anti-vazamento: os métodos de log nunca incluem segredos; os valores são
 * retornados apenas por retorna explícito via ferramenta R2 com consentimento.
 */

import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

const VAULT_DIR = path.join(os.homedir(), '.liora', 'security');
const VAULT_FILE = path.join(VAULT_DIR, 'vault.enc');
const KEY_FILE = path.join(VAULT_DIR, '.vaultkey');

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 };
const MAGIC = 'LVR1'; // identificador de versão do formato

export interface VaultEntry {
  /** valor secreto (nunca logado) */
  value: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

interface VaultPayload {
  entries: Record<string, VaultEntry>;
}

class VaultManager {
  private cache: VaultPayload | null = null;
  // CORREÇÃO (Etapa C — race condition): operações de escrita são SERIALIZADAS
  // através de uma fila de promessas. Sem isso, duas chamadas simultâneas
  // (ex: salvar credencial de e-mail + salvar token de API ao mesmo tempo)
  // executavam load()→mutação→save() em paralelo e a SEGUNDA gravação
  // sobrescrevia a primeira — perda silenciosa de credencial (e pior: com o
  // cache compartilhado, o `get` podia ler estado inconsistente no meio).
  private writeChain: Promise<unknown> = Promise.resolve();

  /** Serializa uma operação de escrita: cada uma espera a anterior terminar */
  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const chained = this.writeChain.then(op, op);
    // Não propaga a falha para o próximo da fila (cada op trata seus próprios erros)
    this.writeChain = chained.catch(() => undefined);
    return chained;
  }

  /** Obtém (ou cria) a chave mestra local */
  private async getMasterKey(): Promise<Buffer> {
    const envKey = process.env.LIORA_VAULT_MASTER_KEY;
    if (envKey && envKey.length >= 16) {
      return crypto.createHash('sha256').update(envKey).digest();
    }
    await fsp.mkdir(VAULT_DIR, { recursive: true });
    if (fs.existsSync(KEY_FILE)) {
      const stored = await fsp.readFile(KEY_FILE);
      if (stored.length === 32) return stored;
    }
    const fresh = crypto.randomBytes(32);
    await fsp.writeFile(KEY_FILE, fresh, { mode: 0o600 });
    return fresh;
  }

  /** Deriva a chave de criptografia via scrypt (salt único do cofre) */
  private deriveKey(masterKey: Buffer, salt: Buffer): Buffer {
    return crypto.scryptSync(masterKey, salt, SCRYPT_PARAMS.keylen, {
      N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p
    });
  }

  /** Criptografa o payload inteiro (AES-256-GCM) */
  private encrypt(plaintext: string, masterKey: Buffer): string {
    const salt = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const key = this.deriveKey(masterKey, salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Formato: MAGIC|salt|iv|tag|data (base64 por segmento)
    return [MAGIC, salt.toString('base64'), iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('|');
  }

  /** Decripta e verifica integridade (GCM rejeita tampers) */
  private decrypt(blob: string, masterKey: Buffer): string {
    const parts = blob.split('|');
    if (parts.length !== 5 || parts[0] !== MAGIC) {
      throw new Error('VAULT_CORRUPT: arquivo do cofre inválido ou de versão desconhecida.');
    }
    const [, saltB64, ivB64, tagB64, dataB64] = parts;
    const key = this.deriveKey(masterKey, Buffer.from(saltB64, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return dec.toString('utf8');
  }

  /** Carrega (e decripta) o cofre do disco */
  private async load(): Promise<VaultPayload> {
    if (this.cache) return this.cache;
    const masterKey = await this.getMasterKey();
    try {
      if (!fs.existsSync(VAULT_FILE)) {
        this.cache = { entries: {} };
        return this.cache;
      }
      const blob = await fsp.readFile(VAULT_FILE, 'utf8');
      const json = this.decrypt(blob.trim(), masterKey);
      const parsed = JSON.parse(json);
      this.cache = { entries: parsed.entries || {} };
    } catch (err: any) {
      if (String(err?.message).includes('VAULT_CORRUPT')) throw err;
      throw new Error('VAULT_DECRYPT_FAILED: não foi possível decriptar o cofre (chave mestra alterada ou arquivo corrompido).');
    }
    return this.cache;
  }

  /** Salva o cofre criptografado no disco */
  private async save(payload: VaultPayload): Promise<void> {
    const masterKey = await this.getMasterKey();
    await fsp.mkdir(VAULT_DIR, { recursive: true });
    const blob = this.encrypt(JSON.stringify(payload), masterKey);
    // Escrita atômica: tmp + rename
    const tmp = `${VAULT_FILE}.tmp`;
    await fsp.writeFile(tmp, blob, 'utf8');
    await fsp.rename(tmp, VAULT_FILE);
    this.cache = payload;
  }

  /** Armazena/atualiza um segredo — SERIALIZADO (anti race condition) */
  public async set(key: string, value: string, description?: string): Promise<{ success: boolean; error?: string }> {
    return this.serialize(() => this._set(key, value, description));
  }

  private async _set(key: string, value: string, description?: string): Promise<{ success: boolean; error?: string }> {
    if (!key || typeof key !== 'string') return { success: false, error: 'INVALID_KEY: identificador vazio ou inválido.' };
    const cleanKey = key.trim().slice(0, 120);
    if (!/^[a-zA-Z0-9._\-:\/]+$/.test(cleanKey)) {
      return { success: false, error: 'INVALID_KEY_FORMAT: use apenas letras, números e . _ - : /' };
    }
    if (!value || typeof value !== 'string') return { success: false, error: 'INVALID_VALUE: valor do segredo vazio.' };
    if (value.length > 10000) return { success: false, error: 'VALUE_TOO_LARGE: segredo excede 10000 caracteres.' };

    const vault = await this.load();
    const now = new Date().toISOString();
    const existing = vault.entries[cleanKey];
    vault.entries[cleanKey] = {
      value,
      description: description?.slice(0, 300),
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    await this.save(vault);
    return { success: true };
  }

  /** Recupera um segredo (retorna o valor — usado apenas por fluxo R2 consentido) */
  public async get(key: string): Promise<{ success: boolean; value?: string; description?: string; createdAt?: string; updatedAt?: string; error?: string }> {
    const vault = await this.load();
    const entry = vault.entries[(key || '').trim()];
    if (!entry) return { success: false, error: `NOT_FOUND: credencial '${key}' não existe no cofre.` };
    return { success: true, value: entry.value, description: entry.description, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
  }

  /** Lista apenas identificadores — NUNCA valores */
  public async list(): Promise<Array<{ key: string; description?: string; updatedAt: string; hasValue: true }>> {
    const vault = await this.load();
    return Object.entries(vault.entries).map(([key, e]) => ({
      key,
      description: e.description,
      updatedAt: e.updatedAt,
      hasValue: true as const
    }));
  }

  /** Remove uma credencial — SERIALIZADO (anti race condition) */
  public async delete(key: string): Promise<{ success: boolean; error?: string }> {
    return this.serialize(() => this._delete(key));
  }

  private async _delete(key: string): Promise<{ success: boolean; error?: string }> {
    const vault = await this.load();
    const cleanKey = (key || '').trim();
    if (!vault.entries[cleanKey]) return { success: false, error: `NOT_FOUND: credencial '${cleanKey}' não existe no cofre.` };
    delete vault.entries[cleanKey];
    await this.save(vault);
    return { success: true };
  }

  /** Verifica a integridade do cofre (abre e fecha sem expor valores) */
  public async health(): Promise<{ ok: boolean; entries: number; error?: string }> {
    try {
      const vault = await this.load();
      return { ok: true, entries: Object.keys(vault.entries).length };
    } catch (err: any) {
      return { ok: false, entries: 0, error: err?.message };
    }
  }

  /** Invalida o cache em memória (para testes) */
  public resetCache(): void {
    this.cache = null;
  }
}

/** Singleton global do cofre criptografado */
export const vaultManager = new VaultManager();

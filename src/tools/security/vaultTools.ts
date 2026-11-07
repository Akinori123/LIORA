/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — FASE 4: FERRAMENTAS DO COFRE CRIPTOGRAFADO (Security Vault)
 *
 * Expõe o cofre local ao modelo via tool calling:
 *  - vault_store_credential    (R2) — armazena/atualiza segredo (consentimento HMAC)
 *  - vault_get_credential      (R2) — recupera segredo (consentimento HMAC)
 *  - vault_list_keys           (R1) — lista apenas identificadores (nunca valores)
 *  - vault_delete_credential   (R2) — remove credencial (consentimento HMAC)
 *  - vault_health_check        (R1) — integridade do cofre
 *
 * ANTI-VAZAMENTO: os valores retornados por vault_get_credential são destinados
 * ao fluxo de ferramentas autenticadas (ex: SMTP, APIs) — a resposta da tool
 * inclui o valor somente no campo estruturado `value`, e as mensagens de
 * status/logs nunca o reproduzem.
 */

import { ToolDefinition } from '../types';
import { vaultManager } from '../../core/vaultManager';

/**
 * vault_store_credential (R2) — armazena ou atualiza um segredo.
 */
export const vaultStoreCredentialTool: ToolDefinition<{
  key: string;
  value: string;
  description?: string;
}, any> = {
  name: 'vault_store_credential',
  description: 'Armazena ou atualiza um segredo (senha, chave de API, token) no Cofre Criptografado Local da LIORA — criptografia AES-256-GCM com derivação scrypt. AÇÃO SENSÍVEL (R2) — exige consentimento do operador. Use quando o usuário pedir "guarde esta senha", "salve minha chave no cofre".',
  category: 'system',
  riskLevel: 'R2',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Identificador da credencial (ex: "smtp.main", "api.stripe.key"). Máx 120 caracteres.' },
      value: { type: 'string', description: 'O segredo a armazenar (máx 10000 caracteres). Nunca é logado.' },
      description: { type: 'string', description: 'Descrição opcional para identificação (ex: "SMTP principal do Gmail").' }
    },
    required: ['key', 'value'],
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'simulated'] },
  execute: async (params) => {
    const res = await vaultManager.set(params.key || '', params.value || '', params.description);
    if (!res.success) {
      return { success: false, error: res.error, simulated: false, timestamp: new Date().toISOString() };
    }
    // Mensagem NUNCA inclui o valor
    return {
      success: true,
      key: params.key,
      operation: 'stored',
      message: `Credencial '${params.key}' armazenada no cofre criptografado com sucesso.`,
      simulated: false,
      timestamp: new Date().toISOString()
    };
  }
};

/**
 * vault_get_credential (R2) — recupera um segredo para uso interno.
 */
export const vaultGetCredentialTool: ToolDefinition<{ key: string }, any> = {
  name: 'vault_get_credential',
  description: 'Recupera um segredo armazenado no Cofre Criptografado Local para uso em ferramentas autenticadas (SMTP, APIs). AÇÃO SENSÍVEL (R2) — exige consentimento do operador. O valor é entregue apenas no campo estruturado da resposta e nunca é reproduzido em logs ou mensagens.',
  category: 'system',
  riskLevel: 'R2',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Identificador da credencial a recuperar.' }
    },
    required: ['key'],
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'simulated'] },
  execute: async (params) => {
    const res = await vaultManager.get(params.key || '');
    if (!res.success) {
      return { success: false, error: res.error, simulated: false, timestamp: new Date().toISOString() };
    }
    return {
      success: true,
      key: params.key,
      value: res.value, // somente no campo estruturado — ferramentas consomem, logs não
      description: res.description,
      updatedAt: res.updatedAt,
      simulated: false,
      timestamp: new Date().toISOString()
    };
  }
};

/**
 * vault_list_keys (R1) — lista identificadores sem expor valores.
 */
export const vaultListKeysTool: ToolDefinition<Record<string, never>, any> = {
  name: 'vault_list_keys',
  description: 'Lista os identificadores das credenciais guardadas no Cofre Criptografado — NUNCA revela os valores. Use para "quais credenciais estão no cofre", "liste minhas chaves salvas".',
  category: 'system',
  riskLevel: 'R1',
  isSimulated: false,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object', requiredFields: ['success', 'keys', 'simulated'] },
  execute: async () => {
    try {
      const keys = await vaultManager.list();
      return {
        success: true,
        keys,
        count: keys.length,
        message: `${keys.length} credencial(is) no cofre (valores protegidos — use vault_get_credential com consentimento para recuperar).`,
        simulated: false,
        timestamp: new Date().toISOString()
      };
    } catch (err: any) {
      return { success: false, error: err?.message || 'VAULT_ERROR', keys: [], simulated: false, timestamp: new Date().toISOString() };
    }
  }
};

/**
 * vault_delete_credential (R2) — remove uma credencial.
 */
export const vaultDeleteCredentialTool: ToolDefinition<{ key: string }, any> = {
  name: 'vault_delete_credential',
  description: 'Remove permanentemente uma credencial do Cofre Criptografado. AÇÃO DESTRUTIVA (R2) — exige consentimento do operador. Use quando o usuário pedir "apague a senha X do cofre", "remova essa credencial".',
  category: 'system',
  riskLevel: 'R2',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Identificador da credencial a remover.' }
    },
    required: ['key'],
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'simulated'] },
  execute: async (params) => {
    const res = await vaultManager.delete(params.key || '');
    if (!res.success) {
      return { success: false, error: res.error, simulated: false, timestamp: new Date().toISOString() };
    }
    return {
      success: true,
      key: params.key,
      operation: 'deleted',
      message: `Credencial '${params.key}' removida do cofre permanentemente.`,
      simulated: false,
      timestamp: new Date().toISOString()
    };
  }
};

/**
 * vault_health_check (R1) — integridade do cofre sem expor valores.
 */
export const vaultHealthCheckTool: ToolDefinition<Record<string, never>, any> = {
  name: 'vault_health_check',
  description: 'Verifica a integridade do Cofre Criptografado: abre e valida a assinatura criptográfica sem revelar valores. Use para diagnóstico ("o cofre está íntegro?").',
  category: 'system',
  riskLevel: 'R1',
  isSimulated: false,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object', requiredFields: ['success', 'ok', 'simulated'] },
  execute: async () => {
    const health = await vaultManager.health();
    return {
      success: true,
      ok: health.ok,
      entries: health.entries,
      error: health.error,
      message: health.ok
        ? `Cofre íntegro — ${health.entries} credencial(is) protegida(s) por AES-256-GCM.`
        : `Cofre com problema de integridade: ${health.error}`,
      simulated: false,
      timestamp: new Date().toISOString()
    };
  }
};

/** Export para registro em massa */
export const allVaultTools: ToolDefinition<any, any>[] = [
  vaultStoreCredentialTool,
  vaultGetCredentialTool,
  vaultListKeysTool,
  vaultDeleteCredentialTool,
  vaultHealthCheckTool
];

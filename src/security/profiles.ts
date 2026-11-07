/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { SecurityProfileConfig, SecurityProfileName } from './types';

/**
 * Perfil padrão inicial STRICT:
 * - Ferramentas R0 de leitura/consulta na lista branca, incluindo as nativas reais
 *   instaladas pelo servidor (system_info, env_safe) e a rota real via OSRM.
 * - 'workspace_read_file' permanece expressamente fora da lista branca nesta fase.
 * - R1 e R2: NÃO executáveis sem consentimento — mas autorizáveis com token HMAC
 *   de consentimento explícito (consumeConsentToken anti-replay), conforme o fluxo
 *   do ConsentCard. allowR2=false significa "nunca executar R2 sem consentimento",
 *   não "nunca executar R2". R3 permanece categoricamente bloqueado.
 */
export const STRICT_PROFILE: Readonly<SecurityProfileConfig> = Object.freeze({
  profileName: 'STRICT',
  allowedTools: Object.freeze([
    'system_info',
    'system_read_env_safe',
    'calculate_route',
    'fetchNews',
    'list_processes',
    'workspace_search_files',
    'browser_extract_text',
    'browser_screenshot',
    'browser_close_session',
    'getSystemStatus',
    'memory_semantic_search',
    'memory_list_context',
    'code_search_symbols',
    'code_grep',
    'code_read_file',
    'git_status',
    'git_diff',
    'iot_list_devices',
    'device_command',
    'open_gps_navigation',
    'maps_search_places',
    'resolve_place_alias',
    // NÚCLEO DE CONTROLE TOTAL DO PC (leitura real)
    'pc_take_screenshot',
    'file_search_and_read',
    // FASE 2: PRODUTIVIDADE — leitura (R1)
    'email_fetch_and_read',
    'calendar_list_events',
    // Escrita (R2 — executa apenas com consentimento HMAC)
    'email_send_or_reply',
    'calendar_create_event',
    // FASE 3: SUB-AGENTES — consulta (R1)
    'check_background_task_status',
    'list_background_tasks',
    // FASE 3: SUB-AGENTES — start/cancel (R2 — executa apenas com consentimento HMAC)
    'start_background_task',
    'cancel_background_task',
    // FASE 4: COFRE CRIPTOGRAFADO — listagem/health (R1, sem expor valores)
    'vault_list_keys',
    'vault_health_check',
    // FASE 4: COFRE CRIPTOGRAFADO — chave/valor (R2 — apenas com consentimento HMAC)
    'vault_store_credential',
    'vault_get_credential',
    'vault_delete_credential',
    // AGENTE WEB AUTÓNOMO (R2 — executa apenas com consentimento HMAC)
    'web_browser_agent'
  ]),
  deniedTools: Object.freeze(['workspace_read_file']),
  requireConfirmationForR1: true,
  allowR2: false as const,
  allowR3: false as const
});

/**
 * Perfil STANDARD (Inativo para despacho no Marco 6.2):
 * - Mantido com as mesmas restrições de execução de R1, R2 e R3 do perfil STRICT.
 * - Não concede privilégios implícitos.
 */
export const STANDARD_PROFILE: Readonly<SecurityProfileConfig> = Object.freeze({
  profileName: 'STANDARD',
  allowedTools: Object.freeze([
    'system_info',
    'system_read_env_safe',
    'calculate_route',
    'fetchNews',
    'list_processes',
    'workspace_search_files',
    'browser_extract_text',
    'browser_screenshot',
    'browser_close_session',
    'getSystemStatus',
    'memory_semantic_search',
    'memory_list_context',
    'code_search_symbols',
    'code_grep',
    'code_read_file',
    'git_status',
    'git_diff',
    'iot_list_devices',
    'open_gps_navigation',
    'maps_search_places'
  ]),
  deniedTools: Object.freeze([]),
  requireConfirmationForR1: true,
  allowR2: false as const,
  allowR3: false as const
});

/**
 * Perfil DEVELOPER (Inativo para despacho no Marco 6.2):
 * - Utilizado estritamente para inspeção de esquemas e testes de diagnóstico.
 * - Não concede privilégios implícitos nem bypass de segurança.
 */
export const DEVELOPER_PROFILE: Readonly<SecurityProfileConfig> = Object.freeze({
  profileName: 'DEVELOPER',
  allowedTools: Object.freeze([
    'system_info',
    'system_read_env_safe',
    'calculate_route',
    'fetchNews',
    'list_processes',
    'workspace_search_files',
    'browser_extract_text',
    'browser_screenshot',
    'browser_close_session',
    'getSystemStatus',
    'memory_semantic_search',
    'memory_list_context',
    'code_search_symbols',
    'code_grep',
    'code_read_file',
    'git_status',
    'git_diff',
    'iot_list_devices',
    'open_gps_navigation',
    'maps_search_places'
  ]),
  deniedTools: Object.freeze([]),
  requireConfirmationForR1: true,
  allowR2: false as const,
  allowR3: false as const
});

export const AVAILABLE_PROFILES: Readonly<Record<SecurityProfileName, Readonly<SecurityProfileConfig>>> = Object.freeze({
  STRICT: STRICT_PROFILE,
  STANDARD: STANDARD_PROFILE,
  DEVELOPER: DEVELOPER_PROFILE
});

/**
 * Validador de integridade estrutural de um perfil de segurança.
 * Retorna true apenas se a configuração estiver completa e em conformidade.
 */
export function isValidSecurityProfile(profile: unknown): profile is SecurityProfileConfig {
  if (!profile || typeof profile !== 'object') {
    return false;
  }

  const p = profile as Record<string, unknown>;

  if (p.profileName !== 'STRICT' && p.profileName !== 'STANDARD' && p.profileName !== 'DEVELOPER') {
    return false;
  }

  if (!Array.isArray(p.allowedTools) || !p.allowedTools.every(t => typeof t === 'string')) {
    return false;
  }

  if (p.deniedTools !== undefined && (!Array.isArray(p.deniedTools) || !p.deniedTools.every(t => typeof t === 'string'))) {
    return false;
  }

  if (typeof p.requireConfirmationForR1 !== 'boolean') {
    return false;
  }

  // Invariantes estritas de segurança
  if (p.allowR2 !== false || p.allowR3 !== false) {
    return false;
  }

  return true;
}

/**
 * Resolve e valida um perfil de segurança pelo nome ou objeto.
 * Em caso de perfil ausente, malformado ou desconhecido, retorna o perfil seguro padrão STRICT.
 */
export function resolveSecurityProfile(input?: unknown): Readonly<SecurityProfileConfig> {
  if (typeof input === 'string') {
    const uppercaseName = input.trim().toUpperCase() as SecurityProfileName;
    if (uppercaseName in AVAILABLE_PROFILES) {
      return AVAILABLE_PROFILES[uppercaseName];
    }
    return STRICT_PROFILE;
  }

  if (isValidSecurityProfile(input)) {
    return Object.freeze({
      profileName: input.profileName,
      allowedTools: Object.freeze([...input.allowedTools]),
      deniedTools: input.deniedTools ? Object.freeze([...input.deniedTools]) : undefined,
      requireConfirmationForR1: input.requireConfirmationForR1,
      allowR2: false as const,
      allowR3: false as const
    });
  }

  return STRICT_PROFILE;
}

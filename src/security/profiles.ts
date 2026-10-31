/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { SecurityProfileConfig, SecurityProfileName } from './types';

/**
 * Perfil padrão inicial STRICT:
 * - Apenas 'system_info' é elegível na lista branca inicial.
 * - 'workspace_read_file' permanece expressamente fora da lista branca nesta fase.
 * - R1, R2 e R3 permanecem categoricamente bloqueados para execução nesta fase.
 */
export const STRICT_PROFILE: Readonly<SecurityProfileConfig> = Object.freeze({
  profileName: 'STRICT',
  allowedTools: Object.freeze(['system_info', 'system_read_env_safe']),
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
  allowedTools: Object.freeze(['system_info', 'system_read_env_safe']),
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
  allowedTools: Object.freeze(['system_info', 'system_read_env_safe']),
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

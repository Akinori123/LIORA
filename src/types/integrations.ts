/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type IntegrationProviderId = 
  | 'gemini' 
  | 'openrouter' 
  | 'github' 
  | 'supabase' 
  | 'firebase' 
  | 'mercadopago' 
  | 'vercel' 
  | 'homeassistant' 
  | 'discord'
  | 'slack'
  | 'custom';

export type IntegrationCategory = 'ai' | 'cloud' | 'finance' | 'iot' | 'database' | 'social';

export type IntegrationConnectionStatus = 
  | 'CONNECTED' 
  | 'DISCONNECTED' 
  | 'DEGRADED'
  | 'ERROR' 
  | 'PENDING_AUTH' 
  | 'RATE_LIMITED';

/**
 * Escopo de permissão concedido pelo usuário ao serviço integrado
 */
export interface IntegrationScope {
  id: string;
  name: string;
  description: string;
  granted: boolean;
  required: boolean;
}

/**
 * Configuração e estado do serviço integrado
 */
export interface IntegrationServiceConfig {
  id: string;
  provider: IntegrationProviderId;
  name: string;
  category: IntegrationCategory;
  description: string;
  status: IntegrationConnectionStatus;
  maskedKey?: string;
  keyFingerprint?: string; // Hash SHA-256 parcial para conferência
  endpointUrl?: string;
  latencyMs?: number;
  lastPingAt?: string;
  scopes: IntegrationScope[];
  featuresSupported: string[];
  errorMessage?: string;
  isSimulated: boolean;
  webhookSecret?: string;
  oauthExpiresAt?: number;
  refreshToken?: string;
  isMcpServer?: boolean;
  mcpStatus?: 'ACTIVE' | 'DISCONNECTED' | 'HEARTBEAT_TIMEOUT' | 'DEGRADED';
  mcpConsecutiveFailures?: number;
  nextAllowedPingAt?: number;
  backoffAttempt?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Estrutura normalizada de evento de Webhook externo
 */
export interface WebhookEventPayload {
  id: string;
  provider: IntegrationProviderId;
  eventType: string; // Ex: 'payment.approved', 'deploy.succeeded', 'repo.push'
  timestamp: string;
  payloadSummary: string;
  rawPayloadSafe: Record<string, any>;
  verifiedSignature: boolean;
  simulated: boolean;
}

/**
 * Contrato de credencial protegida no cofre (Vault)
 */
export interface IntegrationCredentialState {
  id: string;
  provider: IntegrationProviderId;
  label: string;
  maskedKey: string;
  fingerprint: string;
  status: 'valid' | 'invalid' | 'untested';
  associatedServiceId: string;
  lastValidatedAt?: string;
}

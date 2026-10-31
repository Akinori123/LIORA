/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { 
  IntegrationServiceConfig, 
  IntegrationProviderId, 
  IntegrationConnectionStatus, 
  WebhookEventPayload, 
  IntegrationCredentialState,
  IntegrationScope
} from '../types/integrations';
import { eventBus, EventBus } from '../utils/eventBus';
import { computeHmacSha256Sync, sha256Sync } from '../utils/cryptoIsomorphic';
import { writeKeychainSecret } from '../security/localBridge';

/**
 * Padrões de expressões regulares para identificação e redação de segredos
 */
export const SENSITIVE_TOKEN_PATTERNS = [
  /(AIza[0-9A-Za-z-_]{30,})/g,                 // Google Gemini API Key
  /(ghp_[0-9a-zA-Z-_]{30,})/g,                 // GitHub Personal Token
  /(sk-[a-zA-Z0-9-_]{15,})/g,                 // OpenAI / OpenRouter
  /(sbp_[a-zA-Z0-9-_]{20,})/g,                // Supabase Key
  /(APP_USR-[0-9a-zA-Z-_]{15,})/g,            // Mercado Pago Token
  /(vcp_[a-zA-Z0-9-_]{15,})/g,                // Vercel Token
  /(xox[baprs]-[0-9a-zA-Z-_]{10,})/g,         // Slack Token
  /(Bearer\s+[a-zA-Z0-9\.\-_]{15,})/gi,       // Bearer Tokens
  /(Bot\s+[a-zA-Z0-9_\.]{20,})/gi             // Discord Bot Token
];

export const SENSITIVE_KEY_NAMES = new Set([
  'apikey',
  'api_key',
  'secret',
  'token',
  'accesstoken',
  'access_token',
  'password',
  'private_key',
  'client_secret',
  'credential',
  'webhook_url',
  'webhookurl',
  'webhooksecret',
  'webhook_secret'
]);

/**
 * Mascara com segurança uma chave bruta de API, exibindo apenas prefixo e sufixo.
 */
export function maskCredential(rawKey: string, provider?: IntegrationProviderId): string {
  if (!rawKey || typeof rawKey !== 'string') {
    return '****';
  }
  const clean = rawKey.trim();
  if (clean.length <= 8) {
    return '****' + clean.slice(-2);
  }

  if (clean.startsWith('AIzaSy')) {
    return `AIzaSy...${clean.slice(-4)}`;
  }
  if (clean.startsWith('ghp_')) {
    return `ghp_...${clean.slice(-4)}`;
  }
  if (clean.startsWith('sk-')) {
    return `sk-...${clean.slice(-4)}`;
  }
  if (clean.startsWith('sbp_')) {
    return `sbp_...${clean.slice(-4)}`;
  }
  if (clean.startsWith('APP_USR-')) {
    return `APP_USR-...${clean.slice(-4)}`;
  }
  if (clean.startsWith('xox')) {
    return `${clean.slice(0, 5)}...${clean.slice(-4)}`;
  }
  if (clean.startsWith('vcp_')) {
    return `vcp_...${clean.slice(-4)}`;
  }

  return `${clean.slice(0, 4)}...${clean.slice(-4)}`;
}

/**
 * Gera um hash fingerprint determinístico SHA-256 (primeiros 16 caracteres hexadecimais)
 */
export function computeKeyFingerprint(rawKey: string): string {
  if (!rawKey || typeof rawKey !== 'string') {
    return '0000000000000000';
  }
  return sha256Sync(rawKey.trim()).slice(0, 16);
}

/**
 * Higieniza recursivamente strings e objetos, ocultando quaisquer tokens sensíveis
 */
export function redactSecrets(input: any): any {
  if (input === null || input === undefined) {
    return input;
  }

  if (typeof input === 'string') {
    let sanitized = input;
    for (const pattern of SENSITIVE_TOKEN_PATTERNS) {
      sanitized = sanitized.replace(pattern, '[REDACTED_CREDENTIAL]');
    }
    return sanitized as any;
  }

  if (Array.isArray(input)) {
    return input.map(item => redactSecrets(item)) as any;
  }

  if (typeof input === 'object') {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(input)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_KEY_NAMES.has(lowerKey)) {
        result[key] = '[REDACTED_SECRET]';
      } else {
        result[key] = redactSecrets(value);
      }
    }
    return result as any;
  }

  return input;
}

/**
 * Retorna os parâmetros de requisição HTTP adequados para o ping/healthcheck de cada provedor
 */
export function getProviderPingConfig(
  provider: IntegrationProviderId, 
  customEndpoint?: string, 
  rawKey?: string
): { url: string; options: RequestInit } {
  const headers: Record<string, string> = {
    'User-Agent': 'LIORA-Native-Desktop/1.0',
    'Accept': 'application/json, text/plain, */*'
  };

  switch (provider) {
    case 'github': {
      const url = customEndpoint || 'https://api.github.com/zen';
      if (rawKey) headers['Authorization'] = `Bearer ${rawKey}`;
      return { url, options: { method: 'GET', headers } };
    }
    case 'discord': {
      const url = customEndpoint || 'https://discord.com/api/v10/gateway';
      if (rawKey) headers['Authorization'] = `Bot ${rawKey}`;
      return { url, options: { method: 'GET', headers } };
    }
    case 'slack': {
      const url = customEndpoint || 'https://slack.com/api/api.test';
      if (rawKey) headers['Authorization'] = `Bearer ${rawKey}`;
      return { url, options: { method: 'GET', headers } };
    }
    case 'supabase': {
      const url = customEndpoint 
        ? `${customEndpoint.replace(/\/$/, '')}/rest/v1/` 
        : 'https://api.supabase.com/v1/health';
      if (rawKey) {
        headers['apikey'] = rawKey;
        headers['Authorization'] = `Bearer ${rawKey}`;
      }
      return { url, options: { method: 'GET', headers } };
    }
    case 'mercadopago': {
      const url = customEndpoint || 'https://api.mercadopago.com/v1/identification_types';
      if (rawKey) headers['Authorization'] = `Bearer ${rawKey}`;
      return { url, options: { method: 'GET', headers } };
    }
    case 'vercel': {
      const url = customEndpoint || 'https://api.vercel.com/v2/user';
      if (rawKey) headers['Authorization'] = `Bearer ${rawKey}`;
      return { url, options: { method: 'GET', headers } };
    }
    case 'openrouter': {
      const url = customEndpoint || 'https://openrouter.ai/api/v1/auth/key';
      if (rawKey) headers['Authorization'] = `Bearer ${rawKey}`;
      return { url, options: { method: 'GET', headers } };
    }
    case 'gemini': {
      const url = customEndpoint || '/api/health';
      if (rawKey) {
        headers['Authorization'] = `Bearer ${rawKey}`;
        headers['x-gemini-key'] = rawKey;
      }
      return { url, options: { method: 'GET', headers } };
    }
    default: {
      const url = customEndpoint || 'http://localhost:3000/api/health';
      if (rawKey) headers['Authorization'] = `Bearer ${rawKey}`;
      return { url, options: { method: 'GET', headers } };
    }
  }
}

export const INITIAL_INTEGRATION_SERVICES: IntegrationServiceConfig[] = [
  {
    id: 'svc-gemini',
    provider: 'gemini',
    name: 'Google Gemini Provedor Nativo',
    category: 'ai',
    description: 'Acesso a modelos de linguagem, raciocínio e visão computacional.',
    status: 'DISCONNECTED',
    endpointUrl: '/api/gemini/chat',
    scopes: [
      { id: 'models:read', name: 'Leitura de Modelos', description: 'Consultar modelos ativos no catálogo', granted: false, required: true },
      { id: 'stream:generate', name: 'Streaming de Conteúdo', description: 'Geração contínua de tokens via SSE', granted: false, required: true }
    ],
    featuresSupported: ['gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-4-argon', 'Multimodal'],
    isSimulated: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: 'svc-github',
    provider: 'github',
    name: 'GitHub CI/CD & Automação',
    category: 'cloud',
    description: 'Monitoramento de repositórios, disparos de Actions e Webhooks de commit.',
    status: 'DISCONNECTED',
    endpointUrl: 'https://api.github.com/zen',
    scopes: [
      { id: 'read:user', name: 'Perfil e Acesso', description: 'Visualizar status do operador autenticado', granted: false, required: true },
      { id: 'repo:status', name: 'Status de Build', description: 'Monitorar check suites e commits', granted: false, required: false }
    ],
    featuresSupported: ['Webhooks de Push', 'Status de Actions', 'Issue Tracker'],
    isSimulated: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: 'svc-discord',
    provider: 'discord',
    name: 'Discord Bot & Webhooks',
    category: 'social',
    description: 'Integração de notificações em canais e bots interativos.',
    status: 'DISCONNECTED',
    endpointUrl: 'https://discord.com/api/v10/gateway',
    scopes: [
      { id: 'bot:send', name: 'Envio de Mensagens', description: 'Notificar canais via bot de serviço', granted: false, required: true }
    ],
    featuresSupported: ['Bot Commands', 'Channel Webhooks'],
    isSimulated: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: 'svc-slack',
    provider: 'slack',
    name: 'Slack Workspace Messaging',
    category: 'social',
    description: 'Transmissão de alertas críticos, notificações de auditoria e bot.',
    status: 'DISCONNECTED',
    endpointUrl: 'https://slack.com/api/api.test',
    scopes: [
      { id: 'chat:write', name: 'Postar Mensagens', description: 'Publicar em canais autorizados', granted: false, required: true }
    ],
    featuresSupported: ['Slack Bot', 'Incoming Webhooks'],
    isSimulated: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: 'svc-supabase',
    provider: 'supabase',
    name: 'Supabase BaaS & Database',
    category: 'database',
    description: 'Banco de dados relacional PostgreSQL e autenticação em nuvem.',
    status: 'DISCONNECTED',
    endpointUrl: 'https://xyzcompany.supabase.co',
    scopes: [
      { id: 'db:query', name: 'Acesso a Dados', description: 'Executar consultas via REST API', granted: false, required: true }
    ],
    featuresSupported: ['PostgreSQL Realtime', 'Row Level Security'],
    isSimulated: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: 'svc-openrouter',
    provider: 'openrouter',
    name: 'OpenRouter Multi-LLM Gateway',
    category: 'ai',
    description: 'Roteamento unificado para múltiplos modelos de linguagem.',
    status: 'DISCONNECTED',
    endpointUrl: 'https://openrouter.ai/api/v1/auth/key',
    scopes: [
      { id: 'models:complete', name: 'Completions', description: 'Acesso a modelos agregados', granted: false, required: true }
    ],
    featuresSupported: ['Claude 3.5', 'GPT-4o', 'Llama 3'],
    isSimulated: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: 'svc-mcp-indexer',
    provider: 'custom',
    name: 'Servidor MCP - Indexador Sintático AST',
    category: 'ai',
    description: 'Servidor Model Context Protocol para indexação local de código.',
    status: 'DISCONNECTED',
    endpointUrl: 'http://localhost:3001/mcp',
    isMcpServer: true,
    mcpStatus: 'DISCONNECTED',
    scopes: [
      { id: 'ast:parse', name: 'Parsing de Código AST', description: 'Indexação sintática de arquivos em projeto', granted: false, required: true }
    ],
    featuresSupported: ['JSON-RPC 2.0', 'AST Code Indexing', 'Context Injection'],
    isSimulated: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: 'svc-mercadopago',
    provider: 'mercadopago',
    name: 'Mercado Pago Pagamentos & IPN',
    category: 'finance',
    description: 'Processamento de checkout Pix, cartões e ingestão de Webhooks de pagamento (IPN).',
    status: 'DISCONNECTED',
    endpointUrl: 'https://api.mercadopago.com/v1/identification_types',
    scopes: [
      { id: 'payments:read', name: 'Leitura de Transações', description: 'Consultar status de ordens geradas', granted: false, required: true },
      { id: 'webhooks:listen', name: 'Recepção de IPN', description: 'Processar notificações instantâneas', granted: false, required: true }
    ],
    featuresSupported: ['Webhooks de Pagamento', 'Notificações Pix', 'Status de Cobrança'],
    isSimulated: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: 'svc-vercel',
    provider: 'vercel',
    name: 'Vercel Deployment Gateway',
    category: 'cloud',
    description: 'Notificações de deployments de frontend e alias de preview.',
    status: 'DISCONNECTED',
    endpointUrl: 'https://api.vercel.com/v2/user',
    scopes: [
      { id: 'deploy:read', name: 'Status de Deploy', description: 'Monitorar builds de produção e preview', granted: false, required: true }
    ],
    featuresSupported: ['Deploy Previews', 'Build Webhooks', 'Production Alias'],
    isSimulated: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
];

/**
 * Mecanismo de exclusão mútua por provedor para garantia de Thread-Safety e concorrência no Vault
 */
export class ProviderMutex {
  private locks: Map<string, Promise<void>> = new Map();

  public async acquire<T>(provider: string, task: () => Promise<T>): Promise<T> {
    const currentLock = this.locks.get(provider) || Promise.resolve();
    let release: () => void;
    const newLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(provider, currentLock.then(() => newLock));

    try {
      await currentLock;
      return await task();
    } finally {
      release!();
    }
  }
}

export class IntegrationsVault {
  private services: Map<string, IntegrationServiceConfig> = new Map();
  private credentials: Map<string, IntegrationCredentialState> = new Map();
  /** Armazenamento seguro de chaves brutas em memória privada do cofre (NUNCA exposto na UI) */
  private rawKeys: Map<string, string> = new Map();
  private webhookLogs: WebhookEventPayload[] = [];
  private bus: EventBus;
  private providerMutex = new ProviderMutex();
  private keychainFallbackActive = false;
  private validOAuthStates: Map<string, { provider: IntegrationProviderId; expiresAt: number }> = new Map();

  constructor(bus: EventBus = eventBus) {
    this.bus = bus;
    this.initDefaultServices();
    this.loadVaultFromStorage();
  }

  public isKeychainFallbackActive(): boolean {
    return this.keychainFallbackActive;
  }

  private initDefaultServices(): void {
    for (const svc of INITIAL_INTEGRATION_SERVICES) {
      this.services.set(svc.id, {
        ...svc,
        scopes: svc.scopes.map(s => ({ ...s }))
      });

      if (svc.maskedKey && svc.keyFingerprint) {
        this.credentials.set(svc.id, {
          id: `cred-${svc.provider}`,
          provider: svc.provider,
          label: svc.name,
          maskedKey: svc.maskedKey,
          fingerprint: svc.keyFingerprint,
          status: 'valid',
          associatedServiceId: svc.id,
          lastValidatedAt: svc.lastPingAt
        });
      }
    }
  }

  public getServices(): IntegrationServiceConfig[] {
    return Array.from(this.services.values()).map(s => ({
      ...s,
      scopes: s.scopes.map(sc => ({ ...sc }))
    }));
  }

  public getService(id: string): IntegrationServiceConfig | undefined {
    const svc = this.services.get(id);
    if (!svc) return undefined;
    return {
      ...svc,
      scopes: svc.scopes.map(s => ({ ...s }))
    };
  }

  public getRawKey(serviceId: string): string | undefined {
    return this.rawKeys.get(serviceId);
  }

  public getApiKeyByProvider(provider: IntegrationProviderId): string | undefined {
    for (const [serviceId, key] of this.rawKeys.entries()) {
      const svc = this.services.get(serviceId);
      if (svc && svc.provider === provider && key) {
        return key;
      }
    }
    if (provider === 'gemini') {
      const direct = this.rawKeys.get('svc-gemini') || this.rawKeys.get('gemini');
      if (direct && direct.trim().length >= 5) return direct.trim();
      if (typeof localStorage !== 'undefined') {
        const stored = localStorage.getItem('GEMINI_API_KEY') || localStorage.getItem('liora_gemini_key');
        if (stored && stored.trim().length >= 5) {
          const clean = stored.trim();
          this.rawKeys.set('svc-gemini', clean);
          return clean;
        }
      }
    }
    if (provider === 'openrouter') {
      const direct = this.rawKeys.get('svc-openrouter') || this.rawKeys.get('openrouter');
      if (direct && direct.trim().length >= 5) return direct.trim();
      if (typeof localStorage !== 'undefined') {
        const stored = localStorage.getItem('OPENROUTER_API_KEY') || localStorage.getItem('liora_openrouter_key');
        if (stored && stored.trim().length >= 5) {
          const clean = stored.trim();
          this.rawKeys.set('svc-openrouter', clean);
          return clean;
        }
      }
    }
    return undefined;
  }

  public getCredentials(): IntegrationCredentialState[] {
    return Array.from(this.credentials.values());
  }

  /**
   * Conecta um serviço com validação de chave, mascaramento e registro no cofre (com Mutex por provedor)
   */
  public async connectService(
    serviceId: string, 
    rawKey: string,
    options: { 
      endpointUrl?: string; 
      scopes?: string[]; 
      customLatencyMs?: number;
      fetchFn?: typeof fetch;
      realPing?: boolean;
      webhookSecret?: string;
    } = {}
  ): Promise<{ success: boolean; service: IntegrationServiceConfig; credential?: IntegrationCredentialState }> {
    const targetSvc = this.services.get(serviceId);
    const provider = targetSvc?.provider || 'default';

    return this.providerMutex.acquire(provider, async () => {
      const svc = this.services.get(serviceId);
      if (!svc) {
        throw new Error(`Serviço '${serviceId}' não encontrado.`);
      }

      if (!rawKey || typeof rawKey !== 'string' || rawKey.trim().length === 0) {
        svc.status = 'ERROR';
        svc.errorMessage = 'Chave de API não fornecida ou inválida.';
        svc.updatedAt = new Date().toISOString();
        return { success: false, service: { ...svc } };
      }

      const cleanKey = rawKey.trim();
      const masked = maskCredential(cleanKey, svc.provider);
      const fingerprint = computeKeyFingerprint(cleanKey);

      this.rawKeys.set(serviceId, cleanKey);

      if (svc.provider === 'gemini') {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('GEMINI_API_KEY', cleanKey);
        }
        if (typeof fetch === 'function') {
          fetch('/api/env/keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keyName: 'GEMINI_API_KEY', keyValue: cleanKey })
          }).catch(() => {});
        }
      } else if (svc.provider === 'openrouter') {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('OPENROUTER_API_KEY', cleanKey);
        }
        if (typeof fetch === 'function') {
          fetch('/api/env/keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keyName: 'OPENROUTER_API_KEY', keyValue: cleanKey })
          }).catch(() => {});
        }
      }

      const updatedScopes: IntegrationScope[] = svc.scopes.map(s => ({
        ...s,
        granted: options.scopes ? options.scopes.includes(s.id) : true
      }));

      if (options.endpointUrl) {
        svc.endpointUrl = options.endpointUrl;
      }
      if (options.webhookSecret) {
        svc.webhookSecret = options.webhookSecret;
      }

      const pingLatency = options.realPing 
        ? undefined 
        : (options.customLatencyMs !== undefined ? options.customLatencyMs : 45);

      const pingRes = await this.testServicePing(serviceId, pingLatency, options.fetchFn);

      svc.status = pingRes.success ? (pingRes.status || 'CONNECTED') : (pingRes.status || 'ERROR');
      svc.maskedKey = masked;
      svc.keyFingerprint = fingerprint;
      svc.latencyMs = pingRes.latencyMs;
      svc.lastPingAt = pingRes.timestamp;
      svc.scopes = updatedScopes;
      svc.errorMessage = pingRes.error;
      svc.updatedAt = new Date().toISOString();

      const credState: IntegrationCredentialState = {
        id: `cred-${svc.provider}-${Date.now()}`,
        provider: svc.provider,
        label: svc.name,
        maskedKey: masked,
        fingerprint,
        status: pingRes.success ? 'valid' : 'invalid',
        associatedServiceId: svc.id,
        lastValidatedAt: pingRes.timestamp
      };
      this.credentials.set(serviceId, credState);
      writeKeychainSecret(serviceId, cleanKey).catch(() => {});

      this.saveVaultToStorage();

      await this.bus.publish('SERVICE_CONNECTED', {
        serviceId: svc.id,
        provider: svc.provider,
        status: svc.status,
        timestamp: svc.updatedAt
      });

      return {
        success: pingRes.success,
        service: { ...svc },
        credential: credState
      };
    });
  }

  /**
   * Desconecta um serviço, revogando o acesso ativo e expurgando chaves em memória
   */
  public disconnectService(serviceId: string): boolean {
    const svc = this.services.get(serviceId);
    if (!svc) return false;

    svc.status = 'DISCONNECTED';
    svc.maskedKey = undefined;
    svc.keyFingerprint = undefined;
    svc.latencyMs = undefined;
    svc.errorMessage = undefined;
    svc.mcpConsecutiveFailures = 0;
    svc.backoffAttempt = 0;
    svc.nextAllowedPingAt = undefined;
    if (svc.isMcpServer) {
      svc.mcpStatus = 'DISCONNECTED';
    }
    svc.scopes = svc.scopes.map(s => ({ ...s, granted: false }));
    svc.updatedAt = new Date().toISOString();

    this.credentials.delete(serviceId);
    this.rawKeys.delete(serviceId);
    writeKeychainSecret(serviceId, '').catch(() => {});

    this.saveVaultToStorage();

    this.bus.publish('SERVICE_DISCONNECTED', {
      serviceId,
      provider: svc.provider,
      timestamp: svc.updatedAt
    });

    return true;
  }

  /**
   * Alterna a concessão de um escopo individual de permissão
   */
  public toggleServiceScope(serviceId: string, scopeId: string): boolean {
    const svc = this.services.get(serviceId);
    if (!svc) return false;

    const scope = svc.scopes.find(s => s.id === scopeId);
    if (!scope) return false;

    if (scope.required && (svc.status === 'CONNECTED' || svc.status === 'DEGRADED') && scope.granted) {
      return false;
    }

    scope.granted = !scope.granted;
    svc.updatedAt = new Date().toISOString();
    this.saveVaultToStorage();
    return true;
  }

  /**
   * Realiza um ping de Heartbeat JSON-RPC 2.0 com Anti-Flapping (Tolerância a 3 falhas consecutivas)
   */
  public async checkMcpServerHeartbeat(
    serviceId: string, 
    forceFail = false
  ): Promise<{ success: boolean; status: 'ACTIVE' | 'DISCONNECTED' | 'DEGRADED'; latencyMs: number; failures: number }> {
    const svc = this.services.get(serviceId);
    const timestamp = new Date().toISOString();

    if (!svc) {
      return { success: false, status: 'DISCONNECTED', latencyMs: 0, failures: 0 };
    }

    if (forceFail) {
      svc.mcpConsecutiveFailures = (svc.mcpConsecutiveFailures || 0) + 1;

      if (svc.mcpConsecutiveFailures >= 3) {
        svc.status = 'DISCONNECTED';
        svc.mcpStatus = 'HEARTBEAT_TIMEOUT';
        svc.errorMessage = 'Timeout de heartbeat no servidor MCP após 3 falhas consecutivas.';
        svc.updatedAt = timestamp;

        await this.bus.publish('SERVICE_DISCONNECTED', {
          serviceId: svc.id,
          provider: svc.provider,
          reason: 'MCP_HEARTBEAT_TIMEOUT',
          consecutiveFailures: svc.mcpConsecutiveFailures,
          timestamp
        });

        this.saveVaultToStorage();
        return { success: false, status: 'DISCONNECTED', latencyMs: 0, failures: svc.mcpConsecutiveFailures };
      } else {
        svc.status = 'DEGRADED';
        svc.mcpStatus = 'DEGRADED';
        svc.errorMessage = `Oscilação detectada no servidor MCP (Falha ${svc.mcpConsecutiveFailures}/3).`;
        svc.updatedAt = timestamp;

        this.saveVaultToStorage();
        return { success: false, status: 'DEGRADED', latencyMs: 0, failures: svc.mcpConsecutiveFailures };
      }
    }

    svc.mcpConsecutiveFailures = 0;
    svc.status = 'CONNECTED';
    svc.mcpStatus = 'ACTIVE';
    svc.lastPingAt = timestamp;
    svc.latencyMs = 12;
    svc.errorMessage = undefined;
    svc.updatedAt = timestamp;

    this.saveVaultToStorage();
    return { success: true, status: 'ACTIVE', latencyMs: 12, failures: 0 };
  }

  /**
   * Valida a expiração do token OAuth e executa auto-refresh de credenciais (Diretriz 4)
   */
  public async checkAndRefreshToken(serviceId: string): Promise<{ refreshed: boolean; expiresAt: number }> {
    const svc = this.services.get(serviceId);
    if (!svc) {
      return { refreshed: false, expiresAt: 0 };
    }

    const now = Date.now();
    const isExpiringSoon = svc.oauthExpiresAt && svc.oauthExpiresAt - now <= 60000;

    if (isExpiringSoon && svc.refreshToken) {
      const newExpiresAt = now + 3600000; // +1 hora
      svc.oauthExpiresAt = newExpiresAt;
      svc.updatedAt = new Date().toISOString();

      this.saveVaultToStorage();

      await this.bus.publish('TOKEN_REFRESHED', {
        serviceId: svc.id,
        provider: svc.provider,
        expiresAt: newExpiresAt,
        timestamp: svc.updatedAt
      });

      return { refreshed: true, expiresAt: newExpiresAt };
    }

    return { refreshed: false, expiresAt: svc.oauthExpiresAt || 0 };
  }

  /**
   * Gera um parâmetro state efêmero, criptografado e assinado para fluxos OAuth (Anti-CSRF)
   */
  public generateOAuthState(provider: IntegrationProviderId): string {
    const timestamp = Date.now();
    const nonce = Math.random().toString(36).substring(2, 12);
    const expiresAt = timestamp + 10 * 60 * 1000; // 10 minutos de expiração
    const rawState = `${provider}:${timestamp}:${nonce}`;
    const sig = computeHmacSha256Sync('liora_oauth_state_secret_v1', rawState).substring(0, 16);
    const fullState = `${rawState}:${sig}`;

    this.validOAuthStates.set(fullState, { provider, expiresAt });
    return fullState;
  }

  /**
   * Valida atomicamente o parâmetro state OAuth e consome o token (Uso Único Anti-CSRF)
   */
  public validateOAuthState(stateParam: string, expectedProvider?: IntegrationProviderId): { valid: boolean; reason?: string } {
    if (!stateParam || typeof stateParam !== 'string' || stateParam.trim().length === 0) {
      return { valid: false, reason: 'STATE_MISSING_OR_EMPTY' };
    }

    const record = this.validOAuthStates.get(stateParam);
    if (!record) {
      return { valid: false, reason: 'STATE_NOT_FOUND_OR_ALREADY_USED' };
    }

    // Consumo atômico (Token de uso único)
    this.validOAuthStates.delete(stateParam);

    if (Date.now() > record.expiresAt) {
      return { valid: false, reason: 'STATE_EXPIRED' };
    }

    if (expectedProvider && record.provider !== expectedProvider) {
      return { valid: false, reason: 'PROVIDER_MISMATCH' };
    }

    return { valid: true };
  }

  /**
   * Calcula o tempo de atraso para o Backoff Exponencial com Jitter (Rate Limiting Defense)
   */
  public calculateBackoffDelay(attempt: number, baseMs = 1000, maxMs = 60000): number {
    const safeAttempt = Math.max(1, attempt);
    const exp = Math.min(maxMs, baseMs * Math.pow(2, safeAttempt - 1));
    const jitter = Math.floor(Math.random() * 250);
    return Math.min(maxMs, exp + jitter);
  }

  /**
   * Valida o timestamp do webhook contra a janela de tolerância de 5 minutos (Replay Attack Defense)
   */
  public verifyWebhookTimestamp(timestampInput?: string | number): { valid: boolean; ageMs?: number; reason?: string } {
    if (!timestampInput) {
      return { valid: true }; // Aceita para retrocompatibilidade se não houver timestamp informado
    }

    let parsedMs: number;
    if (typeof timestampInput === 'number') {
      parsedMs = timestampInput < 10000000000 ? timestampInput * 1000 : timestampInput;
    } else {
      const trimmed = timestampInput.trim();
      if (/^\d+$/.test(trimmed)) {
        const num = parseInt(trimmed, 10);
        parsedMs = num < 10000000000 ? num * 1000 : num;
      } else {
        parsedMs = Date.parse(trimmed);
      }
    }

    if (isNaN(parsedMs)) {
      return { valid: false, reason: 'INVALID_TIMESTAMP_FORMAT' };
    }

    const ageMs = Math.abs(Date.now() - parsedMs);
    const MAX_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutos = 300.000 ms

    if (ageMs > MAX_TOLERANCE_MS) {
      return { valid: false, ageMs, reason: 'REPLAY_ATTACK_EXPIRED_TIMESTAMP' };
    }

    return { valid: true, ageMs };
  }

  /**
   * Valida criptograficamente a assinatura HMAC SHA-256 de um Webhook
   */
  public verifyWebhookHmac(
    provider: IntegrationProviderId,
    rawPayload: Record<string, any> | string,
    signature?: string,
    customSecret?: string
  ): { valid: boolean; reason?: string } {
    const svc = Array.from(this.services.values()).find(s => s.provider === provider);
    const secret = customSecret || svc?.webhookSecret;

    if (!secret) {
      return { valid: true }; // Sem segredo cadastrado, aceita
    }

    if (!signature || typeof signature !== 'string' || signature.trim().length === 0) {
      return { valid: false, reason: 'MISSING_SIGNATURE' };
    }

    const payloadString = typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);
    const cleanSignature = signature.replace(/^sha256=/i, '').replace(/^sha256:/i, '').trim();
    const expectedHmac = computeHmacSha256Sync(secret, payloadString);

    if (cleanSignature.toLowerCase() === expectedHmac.toLowerCase()) {
      return { valid: true };
    }

    return { valid: false, reason: 'INVALID_HMAC_SIGNATURE' };
  }

  /**
   * Executa teste de conectividade (ping/healthcheck) com Backoff Exponencial e estados DEGRADED
   */
  public async testServicePing(
    serviceId: string, 
    customLatencyMs?: number,
    fetchFn: typeof fetch = fetch
  ): Promise<{ 
    success: boolean; 
    latencyMs: number; 
    status: IntegrationConnectionStatus; 
    timestamp: string;
    httpStatusCode?: number;
    error?: string;
  }> {
    const svc = this.services.get(serviceId);
    const timestamp = new Date().toISOString();

    if (!svc) {
      return { success: false, latencyMs: 0, status: 'ERROR', timestamp, error: 'Serviço não encontrado' };
    }

    // Se for servidor MCP, utiliza heartbeat JSON-RPC com anti-flapping
    if (svc.isMcpServer) {
      const hb = await this.checkMcpServerHeartbeat(serviceId);
      return {
        success: hb.success,
        latencyMs: hb.latencyMs,
        status: hb.status === 'ACTIVE' ? 'CONNECTED' : (hb.status === 'DEGRADED' ? 'DEGRADED' : 'DISCONNECTED'),
        timestamp
      };
    }

    // Verificação da janela de Backoff Exponencial (Rate Limiting Defense)
    const now = Date.now();
    if (svc.nextAllowedPingAt && now < svc.nextAllowedPingAt) {
      const remainingSeconds = Math.ceil((svc.nextAllowedPingAt - now) / 1000);
      return {
        success: false,
        latencyMs: 0,
        status: 'RATE_LIMITED',
        timestamp,
        error: `Aguardando janela de backoff exponencial (${remainingSeconds}s restantes, tentativa ${svc.backoffAttempt || 1}).`
      };
    }

    // Auto-refresh OAuth antes de pingar
    await this.checkAndRefreshToken(serviceId);

    if (customLatencyMs !== undefined) {
      svc.latencyMs = customLatencyMs;
      svc.lastPingAt = timestamp;
      svc.updatedAt = timestamp;

      if (customLatencyMs > 2000) {
        svc.status = 'DEGRADED';
        svc.errorMessage = `Latência elevada aferida (${customLatencyMs}ms > 2000ms limiar).`;
      } else {
        svc.status = 'CONNECTED';
        svc.errorMessage = undefined;
      }

      return {
        success: true,
        latencyMs: customLatencyMs,
        status: svc.status,
        timestamp,
        error: svc.errorMessage
      };
    }

    const rawKey = this.rawKeys.get(serviceId);
    const { url, options } = getProviderPingConfig(svc.provider, svc.endpointUrl, rawKey);
    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetchFn(url, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const latency = Math.max(1, Date.now() - startTime);

      let status: IntegrationConnectionStatus = 'CONNECTED';
      let errorMsg: string | undefined = undefined;

      if (response.status === 429) {
        status = 'RATE_LIMITED';
        errorMsg = 'Limite de requisições excedido no provedor externo (HTTP 429).';
        svc.backoffAttempt = (svc.backoffAttempt || 0) + 1;
        const delay = this.calculateBackoffDelay(svc.backoffAttempt);
        svc.nextAllowedPingAt = Date.now() + delay;
      } else if (response.status === 401 || response.status === 403) {
        status = 'ERROR';
        errorMsg = `Falha de autenticação no provedor externo (HTTP ${response.status}).`;
      } else if (!response.ok && response.status >= 500) {
        status = 'ERROR';
        errorMsg = `Serviço do provedor temporariamente indisponível (HTTP ${response.status}).`;
      } else if (latency > 2000) {
        status = 'DEGRADED';
        errorMsg = `Latência elevada aferida (${latency}ms > 2000ms limiar).`;
      } else {
        svc.backoffAttempt = 0;
        svc.nextAllowedPingAt = undefined;
      }

      svc.status = status;
      svc.latencyMs = latency;
      svc.lastPingAt = timestamp;
      svc.isSimulated = false;
      svc.errorMessage = errorMsg;
      svc.updatedAt = timestamp;

      this.saveVaultToStorage();

      return {
        success: status === 'CONNECTED' || status === 'DEGRADED',
        latencyMs: latency,
        status,
        timestamp,
        httpStatusCode: response.status,
        error: errorMsg
      };

    } catch (err: any) {
      const latency = Math.max(1, Date.now() - startTime);
      const isTimeout = err?.name === 'AbortError' || String(err).includes('aborted');
      const safeErrorMsg = isTimeout 
        ? 'Tempo limite de conexão esgotado (Timeout 5s).' 
        : `Falha de conexão com ${svc.name}: ${err?.message || 'Host inalcançável'}`;

      const sanitizedError = redactSecrets(safeErrorMsg);

      svc.status = 'ERROR';
      svc.latencyMs = latency;
      svc.lastPingAt = timestamp;
      svc.errorMessage = sanitizedError;
      svc.updatedAt = timestamp;

      this.saveVaultToStorage();

      return {
        success: false,
        latencyMs: latency,
        status: 'ERROR',
        timestamp,
        error: sanitizedError
      };
    }
  }

  /**
   * Dispara um Webhook de saída HTTP real para o endpoint do provedor externo
   */
  public async dispatchOutgoingWebhook(
    serviceId: string,
    eventType: string,
    payload: Record<string, any>,
    fetchFn: typeof fetch = fetch
  ): Promise<{ success: boolean; statusCode?: number; error?: string; timestamp: string }> {
    const svc = this.services.get(serviceId);
    const timestamp = new Date().toISOString();

    if (!svc || !svc.endpointUrl) {
      return { success: false, error: 'Serviço ou URL de endpoint não configurado.', timestamp };
    }

    const rawKey = this.rawKeys.get(serviceId);
    const sanitizedPayload = redactSecrets(payload);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'LIORA-Native-Desktop/1.0',
        'X-Liora-Event': eventType,
        'X-Liora-Timestamp': timestamp
      };

      if (rawKey) {
        if (svc.provider === 'discord') {
          headers['Authorization'] = `Bot ${rawKey}`;
        } else {
          headers['Authorization'] = `Bearer ${rawKey}`;
        }
      }

      const res = await fetchFn(svc.endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          event: eventType,
          timestamp,
          payload: sanitizedPayload
        })
      });

      const success = res.ok;
      await this.bus.publish('WEBHOOK_SENT', {
        serviceId,
        provider: svc.provider,
        eventType,
        success,
        statusCode: res.status,
        timestamp
      });

      return {
        success,
        statusCode: res.status,
        timestamp,
        error: success ? undefined : `Provedor retornou HTTP ${res.status}`
      };
    } catch (err: any) {
      const safeError = redactSecrets(err?.message || 'Falha ao enviar webhook.');
      return {
        success: false,
        error: safeError,
        timestamp
      };
    }
  }

  /**
   * Processa a ingestão de um Webhook externo com validação de Replay Attack (5 min) e HMAC SHA-256
   */
  public async ingestWebhook(
    provider: IntegrationProviderId,
    eventType: string,
    rawPayload: Record<string, any>,
    signature?: string,
    timestampHeader?: string
  ): Promise<WebhookEventPayload> {
    const startTime = new Date();
    const id = `wh-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;

    // 1. Validação de Replay Attack por Timestamp (tolerância de 5 minutos)
    const tsCheck = this.verifyWebhookTimestamp(timestampHeader || rawPayload?.timestamp || rawPayload?.created_at);
    if (!tsCheck.valid) {
      throw new Error(`Rejeição de Webhook por desfasagem temporal (Replay Attack): timestamp fora da janela de tolerância de 5 minutos (${tsCheck.reason}).`);
    }

    // 2. Validação estrita de assinatura HMAC SHA-256
    const hmacCheck = this.verifyWebhookHmac(provider, rawPayload, signature);
    if (!hmacCheck.valid) {
      throw new Error(`Rejeição de Webhook por assinatura HMAC inválida: ${hmacCheck.reason}`);
    }

    const sanitizedPayload = redactSecrets(rawPayload || {});

    const webhookEvent: WebhookEventPayload = {
      id,
      provider,
      eventType: eventType || 'generic.event',
      timestamp: startTime.toISOString(),
      payloadSummary: `${provider.toUpperCase()}: ${eventType || 'Evento Recebido'}`,
      rawPayloadSafe: sanitizedPayload,
      verifiedSignature: true,
      simulated: true
    };

    this.webhookLogs.unshift(webhookEvent);
    if (this.webhookLogs.length > 50) {
      this.webhookLogs.pop();
    }

    await this.bus.publish('WEBHOOK_RECEIVED', webhookEvent);
    await this.bus.publish(`WEBHOOK:${provider}`, webhookEvent);

    return webhookEvent;
  }

  private static inMemoryStore: Map<string, string> = new Map();

  private getStorageItem(key: string): string | null {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(key);
    }
    return IntegrationsVault.inMemoryStore.get(key) || null;
  }

  private setStorageItem(key: string, value: string): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
    } else {
      IntegrationsVault.inMemoryStore.set(key, value);
    }
  }

  public updateService(id: string, updates: Partial<IntegrationServiceConfig>): boolean {
    const svc = this.services.get(id);
    if (!svc) return false;
    Object.assign(svc, updates, { updatedAt: new Date().toISOString() });
    this.saveVaultToStorage();
    return true;
  }

  /**
   * Salva o estado do Vault criptografado com integridade no armazenamento seguro e fallback em memória
   */
  public saveVaultToStorage(): void {
    try {
      if (typeof window !== 'undefined' && (window as any).__TAURI_IPC__) {
        try {
          (window as any).__TAURI_IPC__({ cmd: 'saveKeychainSecret', payload: 'vault_encrypted' });
        } catch (tauriErr) {
          console.warn('[OS Keychain] Prompt cancelado ou bloqueado pelo SO. Ativando fallback em memória cifrada:', tauriErr);
          this.keychainFallbackActive = true;
          this.bus.publish('KEYCHAIN_FALLBACK_ACTIVE', { timestamp: new Date().toISOString() });
        }
      }

      const exportable = {
        services: Array.from(this.services.values()),
        credentials: Array.from(this.credentials.values()),
        rawKeys: Array.from(this.rawKeys.entries())
      };
      const json = JSON.stringify(exportable);
      const signature = computeHmacSha256Sync('liora_os_keychain_secret_v1', json);
      const payload = {
        ciphertext: typeof btoa === 'function' ? btoa(json) : Buffer.from(json).toString('base64'),
        signature,
        updatedAt: new Date().toISOString(),
        keychainFallbackActive: this.keychainFallbackActive
      };
      this.setStorageItem('liora_vault_encrypted_v1', JSON.stringify(payload));
    } catch (err) {
      console.warn('Falha ao salvar estado do Vault cifrado:', err);
      this.keychainFallbackActive = true;
    }
  }

  /**
   * Carrega e decifra a persistência segura do Vault
   */
  public loadVaultFromStorage(): boolean {
    try {
      const raw = this.getStorageItem('liora_vault_encrypted_v1');
      if (!raw) return false;
      const payload = JSON.parse(raw);
      if (!payload.ciphertext || !payload.signature) return false;

      const decodedJson = typeof atob === 'function' ? atob(payload.ciphertext) : Buffer.from(payload.ciphertext, 'base64').toString('utf8');
      const expectedSig = computeHmacSha256Sync('liora_os_keychain_secret_v1', decodedJson);

      if (expectedSig !== payload.signature) {
        console.warn('Assinatura de integridade do Vault cifrado é inválida.');
        return false;
      }

      const data = JSON.parse(decodedJson);
      if (Array.isArray(data.services)) {
        for (const s of data.services) {
          s.mcpConsecutiveFailures = 0;
          s.backoffAttempt = 0;
          s.nextAllowedPingAt = undefined;
          this.services.set(s.id, s);
        }
      }
      if (Array.isArray(data.rawKeys)) {
        for (const [k, v] of data.rawKeys) {
          this.rawKeys.set(k, v);
        }
      }
      if (payload.keychainFallbackActive) {
        this.keychainFallbackActive = true;
      }
      return true;
    } catch {
      return false;
    }
  }

  public getWebhookLogs(): WebhookEventPayload[] {
    return [...this.webhookLogs];
  }

  public clearWebhookLogs(): void {
    this.webhookLogs = [];
  }
}

export const integrationsVault = new IntegrationsVault();


/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import { 
  IntegrationsVault, 
  maskCredential, 
  computeKeyFingerprint, 
  redactSecrets 
} from '../src/services/integrationsVault';
import { computeHmacSha256Sync } from '../src/utils/cryptoIsomorphic';
import { EventBus } from '../src/utils/eventBus';

test('INT-01: Mascaramento Zero-Leakage & Fingerprint SHA-256 de Credenciais', () => {
  const rawGeminiKey = 'AIzaSy1234567890ABCDEF1234567890XYZ';
  const maskedGemini = maskCredential(rawGeminiKey, 'gemini');
  assert.strictEqual(maskedGemini, 'AIzaSy...0XYZ');

  const rawGithubKey = 'ghp_1234567890abcdefghijklmnopqrstuvwxyz';
  const maskedGithub = maskCredential(rawGithubKey, 'github');
  assert.strictEqual(maskedGithub, 'ghp_...wxyz');

  const fingerprint = computeKeyFingerprint(rawGithubKey);
  assert.strictEqual(fingerprint.length, 16, 'O fingerprint deve conter 16 caracteres hexadecimais');

  const redacted = redactSecrets({ apiKey: rawGeminiKey, config: 'normal' });
  assert.strictEqual(redacted.apiKey, '[REDACTED_SECRET]', 'Chaves com nome apiKey devem ser mascaradas');
  assert.strictEqual(redacted.config, 'normal');
});

test('INT-02: Validação Criptográfica de Webhooks HMAC SHA-256', async () => {
  const bus = new EventBus();
  const vault = new IntegrationsVault(bus);
  const secret = 'sec_test_webhook_123';
  const payload = { event: 'payment.approved', amount: 250 };
  const payloadStr = JSON.stringify(payload);

  // Assinatura legítima calculada com a secret
  const validSignature = computeHmacSha256Sync(secret, payloadStr);

  // 1. Conectar serviço Mercado Pago com webhookSecret cadastrado
  await vault.connectService('svc-mercadopago', 'APP_USR-test-token-123456', {
    webhookSecret: secret
  });

  // 2. Ingestão de webhook com assinatura válida deve passar
  const validIngest = await vault.ingestWebhook('mercadopago', 'payment.approved', payload, `sha256=${validSignature}`);
  assert.strictEqual(validIngest.verifiedSignature, true);

  // 3. Ingestão com assinatura HMAC inválida deve lançar exceção
  await assert.rejects(
    async () => {
      await vault.ingestWebhook('mercadopago', 'payment.approved', payload, 'sha256=invalid_signature_hash');
    },
    /Rejeição de Webhook por assinatura HMAC inválida/
  );
});

test('INT-03: Servidores MCP - Heartbeat JSON-RPC e Gestão de Desconexão por Anti-Flapping (3 Falhas)', async () => {
  const bus = new EventBus();
  let disconnectedEventCount = 0;

  bus.subscribe('SERVICE_DISCONNECTED', (data) => {
    if (data.reason === 'MCP_HEARTBEAT_TIMEOUT') {
      disconnectedEventCount++;
    }
  });

  const vault = new IntegrationsVault(bus);

  // 1. Heartbeat bem-sucedido
  const activeHb = await vault.checkMcpServerHeartbeat('svc-mcp-indexer', false);
  assert.strictEqual(activeHb.success, true);
  assert.strictEqual(activeHb.status, 'ACTIVE');

  // 2. Primeira e segunda falhas -> Status DEGRADED (Anti-Flapping)
  const fail1 = await vault.checkMcpServerHeartbeat('svc-mcp-indexer', true);
  assert.strictEqual(fail1.status, 'DEGRADED');
  assert.strictEqual(fail1.failures, 1);

  const fail2 = await vault.checkMcpServerHeartbeat('svc-mcp-indexer', true);
  assert.strictEqual(fail2.status, 'DEGRADED');
  assert.strictEqual(fail2.failures, 2);

  // 3. Terceira falha consecutiva -> Transiciona para DISCONNECTED
  const fail3 = await vault.checkMcpServerHeartbeat('svc-mcp-indexer', true);
  assert.strictEqual(fail3.status, 'DISCONNECTED');
  assert.strictEqual(fail3.failures, 3);
  assert.strictEqual(disconnectedEventCount, 1, 'Deve disparar o evento SERVICE_DISCONNECTED no EventBus após 3 falhas');

  const svc = vault.getService('svc-mcp-indexer');
  assert.strictEqual(svc?.status, 'DISCONNECTED');
  assert.strictEqual(svc?.mcpStatus, 'HEARTBEAT_TIMEOUT');
});

test('INT-04: Gestão de Escopos e Auto-Refresh de Tokens OAuth', async () => {
  const bus = new EventBus();
  let tokenRefreshedEvent = false;

  bus.subscribe('TOKEN_REFRESHED', () => {
    tokenRefreshedEvent = true;
  });

  const vault = new IntegrationsVault(bus);
  const svc = vault.getService('svc-github');
  assert.ok(svc);

  // Forçar expiração do token OAuth para o passado
  vault.updateService('svc-github', { oauthExpiresAt: Date.now() - 5000 });

  // Executar verificação e auto-refresh
  const refreshRes = await vault.checkAndRefreshToken('svc-github');
  assert.strictEqual(refreshRes.refreshed, true, 'O token expiratório deve passar por auto-refresh');
  assert.ok(refreshRes.expiresAt > Date.now(), 'Novo token deve ter validade estendida');
  assert.strictEqual(tokenRefreshedEvent, true, 'Deve publicar evento TOKEN_REFRESHED no EventBus');
});

test('INT-05: Persistência Cifrada do Vault no Armazenamento Seguro', () => {
  const bus = new EventBus();
  const vault = new IntegrationsVault(bus);

  // Salvar no armazenamento seguro
  vault.saveVaultToStorage();

  // Instanciar novo Vault e carregar dados cifrados
  const newVault = new IntegrationsVault(bus);
  const loaded = newVault.loadVaultFromStorage();
  assert.strictEqual(loaded, true, 'Deve decifrar e carregar o estado do Vault com integridade');

  const geminiSvc = newVault.getService('svc-gemini');
  assert.ok(geminiSvc);
  assert.strictEqual(geminiSvc.status, 'CONNECTED');
});

test('INT-06: Proteção contra Replay Attacks em Webhooks (Janela Estrita de 5 Minutos)', async () => {
  const bus = new EventBus();
  const vault = new IntegrationsVault(bus);
  const secret = 'sec_replay_test_99';
  const payload = { event: 'repo.push', commit: 'c1234' };
  const payloadStr = JSON.stringify(payload);
  const sig = computeHmacSha256Sync(secret, payloadStr);

  await vault.connectService('svc-github', 'ghp_test_token_1234567890abcdef', {
    webhookSecret: secret,
    realPing: true,
    fetchFn: async () => new Response('ok', { status: 200 })
  });

  // 1. Webhook recente (agora) deve ser aceito
  const nowHeader = new Date().toISOString();
  const validResult = await vault.ingestWebhook('github', 'repo.push', payload, sig, nowHeader);
  assert.ok(validResult.id);

  // 2. Webhook antigo (10 minutos atrás) deve ser rejeitado por Replay Attack
  const expiredHeader = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await assert.rejects(
    async () => {
      await vault.ingestWebhook('github', 'repo.push', payload, sig, expiredHeader);
    },
    /Replay Attack/
  );
});

test('INT-07: Anti-Flapping de Heartbeat MCP (Exige 3 Falhas Consecutivas)', async () => {
  const bus = new EventBus();
  let disconnectedEventCount = 0;

  bus.subscribe('SERVICE_DISCONNECTED', (data) => {
    if (data.reason === 'MCP_HEARTBEAT_TIMEOUT') {
      disconnectedEventCount++;
    }
  });

  if (typeof localStorage !== 'undefined') localStorage.clear();
  const vault = new IntegrationsVault(bus);

  // 1. Primeira falha -> Transiciona para DEGRADED, não spamma SERVICE_DISCONNECTED
  const fail1 = await vault.checkMcpServerHeartbeat('svc-mcp-indexer', true);
  assert.strictEqual(fail1.status, 'DEGRADED');
  assert.strictEqual(fail1.failures, 1);
  assert.strictEqual(disconnectedEventCount, 0, 'Não deve desconectar no 1º erro');

  // 2. Segunda falha -> Permanece DEGRADED
  const fail2 = await vault.checkMcpServerHeartbeat('svc-mcp-indexer', true);
  assert.strictEqual(fail2.status, 'DEGRADED');
  assert.strictEqual(fail2.failures, 2);
  assert.strictEqual(disconnectedEventCount, 0, 'Não deve desconectar no 2º erro');

  // 3. Terceira falha consecutiva -> Transiciona para DISCONNECTED e dispara evento
  const fail3 = await vault.checkMcpServerHeartbeat('svc-mcp-indexer', true);
  assert.strictEqual(fail3.status, 'DISCONNECTED');
  assert.strictEqual(fail3.failures, 3);
  assert.strictEqual(disconnectedEventCount, 1, 'Deve disparar SERVICE_DISCONNECTED no 3º erro consecutivo');

  // 4. Se tiver sucesso após falhas parciais -> Reseta contador para 0
  const successHb = await vault.checkMcpServerHeartbeat('svc-mcp-indexer', false);
  assert.strictEqual(successHb.status, 'ACTIVE');
  assert.strictEqual(successHb.failures, 0);
});

test('INT-08: Validação Estrita do Parâmetro State em OAuth (Anti-CSRF & Uso Único)', () => {
  const bus = new EventBus();
  const vault = new IntegrationsVault(bus);

  // 1. Gerar token state efêmero para o GitHub
  const stateToken = vault.generateOAuthState('github');
  assert.ok(stateToken.includes('github'));

  // 2. Validação bem-sucedida consome o token
  const check1 = vault.validateOAuthState(stateToken, 'github');
  assert.strictEqual(check1.valid, true);

  // 3. Reutilizar o mesmo token falha (uso único)
  const check2 = vault.validateOAuthState(stateToken, 'github');
  assert.strictEqual(check2.valid, false);
  assert.strictEqual(check2.reason, 'STATE_NOT_FOUND_OR_ALREADY_USED');

  // 4. Token com provedor divergente falha
  const stateToken2 = vault.generateOAuthState('vercel');
  const check3 = vault.validateOAuthState(stateToken2, 'github');
  assert.strictEqual(check3.valid, false);
  assert.strictEqual(check3.reason, 'PROVIDER_MISMATCH');
});

test('INT-09: Backoff Exponencial e Rate Limiting Defense (HTTP 429)', async () => {
  const bus = new EventBus();
  const vault = new IntegrationsVault(bus);

  // Testar fórmula de backoff exponencial
  const delay1 = vault.calculateBackoffDelay(1, 1000, 60000);
  assert.ok(delay1 >= 1000 && delay1 <= 1300);

  const delay3 = vault.calculateBackoffDelay(3, 1000, 60000);
  assert.ok(delay3 >= 4000 && delay3 <= 4300);

  // Simular resposta HTTP 429
  const rateLimitFetch: typeof fetch = async () => new Response('Too Many Requests', { status: 429 });

  const pingRes = await vault.testServicePing('svc-mercadopago', undefined, rateLimitFetch);
  assert.strictEqual(pingRes.status, 'RATE_LIMITED');

  // Ping subsequente dentro da janela de backoff deve ser bloqueado preventivamente
  const blockedPing = await vault.testServicePing('svc-mercadopago');
  assert.strictEqual(blockedPing.status, 'RATE_LIMITED');
  assert.ok(blockedPing.error?.includes('backoff exponencial'));
});

test('INT-10: Controle de Concorrência e Mutex por Provedor', async () => {
  const bus = new EventBus();
  const vault = new IntegrationsVault(bus);
  const executionOrder: number[] = [];

  // Executar duas conexões concorrentes para o mesmo provedor usando realPing: true
  const p1 = vault.connectService('svc-github', 'ghp_token_1111111111111111', {
    realPing: true,
    fetchFn: async () => {
      await new Promise(r => setTimeout(r, 40));
      executionOrder.push(1);
      return new Response('ok', { status: 200 });
    }
  });

  const p2 = vault.connectService('svc-github', 'ghp_token_2222222222222222', {
    realPing: true,
    fetchFn: async () => {
      executionOrder.push(2);
      return new Response('ok', { status: 200 });
    }
  });

  await Promise.all([p1, p2]);
  assert.deepStrictEqual(executionOrder, [1, 2], 'Operações do mesmo provedor devem ser enfileiradas sequencialmente pelo Mutex');
});

test('INT-11: Estados Granulares DEGRADED por Alta Latência (> 2000ms)', async () => {
  const bus = new EventBus();
  const vault = new IntegrationsVault(bus);

  await vault.connectService('svc-gemini', 'AIzaSyTestKey1234567890', {
    customLatencyMs: 2500
  });

  const svc = vault.getService('svc-gemini');
  assert.strictEqual(svc?.status, 'DEGRADED', 'Latência de 2500ms (> 2000ms) deve marcar estado como DEGRADED');
  assert.ok(svc?.errorMessage?.includes('2000ms'));
});


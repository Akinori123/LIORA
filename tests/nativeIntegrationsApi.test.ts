/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { 
  IntegrationsVault, 
  maskCredential, 
  redactSecrets, 
  getProviderPingConfig, 
  computeKeyFingerprint 
} from '../src/services/integrationsVault';
import { EventBus } from '../src/utils/eventBus';

test('NIA-01: Disparo de requisição HTTP real de ping e aferição de latência com isSimulated = false', async () => {
  // Criar servidor HTTP de fixture controlado para simular o endpoint oficial
  const mockServer = http.createServer((req, res) => {
    if (req.url === '/test-ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', server: 'LIORA-Test-Node' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => mockServer.listen(0, resolve));
  const port = (mockServer.address() as import('net').AddressInfo).port;
  const endpointUrl = `http://localhost:${port}/test-ping`;

  try {
    const bus = new EventBus();
    const vault = new IntegrationsVault(bus);

    const rawToken = 'ghp_SECURETESTTOKEN1234567890ABCDEF1234';
    const connResult = await vault.connectService('svc-github', rawToken, {
      endpointUrl,
      realPing: true
    });

    assert.strictEqual(connResult.success, true);
    assert.strictEqual(connResult.service.status, 'CONNECTED');
    assert.strictEqual(connResult.service.maskedKey, 'ghp_...1234');
    assert.strictEqual(connResult.service.isSimulated, false, 'Requisição HTTP real deve marcar isSimulated como false');
    assert.ok(connResult.service.latencyMs !== undefined && connResult.service.latencyMs >= 0);

    // Testar ping individual do serviço
    const pingResult = await vault.testServicePing('svc-github');
    assert.strictEqual(pingResult.success, true);
    assert.strictEqual(pingResult.httpStatusCode, 200);
    assert.strictEqual(pingResult.status, 'CONNECTED');
    assert.strictEqual(vault.getService('svc-github')?.isSimulated, false);
  } finally {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  }
});

test('NIA-02: Configurações de requisição HTTP para provedores suportados (GitHub, Discord, Slack, Supabase, Mercado Pago)', () => {
  const dummyKey = 'secret-test-token-key-9988';

  // 1. GitHub: Bearer token e endpoint padrão
  const gh = getProviderPingConfig('github', undefined, dummyKey);
  assert.strictEqual(gh.url, 'https://api.github.com/zen');
  assert.strictEqual((gh.options.headers as any)['Authorization'], `Bearer ${dummyKey}`);

  // 2. Discord: Bot prefix no header Authorization
  const discord = getProviderPingConfig('discord', undefined, dummyKey);
  assert.strictEqual(discord.url, 'https://discord.com/api/v10/gateway');
  assert.strictEqual((discord.options.headers as any)['Authorization'], `Bot ${dummyKey}`);

  // 3. Slack: Bearer token e api.test
  const slack = getProviderPingConfig('slack', undefined, dummyKey);
  assert.strictEqual(slack.url, 'https://slack.com/api/api.test');
  assert.strictEqual((slack.options.headers as any)['Authorization'], `Bearer ${dummyKey}`);

  // 4. Supabase: apikey e Authorization Bearer
  const sb = getProviderPingConfig('supabase', 'https://xyzcompany.supabase.co', dummyKey);
  assert.strictEqual(sb.url, 'https://xyzcompany.supabase.co/rest/v1/');
  assert.strictEqual((sb.options.headers as any)['apikey'], dummyKey);
  assert.strictEqual((sb.options.headers as any)['Authorization'], `Bearer ${dummyKey}`);

  // 5. Mercado Pago: Bearer token
  const mp = getProviderPingConfig('mercadopago', undefined, dummyKey);
  assert.strictEqual(mp.url, 'https://api.mercadopago.com/v1/identification_types');
  assert.strictEqual((mp.options.headers as any)['Authorization'], `Bearer ${dummyKey}`);
});

test('NIA-03: Cofre em memória privada protege chaves brutas de vazamento na UI e logs', async () => {
  const bus = new EventBus();
  const vault = new IntegrationsVault(bus);

  const rawKey = 'sbp_RAWSECRET_DO_NOT_LEAK_INTO_UI_OR_LOGS_9988';
  await vault.connectService('svc-supabase', rawKey, {
    customLatencyMs: 30
  });

  // 1. getServices() nunca expõe chaves brutas
  const services = vault.getServices();
  const sbSvc = services.find(s => s.id === 'svc-supabase')!;
  assert.ok(sbSvc);
  assert.strictEqual(sbSvc.maskedKey, 'sbp_...9988');
  assert.ok(!JSON.stringify(services).includes(rawKey), 'A chave bruta não pode vazar em JSON serializado de serviços');

  // 2. getCredentials() contém apenas maskedKey e fingerprint
  const creds = vault.getCredentials();
  const sbCred = creds.find(c => c.provider === 'supabase')!;
  assert.ok(sbCred);
  assert.strictEqual(sbCred.maskedKey, 'sbp_...9988');
  assert.strictEqual(sbCred.fingerprint, computeKeyFingerprint(rawKey));
  assert.ok(!JSON.stringify(creds).includes(rawKey), 'A chave bruta não pode vazar em credenciais');

  // 3. Higienização por redactSecrets
  const logMessage = `Falha ao autenticar com token ${rawKey} no cluster`;
  const sanitized = redactSecrets(logMessage);
  assert.ok(!sanitized.includes(rawKey));
  assert.ok(sanitized.includes('[REDACTED_CREDENTIAL]'));
});

test('NIA-04: Tratamento defensivo de timeout e falhas de rede (Offline / Host inalcançável)', async () => {
  const bus = new EventBus();
  const vault = new IntegrationsVault(bus);

  // Mock fetch que simula erro de conexão (ECONNREFUSED / Host unreachable)
  const failingFetch: typeof fetch = async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:9999');
  };

  const pingRes = await vault.testServicePing('svc-github', undefined, failingFetch);
  assert.strictEqual(pingRes.success, false);
  assert.strictEqual(pingRes.status, 'ERROR');
  assert.ok(pingRes.error?.includes('Falha de conexão com GitHub'));
  assert.strictEqual(vault.getService('svc-github')?.status, 'ERROR');

  // Mock fetch que simula Timeout (AbortError)
  const timeoutFetch: typeof fetch = async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  };

  const timeoutRes = await vault.testServicePing('svc-github', undefined, timeoutFetch);
  assert.strictEqual(timeoutRes.success, false);
  assert.strictEqual(timeoutRes.status, 'ERROR');
  assert.ok(timeoutRes.error?.includes('Tempo limite de conexão esgotado'));
});

test('NIA-05: Tratamento de respostas de erro HTTP do provedor (401 Auth Error e 429 Rate Limit)', async () => {
  const bus = new EventBus();
  const vault = new IntegrationsVault(bus);

  // 1. Simulação de Rate Limit (HTTP 429)
  const rateLimitFetch: typeof fetch = async () => {
    return new Response('Rate limit exceeded', { status: 429 });
  };

  const rlRes = await vault.testServicePing('svc-mercadopago', undefined, rateLimitFetch);
  assert.strictEqual(rlRes.success, false);
  assert.strictEqual(rlRes.status, 'RATE_LIMITED');
  assert.strictEqual(rlRes.httpStatusCode, 429);
  assert.strictEqual(vault.getService('svc-mercadopago')?.status, 'RATE_LIMITED');

  // 2. Simulação de Chave Inválida (HTTP 401 Unauthorized)
  const authErrorFetch: typeof fetch = async () => {
    return new Response('Bad credentials', { status: 401 });
  };

  const authRes = await vault.testServicePing('svc-github', undefined, authErrorFetch);
  assert.strictEqual(authRes.success, false);
  assert.strictEqual(authRes.status, 'ERROR');
  assert.strictEqual(authRes.httpStatusCode, 401);
  assert.ok(authRes.error?.includes('Falha de autenticação'));
});

test('NIA-06: Disparo de Webhook de saída HTTP (dispatchOutgoingWebhook) com higienização estrita', async () => {
  let receivedHeaderAuth = '';
  let receivedUserAgent = '';
  let receivedBody: any = null;

  const webhookServer = http.createServer(async (req, res) => {
    receivedHeaderAuth = req.headers['authorization'] || '';
    receivedUserAgent = req.headers['user-agent'] || '';

    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      receivedBody = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ delivered: true }));
    });
  });

  await new Promise<void>((resolve) => webhookServer.listen(0, resolve));
  const port = (webhookServer.address() as import('net').AddressInfo).port;
  const webhookUrl = `http://localhost:${port}/webhook/dispatch`;

  try {
    const bus = new EventBus();
    const vault = new IntegrationsVault(bus);

    const secretKey = 'ghp_SECRETTOKEN1234567890ABCDEF1234';
    await vault.connectService('svc-github', secretKey, {
      endpointUrl: webhookUrl,
      customLatencyMs: 20
    });

    // Disparar Webhook com payload contendo campo sensível que deve ser redigido
    const dispatchRes = await vault.dispatchOutgoingWebhook('svc-github', 'ci.build.completed', {
      buildId: 'b-9988',
      status: 'success',
      client_secret: 'leaked-secret-passphrase-to-scrub',
      commitAuthor: 'developer@liora.local'
    });

    assert.strictEqual(dispatchRes.success, true);
    assert.strictEqual(dispatchRes.statusCode, 200);

    // Conferir o que o servidor externo recebeu
    assert.strictEqual(receivedHeaderAuth, `Bearer ${secretKey}`);
    assert.strictEqual(receivedUserAgent, 'LIORA-Native-Desktop/1.0');
    assert.strictEqual(receivedBody.event, 'ci.build.completed');
    assert.strictEqual(receivedBody.payload.client_secret, '[REDACTED_SECRET]', 'Campos sensíveis no payload de saída devem ser expurgados');
    assert.strictEqual(receivedBody.payload.buildId, 'b-9988');
  } finally {
    await new Promise<void>((resolve) => webhookServer.close(() => resolve()));
  }
});

test('NIA-07: Publicação de eventos de ciclo de vida no barramento EventBus', async () => {
  const bus = new EventBus();
  const vault = new IntegrationsVault(bus);

  const publishedEvents: Array<{ event: string; data: any }> = [];
  bus.subscribe('SERVICE_CONNECTED', (data) => { publishedEvents.push({ event: 'SERVICE_CONNECTED', data }); });
  bus.subscribe('SERVICE_DISCONNECTED', (data) => { publishedEvents.push({ event: 'SERVICE_DISCONNECTED', data }); });
  bus.subscribe('WEBHOOK_SENT', (data) => { publishedEvents.push({ event: 'WEBHOOK_SENT', data }); });

  // 1. Conexão
  await vault.connectService('svc-slack', 'xoxb-1234567890-test', { customLatencyMs: 25 });
  assert.ok(publishedEvents.some(e => e.event === 'SERVICE_CONNECTED' && e.data.serviceId === 'svc-slack'));

  // 2. Desconexão
  vault.disconnectService('svc-slack');
  assert.ok(publishedEvents.some(e => e.event === 'SERVICE_DISCONNECTED' && e.data.serviceId === 'svc-slack'));
  assert.strictEqual(vault.getService('svc-slack')?.status, 'DISCONNECTED');
});

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Testes de Regressão — Auditoria Pass 5 (bugs encontrados e corrigidos na raiz)
 *  - DEDUPE-X1: `open_browser({browser:'chrome'})` colide com `pc_launch:chrome`
 *    (impede o duplo disparo do comando de voz "abra o chrome").
 *  - SHIELD-X1: store e motor de automações nascem com o mesmo estado de Shield Mode.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommandDedupeKey } from '../src/utils/commandDeduplicator';
import { automationsEngine } from '../src/services/automationsEngine';
import { useLioraStore } from '../src/store/lioraStore';

test('DEDUPE-X1: open_browser com navegador explícito colide com a abertura do app (pc_launch)', () => {
  const launchChrome = buildCommandDedupeKey('open_application', { appName: 'Google Chrome' });
  const launchEdge = buildCommandDedupeKey('pc_manage_apps', { action: 'launch', appPath: 'msedge' });
  const browserChrome = buildCommandDedupeKey('open_browser', { browser: 'chrome' });
  const browserChromeWithUrl = buildCommandDedupeKey('open_browser', { browser: 'chrome', url: 'https://www.google.com' });
  const browserDefault = buildCommandDedupeKey('open_browser', {});
  const browserDefaultOther = buildCommandDedupeKey('open_browser', { url: 'https://exemplo.com' });
  const browserEdge = buildCommandDedupeKey('open_browser', { browser: 'msedge' });

  assert.equal(launchChrome, 'pc_launch:chrome');
  assert.equal(browserChrome, 'pc_launch:chrome');
  assert.equal(browserChromeWithUrl, 'pc_launch:chrome');
  assert.equal(launchEdge, 'pc_launch:msedge');
  assert.equal(browserEdge, 'pc_launch:msedge');

  // Navegador padrão (desconhecido) mantém chave própria e não colide com apps
  assert.notEqual(browserDefault, browserChrome);
  assert.notEqual(browserDefault, browserDefaultOther);
  assert.match(browserDefault, /^open_browser:default:/);
});

test('SHIELD-X1: estado inicial do store espelha o motor de automações', () => {
  assert.equal(useLioraStore.getState().shieldModeActive, automationsEngine.isShieldMode());

  useLioraStore.getState().setShieldMode(true);
  assert.equal(automationsEngine.isShieldMode(), true);
  assert.equal(useLioraStore.getState().shieldModeActive, true);

  useLioraStore.getState().setShieldMode(false);
  assert.equal(automationsEngine.isShieldMode(), false);
  assert.equal(useLioraStore.getState().shieldModeActive, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Pass 5 — camada de voz, verificação e retry
// ─────────────────────────────────────────────────────────────────────────────

test('RETRY-X1: retryMessage substitui a bolha na SESSÃO alvo (não grava messages globais nela)', async () => {
  const store = useLioraStore.getState();
  const sessionId = store.createSession('Retry sessão alvo');
  const fixture: any[] = [
    { id: 'u-retry', sender: 'user', text: 'Pergunta do retry', timestamp: '10:00', status: 'completed' },
    { id: 'a-retry', sender: 'assistant', text: '', timestamp: '10:01', status: 'error', errorCode: 'AUTH_ERROR', errorMessage: 'falha' }
  ];
  useLioraStore.setState({
    sessions: useLioraStore.getState().sessions.map(s => s.id === sessionId ? { ...s, messages: fixture } : s),
    messages: fixture,
    isGenerating: false
  });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response('data: {"done":true}\n\n', { status: 200 })) as any;
    const pending = useLioraStore.getState().retryMessage('a-retry');
    // Guard atômico: uma segunda chamada concorrente é rejeitada sem criar outro stream
    const concurrent = useLioraStore.getState().retryMessage('a-retry');
    await Promise.all([pending, concurrent]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const session = useLioraStore.getState().sessions.find(s => s.id === sessionId);
  assert.ok(session, 'A sessão alvo precisa existir');
  const assistantBubbles = session!.messages.filter(m => m.sender === 'assistant');
  assert.equal(assistantBubbles.length, 1, 'Não deve criar streams/bolhas duplicadas no mesmo retry');
  assert.ok(!session!.messages.some(m => m.id === 'a-retry'), 'A bolha com erro precisa ter sido removida da sessão');
  assert.equal(session!.messages.filter(m => m.sender === 'user').length, 1, 'A mensagem do usuário não deve ser duplicada');
});

test('ABORT-X1: abortGeneration sem controller libera o estado isGenerating (UI não fica presa)', () => {
  useLioraStore.setState({ isGenerating: true, isVoiceActive: false });
  useLioraStore.getState().abortGeneration();
  assert.equal(useLioraStore.getState().isGenerating, false);
  assert.equal(useLioraStore.getState().orbState, 'IDLE');
});

test('VERIFY-X1: system_exec_sandbox é aprovado com exitCode 0 mesmo escrevendo em stderr', async () => {
  const { verifierEngine } = await import('../src/tools/verifier');
  const ok = await verifierEngine.verifyExecution(
    'system_exec_sandbox',
    { command: 'git status' },
    { exitCode: 0, stdout: 'On branch main\n', stderr: 'warning: LF will be replaced by CRLF' }
  );
  assert.equal(ok.passed, true);

  const failed = await verifierEngine.verifyExecution(
    'system_exec_sandbox',
    { command: 'git status' },
    { exitCode: 1, stdout: '', stderr: 'fatal: not a git repository' }
  );
  assert.equal(failed.passed, false);
});

test('AUDIO-X1: fallback meter é cancelado no teardown (sem loops órfãos de nível)', async () => {
  const mod = await import('../src/services/speechService');
  const speech: any = mod.speechService;
  assert.equal(typeof speech.startFallbackAudioMeter, 'function');
  // Não há DOM no runner: só garantimos que a API interna aceita ser chamada e
  // que o teardown não lança com handles nulos (regressão do loop rAF órfão).
  assert.doesNotThrow(() => speech.stopAudioMeter(true));
});

test('DEV-X1: sendCommand sempre resolve (não deixa a UI presa) e emite evento SSE', async () => {
  const { DevicesManager } = await import('../src/services/devicesManager');
  const engine = new (await import('../src/security/permissionEngine')).PermissionEngine();
  const manager = new DevicesManager(engine);

  const events: any[] = [];
  const unsubscribe = manager.subscribe((ev) => events.push(ev));

  try {
    const ok = await manager.sendCommand('dev-1', 'FETCH_TELEMETRY', 'R0');
    assert.equal(ok.deviceId, 'dev-1');
    assert.ok(events.some(e => e.type === 'DEVICE_COMMAND'), 'Deve publicar DEVICE_COMMAND via SSE');

    // Força uma falha interna do motor de permissões e garante fail-closed sem rejeição
    (engine as any).evaluate = async () => { throw new Error('motor indisponível'); };
    const failed = await manager.sendCommand('dev-1', 'REBOOT', 'R1');
    assert.equal(failed.status, 'BLOCKED_BY_POLICY', 'Falha interna vira registro bloqueado, nunca promessa rejeitada');
    assert.ok(manager.getCommandLogs().some(c => c.id === failed.id));
  } finally {
    unsubscribe();
  }
});

test('AUTO-X1: acionamento manual R1 na UI chega em WAITING_CONSENT e o "Aprovar Execução" executa de verdade', async () => {
  const store = useLioraStore.getState();
  const ruleId = 'audit-pass6-manual-r1';
  store.addAutomation({
    name: 'Auditoria Pass6 R1',
    description: 'Regra R1 acionada manualmente',
    enabled: true,
    trigger: { type: 'MANUAL', config: {}, humanReadable: 'Manual' },
    action: {
      type: 'EXECUTE_TOOL',
      toolName: 'workspace_write_file',
      parameters: { filePath: 'workspace/audit_pass6.txt', content: 'ok' },
      description: 'Gravar arquivo',
      expectedRiskLevel: 'R1'
    }
  } as any);
  // O addAutomation gera um id próprio — recupera a última regra criada
  const created = useLioraStore.getState().automations.find(a => a.action?.parameters?.filePath === 'workspace/audit_pass6.txt');
  assert.ok(created, 'Regra de teste precisa ter sido criada');

  store.setPendingConsent(null);
  const log = await store.triggerAutomationNow(created!.id);
  assert.ok(log, 'triggerAutomationNow deve retornar um log');
  assert.equal(log!.status, 'WAITING_CONSENT', 'Antes o fail-closed matava o fluxo manual de consentimento');

  const pending = useLioraStore.getState().pendingConsent;
  assert.ok(pending && pending.ruleId === created!.id, 'O ConsentCard precisa receber a solicitação');

  const approved = await store.approveAutomationConsent(created!.id);
  assert.ok(approved, 'Aprovação deve retornar o log');
  assert.notEqual(approved!.status, 'BLOCKED_BY_POLICY', 'Token emitido no pedido não pode ser invalidado na aprovação');
});

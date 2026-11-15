/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { audioGate } from '../src/services/audioGate';
import { detectRuntimeEnvironment, shouldUseWebPreviewDesktopFallback } from '../src/utils/runtimeEnvironment';
import { openBrowserTool, pcManageAppsTool } from '../src/tools/pcControlTools';
import { installNativeServerTools } from '../src/tools/nativeServerTools';
import { ToolRegistry } from '../src/tools/registry';
import { PermissionEngine } from '../src/security/permissionEngine';
import { computeParametersHash } from '../src/security/canonicalizer';
import { STRICT_PROFILE } from '../src/security/profiles';
import { IntegrationsVault } from '../src/services/integrationsVault';
import { EventBus } from '../src/utils/eventBus';

test('Bug 1: AudioGate enforces strict mutual exclusion between Live WS, Neural TTS and Offline TTS', () => {
  audioGate.resetForTests();

  let neuralAborted = 0;
  let offlineAborted = 0;
  let liveAborted = 0;

  const unsubNeural = audioGate.registerAbortHandler('neural_tts', () => { neuralAborted++; });
  const unsubOffline = audioGate.registerAbortHandler('offline_tts', () => { offlineAborted++; });
  const unsubLive = audioGate.registerAbortHandler('live_ws', () => { liveAborted++; });

  try {
    // Enquanto Live Session estiver ativa e não suprimida, TTS offline e Neural TTS não determinístico devem ser silenciados
    audioGate.setLiveSessionActive(true);
    assert.equal(audioGate.canUseOfflineTts(), false);
    assert.equal(audioGate.canAcquire('neural_tts'), false);
    assert.equal(audioGate.acquireChannel('offline_tts'), false);
    assert.equal(audioGate.acquireChannel('neural_tts'), false);

    // Adquirir Live WS deve abortar canais concorrentes
    assert.equal(audioGate.acquireChannel('live_ws'), true);
    assert.equal(audioGate.getState().activeChannel, 'live_ws');
    assert.ok(neuralAborted >= 1);
    assert.ok(offlineAborted >= 1);

    // Supressão determinística deve interromper Live WS imediatamente e permitir feedback determinístico
    audioGate.suppressLiveFor(3000);
    assert.equal(audioGate.isLiveSuppressed(), true);
    assert.ok(liveAborted >= 1);
    assert.equal(audioGate.canAcquire('live_ws'), false);
    assert.equal(audioGate.canAcquire('neural_tts', { isDeterministicOverride: true }), true);
    assert.equal(audioGate.acquireChannel('neural_tts', { isDeterministicOverride: true }), true);
    assert.equal(audioGate.getState().activeChannel, 'neural_tts');

    // abortAll limpa qualquer canal ativo
    audioGate.abortAll();
    assert.equal(audioGate.getState().activeChannel, null);
  } finally {
    unsubNeural();
    unsubOffline();
    unsubLive();
    audioGate.resetForTests();
  }
});

test('Bug 2 & 4: Runtime detection & Cloud Web Preview fallback vs Tauri Desktop', () => {
  const headless = detectRuntimeEnvironment({ platform: 'linux', env: {}, isTauri: false });
  assert.equal(headless.mode, 'web-preview-headless');
  assert.equal(headless.webPreviewFallbackActive, true);
  assert.equal(headless.isTauri, false);

  const dryRun = detectRuntimeEnvironment({ platform: 'linux', env: { LIORA_NO_BROWSER: '1' }, isTauri: false });
  assert.equal(dryRun.isDryRun, true);
  assert.equal(dryRun.webPreviewFallbackActive, false);

  const tauriWin = detectRuntimeEnvironment({ platform: 'win32', env: {}, isTauri: true });
  assert.equal(tauriWin.mode, 'tauri-desktop');
  assert.equal(tauriWin.webPreviewFallbackActive, false);
  assert.equal(tauriWin.hasGuiDisplay, true);
});

test('Bug 2 & 4: openBrowserTool & pcManageAppsTool validate URLs and handle Web Preview headless fallback cleanly', async () => {
  // Bloqueia protocolos perigosos
  const badUrlRes = await openBrowserTool.execute({ url: 'file:///etc/passwd', browser: 'chrome' });
  assert.equal(badUrlRes.success, false);
  assert.match(String(badUrlRes.message || badUrlRes.error), /HTTP|HTTPS|URL/i);

  const jsUrlRes = await openBrowserTool.execute({ url: 'javascript:alert(1)', browser: 'default' });
  assert.equal(jsUrlRes.success, false);

  // Testa modo Web Preview headless fallback (sem DISPLAY em container Linux)
  const prevNoBrowser = process.env.LIORA_NO_BROWSER;
  const prevDisplay = process.env.DISPLAY;
  const prevWayland = process.env.WAYLAND_DISPLAY;
  try {
    delete process.env.LIORA_NO_BROWSER;
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;

    if (process.platform === 'linux' && shouldUseWebPreviewDesktopFallback()) {
      const browserRes = await openBrowserTool.execute({ url: 'https://www.google.com', browser: 'chrome' });
      assert.equal(browserRes.success, true);
      assert.equal(browserRes.simulated, true);
      assert.equal(browserRes.runtimeMode, 'web-preview-simulated');

      const notepadRes = await pcManageAppsTool.execute({ action: 'launch', appPath: 'notepad' });
      assert.equal(notepadRes.success, true);
      assert.equal(notepadRes.simulated, true);
      assert.equal(notepadRes.runtimeMode, 'web-preview-simulated');
    }

    // Garante dryRun em LIORA_NO_BROWSER=1
    process.env.LIORA_NO_BROWSER = '1';
    const dryRes = await openBrowserTool.execute({ url: 'https://www.google.com', browser: 'chrome' });
    assert.equal(dryRes.success, true);
    assert.equal(dryRes.dryRun, true);
  } finally {
    if (prevNoBrowser !== undefined) process.env.LIORA_NO_BROWSER = prevNoBrowser;
    else delete process.env.LIORA_NO_BROWSER;
    if (prevDisplay !== undefined) process.env.DISPLAY = prevDisplay;
    if (prevWayland !== undefined) process.env.WAYLAND_DISPLAY = prevWayland;
  }
});

test('Bug 2: PermissionEngine requires single-use consent for R1/R2 desktop tools and rejects replay', async () => {
  const reg = new ToolRegistry();
  installNativeServerTools(reg);
  assert.equal(reg.hasTool('open_browser'), true);
  assert.equal(reg.hasTool('pc_manage_apps'), true);
  assert.equal(reg.hasTool('open_application'), true);

  assert.equal(STRICT_PROFILE.allowedTools.includes('open_browser'), true);
  assert.equal(STRICT_PROFILE.allowedTools.includes('open_application'), true);

  const engine = new PermissionEngine(STRICT_PROFILE);
  const ctx = { sessionId: 'test-session-consent', clientIp: '127.0.0.1', serverTimestamp: Date.now() };
  const params = { browser: 'chrome', url: 'https://example.com' };

  // 1. Sem token deve exigir confirmação explícita (nunca retornar ALLOW silencioso)
  const denied = await engine.evaluate('open_browser', params, ctx, { riskLevel: 'R2' });
  assert.equal(denied.decision, 'DENY');
  assert.equal(denied.code, 'REQUIRES_USER_CONFIRMATION');
  assert.equal(denied.requiredConfirmation, true);

  // 2. Com token emitido e parâmetros idênticos deve permitir (ALLOW)
  const hash = computeParametersHash(params);
  const issued = await engine.issueConsentToken('open_browser', hash, ctx.sessionId);
  const allowed = await engine.evaluate('open_browser', params, ctx, { riskLevel: 'R2', consentToken: issued.token });
  assert.equal(allowed.decision, 'ALLOW');

  // 3. Replay do mesmo token deve ser bloqueado
  const replay = await engine.evaluate('open_browser', params, ctx, { riskLevel: 'R2', consentToken: issued.token });
  assert.equal(replay.decision, 'DENY');
  assert.equal(replay.code, 'REQUIRES_USER_CONFIRMATION');
});

test('Bug 3: IntegrationsVault hydrates .env keys at startup, persists across reloads, and respects manual disconnect', async () => {
  const prevGem = process.env.GEMINI_API_KEY;
  const prevOr = process.env.OPENROUTER_API_KEY;
  try {
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    // Limpa estado em memória compartilhado entre instâncias sem localStorage
    (IntegrationsVault as any).inMemoryStore?.clear?.();

    const bus = new EventBus();
    const vault = new IntegrationsVault(bus);

    assert.equal(vault.getService('svc-gemini')?.status, 'DISCONNECTED');
    assert.equal(vault.getService('svc-openrouter')?.status, 'DISCONNECTED');

    const mockFetch = (async () => ({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        success: true,
        gemini: { isConfigured: true, masked: 'AIza...9876' },
        openrouter: { isConfigured: true, masked: 'sk-o...4321' }
      })
    })) as unknown as typeof fetch;

    const changed = await vault.syncWithBackendEnv(mockFetch);
    assert.equal(changed, true);

    const gem = vault.getService('svc-gemini');
    const or = vault.getService('svc-openrouter');
    assert.equal(gem?.status, 'CONNECTED');
    assert.equal(gem?.maskedKey, 'AIza...9876');
    assert.equal(gem?.isSimulated, false);
    assert.equal(or?.status, 'CONNECTED');
    assert.equal(or?.maskedKey, 'sk-o...4321');
    assert.equal(vault.getCredentials().some(c => c.associatedServiceId === 'svc-gemini' && c.status === 'valid'), true);

    // Simula reinício carregando do snapshot salvo
    const restartedVault = new IntegrationsVault(new EventBus());
    assert.equal(restartedVault.getService('svc-gemini')?.status, 'CONNECTED');
    assert.equal(restartedVault.getService('svc-openrouter')?.status, 'CONNECTED');

    // Desconexão manual não deve ser sobrescrita pela re-hidratação do .env
    assert.equal(restartedVault.disconnectService('svc-openrouter'), true);
    assert.equal(restartedVault.getService('svc-openrouter')?.status, 'DISCONNECTED');
    await restartedVault.syncWithBackendEnv(mockFetch);
    assert.equal(restartedVault.getService('svc-openrouter')?.status, 'DISCONNECTED');
    assert.equal(restartedVault.getService('svc-gemini')?.status, 'CONNECTED');
  } finally {
    if (prevGem !== undefined) process.env.GEMINI_API_KEY = prevGem;
    if (prevOr !== undefined) process.env.OPENROUTER_API_KEY = prevOr;
  }
});

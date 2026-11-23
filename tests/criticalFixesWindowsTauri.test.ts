/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CommandDeduplicator,
  DEFAULT_COMMAND_DEDUPE_WINDOW_MS,
  buildCommandDedupeKey,
  commandDeduplicator
} from '../src/utils/commandDeduplicator';
import { parseConsentVoiceDecision } from '../src/utils/consentVoiceParser';
import { ToolRegistry } from '../src/tools/registry';
import {
  openApplicationTool,
  pcManageAppsTool,
  pcSimulateInputTool
} from '../src/tools/pcControlTools';
import { executeLocalTool } from '../src/security/localBridge';
import { PermissionEngine, permissionEngine } from '../src/security/permissionEngine';
import { computeParametersHash } from '../src/security/canonicalizer';
import { STRICT_PROFILE } from '../src/security/profiles';
import { AuditLogger } from '../src/security/auditLogger';
import { CONSENT_AUTO_DISMISS_MS, useLioraStore } from '../src/store/lioraStore';
import { executePcAction } from '../src/tools/pc/pcActionLauncher';
import { audioGate } from '../src/services/audioGate';
import { speechService } from '../src/services/speechService';

test('Bug 1: CommandDeduplicator canonicalizes aliases and enforces 3000ms debounce window', () => {
  assert.equal(DEFAULT_COMMAND_DEDUPE_WINDOW_MS, 3000);

  const keyFromOpenApp = buildCommandDedupeKey('open_application', { appName: 'Bloco de Notas' });
  const keyFromManageApps = buildCommandDedupeKey('pc_manage_apps', { action: 'launch', appPath: 'notepad.exe' });
  assert.equal(keyFromOpenApp, 'pc_launch:notepad');
  assert.equal(keyFromManageApps, 'pc_launch:notepad');

  const deduper = new CommandDeduplicator(3000);
  const t0 = 1_000_000;

  const first = deduper.checkAndLock(keyFromOpenApp, t0);
  assert.equal(first.isDuplicate, false);

  const second = deduper.checkAndLock(keyFromManageApps, t0 + 1200);
  assert.equal(second.isDuplicate, true);
  assert.equal(second.remainingMs, 1800);

  const afterWindow = deduper.checkAndLock(keyFromManageApps, t0 + 3001);
  assert.equal(afterWindow.isDuplicate, false);

  deduper.release(keyFromOpenApp);
  const afterRelease = deduper.checkAndLock(keyFromOpenApp, t0 + 3100);
  assert.equal(afterRelease.isDuplicate, false);
});

test('Bug 1: ToolRegistry suppresses duplicate side-effectful calls inside 3000ms window', async () => {
  commandDeduplicator.reset();
  const prevNoBrowser = process.env.LIORA_NO_BROWSER;
  process.env.LIORA_NO_BROWSER = '1';

  try {
    const registry = new ToolRegistry();
    registry.registerTool(openApplicationTool);
    registry.registerTool(pcManageAppsTool);

    const r1 = await registry.executeTool('open_application', { appName: 'Bloco de Notas' });
    assert.equal(r1.success, true);
    assert.notEqual(r1.data?.duplicateSuppressed, true);

    const r2 = await registry.executeTool('pc_manage_apps', { action: 'launch', appPath: 'notepad' });
    assert.equal(r2.success, true);
    assert.equal(r2.data?.duplicateSuppressed, true);

    const r3 = await registry.executeTool('open_application', { appName: 'Bloco de Notas' }, { skipDedupe: true });
    assert.equal(r3.success, true);
    assert.notEqual(r3.data?.duplicateSuppressed, true);
  } finally {
    commandDeduplicator.reset();
    if (prevNoBrowser !== undefined) process.env.LIORA_NO_BROWSER = prevNoBrowser;
    else delete process.env.LIORA_NO_BROWSER;
  }
});

test('Bug 2a: pcSimulateInputTool configures 15000ms timeout and resolves typing cleanly', async () => {
  assert.equal(pcSimulateInputTool.riskLevel, 'R2');
  assert.equal(pcSimulateInputTool.timeoutMs, 15000);
  assert.equal(pcManageAppsTool.timeoutMs, 15000);
  assert.equal(openApplicationTool.timeoutMs, 15000);

  const prevNoBrowser = process.env.LIORA_NO_BROWSER;
  process.env.LIORA_NO_BROWSER = '1';
  try {
    const res = await pcSimulateInputTool.execute({ action: 'type', text: 'Olá LIORA Windows' });
    assert.equal(res.success, true);
    assert.equal(res.dryRun, true);
  } finally {
    if (prevNoBrowser !== undefined) process.env.LIORA_NO_BROWSER = prevNoBrowser;
    else delete process.env.LIORA_NO_BROWSER;
  }
});

test('Bug 2a: localBridge falls back to Express backend when Tauri Rust returns unsupported tool error', async () => {
  const prevWindow = (globalThis as any).window;
  const prevFetch = globalThis.fetch;

  let fetchCalledUrl = '';
  try {
    (globalThis as any).window = {
      location: { protocol: 'tauri:', host: 'tauri.localhost' },
      __TAURI__: {
        core: {
          invoke: async () => ({
            toolName: 'pc_simulate_input',
            success: false,
            error: "Ferramenta desconhecida ou não suportada no Tauri: 'pc_simulate_input'.",
            simulated: false,
            riskLevel: 'R2',
            executionTimeMs: 1,
            timestamp: new Date().toISOString()
          })
        }
      }
    };

    globalThis.fetch = (async (url: string) => {
      fetchCalledUrl = url;
      return new Response(
        JSON.stringify({
          success: true,
          toolName: 'pc_simulate_input',
          decision: 'ALLOW',
          riskLevel: 'R2',
          simulated: false,
          data: { message: 'Texto enviado via Express bridge.' }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as any;

    const res = await executeLocalTool('pc_simulate_input', { action: 'type', text: 'Teste' }, 'sess-tauri', 'tok-1');
    assert.equal(res.success, true);
    assert.match(fetchCalledUrl, /\/api\/tools\/execute$/);
    assert.equal((res.data as { message?: string } | undefined)?.message, 'Texto enviado via Express bridge.');
  } finally {
    globalThis.fetch = prevFetch;
    if (prevWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = prevWindow;
  }
});

test('Bug 2b: parseConsentVoiceDecision classifies APPROVE, REJECT and filters assistant prompt echo', () => {
  // Confirmations
  assert.equal(parseConsentVoiceDecision('autorizar'), 'APPROVE');
  assert.equal(parseConsentVoiceDecision('pode executar'), 'APPROVE');
  assert.equal(parseConsentVoiceDecision('Confirmar!'), 'APPROVE');
  assert.equal(parseConsentVoiceDecision('pode fazer isso sim'), 'APPROVE');
  assert.equal(parseConsentVoiceDecision('sim'), 'APPROVE');

  // Rejections (including negated approval -> REJECT fail-closed)
  assert.equal(parseConsentVoiceDecision('cancelar'), 'REJECT');
  assert.equal(parseConsentVoiceDecision('negar'), 'REJECT');
  assert.equal(parseConsentVoiceDecision('não'), 'REJECT');
  assert.equal(parseConsentVoiceDecision('não autorizar'), 'REJECT');
  assert.equal(parseConsentVoiceDecision('não confirmar'), 'REJECT');

  // Assistant echo filtering
  assert.equal(
    parseConsentVoiceDecision('Atenção. Ação requer confirmação. Diga confirmar para autorizar, ou cancelar para recusar.'),
    null
  );
  assert.equal(parseConsentVoiceDecision('olá liora tudo bem'), null);
});

test('Bug 3: lioraStore consent transitions auto-dismiss pendingConsent after CONSENT_AUTO_DISMISS_MS (2500ms)', async () => {
  assert.equal(CONSENT_AUTO_DISMISS_MS, 2500);

  const prevFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/api/security/ui-consent')) {
        return new Response(JSON.stringify({ token: 'mock-ui-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(
        JSON.stringify({
          success: true,
          toolName: 'pc_simulate_input',
          decision: 'ALLOW',
          riskLevel: 'R2',
          simulated: true,
          data: { ok: true }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as any;

    useLioraStore.getState().setPendingConsent({
      auditId: 'audit-dismiss-test-1',
      ruleId: 'test-rule',
      toolName: 'pc_simulate_input',
      riskLevel: 'R2',
      parameters: { action: 'type', text: 'abc' },
      consentToken: '',
      sessionId: 'test-session',
      expiresAt: Date.now() + 60_000,
      status: 'PENDING'
    });

    await useLioraStore.getState().approveConsent();
    assert.equal(useLioraStore.getState().pendingConsent?.status, 'APPROVED');

    // Ainda visível antes de 2.5s, desaparece após ~2.6s
    await new Promise((r) => setTimeout(r, 2650));
    assert.equal(useLioraStore.getState().pendingConsent, null);

    // Também testa rejectConsent -> REJECTED -> auto-dismiss em 2.5s
    useLioraStore.getState().setPendingConsent({
      auditId: 'audit-dismiss-test-2',
      ruleId: 'test-rule',
      toolName: 'open_application',
      riskLevel: 'R1',
      parameters: { appName: 'notepad' },
      consentToken: '',
      sessionId: 'test-session',
      expiresAt: Date.now() + 60_000,
      status: 'PENDING'
    });
    useLioraStore.getState().rejectConsent();
    assert.equal(useLioraStore.getState().pendingConsent?.status, 'REJECTED');
    await new Promise((r) => setTimeout(r, 2650));
    assert.equal(useLioraStore.getState().pendingConsent, null);
  } finally {
    useLioraStore.getState().setPendingConsent(null);
    globalThis.fetch = prevFetch;
  }
});

test('Bug 4: PermissionEngine honors per-tool 3-state policy precedence over global auto-approve and protects R3', async () => {
  const logger = new AuditLogger(50);
  const engine = new PermissionEngine(STRICT_PROFILE, logger);
  const ctx = { sessionId: 'sess-policy-1', serverTimestamp: Date.now() };

  // 1. Padrão: R0 system_info ALLOW, R1 system_exec_simulated REQUIRES_USER_CONFIRMATION
  const r0Default = await engine.evaluate('system_info', { detailLevel: 'standard' }, ctx, { riskLevel: 'R0' });
  assert.equal(r0Default.decision, 'ALLOW');

  const r1Default = await engine.evaluate('system_exec_simulated', { command: 'git status' }, ctx, { riskLevel: 'R1' });
  assert.equal(r1Default.decision, 'DENY');
  assert.equal(r1Default.code, 'REQUIRES_USER_CONFIRMATION');

  // 2. Política individual 'always_allow' libera R1/R2 mesmo com globalAutoApprove = false
  engine.setToolPolicy('system_exec_simulated', 'always_allow');
  const r1AlwaysAllow = await engine.evaluate('system_exec_simulated', { command: 'git status' }, ctx, { riskLevel: 'R1' });
  assert.equal(r1AlwaysAllow.decision, 'ALLOW');

  // 3. Global Auto-Approve libera ferramentas em política 'default'
  engine.setGlobalAutoApprove(true);
  const r2GlobalAllow = await engine.evaluate('pc_simulate_input', { action: 'type', text: 'hi' }, ctx, { riskLevel: 'R2' });
  assert.equal(r2GlobalAllow.decision, 'ALLOW');

  // 4. Política individual 'always_require_consent' SOBRESCREVE globalAutoApprove = true e até R0!
  engine.setToolPolicy('system_info', 'always_require_consent');
  const r0ForcedConsent = await engine.evaluate('system_info', { detailLevel: 'standard' }, ctx, { riskLevel: 'R0' });
  assert.equal(r0ForcedConsent.decision, 'DENY');
  assert.equal(r0ForcedConsent.code, 'REQUIRES_USER_CONFIRMATION');

  // E com token HMAC válido emitido, 'always_require_consent' permite a execução única
  const pHash = computeParametersHash({ detailLevel: 'standard' });
  const issued = await engine.issueConsentToken('system_info', pHash, ctx.sessionId);
  const r0WithToken = await engine.evaluate('system_info', { detailLevel: 'standard' }, ctx, {
    riskLevel: 'R0',
    consentToken: issued.token
  });
  assert.equal(r0WithToken.decision, 'ALLOW');

  // 5. Invariante R3: nunca pode ser liberado mesmo com always_allow + globalAutoApprove
  engine.setToolPolicy('critical_wipe', 'always_allow');
  const r3Blocked = await engine.evaluate('critical_wipe', {}, ctx, { riskLevel: 'R3' });
  assert.equal(r3Blocked.decision, 'DENY');
  assert.equal(r3Blocked.code, 'DENY_CRITICAL_BLOCKED');
});

test('Bug 5 (Audit): localBridge falls back to Express when Tauri rejects ui-consent token with CONSENT_TOKEN_INVALID_OR_MISSING', async () => {
  const prevWindow = (globalThis as any).window;
  const prevFetch = globalThis.fetch;

  let fetchHeaders: Record<string, string> | undefined;
  try {
    (globalThis as any).window = {
      location: { protocol: 'tauri:', host: 'tauri.localhost' },
      __TAURI__: {
        core: {
          invoke: async () => ({
            toolName: 'pc_manage_apps',
            success: false,
            code: 'NATIVE_PERMISSION_BLOCKED',
            error: "CONSENT_TOKEN_INVALID_OR_MISSING: Ferramenta 'pc_manage_apps' (R2) exige token de consentimento assinado pelo backend.",
            simulated: false,
            riskLevel: 'R2',
            executionTimeMs: 1,
            timestamp: new Date().toISOString()
          })
        }
      }
    };

    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      fetchHeaders = init?.headers as Record<string, string>;
      return new Response(
        JSON.stringify({
          success: true,
          toolName: 'pc_manage_apps',
          decision: 'ALLOW',
          riskLevel: 'R2',
          simulated: false,
          data: { opened: true, message: 'Aplicativo iniciado via Express.' }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as any;

    const res = await executeLocalTool(
      'pc_manage_apps',
      { action: 'launch', appPath: 'notepad' },
      'sess-tauri-consent',
      'ui-consent-12345'
    );
    assert.equal(res.success, true);
    assert.equal(fetchHeaders?.['x-liora-ui-consent'], 'ui-consent-12345');
    assert.equal((res.data as { opened?: boolean } | undefined)?.opened, true);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = prevWindow;
  }
});

test('Bug 6 (Audit): pcActionLauncher enforces always_require_consent policy in Tauri Desktop instead of bypassing', async () => {
  commandDeduplicator.reset();
  const prevWindow = (globalThis as any).window;
  const prevFetch = globalThis.fetch;
  let tauriInvokeCalled = false;

  try {
    permissionEngine.setToolPolicy('open_application', 'always_require_consent');
    (globalThis as any).window = {
      __TAURI__: {
        core: {
          invoke: async () => {
            tauriInvokeCalled = true;
            return true;
          }
        }
      }
    };

    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          success: false,
          code: 'REQUIRES_USER_CONFIRMATION',
          error: "Ferramenta 'open_application' configurada para sempre exigir confirmação humana explícita."
        }),
        { status: 403, headers: { 'content-type': 'application/json' } }
      );
    }) as any;

    const res = await executePcAction({
      type: 'app_launch',
      appName: 'Bloco de Notas',
      executable: 'notepad',
      spokenFeedback: 'Abrindo bloco de notas',
      rawInput: 'abrir bloco de notas'
    });

    assert.equal(tauriInvokeCalled, false, 'Não deve invocar Tauri diretamente quando always_require_consent está ativo');
    assert.equal(res.success, false);
    assert.equal(res.requiresConsent, true);
    assert.equal(res.consentToolName, 'open_application');
  } finally {
    permissionEngine.setToolPolicy('open_application', 'default');
    commandDeduplicator.reset();
    globalThis.fetch = prevFetch;
    if (prevWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = prevWindow;
  }
});

test('Bug 7 (Audit): speechService.speak does not abort active Live WS when neural_tts acquisition is denied', async () => {
  const prevWindow = (globalThis as any).window;
  let liveAborted = false;
  let endCalled = false;
  let unregister: (() => void) | null = null;

  try {
    (globalThis as any).window = {
      speechSynthesis: { cancel: () => {} }
    };
    audioGate.resetForTests();
    unregister = audioGate.registerAbortHandler('live_ws', () => {
      liveAborted = true;
    });
    audioGate.setLiveSessionActive(true);

    await speechService.speak('Mensagem sem override', undefined, () => {
      endCalled = true;
    });

    assert.equal(liveAborted, false, 'Live WS ativo NÃO deve ser abortado quando speak() é barrado pelo AudioGate');
    assert.equal(endCalled, true);
  } finally {
    unregister?.();
    audioGate.resetForTests();
    if (prevWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = prevWindow;
  }
});

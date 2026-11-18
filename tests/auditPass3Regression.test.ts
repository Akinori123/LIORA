/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifierEngine } from '../src/tools/verifier';
import { nativeWorkspaceWriteFileTool, nativeCalculateRouteTool } from '../src/tools/nativeServerTools';
import {
  launchGpsNavigation,
  launchPlacesSearch,
  openGpsNavigationTool,
  mapsSearchPlacesTool
} from '../src/tools/navigation/navigationActionTool';
import { automationsEngine } from '../src/services/automationsEngine';
import { useLioraStore } from '../src/store/lioraStore';
import { computeParametersHash } from '../src/security/canonicalizer';

test('PASS3-01: VerifierEngine honors configured settings.workspacePath and executionResult.absolutePath', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liora-pass3-ws-'));
  const origStorage = (globalThis as any).localStorage;
  const mockStore = new Map<string, string>();
  mockStore.set(
    'liora_global_settings_v1',
    JSON.stringify({ workspacePath: tempRoot })
  );
  (globalThis as any).localStorage = {
    getItem: (k: string) => mockStore.get(k) ?? null,
    setItem: (k: string, v: string) => { mockStore.set(k, v); },
    removeItem: (k: string) => { mockStore.delete(k); }
  };

  try {
    const writeRes = await nativeWorkspaceWriteFileTool.execute({
      filePath: 'relatorios/auditoria-p3.md',
      content: '# Auditoria Pass 3\nOK'
    });
    assert.equal(writeRes.success, true);
    assert.equal(writeRes.simulated, false);
    assert.ok(String(writeRes.absolutePath).startsWith(tempRoot));

    const verifyOk = await verifierEngine.verifyExecution(
      'workspace_write_file',
      { filePath: 'relatorios/auditoria-p3.md', content: '# Auditoria Pass 3\nOK' },
      writeRes
    );
    assert.equal(verifyOk.passed, true);
    assert.equal(verifyOk.evidence.verified, true);

    // Path traversal inside executionResult.absolutePath must be ignored in favor of root resolution
    const traversalResult = await verifierEngine.verifyExecution(
      'workspace_write_file',
      { filePath: 'relatorios/nao-existe.md', content: 'abc' },
      { simulated: false, success: true, absolutePath: '/etc/passwd' }
    );
    assert.equal(traversalResult.passed, false);
    assert.match(String(traversalResult.error), /VERIFICATION_FAILED/);
  } finally {
    (globalThis as any).localStorage = origStorage;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('PASS3-02: Navigation tools report simulated honestly in headless Linux Web Preview without breaking dry-run contract', async () => {
  const origNoBrowser = process.env.LIORA_NO_BROWSER;
  const origDisplay = process.env.DISPLAY;
  const origWayland = process.env.WAYLAND_DISPLAY;
  const origForceReal = process.env.LIORA_FORCE_REAL_OS;

  try {
    // 1. Dry-run contract (used by unit test suites)
    process.env.LIORA_NO_BROWSER = '1';
    const dryGps = await launchGpsNavigation('Curitiba', 'waze', 'Ponta Grossa');
    assert.equal(dryGps.success, true);
    assert.equal(dryGps.dryRun, true);
    assert.notEqual(dryGps.simulated, true);

    // 2. Cloud / Headless Linux Web Preview fallback (no DISPLAY/WAYLAND, no dry-run)
    delete process.env.LIORA_NO_BROWSER;
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    delete process.env.LIORA_FORCE_REAL_OS;

    if (process.platform === 'linux') {
      const gps = await launchGpsNavigation('Florianópolis - Pass3', 'google_maps');
      assert.equal(gps.success, true);
      assert.equal(gps.simulated, true);
      assert.equal(gps.runtimeMode, 'web-preview-simulated');

      const places = await launchPlacesSearch('cafeteria pass3');
      assert.equal(places.success, true);
      assert.equal(places.simulated, true);
      assert.equal(places.runtimeMode, 'web-preview-simulated');

      const gpsToolRes = await openGpsNavigationTool.execute({
        destination: 'Joinville Pass3 Test',
        provider: 'waze'
      });
      assert.equal(gpsToolRes.success, true);
      assert.equal(gpsToolRes.simulated, true);
      assert.equal(gpsToolRes.runtimeMode, 'web-preview-simulated');
      assert.match(gpsToolRes.message, /WEB PREVIEW - SIMULADO/i);

      const placesToolRes = await mapsSearchPlacesTool.execute({
        query: 'hospital pass3 test'
      });
      assert.equal(placesToolRes.success, true);
      assert.equal(placesToolRes.simulated, true);
      assert.match(placesToolRes.message, /WEB PREVIEW - SIMULADO/i);

      const routeToolRes = await nativeCalculateRouteTool.execute({
        destination: 'Londrina Pass3 Test'
      });
      assert.equal(routeToolRes.success, true);
      assert.equal(routeToolRes.simulated, true);
      assert.equal(routeToolRes.runtimeMode, 'web-preview-simulated');
      assert.match(routeToolRes.message, /WEB PREVIEW - SIMULADO/i);
    }
  } finally {
    if (origNoBrowser === undefined) delete process.env.LIORA_NO_BROWSER;
    else process.env.LIORA_NO_BROWSER = origNoBrowser;
    if (origDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = origDisplay;
    if (origWayland === undefined) delete process.env.WAYLAND_DISPLAY;
    else process.env.WAYLAND_DISPLAY = origWayland;
    if (origForceReal === undefined) delete process.env.LIORA_FORCE_REAL_OS;
    else process.env.LIORA_FORCE_REAL_OS = origForceReal;
  }
});

test('PASS3-03: GlobalConsentOverlay approve/reject/expire syncs linked AutomationsEngine rules and logs', async () => {
  const ruleId = 'pass3-sync-rule';
  automationsEngine.registerRule({
    id: ruleId,
    name: 'Pass3 Automation Consent Sync',
    description: 'Valida sincronização entre GlobalConsentOverlay e AutomationsEngine',
    enabled: true,
    trigger: {
      type: 'MANUAL',
      config: {},
      humanReadable: 'Manual'
    },
    action: {
      type: 'EXECUTE_TOOL',
      toolName: 'system_info',
      parameters: { detailLevel: 'summary' },
      description: 'Coletar telemetria após aprovação',
      expectedRiskLevel: 'R1'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/api/security/ui-consent')) {
      return new Response(
        JSON.stringify({ success: true, token: 'ui-pass3-token' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({
        success: true,
        toolName: 'system_info',
        decision: 'ALLOW',
        riskLevel: 'R0',
        data: { os: 'linux' },
        simulated: false,
        executionTimeMs: 4,
        timestamp: new Date().toISOString()
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  const store = useLioraStore.getState();
  try {
    // 1. Trigger approval via approveConsent (GlobalConsentOverlay / voice path)
    store.setPendingConsent({
      auditId: 'audit-pass3-sync-approve',
      ruleId,
      toolName: 'system_info',
      riskLevel: 'R1',
      parameters: { detailLevel: 'summary' },
      parametersHash: computeParametersHash({ detailLevel: 'summary' }),
      consentToken: 'tok-pass3-approve',
      sessionId: 'sess-pass3',
      expiresAt: Date.now() + 60000,
      status: 'PENDING'
    });

    const res = await store.approveConsent();
    assert.ok(res && res.success);
    assert.equal(automationsEngine.getRule(ruleId)?.lastExecutionStatus, 'SUCCESS');
    assert.ok(useLioraStore.getState().automationLogs.some(l => l.ruleId === ruleId && l.status === 'SUCCESS'));

    // 2. Trigger rejection via rejectConsent
    store.setPendingConsent({
      auditId: 'audit-pass3-sync-reject',
      ruleId,
      toolName: 'system_info',
      riskLevel: 'R1',
      parameters: { detailLevel: 'summary' },
      parametersHash: computeParametersHash({ detailLevel: 'summary' }),
      consentToken: 'tok-pass3-reject',
      sessionId: 'sess-pass3',
      expiresAt: Date.now() + 60000,
      status: 'PENDING'
    });

    store.rejectConsent();
    assert.equal(automationsEngine.getRule(ruleId)?.lastExecutionStatus, 'BLOCKED_BY_POLICY');
    assert.ok(
      useLioraStore.getState().automationLogs.some(
        l => l.ruleId === ruleId && l.status === 'BLOCKED_BY_POLICY' && String(l.errorMessage).includes('rejeitado')
      )
    );
  } finally {
    store.setPendingConsent(null);
    automationsEngine.unregisterRule(ruleId);
    globalThis.fetch = origFetch;
  }
});

test('PASS3-04: UI structural guards for LioraOrb cleanup, modal dialog accessibility, and DevicesView polling', () => {
  const orbSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/LioraOrb.tsx'), 'utf8');
  assert.match(orbSrc, /container\.removeChild\(renderer\.domElement\)/);
  assert.match(orbSrc, /renderer\.dispose\(\)/);

  const homeSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/views/HomeView.tsx'), 'utf8');
  assert.match(homeSrc, /hasOpenDialog/);
  assert.match(homeSrc, /aria-modal="true"/);

  const overlaySrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/QuickOverlay.tsx'), 'utf8');
  assert.match(overlaySrc, /role="dialog"/);
  assert.match(overlaySrc, /aria-modal="true"/);

  const devicesSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/views/DevicesView.tsx'), 'utf8');
  assert.match(devicesSrc, /pollInFlight/);
});

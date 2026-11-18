/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { useLioraStore } from '../src/store/lioraStore';
import { 
  selectActiveSession, 
  selectActiveMessages, 
  selectConnectedDevicesCount, 
  selectActiveAutomations, 
  selectSystemTelemetrySummary 
} from '../src/store/lioraSelectors';
import { parsePcCommandIntent } from '../src/utils/pcCommandParser';

test('SEL-01: selectActiveSession returns correct active session or null', () => {
  const store = useLioraStore.getState();
  const sessionId = store.createSession('Sessão Seletor');
  store.openSession(sessionId);

  const state = useLioraStore.getState();
  const session = selectActiveSession(state);
  assert.ok(session);
  assert.equal(session.title, 'Sessão Seletor');
  assert.equal(session.id, sessionId);

  // Null when no active session
  useLioraStore.setState({ activeSessionId: null });
  assert.equal(selectActiveSession(useLioraStore.getState()), null);
});

test('SEL-02: selectActiveMessages and derived telemetry selectors return accurate immutable data', () => {
  useLioraStore.setState({
    messages: [
      { id: 'm-1', sender: 'user', text: 'Olá', timestamp: '10:00' }
    ],
    devices: [
      { id: 'd-1', name: 'PC', type: 'pc', connected: true, lastSeen: 'agora', status: 'ONLINE', capabilities: [], isSimulated: false },
      { id: 'd-2', name: 'TV', type: 'tv', connected: false, lastSeen: 'ontem', status: 'OFFLINE', capabilities: [], isSimulated: false }
    ],
    automations: [
      { id: 'a-1', name: 'Auto 1', description: 'desc', enabled: true, trigger: {} as any, action: {} as any, createdAt: '', updatedAt: '' },
      { id: 'a-2', name: 'Auto 2', description: 'desc', enabled: false, trigger: {} as any, action: {} as any, createdAt: '', updatedAt: '' }
    ],
    shieldModeActive: true,
    isGenerating: false,
    orbState: 'IDLE'
  });

  const state = useLioraStore.getState();
  const msgs = selectActiveMessages(state);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, 'Olá');

  assert.equal(selectConnectedDevicesCount(state), 1);
  assert.equal(selectActiveAutomations(state).length, 1);
  assert.equal(selectActiveAutomations(state)[0].id, 'a-1');

  const summary = selectSystemTelemetrySummary(state);
  assert.equal(summary.devicesOnline, 1);
  assert.equal(summary.activeAutomationsCount, 1);
  assert.equal(summary.shieldModeActive, true);
});

test('SEL-03: Reference-equality memoization (===) holds across unrelated store updates', () => {
  const store = useLioraStore.getState();
  const sessionId = store.createSession('Memo Session');
  store.openSession(sessionId);

  useLioraStore.setState({
    messages: [{ id: 'm-memo', sender: 'user', text: 'Teste memo', timestamp: '11:00' }],
    devices: [
      { id: 'dev-1', name: 'PC', type: 'pc', connected: true, lastSeen: 'agora', status: 'ONLINE', capabilities: [], isSimulated: false }
    ],
    automations: [
      { id: 'a-memo', name: 'Auto Memo', description: 'desc', enabled: true, trigger: {} as any, action: {} as any, createdAt: '', updatedAt: '' }
    ],
    shieldModeActive: false,
    isGenerating: false,
    orbState: 'IDLE'
  });

  const state1 = useLioraStore.getState();
  const s1 = selectActiveSession(state1);
  const m1 = selectActiveMessages(state1);
  const c1 = selectConnectedDevicesCount(state1);
  const a1 = selectActiveAutomations(state1);
  const t1 = selectSystemTelemetrySummary(state1);

  // Unrelated slice update (activeTab / activityLogs change)
  useLioraStore.setState({
    activeTab: 'settings',
    activityLogs: [...state1.activityLogs]
  });

  const state2 = useLioraStore.getState();
  assert.equal(selectActiveSession(state2), s1);
  assert.equal(selectActiveMessages(state2), m1);
  assert.equal(selectConnectedDevicesCount(state2), c1);
  assert.equal(selectActiveAutomations(state2), a1);
  assert.equal(selectSystemTelemetrySummary(state2), t1);
});

test('SEL-04: pcCommandParser routes compound and close commands to full AI tool-chaining instead of intercepting blindly', () => {
  assert.equal(parsePcCommandIntent('abra o bloco de notas e escreva um relatório'), null);
  assert.equal(parsePcCommandIntent('abra outra aba e pesquise clima'), null);
  assert.equal(parsePcCommandIntent('feche o bloco de notas'), null);
  assert.equal(parsePcCommandIntent('encerrar chrome'), null);

  const simpleOpen = parsePcCommandIntent('abra o bloco de notas');
  if (!simpleOpen) {
    assert.fail('simpleOpen deveria ter sido reconhecido');
  }
  assert.equal(simpleOpen.type, 'app_launch');
  if (simpleOpen.type === 'app_launch') {
    assert.equal(simpleOpen.executable, 'notepad');
  }
});

test('SEL-05: updateDeviceStatus updates Zustand store state cleanly', () => {
  useLioraStore.setState({
    devices: [
      { id: 'dev-sync', name: 'Sync Device', type: 'android', connected: false, lastSeen: 'ontem', status: 'OFFLINE', capabilities: [], isSimulated: false }
    ]
  });
  useLioraStore.getState().updateDeviceStatus('dev-sync', true);
  const updated = useLioraStore.getState().devices.find(d => d.id === 'dev-sync');
  assert.ok(updated);
  assert.equal(updated.connected, true);
  assert.equal(updated.status, 'ONLINE');
});

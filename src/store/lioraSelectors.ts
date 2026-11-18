/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Seletores Imutáveis e Memoizados para o lioraStore
 * Reduz re-renders desnecessários em componentes React ao extrair estados derivados.
 */

import { LioraState } from './lioraStore';
import { ChatMessage, ConversationSession } from '../types';
import { AutomationRule } from '../types/automations';

function createSelectorMemo<TArgs extends readonly unknown[], TResult>(
  compute: (...args: TArgs) => TResult
): (...args: TArgs) => TResult {
  let hasLast = false;
  let lastArgs: TArgs | null = null;
  let lastResult: TResult;

  return (...args: TArgs): TResult => {
    if (
      hasLast &&
      lastArgs !== null &&
      args.length === lastArgs.length &&
      args.every((arg, i) => Object.is(arg, lastArgs![i]))
    ) {
      return lastResult;
    }
    hasLast = true;
    lastArgs = args;
    lastResult = compute(...args);
    return lastResult;
  };
}

const memoActiveSession = createSelectorMemo(
  (sessions: ConversationSession[], activeSessionId: string | null): ConversationSession | null => {
    if (!activeSessionId) return null;
    return sessions.find(s => s.id === activeSessionId) || null;
  }
);

const EMPTY_MESSAGES: ChatMessage[] = [];

const memoConnectedDevicesCount = createSelectorMemo(
  (devices: LioraState['devices']): number => {
    if (!devices || devices.length === 0) return 0;
    let count = 0;
    for (let i = 0; i < devices.length; i++) {
      if (devices[i].connected) count++;
    }
    return count;
  }
);

const memoActiveAutomations = createSelectorMemo(
  (automations: AutomationRule[]): AutomationRule[] => {
    if (!automations || automations.length === 0) return [];
    return automations.filter(a => a.enabled);
  }
);

export interface SystemTelemetrySummary {
  isGenerating: boolean;
  orbState: LioraState['orbState'];
  shieldModeActive: boolean;
  devicesOnline: number;
  activeAutomationsCount: number;
  logsCount: number;
}

const memoSystemTelemetrySummary = createSelectorMemo(
  (
    isGenerating: boolean,
    orbState: LioraState['orbState'],
    shieldModeActive: boolean,
    devicesOnline: number,
    activeAutomationsCount: number,
    logsCount: number
  ): SystemTelemetrySummary => ({
    isGenerating,
    orbState,
    shieldModeActive,
    devicesOnline,
    activeAutomationsCount,
    logsCount
  })
);

/**
 * Retorna a sessão ativa atual de forma imutável e memoizada.
 */
export const selectActiveSession = (state: LioraState) =>
  memoActiveSession(state.sessions, state.activeSessionId);

/**
 * Retorna as mensagens da sessão ativa com referência estável.
 */
export const selectActiveMessages = (state: LioraState): ChatMessage[] => {
  return state.messages || EMPTY_MESSAGES;
};

/**
 * Retorna o número de dispositivos conectados de forma memoizada.
 */
export const selectConnectedDevicesCount = (state: LioraState): number =>
  memoConnectedDevicesCount(state.devices);

/**
 * Retorna apenas as automações ativas com referência de array estável.
 */
export const selectActiveAutomations = (state: LioraState): AutomationRule[] =>
  memoActiveAutomations(state.automations);

/**
 * Retorna estatísticas resumidas com referência de objeto estável enquanto os valores não mudarem.
 */
export const selectSystemTelemetrySummary = (state: LioraState): SystemTelemetrySummary => {
  const devicesOnline = memoConnectedDevicesCount(state.devices);
  const activeAutomationsCount = memoActiveAutomations(state.automations).length;
  const logsCount = state.activityLogs ? state.activityLogs.length : 0;

  return memoSystemTelemetrySummary(
    state.isGenerating,
    state.orbState,
    state.shieldModeActive,
    devicesOnline,
    activeAutomationsCount,
    logsCount
  );
};


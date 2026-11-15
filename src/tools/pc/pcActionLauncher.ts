/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * LIORA — Executor Determinístico de Ações do PC
 * Dispara comandos reais no computador (lançamento de apps, volume, bloqueio)
 * com verificação real de sucesso e auditoria forense.
 */

import { PcCommandMatch } from '../../utils/pcCommandParser';
import { isTauriEnvironment, invokeTauri } from '../../security/localBridge';

export interface PcExecutionResult {
  success: boolean;
  message: string;
  error?: string;
  simulated?: boolean;
  runtimeMode?: string;
  requiresConsent?: boolean;
  consentToolName?: string;
  consentParams?: Record<string, any>;
}

const BROWSER_EXECUTABLES = new Set(['chrome', 'msedge', 'opera', 'firefox']);

export async function executePcAction(match: PcCommandMatch): Promise<PcExecutionResult> {
  try {
    if (match.type === 'app_launch') {
      // 1. Tenta via Tauri nativo se estiver rodando em container desktop
      if (isTauriEnvironment()) {
        try {
          await invokeTauri<boolean>('open_application', { target: match.executable });
          return {
            success: true,
            simulated: false,
            runtimeMode: 'tauri-desktop',
            message: `Aplicativo '${match.appName}' iniciado com sucesso no computador.`
          };
        } catch {
          // Continua para o backend local Express se o comando nativo falhar
        }
      }

      // Navegadores usam diretamente open_browser para suportar argumentos de browser e Web Preview cleanly
      const primaryTool = BROWSER_EXECUTABLES.has(match.executable) ? 'open_browser' : 'open_application';
      const primaryParams = primaryTool === 'open_browser'
        ? { browser: match.executable }
        : { appName: match.executable };

      const res = await fetch('/api/tools/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-liora-session-id': 'operator-voice-session',
          'x-liora-ui-consent': 'operator-direct-voice'
        },
        body: JSON.stringify({
          toolName: primaryTool,
          parameters: primaryParams
        })
      });

      const data = await res.json().catch(() => ({}));
      const isActualSuccess = res.ok && Boolean(data.success) && data.data?.success !== false;

      if (isActualSuccess) {
        const isSimulated = Boolean(data.simulated || data.data?.simulated);
        return {
          success: true,
          simulated: isSimulated,
          runtimeMode: data.data?.runtimeMode,
          message: data.data?.message || `Aplicativo '${match.appName}' iniciado com sucesso no computador.`
        };
      }

      if (res.status === 403 && (data.code === 'REQUIRES_USER_CONFIRMATION' || data.code === 'DENY_R1_BLOCKED_IN_PHASE_6_2B')) {
        return {
          success: false,
          requiresConsent: true,
          consentToolName: primaryTool,
          consentParams: primaryParams,
          message: data.error || `Abertura de '${match.appName}' requer sua autorização explícita.`,
          error: data.error || 'Ação bloqueada aguardando consentimento.'
        };
      }

      // Fallback: tenta via pc_manage_apps diretamente
      const fallbackRes = await fetch('/api/tools/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-liora-session-id': 'operator-voice-session',
          'x-liora-ui-consent': 'operator-direct-voice'
        },
        body: JSON.stringify({
          toolName: 'pc_manage_apps',
          parameters: {
            action: 'launch',
            appPath: match.executable
          }
        })
      });

      const fallbackData = await fallbackRes.json().catch(() => ({}));
      const isFallbackSuccess = fallbackRes.ok && Boolean(fallbackData.success) && fallbackData.data?.success !== false;
      const isFallbackSimulated = Boolean(fallbackData.simulated || fallbackData.data?.simulated);

      if (fallbackRes.status === 403 && (fallbackData.code === 'REQUIRES_USER_CONFIRMATION' || fallbackData.code === 'DENY_R1_BLOCKED_IN_PHASE_6_2B')) {
        return {
          success: false,
          requiresConsent: true,
          consentToolName: 'pc_manage_apps',
          consentParams: { action: 'launch', appPath: match.executable },
          message: fallbackData.error || `Abertura de '${match.appName}' requer autorização explícita.`,
          error: fallbackData.error || 'Ação bloqueada aguardando consentimento.'
        };
      }

      const errorDetail = fallbackData.data?.message || fallbackData.error || data.data?.message || data.error || 'verifique se o aplicativo está instalado no computador';

      return {
        success: isFallbackSuccess,
        simulated: isFallbackSimulated,
        runtimeMode: fallbackData.data?.runtimeMode,
        message: isFallbackSuccess
          ? (fallbackData.data?.message || `Aplicativo '${match.appName}' iniciado com sucesso.`)
          : `Não foi possível iniciar '${match.appName}': ${errorDetail}.`,
        error: isFallbackSuccess ? undefined : errorDetail
      };
    }

    if (match.type === 'system_lock') {
      const res = await fetch('/api/tools/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-liora-session-id': 'operator-voice-session',
          'x-liora-ui-consent': 'operator-direct-voice'
        },
        body: JSON.stringify({
          toolName: 'system_lock_session',
          parameters: {}
        })
      });
      const data = await res.json().catch(() => ({}));
      const isActualSuccess = res.ok && Boolean(data.success) && data.data?.success !== false;
      const isSimulated = Boolean(data.simulated || data.data?.simulated);
      const errDetail = data.data?.error || data.error || data.data?.message;
      return {
        success: isActualSuccess,
        simulated: isSimulated,
        runtimeMode: data.data?.runtimeMode,
        message: isActualSuccess ? (data.data?.message || 'Sessão do computador bloqueada.') : (errDetail || 'Falha ao bloquear sessão.'),
        error: isActualSuccess ? undefined : (errDetail || 'Falha ao bloquear sessão.')
      };
    }

    if (match.type === 'volume_up' || match.type === 'volume_down' || match.type === 'volume_mute') {
      const targetLevel = match.type === 'volume_mute' ? 0 : match.type === 'volume_up' ? 80 : 30;
      const res = await fetch('/api/tools/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-liora-session-id': 'operator-voice-session',
          'x-liora-ui-consent': 'operator-direct-voice'
        },
        body: JSON.stringify({
          toolName: 'system_set_volume',
          parameters: { level: targetLevel }
        })
      });
      const data = await res.json().catch(() => ({}));
      const isActualSuccess = res.ok && Boolean(data.success) && data.data?.success !== false;
      const isSimulated = Boolean(data.simulated || data.data?.simulated);
      const errDetail = data.data?.error || data.error || data.data?.message;
      return {
        success: isActualSuccess,
        simulated: isSimulated,
        runtimeMode: data.data?.runtimeMode,
        message: isActualSuccess ? (data.data?.message || `Volume ajustado para ${targetLevel}%.`) : (errDetail || 'Falha ao ajustar volume.'),
        error: isActualSuccess ? undefined : (errDetail || 'Falha ao ajustar volume.')
      };
    }

    return { success: false, message: 'Comando não reconhecido.' };
  } catch (err: any) {
    return {
      success: false,
      message: `Erro ao executar ação no sistema: ${err?.message || 'falha de comunicação com o servidor local'}.`,
      error: err?.message
    };
  }
}

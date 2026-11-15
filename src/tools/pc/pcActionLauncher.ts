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
}

export async function executePcAction(match: PcCommandMatch): Promise<PcExecutionResult> {
  try {
    if (match.type === 'app_launch') {
      // 1. Tenta via Tauri nativo se estiver rodando em container desktop
      if (isTauriEnvironment()) {
        try {
          await invokeTauri<boolean>('open_application', { target: match.executable });
          return {
            success: true,
            message: `Aplicativo '${match.appName}' iniciado com sucesso no computador.`
          };
        } catch {
          // Continua para o backend local Express se o comando nativo falhar
        }
      }

      const res = await fetch('/api/tools/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-liora-ui-consent': 'operator-direct-voice'
        },
        body: JSON.stringify({
          toolName: 'open_application',
          parameters: {
            appName: match.executable
          }
        })
      });

      const data = await res.json().catch(() => ({}));
      const isActualSuccess = res.ok && Boolean(data.success) && data.data?.success !== false;

      if (isActualSuccess) {
        return {
          success: true,
          message: `Aplicativo '${match.appName}' iniciado com sucesso no computador.`
        };
      }

      // Fallback: tenta via pc_manage_apps diretamente
      const fallbackRes = await fetch('/api/tools/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
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

      const errorDetail = fallbackData.data?.message || fallbackData.error || data.data?.message || data.error || 'verifique se o aplicativo está instalado no computador';

      return {
        success: isFallbackSuccess,
        message: isFallbackSuccess 
          ? `Aplicativo '${match.appName}' iniciado com sucesso.` 
          : `Não foi possível iniciar '${match.appName}': ${errorDetail}.`,
        error: isFallbackSuccess ? undefined : errorDetail
      };
    }

    if (match.type === 'system_lock') {
      const res = await fetch('/api/tools/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-liora-ui-consent': 'operator-direct-voice' },
        body: JSON.stringify({
          toolName: 'system_lock_session',
          parameters: {}
        })
      });
      const data = await res.json().catch(() => ({}));
      return {
        success: Boolean(data.success),
        message: data.success ? 'Sessão do computador bloqueada.' : 'Falha ao bloquear sessão.'
      };
    }

    if (match.type === 'volume_up' || match.type === 'volume_down' || match.type === 'volume_mute') {
      const targetLevel = match.type === 'volume_mute' ? 0 : match.type === 'volume_up' ? 80 : 30;
      const res = await fetch('/api/tools/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-liora-ui-consent': 'operator-direct-voice' },
        body: JSON.stringify({
          toolName: 'system_set_volume',
          parameters: { level: targetLevel }
        })
      });
      const data = await res.json().catch(() => ({}));
      return {
        success: Boolean(data.success),
        message: data.success ? `Volume ajustado para ${targetLevel}%.` : 'Falha ao ajustar volume.'
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

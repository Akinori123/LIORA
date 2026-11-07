/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — UI DE GERENCIAMENTO DO COFRE CRIPTOGRAFADO (Etapa 6 do diagnóstico)
 *
 * Problema corrigido: o cofre AES-256-GCM era operável apenas por comandos de
 * chat — sem interface visual, o usuário não conseguia VER o que guardou nem
 * APAGAR sem frases frustrantes. Este painel oferece:
 *  - Listagem visual dos identificadores (NUNCA os valores — blindagem mantida)
 *  - Exclusão com confirmação explícita (2 cliques)
 *  - Adição de novas credenciais direto pela UI
 *  - Indicador de integridade do cofre
 */

import React, { useState, useEffect, useCallback } from 'react';
import { KeyRound, Plus, Trash2, ShieldCheck, ShieldAlert, Eye, EyeOff, RefreshCw, X } from 'lucide-react';

interface VaultKeyEntry {
  key: string;
  description?: string;
  updatedAt: string;
}

/**
 * Painel de gerenciamento do cofre. Comunica-se com o backend via
 * executeTool (vault_list_keys / vault_delete_credential / vault_store_credential),
 * respeitando o fluxo de consentimento R2 do PermissionEngine.
 */
export const VaultManagerPanel: React.FC<{ onClose?: () => void }> = ({ onClose }) => {
  const [keys, setKeys] = useState<VaultKeyEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyValue, setNewKeyValue] = useState('');
  const [showValue, setShowValue] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/tools/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolName: 'vault_list_keys', parameters: {} })
      });
      const data = await res.json();
      if (data.success) {
        setKeys(data.keys || []);
      } else {
        setError(data.error || 'Falha ao listar o cofre.');
      }
    } catch (err: any) {
      setError(err?.message || 'Falha de rede ao acessar o cofre.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * CORREÇÃO (Etapa 6 — consentimento de UI para R2): o clique explícito do botão
   * É o consentimento do operador. Solicita o token HMAC via endpoint de issue e
   * envia no header x-liora-ui-consent (consumido anti-replay pelo PermissionEngine).
   */
  const getUiConsentToken = useCallback(async (toolName: string, parameters: Record<string, any>): Promise<string | null> => {
    try {
      const res = await fetch('/api/security/ui-consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolName, parameters })
      });
      const data = await res.json();
      return data.success ? data.token : null;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => { void loadKeys(); }, [loadKeys]);

  const handleStore = async () => {
    if (!newKeyName.trim() || !newKeyValue.trim()) {
      setFeedback('Informe o identificador e o valor do segredo.');
      return;
    }
    try {
      const parameters = { key: newKeyName.trim(), value: newKeyValue, description: 'Adicionado pela UI do cofre' };
      const token = await getUiConsentToken('vault_store_credential', parameters);
      if (!token) {
        setFeedback('Falha ao emitir consentimento de segurança. Tente novamente.');
        return;
      }
      const res = await fetch('/api/tools/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-liora-ui-consent': token },
        body: JSON.stringify({ toolName: 'vault_store_credential', parameters })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback(`Credencial '${newKeyName.trim()}' armazenada com sucesso.`);
        setNewKeyName('');
        setNewKeyValue('');
        setShowValue(false);
        await loadKeys();
      } else {
        setFeedback(data.error || 'Falha ao armazenar.');
      }
    } catch (err: any) {
      setFeedback(err?.message || 'Falha de rede.');
    }
  };

  const handleDelete = async (key: string) => {
    try {
      const token = await getUiConsentToken('vault_delete_credential', { key });
      if (!token) {
        setFeedback('Falha ao emitir consentimento de segurança.');
        return;
      }
      const res = await fetch('/api/tools/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-liora-ui-consent': token },
        body: JSON.stringify({ toolName: 'vault_delete_credential', parameters: { key } })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback(`Credencial '${key}' removida do cofre.`);
        setConfirmDelete(null);
        await loadKeys();
      } else {
        setFeedback(data.error || 'Falha ao remover.');
      }
    } catch (err: any) {
      setFeedback(err?.message || 'Falha de rede.');
    }
  };

  return (
    <div className="bg-[#0E0E0E] border border-[#262626] rounded-2xl p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-[var(--accent-bg)] border border-[var(--accent-border)]/30">
            <KeyRound className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
          </div>
          <div>
            <h4 className="text-sm font-bold text-white">Cofre Criptografado Local</h4>
            <p className="text-[10px] text-[#888888]">AES-256-GCM · credenciais em ~/.liora/security</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => void loadKeys()}
            className="p-1.5 rounded-lg text-[#888888] hover:text-white hover:bg-[#1E1E1E] transition-colors"
            title="Recarregar"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-[#888888] hover:text-white hover:bg-[#1E1E1E] transition-colors"
              title="Fechar"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Indicador de integridade */}
      <div className={`flex items-center gap-2 text-[11px] font-mono px-3 py-2 rounded-lg border ${error
          ? 'bg-red-950/30 border-red-800/50 text-red-300'
          : 'bg-emerald-950/30 border-emerald-800/50 text-emerald-300'
        }`}>
        {error ? <ShieldAlert className="w-3.5 h-3.5" /> : <ShieldCheck className="w-3.5 h-3.5" />}
        <span>{error || 'Cofre íntegro — os valores nunca são exibidos por segurança.'}</span>
      </div>

      {/* Feedback de ação */}
      {feedback && (
        <div className="text-[11px] font-mono text-amber-300 bg-amber-950/30 border border-amber-800/50 px-3 py-2 rounded-lg">
          {feedback}
        </div>
      )}

      {/* Lista de credenciais */}
      <div className="space-y-2 max-h-64 overflow-y-auto">
        {isLoading && keys.length === 0 ? (
          <p className="text-xs text-[#666666] text-center py-4">Carregando credenciais...</p>
        ) : keys.length === 0 ? (
          <p className="text-xs text-[#666666] text-center py-4">
            Nenhuma credencial armazenada ainda. Adicione abaixo ou peça à LIORA por voz.
          </p>
        ) : (
          keys.map((entry) => (
            <div key={entry.key} className="flex items-center justify-between gap-2 bg-[#141414] border border-[#232323] rounded-lg px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-mono font-semibold text-white truncate">{entry.key}</div>
                {entry.description && (
                  <div className="text-[10px] text-[#777777] truncate">{entry.description}</div>
                )}
                <div className="text-[10px] text-[#555555] font-mono">
                  atualizada: {new Date(entry.updatedAt).toLocaleDateString('pt-BR')}
                </div>
              </div>
              {confirmDelete === entry.key ? (
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => void handleDelete(entry.key)}
                    className="px-2 py-1 rounded text-[10px] font-bold bg-red-600 hover:bg-red-500 text-white"
                  >
                    Confirmar
                  </button>
                  <button
                    onClick={() => setConfirmDelete(null)}
                    className="px-2 py-1 rounded text-[10px] text-[#888888] hover:text-white"
                  >
                    Não
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDelete(entry.key)}
                  className="p-1.5 rounded text-[#666666] hover:text-red-400 hover:bg-red-950/30 transition-colors shrink-0"
                  title="Remover do cofre"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          ))
        )}
      </div>

      {/* Adicionar nova credencial */}
      <div className="pt-3 border-t border-[#222222] space-y-2">
        <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-[#888888]">
          <Plus className="w-3 h-3" />
          <span>Nova credencial</span>
        </div>
        <input
          type="text"
          value={newKeyName}
          onChange={(e) => setNewKeyName(e.target.value)}
          placeholder="Identificador (ex: smtp.main)"
          className="w-full bg-[#161616] border border-[#2B2B2B] rounded-lg px-3 py-1.5 text-xs text-white placeholder-[#555555] focus:outline-none focus:border-[var(--accent-primary)]"
        />
        <div className="relative">
          <input
            type={showValue ? 'text' : 'password'}
            value={newKeyValue}
            onChange={(e) => setNewKeyValue(e.target.value)}
            placeholder="Valor do segredo"
            className="w-full bg-[#161616] border border-[#2B2B2B] rounded-lg px-3 py-1.5 pr-9 text-xs text-white placeholder-[#555555] focus:outline-none focus:border-[var(--accent-primary)]"
          />
          <button
            onClick={() => setShowValue(!showValue)}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[#666666] hover:text-white"
            title={showValue ? 'Ocultar' : 'Mostrar'}
          >
            {showValue ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>
        <button
          onClick={() => void handleStore()}
          disabled={!newKeyName.trim() || !newKeyValue.trim()}
          className="w-full py-1.5 rounded-lg text-xs font-bold text-white transition-all disabled:opacity-40"
          style={{ backgroundColor: 'var(--accent-primary)' }}
        >
          Armazenar no Cofre
        </button>
      </div>
    </div>
  );
};

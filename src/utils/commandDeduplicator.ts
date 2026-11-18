/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — Deduplicador Determinístico / Lock de Idempotência para Comandos de Voz e Ferramentas
 * Impede disparos em rajada (ex: abrir 2 ou 3 Blocos de Notas) quando múltiplos canais
 * (Web Speech interim/final, Gemini Live transcription, VAD e function calls) interpretam
 * o mesmo comando dentro de uma janela de debounce configurável (padrão: 3000ms).
 */

export const DEFAULT_COMMAND_DEDUPE_WINDOW_MS = 3000;

const APP_ALIAS_CANONICAL_MAP: Record<string, string> = {
  'bloco de notas': 'notepad',
  'bloco de nota': 'notepad',
  'bloco notas': 'notepad',
  'notepad': 'notepad',
  'notepad.exe': 'notepad',
  'editor de texto': 'notepad',
  'calculadora': 'calc',
  'calculador': 'calc',
  'calc': 'calc',
  'calc.exe': 'calc',
  'calculator': 'calc',
  'painel de controle': 'control',
  'control panel': 'control',
  'control': 'control',
  'configuracoes': 'ms-settings:',
  'configuracoes do windows': 'ms-settings:',
  'ms-settings:': 'ms-settings:',
  'gerenciador de tarefas': 'taskmgr',
  'taskmgr': 'taskmgr',
  'explorador de arquivos': 'explorer',
  'explorer': 'explorer',
  'google chrome': 'chrome',
  'chrome': 'chrome',
  'chrome.exe': 'chrome',
  'navegador': 'chrome',
  'edge': 'msedge',
  'microsoft edge': 'msedge',
  'msedge': 'msedge',
  'opera': 'opera',
  'firefox': 'firefox',
  'spotify': 'spotify',
  'visual studio code': 'code',
  'vs code': 'code',
  'vscode': 'code',
  'code': 'code',
  'powershell': 'powershell',
  'terminal': 'powershell',
  'cmd': 'powershell',
  'paint': 'mspaint',
  'mspaint': 'mspaint',
  'discord': 'discord',
  'whatsapp': 'whatsapp',
  'steam': 'steam',
  'word': 'winword',
  'winword': 'winword',
  'excel': 'excel',
  'powerpoint': 'powerpnt',
  'powerpnt': 'powerpnt',
  'telegram': 'telegram',
  'vlc': 'vlc',
  'obs': 'obs64',
  'obs64': 'obs64'
};

export function normalizeDedupeText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalizeAppTarget(raw: unknown): string {
  const norm = normalizeDedupeText(raw);
  if (!norm) return '';
  if (APP_ALIAS_CANONICAL_MAP[norm]) return APP_ALIAS_CANONICAL_MAP[norm];
  const stripped = norm.replace(/\.exe$/i, '');
  return APP_ALIAS_CANONICAL_MAP[stripped] || stripped;
}

function stableNormalizeValue(val: unknown): unknown {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return normalizeDedupeText(val);
  if (typeof val === 'number' || typeof val === 'boolean') return val;
  if (Array.isArray(val)) return val.map(stableNormalizeValue);
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = stableNormalizeValue(obj[k]);
    }
    return sorted;
  }
  return String(val);
}

/**
 * Gera uma chave canônica de deduplicação baseada em intenção/ferramenta + parâmetros.
 * Garante que `open_application({ appName: 'Bloco de Notas' })` e
 * `pc_manage_apps({ action: 'launch', appPath: 'notepad' })` colidam na mesma chave!
 */
export function buildCommandDedupeKey(toolName: string, params: Record<string, any> = {}): string {
  const cleanTool = normalizeDedupeText(toolName);

  if (cleanTool === 'open_application') {
    const rawTarget = params?.appName || params?.appPath || params?.application || params?.target || '';
    return `pc_launch:${canonicalizeAppTarget(rawTarget)}`;
  }

  if (cleanTool === 'pc_manage_apps' && normalizeDedupeText(params?.action) === 'launch') {
    const rawTarget = params?.appPath || params?.appName || params?.target || params?.processName || '';
    return `pc_launch:${canonicalizeAppTarget(rawTarget)}`;
  }

  if (cleanTool === 'open_browser') {
    const browser = canonicalizeAppTarget(params?.browser || 'default');
    const url = normalizeDedupeText(params?.url || 'https://www.google.com');
    return `open_browser:${browser}:${url}`;
  }

  return `${cleanTool}:${JSON.stringify(stableNormalizeValue(params || {}))}`;
}

export function isSideEffectfulDedupeTool(toolName: string, params: Record<string, any> = {}): boolean {
  if (
    toolName === 'open_application' ||
    toolName === 'open_browser' ||
    toolName === 'pc_simulate_input' ||
    toolName === 'system_lock_session' ||
    toolName === 'system_set_volume' ||
    toolName === 'open_gps_navigation' ||
    toolName === 'maps_search_places'
  ) {
    return true;
  }
  if (toolName === 'pc_manage_apps') {
    const action = normalizeDedupeText(params?.action);
    return action === 'launch' || action === 'kill' || action === 'focus';
  }
  return false;
}

interface DedupeEntry {
  timestamp: number;
  result?: any;
}

export interface DedupeCheckResult {
  isDuplicate: boolean;
  remainingMs: number;
  key: string;
  cachedResult?: any;
}

export class CommandDeduplicator {
  private readonly entries = new Map<string, DedupeEntry>();
  private readonly defaultWindowMs: number;

  constructor(defaultWindowMs = DEFAULT_COMMAND_DEDUPE_WINDOW_MS) {
    this.defaultWindowMs = defaultWindowMs;
  }

  /**
   * Verifica se a chave foi executada dentro da janela de debounce e, caso contrário,
   * adquire imediatamente o lock de idempotência para evitar corrida entre eventos paralelos.
   */
  public checkAndLock(
    key: string,
    now: number = Date.now(),
    windowMs: number = this.defaultWindowMs
  ): DedupeCheckResult {
    const normKey = String(key || '').trim();
    if (!normKey) {
      return { isDuplicate: false, remainingMs: 0, key: '' };
    }

    const existing = this.entries.get(normKey);
    if (existing) {
      const elapsed = now - existing.timestamp;
      if (elapsed >= 0 && elapsed < windowMs) {
        return {
          isDuplicate: true,
          remainingMs: windowMs - elapsed,
          key: normKey,
          cachedResult: existing.result
        };
      }
    }

    this.entries.set(normKey, { timestamp: now });
    this.pruneIfNeeded(now, Math.max(windowMs * 4, 60000));

    return {
      isDuplicate: false,
      remainingMs: 0,
      key: normKey
    };
  }

  /** Consulta não-destrutiva (não grava lock). */
  public isDuplicate(
    key: string,
    now: number = Date.now(),
    windowMs: number = this.defaultWindowMs
  ): boolean {
    const existing = this.entries.get(String(key || '').trim());
    if (!existing) return false;
    const elapsed = now - existing.timestamp;
    return elapsed >= 0 && elapsed < windowMs;
  }

  /** Atualiza o resultado em cache associado ao lock recém-executado. */
  public recordResult(key: string, result: any, now: number = Date.now()): void {
    const normKey = String(key || '').trim();
    if (!normKey) return;
    const existing = this.entries.get(normKey);
    this.entries.set(normKey, {
      timestamp: existing ? existing.timestamp : now,
      result
    });
  }

  /** Libera manualmente um lock específico (ex: em falha antes da execução real). */
  public release(key: string): void {
    const normKey = String(key || '').trim();
    if (normKey) {
      this.entries.delete(normKey);
    }
  }

  public reset(): void {
    this.entries.clear();
  }

  private pruneIfNeeded(now: number, maxAgeMs: number): void {
    if (this.entries.size <= 200) return;
    for (const [k, entry] of this.entries) {
      if (now - entry.timestamp > maxAgeMs) {
        this.entries.delete(k);
      }
    }
  }
}

export const commandDeduplicator = new CommandDeduplicator(DEFAULT_COMMAND_DEDUPE_WINDOW_MS);

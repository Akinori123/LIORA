/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface TokenUsageStats {
  geminiTokens: number;
  openRouterTokens: number;
  totalTokens: number;
  geminiCalls: number;
  openRouterCalls: number;
  totalCalls: number;
  averageLatencyMs: number;
  latencyHistory: number[];
  lastCallTimestamp: string | null;
}

const STORAGE_KEY = 'liora_token_analytics_v1';

class TokenAnalyticsService {
  private stats: TokenUsageStats = {
    geminiTokens: 0,
    openRouterTokens: 0,
    totalTokens: 0,
    geminiCalls: 0,
    openRouterCalls: 0,
    totalCalls: 0,
    averageLatencyMs: 0,
    latencyHistory: [],
    lastCallTimestamp: null
  };

  private listeners: Set<(stats: TokenUsageStats) => void> = new Set();

  constructor() {
    this.loadFromStorage();
  }

  private loadFromStorage(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.totalTokens === 'number') {
          this.stats = { ...this.stats, ...parsed };
        }
      }
    } catch (err) {
      console.warn('[TokenAnalytics] Erro ao carregar métricas:', err);
    }
  }

  private saveToStorage(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.stats));
    } catch {}
  }

  public getStats(): TokenUsageStats {
    return { ...this.stats, latencyHistory: [...this.stats.latencyHistory] };
  }

  public subscribe(listener: (stats: TokenUsageStats) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.saveToStorage();
    const current = this.getStats();
    for (const listener of this.listeners) {
      try {
        listener(current);
      } catch (err) {
        console.error('[TokenAnalytics] Erro em listener:', err);
      }
    }
  }

  /**
   * Registra uma chamada de API calculando tokens aproximados (Aprox: 1 token ~ 4 caracteres)
   */
  public recordApiCall(
    provider: 'gemini' | 'openrouter',
    promptLengthChars: number,
    responseLengthChars: number,
    latencyMs: number
  ): void {
    const estimatedPromptTokens = Math.max(1, Math.ceil(promptLengthChars / 4));
    const estimatedResponseTokens = Math.max(1, Math.ceil(responseLengthChars / 4));
    const callTokens = estimatedPromptTokens + estimatedResponseTokens;

    if (provider === 'gemini') {
      this.stats.geminiTokens += callTokens;
      this.stats.geminiCalls += 1;
    } else {
      this.stats.openRouterTokens += callTokens;
      this.stats.openRouterCalls += 1;
    }

    this.stats.totalTokens = this.stats.geminiTokens + this.stats.openRouterTokens;
    this.stats.totalCalls = this.stats.geminiCalls + this.stats.openRouterCalls;

    // Atualiza latência média móvel
    const safeLatency = Math.max(1, Math.round(latencyMs));
    this.stats.latencyHistory.push(safeLatency);
    if (this.stats.latencyHistory.length > 20) {
      this.stats.latencyHistory.shift();
    }

    const sumLatency = this.stats.latencyHistory.reduce((a, b) => a + b, 0);
    this.stats.averageLatencyMs = Math.round(sumLatency / this.stats.latencyHistory.length);
    this.stats.lastCallTimestamp = new Date().toISOString();

    this.notify();
  }

  public reset(): void {
    this.stats = {
      geminiTokens: 0,
      openRouterTokens: 0,
      totalTokens: 0,
      geminiCalls: 0,
      openRouterCalls: 0,
      totalCalls: 0,
      averageLatencyMs: 0,
      latencyHistory: [],
      lastCallTimestamp: null
    };
    this.notify();
  }
}

export const tokenAnalytics = new TokenAnalyticsService();

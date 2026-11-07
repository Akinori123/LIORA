/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — Ação e Integração de GPS / Navegação Visual (Google Maps & Waze)
 *
 * Responsável por formatar URLs oficiais de rotas e acionar o aplicativo
 * de navegação visual padrão do sistema ou navegador sem travar a interface.
 */

import { ToolDefinition } from '../types';
import { isTauriEnvironment, invokeTauri } from '../../security/localBridge';

export type GpsNavigationProvider = 'google_maps' | 'waze' | 'auto';
export type GpsOrigin = string | { lat: number; lng: number };

export interface FormattedGpsRoute {
  url: string;
  provider: 'google_maps' | 'waze';
  originMode: 'coordinates' | 'named_place' | 'current_gps';
  origin?: string;
  destination: string;
}

/**
 * Formata a URL de navegação oficial conforme o provedor selecionado e ponto de partida.
 * Se a origem não for especificada, Google Maps e Waze utilizam automaticamente
 * a localização atual por GPS do dispositivo/veículo.
 */
export function formatGpsNavigationUrl(
  destination: string,
  provider: GpsNavigationProvider = 'auto',
  origin?: GpsOrigin
): FormattedGpsRoute {
  const cleanDest = destination.trim();
  const selectedProvider: 'google_maps' | 'waze' = provider === 'waze' ? 'waze' : 'google_maps';
  const destEncoded = encodeURIComponent(cleanDest);

  // 1. Provedor Waze
  if (selectedProvider === 'waze') {
    // No Waze, o deep link universal navega diretamente a partir do GPS atual até o destino
    return {
      url: `https://waze.com/ul?q=${destEncoded}&navigate=yes`,
      provider: 'waze',
      originMode: origin ? (typeof origin === 'object' ? 'coordinates' : 'named_place') : 'current_gps',
      origin: typeof origin === 'string' ? origin : origin ? `${origin.lat},${origin.lng}` : undefined,
      destination: cleanDest
    };
  }

  // 2. Provedor Google Maps
  // Cenário A: Origem por coordenadas GPS { lat, lng }
  if (origin && typeof origin === 'object' && typeof origin.lat === 'number' && typeof origin.lng === 'number') {
    return {
      url: `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lng}&destination=${destEncoded}&travelmode=driving`,
      provider: 'google_maps',
      originMode: 'coordinates',
      origin: `${origin.lat},${origin.lng}`,
      destination: cleanDest
    };
  }

  // Cenário B: Origem por nome textual (ex: "Ponta Grossa", "Av. Paulista")
  if (typeof origin === 'string' && origin.trim()) {
    const cleanOrigin = origin.trim();
    return {
      url: `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(cleanOrigin)}&destination=${destEncoded}&travelmode=driving`,
      provider: 'google_maps',
      originMode: 'named_place',
      origin: cleanOrigin,
      destination: cleanDest
    };
  }

  // Cenário C: Sem origem declarada -> O Google Maps assume automaticamente o GPS atual do usuário
  return {
    url: `https://www.google.com/maps/dir/?api=1&destination=${destEncoded}&travelmode=driving`,
    provider: 'google_maps',
    originMode: 'current_gps',
    destination: cleanDest
  };
}

/**
 * GUARDA ANTI-ABAS EM TESTES: quando LIORA_NO_BROWSER=1, os lançadores de SO
 * (rundll32/xdg-open/window.open) são PULADOS — a ferramenta retorna sucesso com
 * a URL formada e dryRun: true, sem abrir nenhuma aba real. Auditoria: antes,
 * cada npm test abria abas de Maps/Waze de verdade.
 * LEITURA DINÂMICA (get): a env pode ser setada a qualquer momento (inclusive
 * dentro de arquivos de teste após imports), não apenas no import-time.
 */
export function isBrowserDryRun(): boolean {
  return typeof process !== 'undefined' && process.env?.LIORA_NO_BROWSER === '1';
}

/**
 * Dispara a abertura do aplicativo oficial de navegação no sistema hospedeiro
 */
export async function launchGpsNavigation(
  destination: string,
  provider: GpsNavigationProvider = 'auto',
  origin?: GpsOrigin
): Promise<{ success: boolean; url: string; provider: string; originMode: string; dryRun?: boolean }> {
  const route = formatGpsNavigationUrl(destination, provider, origin);
  const { url, provider: resolvedProvider, originMode } = route;

  if (isBrowserDryRun()) {
    return { success: true, url, provider: resolvedProvider, originMode, dryRun: true };
  }

  // 1. Ambiente Tauri Desktop Nativo
  if (isTauriEnvironment()) {
    try {
      await invokeTauri<boolean>('open_application', { target: url });
      return { success: true, url, provider: resolvedProvider, originMode };
    } catch (tauriErr) {
      console.warn('[NavigationTool] Falha ao abrir via Tauri IPC, tentando fallback:', tauriErr);
    }
  }

  // 2. Ambiente Browser / Web Preview
  if (typeof window !== 'undefined') {
    try {
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (opened) {
        return { success: true, url, provider: resolvedProvider, originMode };
      }
    } catch (winErr) {
      console.warn('[NavigationTool] window.open bloqueado ou falhou:', winErr);
    }

    // Fallback para abrir no host pelo servidor Express
    try {
      const res = await fetch('/api/tools/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toolName: 'open_gps_navigation',
          parameters: { destination, provider, origin }
        })
      });
      if (res.ok) {
        return { success: true, url, provider: resolvedProvider, originMode };
      }
    } catch (fetchErr) {
      console.warn('[NavigationTool] Falha ao delegar abertura ao servidor:', fetchErr);
    }
  }

  // 3. Ambiente Node.js (Servidor Express)
  if (typeof window === 'undefined') {
    try {
      const { exec } = await import('child_process');
      const os = await import('os');
      const platform = os.platform();

      if (platform === 'win32') {
        exec(`rundll32.exe url.dll,FileProtocolHandler "${url}"`);
      } else if (platform === 'darwin') {
        exec(`open "${url}"`);
      } else {
        exec(`xdg-open "${url}"`);
      }
      return { success: true, url, provider: resolvedProvider, originMode };
    } catch (nodeErr) {
      console.warn('[NavigationTool] Falha ao abrir via Node child_process:', nodeErr);
    }
  }

  return { success: false, url, provider: resolvedProvider, originMode };
}

/**
 * Ferramenta oficial para o Tool Registry: open_gps_navigation (R0)
 */
export const openGpsNavigationTool: ToolDefinition<{
  destination: string;
  origin?: string;
  provider?: GpsNavigationProvider;
  originLat?: number;
  originLng?: number;
}, any> = {
  name: 'open_gps_navigation',
  description: 'Abre diretamente o Google Maps ou Waze com a rota traçada até o destino informado. Suporta origem nomeada ou automática via GPS. Risco R0.',
  category: 'utility',
  riskLevel: 'R0',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      destination: {
        type: 'string',
        description: 'Endereço, local ou coordenadas de destino para a navegação.'
      },
      origin: {
        type: 'string',
        description: 'Ponto de partida / origem da rota (opcional; se omitido, o Maps/Waze utiliza o GPS atual).'
      },
      provider: {
        type: 'string',
        enum: ['google_maps', 'waze', 'auto'],
        description: 'Aplicativo de GPS preferido (padrão: "auto" -> Google Maps).',
        default: 'auto'
      },
      originLat: {
        type: 'number',
        description: 'Latitude atual de origem (opcional).'
      },
      originLng: {
        type: 'number',
        description: 'Longitude atual de origem (opcional).'
      }
    },
    required: ['destination'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['success', 'url', 'provider', 'destination', 'originMode', 'simulated']
  },
  execute: async ({ destination, origin, provider = 'auto', originLat, originLng }) => {
    const resolvedOrigin: GpsOrigin | undefined =
      (typeof originLat === 'number' && typeof originLng === 'number')
        ? { lat: originLat, lng: originLng }
        : (origin && typeof origin === 'string' && origin.trim())
          ? origin.trim()
          : undefined;

    // BUG FIX (duplicação de abas): lock atômico por intenção — a MESMA rota
    // solicitada dentro da janela de 5s é um no-op que retorna o resultado anterior
    const intentKey = normalizeIntentKey('gps_nav', destination, provider, typeof resolvedOrigin === 'string' ? resolvedOrigin : resolvedOrigin ? `${resolvedOrigin.lat},${resolvedOrigin.lng}` : undefined);
    const lock = checkIntentLock(intentKey);
    if (lock.duplicate && lock.previous?.success) {
      return { ...lock.previous, duplicateSuppressed: true, message: `${lock.previous.message} (chamada duplicada suprimida — aba já aberta há menos de 5s).` };
    }

    const result = await launchGpsNavigation(destination, provider, resolvedOrigin);

    const appLabel = result.provider === 'waze' ? 'Waze' : 'Google Maps';
    const originDesc = result.originMode === 'coordinates'
      ? `com partida em [${originLat}, ${originLng}]`
      : result.originMode === 'named_place'
        ? `com partida em "${origin}"`
        : 'com partida na sua localização GPS atual';

    const response = {
      success: result.success,
      url: result.url,
      provider: result.provider,
      destination: destination.trim(),
      originMode: result.originMode,
      origin: typeof resolvedOrigin === 'string' ? resolvedOrigin : resolvedOrigin ? `${resolvedOrigin.lat},${resolvedOrigin.lng}` : undefined,
      message: `Navegação iniciada no ${appLabel} para "${destination.trim()}" ${originDesc}.`,
      simulated: false
    };
    setIntentLock(intentKey, response);
    return response;
  }
};

/**
 * Formata a URL de busca de estabelecimentos e locais no Google Maps Places
 */
export function formatPlacesSearchUrl(
  query: string,
  nearLocation?: string
): { url: string; query: string; nearLocation?: string } {
  const cleanQuery = query.trim();
  let fullSearch = cleanQuery;

  if (nearLocation && typeof nearLocation === 'string' && nearLocation.trim()) {
    const cleanNear = nearLocation.trim();
    // Se a localização de referência não for genérica ("daqui", "aqui", etc.), adiciona ao termo
    if (!/^(?:daqui|aqui|meu\s+local|localiza[cç][aã]o\s+atual|perto|pr[oó]ximo)$/i.test(cleanNear)) {
      fullSearch = `${cleanQuery} em ${cleanNear}`;
    }
  }

  const encodedQuery = encodeURIComponent(fullSearch);
  return {
    url: `https://www.google.com/maps/search/?api=1&query=${encodedQuery}`,
    query: cleanQuery,
    nearLocation: nearLocation?.trim()
  };
}

/**
 * BUG CRÍTICO CORRIGIDO (duplicação de abas do Maps): lock atômico de intenção.
 * Sintoma relatado: "farmácia + supermercado abriam MÚLTIPLAS abas paralelas".
 * Causas na raiz (3 camadas):
 *  1. O LLM emitia múltiplas tool calls numa mesma resposta (function calling
 *     paralelo), cada uma abrindo sua aba — sem coordenação entre elas.
 *  2. A cadeia de fallback do launch era SEM curto-circuito: Tauri → window.open
 *     → servidor, sem cancelar os intermediários (ex: Tauri abre + window.open
 *     abre de novo = 2 abas).
 *  3. Sem debounce temporal — cliques rápidos/retentivas duplicavam.
 * Solução: registro de intenção por janela de tempo (5s). Se a MESMA intenção
 * (query/destino normalizados) foi executada há menos de 5s, a nova chamada é
 * um NO-OP que retorna o resultado anterior — exclusividade atômica garantida.
 */
const INTENT_LOCK_WINDOW_MS = 5000;
const intentLocks = new Map<string, { timestamp: number; result: any }>();

function normalizeIntentKey(prefix: string, ...parts: Array<string | undefined>): string {
  const joined = parts.filter(Boolean).join('|').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  return `${prefix}:${joined}`;
}

function checkIntentLock(key: string): { duplicate: boolean; previous?: any } {
  const entry = intentLocks.get(key);
  if (!entry) return { duplicate: false };
  if (Date.now() - entry.timestamp > INTENT_LOCK_WINDOW_MS) {
    intentLocks.delete(key);
    return { duplicate: false };
  }
  return { duplicate: true, previous: entry.result };
}

function setIntentLock(key: string, result: any): void {
  intentLocks.set(key, { timestamp: Date.now(), result });
  // GC: evita crescimento infinito do mapa
  if (intentLocks.size > 50) {
    const now = Date.now();
    for (const [k, v] of intentLocks) {
      if (now - v.timestamp > INTENT_LOCK_WINDOW_MS) intentLocks.delete(k);
    }
  }
}

/**
 * Dispara a abertura da busca de locais no Google Maps
 */
export async function launchPlacesSearch(
  query: string,
  nearLocation?: string
): Promise<{ success: boolean; url: string; query: string; dryRun?: boolean }> {
  const { url, query: resolvedQuery } = formatPlacesSearchUrl(query, nearLocation);

  if (isBrowserDryRun()) {
    return { success: true, url, query: resolvedQuery, dryRun: true };
  }

  // 1. Ambiente Tauri Desktop Nativo
  if (isTauriEnvironment()) {
    try {
      await invokeTauri<boolean>('open_application', { target: url });
      return { success: true, url, query: resolvedQuery };
    } catch (tauriErr) {
      console.warn('[PlacesTool] Falha ao abrir via Tauri IPC, tentando fallback:', tauriErr);
    }
  }

  // 2. Ambiente Browser / Web Preview
  if (typeof window !== 'undefined') {
    try {
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (opened) {
        return { success: true, url, query: resolvedQuery };
      }
    } catch (winErr) {
      console.warn('[PlacesTool] window.open bloqueado ou falhou:', winErr);
    }

    // Fallback: delega ao servidor Express local para abrir no host
    try {
      const res = await fetch('/api/tools/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toolName: 'maps_search_places',
          parameters: { query, nearLocation }
        })
      });
      if (res.ok) {
        return { success: true, url, query: resolvedQuery };
      }
    } catch (fetchErr) {
      console.warn('[PlacesTool] Falha ao delegar abertura ao servidor:', fetchErr);
    }
  }

  // 3. Ambiente Node.js (Servidor Express)
  if (typeof window === 'undefined') {
    try {
      const { exec } = await import('child_process');
      const os = await import('os');
      const platform = os.platform();

      if (platform === 'win32') {
        exec(`rundll32.exe url.dll,FileProtocolHandler "${url}"`);
      } else if (platform === 'darwin') {
        exec(`open "${url}"`);
      } else {
        exec(`xdg-open "${url}"`);
      }
      return { success: true, url, query: resolvedQuery };
    } catch (nodeErr) {
      console.warn('[PlacesTool] Falha ao abrir via Node child_process:', nodeErr);
    }
  }

  return { success: false, url, query: resolvedQuery };
}

/**
 * Ferramenta oficial para o Tool Registry: maps_search_places (R0)
 */
export const mapsSearchPlacesTool: ToolDefinition<{
  query: string;
  nearLocation?: string;
}, any> = {
  name: 'maps_search_places',
  description: 'Pesquisa estabelecimentos, serviços e pontos de interesse (ex: farmácias, mercados, postos de combustível, hospitais, restaurantes) no Google Maps. Risco R0.',
  category: 'utility',
  riskLevel: 'R0',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Termo de busca (ex: "farmácia mais próxima", "mercado", "posto de gasolina", "restaurante").'
      },
      nearLocation: {
        type: 'string',
        description: 'Endereço, cidade ou local de referência (opcional; se omitido ou "daqui", busca próximo à localização atual).'
      }
    },
    required: ['query'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    requiredFields: ['success', 'url', 'query', 'message', 'simulated']
  },
  execute: async ({ query, nearLocation }) => {
    // BUG FIX (duplicação de abas): lock atômico por intenção — a MESMA busca
    // dentro da janela de 5s é um no-op (ex: "farmácia" dita duas vezes seguidas
    // pelo LLM numa mesma resposta abre UMA aba, não duas)
    const intentKey = normalizeIntentKey('places_search', query, nearLocation);
    const lock = checkIntentLock(intentKey);
    if (lock.duplicate && lock.previous?.success) {
      return { ...lock.previous, duplicateSuppressed: true, message: `${lock.previous.message} (chamada duplicada suprimida — busca já aberta há menos de 5s).` };
    }

    const result = await launchPlacesSearch(query, nearLocation);
    const locDesc = nearLocation && !/^(?:daqui|aqui|meu\s+local|localiza[cç][aã]o\s+atual)$/i.test(nearLocation.trim())
      ? `em ${nearLocation.trim()}`
      : 'próximo à sua localização atual';

    const response = {
      success: result.success,
      url: result.url,
      query: query.trim(),
      nearLocation: nearLocation?.trim(),
      message: `Buscando "${query.trim()}" no Google Maps ${locDesc}.`,
      simulated: false
    };
    setIntentLock(intentKey, response);
    return response;
  }
};


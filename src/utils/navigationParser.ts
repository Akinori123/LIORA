/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { NavTab } from '../types';

export interface NavigationMatch {
  tab: NavTab;
  label: string;
  spokenFeedback: string;
  matchedTerm: string;
  rawInput: string;
}

export interface TabSynonymConfig {
  tab: NavTab;
  label: string;
  spokenFeedback: string;
  synonyms: string[];
}

export const TAB_NAVIGATION_CONFIGS: Record<NavTab, TabSynonymConfig> = {
  settings: {
    tab: 'settings',
    label: 'Configurações',
    spokenFeedback: 'Abrindo configurações.',
    synonyms: [
      'settings',
      'config',
      'configs',
      'configuracao',
      'configuracoes',
      'ajustes',
      'ajuste',
      'preferencias',
      'preferencia'
    ]
  },
  cockpit: {
    tab: 'cockpit',
    label: 'Cockpit & Veículo',
    spokenFeedback: 'Abrindo cockpit veicular.',
    synonyms: [
      'cockpit',
      'carro',
      'veiculo',
      'veiculos',
      'hud',
      'painel',
      'pilot',
      'piloto',
      'veicular'
    ]
  },
  conversation: {
    tab: 'conversation',
    label: 'Conversa & Voz',
    spokenFeedback: 'Abrindo conversa.',
    synonyms: [
      'conversas',
      'conversa',
      'chat',
      'voz',
      'live',
      'dialogo',
      'bate papo'
    ]
  },
  devices: {
    tab: 'devices',
    label: 'Dispositivos & PULO',
    spokenFeedback: 'Abrindo dispositivos.',
    synonyms: [
      'dispositivos',
      'pulo',
      'dispositivo',
      'aparelhos',
      'aparelho',
      'casa',
      'hardware',
      'iot'
    ]
  },
  automations: {
    tab: 'automations',
    label: 'Automações',
    spokenFeedback: 'Abrindo automações.',
    synonyms: [
      'automacoes',
      'automacao',
      'regras',
      'regra',
      'rotinas',
      'rotina'
    ]
  },
  memory: {
    tab: 'memory',
    label: 'Memória & Contexto',
    spokenFeedback: 'Abrindo memória.',
    synonyms: [
      'memoria',
      'memorias',
      'cofre',
      'historico',
      'contexto',
      'lembrancas',
      'lembranca'
    ]
  },
  integrations: {
    tab: 'integrations',
    label: 'Integrações & MCP',
    spokenFeedback: 'Abrindo integrações.',
    synonyms: [
      'integracoes',
      'integracao',
      'mcp',
      'chaves',
      'apis',
      'api',
      'conexoes',
      'servicos'
    ]
  },
  developer: {
    tab: 'developer',
    label: 'Desenvolvedor & Git',
    spokenFeedback: 'Abrindo modo desenvolvedor.',
    synonyms: [
      'desenvolvedor',
      'developer',
      'dev',
      'git',
      'rea',
      'terminal',
      'codigo',
      'codigos'
    ]
  },
  activity: {
    tab: 'activity',
    label: 'Atividade & Logs',
    spokenFeedback: 'Abrindo registro de atividades.',
    synonyms: [
      'atividade',
      'atividades',
      'timeline',
      'auditoria',
      'logs',
      'log',
      'eventos'
    ]
  },
  home: {
    tab: 'home',
    label: 'Início',
    spokenFeedback: 'Voltando para a tela inicial.',
    synonyms: [
      'home',
      'inicio',
      'principal',
      'orbe',
      'tela inicial',
      'painel principal'
    ]
  }
};

/**
 * Normaliza uma string de texto para análise determinística:
 * 1. Converte para minúsculas
 * 2. Remove acentuação e diacríticos (NFD)
 * 3. Remove pontuações e caracteres especiais
 * 4. Normaliza espaços múltiplos
 */
export function normalizeNavigationText(text: string): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Prefixos e conectivos de intenção de navegação
 */
const NAVIGATION_PREFIX_REGEX = /^(?:abr[aei]r?|va(?:i|a)?(?:\s+para|\s+pra|\s+na|\s+no)?|ir(?:\s+para|\s+pra|\s+na|\s+no)?|volt[aei]r?(?:\s+para|\s+pra|\s+ao|\s+a)?|retorn[aei]r?(?:\s+para|\s+pra|\s+ao|\s+a)?|mostr[aei]r?|mud[aei]r?(?:\s+para|\s+pra)?|troqu?e?(?:\s+para|\s+pra)?|navegu?e?(?:\s+para|\s+pra)?|acess[aei]r?|ativ[aei]r?|exib[aei]r?)\s+/;

const FILLERS_REGEX = /^(?:a|o|as|os|para|pra|na|no|em|de|da|do|aba|tela|painel|modulo|secao|seccao|modo)\s+/;

const QUESTION_PREFIX_REGEX = /^(?:o que e|o que sao|como funciona|como|qual|quais|por que|porque|quem|onde|quando|explique|me explique|me diga)\b/;

/**
 * Analisa determinísticamente se o texto falado ou digitado corresponde a uma
 * intenção de navegação para uma das 10 abas da LIORA.
 *
 * Suporta:
 * 1. Nome/abreviação direta isolada (ex: "config", "configs", "carro", "dev", "dispositivos")
 * 2. Prefixos de ação com artigos (ex: "abrir configurações", "abra as configs", "vai para o cockpit", "muda para automacoes")
 * 3. Rejeita perguntas conceituais para não interferir em prompts explicativos do LLM.
 */
export function parseNavigationIntent(input: string): NavigationMatch | null {
  if (!input) return null;
  const rawClean = input.trim();
  if (!rawClean) return null;

  const normalized = normalizeNavigationText(rawClean);
  if (!normalized) return null;

  // Se for uma pergunta ou pedido explicativo direto, cede a palavra ao LLM
  if (QUESTION_PREFIX_REGEX.test(normalized)) {
    return null;
  }

  // 1. Verificação de correspondência exata ou quase-exata com sinônimos conhecidos
  for (const config of Object.values(TAB_NAVIGATION_CONFIGS)) {
    for (const syn of config.synonyms) {
      const normSyn = normalizeNavigationText(syn);
      if (normalized === normSyn) {
        return {
          tab: config.tab,
          label: config.label,
          spokenFeedback: config.spokenFeedback,
          matchedTerm: syn,
          rawInput: rawClean
        };
      }
    }
  }

  // 2. Extração de comando com prefixos de navegação (ex: "abrir as configurações", "vai pra tela de config")
  let stripped = normalized;
  let hasNavPrefix = false;

  const prefixMatch = stripped.match(NAVIGATION_PREFIX_REGEX);
  if (prefixMatch) {
    hasNavPrefix = true;
    stripped = stripped.slice(prefixMatch[0].length).trim();
  }

  // Remove conectivos e artigos extras repetidamente (ex: "a tela de", "o painel do")
  let prev = '';
  while (prev !== stripped) {
    prev = stripped;
    stripped = stripped.replace(FILLERS_REGEX, '').trim();
  }

  if (stripped) {
    // Procura correspondência no restante da frase
    for (const config of Object.values(TAB_NAVIGATION_CONFIGS)) {
      for (const syn of config.synonyms) {
        const normSyn = normalizeNavigationText(syn);
        if (stripped === normSyn) {
          return {
            tab: config.tab,
            label: config.label,
            spokenFeedback: config.spokenFeedback,
            matchedTerm: syn,
            rawInput: rawClean
          };
        }
      }
    }
  }

  // 3. Se houver prefixo explícito de navegação, aceita que o sinônimo seja uma palavra-chave presente
  if (hasNavPrefix && stripped) {
    // Ordena por tamanho decrescente para priorizar sinônimos mais específicos
    for (const config of Object.values(TAB_NAVIGATION_CONFIGS)) {
      for (const syn of config.synonyms) {
        const normSyn = normalizeNavigationText(syn);
        // Verifica se é uma palavra completa
        const wordRegex = new RegExp(`\\b${normSyn}\\b`);
        if (wordRegex.test(stripped)) {
          return {
            tab: config.tab,
            label: config.label,
            spokenFeedback: config.spokenFeedback,
            matchedTerm: syn,
            rawInput: rawClean
          };
        }
      }
    }
  }

  return null;
}

export interface RouteIntent {
  rawInput: string;
  destination: string;
  origin?: string;
  provider: 'google_maps' | 'waze' | 'auto';
  spokenFeedback: string;
}

export interface PlacesSearchIntent {
  rawInput: string;
  query: string;
  nearLocation?: string;
  spokenFeedback: string;
}

/**
 * Remove artigos definidos ou indefinidos no início do nome de um local
 * Ex: "o Aeroporto" -> "Aeroporto", "a Casa" -> "Casa", "o Posto Ipiranga" -> "Posto Ipiranga"
 */
function cleanPlaceName(name: string): string {
  if (!name) return '';
  return name
    .replace(/^(?:o|a|os|as|um|uma|uns|umas)\s+/i, '')
    .trim();
}

/**
 * Normaliza referências locais relativas ("daqui", "aqui", "meu local") para undefined,
 * permitindo que o GPS automático ou localização cadastrada seja utilizada.
 */
function normalizeOrigin(origin?: string): string | undefined {
  if (!origin) return undefined;
  const clean = origin.trim();
  if (/^(?:daqui|aqui|meu\s+local|local\s+atual|localiza[cç][aã]o\s+atual|minha\s+localiza[cç][aã]o)$/i.test(clean)) {
    return undefined;
  }
  return clean;
}

/**
 * Intercepta e extrai intenções de navegação veicular por GPS (Google Maps e Waze).
 * 
 * Suporta:
 * 1. Comando com Origem e Destino declarados:
 *    "Calcula rota de Ponta Grossa para Curitiba no Waze"
 *    "Rota de Ponta Grossa a São Paulo"
 *    -> { origin: "Ponta Grossa", destination: "Curitiba", provider: "waze" }
 * 
 * 2. Comando apenas com Destino ou com "daqui até [cidade]":
 *    "LIORA, navegar para o Aeroporto no Google Maps"
 *    "daqui até São Paulo quanto tempo?"
 *    "quanto tempo daqui até São Paulo"
 *    -> { origin: undefined, destination: "São Paulo", provider: "google_maps" }
 * 
 * 3. Provedores suportados: Google Maps, Waze ou Auto.
 */
export function parseRouteIntent(input: string): RouteIntent | null {
  if (!input) return null;
  const rawClean = input.trim().replace(/[.!?]+$/, '').trim();
  if (!rawClean) return null;

  const normalized = normalizeNavigationText(rawClean);
  if (!normalized) return null;

  // Permite comandos de tempo/distância de rota mesmo que usem palavras interrogativas
  const isRouteQuery = /^(?:como\s+chegar|quanto\s+tempo|qual\s+(?:o\s+)?tempo|qual\s+(?:a\s+)?dist[aâ]ncia|tempo\s+de\s+viagem|daqui\s+(?:at[eé]|para|pra|ao|a|à))\b/i.test(normalized);

  // Rejeita outras perguntas conceituais gerais
  if (QUESTION_PREFIX_REGEX.test(normalized) && !isRouteQuery) {
    return null;
  }

  // 1. Detecção do Provedor de Navegação (Google Maps, Waze ou Auto)
  let provider: 'google_maps' | 'waze' | 'auto' = 'auto';
  if (/\b(?:no|pelo|via|com\s+o|usando\s+o|no\s+app|no\s+aplicativo)?\s*waze\b/i.test(rawClean)) {
    provider = 'waze';
  } else if (/\b(?:no|pelo|via|com\s+o|usando\s+o|no\s+app|no\s+aplicativo)?\s*(?:google\s+maps|maps)\b/i.test(rawClean)) {
    provider = 'google_maps';
  }

  // Remove a menção ao provedor do final/meio da string para isolar os locais
  let workingText = rawClean
    .replace(/\b(?:no|pelo|via|com\s+o|usando\s+o|no\s+app|no\s+aplicativo)?\s*(?:waze|google\s+maps|maps)\b/gi, '')
    .trim();

  // 2. Remove chamados e wake words do início
  workingText = workingText
    .replace(/^(?:liora[,\s]+|ei\s+liora[,\s]+|ok\s+liora[,\s]+|por\s+favor[,\s]+|por\s+gentileza[,\s]+)/i, '')
    .trim();

  // 3. Remove perguntas de tempo/distância ao final da frase (ex: "quanto tempo?", "quanto tempo demora?")
  workingText = workingText
    .replace(/\s+(?:quanto\s+tempo(?:\s+(?:leva|demora|gasta|e|é))?|qual\s+(?:o\s+)?tempo|qual\s+(?:a\s+)?dist[aâ]ncia|tempo\s+de\s+viagem)\??$/i, '')
    .trim();

  // 4. Verifica e remove prefixos de intenção de rota
  const routePrefixRegex = /^(?:(?:calcul[aei]r?|tra[cç][aei]r?|inici[aei]r?|defin[aei]r?|gerar|abr[aei]r?)\s+(?:uma\s+|a\s+|o\s+)?rota|(?:navegu?e?r?|navega(?:r)?)|(?:como\s+chegar)|(?:ir|va(?:i)?|levar|me\s+leva|me\s+leve)|(?:abr[aei]r?)\s+(?:o\s+)?(?:waze|google\s+maps|maps)|(?:quanto\s+tempo(?:\s+(?:leva|demora|gasta|e|é))?|tempo\s+de\s+viagem|dist[aâ]ncia(?:\s+de)?)|(?:daqui|aqui)\s+(?:at[eé]|para|pra|ao|a|à)|rota)\s+/i;

  let prefixMatch = workingText.match(routePrefixRegex);
  let payload = workingText;
  if (prefixMatch) {
    payload = workingText.slice(prefixMatch[0].length).trim();
    // Se o prefixo consumiu "daqui até", "daqui para", etc., a origem já é o ponto atual
    if (/^(?:daqui|aqui)\s+(?:at[eé]|para|pra|ao|a|à)\s+/i.test(prefixMatch[0])) {
      payload = `daqui até ${payload}`;
    }
  } else {
    // Se não bateu com prefixo clássico, checa se começa diretamente com "daqui até/para" ou "de X a Y"
    if (!/^(?:(?:daqui|aqui)\s+(?:at[eé]|para|pra|ao|a|à)|de\s+.+?\s+(?:para|pra|at[eé]|ao|a|à))\s+/i.test(workingText)) {
      return null;
    }
  }

  if (!payload) return null;

  let origin: string | undefined = undefined;
  let destination: string | undefined = undefined;

  // 5. Cenário A: "daqui até/para/ao/a <Destino>"
  const daquiMatch = payload.match(/^(?:daqui|aqui)\s+(?:at[eé]|para|pra|ao|a|à)\s+(.+)$/i);
  if (daquiMatch) {
    origin = undefined; // Origem automática por GPS
    destination = cleanPlaceName(daquiMatch[1]);
  } else {
    // 6. Cenário B: "de <Origem> para/pra/ate/ao/a <Destino>"
    const originDestMatch = payload.match(/^(?:de|do|da|dos|das)\s+(.+?)\s+(?:para|pra|at[eé]|ao|a|à)\s+(.+)$/i);
    if (originDestMatch) {
      origin = normalizeOrigin(cleanPlaceName(originDestMatch[1]));
      destination = cleanPlaceName(originDestMatch[2]);
    } else {
      // 7. Cenário C: Apenas Destino (com ou sem conectivo inicial "para", "pra", "ao", "a", "em", "no", "na")
      const destMatch = payload.match(/^(?:para|pra|at[eé]|ao|a|à|em|no|na|nos|nas)\s+(.+)$/i);
      if (destMatch) {
        destination = cleanPlaceName(destMatch[1]);
      } else {
        destination = cleanPlaceName(payload);
      }
    }
  }

  // Remove eventuais perguntas de tempo residuais do destino
  if (destination) {
    destination = destination
      .replace(/\s+(?:quanto\s+tempo(?:\s+(?:leva|demora|gasta|e|é))?|qual\s+(?:o\s+)?tempo|qual\s+(?:a\s+)?dist[aâ]ncia|tempo\s+de\s+viagem)\??$/i, '')
      .trim();
  }

  if (!destination) return null;

  // Monta feedback falado conciso para o condutor/usuário
  const appLabel = provider === 'waze' ? 'no Waze' : provider === 'google_maps' ? 'no Google Maps' : '';
  const spokenFeedback = origin
    ? `Rota traçada de ${origin} para ${destination}${appLabel ? ` ${appLabel}` : ''}.`
    : `Calculando rota para ${destination}${appLabel ? ` ${appLabel}` : ''} a partir da sua localização atual.`;

  return {
    rawInput: rawClean,
    destination,
    origin,
    provider,
    spokenFeedback
  };
}

/**
 * Intercepta e extrai intenções de busca de estabelecimentos e locais de interesse (Places)
 * Ex: "qual o mercado mais próximo", "farmácia mais próxima de Ponta Grossa", "posto de gasolina perto daqui"
 */
export function parsePlacesSearchIntent(input: string): PlacesSearchIntent | null {
  if (!input) return null;
  const rawClean = input.trim().replace(/[.!?]+$/, '').trim();
  if (!rawClean) return null;

  const normalized = normalizeNavigationText(rawClean);
  if (!normalized) return null;

  // Lista de estabelecimentos e categorias comuns de busca local
  const PLACE_KEYWORDS = /\b(?:mercado|supermercado|farm[aá]cia|drogaria|posto(?:\s+de\s+gasolina|\s+de\s+combust[ií]vel)?|hospital|pronto\s+socorro|upa|padaria|restaurante|oficina(?:\s+mec[aâ]nica)?|borracharia|banco|caixa\s+eletr[oô]nico|hotel|pousada|lanchonete|bar|shopping|academia|estacionamento)\b/i;

  if (!PLACE_KEYWORDS.test(rawClean)) {
    return null;
  }

  // Regex para capturar padrão: "qual o <local> mais próximo (de <referencia>)?"
  const placesRegex = /^(?:liora[,\s]+|ei\s+liora[,\s]+|ok\s+liora[,\s]+)?(?:qual\s+(?:o|a|os|as)?\s*|onde\s+fica(?:\s+(?:o|a|os|as))?\s*|onde\s+tem\s*|buscar\s+|procurar\s+|encontrar\s+|ver\s+)?(.+?)\s+(mais\s+pr[oó]xim[oa]s?|perto(?:\s+de\s+mim|\s+daqui)?|pr[oó]xim[oa]s?)(?:\s+(?:de|em|na|no|daqui|aqui)\s+(.+))?$/i;

  const match = rawClean.match(placesRegex);
  if (!match) {
    return null;
  }

  let query = cleanPlaceName(match[1].trim());
  const modifier = match[2] ? match[2].trim() : 'mais próximo';
  let nearLocation = match[3] ? match[3].trim() : undefined;

  // Normaliza termos como "daqui", "aqui" para undefined (usar localização atual)
  if (nearLocation && /^(?:daqui|aqui|meu\s+local|localiza[cç][aã]o\s+atual|perto|pr[oó]ximo)$/i.test(nearLocation)) {
    nearLocation = undefined;
  }

  // Preserva termo qualificado, ex: "farmácia mais próxima"
  const fullSearchTerm = `${query} ${modifier}`;

  const spokenFeedback = nearLocation
    ? `Buscando ${fullSearchTerm} em ${nearLocation} no Google Maps.`
    : `Buscando ${fullSearchTerm} próximo à sua localização atual no Google Maps.`;

  return {
    rawInput: rawClean,
    query: fullSearchTerm,
    nearLocation,
    spokenFeedback
  };
}

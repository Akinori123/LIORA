/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — RESOLUÇÃO DE LOCAIS SEMÂNTICOS (Etapa 1: Casa, Trabalho, etc.)
 *
 * Problema corrigido: o modelo não sabe onde fica a "casa" ou o "trabalho" do
 * usuário — tentava adivinhar ou falhava. Esta ferramenta resolve apelidos
 * geográficos consultando a MEMÓRIA SEMÂNTICA do usuário (que já persiste
 * entradas como "casa → Rua X, 123" quando o usuário ensina a LIORA).
 *
 * Fluxo: o LLM chama resolve_place_alias ANTES de open_gps_navigation quando
 * o destino é um apelido ("minha casa", "trabalho"). Se a memória tem o
 * endereço, a tool o devolve; senão, instrui o modelo a PEDIR o endereço e
 * ensinar a LIORA (addMemory) para as próximas vezes.
 */

import { ToolDefinition } from '../types';

/** Apelidos comuns e suas chaves canônicas na memória */
const ALIAS_PATTERNS: Array<{ pattern: RegExp; canonical: string[] }> = [
  { pattern: /\b(minha\s+)?casa\b|home/i, canonical: ['casa', 'home', 'residencia', 'endereco_casa'] },
  { pattern: /\btrabalho\b|\bemprego\b|\bescrit[oó]rio\b|work/i, canonical: ['trabalho', 'work', 'escritorio', 'endereco_trabalho', 'trabalho_endereco'] },
  { pattern: /\bfaculdade\b|\buniversidade\b|\bescola\b/i, canonical: ['faculdade', 'universidade', 'escola'] },
  { pattern: /\bacademia\b|\bgin[aá]sio\b/i, canonical: ['academia', 'gym'] },
  { pattern: /\bm[aã]e\b|\bpais\b/i, canonical: ['casa_mae', 'casa_dos_pais', 'mae'] }
];

export const resolvePlaceAliasTool: ToolDefinition<{
  alias: string;
}, any> = {
  name: 'resolve_place_alias',
  description: 'Resolve apelidos geográficos do usuário ("minha casa", "trabalho", "academia", "faculdade") em endereços reais consultando a memória semântica. CHAME ESTA FERRAMENTA ANTES de open_gps_navigation/maps_search_places quando o destino for um apelido e não um endereço explícito. Se o endereço não estiver na memória, retorna instruções para pedir ao usuário e ensinar a LIORA.',
  category: 'system',
  riskLevel: 'R0',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      alias: { type: 'string', description: 'Apelido do local (ex: "casa", "trabalho", "minha mãe").' }
    },
    required: ['alias'],
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'resolved', 'simulated'] },
  execute: async ({ alias }) => {
    const clean = String(alias || '').trim();
    if (!clean) {
      return { success: false, resolved: false, error: 'MISSING_ALIAS: informe o apelido do local.', simulated: false, timestamp: new Date().toISOString() };
    }

    // Busca na memória semântica real do usuário
    let resolvedAddress: string | null = null;
    let matchedKey: string | null = null;

    try {
      const { useLioraStore } = await import('../../store/lioraStore');
      const { memoryEntries } = useLioraStore.getState();
      const norm = clean.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

      // 1. Correspondência por padrões conhecidos (casa/trabalho/etc.)
      const patterns = ALIAS_PATTERNS.filter(p => p.pattern.test(norm));
      for (const p of patterns) {
        for (const canonical of p.canonical) {
          const entry = memoryEntries.find(m =>
            m.key.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') === canonical
          );
          if (entry?.value) {
            resolvedAddress = entry.value;
            matchedKey = entry.key;
            break;
          }
        }
        if (resolvedAddress) break;
      }

      // 2. Busca abrangente para locais personalizados ilimitados (amigos, família, favoritos)
      if (!resolvedAddress) {
        // Tenta encontrar por chaves prefixadas como local_*, endereco_* ou chave direta
        const direct = memoryEntries.find(m => {
          const k = m.key.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/^local_|^endereco_/, '');
          return k === norm || norm.includes(k) || k.includes(norm);
        });
        if (direct?.value && direct.value.trim().length > 3) {
          resolvedAddress = direct.value.trim();
          matchedKey = direct.key;
        }
      }

      // 3. Busca por correspondência de palavras no conteúdo ou chave da memória
      if (!resolvedAddress) {
        const words = norm.split(/\s+/).filter(w => w.length > 2 && !['para', 'onde', 'minha', 'meu', 'casa', 'fica', 'rua', 'vou'].includes(w));
        if (words.length > 0) {
          const fuzzy = memoryEntries.find(m => {
            const k = m.key.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            return words.some(w => k.includes(w));
          });
          if (fuzzy?.value && /\d|rua|avenida|av\.|travessa|estrada|rodovia/i.test(fuzzy.value)) {
            resolvedAddress = fuzzy.value.trim();
            matchedKey = fuzzy.key;
          }
        }
      }
    } catch {
      // memória indisponível — segue como não resolvido
    }

    if (resolvedAddress) {
      return {
        success: true,
        resolved: true,
        alias: clean,
        matchedKey,
        address: resolvedAddress,
        message: `Local '${clean}' resolvido para '${resolvedAddress}' (da memória: ${matchedKey}). Use este endereço em open_gps_navigation.`,
        simulated: false,
        timestamp: new Date().toISOString()
      };
    }

    // Não resolvido: instrui o modelo a pedir e ensinar (para as próximas vezes)
    return {
      success: true,
      resolved: false,
      alias: clean,
      instruction: `PERGUNTE ao usuário: "Qual é o endereço completo do seu ${clean}?" — depois de obter a resposta, grave na memória chamando save_place_alias(alias: '${clean}', address: '...') para que as próximas navegações funcionem automaticamente.`,
      message: `Ainda não sei onde fica o seu '${clean}'. Peça o endereço ao usuário e salve com save_place_alias — na próxima vez a navegação será automática.`,
      simulated: false,
      timestamp: new Date().toISOString()
    };
  }
};

/**
 * Ferramenta oficial para cadastrar/salvar locais favoritos personalizados (R1)
 */
export const savePlaceAliasTool: ToolDefinition<{
  alias: string;
  address: string;
}, any> = {
  name: 'save_place_alias',
  description: 'Salva um local favorito ou apelido geográfico na memória permanente da LIORA (ex: "Casa do Amigo", "Minha Mãe", "Clube", "Escritório Novo"). Chame quando o usuário pedir para salvar, memorizar ou cadastrar um endereço ou local.',
  category: 'system',
  riskLevel: 'R1',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      alias: { type: 'string', description: 'Nome ou apelido do local (ex: "Casa do Amigo", "Trabalho", "Faculdade").' },
      address: { type: 'string', description: 'Endereço completo do local (ex: "Rua Quaresmeira 418, Ponta Grossa").' }
    },
    required: ['alias', 'address'],
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'alias', 'address', 'simulated'] },
  execute: async ({ alias, address }) => {
    const cleanAlias = String(alias || '').trim();
    const cleanAddress = String(address || '').trim();

    if (!cleanAlias || !cleanAddress) {
      return {
        success: false,
        error: 'MISSING_PARAMS: informe tanto o apelido (alias) quanto o endereço completo (address).',
        simulated: false,
        timestamp: new Date().toISOString()
      };
    }

    try {
      const { useLioraStore } = await import('../../store/lioraStore');
      const store = useLioraStore.getState();
      const normKey = cleanAlias.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9_]/g, '_');
      const memoryKey = `local_${normKey}`;

      store.addMemory({
        key: memoryKey,
        value: cleanAddress,
        category: 'preference',
        confidence: 1.0
      });

      return {
        success: true,
        alias: cleanAlias,
        address: cleanAddress,
        memoryKey,
        message: `Local favorito '${cleanAlias}' cadastrado com sucesso no endereço: ${cleanAddress}. Agora você pode dizer 'LIORA, navegue para ${cleanAlias}'.`,
        simulated: false,
        timestamp: new Date().toISOString()
      };
    } catch (err: any) {
      return {
        success: false,
        error: `Falha ao salvar local na memória: ${err?.message || 'erro desconhecido'}`,
        simulated: false,
        timestamp: new Date().toISOString()
      };
    }
  }
};


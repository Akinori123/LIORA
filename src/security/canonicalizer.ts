/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { sha256Sync } from '../utils/cryptoIsomorphic';

/**
 * Erro controlado lançado durante a canonicalização de parâmetros.
 * Não expõe segredos ou conteúdos sensíveis nas mensagens de erro.
 */
export class CanonicalizationError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'CanonicalizationError';
    this.code = code;
    Object.setPrototypeOf(this, CanonicalizationError.prototype);
  }
}

const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Valida descritores de propriedades e extrai chaves seguras sem invocar getters/setters.
 */
function inspectObjectPropertiesWithoutGetters(obj: object): string[] {
  // 1. Rejeição estrita de chaves Symbol
  const symbols = Object.getOwnPropertySymbols(obj);
  if (symbols.length > 0) {
    throw new CanonicalizationError(
      'CANONICALIZATION_FORBIDDEN_SYMBOL_KEY',
      'Chaves do tipo Symbol não são permitidas no subconjunto canônico.'
    );
  }

  // 2. Leitura dos descritores sem invocar getters
  const descriptors = Object.getOwnPropertyDescriptors(obj);
  const keys = Object.keys(descriptors);

  for (const key of keys) {
    // Rejeição de chaves perigosas de prototype pollution
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      throw new CanonicalizationError(
        'CANONICALIZATION_FORBIDDEN_KEY',
        `Chave de propriedade perigosa rejeitada: '${key}'.`
      );
    }

    const desc = descriptors[key];
    // Rejeição de propriedades acessoras (get/set) sem executar o getter
    if (desc.get !== undefined || desc.set !== undefined) {
      throw new CanonicalizationError(
        'CANONICALIZATION_ACCESSOR_PROPERTY',
        `Propriedade acessora (getter/setter) detectada na chave '${key}'. Acessores não são permitidos.`
      );
    }
  }

  return keys;
}

/**
 * Validação estrita de arrays para rejeitar arrays esparsos e propriedades adicionais.
 */
function validateArrayIntegrity(arr: unknown[]): void {
  // Rejeição de símbolos em arrays
  const symbols = Object.getOwnPropertySymbols(arr);
  if (symbols.length > 0) {
    throw new CanonicalizationError(
      'CANONICALIZATION_FORBIDDEN_SYMBOL_KEY',
      'Arrays não podem conter propriedades Symbol.'
    );
  }

  const descriptors = Object.getOwnPropertyDescriptors(arr);
  const propertyNames = Object.getOwnPropertyNames(arr);

  // Validação de propriedades adicionais além dos índices e 'length'
  for (const propName of propertyNames) {
    if (propName === 'length') continue;
    const indexNum = Number(propName);
    if (!Number.isInteger(indexNum) || indexNum < 0 || String(indexNum) !== propName || indexNum >= arr.length) {
      throw new CanonicalizationError(
        'CANONICALIZATION_ARRAY_EXTRA_PROPERTIES',
        `Propriedade não-indexada detectada em array: '${propName}'.`
      );
    }

    const desc = descriptors[propName];
    if (desc && (desc.get !== undefined || desc.set !== undefined)) {
      throw new CanonicalizationError(
        'CANONICALIZATION_ACCESSOR_PROPERTY',
        `Getter/setter detectado no índice '${propName}' do array.`
      );
    }
  }

  // Rejeição de arrays esparsos (buracos sem índice definido)
  for (let i = 0; i < arr.length; i++) {
    if (!(i in arr)) {
      throw new CanonicalizationError(
        'CANONICALIZATION_SPARSE_ARRAY',
        `Array esparso detectado no índice ${i}. Arrays devem ser contíguos e densos.`
      );
    }
  }
}

/**
 * Subconjunto Canônico Determinístico para Parâmetros de Ferramentas.
 * 
 * Regras do Contrato:
 * - Aceita estritamente: objetos simples planos, arrays densos, strings Unicode, números finitos, booleanos e null.
 * - Rejeita undefined em qualquer posição (inclusive dentro de objetos e arrays).
 * - Rejeita referências circulares (diferenciando de referências compartilhadas em DAG).
 * - Rejeita instâncias de classes e objetos com protótipos que não sejam Object.prototype ou null.
 * - Rejeita propriedades perigosas (__proto__, constructor, prototype).
 * - Rejeita propriedades Symbol e propriedades acessoras (getters/setters sem dispará-los).
 * - Rejeita NaN, Infinity, -Infinity, BigInt, funções e símbolos.
 * - Rejeita arrays esparsos ou com propriedades não-numéricas.
 * - Ordenação determinística de chaves por unidades de código UTF-16 (ordem lexicográfica padrão).
 * - Formatação compacta sem espaçamento.
 */
export function canonicalizeDeterministicSubset(
  value: unknown,
  activeAncestors: Set<object> = new Set()
): string {
  // 1. Rejeição incondicional de undefined
  if (value === undefined) {
    throw new CanonicalizationError(
      'CANONICALIZATION_REJECTED_UNDEFINED',
      'Valores undefined são estritamente proibidos no subconjunto canônico.'
    );
  }

  // 2. Literais primitivos simples
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  // 3. Validação numérica rigorosa
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError(
        'CANONICALIZATION_INVALID_NUMBER',
        `Número não finito rejeitado (${value}). Apenas números finitos são permitidos.`
      );
    }
    // Formatação canônica: -0 vira 0
    if (Object.is(value, -0)) {
      return '0';
    }
    return JSON.stringify(value);
  }

  // 4. Strings Unicode
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  // 5. Rejeição de tipos especiais primitivos
  if (typeof value === 'bigint') {
    throw new CanonicalizationError(
      'CANONICALIZATION_UNSUPPORTED_TYPE',
      'Tipo BigInt não é suportado em parâmetros JSON.'
    );
  }

  if (typeof value === 'symbol') {
    throw new CanonicalizationError(
      'CANONICALIZATION_UNSUPPORTED_TYPE',
      'Valores Symbol não são permitidos em parâmetros canônicos.'
    );
  }

  if (typeof value === 'function') {
    throw new CanonicalizationError(
      'CANONICALIZATION_UNSUPPORTED_TYPE',
      'Funções executáveis são estritamente proibidas em parâmetros de ferramentas.'
    );
  }

  // 6. Estruturas compostas (Array e Objeto)
  if (typeof value === 'object') {
    // Detecção de referências circulares pelo caminho ativo de ancestrais
    if (activeAncestors.has(value)) {
      throw new CanonicalizationError(
        'CANONICALIZATION_CIRCULAR_REFERENCE',
        'Estrutura com referência circular detectada. Ciclos não são permitidos.'
      );
    }

    // Tratamento de Arrays
    if (Array.isArray(value)) {
      validateArrayIntegrity(value);

      activeAncestors.add(value);
      try {
        const elements: string[] = [];
        for (let i = 0; i < value.length; i++) {
          elements.push(canonicalizeDeterministicSubset(value[i], activeAncestors));
        }
        return `[${elements.join(',')}]`;
      } finally {
        activeAncestors.delete(value);
      }
    }

    // Tratamento de Objetos Planos
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalizationError(
        'CANONICALIZATION_NON_PLAIN_OBJECT',
        'Apenas objetos literais planos ({}) com protótipo Object.prototype ou null são permitidos.'
      );
    }

    // Inspeção segura de descritores sem invocar getters
    const keys = inspectObjectPropertiesWithoutGetters(value);

    // Ordenação determinística das chaves por unidades de código UTF-16
    keys.sort();

    activeAncestors.add(value);
    try {
      const pairs: string[] = [];
      const record = value as Record<string, unknown>;

      for (const key of keys) {
        const propVal = record[key];
        if (propVal === undefined) {
          throw new CanonicalizationError(
            'CANONICALIZATION_REJECTED_UNDEFINED',
            `Propriedade '${key}' possui valor undefined. Undefined é estritamente proibido.`
          );
        }
        const valStr = canonicalizeDeterministicSubset(propVal, activeAncestors);
        pairs.push(`${JSON.stringify(key)}:${valStr}`);
      }

      return `{${pairs.join(',')}}`;
    } finally {
      activeAncestors.delete(value);
    }
  }

  throw new CanonicalizationError(
    'CANONICALIZATION_UNSUPPORTED_TYPE',
    `Tipo não suportado: '${typeof value}'.`
  );
}

/**
 * Calcula o hash criptográfico SHA-256 do payload canônico determinístico.
 */
export function computeParametersHash(params: unknown): string {
  const canonicalString = canonicalizeDeterministicSubset(params);
  return sha256Sync(canonicalString);
}

/**
 * Congela recursivamente um objeto para garantir que os parâmetros validados
 * não sofram mutação entre a decisão de segurança e a execução.
 */
export function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  Object.freeze(obj);

  for (const key of Object.keys(obj)) {
    const prop = (obj as Record<string, unknown>)[key];
    if (prop !== null && typeof prop === 'object' && !Object.isFrozen(prop)) {
      deepFreeze(prop);
    }
  }

  return obj as Readonly<T>;
}

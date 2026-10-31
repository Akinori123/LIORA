/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolParametersSchema, ToolOutputSchema } from './types';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  sanitized?: Record<string, any>;
}

// Patterns for detecting path traversal, Windows drive letters, UNC paths, and null bytes
const PATH_TRAVERSAL_PATTERN = /(\.\.[\/\\]|^\/|^[a-zA-Z]:[\/\\]|^\\\\|\0)/;

// Patterns for dangerous / destructive commands in simulated shell
const DANGEROUS_COMMANDS = [
  /\brm\b.*(-[a-zA-Z]*r[a-zA-Z]*|-R|--recursive)/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bformat\s+[a-zA-Z]:/i,
  /\b(shutdown|reboot|poweroff|init\s+0)\b/i,
  /\bchmod\s+(-R\s+777|777\s+-R)\b/i,
  /\b(sudo\s+su|sudo\s+-i|passwd|userdel|groupdel)\b/i,
  />\s*\/dev\/(sd[a-z]|nvme|sda)/i
];

const SUPPORTED_TYPES = ['string', 'number', 'boolean', 'array', 'object'];

/**
 * Validates parameters against a ToolParametersSchema with strict security constraints.
 */
export function validateToolParameters(
  schema: ToolParametersSchema,
  params: any
): ValidationResult {
  const errors: string[] = [];

  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return {
      valid: false,
      errors: ['Parâmetros devem ser um objeto JSON válido.']
    };
  }

  const sanitized: Record<string, any> = {};
  const schemaProps = schema.properties || {};
  const requiredKeys = schema.required || [];

  // Check required keys
  for (const reqKey of requiredKeys) {
    if (params[reqKey] === undefined || params[reqKey] === null) {
      errors.push(`Campo obrigatório ausente: '${reqKey}'.`);
    }
  }

  // Check for unexpected extra properties if additionalProperties is false
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(params)) {
      if (!schemaProps[key]) {
        errors.push(`Propriedade não permitida pelo esquema: '${key}'.`);
      }
    }
  }

  // Validate each provided field according to its specification
  for (const [key, prop] of Object.entries(schemaProps)) {
    let val = params[key];

    // Check unsupported property types
    if (!SUPPORTED_TYPES.includes(prop.type)) {
      errors.push(`Tipo de esquema não suportado para campo '${key}': '${prop.type}'.`);
      continue;
    }

    // Use default if value is undefined
    if (val === undefined && prop.default !== undefined) {
      val = prop.default;
    }

    if (val === undefined) {
      continue;
    }

    switch (prop.type) {
      case 'string': {
        if (typeof val !== 'string') {
          errors.push(`Campo '${key}' deve ser do tipo string.`);
          break;
        }

        const trimmed = val.trim();

        if (prop.minLength !== undefined && trimmed.length < prop.minLength) {
          errors.push(`Campo '${key}' deve ter no mínimo ${prop.minLength} caracteres.`);
        }
        if (prop.maxLength !== undefined && trimmed.length > prop.maxLength) {
          errors.push(`Campo '${key}' excede o comprimento máximo de ${prop.maxLength} caracteres.`);
        }
        if (prop.enum && !prop.enum.includes(trimmed)) {
          errors.push(`Campo '${key}' deve ser um dos valores: [${prop.enum.join(', ')}]. Recebido: '${trimmed}'.`);
        }

        // Special security checks for path-like parameters
        if (key.toLowerCase().includes('path') || key.toLowerCase().includes('file')) {
          if (PATH_TRAVERSAL_PATTERN.test(trimmed)) {
            errors.push(`Tentativa de path traversal ou acesso absoluto não autorizado no campo '${key}': '${trimmed}'.`);
          }
        }

        // Special security checks for command-like parameters
        if (key.toLowerCase().includes('command') || key.toLowerCase().includes('cmd')) {
          for (const dangPattern of DANGEROUS_COMMANDS) {
            if (dangPattern.test(trimmed)) {
              errors.push(`Comando com potencial destrutivo bloqueado pela política de segurança R1: '${trimmed}'.`);
              break;
            }
          }
        }

        sanitized[key] = trimmed;
        break;
      }

      case 'number': {
        if (typeof val !== 'number' || isNaN(val)) {
          errors.push(`Campo '${key}' deve ser um número válido.`);
          break;
        }
        if (prop.minimum !== undefined && val < prop.minimum) {
          errors.push(`Campo '${key}' deve ser maior ou igual a ${prop.minimum}.`);
        }
        if (prop.maximum !== undefined && val > prop.maximum) {
          errors.push(`Campo '${key}' deve ser menor ou igual a ${prop.maximum}.`);
        }
        sanitized[key] = val;
        break;
      }

      case 'boolean': {
        if (typeof val !== 'boolean') {
          errors.push(`Campo '${key}' deve ser booleano.`);
          break;
        }
        sanitized[key] = val;
        break;
      }

      case 'array': {
        if (!Array.isArray(val)) {
          errors.push(`Campo '${key}' deve ser um array.`);
          break;
        }
        sanitized[key] = val;
        break;
      }

      case 'object': {
        if (typeof val !== 'object' || val === null || Array.isArray(val)) {
          errors.push(`Campo '${key}' deve ser um objeto JSON.`);
          break;
        }
        sanitized[key] = val;
        break;
      }

      default:
        sanitized[key] = val;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitized: errors.length === 0 ? sanitized : undefined
  };
}

/**
 * Validates tool execution output against contract.
 */
export function validateToolOutput(
  data: any, 
  outputSchema?: ToolOutputSchema
): { valid: boolean; error?: string } {
  if (data === undefined || data === null) {
    return { valid: false, error: 'A ferramenta retornou saída nula ou indefinida.' };
  }
  if (typeof data !== 'object') {
    return { valid: false, error: 'A ferramenta deve retornar um objeto estruturado.' };
  }
  if (outputSchema?.mustBeSimulated !== false && data.simulated !== true) {
    return { valid: false, error: 'A ferramenta simulada violou o contrato de simulação (simulated deve ser true).' };
  }
  if (outputSchema?.requiredFields) {
    for (const field of outputSchema.requiredFields) {
      if (data[field] === undefined) {
        return { valid: false, error: `Saída da ferramenta ausente do campo obrigatório '${field}'.` };
      }
    }
  }
  return { valid: true };
}

/**
 * Sanitizes error messages by stripping server filesystem paths and stack trace details.
 */
export function sanitizeErrorMessage(error: any): string {
  let msg = typeof error === 'string' ? error : error?.message || 'Erro interno na execução da ferramenta.';
  // Strip absolute server paths (Unix / Windows / Container)
  msg = msg.replace(/\/(app|var|usr|etc|root|home|proc|sys|tmp|opt)\/[^\s:;,"']+/g, '[CAMINHO_RESTRITO]');
  msg = msg.replace(/[a-zA-Z]:\\[^\s:;,"']+/g, '[CAMINHO_RESTRITO]');
  // Strip stack trace lines or file positions
  msg = msg.split('\n')[0].trim();
  // Strip API key patterns if any
  msg = msg.replace(/AIza[0-9A-Za-z-_]{35}/g, '[CHAVE_RESTRITA]');
  return msg;
}

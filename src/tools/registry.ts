/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { 
  ToolDefinition, 
  ToolSummary, 
  ToolExecutionResult, 
  ToolExecutionContext 
} from './types';
import { 
  validateToolParameters, 
  validateToolOutput, 
  sanitizeErrorMessage, 
  ValidationResult 
} from './validator';
import { verifierEngine } from './verifier';
import { 
  systemInfoTool, 
  workspaceReadFileTool, 
  systemExecSimulatedTool,
  workspaceWriteFileTool,
  systemExecSandboxTool,
  systemReadEnvSafeTool,
  navigateToTabTool,
  openSettingsTool,
  triggerAutomationTool,
  getSystemStatusTool
} from './simulatedTools';
// CORREÇÃO 2: tools de navegação/mapas existiam mas NUNCA foram registradas —
// o modelo (chat e Live) nunca as recebia, e pedia "mercado mais próximo" falhava.
import { openGpsNavigationTool, mapsSearchPlacesTool } from './navigation/navigationActionTool';
import { resolvePlaceAliasTool, savePlaceAliasTool } from './navigation/placeAliasTool';

export const DEFAULT_TOOL_TIMEOUT_MS = 5000;

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  constructor() {
    this.registerDefaultTools();
  }

  /**
   * Registra as ferramentas simuladas padrão da LIORA
   */
  private registerDefaultTools(): void {
    this.registerTool(systemInfoTool);
    this.registerTool(workspaceReadFileTool);
    this.registerTool(systemExecSimulatedTool);
    this.registerTool(workspaceWriteFileTool);
    this.registerTool(systemExecSandboxTool);
    this.registerTool(systemReadEnvSafeTool);
    this.registerTool(navigateToTabTool);
    this.registerTool(openSettingsTool);
    this.registerTool(triggerAutomationTool);
    this.registerTool(getSystemStatusTool);
    // CORREÇÃO 2: navegação e busca de locais agora declaradas ao modelo
    this.registerTool(openGpsNavigationTool);
    this.registerTool(mapsSearchPlacesTool);
    this.registerTool(resolvePlaceAliasTool);
    this.registerTool(savePlaceAliasTool);
  }

  /**
   * Registra uma nova ferramenta no registro central.
   * Rejeita identificadores duplicados por padrão para evitar sobrescrita silenciosa.
   */
  public registerTool(tool: ToolDefinition): void {
    if (!tool.name || typeof tool.name !== 'string') {
      throw new Error('Nome da ferramenta inválido ou não fornecido.');
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Ferramenta com identificador '${tool.name}' já está registrada no Tool Registry.`);
    }
    if (!tool.parameters || typeof tool.parameters !== 'object') {
      throw new Error(`Esquema de parâmetros inválido para ferramenta '${tool.name}'.`);
    }
    if (typeof tool.execute !== 'function') {
      throw new Error(`Função execute ausente na ferramenta '${tool.name}'.`);
    }

    this.tools.set(tool.name, tool);
  }

  /**
   * Remove uma ferramenta do registro
   */
  public unregisterTool(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Obtém a definição de uma ferramenta com cópia defensiva para evitar mutação externa de metadados
   */
  public getTool(name: string): ToolDefinition | undefined {
    const tool = this.tools.get(name);
    if (!tool) return undefined;
    return {
      ...tool,
      parameters: JSON.parse(JSON.stringify(tool.parameters)),
      outputSchema: tool.outputSchema ? JSON.parse(JSON.stringify(tool.outputSchema)) : undefined
    };
  }

  /**
   * Verifica se uma ferramenta existe
   */
  public hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Retorna resumo de todas as ferramentas disponíveis com cópias defensivas dos esquemas
   */
  public listTools(): ToolSummary[] {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      category: tool.category,
      riskLevel: tool.riskLevel,
      isSimulated: tool.isSimulated,
      parameters: JSON.parse(JSON.stringify(tool.parameters))
    }));
  }

  /**
   * Valida parâmetros brutos para uma ferramenta específica
   */
  public validate(toolName: string, rawParams: any): ValidationResult {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        valid: false,
        errors: [`Ferramenta '${toolName}' não registrada.`]
      };
    }

    return validateToolParameters(tool.parameters, rawParams);
  }

  /**
   * Executa uma ferramenta com validação estrita, timeout de espera, validação de saída e sanitização
   */
  public async executeTool(
    toolName: string, 
    rawParams: any = {}, 
    context?: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const start = performance.now();
    const timestamp = new Date().toISOString();

    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        toolName,
        success: false,
        error: `Ferramenta '${toolName}' não registrada no Tool Registry.`,
        simulated: true,
        riskLevel: 'R0',
        executionTimeMs: Math.round(performance.now() - start),
        timestamp
      };
    }

    // Validação estrita de parâmetros de entrada
    const validation = validateToolParameters(tool.parameters, rawParams);
    if (!validation.valid) {
      return {
        toolName,
        success: false,
        error: `Parâmetros inválidos para '${toolName}': ${validation.errors.join(' ')}`,
        simulated: true,
        riskLevel: tool.riskLevel,
        executionTimeMs: Math.round(performance.now() - start),
        timestamp
      };
    }

    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Tempo limite de execução excedido (${DEFAULT_TOOL_TIMEOUT_MS}ms).`));
      }, DEFAULT_TOOL_TIMEOUT_MS);
    });

    try {
      const sanitizedParams = validation.sanitized || rawParams;
      const executionPromise = tool.execute(sanitizedParams, context);
      const data = await Promise.race([executionPromise, timeoutPromise]);
      if (timer) clearTimeout(timer);

      // Validação estrita do contrato de saída
      const outputVal = validateToolOutput(data, tool.outputSchema);
      if (!outputVal.valid) {
        return {
          toolName,
          success: false,
          error: `Violação do contrato de saída para '${toolName}': ${outputVal.error}`,
          simulated: true,
          riskLevel: tool.riskLevel,
          executionTimeMs: Math.round(performance.now() - start),
          timestamp
        };
      }

      // Auditoria pós-execução via Verifier Engine (Item 17 do Plano Mestre)
      const verification = await verifierEngine.verifyExecution(toolName, sanitizedParams, data);
      if (!verification.passed) {
        return {
          toolName,
          success: false,
          error: verification.error || `Falha na verificação pós-execução para '${toolName}'.`,
          simulated: true,
          riskLevel: tool.riskLevel,
          executionTimeMs: Math.round(performance.now() - start),
          timestamp,
          verification: verification.evidence
        };
      }

      const executionTimeMs = Math.round(performance.now() - start);
      return {
        toolName,
        success: true,
        data,
        simulated: Boolean(data?.simulated ?? tool.isSimulated),
        riskLevel: tool.riskLevel,
        executionTimeMs,
        timestamp,
        verification: verification.evidence
      };
    } catch (err: any) {
      if (timer) clearTimeout(timer);
      const executionTimeMs = Math.round(performance.now() - start);
      const cleanError = sanitizeErrorMessage(err);
      return {
        toolName,
        success: false,
        error: cleanError,
        simulated: true,
        riskLevel: tool.riskLevel,
        executionTimeMs,
        timestamp
      };
    }
  }

  /**
   * Converte ferramentas registradas para o formato FunctionDeclaration do Gemini API (apenas metadados)
   */
  /**
   * Converte uma propriedade do schema para o formato aceito pela API do Gemini.
   * IMPORTANTE: o Gemini EXIGE que toda propriedade do tipo ARRAY declare o campo
   * `items` (com o schema do elemento). Sem isso, a API retorna INVALID_ARGUMENT
   * ("...properties[keys].items: missing field").
   */
  private static toGeminiProperty(prop: any): Record<string, any> {
    const out: Record<string, any> = {
      type: prop.type.toUpperCase(),
      description: prop.description,
      ...(prop.enum ? { enum: prop.enum } : {})
    };

    if (prop.type === 'array' && prop.items) {
      // Preserva os items do array, convertendo recursivamente (arrays de arrays, etc.)
      const items = { ...prop.items } as any;
      if (items.type) items.type = String(items.type).toUpperCase();
      if (items.type === 'ARRAY' && Array.isArray(items.items)) {
        items.items = items.items.map((sub: any) => ToolRegistry.toGeminiProperty(sub));
      } else if (items.type === 'OBJECT' && items.properties) {
        items.properties = Object.fromEntries(
          Object.entries(items.properties).map(([k, v]) => [k, ToolRegistry.toGeminiProperty(v)])
        );
      }
      out.items = items;
    }

    return out;
  }

  public toGeminiDeclarations(): Array<{ name: string; description: string; parameters: any }> {
    return Array.from(this.tools.values()).map(tool => {
      const geminiProps: Record<string, any> = {};
      const requiredProps: string[] = tool.parameters.required || [];

      for (const [key, prop] of Object.entries(tool.parameters.properties)) {
        geminiProps[key] = ToolRegistry.toGeminiProperty(prop);
      }

      return {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'OBJECT',
          properties: geminiProps,
          required: requiredProps
        }
      };
    });
  }
}

// Instância singleton central do Tool Registry para o backend da LIORA
export const toolRegistry = new ToolRegistry();

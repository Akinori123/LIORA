/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type ToolRiskLevel = 'R0' | 'R1' | 'R2' | 'R3';

export type ToolCategory = 'system' | 'workspace' | 'utility' | 'network' | 'automation' | 'mcp' | 'browser';

export interface ToolParameterProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: string[];
  required?: boolean;
  default?: any;
  items?: { type: string; properties?: Record<string, any>; required?: string[] };
  properties?: Record<string, any>;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

export interface ToolParametersSchema {
  type: 'object';
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolExecutionContext {
  callerId?: string;
  sessionId?: string;
  allowedWorkspaceRoot?: string;
  timestamp?: string;
}

import type { VerificationEvidence } from './verifier';

export interface ToolExecutionResult<TData = any> {
  toolName: string;
  success: boolean;
  data?: TData;
  error?: string;
  simulated: boolean;
  riskLevel: ToolRiskLevel;
  executionTimeMs: number;
  timestamp: string;
  verification?: VerificationEvidence;
}

export interface ToolOutputSchema {
  type: 'object';
  requiredFields?: string[];
  mustBeSimulated?: boolean;
}

export interface ToolDefinition<TParams = any, TResult = any> {
  name: string;
  description: string;
  category: ToolCategory;
  riskLevel: ToolRiskLevel;
  isSimulated: boolean;
  parameters: ToolParametersSchema;
  outputSchema?: ToolOutputSchema;
  execute: (params: TParams, context?: ToolExecutionContext) => Promise<TResult>;
}

export interface ToolSummary {
  name: string;
  description: string;
  category: ToolCategory;
  riskLevel: ToolRiskLevel;
  isSimulated: boolean;
  parameters: ToolParametersSchema;
}

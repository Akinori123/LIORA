export type OrbState = 
  | 'OFF' 
  | 'OFFLINE' 
  | 'IDLE' 
  | 'CONNECTING' 
  | 'LISTENING' 
  | 'TRANSCRIBING' 
  | 'THINKING' 
  | 'SPEAKING' 
  | 'EXECUTING' 
  | 'DOWNLOADING' 
  | 'PAUSED' 
  | 'SUCCESS' 
  | 'WARNING' 
  | 'ERROR' 
  | 'CANCELLED';

export type NavTab = 
  | 'home' 
  | 'conversation' 
  | 'activity' 
  | 'memory' 
  | 'devices' 
  | 'automations' 
  | 'developer' 
  | 'integrations' 
  | 'settings'
  | 'cockpit';

export type ConversationSubTab = 'text' | 'voice' | 'transcription' | 'history';

export interface ChatMessage {
  id: string;
  sender: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: string;
  status?: 'sending' | 'streaming' | 'completed' | 'error' | 'cancelled';
  modelUsed?: string;
  toolsCalled?: string[];
  tokens?: number;
  errorMessage?: string;
  errorCode?: 'AUTH_ERROR' | 'QUOTA_ERROR' | 'UNAVAILABLE' | 'NETWORK_ERROR' | 'CANCELLED' | 'UNKNOWN';
  source?: 'text' | 'voice';
  createdAt?: string;
  sessionId?: string;
}

export interface TranscriptionEvent {
  id: string;
  sessionId: string;
  speaker: 'user' | 'assistant' | 'system';
  speakerLabel: string;
  text: string;
  timestamp: string; // HH:MM:SS
  status: 'sending' | 'streaming' | 'completed' | 'error' | 'cancelled';
  source: 'text' | 'voice';
  isPartial: boolean;
  errorMessage?: string;
  errorCode?: string;
}

export interface ConversationSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface TaskStep {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  toolName?: string;
  durationMs?: number;
}

export interface TaskPlan {
  id: string;
  goal: string;
  steps: TaskStep[];
  status: 'planning' | 'running' | 'paused' | 'success' | 'error';
  riskLevel: 'R0' | 'R1' | 'R2' | 'R3';
  createdAt: string;
}

export interface DeviceItem {
  id: string;
  name: string;
  type: 'pc' | 'android' | 'tv' | 'smarthome' | 'printer' | 'car' | 'sensor';
  connected: boolean;
  battery?: number;
  lastSeen: string;
  ip?: string;
}

export interface MemoryEntry {
  id: string;
  category: 'preference' | 'project' | 'fact' | 'routine' | 'journal';
  key: string;
  value: string;
  confidence: number;
  updatedAt: string;
}

export interface CredentialItem {
  id: string;
  provider: 'gemini' | 'openrouter' | 'github' | 'homeassistant' | 'custom';
  label: string;
  maskedKey: string;
  status: 'valid' | 'invalid' | 'untested';
  models: string[];
}

export interface ActivityLogItem {
  id: string;
  timestamp: string;
  category: 'tool' | 'system' | 'security' | 'ai' | 'voice';
  summary: string;
  details: string;
  riskLevel: 'R0' | 'R1' | 'R2' | 'R3';
  status: 'success' | 'warning' | 'error';
  simulated: boolean;
  verified?: boolean;
  verificationDetails?: string;
}

export type {
  ToolRiskLevel,
  ToolCategory,
  ToolParameterProperty,
  ToolParametersSchema,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolDefinition,
  ToolSummary
} from './tools/types';


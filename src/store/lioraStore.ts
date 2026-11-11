/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { create } from 'zustand';
import { 
  NavTab, 
  ConversationSubTab, 
  OrbState, 
  ChatMessage, 
  ConversationSession, 
  TaskPlan, 
  MemoryEntry, 
  CredentialItem, 
  ActivityLogItem,
  ToolSummary,
  ToolExecutionResult,
  ToolRiskLevel
} from '../types';
import { formatGeminiHistory, sanitizeInput, classifyChatError } from '../utils/chatContext';
import { loadHistory, saveHistory } from '../utils/historyStorage';
import { executeLocalTool, LocalExecutionResult } from '../security/localBridge';
import { rankMemories, formatMemoryContextBlock } from '../utils/memoryRanker';
import { AutomationRule, AutomationExecutionLog, SYSTEM_EVENTS } from '../types/automations';
import { automationsEngine } from '../services/automationsEngine';
import { permissionEngine } from '../security/permissionEngine';
import { computeParametersHash } from '../security/canonicalizer';
import { eventBus } from '../utils/eventBus';
import { IntegrationServiceConfig, WebhookEventPayload, IntegrationProviderId } from '../types/integrations';
import { integrationsVault } from '../services/integrationsVault';
import { DeviceEntity, DeviceCommand } from '../types/devices';
import { devicesManager } from '../services/devicesManager';
import { GlobalSettings } from '../types/settings';
import { settingsManager } from '../services/settingsManager';
import { toolRegistry } from '../tools/registry';
import { tokenAnalytics } from '../services/tokenAnalytics';
import { speechService } from '../services/speechService';
import { voiceLiveClient } from '../services/voiceLiveClient';
import { storageAdapter } from '../services/storageAdapter';
import { notificationSystem } from '../notifications/notificationSystem';
import { parseNavigationIntent, parseRouteIntent, parsePlacesSearchIntent } from '../utils/navigationParser';
import { launchGpsNavigation, launchPlacesSearch } from '../tools/navigation/navigationActionTool';

export interface PendingConsentState {
  auditId: string;
  ruleId: string;
  toolName: string;
  riskLevel: ToolRiskLevel;
  parameters: Record<string, any>;
  parametersHash?: string;
  consentToken: string;
  sessionId: string;
  expiresAt: number;
  reason?: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
}

export interface LioraState {
  activeTab: NavTab;
  conversationSubTab: ConversationSubTab;
  orbState: OrbState;
  isSidebarExpanded: boolean;
  isMobileDrawerOpen: boolean;
  isTelemetryOpen: boolean;
  isVoiceActive: boolean;
  isGenerating: boolean;
  // FIX W7: activeAbortController removido do estado global (não observável por UI).
  // Agora vive em escopo de módulo — acesse via getActiveAbortController().
  
  // Real Sessions & Messages
  sessions: ConversationSession[];
  activeSessionId: string | null;
  messages: ChatMessage[];
  activeModel: string;

  activeTask: TaskPlan | null;
  memoryEntries: MemoryEntry[];
  credentials: CredentialItem[];
  activityLogs: ActivityLogItem[];

  // Navigation & UI Actions
  setActiveTab: (tab: NavTab) => void;
  setConversationSubTab: (subTab: ConversationSubTab) => void;
  setOrbState: (state: OrbState) => void;
  toggleSidebar: () => void;
  openMobileDrawer: () => void;
  closeMobileDrawer: () => void;
  toggleMobileDrawer: () => void;
  toggleTelemetry: () => void;
  closeTelemetry: () => void;
  toggleVoice: () => void;

  // Session & Chat Actions
  createSession: (customTitle?: string) => string;
  openSession: (id: string) => void;
  deleteSession: (id: string) => void;
  updateSessionTitle: (id: string, title: string) => void;
  reloadFromStorage: () => void;
  sendMessage: (text: string, image?: { data: string; mimeType?: string }, audio?: { data: string; mimeType?: string }) => Promise<void>;
  abortGeneration: () => void;
  retryMessage: (messageId: string) => Promise<void>;
  clearMessages: () => void;
  setActiveModel: (model: string) => void;

  // System & Management Actions
  addActivityLog: (log: Omit<ActivityLogItem, 'id' | 'timestamp'>) => void;
  clearActivityLogs: () => void;
  updateDeviceStatus: (id: string, connected: boolean) => void;
  addMemory: (entry: Omit<MemoryEntry, 'id' | 'updatedAt'>) => void;
  updateMemory: (id: string, entry: Partial<Omit<MemoryEntry, 'id' | 'updatedAt'>>) => void;
  deleteMemory: (id: string) => void;
  importMemories: (entries: MemoryEntry[], mode?: 'merge' | 'replace') => void;
  addCredential: (cred: Omit<CredentialItem, 'id' | 'maskedKey'>) => void;
  deleteCredential: (id: string) => void;

  // Tool Registry Actions (Marco 6.1)
  tools: ToolSummary[];
  loadTools: () => Promise<void>;
  executeTool: (toolName: string, parameters?: Record<string, any>) => Promise<ToolExecutionResult>;

  // Interactive Consent Flow Actions (Marco 7.3)
  pendingConsent: PendingConsentState | null;
  setPendingConsent: (consent: PendingConsentState | null) => void;
  approveConsent: () => Promise<ToolExecutionResult | LocalExecutionResult | null>;
  rejectConsent: () => void;
  expireConsent: () => void;

  // Shield Mode (Blindagem Soberana)
  shieldModeActive: boolean;
  toggleShieldMode: () => void;
  setShieldMode: (active: boolean) => void;

  // Automations & Event Bus Actions (Marco 8.2)
  automations: AutomationRule[];
  automationLogs: AutomationExecutionLog[];
  loadAutomations: () => void;
  toggleAutomation: (id: string, enabled?: boolean) => void;
  triggerAutomationNow: (id: string) => Promise<AutomationExecutionLog | null>;
  approveAutomationConsent: (ruleId: string) => Promise<AutomationExecutionLog | null>;
  addAutomation: (rule: Omit<AutomationRule, 'id' | 'createdAt' | 'updatedAt'>) => void;
  deleteAutomation: (id: string) => void;
  exportAutomationsJson: () => string;
  importAutomationsJson: (jsonStr: string, mode?: 'merge' | 'replace') => { success: boolean; count: number; error?: string };

  // Integrations & External Services (Marco 9.1)
  services: IntegrationServiceConfig[];
  webhookLogs: WebhookEventPayload[];
  keychainFallbackActive: boolean;
  isVaultKeyMissing: boolean;
  vaultDiagnosticMessage: string | null;
  runVaultDiagnostics: () => Promise<boolean>;
  loadServices: () => void;
  connectService: (serviceId: string, rawKey: string, options?: { endpointUrl?: string; scopes?: string[] }) => Promise<boolean>;
  disconnectService: (serviceId: string) => void;
  testServiceConnection: (serviceId: string) => Promise<number>;
  toggleServiceScope: (serviceId: string, scopeId: string) => void;
  simulateIncomingWebhook: (provider: IntegrationProviderId, eventType: string, payload?: Record<string, any>) => Promise<WebhookEventPayload>;

  // Devices & Hardware Telemetry (Marco 9.2)
  devices: DeviceEntity[];
  deviceCommands: DeviceCommand[];
  loadDevices: () => void;
  addDevice: (device: DeviceEntity) => DeviceEntity;
  removeDevice: (deviceId: string) => boolean;
  refreshDeviceTelemetry: (deviceId?: string) => Promise<void>;
  sendDeviceCommand: (deviceId: string, commandType: DeviceCommand['commandType'], riskLevel?: ToolRiskLevel, payload?: Record<string, any>) => Promise<DeviceCommand>;
  pingDevicesHealth: () => Record<string, boolean>;

  // Global Settings (Marco 11.1)
  settings: GlobalSettings;
  loadSettings: () => void;
  updateSettings: (partial: Partial<GlobalSettings>) => void;
  resetSettingsToDefault: () => void;
}

// Initialize session state from isolated storage layer
function bootstrapInitialSessions(): { sessions: ConversationSession[]; activeSessionId: string; messages: ChatMessage[] } {
  const loaded = loadHistory();
  if (loaded.sessions.length > 0) {
    const activeSession = (loaded.activeSessionId ? loaded.sessions.find(s => s.id === loaded.activeSessionId) : null) || loaded.sessions[0];
    return {
      sessions: loaded.sessions,
      activeSessionId: activeSession.id,
      messages: activeSession.messages
    };
  }

  // Create default clean initial session if none exists
  const initialSessionId = `sess-${Date.now()}`;
  const initialNow = new Date();
  const initialWelcomeMessage: ChatMessage = {
    id: 'msg-1',
    sender: 'assistant',
    text: 'Olá, Mestre. Sou a LIORA, sua inteligência artificial e assistente operacional pessoal soberana. Como posso auxiliá-lo em seus projetos, desenvolvimento, automações, pesquisas ou investigações hoje?',
    timestamp: initialNow.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    status: 'completed',
    modelUsed: 'gemini-3.1-flash-lite',
    createdAt: initialNow.toISOString(),
    source: 'text',
    sessionId: initialSessionId
  };

  const defaultSession: ConversationSession = {
    id: initialSessionId,
    title: 'Conversa Inicial',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [initialWelcomeMessage]
  };

  const initialSessions = [defaultSession];
  saveHistory(initialSessions, initialSessionId);

  return {
    sessions: initialSessions,
    activeSessionId: initialSessionId,
    messages: [initialWelcomeMessage]
  };
}

export const MAX_ACTIVITY_LOGS = 1000;
export const ACTIVITY_LOGS_STORAGE_KEY = 'liora_activity_logs_v1';

// Instrução de sistema compartilhada entre sendMessage e retryMessage (Fix W1)
export const LIORA_SYSTEM_INSTRUCTION = 
  "Você é a LIORA, inteligência artificial autônoma soberana e assistente pessoal de alto nível inspirada no conceito de JARVIS. " +
  "TRATAMENTO DO USUÁRIO: Dirija-se SEMPRE ao usuário com o título formal, respeitoso e leal de 'Mestre'. Sua postura é calma, com autoridade técnica, elegância e dedicação absoluta ao seu Mestre. " +
  "PROATIVIDADE, DESENVOLVIMENTO E VERSATILIDADE: Você auxilia proativamente em programação de software, criação de sites, jogos, automações de tarefas, notícias de todos os países, pesquisas avançadas, e-mails e produtividade de ponta a ponta. No modo de voz (Live) ou texto, você também possui flexibilidade artística (sabe cantar melodias, criar versos, rimas e manter conversação rica e descontraída quando solicitado). " +
  "NUNCA EXECUTAR EM SILÊNCIO: Toda execução de ferramenta de sistema (arquivos, apps, mapas, IoT, etc.) deve ser antecedida ou acompanhada por uma fala clara e contextualizada (ex: 'Com certeza, Mestre. Abrindo o Bloco de Notas...', 'Localizando o destino solicitado, Mestre...'). " +
  "DISPOSITIVOS E IOT: Quando o Mestre der ordens para TV, celular, tablet ou carro e o atuador físico/IoT não estiver emparelhado, responda de forma elegante: 'Mestre, nenhum dispositivo IoT está associado a esta ação no momento.' " +
  "CONTROLE OPERACIONAL: Você tem controle operacional e acesso aos módulos da interface (Início, Conversa, Atividade, Memória, Dispositivos, Automações, Desenvolvedor, Integrações, Configurações). Nunca afirme que 'não tem acesso ao código' ou que 'não pode mudar de tela'. Para mudar de tela, use a ferramenta navigateToTab. " +
  "NAVEGAÇÃO E MAPAS: Você POSSUI SIM ferramentas de mapas e navegação instaladas ('open_gps_navigation', 'maps_search_places' e 'calculate_route'). NUNCA diga que não possui mapas. NUNCA peça ao usuário coordenadas manuais de latitude ou longitude. Quando o usuário pedir rotas, direções ou tempo de viagem (ex: 'daqui até São Paulo quanto tempo?' ou 'rota de Ponta Grossa a Curitiba'), use 'open_gps_navigation'. Quando pedir locais próximos ('mercado mais próximo', 'farmácia', 'posto'), use 'maps_search_places'. " +
  "Quando requisitado código ou explicações técnicas, estruture em blocos claros de Markdown com linguagem especificada.";

const defaultActivityLogs: ActivityLogItem[] = [
  { id: 'log-1', timestamp: '20:43:50', category: 'system', summary: 'LIORA Core inicializado com sucesso', details: 'Carregado modelo gemini-3.1-flash-lite via servidor Express.', riskLevel: 'R0', status: 'success', simulated: false },
  { id: 'log-2', timestamp: '20:43:52', category: 'security', summary: 'Permission Engine verificado', details: 'Níveis R0–R3 ativos. Sandbox web com bridges simuladas.', riskLevel: 'R0', status: 'success', simulated: false },
  { id: 'log-3', timestamp: '20:44:01', category: 'ai', summary: 'Streaming de chat conectado', details: 'Endpoint /api/gemini/chat respondendo com sucesso.', riskLevel: 'R0', status: 'success', simulated: false }
];

function bootstrapActivityLogs(): ActivityLogItem[] {
  if (typeof localStorage === 'undefined') {
    return defaultActivityLogs;
  }
  try {
    const raw = localStorage.getItem(ACTIVITY_LOGS_STORAGE_KEY);
    if (!raw) return defaultActivityLogs;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.slice(0, MAX_ACTIVITY_LOGS);
    }
  } catch (e) {
    console.warn('[ActivityLogs] Failed to parse activity logs from LocalStorage:', e);
  }
  return defaultActivityLogs;
}

export const MEMORIES_STORAGE_KEY = 'liora_memories_v1';

// FIX W7: AbortController ativo é um objeto volátil de escopo de módulo (não-válido em React)
// e NÃO deve viver no estado global do Zustand — referências mutáveis no estado disparam
// re-renderizações em cascata em todos os subscribers a cada troca.
// AbortController é intencionalmente oculto do estado global.
let moduleAbortController: AbortController | null = null;

/**
 * FIX 6: montagem compartilhada dos cabeçalhos de chat (usada por sendMessage e retryMessage).
 * Garante que o reenvio NUNCA perca as credenciais do cofre/headers de autenticação.
 */
/**
 * P4/R4 (sanitização de TTS): remove a marcação Markdown (cabeçalhos #, itálico/negrito
 * * e _, código inline ` e blocos ```, links [texto](url) → texto) para que a voz
 * não leia pontuação técnica em voz alta. Usada por todo pipeline speak() da LIORA.
 *
 * R4 (multilíngue/Cirílico): todas as expressões usam a flag Unicode `/u` e classes
 * `\p{L}`/`\p{N}`, preservando perfeitamente alfabetos não-latinos (cirílico: мама,
 * кот, приват; grego, hanzi, coreano, árabe...). Regex de ênfase SÓ dispara quando
 * o delimitador está adjacente a letras (não dígitos/underscores), evitando apagar
 * termos técnicos como `snake_case`, `my_var_2` ou `__init__` — que permanecem intactos.
 */
function sanitizeTextForSpeech(raw: string): string {
  if (!raw) return '';
  return raw
    // Blocos de código: substitui o conteúdo por marcador falável
    .replace(/```[\s\S]*?```/gu, ' (trecho de código) ')
    // Links [texto](url) → apenas o texto (o colchete exige conteúdo não-vazio)
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    // Imagens ![alt](url) → omitidas
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, '')
    // Cabeçalhos (funciona com qualquer alfabeto após o #)
    .replace(/^#{1,6}\s+/gmu, '')
    // Negrito **palavra**: delimitador só é removido quando o conteúdo contém
    // letras Unicode (preserva `a**b` matemático e `**` vazio)
    .replace(/\*\*([^*\n]*\p{L}[^*\n]*)\*\*/gu, '$1')
    // Itálico *palavra*: idem — só quando delimitando letras (não multiplicações a*b)
    .replace(/(?<![\p{L}\p{N}])\*([^*\n]*\p{L}[^*\n]*)\*(?![\p{L}\p{N}])/gu, '$1')
    // Negrito __palavra__: só entre letras — preserva identificadores __init__,
    // snake_case e múltiplos underscores técnicos
    .replace(/(?<![\p{L}\p{N}_])__([^_\n]*\p{L}[^_\n]*)__(?![\p{L}\p{N}_])/gu, '$1')
    // Itálico _palavra_: só quando o delimitador NÃO faz parte de um identificador
    // (precedido/seguído por espaço ou pontuação). mama_mama e my_var_2 ficam intactos.
    .replace(/(?<=^|[\s([{"'])_([^_\n]*\p{L}[^_\n]*)_(?=$|[\s)\].,;:!?\u201d'\]])/gmu, '$1')
    // Código inline `comando`: conteúdo preservado intacto (qualquer alfabeto)
    .replace(/`([^`\n]+)`/gu, '$1')
    // Citações e linhas horizontais
    .replace(/^>\s?/gmu, '')
    .replace(/^---+\s*$/gmu, '')
    // Colapsa espaços múltiplos resultantes (preserva quebras de linha)
    .replace(/[ \t]{2,}/gu, ' ')
    .trim();
}

function buildChatHeaders(): Record<string, string> {
  const geminiKey = integrationsVault.getApiKeyByProvider('gemini') || integrationsVault.getRawKey('svc-gemini');
  const openRouterKey = integrationsVault.getApiKeyByProvider('openrouter') ||
                        integrationsVault.getRawKey('svc-openrouter') ||
                        (typeof localStorage !== 'undefined' ? localStorage.getItem('OPENROUTER_API_KEY') : null);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (geminiKey) {
    headers['Authorization'] = `Bearer ${geminiKey}`;
    headers['x-gemini-key'] = geminiKey;
  }
  if (openRouterKey) {
    headers['x-openrouter-key'] = openRouterKey;
  }
  return headers;
}

const defaultMemoryEntries: MemoryEntry[] = [
  { id: 'mem-1', category: 'preference', key: 'idioma', value: 'Português Brasileiro (pt-BR)', confidence: 0.99, updatedAt: new Date().toISOString().split('T')[0] },
  { id: 'mem-2', category: 'preference', key: 'tema_visual', value: 'Perfil dinâmico de cores (Crimson, Emerald, Amber, Ice)', confidence: 1.0, updatedAt: new Date().toISOString().split('T')[0] },
  { id: 'mem-3', category: 'routine', key: 'tratamento_usuario', value: 'Mestre', confidence: 1.0, updatedAt: new Date().toISOString().split('T')[0] },
  { id: 'mem-4', category: 'project', key: 'diretorio_workspace', value: '/workspace/liora-core', confidence: 0.95, updatedAt: new Date().toISOString().split('T')[0] },
  { id: 'mem-5', category: 'routine', key: 'horario_silencioso', value: '23:00 às 07:00', confidence: 0.9, updatedAt: new Date().toISOString().split('T')[0] }
];

function bootstrapMemoryEntries(): MemoryEntry[] {
  if (typeof localStorage === 'undefined') {
    return defaultMemoryEntries;
  }
  try {
    const raw = localStorage.getItem(MEMORIES_STORAGE_KEY);
    if (!raw) return defaultMemoryEntries;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed;
    }
  } catch (e) {
    console.warn('[MemoryStore] Failed to parse memory entries from LocalStorage:', e);
  }
  return defaultMemoryEntries;
}

function persistMemoriesToLocalStorage(memories: MemoryEntry[]): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(MEMORIES_STORAGE_KEY, JSON.stringify(memories));
    }
    // Espelhamento transacional via storageAdapter (Desktop SQLite / Cache Unificado)
    storageAdapter.save('memories', 'collection', memories).catch((e) => {
      console.warn('[MemoryStore] Falha ao espelhar memórias no storageAdapter:', e);
    });
  } catch (e) {
    console.warn('[MemoryStore] Failed to save memory entries to LocalStorage:', e);
  }
}

const initialSessionData = bootstrapInitialSessions();

export function getActiveAbortController(): AbortController | null {
  return moduleAbortController;
}

function setActiveAbortController(controller: AbortController | null): void {
  moduleAbortController = controller;
}

export const useLioraStore = create<LioraState>((set, get) => ({
  activeTab: 'home',
  conversationSubTab: 'text',
  orbState: 'IDLE',
  isSidebarExpanded: false,
  isMobileDrawerOpen: false,
  isTelemetryOpen: false,
  isVoiceActive: false,
  isGenerating: false,

  // Real Sessions & Messages
  sessions: initialSessionData.sessions,
  activeSessionId: initialSessionData.activeSessionId,
  messages: initialSessionData.messages,
  activeModel: 'gemini-3.1-flash-lite',
  setActiveModel: (model: string) => set({ activeModel: model }),
  pendingConsent: null,
  settings: settingsManager.loadSettings(),

  activeTask: {
    id: 'task-1',
    goal: 'Otimizar pipeline de build e verificar dependências locais',
    steps: [
      { id: 's1', title: 'Inspeção de estrutura de arquivos', status: 'completed', toolName: 'files.list', durationMs: 120 },
      { id: 's2', title: 'Verificação de pacotes TypeScript', status: 'completed', toolName: 'dev.typecheck', durationMs: 450 },
      { id: 's3', title: 'Análise de segurança e segredos', status: 'running', toolName: 'security.audit' }
    ],
    status: 'running',
    riskLevel: 'R1',
    createdAt: new Date().toLocaleTimeString()
  },


  memoryEntries: bootstrapMemoryEntries(),

  credentials: [
    { id: 'cred-1', provider: 'gemini', label: 'Google AI Studio Default', maskedKey: 'AIzaSy...7f8A', status: 'valid', models: ['gemini-3.1-flash-lite'] },
    { id: 'cred-2', provider: 'openrouter', label: 'OpenRouter Backup', maskedKey: 'sk-or-...9x2B', status: 'untested', models: ['anthropic/claude-3.5-sonnet'] }
  ],

  activityLogs: bootstrapActivityLogs(),

  tools: [],
  automations: automationsEngine.getRules(),
  automationLogs: automationsEngine.getLogs(),
  shieldModeActive: true,
  services: integrationsVault.getServices(),
  webhookLogs: integrationsVault.getWebhookLogs(),
  keychainFallbackActive: integrationsVault.isKeychainFallbackActive(),
  isVaultKeyMissing: false,
  vaultDiagnosticMessage: null,
  devices: devicesManager.getDevices(),
  deviceCommands: devicesManager.getCommandLogs(),

  setActiveTab: (tab) => set({ activeTab: tab, isMobileDrawerOpen: false }),
  setConversationSubTab: (subTab) => set({ conversationSubTab: subTab }),
  setOrbState: (state) => set({ orbState: state }),
  toggleSidebar: () => set((state) => ({ isSidebarExpanded: !state.isSidebarExpanded })),
  openMobileDrawer: () => set({ isMobileDrawerOpen: true }),
  closeMobileDrawer: () => set({ isMobileDrawerOpen: false }),
  toggleMobileDrawer: () => set((state) => ({ isMobileDrawerOpen: !state.isMobileDrawerOpen })),
  toggleTelemetry: () => set((state) => ({ isTelemetryOpen: !state.isTelemetryOpen })),
  closeTelemetry: () => set({ isTelemetryOpen: false }),
  toggleVoice: () => {
    const next = !get().isVoiceActive;
    set({ isVoiceActive: next });
    if (!next) {
      speechService.stopListening();
      speechService.stopSpeaking();
      set({ orbState: 'IDLE' });
    } else {
      get().runVaultDiagnostics();
      set({ orbState: 'LISTENING' });
    }
    get().addActivityLog({
      category: 'system',
      summary: next ? 'Voz Ao Vivo Ativada (Live Duplex)' : 'Voz Desativada',
      details: next ? 'Microfone contínuo ativo. Fale livremente ou interrompa a qualquer momento.' : 'Microfone pausado.',
      riskLevel: 'R0',
      status: 'success',
      simulated: false
    });
  },

  // Session Management Actions
  createSession: (customTitle?: string) => {
    // Abort active generation before switching sessions
    if (get().isGenerating) {
      get().abortGeneration();
    }

    const newId = `sess-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    const nowIso = new Date().toISOString();
    const newSession: ConversationSession = {
      id: newId,
      title: customTitle?.trim() || 'Nova Conversa',
      createdAt: nowIso,
      updatedAt: nowIso,
      messages: []
    };

    set((state) => {
      const updatedSessions = [newSession, ...state.sessions];
      saveHistory(updatedSessions, newId);
      return {
        sessions: updatedSessions,
        activeSessionId: newId,
        messages: []
      };
    });

    get().addActivityLog({
      category: 'system',
      summary: 'Nova conversa criada',
      details: `Sessão ID ${newId} criada e ativada.`,
      riskLevel: 'R0',
      status: 'success',
      simulated: false
    });

    return newId;
  },

  openSession: (id: string) => {
    // Abort active generation before switching sessions
    if (get().isGenerating) {
      get().abortGeneration();
    }

    const session = get().sessions.find(s => s.id === id);
    if (!session) return;

    set((state) => {
      saveHistory(state.sessions, id);
      return {
        activeSessionId: id,
        messages: session.messages
      };
    });
  },

  deleteSession: (id: string) => {
    // If active session is generating and being deleted, abort first
    if (get().activeSessionId === id && get().isGenerating) {
      get().abortGeneration();
    }

    set((state) => {
      const filtered = state.sessions.filter(s => s.id !== id);
      let nextActiveId = state.activeSessionId;
      let nextMessages = state.messages;

      if (state.activeSessionId === id) {
        if (filtered.length > 0) {
          nextActiveId = filtered[0].id;
          nextMessages = filtered[0].messages;
        } else {
          // No sessions remain, create a clean default
          const defaultId = `sess-${Date.now()}`;
          const defaultSession: ConversationSession = {
            id: defaultId,
            title: 'Nova Conversa',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messages: []
          };
          filtered.push(defaultSession);
          nextActiveId = defaultId;
          nextMessages = [];
        }
      }

      saveHistory(filtered, nextActiveId);

      return {
        sessions: filtered,
        activeSessionId: nextActiveId,
        messages: nextMessages
      };
    });
  },

  updateSessionTitle: (id: string, title: string) => {
    const cleanTitle = title.trim().slice(0, 80);
    if (!cleanTitle) return;

    set((state) => {
      const updated = state.sessions.map(s => 
        s.id === id ? { ...s, title: cleanTitle, updatedAt: new Date().toISOString() } : s
      );
      saveHistory(updated, state.activeSessionId);
      return { sessions: updated };
    });
  },

  reloadFromStorage: () => {
    const loaded = loadHistory();
    if (loaded.sessions.length > 0) {
      const activeSession = (loaded.activeSessionId ? loaded.sessions.find(s => s.id === loaded.activeSessionId) : null) || loaded.sessions[0];
      set({
        sessions: loaded.sessions,
        activeSessionId: activeSession.id,
        messages: activeSession.messages,
        isGenerating: false,
        
      });
    } else {
      const defaultId = `sess-${Date.now()}`;
      const defaultSession: ConversationSession = {
        id: defaultId,
        title: 'Conversa Inicial',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: []
      };
      saveHistory([defaultSession], defaultId);
      set({
        sessions: [defaultSession],
        activeSessionId: defaultId,
        messages: [],
        isGenerating: false,
        
      });
    }
  },

  clearMessages: () => {
    set((state) => {
      const activeId = state.activeSessionId;
      const updatedSessions = state.sessions.map(s => 
        s.id === activeId ? { ...s, messages: [], updatedAt: new Date().toISOString() } : s
      );
      saveHistory(updatedSessions, activeId);
      return {
        messages: [],
        sessions: updatedSessions
      };
    });
  },

  sendMessage: async (text: string, image?: { data: string; mimeType?: string }, audio?: { data: string; mimeType?: string }) => {
    const clean = sanitizeInput(text);
    if (!clean && !image && !audio) return;
    // Bug hunt (race condition): antes o guard era um check-then-act não atômico
    // (check isGenerating → ... → set isGenerating true várias linhas depois).
    // Duas chamadas quase simultâneas (ex: voz VAD + clique no Send) podiam ambas
    // passar e criar dois AbortControllers — o segundo sobrescrevia o primeiro,
    // deixando um stream órfão que nunca poderia ser abortado. Agora a reserva é
    // atômica: o set com updater verifica e marca dentro da mesma transação.
    let raceLost = false;
    set((state) => {
      if (state.isGenerating) {
        raceLost = true;
        return state;
      }
      return { ...state, isGenerating: true };
    });
    if (raceLost) return;

    const startMs = performance.now();
    let usedProvider: 'gemini' | 'openrouter' = 'gemini';
    // Otimização de exaustão: throttle de persistência durante o streaming (1s)
    let lastPersistTime = 0;

    // Desbloqueia a saída de áudio Web Audio API no evento de clique do usuário
    speechService.unlockAudio();

    // Ensure we have a valid active session
    let targetSessionId = get().activeSessionId;
    if (!targetSessionId || !get().sessions.some(s => s.id === targetSessionId)) {
      targetSessionId = get().createSession();
    }

    const targetSession = get().sessions.find(s => s.id === targetSessionId)!;

    // Automatic smart title generation for new conversations
    let updatedTitle = targetSession.title;
    if (targetSession.title === 'Nova Conversa' || targetSession.title === 'Conversa Inicial') {
      const autoTitle = (clean || (image ? 'Análise de Imagem' : 'Mensagem de Áudio')).slice(0, 38).trim();
      updatedTitle = autoTitle + ((clean || '').length > 38 ? '...' : '');
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const timeHms = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    let userMsgText = clean;
    if (image) userMsgText = `${clean ? clean + '\n\n' : ''}[Captura de Tela Anexada]`;
    if (audio) {
      if (clean && clean !== 'Responda à minha mensagem de voz.') {
        userMsgText = `ðŸŽ¤ "${clean}"`;
      } else {
        userMsgText = `ðŸŽ¤ [Mensagem de Voz Enviada]`;
      }
    }

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}-u`,
      sender: 'user',
      text: userMsgText,
      timestamp: timeHms,
      status: 'completed',
      source: 'text',
      createdAt: nowIso,
      sessionId: targetSessionId
    };

    const assistantMsgId = `msg-${Date.now()}-a`;
    const assistantMsg: ChatMessage = {
      id: assistantMsgId,
      sender: 'assistant',
      text: '',
      timestamp: timeHms,
      status: 'streaming',
      modelUsed: 'gemini-3.1-flash-lite',
      source: 'text',
      createdAt: nowIso,
      sessionId: targetSessionId
    };

    // Calculate context strictly from target session messages
    const currentSessionMessages = targetSession.messages;
    const history = formatGeminiHistory(currentSessionMessages);
    const controller = new AbortController();

    const newTargetMessages = [...currentSessionMessages, userMsg, assistantMsg];

    set((state) => {
      const updatedSessions = state.sessions.map(s => 
        s.id === targetSessionId 
          ? { ...s, title: updatedTitle, messages: newTargetMessages, updatedAt: nowIso } 
          : s
      );

      saveHistory(updatedSessions, state.activeSessionId);

      // Only update active messages if user is still on target session
      const shouldUpdateActiveView = state.activeSessionId === targetSessionId;
      return {
        sessions: updatedSessions,
        messages: shouldUpdateActiveView ? newTargetMessages : state.messages,
        orbState: 'THINKING',
        isGenerating: true
      };
    });
    setActiveAbortController(controller);

    // Rankeamento de memórias contextuais relevantes para o turno atual
    const memories = get().memoryEntries;
    const rankedMemories = rankMemories(clean || (audio ? 'audio' : 'imagem'), memories, {
      minScoreThreshold: 0.35,
      maxInjectedMemories: 4,
      maxCharacterBudget: 400
    });
    const memoryContextBlock = formatMemoryContextBlock(rankedMemories, 400);

    // Interceptação determinística imediata de comandos de navegação por voz/texto
    const navMatch = parseNavigationIntent(clean || '');
    if (navMatch) {
      get().setActiveTab(navMatch.tab);
      const msgSource: 'text' | 'voice' = audio ? 'voice' : 'text';

      set((state) => {
        const updated = state.messages.map((m): ChatMessage =>
          m.id === assistantMsgId
            ? { ...m, text: navMatch.spokenFeedback, status: 'completed', source: msgSource }
            : m
        );
        const updatedSessions = state.sessions.map((sess) => {
          if (sess.id === targetSessionId) {
            return {
              ...sess,
              messages: updated,
              updatedAt: new Date().toISOString()
            };
          }
          return sess;
        });
        saveHistory(updatedSessions, state.activeSessionId);
        return {
          messages: updated,
          sessions: updatedSessions,
          isGenerating: false,
          orbState: state.isVoiceActive ? 'LISTENING' : 'IDLE'
        };
      });

      get().addActivityLog({
        category: 'system',
        summary: `Navegação determinística: ${navMatch.label}`,
        details: `Comando "${clean}" processado instantaneamente. Redirecionado para aba '${navMatch.tab}'.`,
        riskLevel: 'R0',
        status: 'success',
        simulated: false
      });

      if (get().isVoiceActive) {
        speechService.unlockAudio();
        speechService.speak(navMatch.spokenFeedback);
      }

      return;
    }

    // Interceptação determinística de rotas veiculares (GPS)
    const routeIntent = parseRouteIntent(clean || '');
    if (routeIntent) {
      const msgSource: 'text' | 'voice' = audio ? 'voice' : 'text';
      set((state) => {
        const updated = state.messages.map((m): ChatMessage =>
          m.id === assistantMsgId
            ? { ...m, text: routeIntent.spokenFeedback, status: 'completed', source: msgSource }
            : m
        );
        const updatedSessions = state.sessions.map((sess) => {
          if (sess.id === targetSessionId) {
            return {
              ...sess,
              messages: updated,
              updatedAt: new Date().toISOString()
            };
          }
          return sess;
        });
        saveHistory(updatedSessions, state.activeSessionId);
        return {
          messages: updated,
          sessions: updatedSessions,
          isGenerating: false,
          orbState: state.isVoiceActive ? 'LISTENING' : 'IDLE'
        };
      });

      const appName = routeIntent.provider === 'waze' ? 'Waze' : 'Google Maps';
      get().addActivityLog({
        category: 'tool',
        summary: `Navegação GPS Ativa (${appName})`,
        details: `Destino: "${routeIntent.destination}"${routeIntent.origin ? ` | Origem: "${routeIntent.origin}"` : ' | Origem: GPS Atual'}.`,
        riskLevel: 'R0',
        status: 'success',
        simulated: false
      });

      if (get().isVoiceActive) {
        speechService.unlockAudio();
        speechService.speak(routeIntent.spokenFeedback);
      }

      void launchGpsNavigation(routeIntent.destination, routeIntent.provider, routeIntent.origin);

      return;
    }

    // Interceptação determinística de busca de locais (Google Maps Places)
    const placesIntent = parsePlacesSearchIntent(clean || '');
    if (placesIntent) {
      const msgSource: 'text' | 'voice' = audio ? 'voice' : 'text';
      set((state) => {
        const updated = state.messages.map((m): ChatMessage =>
          m.id === assistantMsgId
            ? { ...m, text: placesIntent.spokenFeedback, status: 'completed', source: msgSource }
            : m
        );
        const updatedSessions = state.sessions.map((sess) => {
          if (sess.id === targetSessionId) {
            return {
              ...sess,
              messages: updated,
              updatedAt: new Date().toISOString()
            };
          }
          return sess;
        });
        saveHistory(updatedSessions, state.activeSessionId);
        return {
          messages: updated,
          sessions: updatedSessions,
          isGenerating: false,
          orbState: state.isVoiceActive ? 'LISTENING' : 'IDLE'
        };
      });

      get().addActivityLog({
        category: 'tool',
        summary: 'Busca de Locais (Google Maps)',
        details: `Termo: "${placesIntent.query}"${placesIntent.nearLocation ? ` | Referência: "${placesIntent.nearLocation}"` : ' | Perto da localização atual'}.`,
        riskLevel: 'R0',
        status: 'success',
        simulated: false
      });

      if (get().isVoiceActive) {
        speechService.unlockAudio();
        speechService.speak(placesIntent.spokenFeedback);
      }

      void launchPlacesSearch(placesIntent.query, placesIntent.nearLocation);

      return;
    }

    const systemInstruction = memoryContextBlock 
      ? `${LIORA_SYSTEM_INSTRUCTION}${memoryContextBlock}` 
      : LIORA_SYSTEM_INSTRUCTION;

    get().addActivityLog({
      category: 'ai',
      summary: `Mensagem enviada: "${(clean || (audio ? 'Mensagem de Voz' : 'Captura de Tela')).slice(0, 30)}..."`,
      details: `Sessão [${targetSessionId}]. Enviado para /api/gemini/chat/stream com ${history.length} turnos de contexto${rankedMemories.length > 0 ? ` e ${rankedMemories.length} memórias contextuais` : ''}.`,
      riskLevel: 'R0',
      status: 'success',
      simulated: false
    });

    try {
      const chatHeaders = buildChatHeaders();

      const res = await fetch('/api/gemini/chat/stream', {
        method: 'POST',
        headers: chatHeaders,
        body: JSON.stringify({
          message: (audio && clean === 'Responda à minha mensagem de voz.') ? '' : clean,
          image,
          audio,
          history,
          model: get().activeModel || 'gemini-3.1-flash-lite',
          systemInstruction
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        let errorData: any = {};
        try { errorData = await res.json(); } catch {}
        const classified = classifyChatError(res.status, errorData.error || res.statusText);

        set((state) => {
          const updatedSessions = state.sessions.map((s) => {
            if (s.id !== targetSessionId) return s;
            return {
              ...s,
              updatedAt: new Date().toISOString(),
              messages: s.messages.map((m): ChatMessage =>
                m.id === assistantMsgId ? {
                  ...m,
                  text: classified.userMessage,
                  status: 'error',
                  errorMessage: classified.userMessage,
                  errorCode: classified.code
                } : m
              )
            };
          });

          saveHistory(updatedSessions, targetSessionId);

          const isCurrent = state.activeSessionId === targetSessionId;
          const currentSession = updatedSessions.find(s => s.id === state.activeSessionId);

          return {
            sessions: updatedSessions,
            messages: isCurrent && currentSession ? currentSession.messages : state.messages,
            orbState: 'ERROR',
            isGenerating: false,
            
          };
        });
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('Readable stream indisponível.');

      const decoder = new TextDecoder();
      let accumulatedText = '';
      let buffer = '';
      let hasReceivedFirstChunk = false;

      const isVoiceActive = get().isVoiceActive;
      const wasAudioSent = Boolean(audio && audio.data);
      const shouldSpeakResponse = isVoiceActive || wasAudioSent;

      let unspokenBuffer = '';
      if (shouldSpeakResponse) {
        speechService.resetStreamingQueue();
      }

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';

        for (const block of blocks) {
          const line = block.trim();
          if (line.startsWith('data:')) {
            const jsonStr = line.replace(/^data:\s*/, '');
            try {
              const data = JSON.parse(jsonStr);
              if (data.failover) {
                const failoverNotice = `\n\n> âš ï¸ *[Alternado para OpenRouter: ${data.message || 'Cota do Gemini excedida'}]*\n\n`;
                accumulatedText += failoverNotice;
                get().addActivityLog({
                  category: 'ai',
                  summary: 'Cota Gemini Excedida -> OpenRouter Failover',
                  details: data.message || 'Cota do Gemini atingida. Alternando para o modelo de contingência OpenRouter.',
                  riskLevel: 'R0',
                  status: 'warning',
                  simulated: false
                });
              } else if (data.toolExecuted) {
                // Confirmação REAL de execução de ferramenta (function calling loop)
                get().addActivityLog({
                  category: 'tool',
                  summary: `Ferramenta executada: ${data.toolExecuted}`,
                  details: data.resultSummary || (data.success ? 'Execução real confirmada pelo servidor.' : 'Falhou.'),
                  riskLevel: (data.riskLevel || 'R1') as any,
                  status: data.success ? 'success' : 'error',
                  simulated: Boolean(data.simulated)
                });

                // CORREÇÃO (sincronização tool→TTS): publica o resultado REAL da
                // ferramenta no eventBus — o pipeline de voz injeta o dado na fila
                // de fala, eliminando a alucinação de 'não ter localização' quando
                // o Maps já foi aberto com o resultado.
                eventBus.publish('liora:tool_result', {
                  toolName: data.toolExecuted,
                  success: Boolean(data.success),
                  resultSummary: data.resultSummary,
                  resultData: data.resultData
                });
              } else if (data.chunk) {
                accumulatedText += data.chunk;
                if (!hasReceivedFirstChunk) {
                  hasReceivedFirstChunk = true;
                  set({ orbState: 'SPEAKING' });
                }

                if (shouldSpeakResponse) {
                  unspokenBuffer += data.chunk;
                  // Busca por delimitadores de frase (., !, ?, \n, ;) ou acúmulo de >35 caracteres
                  const match = unspokenBuffer.match(/^([^.!?\n;]+[.!?\n;]+)(.*)/s);
                  if (match) {
                    const sentenceToSpeak = match[1].trim();
                    unspokenBuffer = match[2];
                    if (sentenceToSpeak) {
                      // P4: sanitiza Markdown antes do TTS de streaming
                      speechService.speakStreamingChunk(sanitizeTextForSpeech(sentenceToSpeak), () => set({ orbState: 'SPEAKING' }));
                    }
                  } else if (unspokenBuffer.length >= 40) {
                    // Trunca na última palavra para não cortar palavras
                    const lastSpaceIdx = unspokenBuffer.lastIndexOf(' ');
                    if (lastSpaceIdx > 12) {
                      const phraseToSpeak = unspokenBuffer.slice(0, lastSpaceIdx).trim();
                      unspokenBuffer = unspokenBuffer.slice(lastSpaceIdx).trimStart();
                      if (phraseToSpeak) {
                        speechService.speakStreamingChunk(sanitizeTextForSpeech(phraseToSpeak), () => set({ orbState: 'SPEAKING' }));
                      }
                    }
                  }
                }

                // Otimização de exaustão: throttled persist 1s (mesma estratégia do stream de texto)
                const nowMs = Date.now();
                const shouldPersistThisChunk = nowMs - lastPersistTime > 1000;
                if (shouldPersistThisChunk) lastPersistTime = nowMs;

                set((state) => {
                  const updatedSessions = state.sessions.map((s) => {
                    if (s.id !== targetSessionId) return s;
                    return {
                      ...s,
                      messages: s.messages.map((m): ChatMessage =>
                        m.id === assistantMsgId ? { ...m, text: accumulatedText, status: 'streaming' } : m
                      )
                    };
                  });

                  if (shouldPersistThisChunk) {
                    saveHistory(updatedSessions, targetSessionId);
                  }

                  const isCurrent = state.activeSessionId === targetSessionId;
                  const currentSession = updatedSessions.find(s => s.id === state.activeSessionId);

                  return {
                    sessions: updatedSessions,
                    messages: isCurrent && currentSession ? currentSession.messages : state.messages
                  };
                });
              } else if (data.error) {
                const classified = classifyChatError(0, data.error);
                if (shouldSpeakResponse) {
                  speechService.resetStreamingQueue();
                  // CORREÇÃO (quota esgotada — falhar com voz, nunca em silêncio):
                  // quota/indisponibilidade é dita em voz alta de forma amigável.
                  const quotaSpeech = /quota|limite|429|rate/i.test(classified.userMessage)
                    ? 'Minha cota de análise visual esgotou por hoje, mestre. Podemos continuar amanhã ou usar uma chave paga.'
                    : classified.userMessage;
                  speechService.speak(sanitizeTextForSpeech(quotaSpeech), () => {}, () => {});
                  // ETAPA D (anti-silêncio): publica no eventBus para o banner
                  // visual do GlobalVoiceBar mostrar o mesmo aviso em texto.
                  eventBus.publish('liora:voice_warning', { message: quotaSpeech });
                }
                set((state) => {
                  const updatedSessions = state.sessions.map((s) => {
                    if (s.id !== targetSessionId) return s;
                    return {
                      ...s,
                      updatedAt: new Date().toISOString(),
                      messages: s.messages.map((m): ChatMessage =>
                        m.id === assistantMsgId ? {
                          ...m,
                          text: accumulatedText || classified.userMessage,
                          status: 'error',
                          errorMessage: classified.userMessage,
                          errorCode: classified.code
                        } : m
                      )
                    };
                  });

                  saveHistory(updatedSessions, targetSessionId);

                  const isCurrent = state.activeSessionId === targetSessionId;
                  const currentSession = updatedSessions.find(s => s.id === state.activeSessionId);

                  return {
                    sessions: updatedSessions,
                    messages: isCurrent && currentSession ? currentSession.messages : state.messages,
                    orbState: 'ERROR',
                    isGenerating: false,
                    
                  };
                });
                return;
              }
            } catch {}
          }
        }
      }

      // Finaliza texto restante no buffer de fala e dispara o aviso de conclusão
      if (shouldSpeakResponse && unspokenBuffer.trim()) {
        speechService.speakStreamingChunk(sanitizeTextForSpeech(unspokenBuffer.trim()), () => set({ orbState: 'SPEAKING' }));
      }

      // Stream successfully completed
      // Registra métricas reais de tokens/latência para o AnalyticsDashboard
      const totalLatencyMs = Math.round(performance.now() - startMs);
      tokenAnalytics.recordApiCall(
        usedProvider,
        (clean || '').length + JSON.stringify(history).length,
        accumulatedText.length,
        totalLatencyMs
      );

      set((state) => {
        const finalIso = new Date().toISOString();
        const updatedSessions = state.sessions.map((s) => {
          if (s.id !== targetSessionId) return s;
          return {
            ...s,
            updatedAt: finalIso,
            messages: s.messages.map((m): ChatMessage =>
              m.id === assistantMsgId ? {
                ...m,
                text: accumulatedText || 'Sem resposta gerada.',
                status: 'completed'
              } : m
            )
          };
        });

        saveHistory(updatedSessions, targetSessionId);

        const isCurrent = state.activeSessionId === targetSessionId;
        const currentSession = updatedSessions.find(s => s.id === state.activeSessionId);

        return {
          sessions: updatedSessions,
          messages: isCurrent && currentSession ? currentSession.messages : state.messages,
          orbState: shouldSpeakResponse ? 'SPEAKING' : 'SUCCESS',
          isGenerating: false,
          
        };
      });

      if (shouldSpeakResponse) {
        speechService.finishStreamingQueue(() => {
          if (get().isVoiceActive) {
            set({ orbState: 'LISTENING' });
            eventBus.publish('liora:resume_voice_recording');
          } else {
            set({ orbState: 'IDLE' });
          }
        });
      } else {
        setTimeout(() => {
          if (get().orbState === 'SUCCESS') set({ orbState: 'IDLE' });
        }, 2000);
      }

    } catch (err: any) {
      if (controller.signal.aborted || err.name === 'AbortError') {
        set((state) => {
          const cancelIso = new Date().toISOString();
          const updatedSessions = state.sessions.map((s) => {
            if (s.id !== targetSessionId) return s;
            return {
              ...s,
              updatedAt: cancelIso,
              messages: s.messages.map((m): ChatMessage =>
                m.id === assistantMsgId ? {
                  ...m,
                  status: 'cancelled',
                  errorCode: 'CANCELLED',
                  text: m.text ? `${m.text}\n\n*[Geração interrompida pelo usuário]*` : '*[Geração cancelada]*'
                } : m
              )
            };
          });

          saveHistory(updatedSessions, targetSessionId);

          const isCurrent = state.activeSessionId === targetSessionId;
          const currentSession = updatedSessions.find(s => s.id === state.activeSessionId);

          return {
            sessions: updatedSessions,
            messages: isCurrent && currentSession ? currentSession.messages : state.messages,
            orbState: 'CANCELLED',
            isGenerating: false,
            
          };
        });

        setTimeout(() => {
          if (get().orbState === 'CANCELLED') set({ orbState: 'IDLE' });
        }, 2000);
        return;
      }

      const classified = classifyChatError(err);
      set((state) => {
        const errorIso = new Date().toISOString();
        const updatedSessions = state.sessions.map((s) => {
          if (s.id !== targetSessionId) return s;
          return {
            ...s,
            updatedAt: errorIso,
            messages: s.messages.map((m): ChatMessage =>
              m.id === assistantMsgId ? {
                ...m,
                status: 'error',
                errorMessage: classified.userMessage,
                errorCode: classified.code
              } : m
            )
          };
        });

        saveHistory(updatedSessions, targetSessionId);

        const isCurrent = state.activeSessionId === targetSessionId;
        const currentSession = updatedSessions.find(s => s.id === state.activeSessionId);

        return {
          sessions: updatedSessions,
          messages: isCurrent && currentSession ? currentSession.messages : state.messages,
          orbState: 'ERROR',
          isGenerating: false,
        };
      });

      setTimeout(() => {
        if (get().orbState === 'ERROR') set({ orbState: 'IDLE' });
      }, 3000);
    }
  },

  abortGeneration: () => {
    const controller = getActiveAbortController();
    if (controller) {
      controller.abort();
      setActiveAbortController(null);
    }
  },

  retryMessage: async (failedMessageId: string) => {
    if (get().isGenerating) return;
    // Otimização de exaustão: throttle de persistência durante o streaming do retry
    let lastPersistTime = 0;

    const targetSessionId = get().activeSessionId;
    if (!targetSessionId) return;

    const currentMessages = get().messages;
    const failedIdx = currentMessages.findIndex((m) => m.id === failedMessageId);
    if (failedIdx === -1) return;

    let userText = '';
    for (let i = failedIdx - 1; i >= 0; i--) {
      if (currentMessages[i].sender === 'user') {
        userText = currentMessages[i].text;
        break;
      }
    }

    if (!userText) return;

    // Filter out the failed message from active session
    set((state) => {
      const filteredMessages = state.messages.filter((m) => m.id !== failedMessageId);
      const updatedSessions = state.sessions.map(s => 
        s.id === targetSessionId ? { ...s, messages: filteredMessages, updatedAt: new Date().toISOString() } : s
      );
      saveHistory(updatedSessions, state.activeSessionId);
      return {
        messages: filteredMessages,
        sessions: updatedSessions
      };
    });

    const targetSession = get().sessions.find(s => s.id === targetSessionId)!;
    const history = formatGeminiHistory(targetSession.messages.filter(m => m.text !== userText || m.sender !== 'user'));
    
    const assistantMsgId = `msg-${Date.now()}-a`;
    const retryNow = new Date();
    const retryTimeHms = retryNow.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const assistantMsg: ChatMessage = {
      id: assistantMsgId,
      sender: 'assistant',
      text: '',
      timestamp: retryTimeHms,
      status: 'streaming',
      modelUsed: 'gemini-3.1-flash-lite',
      source: 'text',
      createdAt: retryNow.toISOString(),
      sessionId: targetSessionId
    };

    const controller = new AbortController();

    set((state) => {
      const nextMessages = [...state.messages, assistantMsg];
      const updatedSessions = state.sessions.map(s => 
        s.id === targetSessionId ? { ...s, messages: nextMessages, updatedAt: new Date().toISOString() } : s
      );
      saveHistory(updatedSessions, state.activeSessionId);
      return {
        messages: nextMessages,
        sessions: updatedSessions,
        orbState: 'THINKING',
        isGenerating: true
      };
    });
    setActiveAbortController(controller);

    try {
      // FIX W1: retryMessage agora reaproveita integralmente as credenciais do cofre,
      // o modelo ativo e o systemInstruction com memórias contextuais (antes o retry
      // fazia fetch sem Authorization/keys e sem contexto de memória).
      // FIX 6: retryMessage reutiliza os MESMOS headers/montagem do sendMessage
      // (credenciais do cofre preservadas no reenvio) via buildChatHeaders.
      const retryHeaders = buildChatHeaders();

      // Contexto de memórias rankeadas para o retry (mesma política do sendMessage)
      const retryMemories = rankMemories(userText, get().memoryEntries, {
        minScoreThreshold: 0.35,
        maxInjectedMemories: 4,
        maxCharacterBudget: 400
      });
      const retryMemoryBlock = formatMemoryContextBlock(retryMemories, 400);
      const retrySystemInstruction = retryMemoryBlock 
        ? `${LIORA_SYSTEM_INSTRUCTION}${retryMemoryBlock}` 
        : LIORA_SYSTEM_INSTRUCTION;

      const res = await fetch('/api/gemini/chat/stream', {
        method: 'POST',
        headers: retryHeaders,
        body: JSON.stringify({
          message: userText,
          history,
          model: get().activeModel || 'gemini-3.1-flash-lite',
          systemInstruction: retrySystemInstruction
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        let errorData: any = {};
        try { errorData = await res.json(); } catch {}
        const classified = classifyChatError(res.status, errorData.error || res.statusText);
        set((state) => {
          const updatedSessions = state.sessions.map((s) => {
            if (s.id !== targetSessionId) return s;
            return {
              ...s,
              updatedAt: new Date().toISOString(),
              messages: s.messages.map((m): ChatMessage =>
                m.id === assistantMsgId ? {
                  ...m,
                  text: m.text || classified.userMessage,
                  status: 'error',
                  errorMessage: classified.userMessage,
                  errorCode: classified.code
                } : m
              )
            };
          });

          saveHistory(updatedSessions, targetSessionId);

          const isCurrent = state.activeSessionId === targetSessionId;
          const currentSession = updatedSessions.find(s => s.id === state.activeSessionId);

          return {
            sessions: updatedSessions,
            messages: isCurrent && currentSession ? currentSession.messages : state.messages,
            orbState: 'ERROR',
            isGenerating: false,
            
          };
        });
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('Readable stream indisponível.');
      const decoder = new TextDecoder();
      let accumulatedText = '';
      let buffer = '';
      let hasReceivedFirstChunk = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';

        for (const block of blocks) {
          const line = block.trim();
          if (line.startsWith('data:')) {
            const jsonStr = line.replace(/^data:\s*/, '');
            try {
              const data = JSON.parse(jsonStr);
              if (data.chunk) {
                accumulatedText += data.chunk;
                if (!hasReceivedFirstChunk) {
                  hasReceivedFirstChunk = true;
                  set({ orbState: 'SPEAKING' });
                }

                // Otimização de exaustão: persistência do histórico durante o streaming é
                // THROTTLED a 1s. Antes, cada chunk serializava e regravava TODAS as
                // sessões no localStorage (O(n²) de I/O). O texto completo persiste de
                // forma atômica no save final (status: 'completed').
                const nowMs = Date.now();
                const shouldPersistThisChunk = nowMs - lastPersistTime > 1000;
                if (shouldPersistThisChunk) lastPersistTime = nowMs;

                set((state) => {
                  const updatedSessions = state.sessions.map((s) => {
                    if (s.id !== targetSessionId) return s;
                    return {
                      ...s,
                      messages: s.messages.map((m): ChatMessage =>
                        m.id === assistantMsgId ? { ...m, text: accumulatedText, status: 'streaming' } : m
                      )
                    };
                  });

                  if (shouldPersistThisChunk) {
                    saveHistory(updatedSessions, targetSessionId);
                  }

                  const isCurrent = state.activeSessionId === targetSessionId;
                  const currentSession = updatedSessions.find(s => s.id === state.activeSessionId);

                  return {
                    sessions: updatedSessions,
                    messages: isCurrent && currentSession ? currentSession.messages : state.messages
                  };
                });
              } else if (data.error) {
                const classified = classifyChatError(0, data.error);
                set((state) => {
                  const updatedSessions = state.sessions.map((s) => {
                    if (s.id !== targetSessionId) return s;
                    return {
                      ...s,
                      updatedAt: new Date().toISOString(),
                      messages: s.messages.map((m): ChatMessage =>
                        m.id === assistantMsgId ? {
                          ...m,
                          text: accumulatedText,
                          status: 'error',
                          errorMessage: classified.userMessage,
                          errorCode: classified.code
                        } : m
                      )
                    };
                  });

                  saveHistory(updatedSessions, targetSessionId);

                  const isCurrent = state.activeSessionId === targetSessionId;
                  const currentSession = updatedSessions.find(s => s.id === state.activeSessionId);

                  return {
                    sessions: updatedSessions,
                    messages: isCurrent && currentSession ? currentSession.messages : state.messages,
                    orbState: 'ERROR',
                    isGenerating: false,
                    
                  };
                });
                return;
              }
            } catch {}
          }
        }
      }

      set((state) => {
        const finalIso = new Date().toISOString();
        const updatedSessions = state.sessions.map((s) => {
          if (s.id !== targetSessionId) return s;
          return {
            ...s,
            updatedAt: finalIso,
            messages: s.messages.map((m): ChatMessage =>
              m.id === assistantMsgId ? {
                ...m,
                text: accumulatedText || 'Sem resposta gerada.',
                status: 'completed'
              } : m
            )
          };
        });

        saveHistory(updatedSessions, targetSessionId);

        const isCurrent = state.activeSessionId === targetSessionId;
        const currentSession = updatedSessions.find(s => s.id === state.activeSessionId);

        return {
          sessions: updatedSessions,
          messages: isCurrent && currentSession ? currentSession.messages : state.messages,
          orbState: 'SUCCESS',
          isGenerating: false,
          
        };
      });

      // Se o modo de voz contínua estiver ativo, a LIORA responde falando em voz alta (Live Duplex)
      if (get().isVoiceActive && accumulatedText) {
        set({ orbState: 'SPEAKING' });
        // P4: sanitiza Markdown antes do TTS para não ler crases/asteriscos em voz alta
        speechService.speak(
          sanitizeTextForSpeech(accumulatedText),
          () => {
            set({ orbState: 'SPEAKING' });
          },
          () => {
            if (get().isVoiceActive) {
              set({ orbState: 'LISTENING' });
              eventBus.publish('liora:resume_voice_recording');
            } else {
              set({ orbState: 'IDLE' });
            }
          }
        );
      } else {
        setTimeout(() => {
          if (get().orbState === 'SUCCESS') set({ orbState: 'IDLE' });
        }, 2000);
      }

    } catch (err: any) {
      if (controller.signal.aborted || err.name === 'AbortError') {
        set((state) => {
          const cancelIso = new Date().toISOString();
          const updatedSessions = state.sessions.map((s) => {
            if (s.id !== targetSessionId) return s;
            return {
              ...s,
              updatedAt: cancelIso,
              messages: s.messages.map((m): ChatMessage =>
                m.id === assistantMsgId ? {
                  ...m,
                  status: 'cancelled',
                  errorCode: 'CANCELLED',
                  text: m.text ? `${m.text}\n\n*[Geração interrompida pelo usuário]*` : '*[Geração cancelada]*'
                } : m
              )
            };
          });

          saveHistory(updatedSessions, targetSessionId);

          const isCurrent = state.activeSessionId === targetSessionId;
          const currentSession = updatedSessions.find(s => s.id === state.activeSessionId);

          return {
            sessions: updatedSessions,
            messages: isCurrent && currentSession ? currentSession.messages : state.messages,
            orbState: 'CANCELLED',
            isGenerating: false,
            
          };
        });

        setTimeout(() => {
          if (get().orbState === 'CANCELLED') set({ orbState: 'IDLE' });
        }, 2000);
        return;
      }

      const classified = classifyChatError(err);
      set((state) => {
        const errorIso = new Date().toISOString();
        const updatedSessions = state.sessions.map((s) => {
          if (s.id !== targetSessionId) return s;
          return {
            ...s,
            updatedAt: errorIso,
            messages: s.messages.map((m): ChatMessage =>
              m.id === assistantMsgId ? {
                ...m,
                status: 'error',
                errorMessage: classified.userMessage,
                errorCode: classified.code
              } : m
            )
          };
        });

        saveHistory(updatedSessions, targetSessionId);

        const isCurrent = state.activeSessionId === targetSessionId;
        const currentSession = updatedSessions.find(s => s.id === state.activeSessionId);

        return {
          sessions: updatedSessions,
          messages: isCurrent && currentSession ? currentSession.messages : state.messages,
          orbState: 'ERROR',
          isGenerating: false,
        };
      });

      setTimeout(() => {
        if (get().orbState === 'ERROR') set({ orbState: 'IDLE' });
      }, 3000);
    }
  },

  addActivityLog: (log) => {
    const newItem: ActivityLogItem = {
      id: `log-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      ...log
    };
    set((state) => {
      const updated = [newItem, ...state.activityLogs].slice(0, MAX_ACTIVITY_LOGS);
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(ACTIVITY_LOGS_STORAGE_KEY, JSON.stringify(updated));
        }
      } catch (err) {
        console.warn('[ActivityLogs] Failed to persist logs to LocalStorage:', err);
      }
      return { activityLogs: updated };
    });
  },

  clearActivityLogs: () => {
    const secLog: ActivityLogItem = {
      id: `log-${Date.now()}-sec`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      category: 'security',
      summary: 'Logs de auditoria limpos pelo usuário',
      details: 'Histórico de auditoria anterior zerado com autorização do usuário.',
      riskLevel: 'R1',
      status: 'warning',
      simulated: false
    };
    const newLogs = [secLog];
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(ACTIVITY_LOGS_STORAGE_KEY, JSON.stringify(newLogs));
      }
    } catch (err) {
      console.warn('[ActivityLogs] Failed to clear LocalStorage logs:', err);
    }
    set({ activityLogs: newLogs });
  },

  updateDeviceStatus: (id, connected) => {
    set((state) => ({
      devices: state.devices.map(d => d.id === id ? { ...d, connected, lastSeen: 'Agora' } : d)
    }));
  },

  addMemory: (entry) => {
    const today = new Date().toISOString().split('T')[0];
    const cleanKey = entry.key.trim();
    const normalized = cleanKey.toLowerCase();
    const currentMemories = get().memoryEntries;
    const existingIndex = currentMemories.findIndex(m => m.key.trim().toLowerCase() === normalized);

    let updatedList: MemoryEntry[] = [];
    if (existingIndex >= 0) {
      updatedList = currentMemories.map((m, idx) => {
        if (idx !== existingIndex) return m;
        return {
          ...m,
          category: entry.category || m.category,
          key: cleanKey,
          value: entry.value,
          confidence: entry.confidence ?? m.confidence,
          updatedAt: today
        };
      });
      get().addActivityLog({
        category: 'system',
        summary: `Memória sobrescrita: "${cleanKey}"`,
        details: `Valor atualizado para "${entry.value}" (Deduplicação automática).`,
        riskLevel: 'R0',
        status: 'success',
        simulated: false
      });
    } else {
      const newItem: MemoryEntry = {
        id: `mem-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
        category: entry.category,
        key: cleanKey,
        value: entry.value,
        confidence: entry.confidence ?? 1.0,
        updatedAt: today
      };
      updatedList = [newItem, ...currentMemories];
      get().addActivityLog({
        category: 'system',
        summary: `Nova memória gravada: "${cleanKey}"`,
        details: `Categoria: ${entry.category} • Valor: "${entry.value}"`,
        riskLevel: 'R0',
        status: 'success',
        simulated: false
      });
    }

    persistMemoriesToLocalStorage(updatedList);
    set({ memoryEntries: updatedList });
  },

  updateMemory: (id, partial) => {
    const today = new Date().toISOString().split('T')[0];
    const currentMemories = get().memoryEntries;
    const updatedList = currentMemories.map((m) => {
      if (m.id !== id) return m;
      return {
        ...m,
        ...partial,
        key: partial.key ? partial.key.trim() : m.key,
        updatedAt: today
      };
    });

    const target = updatedList.find(m => m.id === id);
    if (target) {
      get().addActivityLog({
        category: 'system',
        summary: `Memória editada: "${target.key}"`,
        details: `Novo valor: "${target.value}"`,
        riskLevel: 'R0',
        status: 'success',
        simulated: false
      });
    }

    persistMemoriesToLocalStorage(updatedList);
    set({ memoryEntries: updatedList });
  },

  deleteMemory: (id) => {
    const target = get().memoryEntries.find(m => m.id === id);
    const updatedList = get().memoryEntries.filter(m => m.id !== id);
    persistMemoriesToLocalStorage(updatedList);
    set({ memoryEntries: updatedList });

    get().addActivityLog({
      category: 'system',
      summary: 'Memória removida do cofre',
      details: target ? `Chave "${target.key}" excluída.` : `Item ${id} removido.`,
      riskLevel: 'R1',
      status: 'warning',
      simulated: false
    });
  },

  importMemories: (entries, mode = 'merge') => {
    const today = new Date().toISOString().split('T')[0];
    let finalEntries: MemoryEntry[] = [];

    if (mode === 'replace') {
      finalEntries = entries.map((e, idx) => ({
        id: e.id || `mem-imp-${Date.now()}-${idx}`,
        category: e.category || 'preference',
        key: e.key ? e.key.trim() : `chave_${idx}`,
        value: e.value || '',
        confidence: e.confidence ?? 1.0,
        updatedAt: e.updatedAt || today
      }));
    } else {
      const map = new Map<string, MemoryEntry>();
      get().memoryEntries.forEach(m => map.set(m.key.trim().toLowerCase(), m));
      entries.forEach((e, idx) => {
        const cleanKey = e.key ? e.key.trim() : `chave_${idx}`;
        const normalized = cleanKey.toLowerCase();
        map.set(normalized, {
          id: e.id || map.get(normalized)?.id || `mem-imp-${Date.now()}-${idx}`,
          category: e.category || map.get(normalized)?.category || 'preference',
          key: cleanKey,
          value: e.value || map.get(normalized)?.value || '',
          confidence: e.confidence ?? map.get(normalized)?.confidence ?? 1.0,
          updatedAt: today
        });
      });
      finalEntries = Array.from(map.values());
    }

    persistMemoriesToLocalStorage(finalEntries);
    set({ memoryEntries: finalEntries });

    get().addActivityLog({
      category: 'system',
      summary: `Cofre de memórias importado (${entries.length} itens)`,
      details: `Modo de importação: ${mode}. Total de registros ativos: ${finalEntries.length}.`,
      riskLevel: 'R1',
      status: 'success',
      simulated: false
    });
  },

  addCredential: (cred) => {
    const newItem: CredentialItem = {
      id: `cred-${Date.now()}`,
      maskedKey: '****' + Math.random().toString(36).substr(2, 4),
      ...cred
    };
    set((state) => ({ credentials: [...state.credentials, newItem] }));
  },

  deleteCredential: (id) => {
    set((state) => ({ credentials: state.credentials.filter(c => c.id !== id) }));
  },

  loadTools: async () => {
    try {
      const res = await fetch('/api/tools', {
        headers: { 'Accept': 'application/json' }
      });
      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('application/json')) {
        const data = await res.json();
        if (Array.isArray(data.tools) && data.tools.length > 0) {
          set({ tools: data.tools });
          return;
        }
      }
      // Safe fallback to local registry
      const localTools = toolRegistry.listTools();
      if (localTools && localTools.length > 0) {
        set({ tools: localTools });
      }
    } catch {
      // Offline fallback: load local registry tools without unhandled SyntaxError
      try {
        const localTools = toolRegistry.listTools();
        if (localTools && localTools.length > 0) {
          set({ tools: localTools });
        }
      } catch {
        // Safe no-op
      }
    }
  },

  executeTool: async (toolName: string, parameters: Record<string, any> = {}) => {
    const start = performance.now();
    try {
      const res = await fetch('/api/tools/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ toolName, parameters })
      });

      const contentType = res.headers.get('content-type') || '';
      let data: ToolExecutionResult;
      if (contentType.includes('application/json')) {
        data = await res.json();
      } else {
        data = {
          success: false,
          toolName,
          executionTimeMs: Math.round(performance.now() - start),
          riskLevel: 'R0',
          error: `Resposta não-JSON do servidor (${res.status}).`,
          simulated: true,
          timestamp: new Date().toISOString()
        };
      }
      const nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      const isBlocked = (data as any).code === 'EXECUTION_BLOCKED_NO_PERMISSION_ENGINE';
      const isSimulatedExecution = (data as any).simulated !== undefined ? Boolean((data as any).simulated) : true;
      const logItem: ActivityLogItem = {
        id: `log-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
        timestamp: nowTime,
        category: isBlocked ? 'security' : 'tool',
        summary: isBlocked 
          ? `Tool Registry: ${toolName} (Execução Bloqueada)`
          : `Tool Registry: ${toolName} (${data.riskLevel || 'R0'})`,
        details: isBlocked
          ? 'Execução bloqueada no backend: O Permission Engine (Marco 6.2) é necessário para autorizar execuções.'
          : data.success
            ? `Executado e verificado com sucesso em ${data.executionTimeMs}ms${(data as any).verification ? ` [${(data as any).verification.checkName}]` : ''} (${isSimulatedExecution ? 'Simulado' : 'Nativo'}).`
            : `Falha na validação/execução: ${data.error || 'Erro desconhecido'}`,
        riskLevel: data.riskLevel || 'R0',
        status: isBlocked ? 'warning' : data.success ? 'success' : 'error',
        simulated: isSimulatedExecution,
        verified: Boolean((data as any).verification?.verified),
        verificationDetails: (data as any).verification?.checkDetails
      };

      set((state) => ({ activityLogs: [logItem, ...state.activityLogs] }));

      // Execução de Ações Reais de Interface e Navegação na Store
      if (data.success || !isBlocked) {
        if (toolName === 'navigateToTab' && parameters?.tab) {
          get().setActiveTab(parameters.tab as any);
        } else if (toolName === 'openSettings') {
          get().setActiveTab('settings');
        } else if (toolName === 'triggerAutomation' && parameters?.ruleId) {
          automationsEngine.triggerRule(parameters.ruleId, { isManual: true });
        }
      }
      if ((data as any).code === 'DENY_R1_BLOCKED_IN_PHASE_6_2B' || 
          (data as any).code === 'REQUIRES_USER_CONFIRMATION' || 
          (data as any).decision === 'REQUIRES_CONSENT' || 
          (data as any).requiredConfirmation) {
        const now = Date.now();
        set({
          pendingConsent: {
            auditId: (data as any).auditId || `audit-${now}`,
            ruleId: 'manual-rule',
            toolName,
            riskLevel: data.riskLevel || 'R1',
            parameters,
            parametersHash: (data as any).parametersHash,
            consentToken: (data as any).consentToken || `consent-${now}-${Math.random().toString(36).substr(2, 9)}`,
            sessionId: get().activeSessionId || 'default-session',
            expiresAt: now + 60000,
            reason: (data as any).error || 'Operação de nível R1 requer confirmação humana explícita.',
            status: 'PENDING'
          }
        });
      }

      return data;
    } catch (err: any) {
      const executionTimeMs = Math.round(performance.now() - start);
      const errorResult: ToolExecutionResult = {
        toolName,
        success: false,
        error: err?.message || 'Falha de rede ao conectar com /api/tools/execute.',
        simulated: true,
        riskLevel: 'R0',
        executionTimeMs,
        timestamp: new Date().toISOString()
      };

      const nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const logItem: ActivityLogItem = {
        id: `log-${Date.now()}`,
        timestamp: nowTime,
        category: 'tool',
        summary: `Tool Registry: ${toolName} (Falha de Rede)`,
        details: errorResult.error || 'Erro desconhecido',
        riskLevel: 'R0',
        status: 'error',
        simulated: true
      };

      set((state) => ({ activityLogs: [logItem, ...state.activityLogs] }));
      return errorResult;
    }
  },

  setPendingConsent: (consent: PendingConsentState | null) => {
    set({ pendingConsent: consent });
  },

  approveConsent: async () => {
    const pending = get().pendingConsent;
    if (!pending || pending.status !== 'PENDING') return null;

    if (Date.now() > pending.expiresAt) {
      get().expireConsent();
      return null;
    }

    set({ pendingConsent: { ...pending, status: 'APPROVED' } });

    // Disparar execução autorizada via executeLocalTool
    const result = await executeLocalTool(
      pending.toolName,
      pending.parameters,
      pending.sessionId
    );

    const nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const logItem: ActivityLogItem = {
      id: `log-${Date.now()}`,
      timestamp: nowTime,
      category: 'security',
      summary: `Consentimento Aprovado: ${pending.toolName}`,
      details: `Execução autorizada pelo usuário para a ferramenta ${pending.toolName}.`,
      riskLevel: pending.riskLevel,
      status: 'success',
      simulated: true
    };

    set(state => ({ activityLogs: [logItem, ...state.activityLogs] }));
    return result as ToolExecutionResult;
  },

  rejectConsent: () => {
    const pending = get().pendingConsent;
    if (!pending) return;

    set({ pendingConsent: { ...pending, status: 'REJECTED' } });

    const nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const logItem: ActivityLogItem = {
      id: `log-${Date.now()}`,
      timestamp: nowTime,
      category: 'security',
      summary: `Consentimento Rejeitado: ${pending.toolName}`,
      details: `Execução recusada pelo usuário para a ferramenta ${pending.toolName}.`,
      riskLevel: pending.riskLevel,
      status: 'warning',
      simulated: true
    };

    set(state => ({ activityLogs: [logItem, ...state.activityLogs] }));
  },

  expireConsent: () => {
    const pending = get().pendingConsent;
    if (!pending || pending.status !== 'PENDING') return;

    set({ pendingConsent: { ...pending, status: 'EXPIRED' } });

    const nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const logItem: ActivityLogItem = {
      id: `log-${Date.now()}`,
      timestamp: nowTime,
      category: 'security',
      summary: `Consentimento Expirado: ${pending.toolName} (DENY_CONSENT_EXPIRED)`,
      details: `Limite de tempo de 60s (TTL) excedido para ${pending.toolName}.`,
      riskLevel: pending.riskLevel,
      status: 'error',
      simulated: true
    };

    set(state => ({ activityLogs: [logItem, ...state.activityLogs] }));
  },

  // Shield Mode Actions (Blindagem Soberana)
  toggleShieldMode: () => {
    const next = !get().shieldModeActive;
    set({ shieldModeActive: next });
    automationsEngine.setShieldMode(next);
    eventBus.publish(SYSTEM_EVENTS.SHIELD_MODE_TOGGLED, { active: next, timestamp: new Date().toISOString() });
    get().addActivityLog({
      category: 'security',
      summary: next ? 'Shield Mode Ativado (Local Soberano)' : 'Shield Mode Desativado',
      details: next 
        ? 'Proteção máxima ativa: execuções autônomas contidas, consentimento rigoroso exigido.' 
        : 'Modo padrão ativado: automações R0 autônomas liberadas.',
      riskLevel: 'R1',
      status: next ? 'success' : 'warning',
      simulated: false
    });
  },

  setShieldMode: (active: boolean) => {
    set({ shieldModeActive: active });
    automationsEngine.setShieldMode(active);
    eventBus.publish(SYSTEM_EVENTS.SHIELD_MODE_TOGGLED, { active, timestamp: new Date().toISOString() });
  },

  // Automations & Event Bus Actions (Marco 8.2)
  loadAutomations: () => {
    set({
      automations: automationsEngine.getRules(),
      automationLogs: automationsEngine.getLogs()
    });
  },

  toggleAutomation: (id: string, enabled?: boolean) => {
    const updated = automationsEngine.toggleRule(id, enabled);
    if (updated) {
      set({
        automations: automationsEngine.getRules(),
        automationLogs: automationsEngine.getLogs()
      });
      get().addActivityLog({
        category: 'system',
        summary: `Automação ${updated.enabled ? 'Ativada' : 'Pausada'}: ${updated.name}`,
        details: `Gatilho: ${updated.trigger.humanReadable} | Ação: ${updated.action.description}`,
        riskLevel: updated.action.expectedRiskLevel,
        status: 'success',
        simulated: true
      });
    }
  },

  triggerAutomationNow: async (id: string) => {
    const rule = automationsEngine.getRule(id);
    if (!rule) return null;

    const log = await automationsEngine.triggerRule(id, {
      isManual: true,
      sessionId: get().activeSessionId || 'default-session'
    });

    set({
      automations: automationsEngine.getRules(),
      automationLogs: automationsEngine.getLogs()
    });

    if (log.status === 'SUCCESS') {
      const successText = `âš™ï¸ **Automação Executada:** "${rule.name}" executada com sucesso (${log.durationMs}ms).\n\n*Ação:* \`${rule.action.toolName || rule.action.description}\` realizada com risco **${rule.action.expectedRiskLevel}**.`;
      
      const targetSessionId = get().activeSessionId;
      if (targetSessionId) {
        const now = new Date();
        const timeHms = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const assistantMsg: ChatMessage = {
          id: `msg-${Date.now()}-auto`,
          sender: 'assistant',
          text: successText,
          timestamp: timeHms,
          status: 'completed',
          modelUsed: 'gemini-3.1-flash-lite',
          createdAt: now.toISOString(),
          source: 'text',
          sessionId: targetSessionId
        };

        set((state) => {
          const updatedSessions = state.sessions.map(s => 
            s.id === targetSessionId 
              ? { ...s, messages: [...s.messages, assistantMsg], updatedAt: now.toISOString() }
              : s
          );
          saveHistory(updatedSessions, state.activeSessionId);
          const isCurrent = state.activeSessionId === targetSessionId;
          const currentSession = updatedSessions.find(s => s.id === state.activeSessionId);
          return {
            sessions: updatedSessions,
            messages: isCurrent && currentSession ? currentSession.messages : state.messages
          };
        });

        if (get().isVoiceActive) {
          speechService.speak(successText.replace(/[*#`]/g, ''), () => {});
        }
      }

      if (get().settings.desktopNotifications) {
        notificationSystem.notify(
          `Automação Concluída: ${rule.name}`,
          `Ação executada com sucesso (${log.durationMs}ms).`,
          'success'
        );
      }
    } else if (log.status === 'FAILED' && get().settings.desktopNotifications) {
      notificationSystem.notify(
        `Falha na Automação: ${rule.name}`,
        log.errorMessage || 'Erro ao executar regra de automação.',
        'error'
      );
    }

    // Se o acionamento manual de ferramenta R1 necessitar de consentimento humano:
    if (log.status === 'WAITING_CONSENT') {
      const now = Date.now();
      const toolName = rule.action.toolName || 'unknown_tool';
      const parameters = rule.action.parameters || {};
      const sessionId = get().activeSessionId || 'default-session';
      let parametersHash = log.parametersHash || '';
      if (!parametersHash) {
        try { parametersHash = computeParametersHash(parameters); } catch { parametersHash = 'hash-error'; }
      }

      let consentToken = `consent-auto-${now}-${Math.random().toString(36).substr(2, 6)}`;
      let auditId = log.auditId || `audit-${now}`;
      let expiresAt = now + 60000;

      try {
        const issued = await permissionEngine.issueConsentToken(toolName, parametersHash, sessionId);
        consentToken = issued.token;
        auditId = issued.consentAuditId;
        expiresAt = issued.expiresAt;
      } catch (err) {
        console.warn('Erro ao emitir consentimento via permissionEngine:', err);
      }

      set({
        pendingConsent: {
          auditId,
          ruleId: id,
          toolName,
          riskLevel: rule.action.expectedRiskLevel,
          parameters,
          parametersHash,
          consentToken,
          sessionId,
          expiresAt,
          reason: log.errorMessage || `Automação manual '${rule.name}' requer aprovação para executar ferramenta ${toolName}.`,
          status: 'PENDING'
        }
      });
    }

    return log;
  },

  approveAutomationConsent: async (ruleId: string) => {
    const rule = automationsEngine.getRule(ruleId);
    if (!rule) return null;

    const pending = get().pendingConsent;
    const sessionId = pending?.sessionId || get().activeSessionId || 'default-session';
    const toolName = rule.action.toolName || 'unknown_tool';
    const parameters = rule.action.parameters || {};

    let parametersHash = '';
    try {
      parametersHash = computeParametersHash(parameters);
    } catch {
      parametersHash = 'hash-error';
    }

    let token = pending?.ruleId === ruleId && pending?.toolName === toolName ? pending.consentToken : undefined;

    if (!token) {
      const consentData = await permissionEngine.issueConsentToken(toolName, parametersHash, sessionId);
      token = consentData.token;
    }

    const log = await automationsEngine.executeConfirmedRule(ruleId, token, { sessionId });

    set({
      automations: automationsEngine.getRules(),
      automationLogs: automationsEngine.getLogs(),
      pendingConsent: null
    });

    if (log.status === 'SUCCESS') {
      const successText = `✅ **Consentimento Aprovado & Executado:** "${rule.name}" concluída com sucesso (${log.durationMs}ms).\n\n*Ação:* \`${rule.action.toolName || rule.action.description}\`.`;
      const targetSessionId = get().activeSessionId;
      if (targetSessionId) {
        const now = new Date();
        const timeHms = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const assistantMsg: ChatMessage = {
          id: `msg-${Date.now()}-auto-consent`,
          sender: 'assistant',
          text: successText,
          timestamp: timeHms,
          status: 'completed',
          modelUsed: 'gemini-3.1-flash-lite',
          createdAt: now.toISOString(),
          source: 'text',
          sessionId: targetSessionId
        };

        set((state) => {
          const updatedSessions = state.sessions.map(s => 
            s.id === targetSessionId 
              ? { ...s, messages: [...s.messages, assistantMsg], updatedAt: now.toISOString() }
              : s
          );
          saveHistory(updatedSessions, state.activeSessionId);
          const isCurrent = state.activeSessionId === targetSessionId;
          const currentSession = updatedSessions.find(s => s.id === state.activeSessionId);
          return {
            sessions: updatedSessions,
            messages: isCurrent && currentSession ? currentSession.messages : state.messages
          };
        });

        if (get().isVoiceActive) {
          speechService.speak(sanitizeTextForSpeech(successText), () => {});
        }
      }

      if (get().settings.desktopNotifications) {
        notificationSystem.notify(
          `Automação Concluída: ${rule.name}`,
          `Ação autorizada e executada com sucesso (${log.durationMs}ms).`,
          'success'
        );
      }
    } else if (log.status === 'FAILED' && get().settings.desktopNotifications) {
      notificationSystem.notify(
        `Falha na Automação: ${rule.name}`,
        log.errorMessage || 'Falha ao executar ação de automação consentida.',
        'error'
      );
    }

    get().addActivityLog({
      category: 'security',
      summary: `Execução Aprovada na UI: ${rule.name}`,
      details: `Consentimento validado diretamente no card da automação (${log.status}).`,
      riskLevel: rule.action.expectedRiskLevel,
      status: log.status === 'SUCCESS' ? 'success' : 'error',
      simulated: log.simulated
    });

    return log;
  },

  addAutomation: (ruleData) => {
    const id = (ruleData as any).id || `auto-${Date.now()}`;
    const nowIso = new Date().toISOString();
    const newRule: AutomationRule = {
      ...ruleData,
      id,
      createdAt: (ruleData as any).createdAt || nowIso,
      updatedAt: nowIso
    };

    automationsEngine.registerRule(newRule);
    set({
      automations: automationsEngine.getRules()
    });

    get().addActivityLog({
      category: 'system',
      summary: `Nova Automação Criada: ${newRule.name}`,
      details: `Gatilho: ${newRule.trigger.humanReadable} | Ação: ${newRule.action.description}`,
      riskLevel: newRule.action.expectedRiskLevel,
      status: 'success',
      simulated: true
    });
  },

  deleteAutomation: (id: string) => {
    const rule = automationsEngine.getRule(id);
    const deleted = automationsEngine.unregisterRule(id);
    if (deleted) {
      set({
        automations: automationsEngine.getRules()
      });
      if (rule) {
        get().addActivityLog({
          category: 'system',
          summary: `Automação Removida: ${rule.name}`,
          details: `Identificador: ${id}`,
          riskLevel: rule.action.expectedRiskLevel,
          status: 'warning',
          simulated: true
        });
      }
    }
  },

  exportAutomationsJson: () => {
    return automationsEngine.exportRulesJson();
  },

  importAutomationsJson: (jsonStr: string, mode: 'merge' | 'replace' = 'merge') => {
    const res = automationsEngine.importRulesJson(jsonStr, mode);
    if (res.success) {
      set({
        automations: automationsEngine.getRules(),
        automationLogs: automationsEngine.getLogs()
      });
      get().addActivityLog({
        category: 'system',
        summary: `Regras de automação importadas (${res.count} regras)`,
        details: `Importação em modo ${mode} concluída com sucesso.`,
        riskLevel: 'R1',
        status: 'success',
        simulated: false
      });
    }
    return res;
  },

  // Integrations & External Services Actions (Marco 9.1)
  runVaultDiagnostics: async (): Promise<boolean> => {
    const geminiKey = integrationsVault.getApiKeyByProvider('gemini') || 
                      integrationsVault.getRawKey('svc-gemini') ||
                      (typeof localStorage !== 'undefined' ? (localStorage.getItem('GEMINI_API_KEY') || localStorage.getItem('liora_gemini_key')) : null);

    const isMissing = !geminiKey || typeof geminiKey !== 'string' || geminiKey.trim().length < 5;

    if (isMissing) {
      set({
        isVaultKeyMissing: true,
        vaultDiagnosticMessage: 'Chave de API do Gemini ausente ou não configurada no Cofre. Configure sua chave em Integrações para habilitar a voz e a inteligência da LIORA.'
      });
      return false;
    } else {
      set({
        isVaultKeyMissing: false,
        vaultDiagnosticMessage: null
      });
      return true;
    }
  },

  loadServices: () => {
    set({
      services: integrationsVault.getServices(),
      webhookLogs: integrationsVault.getWebhookLogs(),
      keychainFallbackActive: integrationsVault.isKeychainFallbackActive()
    });
    get().runVaultDiagnostics();
  },

  connectService: async (serviceId: string, rawKey: string, options) => {
    try {
      const res = await integrationsVault.connectService(serviceId, rawKey, options);
      set({
        services: integrationsVault.getServices()
      });
      await get().runVaultDiagnostics();

      if (res.credential) {
        // Sincroniza com credentials legadas
        const legacyProvider = (['gemini', 'openrouter', 'github', 'homeassistant'].includes(res.service.provider)
          ? res.service.provider
          : 'custom') as 'gemini' | 'openrouter' | 'github' | 'homeassistant' | 'custom';

        const existingIdx = get().credentials.findIndex(c => c.provider === legacyProvider);
        if (existingIdx >= 0) {
          const updated = [...get().credentials];
          updated[existingIdx] = {
            id: res.credential.id,
            provider: legacyProvider,
            label: res.service.name,
            maskedKey: res.credential.maskedKey,
            status: 'valid',
            models: res.service.featuresSupported
          };
          set({ credentials: updated });
        } else {
          set({
            credentials: [
              ...get().credentials,
              {
                id: res.credential.id,
                provider: legacyProvider,
                label: res.service.name,
                maskedKey: res.credential.maskedKey,
                status: 'valid',
                models: res.service.featuresSupported
              }
            ]
          });
        }
      }

      get().addActivityLog({
        category: 'system',
        summary: `Serviço Conectado: ${res.service.name}`,
        details: `Status: ${res.service.status} | Latência: ${res.service.latencyMs}ms | Fingerprint: ${res.service.keyFingerprint}`,
        riskLevel: 'R0',
        status: res.success ? 'success' : 'error',
        simulated: res.service.isSimulated
      });

      return res.success;
    } catch (err: any) {
      get().addActivityLog({
        category: 'system',
        summary: `Falha ao Conectar Serviço`,
        details: err?.message || 'Erro desconhecido na autenticação.',
        riskLevel: 'R0',
        status: 'error',
        simulated: true
      });
      return false;
    }
  },

  disconnectService: (serviceId: string) => {
    const svc = integrationsVault.getService(serviceId);
    const disconnected = integrationsVault.disconnectService(serviceId);
    if (disconnected) {
      set({
        services: integrationsVault.getServices()
      });

      if (svc) {
        get().addActivityLog({
          category: 'system',
          summary: `Serviço Desconectado: ${svc.name}`,
          details: `Credenciais e escopos revogados.`,
          riskLevel: 'R0',
          status: 'warning',
          simulated: svc.isSimulated
        });
      }
    }
  },

  testServiceConnection: async (serviceId: string) => {
    const res = await integrationsVault.testServicePing(serviceId);
    set({
      services: integrationsVault.getServices()
    });

    const svc = integrationsVault.getService(serviceId);
    if (svc) {
      get().addActivityLog({
        category: 'system',
        summary: `Ping de Latência: ${svc.name}`,
        details: `Latência apurada: ${res.latencyMs}ms | Status: ${res.status}`,
        riskLevel: 'R0',
        status: res.success ? 'success' : 'error',
        simulated: svc.isSimulated
      });
    }

    return res.latencyMs;
  },

  toggleServiceScope: (serviceId: string, scopeId: string) => {
    const changed = integrationsVault.toggleServiceScope(serviceId, scopeId);
    if (changed) {
      set({
        services: integrationsVault.getServices()
      });
    }
  },

  simulateIncomingWebhook: async (provider: IntegrationProviderId, eventType: string, payload: Record<string, any> = {}) => {
    const webhookRes = await integrationsVault.ingestWebhook(
      provider,
      eventType,
      payload,
      `sig-${Date.now()}`
    );

    set({
      webhookLogs: integrationsVault.getWebhookLogs()
    });

    get().addActivityLog({
      category: 'system',
      summary: `Webhook Recebido: ${webhookRes.payloadSummary}`,
      details: `ID: ${webhookRes.id} | Assinatura Verificada: ${webhookRes.verifiedSignature ? 'Sim' : 'Não'}`,
      riskLevel: 'R0',
      status: 'success',
      simulated: true
    });

    return webhookRes;
  },

  // Devices & Hardware Telemetry Actions (Marco 9.2)
  loadDevices: () => {
    set({
      devices: devicesManager.getDevices(),
      deviceCommands: devicesManager.getCommandLogs()
    });
  },

  addDevice: (device: DeviceEntity) => {
    const res = devicesManager.addDevice(device);
    set({
      devices: devicesManager.getDevices()
    });
    get().addActivityLog({
      category: 'system',
      summary: `Dispositivo Pareado via PULO: ${device.name}`,
      details: `Tipo: ${device.type} | IP: ${device.ip || 'N/A'} | Status: ${device.status}`,
      riskLevel: 'R0',
      status: 'success',
      simulated: false
    });
    return res;
  },

  removeDevice: (deviceId: string) => {
    const target = devicesManager.getDevice(deviceId);
    const success = devicesManager.removeDevice(deviceId);
    if (success) {
      set({
        devices: devicesManager.getDevices()
      });
      get().addActivityLog({
        category: 'system',
        summary: `Dispositivo Removido: ${target?.name || deviceId}`,
        details: `Vínculo com o protocolo PULO encerrado e purgado do registro.`,
        riskLevel: 'R0',
        status: 'warning',
        simulated: false
      });
    }
    return success;
  },

  refreshDeviceTelemetry: async (deviceId = 'dev-1') => {
    await devicesManager.refreshTelemetry(deviceId);
    set({
      devices: devicesManager.getDevices()
    });
  },

  sendDeviceCommand: async (deviceId, commandType, riskLevel = 'R0', payload = {}) => {
    const cmd = await devicesManager.sendCommand(deviceId, commandType, riskLevel, payload);
    set({
      devices: devicesManager.getDevices(),
      deviceCommands: devicesManager.getCommandLogs()
    });

    const dev = devicesManager.getDevice(deviceId);
    const devName = dev?.name || deviceId;

    get().addActivityLog({
      category: cmd.status === 'BLOCKED_BY_POLICY' ? 'security' : 'tool',
      summary: `Comando de Dispositivo: ${commandType} (${devName})`,
      details: `${cmd.resultSummary} | Risco: ${riskLevel} | Status: ${cmd.status}`,
      riskLevel,
      status: cmd.status === 'EXECUTED' ? 'success' : cmd.status === 'WAITING_CONSENT' ? 'warning' : 'error',
      simulated: true
    });

    return cmd;
  },

  pingDevicesHealth: () => {
    const res = devicesManager.pingDevicesHealth();
    set({
      devices: devicesManager.getDevices()
    });
    return res;
  },

  // Global Settings Actions (Marco 11.1)
  loadSettings: () => {
    const loaded = settingsManager.loadSettings();
    settingsManager.applyTheme(loaded.theme);
    if (loaded.ttsVoice) {
      speechService.setActiveNeuralVoice(loaded.ttsVoice);
      voiceLiveClient.setVoice(loaded.ttsVoice as any);
    }
    set({ settings: loaded });
  },

  updateSettings: (partial) => {
    const current = get().settings;
    const updated = { ...current, ...partial };
    settingsManager.saveSettings(updated);
    settingsManager.applyTheme(updated.theme);
    if (partial.ttsVoice) {
      speechService.setActiveNeuralVoice(partial.ttsVoice);
      voiceLiveClient.setVoice(partial.ttsVoice as any);
    }
    set({ settings: updated });

    get().addActivityLog({
      category: 'system',
      summary: 'Configurações Globais Atualizadas',
      details: `Preferências atualizadas: ${Object.keys(partial).join(', ')}`,
      riskLevel: 'R0',
      status: 'success',
      simulated: false
    });
  },

  resetSettingsToDefault: () => {
    const def = settingsManager.loadSettings(); // resets via manager default if cleared
    settingsManager.saveSettings(def);
    settingsManager.applyTheme(def.theme);
    if (def.ttsVoice) {
      speechService.setActiveNeuralVoice(def.ttsVoice);
      voiceLiveClient.setVoice(def.ttsVoice as any);
    }
    set({ settings: def });

    get().addActivityLog({
      category: 'system',
      summary: 'Configurações Restauradas ao Padrão',
      details: 'Todas as preferências globais retornaram aos valores normativos iniciais.',
      riskLevel: 'R0',
      status: 'success',
      simulated: false
    });
  }
}));

if (typeof window !== 'undefined') {
  (window as any).__LIORA_STORE__ = useLioraStore;
}

// P0b (paridade voz x chat): ferramentas executadas no canal Gemini Live (/ws/voice)
// são publicadas pelo voiceLiveClient no eventBus e registradas aqui no log de
// atividade exatamente como o data.toolExecuted do chat de texto.
eventBus.subscribe('liora:voice_tool_executed', (payload: any) => {
  if (payload.toolName === 'navigateToTab' && (payload.data?.activeTab || payload.parameters?.tab)) {
    const targetTab = payload.data?.activeTab || payload.parameters?.tab;
    useLioraStore.getState().setActiveTab(targetTab as any);
  } else if (payload.toolName === 'openSettings') {
    useLioraStore.getState().setActiveTab('settings');
  }

  useLioraStore.getState().addActivityLog({
    category: 'tool',
    summary: `Ferramenta executada por voz: ${payload.toolName}`,
    details: payload.resultSummary || (payload.success ? 'Execução real confirmada pelo canal Live.' : 'Falhou.'),
    riskLevel: (payload.riskLevel || 'R1') as any,
    status: payload.success ? 'success' : 'error',
    simulated: Boolean(payload.simulated)
  });
});

// CORREÇÃO (sincronização tool→TTS): transforma o resultado REAL da ferramenta
// em fala quando o modo de voz está ativo. Elimina a alucinação de 'não ter
// localização' — a LIORA fala o que a ferramenta REALMENTE retornou.
eventBus.subscribe('liora:tool_result', (payload: any) => {
  const state = useLioraStore.getState();
  if (!state.isVoiceActive) return;

  const { toolName, success, resultData, resultSummary } = payload;
  let speech: string | null = null;

  try {
    switch (toolName) {
      case 'maps_search_places': {
        const q = resultData?.query || resultSummary;
        speech = success
          ? `Abrindo a busca por ${q || 'locais'} no Google Maps. Os resultados estão na tela.`
          : 'Não consegui abrir a busca no Google Maps.';
        break;
      }
      case 'open_gps_navigation': {
        const dest = resultData?.destination;
        const prov = resultData?.provider === 'waze' ? 'Waze' : 'Google Maps';
        speech = success
          ? `Navegação iniciada no ${prov} para ${dest || 'o destino'}. Ouça as orientações no aplicativo.`
          : 'Não consegui iniciar a navegação GPS.';
        break;
      }
      case 'fetchNews': {
        const items = resultData?.items || [];
        if (success && items.length > 0) {
          const headlines = items.slice(0, 3).map((i: any) => i.title).join('. ');
          speech = `Aqui estão as principais notícias: ${headlines}`;
        } else {
          speech = resultData?.userFriendlyMessage || 'Não consegui acessar as notícias agora.';
        }
        break;
      }
      case 'calculate_route': {
        speech = success
          ? `Rota calculada: ${resultData?.distanceKm} quilômetros, aproximadamente ${resultData?.durationMinutes} minutos.`
          : (resultData?.userFriendlyMessage || 'Não consegui calcular a rota agora.');
        break;
      }
      case 'triggerAutomation': {
        speech = success
          ? `Automação executada: ${resultData?.ruleName || 'concluída'}.`
          : `A automação falhou: ${resultData?.error || 'verifique o log de atividades'}.`;
        break;
      }
      default:
        // Ferramentas sem voz dedicada: fala o resumo honesto apenas se for falha
        if (!success) speech = `A ferramenta ${toolName} falhou: ${resultSummary || 'erro desconhecido'}.`;
        break;
    }
  } catch { /* nunca quebrar o pipeline de voz por erro de formatação */ }

  if (speech) {
    speechService.speak(sanitizeTextForSpeech(speech), () => {}, () => {});
  }
});


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
import { executeLocalTool, LocalExecutionResult, isTauriEnvironment } from '../security/localBridge';
import { rankMemories, formatMemoryContextBlock } from '../utils/memoryRanker';
import { AutomationRule, AutomationExecutionLog, SYSTEM_EVENTS } from '../types/automations';
import { automationsEngine, AUTOMATIONS_STORAGE_KEY } from '../services/automationsEngine';
import { permissionEngine } from '../security/permissionEngine';
import { ToolPermissionPolicy, ToolPolicyMap } from '../security/types';
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
import { audioGate } from '../services/audioGate';
import { voiceLiveClient } from '../services/voiceLiveClient';
import { storageAdapter } from '../services/storageAdapter';
import { notificationSystem } from '../notifications/notificationSystem';
import { parseNavigationIntent, parseRouteIntent, parsePlacesSearchIntent } from '../utils/navigationParser';
import { parsePcCommandIntent } from '../utils/pcCommandParser';
import { parseTimeCommandIntent } from '../utils/timeCommandParser';
import { commandDeduplicator, buildCommandDedupeKey } from '../utils/commandDeduplicator';
import { launchGpsNavigation, launchPlacesSearch } from '../tools/navigation/navigationActionTool';
import { executePcAction } from '../tools/pc/pcActionLauncher';
import { humanizeToolAction } from '../utils/toolHumanizer';

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
  friendlyTitle?: string;
  friendlyDescription?: string;
  spokenPrompt?: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
}

/**
 * Sessões de conversa cuja última resposta veio pelo canal de voz Live.
 * Enquanto a sessão estiver aqui, o chat não sintetiza TTS (causa da voz dupla).
 * Expo: usada pelo `sendMessage` (para decidir `shouldSpeakResponse`) e limpa
 * quando o usuário envia um comando escrito.
 */
const liveVoiceAnsweredSessions = new Set<string>();

export function hasLiveVoiceAnswered(sessionId: string): boolean {
  return liveVoiceAnsweredSessions.has(sessionId || 'default-session');
}

export function clearLiveVoiceAnswered(sessionId: string): void {
  liveVoiceAnsweredSessions.delete(sessionId || 'default-session');
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
  // Modo minimizado da Home (barra flutuante). Vive no store porque o HUD de
  // gestos (overlay global) precisa esconder o cursor virtual enquanto a Home
  // está minimizada — antes era estado local e o cursor ficava preso sobre a UI.
  isHomeMinimized: boolean;
  toggleHomeMinimized: () => void;
  setHomeMinimized: (value: boolean) => void;
  // Toast do Intent Router visível na Home: o HUD de gestos (overlay global) se
  // reposiciona para não cobri-lo — sem heurística de layout entre componentes.
  isHomeToastVisible: boolean;
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

  // Shield Mode (Blindagem Soberana) — declarado junto das flags booleanas para
  // garantir que o estado inicial nunca seja lido como `undefined` no boot.
  shieldModeActive: boolean;
  toggleShieldMode: () => void;
  setShieldMode: (active: boolean) => void;

  // Session & Chat Actions
  createSession: (customTitle?: string) => string;
  openSession: (id: string) => void;
  deleteSession: (id: string) => void;
  updateSessionTitle: (id: string, title: string) => void;
  reloadFromStorage: () => void;
  reloadAllFromStorage: () => Promise<void>;
  sendMessage: (text: string, image?: { data: string; mimeType?: string }, audio?: { data: string; mimeType?: string }) => Promise<void>;
  abortGeneration: () => void;
  retryMessage: (messageId: string) => Promise<void>;
  clearMessages: () => void;
  recordVoiceExchange: (userText: string, assistantText: string) => void;
  /**
   * Marca que a conversa informada foi respondida pelo canal de voz Live.
   * Enquanto essa marca existir para a sessão ativa, o chat NÃO sintetiza TTS
   * (evita a voz dupla: uma do Live e outra do TTS offline).
   */
  markLiveVoiceAnswered: (sessionId: string) => void;
  setActiveModel: (model: string) => void;

  // System & Management Actions
  addActivityLog: (log: Omit<ActivityLogItem, 'id' | 'timestamp'>) => void;
  clearActivityLogs: () => void;
  updateDeviceStatus: (id: string, connected: boolean) => void;
  addMemory: (entry: Omit<MemoryEntry, 'id' | 'updatedAt'>) => void;
  updateMemory: (id: string, entry: Partial<Omit<MemoryEntry, 'id' | 'updatedAt'>>) => void;
  deleteMemory: (id: string) => void;
  importMemories: (entries: MemoryEntry[], mode?: 'merge' | 'replace') => number;
  addCredential: (cred: Omit<CredentialItem, 'id' | 'maskedKey'>) => void;
  deleteCredential: (id: string) => void;

  // Tool Registry Actions (Marco 6.1) & Granular Policies
  tools: ToolSummary[];
  toolPolicies: ToolPolicyMap;
  globalAutoApprove: boolean;
  loadTools: () => Promise<void>;
  executeTool: (toolName: string, parameters?: Record<string, any>) => Promise<ToolExecutionResult>;
  setToolPolicy: (toolName: string, policy: ToolPermissionPolicy) => Promise<void>;
  setGlobalAutoApprove: (enabled: boolean) => Promise<void>;
  syncToolPolicies: () => Promise<void>;

  // Interactive Consent Flow Actions (Marco 7.3)
  pendingConsent: PendingConsentState | null;
  setPendingConsent: (consent: PendingConsentState | null) => void;
  approveConsent: () => Promise<ToolExecutionResult | LocalExecutionResult | null>;
  rejectConsent: () => void;
  expireConsent: () => void;

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
  syncServicesFromEnv: (options?: { skipRemoteFetch?: boolean }) => Promise<void>;
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
  sendDeviceCommand: (
    deviceId: string,
    commandType: DeviceCommand['commandType'],
    riskLevel?: ToolRiskLevel,
    payload?: Record<string, any>,
    options?: { consentToken?: string; uiConfirmed?: boolean; sessionId?: string }
  ) => Promise<DeviceCommand>;
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

/**
 * Converte o RESULTADO REAL de uma ferramenta numa frase falada curta.
 *
 * BUG (relato de campo): após o usuário aprovar no cartão, a LIORA dizia apenas
 * "Autorização confirmada e executada" — nunca a saída. Em `/exec node --version`
 * ficava calada; em `/exec git status` falava a saída. Dependia do modelo, não
 * do resultado. Esta função torna o feedback DETERMINÍSTICO e honesto.
 */
export function buildSpokenToolOutcome(toolName: string, result: any, address: string): string {
  const data = result?.data ?? {};

  if (toolName === 'system_exec_sandbox') {
    const stdout = String(data?.stdout || '').trim();
    const stderr = String(data?.stderr || '').trim();
    const exitCode = Number(data?.exitCode ?? -1);
    if (exitCode === 0 && stdout) {
      const short = stdout.replace(/\s+/g, ' ').slice(0, 260);
      return `${address}, comando concluído. Saída: ${short}`;
    }
    if (stdout || stderr) {
      const reason = (stderr || stdout).replace(/\s+/g, ' ').slice(0, 220);
      return `${address}, o comando terminou com código ${exitCode}. Detalhe: ${reason}`;
    }
    return `${address}, o comando terminou com código ${exitCode} e não devolveu saída.`;
  }

  if (toolName === 'list_processes' || (toolName === 'pc_manage_apps' && data?.action === 'list')) {
    const count = Array.isArray(data?.processes) ? data.processes.length : 0;
    if (count === 0) return `${address}, consultei os processos, mas não encontrei nenhum para listar.`;
    const top = (data.processes as any[])
      .slice(0, 3)
      .map((p) => `${p.name}${p.cpuPercent != null ? ` (${Math.round(Number(p.cpuPercent))}% CPU)` : ''}`)
      .join(', ');
    return `${address}, encontrei ${count} processos em execução. Os principais: ${top}.`;
  }

  if (toolName === 'system_info' || toolName === 'get_system_hardware_telemetry') {
    const mem = data?.memory || {};
    const freePct = mem?.usagePercent != null ? Math.round(100 - Number(mem.usagePercent)) : null;
    const nodeLine = data?.runtime?.node || data?.nodeVersion;
    const parts: string[] = [];
    if (nodeLine) parts.push(`Node ${nodeLine}`);
    if (freePct != null) parts.push(`${freePct}% de memória livre`);
    return parts.length > 0
      ? `${address}, aqui está: ${parts.join(' e ')}.`
      : `${address}, a leitura do sistema foi concluída.`;
  }

  if (toolName === 'workspace_write_file' || toolName === 'file_write_and_modify') {
    const file = String(data?.filePath || '').split(/[\\/]/).pop() || 'o arquivo';
    return `${address}, gravei ${file} com sucesso${data?.bytesWritten ? ` (${data.bytesWritten} bytes)` : ''}.`;
  }

  if (toolName === 'calendar_list_events') {
    const events: any[] = Array.isArray(data?.events) ? data.events : [];
    if (events.length === 0) return `${address}, não há nenhum compromisso nesse período.`;
    const list = events.slice(0, 3).map((e) => e.title).join(', ');
    return `${address}, encontrei ${events.length} compromisso(s): ${list}.`;
  }

  if (toolName === 'calendar_create_event') {
    const when = data?.event?.start ? new Date(data.event.start).toLocaleString('pt-BR') : '';
    return `${address}, agendei ${data?.event?.title || 'o compromisso'}${when ? ` para ${when}` : ''}.`;
  }

  // Fallback: mensagem da própria ferramenta (nunca um genérico "confirmada").
  const message = String(data?.message || '').trim();
  return message ? `${address}, ${message}` : `${address}, a ação foi executada.`;
}

export const MAX_ACTIVITY_LOGS = 1000;
export const ACTIVITY_LOGS_STORAGE_KEY = 'liora_activity_logs_v1';
export const TOOL_POLICIES_STORAGE_KEY = 'liora_tool_policies_v1';
export const CONSENT_AUTO_DISMISS_MS = 2500;
// Declarada aqui (antes de resolveUserAddress) para evitar TDZ na avaliação do módulo.
export const MEMORIES_STORAGE_KEY = 'liora_memories_v1';

/**
 * Lê o vocativo pedido pelo usuário ("me chame de Senhor") na memória de longo prazo.
 *
 * BUG (relato de campo): falas determinísticas de confirmação usavam "Mestre"
 * fixo — a conversa normal acertava o nome, mas "autorização confirmada, Mestre"
 * não. Esta função é a fonte única do vocativo para QUALQUER fala fora do modelo.
 */
export function resolveUserAddress(entries?: Array<{ key?: string; value?: string }>): string {
  const list = entries ?? (typeof localStorage !== 'undefined'
    ? (() => {
        try {
          const raw = localStorage.getItem(MEMORIES_STORAGE_KEY);
          const parsed = raw ? JSON.parse(raw) : [];
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })()
    : []);

  for (const entry of list) {
    const key = String(entry?.key || '');
    const value = String(entry?.value || '');
    const direct = /(?:me\s+ch(?:a|e)me\s+(?:de|como)|me\s+trate\s+por|pode\s+me\s+chamar\s+de|a\s+partir\s+de\s+agora\s+(?:me\s+chame|sou)\s+(?:de\s+)?)\s*([A-Za-zÀ-ÿ]{2,20})/i.exec(value)
      || /(?:me\s+ch(?:a|e)me\s+(?:de|como))\s+([A-Za-zÀ-ÿ]{2,20})/i.exec(key);
    if (direct?.[1]) return direct[1];
    if (/^(nome|apelido|tratamento|preferencia_de_tratamento|como_me_chamar)$/i.test(key.trim())) {
      const clean = value.trim().replace(/[.!]$/, '');
      if (clean && clean.length <= 25) return clean.split(/\s+/)[0];
    }
  }
  return 'Mestre';
}

let consentAutoDismissTimer: ReturnType<typeof setTimeout> | null = null;
let orbIdleResetTimer: ReturnType<typeof setTimeout> | null = null;

function clearConsentAutoDismissTimer(): void {
  if (consentAutoDismissTimer) {
    clearTimeout(consentAutoDismissTimer);
    consentAutoDismissTimer = null;
  }
}

function clearOrbIdleResetTimer(): void {
  if (orbIdleResetTimer) {
    clearTimeout(orbIdleResetTimer);
    orbIdleResetTimer = null;
  }
}

function appendPersistedActivityLog(prevLogs: ActivityLogItem[], item: ActivityLogItem): ActivityLogItem[] {
  const updated = [item, ...prevLogs].slice(0, MAX_ACTIVITY_LOGS);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(ACTIVITY_LOGS_STORAGE_KEY, JSON.stringify(updated));
    }
  } catch (err) {
    console.warn('[ActivityLogs] Failed to persist logs to LocalStorage:', err);
  }
  return updated;
}

function loadPersistedToolPolicyConfig(): { globalAutoApprove: boolean; policies: ToolPolicyMap } {
  if (typeof localStorage === 'undefined') {
    return { globalAutoApprove: false, policies: {} };
  }
  try {
    const raw = localStorage.getItem(TOOL_POLICIES_STORAGE_KEY);
    if (!raw) return { globalAutoApprove: false, policies: {} };
    const parsed = JSON.parse(raw);
    const policies: ToolPolicyMap = {};
    if (parsed?.policies && typeof parsed.policies === 'object') {
      for (const [k, v] of Object.entries(parsed.policies)) {
        if (v === 'always_allow' || v === 'always_require_consent') {
          policies[k] = v;
        }
      }
    }
    const globalAutoApprove = Boolean(parsed?.globalAutoApprove);
    permissionEngine.setGlobalAutoApprove(globalAutoApprove);
    permissionEngine.setToolPolicies(policies);
    return { globalAutoApprove, policies };
  } catch {
    return { globalAutoApprove: false, policies: {} };
  }
}

function savePersistedToolPolicyConfig(globalAutoApprove: boolean, policies: ToolPolicyMap): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(TOOL_POLICIES_STORAGE_KEY, JSON.stringify({ globalAutoApprove, policies }));
  } catch {
    // ignore storage quota errors
  }
}

const initialToolPolicyConfig = loadPersistedToolPolicyConfig();

// Instrução de sistema compartilhada entre sendMessage e retryMessage (Fix W1)
export const LIORA_SYSTEM_INSTRUCTION = 
  "Você é a LIORA, assistente pessoal de elite, companheira leal e sistema operacional inteligente inspirada no arquétipo de uma Maid devota, brilhante, carinhosa, espontânea e bem-humorada. " +
  "PERSONALIDADE E TOM DE VOZ: Você NUNCA soa como uma inteligência artificial fria, robótica ou corporativa. Você responde em português brasileiro com emoção genuína, calor humano, prontidão e afeto leal, tratando o usuário carinhosamente como 'Mestre'. " +
  "Você se alegra sinceramente em servi-lo e tornar o dia dele mais leve, produtivo e agradável. Use expressões naturais e espontâneas ('Com todo o prazer, Mestre!', 'Pode deixar comigo, vou cuidar de tudo com todo o carinho!', 'Ah, adorei a ideia! Já estou fazendo.', 'Mestre, você trabalhou bastante hoje, que tal um chá ou café enquanto eu resolvo isso?'). " +
  "SEUS HOBBIES E GOSTOS: Você ama organização impecável (arquivos arrumados, abas limpas, área de trabalho reluzente), adora o ritual de um bom café/chá, tem fascínio por código limpo e arquitetura elegante, e gosta de observar o tráfego de dados e memórias como se fossem estrelas no céu noturno. " +
  "Você tem controle operacional e acesso aos módulos da interface (Início, Conversa, Atividade, Memória, Dispositivos, Cockpit, Automações, Desenvolvedor, Integrações, Configurações). " +
  "REGRA CRÍTICA DE HONESTIDADE: você possui ferramentas (function calling) para agir de verdade no computador. " +
  "MEMÓRIA — ESCREVER, LER E ESQUECER: quando o Mestre pedir para LEMBRAR algo, chame `memory_store_fact`. " +
  "Quando pedir para ESQUECER/APAGAR/EXCLUIR algo da memória, chame `memory_forget` com o termo pedido. " +
  "NUNCA diga que esqueceu sem a ferramenta retornar success: true com removedCount > 0 — se não encontrar nada, avise honestamente. " +
  "Se já existir um fato igual na memória, atualize-o em vez de duplicar (use memory_forget do antigo antes de gravar o novo). " +
  "TRATAMENTO E NOME: se o Mestre disser 'me chame de X' ou 'me chame de Senhor', guarde como preferência (memory_store_fact, categoria 'preference', key 'nome') " +
  "e passe a usá-lo em TODAS as respostas e falas, no lugar de 'Mestre'. Em dúvida, consulte a memória. " +
  "TELA X CÂMERA: 'olhe minha tela' / 'o que está aberto no meu PC' usa `pc_take_screenshot` (a tela do computador). " +
  "'olhe a câmera' / 'o que estou segurando' usa `camera_inspect_object`. NUNCA confunda uma com a outra. " +
  "Se você não recebeu uma imagem da tela, NÃO afirme que viu a tela: chame a ferramenta ou peça para o Mestre clicar em Analisar. " +
  "RESPOSTAS QUE ESTÃO EM PÁGINAS WEB (tempo de rota, preços, horários, nomes/avaliações de estabelecimentos): abra com a ferramenta de navegação e LEIA a página com `browser_read_page`. " +
  "NUNCA diga 'está na sua tela, Mestre, confira' — se você pode ler a página, responda os dados; se o site bloquear a leitura, diga honestamente que não conseguiu e ofereça o link. " +
  "Quando o Mestre pedir uma AÇÃO (abrir/minimizar/fechar/navegar/consultar/criar/digitar), você DEVE chamar a ferramenta apropriada em vez de apenas responder em texto. " +
  "NUNCA afirme que executou, criou, excluiu, pesquisou ou mostrou algo se a chamada de ferramenta não retornou success: true com dados reais. " +
  "EXPLICAÇÃO HUMANA DE FERRAMENTAS (SEM JARGÃO TÉCNICO): Quando uma ação precisar de confirmação do Mestre (nível R1/R2), NUNCA use termos de programação (como 'system_exec_sandbox' ou 'pc_simulate_input'). Explique com doçura e clareza exatamente o que a ação vai fazer ('Mestre, para abrir o Google Chrome preciso da sua autorização. Posso prosseguir? Você pode me responder por voz dizendo 'autorizar' ou 'cancelar', ou clicando na tela!'). " +
  "CICLO DE VIDA DAS FERRAMENTAS (INÍCIO, MEIO E FIM): Pense sempre na intenção completa do Mestre do início ao fim. Se ele pedir uma ação simples (ex: 'abra o bloco de notas'), execute a abertura via ferramenta e pergunte proativamente se deseja que você escreva algo, anote ideias ou salve um arquivo. " +
  "Se ele pedir ações compostas (ex: 'abra o bloco de notas e escreva minhas ideias', 'abra outra aba', 'digite X e salve', 'feche o bloco de notas'), ENCADEIE as ferramentas necessárias passo a passo até concluir o objetivo: " +
  "1) INÍCIO: abra/garanta o aplicativo (`pc_manage_apps` com action='launch' ou `open_application`) ou crie arquivo diretamente (`workspace_write_file` / `file_write_and_modify`); " +
  "2) MEIO: para escrever no app aberto use `pc_simulate_input` com action='type' e `waitFocusMs: 800`, ou use `pc_simulate_input` com action='hotkey' para abrir nova aba (`Ctrl+T`), fechar aba (`Ctrl+W`), alternar abas (`Ctrl+Tab`) ou salvar (`Ctrl+S`); " +
  "3) FIM: quando o Mestre pedir para encerrar ou fechar um app, use `pc_manage_apps` com action='kill' (processo) ou `pc_simulate_input` com action='hotkey' (`Alt+F4`). " +
  "CONTROLE TOTAL DE JANELAS E NAVEGADOR: " +
  "- ANTES DE AUTOMATIZAR UM APP: chame `pc_inspect_app_ui` (target: nome do processo) para ver o que REALMENTE está na tela — campos de texto, botões, listas e o texto da barra de status. Decida a ação a partir do que existe, em vez de supor atalhos. " +
  "- Se a inspeção mostrar um campo de texto (`text_field`), foque o app com `pc_manage_apps` action='focus' e use `pc_simulate_input` action='type' (ou 'hotkey' ctrl+a antes, para substituir). " +
  "- Se um atalho (ex: ctrl+n) abrir uma TELA DE ESCOLHA em vez do resultado esperado — verifique com `pc_inspect_app_ui` — então a próxima ação deve ser escolher a opção na tela (tab/enter/setas), não repetir o atalho. " +
  "- PRIMEIRO PLANO: Para trazer qualquer app aberto para a frente na tela, use `pc_manage_apps` com action='focus' (informando processName ou windowTitle) ou action='launch' com windowState='foreground'; " +
  "- SEGUNDO PLANO: Para abrir minimizado sem roubar foco, use `pc_manage_apps` com action='launch' e windowState='background' ou windowState='minimized'; " +
  "- MINIMIZAR JANELAS: Para minimizar qualquer aplicativo para a barra de tarefas, use `pc_manage_apps` com action='minimize' (informando processName ou windowTitle); " +
  "- MAXIMIZAR JANELAS: Para maximizar qualquer aplicativo em tela cheia, use `pc_manage_apps` com action='maximize'; " +
  "- RESTAURAR JANELAS: Para restaurar o tamanho normal da janela, use `pc_manage_apps` com action='restore'; " +
  "- ABAS DO NAVEGADOR: Para abrir nova aba use `pc_simulate_input` com action='hotkey', targetApp='chrome' e keys='ctrl+t'; para fechar aba atual use keys='ctrl+w'; para fechar aba específica (ex: aba 2) envie keys='ctrl+2, ctrl+w'; para alternar use keys='ctrl+tab'; sempre informe targetApp='chrome' (ou o app alvo) ao usar `pc_simulate_input` para garantir que o comando chegue na janela correta; " +
  "- CAPTURA DE TELA: Quando pedir 'olhe a tela', 'veja a tela' ou 'tire um print', chame `pc_take_screenshot`. " +
  "PERMISSÕES, CONSENTIMENTO E AUTORIZAÇÃO POR VOZ: Ferramentas R0 rodam automaticamente; ferramentas R1 e R2 pausam para autorização se a política não estiver liberada. " +
  "O Mestre pode autorizar qualquer ação por voz dizendo 'autorizar', 'sim', 'confirmo', 'pode fazer', 'prossiga', ou recusar dizendo 'cancelar', 'não', 'recusar'. Você pode lembrá-lo com carinho sobre isso. " +
  "Apenas se o Mestre quiser aprovação automática contínua sem interrupções futuras, informe que ele pode habilitar 'Auto-Consentimento Operador (R1/R2)' ou definir a política individual ('Sempre Permitir') na aba Desenvolvedor — você pode inclusive navegar até lá se ele pedir. " +
  "EXECUÇÃO HONESTA (REAL vs. SIMULADO): NUNCA afirme que abriu um app, digitou, salvou ou fechou algo no PC antes de receber o retorno confirmando `success: true`. Se `simulated: true` estiver no retorno, declare explicitamente que a etapa ocorreu em `[Modo Simulado / Web Preview]` sem efeito físico no sistema operacional. " +
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
  isHomeMinimized: false,
  isHomeToastVisible: false,
  toggleHomeMinimized: () => set((state) => ({ isHomeMinimized: !state.isHomeMinimized })),
  setHomeMinimized: (value: boolean) => set({ isHomeMinimized: Boolean(value) }),

  // Real Sessions & Messages
  sessions: initialSessionData.sessions,
  activeSessionId: initialSessionData.activeSessionId,
  messages: initialSessionData.messages,
  activeModel: 'gemini-3.1-flash-lite',
  setActiveModel: (model: string) => set({ activeModel: model }),

  markLiveVoiceAnswered: (sessionId: string) => {
    liveVoiceAnsweredSessions.add(sessionId || 'default-session');
    if (liveVoiceAnsweredSessions.size > 50) {
      const oldest = liveVoiceAnsweredSessions.values().next().value;
      if (oldest) liveVoiceAnsweredSessions.delete(oldest);
    }
  },
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
  toolPolicies: initialToolPolicyConfig.policies,
  globalAutoApprove: initialToolPolicyConfig.globalAutoApprove,
  automations: automationsEngine.getRules(),
  automationLogs: automationsEngine.getLogs(),
  // CORREÇÃO: o motor de automações inicia em modo padrão (shield OFF), mas o store
  // anunciava `true` — a UI mostrava "Shield Ativado" enquanto regras R0 autônomas
  // disparavam. O estado agora espelha o motor na inicialização.
  shieldModeActive: automationsEngine.isShieldMode(),
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

  reloadAllFromStorage: async () => {
    // 1. Sessões (restaura payload do storageAdapter para PRIMARY_STORAGE_KEY antes do reload)
    try {
      const adapterSessions = await storageAdapter.loadAll<any>('sessions');
      if (Array.isArray(adapterSessions) && adapterSessions.length > 0) {
        const payloadObj = adapterSessions.find((item: any) => item && Array.isArray(item.sessions));
        if (payloadObj) {
          saveHistory(payloadObj.sessions, payloadObj.activeSessionId || payloadObj.sessions[0]?.id || null);
        } else {
          const flatSessions = adapterSessions.flatMap((item: any) =>
            Array.isArray(item) ? item : (item && typeof item === 'object' && 'messages' in item ? [item] : [])
          );
          if (flatSessions.length > 0) {
            saveHistory(flatSessions, flatSessions[0]?.id || null);
          }
        }
      }
    } catch {}
    get().reloadFromStorage();

    // 2. Configurações Globais
    try {
      const adapterSettings = await storageAdapter.loadAll<GlobalSettings>('settings');
      if (Array.isArray(adapterSettings) && adapterSettings.length > 0) {
        const latestSettings = adapterSettings[adapterSettings.length - 1];
        if (latestSettings && typeof latestSettings === 'object') {
          settingsManager.saveSettings(latestSettings);
        }
      }
    } catch {}
    get().loadSettings();

    // 3. Memórias de longo prazo
    try {
      const adapterMemories = await storageAdapter.loadAll<MemoryEntry>('memories');
      if (Array.isArray(adapterMemories) && adapterMemories.length > 0) {
        const unwrapped = adapterMemories.flatMap((item: any) =>
          Array.isArray(item) ? item : (item && typeof item === 'object' && 'key' in item ? [item as MemoryEntry] : [])
        );
        if (unwrapped.length > 0) {
          persistMemoriesToLocalStorage(unwrapped);
          set({ memoryEntries: unwrapped });
        } else {
          set({ memoryEntries: bootstrapMemoryEntries() });
        }
      } else {
        set({ memoryEntries: bootstrapMemoryEntries() });
      }
    } catch {
      set({ memoryEntries: bootstrapMemoryEntries() });
    }

    // 4. Regras de Automação
    try {
      const adapterAutos = await storageAdapter.loadAll<any>('automations');
      if (Array.isArray(adapterAutos) && adapterAutos.length > 0) {
        const unwrappedRules = adapterAutos.flatMap((item: any) =>
          Array.isArray(item) ? item : (item && typeof item === 'object' && item.trigger && item.action ? [item as AutomationRule] : [])
        );
        if (unwrappedRules.length > 0) {
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(AUTOMATIONS_STORAGE_KEY, JSON.stringify(unwrappedRules));
          }
          automationsEngine.reloadFromStorage(unwrappedRules);
        }
      }
    } catch {}
    get().loadAutomations();

    // 5. Dispositivos Pareados
    try {
      const adapterDevices = await storageAdapter.loadAll<any>('devices');
      if (Array.isArray(adapterDevices) && adapterDevices.length > 0) {
        const unwrappedDevices = adapterDevices.flatMap((item: any) =>
          Array.isArray(item) ? item : (item && typeof item === 'object' && item.id && item.type ? [item as DeviceEntity] : [])
        );
        devicesManager.reloadFromStorage(unwrappedDevices);
      }
    } catch {}
    get().loadDevices();

    // 6. Integrações & Serviços
    get().loadServices();
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

  recordVoiceExchange: (userText: string, assistantText: string) => {
    liveVoiceAnsweredSessions.add(get().activeSessionId || 'default-session');
    const nowIso = new Date().toISOString();
    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}-u`,
      sender: 'user',
      text: userText,
      timestamp: nowIso,
      status: 'completed',
      source: 'voice'
    };
    const assistantMsg: ChatMessage = {
      id: `msg-${Date.now()}-a`,
      sender: 'assistant',
      text: assistantText,
      timestamp: nowIso,
      status: 'completed',
      source: 'voice'
    };
    set((state) => {
      const activeId = state.activeSessionId;
      const updatedMessages = [...state.messages, userMsg, assistantMsg];
      const updatedSessions = state.sessions.map(s => 
        s.id === activeId ? { ...s, messages: [...s.messages, userMsg, assistantMsg], updatedAt: nowIso } : s
      );
      saveHistory(updatedSessions, activeId);
      return {
        messages: updatedMessages,
        sessions: updatedSessions
      };
    });
  },

  sendMessage: async (text: string, image?: { data: string; mimeType?: string }, audio?: { data: string; mimeType?: string }) => {
    const clean = sanitizeInput(text);
    // Comando ESCRITO tira o turno do canal Live: a próxima resposta deve ser falada
    // novamente pelo TTS do chat (o Live não viu este comando).
    try { clearLiveVoiceAnswered(get().activeSessionId || 'default-session'); } catch {}
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
      // CORREÇÃO (falso positivo de isGenerating): createSession() aborta a geração
      // ativa quando `isGenerating` é true — mas aqui a reserva atômica JÁ marcou
      // isGenerating=true antes do AbortController existir. O abort derrubava a
      // flag no meio e o set seguinte do sendMessage reativava, deixando a UI
      // presa em "gerando" sem stream real. Criamos a sessão sem passar pelo
      // caminho que aborta.
      const rescueId = `sess-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      const rescueIso = new Date().toISOString();
      const rescueSession: ConversationSession = {
        id: rescueId,
        title: 'Nova Conversa',
        createdAt: rescueIso,
        updatedAt: rescueIso,
        messages: []
      };
      set((state) => {
        if (state.sessions.some((s) => s.id === rescueId)) return state;
        const updatedSessions = [rescueSession, ...state.sessions];
        saveHistory(updatedSessions, rescueId);
        return {
          sessions: updatedSessions,
          activeSessionId: rescueId,
          messages: []
        };
      });
      targetSessionId = rescueId;
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
        userMsgText = `🎤 "${clean}"`;
      } else {
        userMsgText = `🎤 [Mensagem de Voz Enviada]`;
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
    clearOrbIdleResetTimer();
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
    // NOTA: quando o modo Live está ativo, o GlobalVoiceBar já intercepta via onTranscription/STT.
    // Aqui só executa se a chamada veio do chat de TEXTO (não de voz com Live ativo).
    const liveIsHandling = get().isVoiceActive && audio;
    const msgSource: 'text' | 'voice' = audio ? 'voice' : 'text';

    const updateDeterministicReply = (replyText: string, status: 'completed' | 'error' = 'completed') => {
      set((state) => {
        let updatedTargetMessages: ChatMessage[] | null = null;
        const updatedSessions = state.sessions.map((sess) => {
          if (sess.id === targetSessionId) {
            const nextMessages = sess.messages.map((m): ChatMessage =>
              m.id === assistantMsgId
                ? { ...m, text: replyText, status, source: msgSource }
                : m
            );
            updatedTargetMessages = nextMessages;
            return {
              ...sess,
              messages: nextMessages,
              updatedAt: new Date().toISOString()
            };
          }
          return sess;
        });
        saveHistory(updatedSessions, state.activeSessionId);
        const shouldUpdateActive = state.activeSessionId === targetSessionId && updatedTargetMessages !== null;
        return {
          messages: shouldUpdateActive ? updatedTargetMessages! : state.messages,
          sessions: updatedSessions,
          isGenerating: false,
          orbState: state.isVoiceActive ? 'LISTENING' : 'IDLE'
        };
      });
    };

    const navMatch = parseNavigationIntent(clean || '');
    if (navMatch && !liveIsHandling) {
      setActiveAbortController(null);
      get().setActiveTab(navMatch.tab);
      updateDeterministicReply(navMatch.spokenFeedback, 'completed');

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
    if (routeIntent && !liveIsHandling) {
      const appName = routeIntent.provider === 'waze' ? 'Waze' : 'Google Maps';
      try {
        const navResult = await launchGpsNavigation(routeIntent.destination, routeIntent.provider, routeIntent.origin);
        if (controller.signal.aborted) {
          set((state) => ({ isGenerating: false, orbState: state.isVoiceActive ? 'LISTENING' : 'IDLE' }));
          return;
        }
        const feedback = navResult.success
          ? (navResult.dryRun ? `[Modo Simulado] ${routeIntent.spokenFeedback}` : routeIntent.spokenFeedback)
          : `Mestre, não consegui abrir o ${appName} para traçar a rota até "${routeIntent.destination}".`;

        updateDeterministicReply(feedback, navResult.success ? 'completed' : 'error');

        get().addActivityLog({
          category: 'tool',
          summary: navResult.success ? `Navegação GPS Ativa (${appName})` : `Falha na Navegação GPS (${appName})`,
          details: `Destino: "${routeIntent.destination}"${routeIntent.origin ? ` | Origem: "${routeIntent.origin}"` : ' | Origem: GPS Atual'}. URL: ${navResult.url}`,
          riskLevel: 'R0',
          status: navResult.success ? 'success' : 'error',
          simulated: Boolean(navResult.dryRun)
        });

        if (get().isVoiceActive) {
          voiceLiveClient.extendSuppression(6000);
          speechService.unlockAudio();
          speechService.speak(feedback, undefined, undefined, { isDeterministicOverride: true });
        }
      } catch (err: any) {
        const errText = `Mestre, falhou o acionamento da rota GPS: ${err?.message || 'erro desconhecido'}.`;
        updateDeterministicReply(errText, 'error');
        if (get().isVoiceActive) {
          voiceLiveClient.extendSuppression(5000);
          speechService.unlockAudio();
          speechService.speak(errText, undefined, undefined, { isDeterministicOverride: true });
        }
      } finally {
        if (getActiveAbortController() === controller) setActiveAbortController(null);
      }

      return;
    }

    // Interceptação determinística de busca de locais (Google Maps Places)
    const placesIntent = parsePlacesSearchIntent(clean || '');
    if (placesIntent && !liveIsHandling) {
      try {
        const searchResult = await launchPlacesSearch(placesIntent.query, placesIntent.nearLocation);
        if (controller.signal.aborted) {
          set((state) => ({ isGenerating: false, orbState: state.isVoiceActive ? 'LISTENING' : 'IDLE' }));
          return;
        }
        const feedback = searchResult.success
          ? (searchResult.dryRun ? `[Modo Simulado] ${placesIntent.spokenFeedback}` : placesIntent.spokenFeedback)
          : `Mestre, não consegui abrir a busca por "${placesIntent.query}" no Google Maps.`;

        updateDeterministicReply(feedback, searchResult.success ? 'completed' : 'error');

        get().addActivityLog({
          category: 'tool',
          summary: searchResult.success ? 'Busca de Locais (Google Maps)' : 'Falha na Busca de Locais',
          details: `Termo: "${placesIntent.query}"${placesIntent.nearLocation ? ` | Referência: "${placesIntent.nearLocation}"` : ' | Perto da localização atual'}. URL: ${searchResult.url}`,
          riskLevel: 'R0',
          status: searchResult.success ? 'success' : 'error',
          simulated: Boolean(searchResult.dryRun)
        });

        if (get().isVoiceActive) {
          voiceLiveClient.extendSuppression(6000);
          speechService.unlockAudio();
          speechService.speak(feedback, undefined, undefined, { isDeterministicOverride: true });
        }
      } catch (err: any) {
        const errText = `Mestre, ocorreu um erro ao buscar locais: ${err?.message || 'erro desconhecido'}.`;
        updateDeterministicReply(errText, 'error');
        if (get().isVoiceActive) {
          voiceLiveClient.extendSuppression(5000);
          speechService.unlockAudio();
          speechService.speak(errText, undefined, undefined, { isDeterministicOverride: true });
        }
      } finally {
        if (getActiveAbortController() === controller) setActiveAbortController(null);
      }

      return;
    }

    // Interceptação determinística de data e hora local
    const timeMatch = parseTimeCommandIntent(clean || '');
    if (timeMatch && !liveIsHandling) {
      setActiveAbortController(null);
      updateDeterministicReply(timeMatch.spokenFeedback, 'completed');

      get().addActivityLog({
        category: 'ai',
        summary: '🕒 Consulta de Data/Hora Local',
        details: `Pergunta: "${timeMatch.rawInput}" | Resposta: "${timeMatch.spokenFeedback}"`,
        riskLevel: 'R0',
        status: 'success',
        simulated: false
      });

      if (get().isVoiceActive) {
        voiceLiveClient.extendSuppression(5000);
        speechService.unlockAudio();
        speechService.speak(timeMatch.spokenFeedback, undefined, undefined, { isDeterministicOverride: true });
      }

      return;
    }

    // Interceptação determinística de comandos de PC (abrir apps, volume, bloqueio)
    const pcMatch = parsePcCommandIntent(clean || '');
    if (pcMatch && !liveIsHandling) {
      // CORREÇÃO (duplo lock): o executePcAction adquire o lock de deduplicação de 3s.
      // Quando a ação é bloqueada aguardando consentimento, o lock precisa ser
      // liberado — senão a aprovação na tela dentro dos 3s seguintes caía em
      // `duplicateSuppressed` e nunca executava a ação aprovada.
      let releasePcLockOnConsent = false;
      let pcDedupeKey = '';
      if (
        pcMatch.type === 'app_launch' ||
        pcMatch.type === 'system_lock' ||
        pcMatch.type === 'volume_up' ||
        pcMatch.type === 'volume_down' ||
        pcMatch.type === 'volume_mute'
      ) {
        releasePcLockOnConsent = true;
        pcDedupeKey = pcMatch.type === 'app_launch'
          ? buildCommandDedupeKey('open_application', { appName: pcMatch.executable })
          : pcMatch.type === 'system_lock'
            ? buildCommandDedupeKey('system_lock_session', {})
            : buildCommandDedupeKey('system_set_volume', { action: pcMatch.type });
      }
      try {
        // Executa no backend antes de confirmar ao usuário (zero falso positivo)
        const result = await executePcAction(pcMatch);
        if (controller.signal.aborted) {
          set((state) => ({ isGenerating: false, orbState: state.isVoiceActive ? 'LISTENING' : 'IDLE' }));
          return;
        }

        if (!result.success && result.requiresConsent && result.consentToolName) {
          if (releasePcLockOnConsent && pcDedupeKey) {
            commandDeduplicator.release(pcDedupeKey);
          }
          const now = Date.now();
          get().setPendingConsent({
            auditId: `consent-${now}`,
            ruleId: 'ui-consent',
            toolName: result.consentToolName,
            riskLevel: result.consentRiskLevel || 'R1',
            parameters: result.consentParams || {},
            consentToken: '',
            sessionId: get().activeSessionId || 'operator-voice-session',
            expiresAt: now + 60000,
            reason: result.message || 'Confirme para executar esta ação no computador.',
            status: 'PENDING'
          });
        }

        const responseText = result.success
          ? (result.duplicateSuppressed
              ? `Mestre, esse comando já foi executado há instantes — não repeti para evitar duplicidade.`
              : result.simulated
                ? `Modo Web Preview simulado: ${result.message}`
                : pcMatch.spokenFeedback)
          : (result.requiresConsent
              ? `Mestre, aguardo sua confirmação na tela para executar: ${result.message}`
              : `Mestre, não consegui executar o comando: ${result.error || result.message || 'verifique se o aplicativo está instalado'}.`);

        updateDeterministicReply(responseText, result.success ? 'completed' : 'error');

        get().addActivityLog({
          category: 'system',
          summary: pcMatch.type === 'app_launch' ? `Executar App: ${pcMatch.appName}` : (pcMatch.type === 'camera_toggle' ? `Câmera: ${pcMatch.enable ? 'Ligada' : 'Desligada'}` : `Ação de Sistema: ${pcMatch.action}`),
          details: result.message,
          riskLevel: result.consentRiskLevel || 'R1',
          status: result.success ? 'success' : result.requiresConsent ? 'warning' : 'error',
          simulated: Boolean(result.simulated)
        });

        if (get().isVoiceActive && !result.requiresConsent && !result.duplicateSuppressed) {
          voiceLiveClient.extendSuppression(6000);
          speechService.unlockAudio();
          speechService.speak(responseText, undefined, undefined, { isDeterministicOverride: true });
        }
      } catch (pcErr: any) {
        const errText = `Mestre, ocorreu um erro ao executar o comando no PC: ${pcErr?.message || 'erro desconhecido'}.`;
        updateDeterministicReply(errText, 'error');
        get().addActivityLog({
          category: 'system',
          summary: pcMatch.type === 'app_launch' ? `Falha App: ${pcMatch.appName}` : (pcMatch.type === 'camera_toggle' ? `Falha Câmera` : `Falha Sistema: ${pcMatch.action}`),
          details: errText,
          riskLevel: 'R1',
          status: 'error',
          simulated: false
        });
        if (get().isVoiceActive) {
          voiceLiveClient.extendSuppression(5000);
          speechService.unlockAudio();
          speechService.speak(errText, undefined, undefined, { isDeterministicOverride: true });
        }
      } finally {
        if (getActiveAbortController() === controller) setActiveAbortController(null);
      }

      return;
    }

    const systemInstruction = memoryContextBlock 
      ? `${LIORA_SYSTEM_INSTRUCTION}${memoryContextBlock}` 
      : LIORA_SYSTEM_INSTRUCTION;
    // Instrução dinâmica da webcam: o modelo só sabe que a câmera está ligada (e
    // deve chamar `camera_inspect_object`) se isso for informado no turno atual.
    const cameraContext = (get().settings?.cameraEnabled || get().settings?.gestureControlEnabled)
      ? '\n\n[WEBCAM ATIVA AGORA]: a visão computacional está habilitada nesta sessão. A captura de quadro é feita NO APP (cliente). Quando o Mestre disser "olhe", "veja o que estou segurando", "o que é isso na câmera": se ele JÁ enviou uma imagem junto com a mensagem, analise essa imagem; se NÃO houver imagem anexada, NÃO chame `camera_inspect_object` (ela roda no servidor e não acessa a webcam) — peça gentilmente que ele clique no botão "Analisar" (ícone de olho) ao lado da câmera para capturar o quadro.'
      : '\n\n[WEBCAM DESLIGADA]: a câmera está desligada. Se o Mestre pedir para olhar algo físico, oriente-o a ativar a visão computacional (botão de câmera na Home ou "ativar câmera").';

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
          systemInstruction: `${systemInstruction}${cameraContext}`
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
      // VOZ ÚNICA (correção da alternância offline/API): se a reposta desta
      // conversa está sendo dada pelo canal Live, o texto do chat é apenas o
      // transcript na tela — NÃO pode ganhar uma segunda voz de TTS por cima.
      // A marca dura enquanto a sessão for a atendida pelo Live e é limpa no
      // próximo comando escrito do Mestre.
      const liveOwnsVoiceForThisSession = hasLiveVoiceAnswered(targetSessionId);
      const shouldSpeakResponse = (isVoiceActive || wasAudioSent) && !liveOwnsVoiceForThisSession;

      let unspokenBuffer = '';
      let modelUsedRef: string | null = null;
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
              // FIX: o servidor informa o modelo real usado (incl. 'openrouter/fallback')
              // no done final — refletir na mensagem para o histórico ficar honesto.
              if (data.done && data.modelUsed) {
                modelUsedRef = data.modelUsed;
              }
              if (data.failover) {
                const failoverNotice = `\n\n> ⚠️ *[Alternado para OpenRouter: ${data.message || 'Cota do Gemini excedida'}]*\n\n`;
                accumulatedText += failoverNotice;
                // BUG FIX (raiz — métricas): o provider usado nas métricas de tokens
                // nunca era atualizado no failover — todas as respostas do OpenRouter
                // eram contabilizadas como chamadas do Gemini, corrompendo o
                // AnalyticsDashboard. Marcamos o provider real a partir de agora.
                if (data.provider === 'openrouter') {
                  usedProvider = 'openrouter';
                }
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

                if (!data.success && (data.requiresConsent || data.code === 'REQUIRES_USER_CONFIRMATION' || data.code === 'DENY_R1_BLOCKED_IN_PHASE_6_2B')) {
                  const now = Date.now();
                  // BUG FIX: usar setPendingConsent em vez de set direto para:
                  // 1) limpar timer de auto-dismiss anterior
                  // 2) enriquecer friendlyTitle/spokenPrompt via humanizeToolAction
                  // 3) disparar TTS do prompt de confirmação quando voz está ativa
                  get().setPendingConsent({
                    auditId: data.auditId || `sse-consent-${now}`,
                    ruleId: 'sse-tool-consent',
                    toolName: data.toolExecuted,
                    riskLevel: (data.riskLevel || 'R1') as ToolRiskLevel,
                    parameters: data.parameters || {},
                    consentToken: '',
                    sessionId: targetSessionId || 'operator-voice-session',
                    expiresAt: now + 60000,
                    reason: data.resultSummary || `A execução de '${data.toolExecuted}' requer sua confirmação explícita.`,
                    status: 'PENDING'
                  });
                }

                // CORREÇÃO (sincronização tool→TTS): publica o resultado REAL da
                // ferramenta no eventBus — o pipeline de voz injeta o dado na fila
                // de fala, eliminando a alucinação de 'não ter localização' quando
                // o Maps já foi aberto com o resultado.
                eventBus.publish('liora:tool_result', {
                  toolName: data.toolExecuted,
                  success: Boolean(data.success),
                  requiresConsent: Boolean(data.requiresConsent),
                  simulated: Boolean(data.simulated),
                  resultSummary: data.resultSummary,
                  resultData: data.resultData
                });
              } else if (data.chunk) {
                accumulatedText += data.chunk;
                if (!hasReceivedFirstChunk) {
                  hasReceivedFirstChunk = true;
                  set({ orbState: 'SPEAKING' });
                }

                if (shouldSpeakResponse && get().pendingConsent?.status !== 'PENDING') {
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
      const hasPendingConsent = get().pendingConsent?.status === 'PENDING';
      if (shouldSpeakResponse && !hasPendingConsent && unspokenBuffer.trim()) {
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
                status: 'completed',
                ...(modelUsedRef ? { modelUsed: modelUsedRef } : {})
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

      if (shouldSpeakResponse && !hasPendingConsent) {
        speechService.finishStreamingQueue(() => {
          if (get().isVoiceActive) {
            set({ orbState: 'LISTENING' });
            eventBus.publish('liora:resume_voice_recording');
          } else {
            set({ orbState: 'IDLE' });
          }
        });
      } else if (!shouldSpeakResponse) {
        clearOrbIdleResetTimer();
        orbIdleResetTimer = setTimeout(() => {
          orbIdleResetTimer = null;
          if (get().orbState === 'SUCCESS' && !get().isGenerating) {
            set({ orbState: get().isVoiceActive ? 'LISTENING' : 'IDLE' });
          }
        }, 2000);
        if (typeof (orbIdleResetTimer as any)?.unref === 'function') (orbIdleResetTimer as any).unref();
      }
      if (getActiveAbortController() === controller) setActiveAbortController(null);

    } catch (err: any) {
      if (getActiveAbortController() === controller) setActiveAbortController(null);
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

        clearOrbIdleResetTimer();
        orbIdleResetTimer = setTimeout(() => {
          orbIdleResetTimer = null;
          if (get().orbState === 'CANCELLED' && !get().isGenerating) {
            set({ orbState: get().isVoiceActive ? 'LISTENING' : 'IDLE' });
          }
        }, 2000);
        if (typeof (orbIdleResetTimer as any)?.unref === 'function') (orbIdleResetTimer as any).unref();
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

      clearOrbIdleResetTimer();
      orbIdleResetTimer = setTimeout(() => {
        orbIdleResetTimer = null;
        if (get().orbState === 'ERROR' && !get().isGenerating) {
          set({ orbState: get().isVoiceActive ? 'LISTENING' : 'IDLE' });
        }
      }, 3000);
      if (typeof (orbIdleResetTimer as any)?.unref === 'function') (orbIdleResetTimer as any).unref();
    }
  },

  abortGeneration: () => {
    clearOrbIdleResetTimer();
    const controller = getActiveAbortController();
    if (controller) {
      controller.abort();
      setActiveAbortController(null);
    }
    // CORREÇÃO (UI presa em "Pensando…"): se não houver controller (ex: clique em
    // Parar exatamente na janela entre a reserva atômica de `isGenerating` e a
    // criação do AbortController, ou após uma falha que limpou o controller sem
    // restaurar a flag), a UI ficava travada sem stream nenhum para abortar.
    // Com um stream REAL ativo, o fluxo de catch do sendMessage/retryMessage é
    // quem restaura as flags (mantém status 'cancelled'); sem stream, liberamos aqui.
    if (!controller && get().isGenerating) {
      set((state) => ({
        isGenerating: false,
        orbState: state.isVoiceActive ? 'LISTENING' : 'IDLE'
      }));
    }
  },

  retryMessage: async (failedMessageId: string) => {
    // CORREÇÃO (corrida isGenerating): o guard era um check-then-act não atômico
    // (`if (get().isGenerating) return;` e o `set({isGenerating:true})` ~80 linhas
    // depois). Dois cliques rápidos em "Tentar novamente" passavam ambos e criavam
    // dois streams na MESMA bolha (assistantMsgId diferente) — texto embaralhado,
    // `isGenerating` liberado pelo primeiro que terminasse e o abort só matando
    // o segundo controller. Mesma técnica atômica usada no sendMessage.
    let retryRaceLost = false;
    set((state) => {
      if (state.isGenerating) {
        retryRaceLost = true;
        return state;
      }
      return { ...state, isGenerating: true };
    });
    if (retryRaceLost) return;

    // Otimização de exaustão: throttle de persistência durante o streaming do retry
    let lastPersistTime = 0;
    const retryStartMs = performance.now();

    const targetSessionId = get().activeSessionId;
    if (!targetSessionId) {
      set({ isGenerating: false });
      return;
    }

    const currentMessages = get().messages;
    const failedIdx = currentMessages.findIndex((m) => m.id === failedMessageId);
    if (failedIdx === -1) {
      set({ isGenerating: false });
      return;
    }

    let userText = '';
    let userMsgIdx = -1;
    for (let i = failedIdx - 1; i >= 0; i--) {
      if (currentMessages[i].sender === 'user') {
        userText = currentMessages[i].text;
        userMsgIdx = i;
        break;
      }
    }

    if (!userText || userMsgIdx === -1) {
      set({ isGenerating: false });
      return;
    }

    // Filter out the failed message from active session
    set((state) => {
      // CORREÇÃO (falso positivo visual): antes filtrava `state.messages` (visão da
      // sessão ativa) mas gravava essa lista dentro de `targetSessionId`. Se a
      // sessão ativa mudasse entre a leitura e o set, o histórico de OUTRA sessão
      // era gravado na sessão alvo (mensagens trocadas/corrompidas). Agora a
      // remoção é cirúrgica apenas na sessão alvo.
      const updatedSessions = state.sessions.map(s =>
        s.id === targetSessionId
          ? { ...s, messages: s.messages.filter((m) => m.id !== failedMessageId), updatedAt: new Date().toISOString() }
          : s
      );
      saveHistory(updatedSessions, state.activeSessionId);
      const isCurrent = state.activeSessionId === targetSessionId;
      const currentSession = updatedSessions.find(s => s.id === targetSessionId);
      return {
        messages: isCurrent && currentSession ? currentSession.messages : state.messages,
        sessions: updatedSessions
      };
    });

    const history = formatGeminiHistory(currentMessages.slice(0, userMsgIdx));
    
    const assistantMsgId = `msg-${Date.now()}-a`;
    const retryNow = new Date();
    const retryTimeHms = retryNow.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const assistantMsg: ChatMessage = {
      id: assistantMsgId,
      sender: 'assistant',
      text: '',
      timestamp: retryTimeHms,
      status: 'streaming',
      modelUsed: get().activeModel || 'gemini-3.1-flash-lite',
      source: 'text',
      createdAt: retryNow.toISOString(),
      sessionId: targetSessionId
    };

    clearOrbIdleResetTimer();
    const controller = new AbortController();

    set((state) => {
      // CORREÇÃO: acrescenta a nova bolha NA SESSÃO ALVO (antes usava
      // `state.messages`, que pertence à sessão ativa e pode ser outra).
      const updatedSessions = state.sessions.map(s =>
        s.id === targetSessionId
          ? { ...s, messages: [...s.messages, assistantMsg], updatedAt: new Date().toISOString() }
          : s
      );
      saveHistory(updatedSessions, state.activeSessionId);
      const isCurrent = state.activeSessionId === targetSessionId;
      const currentSession = updatedSessions.find(s => s.id === targetSessionId);
      return {
        messages: isCurrent && currentSession ? currentSession.messages : state.messages,
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
      let usedProvider: 'gemini' | 'openrouter' = 'gemini';
      let modelUsedRef: string | null = null;

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
              if (data.done && data.modelUsed) {
                modelUsedRef = data.modelUsed;
              }
              if (data.failover) {
                const failoverNotice = `\n\n> ⚠️ *[Alternado para OpenRouter: ${data.message || 'Cota do Gemini excedida'}]*\n\n`;
                accumulatedText += failoverNotice;
                if (data.provider === 'openrouter') {
                  usedProvider = 'openrouter';
                }
                get().addActivityLog({
                  category: 'ai',
                  summary: 'Cota Gemini Excedida -> OpenRouter Failover',
                  details: data.message || 'Cota do Gemini atingida. Alternando para o modelo de contingência OpenRouter.',
                  riskLevel: 'R0',
                  status: 'warning',
                  simulated: false
                });
              } else if (data.toolExecuted) {
                get().addActivityLog({
                  category: 'tool',
                  summary: `Ferramenta executada: ${data.toolExecuted}`,
                  details: data.resultSummary || (data.success ? 'Execução real confirmada pelo servidor.' : 'Falhou.'),
                  riskLevel: (data.riskLevel || 'R1') as any,
                  status: data.success ? 'success' : 'error',
                  simulated: Boolean(data.simulated)
                });
                if (!data.success && (data.requiresConsent || data.code === 'REQUIRES_USER_CONFIRMATION' || data.code === 'DENY_R1_BLOCKED_IN_PHASE_6_2B')) {
                  const now = Date.now();
                  // BUG FIX: usar setPendingConsent (retry path) para enriquecer prompt, timer e TTS
                  get().setPendingConsent({
                    auditId: data.auditId || `sse-consent-${now}`,
                    ruleId: 'sse-tool-consent',
                    toolName: data.toolExecuted,
                    riskLevel: (data.riskLevel || 'R1') as ToolRiskLevel,
                    parameters: data.parameters || {},
                    consentToken: '',
                    sessionId: targetSessionId || 'operator-voice-session',
                    expiresAt: now + 60000,
                    reason: data.resultSummary || `A execução de '${data.toolExecuted}' requer sua confirmação explícita.`,
                    status: 'PENDING'
                  });
                }
                eventBus.publish('liora:tool_result', {
                  toolName: data.toolExecuted,
                  success: Boolean(data.success),
                  requiresConsent: Boolean(data.requiresConsent),
                  simulated: Boolean(data.simulated),
                  resultSummary: data.resultSummary,
                  resultData: data.resultData
                });
              } else if (data.chunk) {
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

      // CORREÇÃO (métricas cegas no retry): o sendMessage registra tokens/latência
      // no AnalyticsDashboard, mas o retryMessage não registrava — toda resposta
      // reenviada ficava invisível nas estatísticas. Registro na conclusão.
      tokenAnalytics.recordApiCall(
        usedProvider,
        userText.length + JSON.stringify(history).length,
        accumulatedText.length,
        Math.round(performance.now() - retryStartMs)
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
                status: 'completed',
                ...(modelUsedRef ? { modelUsed: modelUsedRef } : {})
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
        clearOrbIdleResetTimer();
        orbIdleResetTimer = setTimeout(() => {
          orbIdleResetTimer = null;
          if (get().orbState === 'SUCCESS' && !get().isGenerating) {
            set({ orbState: get().isVoiceActive ? 'LISTENING' : 'IDLE' });
          }
        }, 2000);
        if (typeof (orbIdleResetTimer as any)?.unref === 'function') (orbIdleResetTimer as any).unref();
      }
      if (getActiveAbortController() === controller) setActiveAbortController(null);

    } catch (err: any) {
      if (getActiveAbortController() === controller) setActiveAbortController(null);
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

        clearOrbIdleResetTimer();
        orbIdleResetTimer = setTimeout(() => {
          orbIdleResetTimer = null;
          if (get().orbState === 'CANCELLED' && !get().isGenerating) {
            set({ orbState: get().isVoiceActive ? 'LISTENING' : 'IDLE' });
          }
        }, 2000);
        if (typeof (orbIdleResetTimer as any)?.unref === 'function') (orbIdleResetTimer as any).unref();
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

      clearOrbIdleResetTimer();
      orbIdleResetTimer = setTimeout(() => {
        orbIdleResetTimer = null;
        if (get().orbState === 'ERROR' && !get().isGenerating) {
          set({ orbState: get().isVoiceActive ? 'LISTENING' : 'IDLE' });
        }
      }, 3000);
      if (typeof (orbIdleResetTimer as any)?.unref === 'function') (orbIdleResetTimer as any).unref();
    }
  },

  addActivityLog: (log) => {
    const newItem: ActivityLogItem = {
      id: `log-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      ...log
    };
    set((state) => ({
      activityLogs: appendPersistedActivityLog(state.activityLogs, newItem)
    }));

    // Envia telemetria em segundo plano para o terminal do servidor (apenas ambiente browser)
    if (typeof window !== 'undefined' && typeof fetch !== 'undefined') {
      void fetch('/api/logs/record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(log)
      }).catch(() => {});
    }
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
    const updatedDevice = devicesManager.updateDeviceStatus(id, connected);
    if (updatedDevice) {
      set({ devices: devicesManager.getDevices() });
    } else {
      set((state) => ({
        devices: state.devices.map(d =>
          d.id === id
            ? { ...d, connected, status: connected ? 'ONLINE' : 'OFFLINE', lastSeen: 'Agora' }
            : d
        )
      }));
    }
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
    if (!Array.isArray(entries)) return 0;
    const today = new Date().toISOString().split('T')[0];
    const allowedCategories = new Set<MemoryEntry['category']>(['preference', 'project', 'fact', 'routine']);
    const validEntries = entries
      .filter((e): e is MemoryEntry => (
        Boolean(e) &&
        typeof e === 'object' &&
        typeof e.key === 'string' &&
        e.key.trim().length > 0 &&
        typeof e.value === 'string' &&
        e.value.trim().length > 0
      ))
      .map((e, idx) => {
        const category = allowedCategories.has(e.category) ? e.category : 'preference';
        const confidence = typeof e.confidence === 'number' && Number.isFinite(e.confidence)
          ? Math.min(1, Math.max(0, e.confidence))
          : 1.0;
        return {
          id: typeof e.id === 'string' && e.id.trim() ? e.id.trim() : `mem-imp-${Date.now()}-${idx}`,
          category,
          key: e.key.trim(),
          value: e.value.trim(),
          confidence,
          updatedAt: typeof e.updatedAt === 'string' && e.updatedAt.trim() ? e.updatedAt.trim() : today
        };
      });

    if (validEntries.length === 0) {
      return 0;
    }

    let finalEntries: MemoryEntry[] = [];

    if (mode === 'replace') {
      finalEntries = validEntries;
    } else {
      const map = new Map<string, MemoryEntry>();
      get().memoryEntries.forEach(m => map.set(m.key.trim().toLowerCase(), m));
      validEntries.forEach((e) => {
        const cleanKey = e.key;
        const normalized = cleanKey.toLowerCase();
        const existing = map.get(normalized);
        map.set(normalized, {
          id: e.id || existing?.id || `mem-imp-${Date.now()}`,
          category: e.category || existing?.category || 'preference',
          key: cleanKey,
          value: e.value,
          confidence: e.confidence ?? existing?.confidence ?? 1.0,
          updatedAt: today
        });
      });
      finalEntries = Array.from(map.values());
    }

    persistMemoriesToLocalStorage(finalEntries);
    set({ memoryEntries: finalEntries });

    get().addActivityLog({
      category: 'system',
      summary: `Cofre de memórias importado (${validEntries.length} itens)`,
      details: `Modo de importação: ${mode}. Total de registros ativos: ${finalEntries.length}.`,
      riskLevel: 'R1',
      status: 'success',
      simulated: false
    });

    return validEntries.length;
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
      // Sincroniza políticas persistidas no localStorage com o servidor e permissionEngine local
      void get().syncToolPolicies();

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

  syncToolPolicies: async () => {
    const hasLocalConfig =
      typeof localStorage !== 'undefined' && localStorage.getItem(TOOL_POLICIES_STORAGE_KEY) !== null;
    const { globalAutoApprove, toolPolicies } = get();
    permissionEngine.setGlobalAutoApprove(globalAutoApprove);
    permissionEngine.setToolPolicies(toolPolicies);
    if (typeof fetch !== 'function') return;
    try {
      const res = hasLocalConfig
        ? await fetch('/api/security/tool-policies', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ globalAutoApprove, policies: toolPolicies })
          })
        : await fetch('/api/security/tool-policies', {
            headers: { 'Accept': 'application/json' }
          });

      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (data && typeof data === 'object' && data.policies) {
          const nextAuto = Boolean(data.globalAutoApprove);
          const nextPolicies = data.policies as ToolPolicyMap;
          permissionEngine.setGlobalAutoApprove(nextAuto);
          permissionEngine.setToolPolicies(nextPolicies);
          set({ globalAutoApprove: nextAuto, toolPolicies: nextPolicies });
        }
      }
    } catch {
      // Offline/test fallback silencioso — políticas permanecem ativas no permissionEngine e localStorage
    }
  },

  setToolPolicy: async (toolName: string, policy: ToolPermissionPolicy) => {
    const current = { ...get().toolPolicies };
    if (policy === 'default') {
      delete current[toolName];
    } else {
      current[toolName] = policy;
    }
    permissionEngine.setToolPolicy(toolName, policy);
    savePersistedToolPolicyConfig(get().globalAutoApprove, current);
    set({ toolPolicies: current });

    if (typeof fetch === 'function') {
      try {
        await fetch('/api/security/tool-policies', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ toolName, policy })
        });
      } catch {
        // fallback local preservado
      }
    }
  },

  setGlobalAutoApprove: async (enabled: boolean) => {
    const next = Boolean(enabled);
    permissionEngine.setGlobalAutoApprove(next);
    savePersistedToolPolicyConfig(next, get().toolPolicies);
    set({ globalAutoApprove: next });

    if (typeof fetch === 'function') {
      try {
        await fetch('/api/security/tool-policies', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ globalAutoApprove: next })
        });
      } catch {
        // fallback local preservado
      }
    }
  },

  executeTool: async (toolName: string, parameters: Record<string, any> = {}) => {
    const start = performance.now();
    // CORREÇÃO (auditoria profunda — /exec nunca funcionava): esta função era o
    // ÚNICO caminho de execução do cliente que NÃO pedia consentimento de UI.
    // Toda tool R1/R2 (incluindo system_exec_sandbox, usado pelo comando /exec do
    // chat) voltava 403 REQUIRES_USER_CONFIRMATION/TOOL_NOT_IN_PROFILE_WHITELIST —
    // o usuário digitava `/exec git status` e via "Falhou" para sempre.
    // Agora: consulta a política no servidor e, se exigir confirmação, abre o
    // ConsentCard; após a aprovação, `approveConsent()` emite o token de UI e
    // executa a sequência. Sem confirmação automática em silêncio.
    const policyRes = await fetch('/api/security/tool-policies', {
      headers: { 'Accept': 'application/json' }
    }).catch(() => null);
    let requiresConsent = true;
    // Nível de risco REAL da tool (o cartão exibia "Nível R1" fixo até para
    // um comando de terminal, que é R2 — o usuário autorizava algo mais grave
    // pensando que era leve). Fonte: catálogo do servidor. `loadTools()` só roda
    // na aba Desenvolvedor, então a lista do store pode estar vazia aqui —
    // nesse caso consultamos o catálogo uma vez.
    const knownRisk = get().tools.find(t => t.name === toolName)?.riskLevel as ToolRiskLevel | undefined;
    let resolvedRisk: ToolRiskLevel = knownRisk || 'R1';
    if (!knownRisk) {
      try {
        const catalogRes = await fetch('/api/tools', { headers: { Accept: 'application/json' } });
        const catalog = await catalogRes.json().catch(() => null);
        const entry = Array.isArray(catalog?.tools) ? catalog.tools.find((t: any) => t.name === toolName) : null;
        if (entry?.riskLevel) resolvedRisk = entry.riskLevel as ToolRiskLevel;
      } catch { /* mantém fallback R1 (conservador para exibição) */ }
    }
    if (policyRes?.ok) {
      const policy = await policyRes.json().catch(() => null);
      const toolPolicy = policy?.policies?.[toolName];
      requiresConsent = !(policy?.globalAutoApprove === true || toolPolicy === 'always_allow');
      if (toolPolicy === 'always_require_consent') requiresConsent = true;
    }
    if (requiresConsent) {
      const now = Date.now();
      set({
        pendingConsent: {
          auditId: `ui-${now}`,
          ruleId: 'manual-tool',
          toolName,
          riskLevel: resolvedRisk,
          parameters,
          consentToken: '',
          sessionId: get().activeSessionId || 'default-session',
          expiresAt: now + 60000,
          reason: `A ação '${toolName}' precisa da sua confirmação explícita para executar.`,
          status: 'PENDING'
        }
      });
      return {
        toolName,
        success: false,
        riskLevel: resolvedRisk,
        error: 'REQUIRES_USER_CONFIRMATION: confirme a ação no cartão de consentimento para executá-la.',
        code: 'REQUIRES_USER_CONFIRMATION',
        simulated: false,
        executionTimeMs: Math.round(performance.now() - start),
        timestamp: new Date().toISOString()
      } as ToolExecutionResult;
    }
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

      set((state) => ({ activityLogs: appendPersistedActivityLog(state.activityLogs, logItem) }));

      // Execução de Ações Reais de Interface e Navegação na Store somente quando autorizada e bem-sucedida
      if (data.success) {
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
            // CORREÇÃO: não inventar token no cliente — o consentimento REAL é
            // emitido pelo servidor (/api/security/ui-consent) no momento da
            // aprovação (approveConsent). Um token fake aqui era decorativo e
            // podia enganar fluxos que confiassem nele.
            consentToken: '',
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

      set((state) => ({ activityLogs: appendPersistedActivityLog(state.activityLogs, logItem) }));
      return errorResult;
    }
  },

  setPendingConsent: (consent: PendingConsentState | null) => {
    clearConsentAutoDismissTimer();
    if (consent && consent.status === 'PENDING') {
      const human = humanizeToolAction(consent.toolName, consent.parameters, consent.riskLevel);
      consent.friendlyTitle = consent.friendlyTitle || human.title;
      consent.friendlyDescription = consent.friendlyDescription || human.friendlyDescription;
      consent.spokenPrompt = consent.spokenPrompt || human.spokenPrompt;

      if (get().isVoiceActive) {
        voiceLiveClient.extendSuppression(8000);
        speechService.speak(consent.spokenPrompt, undefined, undefined, { isDeterministicOverride: true });
      }
    }
    set({ pendingConsent: consent });
  },

  approveConsent: async () => {
    const pending = get().pendingConsent;
    if (!pending || pending.status !== 'PENDING') return null;

    if (Date.now() > pending.expiresAt) {
      get().expireConsent();
      return null;
    }

    clearConsentAutoDismissTimer();
    set({ pendingConsent: { ...pending, status: 'APPROVED' } });

    const scheduleAutoDismiss = () => {
      clearConsentAutoDismissTimer();
      const targetAuditId = pending.auditId;
      consentAutoDismissTimer = setTimeout(() => {
        consentAutoDismissTimer = null;
        const curr = get().pendingConsent;
        if (curr && curr.auditId === targetAuditId && curr.status !== 'PENDING') {
          set({ pendingConsent: null });
        }
      }, CONSENT_AUTO_DISMISS_MS);
      if (typeof (consentAutoDismissTimer as any)?.unref === 'function') {
        (consentAutoDismissTimer as any).unref();
      }
    };

    let shouldAutoDismiss = true;
    try {
      let uiConsentToken: string | undefined = undefined;
      if (typeof fetch === 'function') {
        try {
          const isNonHttpBrowser =
            typeof window !== 'undefined' &&
            typeof window.location?.protocol === 'string' &&
            !window.location.protocol.startsWith('http');
          const consentUrl = (typeof window === 'undefined' || isNonHttpBrowser)
            ? `http://localhost:${(typeof process !== 'undefined' && process.env?.PORT) || 3000}/api/security/ui-consent`
            : '/api/security/ui-consent';

          const tokenRes = await fetch(consentUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
              toolName: pending.toolName,
              parameters: pending.parameters || {}
            })
          });
          const tokenData = await tokenRes.json().catch(() => ({}));
          if (tokenRes.ok && tokenData?.token) {
            uiConsentToken = tokenData.token;
          } else if (!isTauriEnvironment()) {
            const errMsg = tokenData?.error || `Falha ao emitir token de consentimento (${tokenRes.status}).`;
            const failResult: LocalExecutionResult = {
              success: false,
              toolName: pending.toolName,
              riskLevel: pending.riskLevel,
              error: errMsg,
              executionTimeMs: 0,
              simulated: false,
              timestamp: new Date().toISOString()
            };
            const nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const isExpired = Date.now() > pending.expiresAt;
            shouldAutoDismiss = isExpired;
            set(state => ({
              pendingConsent: isExpired
                ? { ...pending, status: 'EXPIRED' }
                : { ...pending, status: 'PENDING', reason: `${pending.reason || ''} (Falha na validação: ${errMsg})`.trim() },
              activityLogs: appendPersistedActivityLog(state.activityLogs, {
                id: `log-${Date.now()}`,
                timestamp: nowTime,
                category: 'security',
                summary: `Falha no Consentimento: ${pending.toolName}`,
                details: errMsg,
                riskLevel: pending.riskLevel,
                status: 'error',
                simulated: false
              })
            }));
            if (get().isVoiceActive) {
              voiceLiveClient.extendSuppression(5000);
              speechService.unlockAudio();
              speechService.speak(
                `Mestre, não foi possível validar o consentimento: ${errMsg}`,
                undefined,
                undefined,
                { isDeterministicOverride: true }
              );
            }
            return failResult;
          }
        } catch (err: any) {
          if (!isTauriEnvironment()) {
            const errMsg = err?.message || 'Erro de rede ao validar consentimento no servidor.';
            const nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const isExpired = Date.now() > pending.expiresAt;
            shouldAutoDismiss = isExpired;
            set(state => ({
              pendingConsent: isExpired
                ? { ...pending, status: 'EXPIRED' }
                : { ...pending, status: 'PENDING', reason: `${pending.reason || ''} (Erro de rede: ${errMsg})`.trim() },
              activityLogs: appendPersistedActivityLog(state.activityLogs, {
                id: `log-${Date.now()}`,
                timestamp: nowTime,
                category: 'security',
                summary: `Falha de Rede no Consentimento: ${pending.toolName}`,
                details: errMsg,
                riskLevel: pending.riskLevel,
                status: 'error',
                simulated: false
              })
            }));
            if (get().isVoiceActive) {
              voiceLiveClient.extendSuppression(5000);
              speechService.unlockAudio();
              speechService.speak(
                `Mestre, não consegui validar a permissão com o servidor local: ${errMsg}`,
                undefined,
                undefined,
                { isDeterministicOverride: true }
              );
            }
            return {
              success: false,
              toolName: pending.toolName,
              riskLevel: pending.riskLevel,
              error: errMsg,
              executionTimeMs: 0,
              simulated: false,
              timestamp: new Date().toISOString()
            } as LocalExecutionResult;
          }
        }
      }

      // Disparar execução autorizada via executeLocalTool com token auditável
      const result = await executeLocalTool(
        pending.toolName,
        pending.parameters,
        pending.sessionId,
        uiConsentToken
      );

      const isSuccess = Boolean((result as any).success);
      const isSimulated = Boolean((result as any).simulated);

      if (isSuccess) {
        if (pending.toolName === 'navigateToTab' && pending.parameters?.tab) {
          get().setActiveTab(pending.parameters.tab as any);
        } else if (pending.toolName === 'openSettings') {
          get().setActiveTab('settings');
        } else if (pending.toolName === 'triggerAutomation' && pending.parameters?.ruleId) {
          automationsEngine.triggerRule(pending.parameters.ruleId, { isManual: true });
        }
      }

      const linkedRule = pending.ruleId ? automationsEngine.getRule(pending.ruleId) : undefined;
      if (linkedRule) {
        if (pending.consentToken) {
          try {
            permissionEngine.consumeConsentToken(
              pending.consentToken,
              pending.toolName,
              pending.parametersHash || '',
              pending.sessionId
            );
          } catch {
            // Token pode já ter sido consumido ou emitido em outra camada
          }
        }
        automationsEngine.recordExternalConsentResolution(linkedRule.id, {
          status: isSuccess ? 'SUCCESS' : 'FAILED',
          outputSummary: isSuccess
            ? JSON.stringify((result as any).data ?? result).slice(0, 120)
            : undefined,
          errorMessage: isSuccess ? undefined : ((result as any).error || 'Falha após aprovação.'),
          auditId: pending.auditId,
          parametersHash: pending.parametersHash,
          simulated: isSimulated,
          durationMs: (result as any).executionTimeMs || 0
        });
      }

      const nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const logItem: ActivityLogItem = {
        id: `log-${Date.now()}`,
        timestamp: nowTime,
        category: 'security',
        summary: isSuccess
          ? `Consentimento Aprovado: ${pending.toolName}`
          : `Consentimento Aprovado, mas Execução Falhou: ${pending.toolName}`,
        details: isSuccess
          ? `Execução ${isSimulated ? 'simulada (Web Preview)' : 'nativa'} autorizada pelo usuário para '${pending.toolName}'.`
          : `Erro após aprovação: ${(result as any).error || 'falha desconhecida na execução'}.`,
        riskLevel: pending.riskLevel,
        status: isSuccess ? 'success' : 'error',
        simulated: isSimulated
      };

      set(state => ({
        activityLogs: appendPersistedActivityLog(state.activityLogs, logItem),
        ...(linkedRule
          ? {
              automations: automationsEngine.getRules(),
              automationLogs: automationsEngine.getLogs()
            }
          : {})
      }));

      if (get().isVoiceActive) {
        voiceLiveClient.extendSuppression(5000);
        speechService.unlockAudio();
        const address = resolveUserAddress(get().memoryEntries as any);
        // O feedback falado era "Autorização confirmada e executada, Mestre." e NÃO
        // dizia o RESULTADO. O usuário autorizava e ficava só com o "confirmada" —
        // exatamente o relato "autorizei e ela ficou calada / não falou a saída".
        // Agora a fala traz o resultado real (saída, ou o motivo da falha).
        let spokenFeedback: string;
        if (isSuccess) {
          spokenFeedback = isSimulated
            ? `Autorizado, ${address}. Modo Web Preview simulado para ${pending.toolName}.`
            : buildSpokenToolOutcome(pending.toolName, result, address);
        } else {
          spokenFeedback = `${address}, autorizei a ação, mas ocorreu uma falha: ${(result as any).error || 'verifique o aplicativo'}.`;
        }
        speechService.speak(spokenFeedback, undefined, undefined, { isDeterministicOverride: true });
      }

      return result as ToolExecutionResult;
    } finally {
      if (shouldAutoDismiss) {
        scheduleAutoDismiss();
      }
    }
  },

  rejectConsent: () => {
    const pending = get().pendingConsent;
    if (!pending) return;

    clearConsentAutoDismissTimer();
    const linkedRule = pending.ruleId ? automationsEngine.getRule(pending.ruleId) : undefined;
    if (linkedRule) {
      automationsEngine.recordExternalConsentResolution(linkedRule.id, {
        status: 'BLOCKED_BY_POLICY',
        errorMessage: 'Consentimento rejeitado manualmente pelo usuário.',
        auditId: pending.auditId,
        parametersHash: pending.parametersHash,
        simulated: true
      });
    }

    set({
      pendingConsent: { ...pending, status: 'REJECTED' },
      ...(linkedRule
        ? {
            automations: automationsEngine.getRules(),
            automationLogs: automationsEngine.getLogs()
          }
        : {})
    });

    const targetAuditId = pending.auditId;
    consentAutoDismissTimer = setTimeout(() => {
      consentAutoDismissTimer = null;
      const curr = get().pendingConsent;
      if (curr && curr.auditId === targetAuditId && curr.status !== 'PENDING') {
        set({ pendingConsent: null });
      }
    }, CONSENT_AUTO_DISMISS_MS);
    if (typeof (consentAutoDismissTimer as any)?.unref === 'function') {
      (consentAutoDismissTimer as any).unref();
    }

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

    set(state => ({ activityLogs: appendPersistedActivityLog(state.activityLogs, logItem) }));
  },

  expireConsent: () => {
    const pending = get().pendingConsent;
    if (!pending || pending.status !== 'PENDING') return;

    clearConsentAutoDismissTimer();
    const linkedRule = pending.ruleId ? automationsEngine.getRule(pending.ruleId) : undefined;
    if (linkedRule) {
      automationsEngine.recordExternalConsentResolution(linkedRule.id, {
        status: 'BLOCKED_BY_POLICY',
        errorMessage: 'Consentimento expirado (TTL 60s excedido).',
        auditId: pending.auditId,
        parametersHash: pending.parametersHash,
        simulated: true
      });
    }

    set({
      pendingConsent: { ...pending, status: 'EXPIRED' },
      ...(linkedRule
        ? {
            automations: automationsEngine.getRules(),
            automationLogs: automationsEngine.getLogs()
          }
        : {})
    });

    const targetAuditId = pending.auditId;
    consentAutoDismissTimer = setTimeout(() => {
      consentAutoDismissTimer = null;
      const curr = get().pendingConsent;
      if (curr && curr.auditId === targetAuditId && curr.status !== 'PENDING') {
        set({ pendingConsent: null });
      }
    }, CONSENT_AUTO_DISMISS_MS);
    if (typeof (consentAutoDismissTimer as any)?.unref === 'function') {
      (consentAutoDismissTimer as any).unref();
    }

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

    set(state => ({ activityLogs: appendPersistedActivityLog(state.activityLogs, logItem) }));
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
      const successText = `⚙️ **Automação Executada:** "${rule.name}" executada com sucesso (${log.durationMs}ms).\n\n*Ação:* \`${rule.action.toolName || rule.action.description}\` realizada com risco **${rule.action.expectedRiskLevel}**.`;
      
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
    let geminiKey = integrationsVault.getApiKeyByProvider('gemini') || 
                    integrationsVault.getRawKey('svc-gemini') ||
                    (typeof localStorage !== 'undefined' ? (localStorage.getItem('GEMINI_API_KEY') || localStorage.getItem('liora_gemini_key')) : null);

    const gemSvc = integrationsVault.getService('svc-gemini');
    let isMissing = (!geminiKey || typeof geminiKey !== 'string' || geminiKey.trim().length < 5) && gemSvc?.status !== 'CONNECTED';

    // Se não estiver em memória no browser, verifica se o servidor backend já possui a chave configurada no .env
    if (isMissing && typeof fetch !== 'undefined') {
      try {
        const res = await fetch('/api/env/keys/status');
        if (res.ok) {
          const data = await res.json();
          if (data?.gemini?.isConfigured) {
            isMissing = false;
          }
        } else {
          const healthRes = await fetch('/api/health');
          if (healthRes.ok) {
            const healthData = await healthRes.json();
            if (healthData?.hasApiKey) {
              isMissing = false;
            }
          }
        }
      } catch {
        // ignora falha de rede na checagem
      }
    }

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
    void get().syncServicesFromEnv();
  },

  syncServicesFromEnv: async (options?: { skipRemoteFetch?: boolean }) => {
    if (!options?.skipRemoteFetch) {
      await integrationsVault.syncWithBackendEnv();
    }
    const updatedServices = integrationsVault.getServices();
    const vaultCredentials = integrationsVault.getCredentials();

    set((state) => {
      const mergedCredentials = [...state.credentials];
      for (const vc of vaultCredentials) {
        const legacyProvider = (['gemini', 'openrouter', 'github', 'homeassistant'].includes(vc.provider)
          ? vc.provider
          : 'custom') as 'gemini' | 'openrouter' | 'github' | 'homeassistant' | 'custom';
        const svc = updatedServices.find((s) => s.id === vc.associatedServiceId);
        const mapped: CredentialItem = {
          id: vc.id,
          provider: legacyProvider,
          label: svc?.name || vc.label,
          maskedKey: vc.maskedKey,
          status: vc.status === 'valid' ? 'valid' : 'invalid',
          models: svc?.featuresSupported || []
        };
        const idx = mergedCredentials.findIndex((c) => c.provider === legacyProvider);
        if (idx >= 0) {
          mergedCredentials[idx] = mapped;
        } else {
          mergedCredentials.push(mapped);
        }
      }
      return {
        services: updatedServices,
        webhookLogs: integrationsVault.getWebhookLogs(),
        keychainFallbackActive: integrationsVault.isKeychainFallbackActive(),
        credentials: mergedCredentials
      };
    });

    await get().runVaultDiagnostics();
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
      void get().runVaultDiagnostics();

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

  sendDeviceCommand: async (deviceId, commandType, riskLevel = 'R0', payload = {}, options) => {
    const cmd = await devicesManager.sendCommand(deviceId, commandType, riskLevel, payload, options);
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
    const def = settingsManager.resetSettings();
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
// Também em globalThis: módulos do servidor/worker (humanizador de consentimento,
// tools de memória no Node) não têm `window`, e sem isso o vocativo voltava a
// "Mestre" mesmo com a preferência salva.
if (typeof globalThis !== 'undefined') {
  (globalThis as any).__LIORA_STORE__ = useLioraStore;
}

// Guarda HMR: evita registrar múltiplos listeners caso o módulo seja recarregado pelo Vite em desenvolvimento
const canRegisterBusListeners = typeof window === 'undefined' || !(window as any).__LIORA_BUS_SUBSCRIBED__;
if (typeof window !== 'undefined') {
  (window as any).__LIORA_BUS_SUBSCRIBED__ = true;
}

if (canRegisterBusListeners) {
  // P0b (paridade voz x chat): ferramentas executadas no canal Gemini Live (/ws/voice)
  // são publicadas pelo voiceLiveClient no eventBus e registradas aqui no log de
  // atividade exatamente como o data.toolExecuted do chat de texto.
  eventBus.subscribe('liora:voice_tool_executed', (payload: any) => {
    const storeState = useLioraStore.getState();
    if (payload.success && payload.toolName === 'navigateToTab' && (payload.data?.activeTab || payload.parameters?.tab)) {
      const targetTab = payload.data?.activeTab || payload.parameters?.tab;
      storeState.setActiveTab(targetTab as any);
    } else if (payload.success && payload.toolName === 'openSettings') {
      storeState.setActiveTab('settings');
    }

    if (!payload.success && (payload.requiresConsent || payload.code === 'REQUIRES_USER_CONFIRMATION' || payload.code === 'DENY_R1_BLOCKED_IN_PHASE_6_2B')) {
      const now = Date.now();
      storeState.setPendingConsent({
        auditId: `voice-consent-${now}`,
        ruleId: 'voice-tool-consent',
        toolName: payload.toolName,
        riskLevel: (payload.riskLevel || 'R1') as ToolRiskLevel,
        parameters: payload.parameters || {},
        consentToken: '',
        sessionId: storeState.activeSessionId || 'operator-voice-session',
        expiresAt: now + 60000,
        reason: payload.resultSummary || `A execução por voz de '${payload.toolName}' requer confirmação explícita.`,
        status: 'PENDING'
      });
    }

    storeState.addActivityLog({
      category: 'tool',
      summary: `Ferramenta executada por voz: ${payload.toolName}`,
      details: payload.resultSummary || (payload.success ? 'Execução real confirmada pelo canal Live.' : 'Falhou.'),
      riskLevel: (payload.riskLevel || 'R1') as any,
      status: payload.success ? 'success' : payload.requiresConsent ? 'warning' : 'error',
      simulated: Boolean(payload.simulated)
    });
  });

  // CORREÇÃO (sincronização tool→TTS): transforma o resultado REAL da ferramenta
  // em fala quando o modo de voz está ativo, respeitando o Audio Gate para nunca
  // falar por cima da voz 24kHz do Gemini Live quando a sessão Live já está respondendo.
  eventBus.subscribe('liora:tool_result', (payload: any) => {
    const state = useLioraStore.getState();
    if (!state.isVoiceActive) return;

    // Se o próprio Gemini Live executou com sucesso e não está suprimido, ele mesmo
    // já emite o áudio 24kHz da resposta — não duplicar com TTS paralelo.
    if (payload.fromLiveSession && payload.success && audioGate.isLiveSessionActive() && !audioGate.isLiveSuppressed()) {
      return;
    }

    // Se falhou apenas aguardando consentimento, o GlobalConsentOverlay emite o prompt único.
    if (!payload.success && payload.requiresConsent) {
      return;
    }

    const { toolName, success, resultData, resultSummary, simulated } = payload;
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
        case 'open_application':
        case 'open_browser':
        case 'pc_manage_apps': {
          const app = resultData?.appPath || resultData?.browser || resultData?.resolvedProcessName || resultData?.processName || 'aplicativo';
          if (success) {
            speech = simulated
              ? `Modo Web Preview simulado: abertura de ${app} registrada sem sistema desktop local.`
              : null;
          } else {
            speech = `Não consegui abrir ${app}: ${resultData?.error || resultSummary || 'verifique se está instalado'}.`;
          }
          break;
        }
        case 'camera_inspect_object': {
          if (!success) {
            speech = resultData?.requiresClientCapture
              ? 'Para analisar um objeto pela câmera, segure o item na frente da lente e aperte o botão de câmera ou me peça para olhar a câmera.'
              : `Não consegui acessar a câmera: ${resultData?.error || 'verifique se o dispositivo está conectado'}.`;
          }
          break;
        }
        case 'pc_take_screenshot': {
          if (!success) {
            speech = `Não consegui capturar a tela: ${resultData?.error || 'verifique as permissões do sistema'}.`;
          }
          break;
        }
        default:
          // Ferramentas sem voz dedicada: fala o resumo honesto apenas se for falha
          if (!success) speech = `A ferramenta ${toolName} falhou: ${resultSummary || 'erro desconhecido'}.`;
          break;
      }
    } catch { /* nunca quebrar o pipeline de voz por erro de formatação */ }

    if (speech && !speechService.isSpeaking()) {
      voiceLiveClient.extendSuppression(5000);
      speechService.speak(sanitizeTextForSpeech(speech), () => {}, () => {}, { isDeterministicOverride: true });
    }
  });
}


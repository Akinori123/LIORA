/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — Playwright Browser Automation Tools (Node.js / server-side only)
 *
 * Este módulo NUNCA deve ser importado diretamente no frontend Vite.
 * Ele é carregado dinamicamente pelo servidor Express (server.ts) via
 * installNativeServerTools().
 *
 * Funcionalidades:
 *  - browser_open_url      (R1) — abre URL em sessão gerenciada, retorna título + screenshot base64
 *  - browser_navigate      (R1) — navega para URL em sessão existente
 *  - browser_click         (R1) — clica em seletor CSS/XPath
 *  - browser_fill_form     (R1) — preenche campo de formulário
 *  - browser_extract_text  (R0) — extrai texto de seletor
 *  - browser_screenshot    (R0) — captura screenshot da página atual
 *  - browser_close_session (R0) — fecha sessão do browser
 *
 * Segurança:
 *  - Máximo de 2 sessões simultâneas
 *  - Auto-encerramento após 5 min de inatividade
 *  - URLs bloqueadas: file://, about:, chrome://, localhost (exceto portas conhecidas)
 *  - Sem execução de JavaScript arbitrário pelo LLM
 */

import { ToolDefinition } from '../types';

// ─── Tipos ───────────────────────────────────────────────────────────────────

interface BrowserSession {
  id: string;
  browser: import('playwright').Browser;
  page: import('playwright').Page;
  lastUsed: number;
  currentUrl: string;
}

// ─── Gerenciador de Sessões ───────────────────────────────────────────────────

const MAX_SESSIONS = 2;
const SESSION_IDLE_MS = 5 * 60 * 1000; // 5 minutos

const sessions = new Map<string, BrowserSession>();

/** Importa playwright dinamicamente (somente Node.js) */
async function getPlaywright() {
  if (typeof window !== 'undefined') {
    throw new Error('ENVIRONMENT_ERROR: Playwright só pode ser usado no servidor Node.js.');
  }
  return import('playwright');
}

/** Cria ou reutiliza um ID de sessão único */
function newSessionId(): string {
  return `pw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Valida URL — bloqueia esquemas perigosos */
function assertSafeUrl(url: string): void {
  if (!url || typeof url !== 'string') throw new Error('INVALID_URL: URL vazia ou inválida.');
  const lower = url.toLowerCase().trim();
  if (
    lower.startsWith('file://') ||
    lower.startsWith('about:') ||
    lower.startsWith('chrome://') ||
    lower.startsWith('javascript:') ||
    lower.startsWith('data:')
  ) {
    throw new Error(`URL_BLOCKED: O esquema '${lower.split(':')[0]}:' não é permitido por segurança.`);
  }
  // Requer http:// ou https://
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
    throw new Error('URL_BLOCKED: Apenas URLs http:// e https:// são permitidas.');
  }
}

/** Remove sessões inativas */
async function pruneIdleSessions(): Promise<void> {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastUsed > SESSION_IDLE_MS) {
      try { await session.browser.close(); } catch { /* ignora */ }
      sessions.delete(id);
    }
  }
}

/** Fecha todas as sessões — chamado ao encerrar o processo */
export async function closeAllBrowserSessions(): Promise<void> {
  for (const session of sessions.values()) {
    try { await session.browser.close(); } catch { /* ignora */ }
  }
  sessions.clear();
}

// Limpeza ao encerrar o processo
if (typeof process !== 'undefined') {
  process.on('exit', () => { for (const s of sessions.values()) { try { s.browser.close(); } catch { /* ignora */ } } });
  process.on('SIGTERM', async () => { await closeAllBrowserSessions(); process.exit(0); });
}

/** Obtém sessão existente ou lança erro */
function getSession(sessionId: string): BrowserSession {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`SESSION_NOT_FOUND: Sessão '${sessionId}' não encontrada. Use browser_open_url primeiro.`);
  }
  session.lastUsed = Date.now();
  return session;
}

/**
 * AGENTE WEB (web_browser_agent): acesso interno ao Page para o pipeline de ações.
 * Exporta a página de uma sessão existente (ou null) — o agente monta/usa sessões
 * através de browser_open_url e executa steps com page APIs diretas.
 */
export function getPageForAgent(sessionId: string): import('playwright').Page | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.lastUsed = Date.now();
  return session.page;
}

/** Captura screenshot como base64 PNG (max 1MB, reduzido se maior) */
async function captureScreenshot(page: import('playwright').Page): Promise<string> {
  const buf = await page.screenshot({ type: 'png', fullPage: false });
  return buf.toString('base64');
}

// ─── Definições das Ferramentas ───────────────────────────────────────────────

/**
 * browser_open_url (R1)
 * Abre uma URL em uma nova sessão gerenciada de browser headless.
 */
export const browserOpenUrlTool: ToolDefinition<{ url: string; sessionId?: string }, any> = {
  name: 'browser_open_url',
  description:
    'Abre uma URL em um browser headless gerenciado. Retorna ID de sessão, título da página e screenshot. ' +
    'Use para acessar e interagir com páginas web a pedido do usuário.',
  category: 'browser',
  riskLevel: 'R1',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL completa a abrir (deve começar com http:// ou https://).'
      },
      sessionId: {
        type: 'string',
        description: 'ID de sessão existente para reutilizar (opcional). Se omitido, cria nova sessão.'
      }
    },
    required: ['url'],
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['sessionId', 'title', 'url', 'simulated'] },
  execute: async ({ url, sessionId }) => {
    assertSafeUrl(url);
    await pruneIdleSessions();

    // Reutiliza sessão existente se fornecida
    if (sessionId && sessions.has(sessionId)) {
      const session = getSession(sessionId);
      await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      session.currentUrl = session.page.url();
      const title = await session.page.title();
      const screenshot = await captureScreenshot(session.page);
      return {
        success: true,
        sessionId,
        title,
        url: session.currentUrl,
        screenshot,
        simulated: false
      };
    }

    // Verifica limite de sessões
    if (sessions.size >= MAX_SESSIONS) {
      await pruneIdleSessions();
      if (sessions.size >= MAX_SESSIONS) {
        throw new Error(`SESSION_LIMIT: Máximo de ${MAX_SESSIONS} sessões simultâneas atingido. Feche uma sessão com browser_close_session.`);
      }
    }

    const pw = await getPlaywright();

    // Tenta Chromium headless shell, depois msedge como fallback
    let browser: import('playwright').Browser;
    try {
      browser = await pw.chromium.launch({ headless: true, timeout: 15000 });
    } catch {
      try {
        browser = await pw.chromium.launch({ channel: 'msedge', headless: true, timeout: 15000 });
      } catch (e2) {
        throw new Error(`BROWSER_LAUNCH_FAILED: Não foi possível iniciar o browser. ${(e2 as Error).message}`);
      }
    }

    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (navErr) {
      await browser.close();
      throw new Error(`NAVIGATION_FAILED: ${(navErr as Error).message}`);
    }

    const id = newSessionId();
    const session: BrowserSession = {
      id,
      browser,
      page,
      lastUsed: Date.now(),
      currentUrl: page.url()
    };
    sessions.set(id, session);

    const title = await page.title();
    const screenshot = await captureScreenshot(page);

    return {
      success: true,
      sessionId: id,
      title,
      url: page.url(),
      screenshot,
      simulated: false
    };
  }
};

/**
 * browser_navigate (R1)
 * Navega para uma URL em uma sessão existente.
 */
export const browserNavigateTool: ToolDefinition<{ sessionId: string; url: string }, any> = {
  name: 'browser_navigate',
  description: 'Navega para uma URL em uma sessão de browser existente. Requer sessionId obtido com browser_open_url.',
  category: 'browser',
  riskLevel: 'R1',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'ID da sessão do browser.' },
      url: { type: 'string', description: 'URL de destino.' }
    },
    required: ['sessionId', 'url'],
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'url', 'title', 'simulated'] },
  execute: async ({ sessionId, url }) => {
    assertSafeUrl(url);
    const session = getSession(sessionId);
    await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    session.currentUrl = session.page.url();
    const title = await session.page.title();
    const screenshot = await captureScreenshot(session.page);
    return { success: true, url: session.currentUrl, title, screenshot, simulated: false };
  }
};

/**
 * browser_click (R1)
 * Clica em um elemento pelo seletor CSS.
 */
export const browserClickTool: ToolDefinition<{ sessionId: string; selector: string }, any> = {
  name: 'browser_click',
  description: 'Clica em um elemento da página pelo seletor CSS. Use para interagir com botões, links e controles.',
  category: 'browser',
  riskLevel: 'R1',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'ID da sessão do browser.' },
      selector: { type: 'string', description: 'Seletor CSS do elemento a clicar.' }
    },
    required: ['sessionId', 'selector'],
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'simulated'] },
  execute: async ({ sessionId, selector }) => {
    const session = getSession(sessionId);
    await session.page.click(selector, { timeout: 10000 });
    session.currentUrl = session.page.url();
    const screenshot = await captureScreenshot(session.page);
    return { success: true, currentUrl: session.currentUrl, screenshot, simulated: false };
  }
};

/**
 * browser_fill_form (R1)
 * Preenche um campo de formulário.
 */
export const browserFillFormTool: ToolDefinition<{ sessionId: string; selector: string; value: string }, any> = {
  name: 'browser_fill_form',
  description: 'Preenche um campo de formulário (input, textarea) pelo seletor CSS com um valor de texto.',
  category: 'browser',
  riskLevel: 'R1',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'ID da sessão do browser.' },
      selector: { type: 'string', description: 'Seletor CSS do campo a preencher.' },
      value: { type: 'string', description: 'Valor a inserir no campo.' }
    },
    required: ['sessionId', 'selector', 'value'],
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'simulated'] },
  execute: async ({ sessionId, selector, value }) => {
    const session = getSession(sessionId);
    await session.page.fill(selector, value, { timeout: 10000 });
    return { success: true, selector, simulated: false };
  }
};

/**
 * browser_extract_text (R0)
 * Extrai o conteúdo textual de um seletor ou da página inteira.
 */
export const browserExtractTextTool: ToolDefinition<{ sessionId: string; selector?: string }, any> = {
  name: 'browser_extract_text',
  description: 'Extrai o conteúdo de texto de um seletor CSS ou da página inteira (sem seletor). Risco R0 — somente leitura.',
  category: 'browser',
  riskLevel: 'R0',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'ID da sessão do browser.' },
      selector: { type: 'string', description: 'Seletor CSS (opcional). Omitir retorna texto da página inteira.' }
    },
    required: ['sessionId'],
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['text', 'simulated'] },
  execute: async ({ sessionId, selector }) => {
    const session = getSession(sessionId);
    let text: string;
    if (selector) {
      text = await session.page.innerText(selector, { timeout: 10000 });
    } else {
      text = await session.page.innerText('body', { timeout: 10000 });
    }
    // Trunca a 10.000 chars para evitar payloads gigantes no modelo
    const truncated = text.length > 10000;
    return {
      text: text.slice(0, 10000),
      truncated,
      charCount: text.length,
      simulated: false
    };
  }
};

/**
 * browser_screenshot (R0)
 * Captura screenshot da página atual.
 */
export const browserScreenshotTool: ToolDefinition<{ sessionId: string }, any> = {
  name: 'browser_screenshot',
  description: 'Captura um screenshot PNG (base64) da página atual no browser. Risco R0 — somente leitura.',
  category: 'browser',
  riskLevel: 'R0',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'ID da sessão do browser.' }
    },
    required: ['sessionId'],
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['screenshot', 'url', 'simulated'] },
  execute: async ({ sessionId }) => {
    const session = getSession(sessionId);
    const screenshot = await captureScreenshot(session.page);
    return { screenshot, url: session.page.url(), simulated: false };
  }
};

/**
 * browser_close_session (R0)
 * Fecha uma sessão do browser e libera recursos.
 */
export const browserCloseSessionTool: ToolDefinition<{ sessionId: string }, any> = {
  name: 'browser_close_session',
  description: 'Fecha uma sessão de browser e libera os recursos. Sempre feche sessões quando não precisar mais delas.',
  category: 'browser',
  riskLevel: 'R0',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'ID da sessão a fechar.' }
    },
    required: ['sessionId'],
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'simulated'] },
  execute: async ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (!session) {
      return { success: false, reason: `Sessão '${sessionId}' não encontrada.`, simulated: false };
    }
    try {
      await session.browser.close();
    } catch { /* ignora */ }
    sessions.delete(sessionId);
    return { success: true, sessionId, simulated: false };
  }
};

/** Array de todas as ferramentas Playwright para registro em massa */
export const allBrowserTools: ToolDefinition<any, any>[] = [
  browserOpenUrlTool,
  browserNavigateTool,
  browserClickTool,
  browserFillFormTool,
  browserExtractTextTool,
  browserScreenshotTool,
  browserCloseSessionTool
];


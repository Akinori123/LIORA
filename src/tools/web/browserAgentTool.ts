/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — AGENTE WEB AUTÓNOMO (FASE 1 do Plano Mestre: BROWSER USE)
 *
 * Executa um PIPELINE de ações de navegação web de forma autónoma em uma única
 * chamada: navegar → clicar → digitar → scroll → extrair texto → screenshot.
 * Reutiliza o gerenciador de sessões Playwright do playwrightTool.ts.
 *
 * SEGURANÇA (R2 — consentimento HMAC obrigatório):
 *  - Ações sobre a web interagem com o exterior → R2 estrito, exige consentimento
 *    HMAC auditável (o frontend exibe o ConsentCard antes de executar).
 *  - Blocklist de domínios maliciosos conhecidos + padrões de phishing.
 *  - Downloads de executáveis arbitrários bloqueados (Content-Disposition/URL).
 *  - Máximo de passos por execução e timeout global — sem loops infinitos.
 *  - Sem execução de JavaScript arbitrário pelo modelo.
 *  - Retorno: texto extraído + screenshot base64 do estado final (visão computacional).
 */

import path from 'path';
import { ToolDefinition } from '../types';
import { getPageForAgent } from '../browser/playwrightTool';

// ─── Segurança: Blocklist de domínios ────────────────────────────────────────

/** Domínios e padrões conhecidos como maliciosos/phishing/spearfishing */
const DOMAIN_BLOCKLIST: RegExp[] = [
  /\.(tk|ml|ga|cf|gq)$/i,                    // TLDs gratuitos massivamente abusados
  /phishing|malware|virus|keylog/i,          // palavras explícitas no domínio
  /(?:paypal|apple|google|microsoft|amazon|netflix|banco|itau|bradesco|nubank|caixa)\d*\.(?!com(?:\.br)?$)[a-z]{2,}$/i, // typosquatting de marcas
  /^\d{1,3}(\.\d{1,3}){3}$/,                // IPs diretos (comum em infra de ataque)
  /bit\.ly|tinyurl|t\.co|is\.gd|cutt\.ly/i, // encurtadores (destino oculto) em navegação autónoma
];

/** Extensões de download executável — bloqueadas (nunca baixar binários) */
const BLOCKED_DOWNLOAD_EXTENSIONS = new Set([
  '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.js', '.jar',
  '.apk', '.dmg', '.deb', '.rpm', '.sh', '.dll', '.sys'
]);

/** Valida uma URL contra a política de segurança do agente */
function assertAgentSafeUrl(rawUrl: string): { ok: true; url: string } | { ok: false; error: string } {
  let candidate = (rawUrl || '').trim();

  // SEGURANÇA PRIMEIRO: bloqueia esquemas perigosos ANTES de qualquer resolução
  // (a conversão de termo genérico abaixo não deve jamais "lavar" file:// ou javascript:)
  const lowerRaw = candidate.toLowerCase();
  if (
    lowerRaw.startsWith('file://') ||
    lowerRaw.startsWith('javascript:') ||
    lowerRaw.startsWith('data:') ||
    lowerRaw.startsWith('about:') ||
    lowerRaw.startsWith('chrome://') ||
    lowerRaw.startsWith('vbscript:')
  ) {
    return { ok: false, error: `URL_BLOCKED: O esquema '${lowerRaw.split(':')[0]}:' não é permitido por segurança.` };
  }

  // CORREÇÃO (Etapa 3 — agente web perdido): o modelo às vezes passa um TERMO
  // GENÉRICO ("youtube", "google", "wikipedia") em vez de URL estruturada,
  // e a tool falhava com INVALID_URL. Resolve automaticamente: se não tem
  // esquema/ponto, vira busca do Google; se tem ponto mas sem esquema, assume https.
  if (!/^https?:\/\//i.test(candidate)) {
    if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(candidate)) {
      candidate = `https://${candidate}`; // "example.com" → https://example.com
    } else {
      // Termo de busca: "youtube" → pesquisa do Google (não falha)
      candidate = `https://www.google.com/search?q=${encodeURIComponent(candidate)}`;
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: `INVALID_URL: '${rawUrl}' não é uma URL válida.` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `URL_BLOCKED: apenas http/https são permitidos (recebido '${parsed.protocol}').` };
  }

  const host = parsed.hostname.toLowerCase();

  // Loopback/interno: o agente não deve tocar serviços da própria máquina
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) {
    return { ok: false, error: `URL_BLOCKED: destino interno '${host}' não é permitido para o agente web.` };
  }

  // IP direto
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return { ok: false, error: `URL_BLOCKED: navegação para IP direto (${host}) bloqueada — use o domínio.` };
  }

  for (const pattern of DOMAIN_BLOCKLIST) {
    if (pattern.test(host)) {
      return { ok: false, error: `DOMAIN_BLOCKED: domínio '${host}' corresponde a um padrão de bloqueio de segurança.` };
    }
  }

  return { ok: true, url: parsed.toString() };
}

/** Valida se um download é permitido (nunca executáveis) */
function isBlockedDownload(url: string, contentType?: string): string | null {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const ext = path.extname(pathname);
    if (ext && BLOCKED_DOWNLOAD_EXTENSIONS.has(ext)) {
      return `DOWNLOAD_BLOCKED: tipo de arquivo '${ext}' é executável/script e não pode ser baixado pelo agente.`;
    }
    if (contentType) {
      const ct = contentType.toLowerCase();
      if (ct.includes('application/x-msdownload') || ct.includes('application/x-executable') || ct.includes('application/x-dosexec')) {
        return 'DOWNLOAD_BLOCKED: content-type de executável bloqueado.';
      }
    }
    return null;
  } catch {
    return 'DOWNLOAD_BLOCKED: URL de download malformada.';
  }
}

/**
 * CORREÇÃO (Etapa D — falhas de rede faláveis): traduz erros técnicos do
 * Chromium/Playwright em mensagens amigáveis que a LIORA pode FALAR para o
 * usuário (o TTS não consegue pronunciar 'net::ERR_NAME_NOT_RESOLVED').
 */
export function friendlyNetworkError(raw: string): string {
  const msg = raw.toLowerCase();
  if (/net::err_name_not_resolved|dns/.test(msg)) {
    return 'Não consegui acessar o site — o endereço não foi encontrado. Verifique se foi digitado corretamente.';
  }
  if (/net::err_internet_disconnected|err_connection_reset|err_connection_aborted|err_network_changed/.test(msg)) {
    return 'Sua conexão com a internet caiu no meio da tarefa. Tente novamente quando estiver conectado.';
  }
  if (/net::err_timed_out|timeout.*exceeded|navigation timeout/.test(msg)) {
    return 'O site demorou demais para responder. Ele pode estar fora do ar — tente novamente em instantes.';
  }
  if (/net::err_connection_refused/.test(msg)) {
    return 'O site recusou a conexão. Ele pode estar bloqueado ou fora do ar.';
  }
  if (/net::err_cert_|ssl|certificate/.test(msg)) {
    return 'O site tem um problema de certificado de segurança. Por precaução, não acessei.';
  }
  if (/net::err_access_denied|permission/.test(msg)) {
    return 'O site bloqueou o acesso automatizado da LIORA.';
  }
  if (/target closed|browser.*closed|session.*not found/.test(msg)) {
    return 'A sessão do navegador foi encerrada inesperadamente. Tente novamente.';
  }
  if (/timeout.*exceeded.*waiting for|waiting for selector|element.*not.*found/.test(msg)) {
    return 'Não encontrei o elemento esperado na página — a página pode ter carregado diferente do previsto.';
  }
  return raw.replace(/net::/gi, '').slice(0, 200);
}

// ─── Tipos de ações do pipeline ──────────────────────────────────────────────

export interface AgentAction {
  action: 'goto' | 'click' | 'type' | 'scroll' | 'extract_text' | 'screenshot' | 'wait_for_selector' | 'select_option' | 'press_key';
  /** URL para goto (apenas na primeira ação ou navegações subsequentes) */
  url?: string;
  /** Seletor CSS/texto para click, type, wait_for_selector, select_option, extract_text */
  selector?: string;
  /** Texto para type, valor para select_option, tecla para press_key */
  value?: string;
  /** Pixels para scroll (positivo = baixo, negativo = cima) */
  amount?: number;
  /** Descrição em linguagem natural do passo (para auditoria) */
  description?: string;
}

export interface AgentRunResult {
  success: boolean;
  /** Falha amigável e falável (Etapa D) — para o TTS falar sem 'net::ERR_...' cru */
  userFriendlyMessage?: string;
  sessionId: string;
  stepsExecuted: Array<{ index: number; action: string; ok: boolean; detail: string }>;
  finalUrl: string;
  title: string;
  extractedText?: string;
  screenshot?: string; // base64 PNG do estado final
  error?: string;
  simulated: boolean;
  timestamp: string;
}

// ─── Limites de execução ─────────────────────────────────────────────────────

const MAX_STEPS = 12;              // pipeline nunca passa de 12 ações
const STEP_TIMEOUT_MS = 15000;     // timeout por passo
const GLOBAL_TIMEOUT_MS = 90000;   // timeout global de toda a execução
const MAX_EXTRACT_CHARS = 20000;   // limite de texto extraído

// ─── Ferramenta ──────────────────────────────────────────────────────────────

export const webBrowserAgentTool: ToolDefinition<{
  sessionId?: string;
  url: string;
  actions: AgentAction[];
  maxSteps?: number;
}, AgentRunResult> = {
  name: 'web_browser_agent',
  description:
    'Agente web autónomo: navega para uma URL e executa uma sequência de ações (click, type, scroll, ' +
    'extract_text, screenshot, select_option, press_key) em uma única execução controlada. ' +
    'Retorna o texto extraído e um screenshot do estado final para análise visual. ' +
    'AÇÕES DE RISCO (R2): exige consentimento do operador antes de submeter formulários ou interagir com sites externos.',
  category: 'browser',
  riskLevel: 'R2',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'ID de sessão Playwright existente (de browser_open_url). Se omitido, o agente cria sessão própria via goto.'
      },
      url: {
        type: 'string',
        description: 'URL inicial de navegação (http/https).'
      },
      actions: {
        type: 'array',
        description: `Pipeline de ações sequenciais (máx ${MAX_STEPS}). Cada passo executa em ordem; o pipeline para no primeiro erro.`,
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'Ação a executar: goto, click, type, scroll, extract_text, screenshot, wait_for_selector, select_option ou press_key.', enum: ['goto', 'click', 'type', 'scroll', 'extract_text', 'screenshot', 'wait_for_selector', 'select_option', 'press_key'] },
            url: { type: 'string', description: 'URL destino (apenas para action=goto).' },
            selector: { type: 'string', description: 'Seletor CSS do elemento (click, type, wait_for_selector, select_option, extract_text).' },
            value: { type: 'string', description: 'Texto a digitar (type), valor da opção (select_option) ou tecla (press_key, ex: Enter).' },
            amount: { type: 'number', description: 'Pixels de scroll (positivo = baixo, negativo = cima). Padrão 500.' },
            description: { type: 'string', description: 'Descrição opcional do passo em linguagem natural (para auditoria).' }
          },
          required: ['action']
        }
      },
      maxSteps: {
        type: 'number',
        description: 'Limite de passos desta execução (1-12). Padrão 12.',
        default: MAX_STEPS
      }
    },
    required: ['url', 'actions'],
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'sessionId', 'stepsExecuted', 'finalUrl', 'simulated'] },
  execute: async (params) => {
    const startedAt = Date.now();
    const result: AgentRunResult = {
      success: false,
      sessionId: params.sessionId || '',
      stepsExecuted: [],
      finalUrl: '',
      title: '',
      simulated: false,
      timestamp: new Date().toISOString()
    };

    // ── 1. Validação de entrada ──
    const actions = Array.isArray(params.actions) ? params.actions.slice(0, Math.max(1, Math.min(MAX_STEPS, params.maxSteps || MAX_STEPS))) : [];
    if (actions.length === 0) {
      result.error = 'NO_ACTIONS: nenhuma ação fornecida no pipeline.';
      return result;
    }

    const urlCheck = assertAgentSafeUrl(params.url);
    if (!urlCheck.ok) {
      result.error = urlCheck.error;
      return result;
    }

    // ── 2. Garantir sessão de browser ──
    let sessionId = params.sessionId || '';
    let page: import('playwright').Page | null = null;

    if (sessionId) {
      page = getPageForAgent(sessionId);
      if (!page) {
        result.error = `SESSION_NOT_FOUND: sessão '${sessionId}' não existe ou expirou. Use browser_open_url para criar.`;
        return result;
      }
    } else {
      // Cria sessão via browser_open_url (reutiliza todo o gerenciamento de sessões)
      const { browserOpenUrlTool } = await import('../browser/playwrightTool');
      const openRes = await browserOpenUrlTool.execute({ url: urlCheck.url });
      if (!openRes.success) {
        result.error = String(openRes.error || 'Falha ao abrir a URL inicial.');
        return result;
      }
      sessionId = String(openRes.sessionId);
      result.sessionId = sessionId;
      page = getPageForAgent(sessionId);
      if (!page) {
        result.error = 'SESSION_LOST: sessão criada mas não recuperável.';
        return result;
      }
    }

    // ── 3. Proteção contra downloads de executáveis ──
    page.on('download', async (download) => {
      const blocked = isBlockedDownload(download.url());
      if (blocked) {
        try { await download.cancel(); } catch { /* ignore */ }
        console.warn(`[WebAgent] ${blocked} (${download.url()})`);
      }
    });

    // ── 4. Execução do pipeline ──
    const globalTimer = setTimeout(() => {
      result.error = result.error || `GLOBAL_TIMEOUT: execução excedeu ${GLOBAL_TIMEOUT_MS / 1000}s.`;
    }, GLOBAL_TIMEOUT_MS);

    try {
      // Navegação inicial (se sessão recém-criada, browser_open_url já navegou)
      if (params.sessionId) {
        // Sessão existente: re-navega para a URL pedida
        const gotoCheck = assertAgentSafeUrl(params.url);
        if (!gotoCheck.ok) {
          result.error = gotoCheck.error;
          return result;
        }
        await page.goto(gotoCheck.url, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT_MS });
      }

      let lastExtractedText = '';

      for (let i = 0; i < actions.length; i++) {
        if (Date.now() - startedAt > GLOBAL_TIMEOUT_MS) {
          result.error = result.error || 'GLOBAL_TIMEOUT: pipeline interrompido.';
          break;
        }

        const step = actions[i];
        const stepLog = { index: i, action: step.action, ok: false, detail: '' };

        try {
          switch (step.action) {
            case 'goto': {
              const check = assertAgentSafeUrl(step.url || '');
              if (!check.ok) throw new Error(check.error);
              // Verifica download antes de navegar
              const dl = isBlockedDownload(check.url);
              if (dl) throw new Error(dl);
              // CORREÇÃO (Etapa D — rede oscilante): retry 1× para erros TRANSIENTES
              // (timeout, ERR_CONNECTION_RESET, ERR_INTERNET_DISCONNECTED momentâneo).
              // Antes, uma oscilação de 1s matava o pipeline inteiro no meio.
              try {
                await page.goto(check.url, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT_MS });
              } catch (navErr: any) {
                const msg = String(navErr?.message || '');
                const transient = /Timeout.*exceeded|net::ERR_(CONNECTION_RESET|TIMED_OUT|INTERNET_DISCONNECTED|CONNECTION_ABORTED)/i.test(msg);
                if (!transient) throw navErr;
                await page.waitForTimeout(2000); // espera 2s e tenta mais uma vez
                await page.goto(check.url, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT_MS });
              }
              stepLog.ok = true;
              stepLog.detail = `Navegou para ${page.url()}`;
              break;
            }

            case 'click': {
              if (!step.selector) throw new Error('MISSING_SELECTOR: click exige selector.');
              await page.click(step.selector, { timeout: STEP_TIMEOUT_MS });
              stepLog.ok = true;
              stepLog.detail = `Clicou em '${step.selector}'`;
              break;
            }

            case 'type': {
              if (!step.selector || step.value === undefined) throw new Error('MISSING_PARAMS: type exige selector e value.');
              await page.fill(step.selector, String(step.value).slice(0, 5000), { timeout: STEP_TIMEOUT_MS });
              stepLog.ok = true;
              stepLog.detail = `Digitou ${String(step.value).length} caracteres em '${step.selector}'`;
              break;
            }

            case 'scroll': {
              const amount = Math.max(-5000, Math.min(5000, step.amount ?? 500));
              await page.mouse.wheel(0, amount);
              await page.waitForTimeout(300);
              stepLog.ok = true;
              stepLog.detail = `Scroll ${amount > 0 ? 'para baixo' : 'para cima'} (${Math.abs(amount)}px)`;
              break;
            }

            case 'extract_text': {
              const text = step.selector
                ? await page.locator(step.selector).first().innerText({ timeout: STEP_TIMEOUT_MS })
                : await page.evaluate(() => document.body?.innerText || '');
              lastExtractedText = (text || '').slice(0, MAX_EXTRACT_CHARS);
              result.extractedText = lastExtractedText;
              stepLog.ok = true;
              stepLog.detail = `Extraídos ${lastExtractedText.length} caracteres${step.selector ? ` de '${step.selector}'` : ' do corpo da página'}`;
              break;
            }

            case 'screenshot': {
              const buf = await page.screenshot({ type: 'png', fullPage: false });
              result.screenshot = buf.toString('base64');
              stepLog.ok = true;
              stepLog.detail = `Screenshot capturado (${Math.round(buf.length / 1024)} KB)`;
              break;
            }

            case 'wait_for_selector': {
              if (!step.selector) throw new Error('MISSING_SELECTOR: wait_for_selector exige selector.');
              await page.waitForSelector(step.selector, { timeout: STEP_TIMEOUT_MS });
              stepLog.ok = true;
              stepLog.detail = `Elemento '${step.selector}' presente`;
              break;
            }

            case 'select_option': {
              if (!step.selector || step.value === undefined) throw new Error('MISSING_PARAMS: select_option exige selector e value.');
              await page.selectOption(step.selector, String(step.value), { timeout: STEP_TIMEOUT_MS });
              stepLog.ok = true;
              stepLog.detail = `Selecionado '${step.value}' em '${step.selector}'`;
              break;
            }

            case 'press_key': {
              const key = (step.value || '').trim();
              if (!key) throw new Error('MISSING_VALUE: press_key exige a tecla (ex: Enter).');
              await page.keyboard.press(key);
              stepLog.ok = true;
              stepLog.detail = `Tecla '${key}' pressionada`;
              break;
            }

            default:
              throw new Error(`UNKNOWN_ACTION: '${(step as any).action}' não suportada.`);
          }
        } catch (stepErr: any) {
          const rawMsg = String(stepErr?.message || 'falha desconhecida').slice(0, 300);
          stepLog.detail = rawMsg;
          result.stepsExecuted.push(stepLog);

          // CORREÇÃO (Etapa D — rede cai no meio do pipeline): traduz erros técnicos
          // do Chromium para falha AMIGÁVEL e falável, em vez de 'net::ERR_...' cru.
          const friendly = friendlyNetworkError(rawMsg);
          result.error = `STEP_${i}_FAILED (${step.action}): ${friendly}`;
          result.userFriendlyMessage = friendly;
          // Interrompe o pipeline no primeiro passo que falha (execução determinística)
          break;
        }

        result.stepsExecuted.push(stepLog);
      }

      // ── 5. Estado final ──
      result.finalUrl = page.url();
      try { result.title = await page.title(); } catch { /* ignore */ }

      // BLINDAGEM ANTI-SUCESSO-FALSO (Etapa 3): verifica o estado REAL da página.
      // Se a navegação falhou (página de erro, about:blank, DNS), o resultado NÃO
      // pode reportar success mesmo que os passos "executaram" sem throw — isso
      // levava o modelo a mentir "já abri o YouTube" quando nada aconteceu.
      const finalUrl = page.url();
      if (finalUrl === 'about:blank' || /ERR_(NAME_NOT_RESOLVED|CONNECTION|INTERNET)/i.test(finalUrl)) {
        result.success = false;
        result.error = result.error || `NAVIGATION_FAILED: a página não carregou (URL final: '${finalUrl}'). Verifique a conexão ou o endereço.`;
        return result;
      }

      // Screenshot final automático se nenhum passo capturou
      if (!result.screenshot) {
        try {
          const buf = await page.screenshot({ type: 'png', fullPage: false });
          result.screenshot = buf.toString('base64');
        } catch { /* screenshot final opcional */ }
      }

      result.success = !result.error && result.stepsExecuted.length > 0;

      // FIX (hang do runner de testes): quando o agente cria a PRÓPRIA sessão
      // (sessionId omitido), ela é efêmera por design — fecha ao final do pipeline
      // para liberar o Chromium e não reter o event loop. Sessões fornecidas pelo
      // chamador (sessionId passado) permanecem abertas para reuso em cadeias.
      if (!params.sessionId) {
        try {
          const { browserCloseSessionTool } = await import('../browser/playwrightTool');
          await browserCloseSessionTool.execute({ sessionId });
        } catch { /* ignore */ }
      }

      return result;
    } catch (err: any) {
      result.error = `AGENT_ERROR: ${err?.message || 'falha desconhecida do agente'}`;
      return result;
    } finally {
      clearTimeout(globalTimer);
    }
  }
};

/** Export para registro em massa no nativeServerTools */
export const allWebAgentTools: ToolDefinition<any, any>[] = [
  webBrowserAgentTool
];

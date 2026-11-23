/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — LEITURA REAL DE PÁGINAS (Browser Use sem "abrir e não saber ler")
 *
 * Por que existe (relato de campo): "pedi o tempo até Curitiba e ela só abriu o
 * Google Maps e mandou eu olhar a tela"; "perguntei os mercados próximos e ela
 * não falou os nomes". `open_gps_navigation`/`maps_search_places` apenas ABREM
 * a URL — quem responde é a página. Esta ferramenta abre a página num Chromium
 * headless (Playwright, JÁ instalado neste projeto) e devolve o TEXTO lido, para
 * o modelo responder com dados reais em vez de mandar o usuário olhar a tela.
 *
 * Segurança: reutiliza a política de URLs do módulo de browser (bloqueia file:,
 * javascript:, data:, localhost/IPs privados) e nunca executa JS arbitrário.
 */

import { ToolDefinition } from '../types';

export interface PageReadResult {
  ok: boolean;
  url?: string;
  title?: string;
  text?: string;
  error?: string;
}

/** Bloqueia esquemas e destinos locais/inseguros (SSRF). */
function assertReadableUrl(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) throw new Error('INVALID_URL: informe a URL.');

  // ORDEM IMPORTA: rejeitar esquemas perigosos ANTES de prefixar "https://".
  // Antes `file:///C:/...` virava `https://file///C:/...` e escapava do teste
  // de protocolo — o mesmo furo permitiria `javascript:` e `data:`.
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      throw new Error(`URL_BLOCKED: esquema '${scheme}:' não permitido (use http ou https).`);
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(schemeMatch ? value : `https://${value}`);
  } catch {
    throw new Error('INVALID_URL: URL inválida.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`URL_BLOCKED: esquema '${parsed.protocol}' não permitido.`);
  }
  const host = parsed.hostname.toLowerCase();
  const isLocalHost =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host);
  if (isLocalHost) throw new Error('URL_BLOCKED: endereços locais/privados não são acessíveis.');
  return parsed.toString();
}

/**
 * Lê o conteúdo textual de uma URL com Chromium headless.
 * Exportada para reuso por outras tools (ex.: rota com tempo estimado).
 */
export async function readPageText(url: string, options: { timeoutMs?: number; maxChars?: number } = {}): Promise<PageReadResult> {
  const timeoutMs = Math.max(3000, Math.min(30000, options.timeoutMs ?? 20000));
  const maxChars = Math.max(200, Math.min(20000, options.maxChars ?? 6000));

  let safeUrl: string;
  try {
    safeUrl = assertReadableUrl(url);
  } catch (err: any) {
    return { ok: false, error: err?.message || 'URL inválida.' };
  }

  let browser: any = null;
  try {
    const pw: any = await import('playwright');
    browser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' });
    await page.goto(safeUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    // Pequena espera por conteúdo dinâmico (Maps/SPA montam depois do DOMContentLoaded)
    await page.waitForTimeout(1200);
    const title: string = await page.title();
    const bodyText: string = await page.evaluate(() => {
      const remove = ['script', 'style', 'noscript', 'svg'];
      for (const tag of remove) document.querySelectorAll(tag).forEach((el) => el.remove());
      return (document.body.innerText || '').replace(/\n{3,}/g, '\n\n');
    });
    const text = String(bodyText || '').slice(0, maxChars).trim();
    const finalUrl = page.url();
    await browser.close();
    browser = null;
    if (!text) {
      return { ok: false, url: finalUrl, title, error: 'PAGE_EMPTY: a página não retornou texto legível (pode exigir JavaScript/login).' };
    }

    // BUG CORRIGIDO (leitura que "mente"): Google/Bing/DuckDuckGo frequentemente
    // devolvem página de CAPTCHA/erro para navegadores headless. Sem esta
    // checagem a tool respondia success:true com texto de bloqueio e o modelo
    // trataria isso como resposta real. Detecta: (a) sinais explícitos de
    // anti-bot; (b) conteúdo curto e sem palavras substantivas (página de
    // erro vazia) — nunca afirmamos "li a página" sem texto útil.
    const blockedSignal = /unusual traffic|not a robot|captcha|tráfego incomum|access denied|403 forbidden|if this persists|anonymized error|enable javascript|verify you are human/i.test(text);
    const wordCount = text.split(/\s+/).filter((w) => /[A-Za-zÀ-ÿ]{3,}/.test(w)).length;
    const looksLikeErrorPage = wordCount < 25;
    if (blockedSignal || looksLikeErrorPage) {
      return {
        ok: false,
        url: finalUrl,
        title,
        error: blockedSignal
          ? 'PAGE_BLOCKED_BY_SITE: o site exigiu verificação humana (CAPTCHA/anti-bot). Não é possível ler este conteúdo automaticamente — use outra fonte ou peça ao Mestre para abrir no navegador.'
          : 'PAGE_WITHOUT_CONTENT: a página não expôs conteúdo legível (possivelmente bloqueada por anti-bot ou carregada por JavaScript pesado).'
      };
    }

    return { ok: true, url: finalUrl, title, text };
  } catch (err: any) {
    try { await browser?.close(); } catch { /* ignore */ }
    const message = String(err?.message || err);
    if (/Cannot find module|Executable doesn't exist/i.test(message)) {
      return { ok: false, error: 'BROWSER_INSTALL_REQUIRED: execute "npx playwright install chromium" para habilitar a leitura de páginas.' };
    }
    return { ok: false, error: `PAGE_READ_FAILED: ${message.slice(0, 300)}` };
  }
}

export const browserReadPageTool: ToolDefinition<{
  url: string;
  maxChars?: number;
}, any> = {
  name: 'browser_read_page',
  description: 'Abre uma página web em um navegador headless e retorna o TEXTO visível dela. Use SEMPRE que a resposta estiver na própria página — por exemplo, depois de abrir o Google Maps, para dizer o tempo estimado real de uma rota, ou para listar os nomes/avaliações de estabelecimentos encontrados. Nunca diga "está na sua tela": leia a página e responda com os dados. Risco R1.',
  category: 'browser',
  riskLevel: 'R1',
  isSimulated: false,
  timeoutMs: 40000,
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL completa (http/https) a ser lida.' },
      maxChars: { type: 'number', description: 'Máximo de caracteres do texto retornado (200–20000, padrão 6000).' }
    },
    required: ['url'],
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'simulated'] },
  execute: async ({ url, maxChars }) => {
    const result = await readPageText(url, { maxChars });
    if (!result.ok) {
      return {
        success: false,
        error: result.error,
        url: result.url || url,
        title: result.title,
        simulated: false,
        timestamp: new Date().toISOString()
      };
    }
    return {
      success: true,
      url: result.url,
      title: result.title,
      text: result.text,
      chars: result.text?.length ?? 0,
      message: `Página '${result.title}' lida (${result.text?.length ?? 0} caracteres).`,
      simulated: false,
      timestamp: new Date().toISOString()
    };
  }
};

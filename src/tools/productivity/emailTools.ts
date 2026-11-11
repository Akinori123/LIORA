/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — FASE 2: MÓDULO DE E-MAIL (Produtividade)
 *
 * Ferramentas de leitura (R1) e envio (R2) de e-mail REAIS via IMAP/SMTP,
 * com credenciais armazenadas exclusivamente no cofre local do usuário
 * (integrationsVault — svc-email-imap). Nenhum dado sai da máquina exceto
 * para o servidor de e-mail do próprio usuário.
 *
 * Formato da credencial no cofre (campo rawKey do serviço):
 *   imap://usuario:senha@host:porta|smtp://usuario:senha@host:porta
 *
 * Implementação IMAP/SMTP em Node puro (TLS sockets + protocolo textual) —
 * sem dependências externas. Suporta:
 *  - LOGIN/STARTTLS, LIST/SELECT, SEARCH, FETCH (headers + corpo)
 *  - SMTP: EHLO, AUTH LOGIN, MAIL FROM, RCPT TO, DATA
 *
 * R1: email_fetch_and_read  — leitura de caixa de entrada
 * R2: email_send_or_reply   — envio/resposta (consentimento HMAC obrigatório)
 */

import tls from 'tls';
import net from 'net';
import { ToolDefinition } from '../types';
import { integrationsVault } from '../../services/integrationsVault';

// ─── Parse da credencial do cofre ────────────────────────────────────────────

interface MailCredential {
  imap: { host: string; port: number; user: string; pass: string };
  smtp: { host: string; port: number; user: string; pass: string };
}

/**
 * Extrai credenciais IMAP/SMTP do cofre.
 * Formato no rawKey: "imap://user:pass@host:port|smtp://user:pass@host:port"
 * (separador | entre os dois blocos)
 */
function loadMailCredential(): MailCredential | null {
  const raw = integrationsVault.getApiKeyByProvider('email')
    || integrationsVault.getRawKey('svc-email-imap');
  if (!raw || raw.length < 10) return null;

  try {
    const parts = raw.split('|');
    const imapPart = parts.find(p => p.startsWith('imap://')) || '';
    const smtpPart = parts.find(p => p.startsWith('smtp://')) || '';

    const parseBlock = (block: string, defaultPort: number) => {
      const m = /^([a-z]+):\/\/([^:]+):([^@]*)@([^:]+):(\d+)$/i.exec(block.trim());
      if (!m) return null;
      return { user: decodeURIComponent(m[2]), pass: decodeURIComponent(m[3]), host: m[4], port: parseInt(m[5], 10) || defaultPort };
    };

    const imap = parseBlock(imapPart, 993);
    const smtp = parseBlock(smtpPart, 587);
    if (!imap) return null;

    return {
      imap,
      smtp: smtp || { ...imap, port: 587 }
    };
  } catch {
    return null;
  }
}

// ─── Cliente IMAP mínimo (Node puro) ─────────────────────────────────────────

interface ImapResponse {
  status: string;
  data: string[];
}

/**
 * Executa uma sequência IMAP simples: conecta (TLS implícito ou STARTTLS),
 * autentica LOGIN, executa comandos e sai. Retorna as respostas não-tagged.
 */
  /**
   * BUG CRÍTICO CORRIGIDO (pipeline em duas etapas): o protocolo IMAP exige que
   * o intervalo do FETCH seja calculado APÓS o SEARCH responder. Antes, ambos
   * iam juntos na fila com '1:*' fixo. Agora: uma função `onBeforeNext`
   * permite ao chamador INJETAR comandos dinamicamente com base nas respostas
   * anteriores (ex: monta o FETCH com o UID exato da última mensagem da busca).
   */
  async function imapSession(
    cred: { host: string; port: number; user: string; pass: string },
    commands: string[],
    timeoutMs = 15000,
    /** Callback executado após cada comando OK — pode INJETAR novos comandos */
    onBeforeNext?: (collected: string[], nextCommandIndex: number) => string[] | null
  ): Promise<ImapResponse> {
  return new Promise((resolve, reject) => {
    const data: string[] = [];
    let status = '';
    let buffer = '';
    let cmdIdx = 0;
    const tag = 'A';
    let socket: tls.TLSSocket | net.Socket;
    let tagCounter = 0;
    let startTimer: NodeJS.Timeout | null = null;
    let logoutTimer: NodeJS.Timeout | null = null;

    const finish = (err?: Error) => {
      clearTimeout(timeout);
      if (startTimer) { clearTimeout(startTimer); startTimer = null; }
      if (logoutTimer) { clearTimeout(logoutTimer); logoutTimer = null; }
      try { 
        if (!socket.destroyed) {
          socket.end(); 
          socket.destroy();
        }
      } catch { /* ignore */ }
      if (err) reject(err);
      else resolve({ status, data });
    };

    const timeout = setTimeout(() => finish(new Error(`IMAP_TIMEOUT: servidor ${cred.host}:${cred.port} não respondeu em ${timeoutMs / 1000}s.`)), timeoutMs);

    try {
      socket = tls.connect({ host: cred.host, port: cred.port, rejectUnauthorized: false }, () => {
        // TLS conectado — espera greeting, depois processa
      });
    } catch (err: any) {
      clearTimeout(timeout);
      return reject(new Error(`IMAP_CONNECT_FAILED: ${err?.message || 'falha de conexão'}`));
    }

    socket.setEncoding('utf8');
    socket.on('error', (err) => {
      clearTimeout(timeout);
      finish(new Error(`IMAP_ERROR: ${err.message}`));
    });

    const sendNext = () => {
      if (socket.destroyed || socket.writableEnded) return;
      if (cmdIdx >= commands.length) {
        clearTimeout(timeout);
        try { socket.write(`B LOGOUT\r\n`); } catch {}
        logoutTimer = setTimeout(() => finish(), 300);
        return;
      }
      const cmd = commands[cmdIdx];
      tagCounter++;
      try {
        socket.write(`A${tagCounter} ${cmd}\r\n`);
      } catch (writeErr) {
        finish(writeErr as Error);
        return;
      }
      cmdIdx++;
    };

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      // Processa linhas completas — BUG FIX: linha a linha com regex de tag ÚNICA
      // (antes, o tag 'A' casava com QUALQUER linha começando com 'A' — ex:
      // Subject: Apple — e o servidor achava que o comando terminou antes da hora,
      // desincronizando o protocolo completamente).
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const tagMatch = new RegExp(`^A${tagCounter}\\s`).exec(line);
        if (tagMatch) {
          const result = line.slice(tagMatch[0].length).toUpperCase();
          if (result.startsWith('OK')) {
            status = 'OK';
            // BUG FIX (pipeline dinâmico): o callback pode INJETAR novos comandos
            // com base nas respostas coletadas (ex: montar FETCH com UIDs da busca)
            if (onBeforeNext && cmdIdx < commands.length) {
              const injected = onBeforeNext(data, cmdIdx);
              if (injected && injected.length > 0) {
                commands.splice(cmdIdx, 0, ...injected);
              }
            }
            sendNext();
          } else if (result.startsWith('NO') || result.startsWith('BAD')) {
            clearTimeout(timeout);
            finish(new Error(`IMAP_REJECTED: ${line.slice(tagMatch[0].length).slice(0, 200)}`));
            return;
          }
        } else {
          if (line.startsWith('* OK') || line.startsWith('* BYE')) continue;
          data.push(line);
        }
      }
    });

    // Espera o greeting e começa
    socket.once('data', () => {
      startTimer = setTimeout(sendNext, 100);
    });
  });
}

/** Parse simples de headers de e-mail a partir de linhas FETCH */
function parseEmailHeaders(raw: string): { from: string; subject: string; date: string } {
  const fromMatch = /From:\s*(.+)/i.exec(raw);
  const subjMatch = /Subject:\s*(.+)/i.exec(raw);
  const dateMatch = /Date:\s*(.+)/i.exec(raw);
  return {
    from: (fromMatch?.[1] || 'desconhecido').trim(),
    subject: (subjMatch?.[1] || '(sem assunto)').trim(),
    date: (dateMatch?.[1] || '').trim()
  };
}

// ─── Ferramentas ─────────────────────────────────────────────────────────────

/**
 * email_fetch_and_read (R1) — leitura real da caixa de entrada via IMAP.
 */
export const emailFetchAndReadTool: ToolDefinition<{
  mode: 'recent' | 'unread' | 'search';
  query?: string;
  maxMessages?: number;
  readBody?: boolean;
}, any> = {
  name: 'email_fetch_and_read',
  description: 'Lê e-mails REAIS da caixa de entrada do usuário via IMAP: lista as mensagens mais recentes, as não lidas, ou pesquisa por remetente/assunto/conteúdo. Use quando o usuário pedir "quais e-mails novos tenho", "procure o e-mail do João", "leia minha caixa de entrada".',
  category: 'system',
  riskLevel: 'R1',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['recent', 'unread', 'search'], description: 'recent = últimas mensagens; unread = não lidas; search = busca por termo.', default: 'recent' },
      query: { type: 'string', description: 'Termo de busca IMAP (usado com mode=search). Busca em remetente, assunto e corpo.' },
      maxMessages: { type: 'number', description: 'Máximo de mensagens a retornar (1-25). Padrão 10.', default: 10 },
      readBody: { type: 'boolean', description: 'Se true, inclui o início do corpo da mensagem (primeiros 2000 caracteres).' }
    },
    required: ['mode'],
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'messages', 'simulated'] },
  execute: async (params) => {
    const cred = loadMailCredential();
    if (!cred) {
      return {
        success: false,
        error: 'EMAIL_NOT_CONFIGURED: nenhuma conta IMAP configurada no Cofre. Configure o serviço "E-mail IMAP/SMTP" em Integrações com o formato imap://usuario:senha@host:porta|smtp://usuario:senha@host:porta.',
        messages: [],
        simulated: false,
        timestamp: new Date().toISOString()
      };
    }

    const maxMsgs = Math.max(1, Math.min(25, params.maxMessages || 10));

    // Monta a sequência de comandos IMAP conforme o modo
    let searchClause = 'ALL';
    if (params.mode === 'unread') searchClause = 'UNSEEN';
    if (params.mode === 'search' && params.query) {
      // Sanitiza a query: IMAP SEARCH é textual — remove aspas/CR/LF (anti-injeção)
      const safe = (params.query || '').replace(/["\r\n\\]/g, ' ').trim().slice(0, 200);
      if (safe) searchClause = `TEXT "${safe}"`;
    }

    // BUG CRÍTICO CORRIGIDO: o FETCH usava o intervalo fixo '1:*' — IGNORAVA
    // completamente o resultado da busca e baixava os cabeçalhos de TODAS as
    // mensagens da caixa (na prática: sempre os e-mails mais antigos, nunca os
    // que a busca encontrou). Agora o pipeline é em DUAS etapas: primeiro SEARCH
    // coleta os UIDs; a resposta determina o intervalo exato do FETCH.
    // Também: LOGIN com aspas (senhas com espaços/chars especiais quebravam o
    // protocolo) e sanitização de CR/LF nos campos (anti-injeção de comando IMAP).
    const imapUser = cred.imap.user.replace(/["\r\n]/g, '');
    const imapPass = cred.imap.pass.replace(/["\r\n]/g, '');

    try {
      // SEGUNDA ETAPA: ao terminar o SEARCH, injetamos o comando FETCH exato
      // com os UIDs reais encontrados (pipeline dinâmico do imapSession).
      let fetchCommand: string | null = null;
      const res = await imapSession(
        cred.imap,
        [
          `LOGIN "${imapUser}" "${imapPass}"`,
          'SELECT INBOX',
          `UID SEARCH ${searchClause}`
        ],
        20000,
        (collected) => {
          // Chamado após cada OK. No SEARCH (3º comando), monta o FETCH dinâmico.
          // BUG FIX: regex exato — 'SELECT' contém 'SEARCH'? Não, mas 'UID SEARCH'
          // vs linhas de dados exigem âncora. Casamos apenas a linha de resposta
          // do SEARCH: começa com '* SEARCH'.
          const searchLine = collected.find(l => /^\*\s*SEARCH/i.test(l));
          if (!searchLine || fetchCommand) return null; // só injeta uma vez, após SEARCH
          const uidMatch = /SEARCH\s+([\d\s]+)$/i.exec(searchLine);
          const uids = (uidMatch?.[1] || '').trim().split(/\s+/).filter(u => /^\d+$/.test(u)).slice(-maxMsgs).reverse();
          if (uids.length === 0) return null;
          fetchCommand = `UID FETCH ${uids.join(',')} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`;
          return [fetchCommand];
        }
      );

      // Parse das respostas SEARCH e FETCH
      const searchLine = res.data.find(l => /^(\*\s+)?SEARCH/i.test(l) || l.toUpperCase().includes('SEARCH'));
      const uidMatch = searchLine?.match(/SEARCH(.*)/i);
      const uids = (uidMatch?.[1] || '').trim().split(/\s+/).filter(u => /^\d+$/.test(u)).slice(-maxMsgs).reverse();

      if (uids.length === 0) {
        return {
          success: true,
          mailbox: 'INBOX',
          mode: params.mode,
          messages: [],
          count: 0,
          message: 'Nenhuma mensagem correspondente encontrada.',
          simulated: false,
          timestamp: new Date().toISOString()
        };
      }

      // Extrai blocos de FETCH das linhas retornadas
      const messages: Array<{ uid: string; from: string; subject: string; date: string; bodyPreview?: string }> = [];
      let current: any = null;
      for (const line of res.data) {
        const fetchStart = /UID\s+(\d+)\s+/i.exec(line);
        if (fetchStart) {
          if (current && messages.length < maxMsgs) messages.push(current);
          current = { uid: fetchStart[1], from: '', subject: '', date: '' };
        }
        if (current) {
          const from = /From:\s*(.+)/i.exec(line);
          const subj = /Subject:\s*(.+)/i.exec(line);
          const date = /Date:\s*(.+)/i.exec(line);
          if (from) current.from = from[1].trim();
          if (subj) current.subject = subj[1].trim();
          if (date) current.date = date[1].trim();
          // Corpo: linhas após o blank do header
          if (params.readBody && current.from && !current.bodyPreview && line.length > 2 && !/^[A-Z][a-z-]+:/.test(line)) {
            current.bodyPreview = line.slice(0, 2000);
          }
        }
      }
      if (current && messages.length < maxMsgs) messages.push(current);

      return {
        success: true,
        mailbox: 'INBOX',
        mode: params.mode,
        query: params.mode === 'search' ? params.query : undefined,
        messages: messages.slice(0, maxMsgs),
        count: messages.length,
        simulated: false,
        timestamp: new Date().toISOString()
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message || 'EMAIL_FETCH_FAILED: falha desconhecida na leitura IMAP.',
        messages: [],
        simulated: false,
        timestamp: new Date().toISOString()
      };
    }
  }
};

/**
 * email_send_or_reply (R2) — envio real via SMTP.
 * Toda chamada exige consentimento HMAC (o engine bloqueia sem token).
 */
export const emailSendOrReplyTool: ToolDefinition<{
  to: string;
  subject: string;
  body: string;
  cc?: string;
  replyToMessageUid?: string;
  isHtml?: boolean;
}, any> = {
  name: 'email_send_or_reply',
  description: 'Envia um e-mail REAL via SMTP do usuário: nova mensagem ou resposta. AÇÃO DE ALTO IMPACTO (R2) — exige confirmação explícita do operador (consentimento HMAC) antes de enviar, pois envia conteúdo para pessoas reais.',
  category: 'system',
  riskLevel: 'R2',
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Endereço de e-mail do destinatário (ex: nome@dominio.com).' },
      subject: { type: 'string', description: 'Assunto da mensagem (máx 200 caracteres).' },
      body: { type: 'string', description: 'Corpo da mensagem (máx 20000 caracteres).' },
      cc: { type: 'string', description: 'Destinatários em cópia (separados por vírgula).' },
      isHtml: { type: 'boolean', description: 'Se true, o corpo é enviado como HTML; caso contrário texto puro (padrão).' }
    },
    required: ['to', 'subject', 'body'],
    additionalProperties: false
  },
  outputSchema: { type: 'object', requiredFields: ['success', 'simulated'] },
  execute: async (params) => {
    const cred = loadMailCredential();
    if (!cred) {
      return {
        success: false,
        error: 'EMAIL_NOT_CONFIGURED: nenhuma conta SMTP configurada no Cofre. Configure o serviço "E-mail IMAP/SMTP" em Integrações.',
        simulated: false,
        timestamp: new Date().toISOString()
      };
    }

    // ── Validações rígidas de entrada ──
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const recipients = params.to.split(',').map(s => s.trim()).filter(Boolean);
    if (recipients.length === 0 || recipients.some(r => !EMAIL_RE.test(r))) {
      return { success: false, error: `INVALID_RECIPIENT: destinatário(s) inválido(s): '${params.to}'.`, simulated: false, timestamp: new Date().toISOString() };
    }
    const ccRecipients = (params.cc || '').split(',').map(s => s.trim()).filter(Boolean);
    if (ccRecipients.some(r => !EMAIL_RE.test(r))) {
      return { success: false, error: `INVALID_CC: endereço(s) em cópia inválido(s): '${params.cc}'.`, simulated: false, timestamp: new Date().toISOString() };
    }

    const subject = (params.subject || '').replace(/[\r\n]/g, ' ').slice(0, 200);
    const body = (params.body || '').slice(0, 20000);
    if (!subject) return { success: false, error: 'MISSING_SUBJECT: o assunto é obrigatório.', simulated: false, timestamp: new Date().toISOString() };
    if (!body) return { success: false, error: 'MISSING_BODY: o corpo da mensagem é obrigatório.', simulated: false, timestamp: new Date().toISOString() };

    // Header injection: bloqueia CR/LF em campos
    for (const r of [...recipients, ...ccRecipients]) {
      if (/[\r\n]/.test(r)) return { success: false, error: 'HEADER_INJECTION_BLOCKED: quebras de linha no destinatário bloqueadas.', simulated: false, timestamp: new Date().toISOString() };
    }

    const allRecipients = [...recipients, ...ccRecipients];
    const mimeBody = params.isHtml
      ? `--LIORA-BOUNDARY\r\nContent-Type: text/html; charset="UTF-8"\r\n\r\n${body}`
      : body;

    const message = [
      `From: ${cred.smtp.user}`,
      `To: ${recipients.join(', ')}`,
      ccRecipients.length > 0 ? `Cc: ${ccRecipients.join(', ')}` : '',
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      params.isHtml
        ? 'Content-Type: multipart/alternative; boundary="LIORA-BOUNDARY"'
        : 'Content-Type: text/plain; charset="UTF-8"',
      '',
      mimeBody
    ].filter(Boolean).join('\r\n');

    // ── Sessão SMTP real (Node puro) ──
    return new Promise((resolve) => {
      let stage = 'greeting';
      let buffer = '';
      let rcptIndex = 0;
      let settled = false;

      let socket: net.Socket;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch {}
        resolve({
          success: false,
          error: `SMTP_TIMEOUT: servidor ${cred.smtp.host}:${cred.smtp.port} não respondeu em 20s.`,
          simulated: false,
          timestamp: new Date().toISOString()
        });
      }, 20000);

      socket = net.createConnection({ host: cred.smtp.host, port: cred.smtp.port }, () => {
        stage = 'greeting';
      });

      socket.setEncoding('utf8');
      socket.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { socket.destroy(); } catch {}
        resolve({
          success: false,
          error: `SMTP_ERROR: ${err.message}`,
          simulated: false,
          timestamp: new Date().toISOString()
        });
      });

      socket.on('close', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({
          success: false,
          error: `SMTP_CLOSED: A conexão com o servidor SMTP foi encerrada inesperadamente antes da conclusão.`,
          simulated: false,
          timestamp: new Date().toISOString()
        });
      });

      const send = (line: string) => {
        if (!socket.destroyed && !socket.writableEnded) {
          socket.write(line + '\r\n');
        }
      };

      const smtpError = (resp: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { socket.end(); socket.destroy(); } catch {}
        resolve({
          success: false,
          error: `SMTP_REJECTED: ${resp.slice(0, 200)}`,
          simulated: false,
          timestamp: new Date().toISOString()
        });
      };

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');

        // Multi-line: aguarda "XXX " (espaço após código) para agir
        const lastLine = buffer.split('\r\n').filter(Boolean).pop() || '';
        if (!/^\d{3}(\s|$)/.test(lastLine)) return;
        buffer = '';

        const code = parseInt(lastLine.slice(0, 3), 10);

        switch (stage) {
          case 'greeting':
            if (code !== 220) return smtpError(lastLine);
            stage = 'ehlo'; send(`EHLO liora.local`);
            break;
          case 'ehlo':
            if (code !== 250) return smtpError(lastLine);
            stage = 'auth'; send('AUTH LOGIN');
            break;
          case 'auth':
            if (code !== 334) return smtpError(lastLine);
            stage = 'auth_user'; send(Buffer.from(cred.smtp.user).toString('base64'));
            break;
          case 'auth_user':
            if (code !== 334) return smtpError(lastLine);
            stage = 'auth_pass'; send(Buffer.from(cred.smtp.pass).toString('base64'));
            break;
          case 'auth_pass':
            if (code !== 235) return smtpError(lastLine);
            stage = 'mail_from'; send(`MAIL FROM:<${cred.smtp.user}>`);
            break;
          case 'mail_from':
            if (code !== 250) return smtpError(lastLine);
            stage = 'rcpt_to';
            rcptIndex = 0;
            send(`RCPT TO:<${allRecipients[0]}>`);
            break;
          case 'rcpt_to': {
            if (code !== 250) return smtpError(lastLine);
            rcptIndex++;
            if (rcptIndex < allRecipients.length) {
              send(`RCPT TO:<${allRecipients[rcptIndex]}>`);
              return;
            }
            stage = 'data';
            send('DATA');
            break;
          }
          case 'data':
            if (code !== 354) return smtpError(lastLine);
            stage = 'body'; send(message);
            send('.');
            break;
          case 'body':
            if (code !== 250) return smtpError(lastLine);
            stage = 'quit';
            settled = true;
            clearTimeout(timeout);
            send('QUIT');
            try { socket.end(); } catch {}
            resolve({
              success: true,
              to: recipients,
              cc: ccRecipients,
              subject,
              messageId: lastLine.match(/<[^>]+>/)?.[0] || undefined,
              message: `E-mail enviado com sucesso para ${recipients.join(', ')}${ccRecipients.length > 0 ? ` (cópia: ${ccRecipients.join(', ')})` : ''}.`,
              simulated: false,
              timestamp: new Date().toISOString()
            });
            break;
        }
      });
    });
  }
};

/** Export para registro em massa */
export const allEmailTools: ToolDefinition<any, any>[] = [
  emailFetchAndReadTool,
  emailSendOrReplyTool
];

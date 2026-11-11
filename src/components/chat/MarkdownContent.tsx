/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { marked, Tokens } from 'marked';
import DOMPurify from 'dompurify';
import { Check, Copy, Code2 } from 'lucide-react';

/**
 * Sanitização XSS: toda saída HTML do marked passa pelo DOMPurify antes de
 * entrar no DOM via dangerouslySetInnerHTML. Sem isso, markdown malicioso
 * (de resposta do modelo ou de conteúdo colado pelo usuário) poderia injetar
 * scripts/event handlers na webview do Tauri.
 */
const sanitizeHtml = (html: string): string => {
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['a', 'b', 'i', 'em', 'strong', 'code', 'br', 'span', 'sup', 'sub', 'del', 's', 'u', 'ol', 'ul', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['href', 'title', 'target', 'rel'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#|\/)/i // bloqueia javascript:, vbscript:, data: (exceto âncoras/relativos)
  });
  // BUG FIX (XSS/tabnabbing): DOMPurify não força rel nos <a> — link de resposta do
  // modelo podia abrir na MESMA janela (navegando para fora da LIORA) ou sem
  // noopener (a página aberta podia manipular window.opener). Reforço pós-sanitização.
  const doc = new DOMParser().parseFromString(`<div>${clean}</div>`, 'text/html');
  doc.querySelectorAll('a[href]').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer nofollow');
  });
  return doc.body.firstElementChild?.innerHTML || '';
};

interface CodeBlockProps {
  language?: string;
  code: string;
}

export const CodeBlock: React.FC<CodeBlockProps> = ({ language, code }) => {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const handleCopy = async () => {
    let success = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(code);
        success = true;
      }
    } catch {
      // Fallback below
    }

    if (!success) {
      try {
        const textArea = document.createElement('textarea');
        textArea.value = code;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        success = document.execCommand('copy');
        textArea.remove();
      } catch (err) {
        console.error('Falha ao copiar:', err);
      }
    }

    if (success) {
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    }
  };

  const displayLang = language?.trim() || 'código';

  return (
    <div className="my-3 rounded-xl overflow-hidden border border-[#262626] bg-[#0A0A0A] shadow-lg">
      <div className="flex items-center justify-between px-3.5 py-1.5 bg-[#141414] border-b border-[#222222] text-xs">
        <div className="flex items-center gap-1.5 text-[#A0A0A0] font-mono text-[11px]">
          <Code2 className="w-3.5 h-3.5 text-[var(--accent-primary)]" />
          <span className="uppercase tracking-wider font-semibold">{displayLang}</span>
        </div>
        <button
          onClick={handleCopy}
          type="button"
          aria-label={copied ? "Código copiado para a área de transferência" : "Copiar código"}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
            copied
              ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-600/50'
              : 'text-[#888888] hover:text-white bg-[#1A1A1A] hover:bg-[#242424] border border-[#2E2E2E]'
          }`}
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-emerald-400" />
              <span>Copiado!</span>
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              <span>Copiar</span>
            </>
          )}
        </button>
      </div>
      <div className="p-3.5 overflow-x-auto text-[13px] font-mono text-[#E6E6E6] leading-relaxed selection:bg-[var(--accent-bg)] selection:text-white">
        <pre className="m-0 font-mono">
          <code>{code}</code>
        </pre>
      </div>
    </div>
  );
};

interface MarkdownContentProps {
  content: string;
}

export const MarkdownContent: React.FC<MarkdownContentProps> = ({ content }) => {
  if (!content) return null;

  // Use marked.lexer to produce structured tokens
  let tokens: any[] = [];
  try {
    tokens = marked.lexer(content);
  } catch {
    return <p className="whitespace-pre-wrap">{content}</p>;
  }

  const renderHeading = (depth: number, text: string, key: number) => {
    const html = sanitizeHtml(marked.parseInline(text) as string);
    const baseClass = "font-bold text-white mt-3 mb-1.5 border-b border-[#222222] pb-1";
    if (depth <= 2) {
      return <h3 key={key} className={`text-sm ${baseClass}`} dangerouslySetInnerHTML={{ __html: html }} />;
    } else {
      return <h4 key={key} className={`text-xs ${baseClass}`} dangerouslySetInnerHTML={{ __html: html }} />;
    }
  };

  return (
    <div className="markdown-body space-y-2 text-sm leading-relaxed text-[#E5E5E5]">
      {tokens.map((token, idx) => {
        switch (token.type) {
          case 'code': {
            const codeToken = token as Tokens.Code;
            return (
              <CodeBlock
                key={idx}
                language={codeToken.lang}
                code={codeToken.text}
              />
            );
          }

          case 'heading': {
            const hToken = token as Tokens.Heading;
            return renderHeading(hToken.depth, hToken.text, idx);
          }

          case 'paragraph': {
            const pToken = token as Tokens.Paragraph;
            return (
              <p
                key={idx}
                className="leading-relaxed whitespace-pre-wrap"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(marked.parseInline(pToken.text) as string) }}
              />
            );
          }

          case 'list': {
            const listToken = token as Tokens.List;
            const ListTag = listToken.ordered ? 'ol' : 'ul';
            return (
              <ListTag
                key={idx}
                className={`my-2 space-y-1 pl-5 ${
                  listToken.ordered ? 'list-decimal' : 'list-disc marker:text-[var(--accent-primary)]'
                }`}
              >
                {listToken.items.map((item, itemIdx) => (
                  <li
                    key={itemIdx}
                    className="leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(marked.parseInline(item.text) as string) }}
                  />
                ))}
              </ListTag>
            );
          }

          case 'blockquote': {
            const bToken = token as Tokens.Blockquote;
            return (
              <blockquote
                key={idx}
                className="border-l-2 border-[var(--accent-primary)] pl-3 py-1 my-2 bg-[#121212] text-[#B0B0B0] italic rounded-r-lg"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(marked.parseInline(bToken.text) as string) }}
              />
            );
          }

          case 'table': {
            const tToken = token as Tokens.Table;
            return (
              <div key={idx} className="my-3 overflow-x-auto rounded-lg border border-[#222222]">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-[#181818] text-[#FFFFFF] border-b border-[#222222]">
                    <tr>
                      {tToken.header.map((col, colIdx) => (
                        <th
                          key={colIdx}
                          className="px-3 py-2 font-semibold"
                          dangerouslySetInnerHTML={{ __html: sanitizeHtml(marked.parseInline(col.text) as string) }}
                        />
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1F1F1F]">
                    {tToken.rows.map((row, rowIdx) => (
                      <tr key={rowIdx} className="hover:bg-[#121212] transition-colors">
                        {row.map((cell, cellIdx) => (
                          <td
                            key={cellIdx}
                            className="px-3 py-2 text-[#CCCCCC]"
                            dangerouslySetInnerHTML={{ __html: sanitizeHtml(marked.parseInline(cell.text) as string) }}
                          />
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }

          case 'space':
            return null;

          default:
            return (
              <div
                key={idx}
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(marked.parse(token.raw) as string) }}
              />
            );
        }
      })}
    </div>
  );
};

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — Sincronizador Bidirecional de Memória em Markdown
 *
 * Sincroniza memórias estruturadas com arquivos canônicos legíveis por humanos (.md):
 * - preferences.md
 * - projects.md
 * - facts.md
 * - routines.md
 * - identity.md
 */

import { MemoryEntry } from '../../types';

export class MarkdownMemorySync {
  private baseDir: string | null = null;

  /**
   * Obtém o diretório de arquivos markdown de memória (~/.liora/memory)
   */
  public async getMemoryDirectory(): Promise<string | null> {
    if (this.baseDir) return this.baseDir;

    if (typeof window === 'undefined') {
      try {
        const path = await import('path');
        const os = await import('os');
        const fs = await import('fs');
        const dir = path.join(os.homedir(), '.liora', 'memory');
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        this.baseDir = dir;
        return dir;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Converte uma lista de memórias em conteúdo Markdown formatado
   */
  public serializeToMarkdown(categoryTitle: string, entries: MemoryEntry[]): string {
    const lines = [
      `# ${categoryTitle}`,
      '',
      `> Sincronizado automaticamente pela LIORA em ${new Date().toLocaleString('pt-BR')}`,
      ''
    ];

    if (entries.length === 0) {
      lines.push('*Nenhum registro armazenado nesta categoria.*');
      return lines.join('\n');
    }

    for (const entry of entries) {
      lines.push(`- **${entry.key}**: ${entry.value}`);
    }

    lines.push('');
    return lines.join('\n');
  }

  /**
   * Converte conteúdo Markdown em entradas de memória estruturadas
   */
  public parseMarkdown(content: string, category: MemoryEntry['category']): MemoryEntry[] {
    const entries: MemoryEntry[] = [];
    const lines = content.split('\n');

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('-')) continue;

      // Padrão 1: - **chave**: valor
      const boldMatch = line.match(/^-\s*\*\*([^*]+)\*\*:\s*(.+)$/);
      if (boldMatch) {
        entries.push({
          id: `md-${category}-${boldMatch[1].trim().toLowerCase().replace(/\s+/g, '_')}`,
          category,
          key: boldMatch[1].trim(),
          value: boldMatch[2].trim(),
          confidence: 1.0,
          updatedAt: new Date().toISOString()
        });
        continue;
      }

      // Padrão 2: - chave: valor
      const simpleMatch = line.match(/^-\s*([^:]+):\s*(.+)$/);
      if (simpleMatch) {
        entries.push({
          id: `md-${category}-${simpleMatch[1].trim().toLowerCase().replace(/\s+/g, '_')}`,
          category,
          key: simpleMatch[1].trim(),
          value: simpleMatch[2].trim(),
          confidence: 1.0,
          updatedAt: new Date().toISOString()
        });
      }
    }

    return entries;
  }

  /**
   * Exporta e sincroniza a coleção de memórias para arquivos .md no disco
   */
  public async syncToDisk(memories: MemoryEntry[]): Promise<boolean> {
    const dir = await this.getMemoryDirectory();
    if (!dir) return false;

    try {
      const fs = await import('fs');
      const path = await import('path');

      const categories: Array<{ file: string; title: string; category: MemoryEntry['category'] }> = [
        { file: 'preferences.md', title: 'Preferências do Usuário', category: 'preference' },
        { file: 'projects.md', title: 'Projetos & Tecnologias', category: 'project' },
        { file: 'facts.md', title: 'Fatos & Aprendizados', category: 'fact' },
        { file: 'routines.md', title: 'Rotinas & Horários', category: 'routine' },
        { file: 'identity.md', title: 'Identidade & Comportamento', category: 'journal' }
      ];

      for (const cat of categories) {
        const catEntries = memories.filter((m) => m.category === cat.category);
        const md = this.serializeToMarkdown(cat.title, catEntries);
        fs.writeFileSync(path.join(dir, cat.file), md, 'utf-8');
      }

      return true;
    } catch (err) {
      console.warn('[MarkdownMemorySync] Erro ao sincronizar para o disco:', err);
      return false;
    }
  }

  /**
   * Lê arquivos .md do disco e extrai as memórias canônicas
   */
  public async syncFromDisk(): Promise<MemoryEntry[]> {
    const dir = await this.getMemoryDirectory();
    if (!dir) return [];

    try {
      const fs = await import('fs');
      const path = await import('path');

      const files: Array<{ file: string; category: MemoryEntry['category'] }> = [
        { file: 'preferences.md', category: 'preference' },
        { file: 'projects.md', category: 'project' },
        { file: 'facts.md', category: 'fact' },
        { file: 'routines.md', category: 'routine' },
        { file: 'identity.md', category: 'journal' }
      ];

      const allEntries: MemoryEntry[] = [];

      for (const item of files) {
        const fullPath = path.join(dir, item.file);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const parsed = this.parseMarkdown(content, item.category);
          allEntries.push(...parsed);
        }
      }

      return allEntries;
    } catch (err) {
      console.warn('[MarkdownMemorySync] Erro ao carregar do disco:', err);
      return [];
    }
  }
}

export const markdownMemorySync = new MarkdownMemorySync();


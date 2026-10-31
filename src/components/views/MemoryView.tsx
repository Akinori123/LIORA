/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useMemo } from 'react';
import { useLioraStore } from '../../store/lioraStore';
import { MemoryEntry } from '../../types';
import { sanitizeMemoryValue } from '../../utils/memoryRanker';
import { 
  semanticMemoryEngine, 
  SearchMode, 
  SemanticSearchResult 
} from '../../services/semanticMemoryEngine';
import { 
  Database, 
  Plus, 
  Trash2, 
  Search, 
  Sparkles, 
  Pencil, 
  Download, 
  Upload, 
  AlertTriangle, 
  X, 
  Check, 
  Filter,
  Binary,
  Cpu,
  Layers,
  Sliders,
  Compass,
  Info
} from 'lucide-react';

export const MemoryView: React.FC = () => {
  const { memoryEntries, addMemory, updateMemory, deleteMemory, importMemories, sessions } = useLioraStore();

  // Search & Filters state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('hybrid');
  const [similarityThreshold, setSimilarityThreshold] = useState<number>(0.20);
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<string>('all');
  const [selectedClusterFilter, setSelectedClusterFilter] = useState<string>('all');
  const [showAdvancedSearch, setShowAdvancedSearch] = useState<boolean>(false);

  // Form state
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newCategory, setNewCategory] = useState<'preference' | 'project' | 'fact' | 'routine'>('preference');

  // Modals state
  const [editingMemory, setEditingMemory] = useState<MemoryEntry | null>(null);
  const [deletingMemory, setDeletingMemory] = useState<MemoryEntry | null>(null);
  const [inspectingVector, setInspectingVector] = useState<{
    entry: MemoryEntry;
    vector: number[];
    cluster: string;
    similarityWithQuery?: number;
  } | null>(null);

  // Auto-extraction suggestions state
  const [isAutoExtractOpen, setIsAutoExtractOpen] = useState(false);
  const [suggestedFacts, setSuggestedFacts] = useState<Array<{ category: 'preference' | 'project' | 'fact' | 'routine'; key: string; value: string }>>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Clusters ativos calculados pelo motor semântico
  const activeClusters = useMemo(() => {
    return semanticMemoryEngine.getClusters(memoryEntries);
  }, [memoryEntries]);

  // Executa busca semântica vetorial ou filtro padrão
  const searchResults = useMemo(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed) return null;

    return semanticMemoryEngine.search(trimmed, memoryEntries, {
      mode: searchMode,
      threshold: similarityThreshold,
      maxResults: 30
    });
  }, [searchQuery, memoryEntries, searchMode, similarityThreshold]);

  // Aplica filtros de categoria e cluster
  const displayedItems = useMemo(() => {
    if (searchResults !== null) {
      return searchResults.filter(res => {
        const matchesCategory = selectedCategoryFilter === 'all' || res.entry.category === selectedCategoryFilter;
        const matchesCluster = selectedClusterFilter === 'all' || res.cluster === selectedClusterFilter;
        return matchesCategory && matchesCluster;
      });
    }

    return memoryEntries
      .filter(m => {
        const matchesCategory = selectedCategoryFilter === 'all' || m.category === selectedCategoryFilter;
        const entryCluster = semanticMemoryEngine.detectCluster(m);
        const matchesCluster = selectedClusterFilter === 'all' || entryCluster === selectedClusterFilter;
        return matchesCategory && matchesCluster;
      })
      .map(entry => ({
        entry,
        score: 1.0,
        semanticScore: 0,
        lexicalScore: 0,
        matchReason: 'Item cadastrado no cofre',
        matchedTokens: [],
        cluster: semanticMemoryEngine.detectCluster(entry)
      } as SemanticSearchResult));
  }, [searchResults, memoryEntries, selectedCategoryFilter, selectedClusterFilter]);

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKey.trim() || !newValue.trim()) return;

    // Sanitization check
    const sanitized = sanitizeMemoryValue(newKey.trim(), newValue.trim());

    addMemory({
      category: newCategory,
      key: sanitized.sanitizedKey,
      value: sanitized.sanitizedValue,
      confidence: 1.0
    });

    setNewKey('');
    setNewValue('');
  };

  const handleUpdate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingMemory || !editingMemory.key.trim() || !editingMemory.value.trim()) return;

    const sanitized = sanitizeMemoryValue(editingMemory.key.trim(), editingMemory.value.trim());

    updateMemory(editingMemory.id, {
      category: editingMemory.category,
      key: sanitized.sanitizedKey,
      value: sanitized.sanitizedValue
    });

    setEditingMemory(null);
  };

  // Export JSON
  const handleExportVault = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(memoryEntries, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `liora_memory_vault_${Date.now()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  // Import JSON
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target?.result as string);
        if (Array.isArray(parsed)) {
          importMemories(parsed, 'merge');
        } else {
          alert('O arquivo JSON importado deve conter uma lista válida de memórias.');
        }
      } catch {
        alert('Falha ao ler o arquivo JSON. Verifique a formatação do arquivo.');
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Smart Auto-Extraction from Conversation Sessions
  const handleExtractSuggestions = () => {
    const suggestions: Array<{ category: 'preference' | 'project' | 'fact' | 'routine'; key: string; value: string }> = [];
    const existingKeys = new Set(memoryEntries.map(m => m.key.toLowerCase().trim()));

    sessions.forEach(sess => {
      sess.messages.forEach(msg => {
        if (msg.sender === 'user') {
          const text = msg.text.trim();
          
          if (/meu nome [eé]\s+(.+)/i.test(text)) {
            const match = text.match(/meu nome [eé]\s+([a-zA-ZÀ-ÿ\s]+)/i);
            if (match && match[1]) {
              const val = match[1].trim();
              if (!existingKeys.has('nome_usuario')) {
                suggestions.push({ category: 'fact', key: 'nome_usuario', value: val });
              }
            }
          }

          if (/prefiro\s+(.+)/i.test(text)) {
            const match = text.match(/prefiro\s+(.+)/i);
            if (match && match[1]) {
              const val = match[1].slice(0, 40).trim();
              if (!existingKeys.has('preferencia_detectada')) {
                suggestions.push({ category: 'preference', key: 'preferencia_detectada', value: val });
              }
            }
          }

          if (/trabalhando em\s+(.+)/i.test(text) || /projeto\s+(.+)/i.test(text)) {
            const match = text.match(/(trabalhando em|projeto)\s+(.+)/i);
            if (match && match[2]) {
              const val = match[2].slice(0, 40).trim();
              if (!existingKeys.has('projeto_ativo')) {
                suggestions.push({ category: 'project', key: 'projeto_ativo', value: val });
              }
            }
          }
        }
      });
    });

    if (suggestions.length === 0) {
      suggestions.push({ category: 'preference', key: 'modo_respostas', value: 'Respostas diretas e focadas em código' });
      suggestions.push({ category: 'project', key: 'ambiente_desenvolvimento', value: 'React + TypeScript + Express' });
    }

    setSuggestedFacts(suggestions);
    setIsAutoExtractOpen(true);
  };

  const handleApproveSuggestion = (sug: { category: 'preference' | 'project' | 'fact' | 'routine'; key: string; value: string }) => {
    addMemory({ ...sug, confidence: 1.0 });
    setSuggestedFacts(prev => prev.filter(item => item.key !== sug.key));
  };

  const handleOpenVectorInspector = (entry: MemoryEntry, cluster: string, similarity?: number) => {
    const vector = semanticMemoryEngine.generateEmbedding(`${entry.category} ${entry.key} ${entry.value}`);
    setInspectingVector({
      entry,
      vector,
      cluster,
      similarityWithQuery: similarity
    });
  };

  const demoQueries = [
    { label: 'Onde programo software?', query: 'Onde eu costumo programar e criar software?' },
    { label: 'Cores e visual', query: 'Qual o tema visual e esquema de cores do sistema?' },
    { label: 'Horário de silêncio', query: 'Qual o período de silêncio e foco noturno?' },
    { label: 'Idioma de fala', query: 'Qual o idioma principal e formato de resposta?' }
  ];

  return (
    <div className="flex-1 flex flex-col overflow-y-auto p-4 sm:p-6 md:p-8 space-y-6 max-w-6xl mx-auto w-full">
      {/* Hidden file input for import */}
      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={handleFileChange} 
        accept=".json" 
        className="hidden" 
      />

      {/* Header Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-display font-bold text-white">Memória & Contexto Duradouro</h2>
            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-red-950/70 text-[#FF2B2B] border border-red-800/60">
              VETORIAL DENSE 32-D
            </span>
          </div>
          <p className="text-xs sm:text-sm text-[#A8A8A8] mt-1">
            Cofre de conhecimento com busca semântica por embeddings e rerank em tempo real.
          </p>
        </div>

        {/* Action Buttons: Auto-Extract, Export, Import */}
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            onClick={handleExtractSuggestions}
            className="flex items-center gap-2 px-3.5 py-2 bg-[var(--accent-bg)] hover:opacity-90 border border-[var(--accent-border)] text-[var(--accent-primary)] text-xs font-semibold rounded-xl transition-all shadow-lg shadow-[var(--accent-glow)]"
            title="Analisar conversas ativas e sugerir memórias relevantes"
          >
            <Sparkles className="w-4 h-4" />
            <span>Sugerir das Conversas</span>
          </button>

          <button
            onClick={handleExportVault}
            className="flex items-center gap-1.5 px-3 py-2 bg-[#161616] hover:bg-[#222222] border border-[#2B2B2B] rounded-xl text-xs text-[#CCCCCC] hover:text-white transition-colors"
            title="Exportar cofre de memórias em formato JSON"
          >
            <Download className="w-3.5 h-3.5 text-emerald-400" />
            <span className="hidden sm:inline">Exportar .json</span>
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 px-3 py-2 bg-[#161616] hover:bg-[#222222] border border-[#2B2B2B] rounded-xl text-xs text-[#CCCCCC] hover:text-white transition-colors"
            title="Importar cofre de memórias a partir de um arquivo JSON"
          >
            <Upload className="w-3.5 h-3.5 text-[var(--accent-primary)]" />
            <span className="hidden sm:inline">Importar .json</span>
          </button>
        </div>
      </div>

      {/* Semantic Search & Vector Controls Bar */}
      <div className="bg-[#111111] border border-[#222222] rounded-2xl p-5 shadow-xl space-y-4">
        <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
          {/* Search Input */}
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-3 w-4 h-4 text-[#777777]" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Pesquisar memórias por conceito, intenção ou palavra-chave..."
              className="w-full bg-[#161616] border border-[#2B2B2B] rounded-xl pl-10 pr-10 py-2.5 text-xs text-white placeholder-[#777777] focus:outline-none focus:border-[var(--accent-primary)] transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-3 text-[#777777] hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Mode Selector */}
          <div className="flex items-center gap-1 bg-[#161616] border border-[#2B2B2B] p-1 rounded-xl shrink-0">
            {[
              { id: 'hybrid', label: 'Híbrido', desc: 'Vetorial + Léxico' },
              { id: 'semantic', label: 'Semântico', desc: 'Embeddings 32D' },
              { id: 'lexical', label: 'Léxico', desc: 'Palavras Exatas' },
            ].map(m => (
              <button
                key={m.id}
                onClick={() => setSearchMode(m.id as SearchMode)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  searchMode === m.id
                    ? 'bg-[var(--accent-primary)] text-white shadow-md shadow-[var(--accent-glow)]'
                    : 'text-[#888888] hover:text-white'
                }`}
                title={m.desc}
              >
                {m.label}
              </button>
            ))}

            <button
              onClick={() => setShowAdvancedSearch(!showAdvancedSearch)}
              className={`p-1.5 rounded-lg transition-colors text-xs ${
                showAdvancedSearch ? 'text-[var(--accent-primary)] bg-[#222222]' : 'text-[#777777] hover:text-white'
              }`}
              title="Ajustar limiares de relevância"
            >
              <Sliders className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Advanced Slider Bar */}
        {showAdvancedSearch && (
          <div className="bg-[#171717] border border-[#282828] rounded-xl p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 text-[#A8A8A8]">
              <Binary className="w-4 h-4 text-[var(--accent-primary)]" />
              <span>Limiar Mínimo de Similaridade Cosseno:</span>
              <span className="font-mono text-white font-bold">{Math.round(similarityThreshold * 100)}%</span>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min="0.10"
                max="0.80"
                step="0.05"
                value={similarityThreshold}
                onChange={(e) => setSimilarityThreshold(parseFloat(e.target.value))}
                className="w-48 accent-[var(--accent-primary)] cursor-pointer"
              />
              <span className="text-[10px] font-mono text-[#777777]">{similarityThreshold >= 0.5 ? 'Alta Precisão' : 'Ampla Abrangência'}</span>
            </div>
          </div>
        )}

        {/* Quick Demo Test Queries */}
        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-[#1C1C1C]">
          <span className="text-[11px] font-mono text-[#666666] flex items-center gap-1">
            <Compass className="w-3 h-3 text-[var(--accent-primary)]" />
            <span>EXEMPLOS SEMÂNTICOS:</span>
          </span>
          {demoQueries.map((demo) => (
            <button
              key={demo.label}
              onClick={() => setSearchQuery(demo.query)}
              className="text-[11px] px-2.5 py-1 bg-[#161616] hover:bg-[#222222] border border-[#2B2B2B] text-[#CCCCCC] hover:text-white rounded-lg transition-colors"
            >
              "{demo.label}"
            </button>
          ))}
        </div>
      </div>

      {/* Semantic Clusters Strip */}
      <div className="bg-[#111111] border border-[#222222] rounded-2xl p-4 shadow-xl space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-white font-mono">
            <Layers className="w-4 h-4 text-[var(--accent-primary)]" />
            <span>CLUSTERS CONCEITUAIS ATIVOS ({activeClusters.length})</span>
          </div>
          <span className="text-[10px] text-[#777777] font-mono">Agrupamento semântico autônomo</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setSelectedClusterFilter('all')}
            className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-all ${
              selectedClusterFilter === 'all'
                ? 'bg-white text-black font-bold shadow'
                : 'bg-[#171717] text-[#888888] hover:text-white border border-[#282828]'
            }`}
          >
            Todos os Clusters
          </button>
          {activeClusters.map(cl => (
            <button
              key={cl.id}
              onClick={() => setSelectedClusterFilter(selectedClusterFilter === cl.name ? 'all' : cl.name)}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 ${
                selectedClusterFilter === cl.name
                  ? 'bg-[var(--accent-primary)] text-white shadow-md shadow-[var(--accent-glow)]'
                  : 'bg-[#171717] text-[#AAAAAA] hover:text-white border border-[#282828]'
              }`}
            >
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: cl.color }} />
              <span>{cl.name}</span>
              <span className="text-[10px] font-mono opacity-70">({cl.entriesCount})</span>
            </button>
          ))}
        </div>
      </div>

      {/* Add Memory Form */}
      <div className="bg-[#111111] border border-[#222222] rounded-2xl p-5 sm:p-6 shadow-xl">
        <h3 className="text-sm font-semibold text-white mb-3.5 flex items-center gap-2">
          <Database className="w-4 h-4 text-[var(--accent-primary)]" />
          <span>Cadastrar Nova Memória (Indexação Vetorial Imediata)</span>
        </h3>
        <form onSubmit={handleAdd} className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
          <select
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value as any)}
            className="bg-[#171717] border border-[#333333] rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-[var(--accent-primary)] transition-colors"
          >
            <option value="preference">Preferência (1.4x)</option>
            <option value="project">Projeto (1.2x)</option>
            <option value="fact">Fato / Dado (1.0x)</option>
            <option value="routine">Rotina (1.1x)</option>
          </select>
          <input
            type="text"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="Chave (ex: editor_preferido)"
            className="bg-[#171717] border border-[#333333] rounded-xl px-3 py-2 text-xs text-white placeholder-[#777777] focus:outline-none focus:border-[var(--accent-primary)] transition-colors"
          />
          <input
            type="text"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            placeholder="Valor (ex: Visual Studio Code)"
            className="bg-[#171717] border border-[#333333] rounded-xl px-3 py-2 text-xs text-white placeholder-[#777777] focus:outline-none focus:border-[var(--accent-primary)] transition-colors"
          />
          <button
            type="submit"
            className="px-4 py-2 bg-[var(--accent-primary)] hover:opacity-90 text-white text-xs font-semibold rounded-xl flex items-center justify-center gap-2 transition-all shadow-md shadow-[var(--accent-glow)]"
          >
            <Plus className="w-4 h-4" />
            <span>Salvar Memória</span>
          </button>
        </form>
      </div>

      {/* Category Filter Pills & Results Count */}
      <div className="bg-[#111111] border border-[#222222] rounded-2xl p-4 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 shadow-xl">
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex items-center gap-1 text-xs text-[#777777] font-mono mr-1">
            <Filter className="w-3.5 h-3.5 text-[var(--accent-primary)]" />
            <span className="hidden sm:inline">CATEGORIA:</span>
          </div>

          {[
            { id: 'all', label: 'Todas' },
            { id: 'preference', label: 'Preferências' },
            { id: 'project', label: 'Projetos' },
            { id: 'fact', label: 'Fatos' },
            { id: 'routine', label: 'Rotinas' },
          ].map((pill) => (
            <button
              key={pill.id}
              onClick={() => setSelectedCategoryFilter(pill.id)}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-all ${
                selectedCategoryFilter === pill.id
                  ? 'bg-[var(--accent-primary)] text-white shadow-md shadow-[var(--accent-glow)]'
                  : 'bg-[#171717] hover:bg-[#222222] text-[#888888] hover:text-white border border-[#2E2E2E]'
              }`}
            >
              {pill.label}
            </button>
          ))}
        </div>

        <div className="text-xs font-mono text-[#888888] flex items-center gap-2">
          <span>{displayedItems.length} {displayedItems.length === 1 ? 'memória' : 'memórias'} {searchQuery ? 'recuperadas' : 'cadastradas'}</span>
          {searchQuery && (
            <span className="px-2 py-0.5 rounded bg-[#1A1A1A] text-[#CCCCCC] text-[10px]">
              Modo: {searchMode.toUpperCase()}
            </span>
          )}
        </div>
      </div>

      {/* Memories Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {displayedItems.map((item) => {
          const mem = item.entry;
          const isSearchActive = Boolean(searchQuery.trim());
          const simPct = Math.round((item.semanticScore || item.score) * 100);

          return (
            <div 
              key={mem.id} 
              className="bg-[#111111] border border-[#222222] hover:border-[#333333] rounded-2xl p-5 flex flex-col justify-between gap-4 transition-all shadow-lg relative group"
            >
              <div className="min-w-0 flex-1">
                {/* Header Tags */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono px-2 py-0.5 bg-[#171717] border border-[#333333] rounded uppercase font-bold text-[var(--accent-primary)]">
                      {mem.category}
                    </span>
                    <span className="text-[10px] font-mono px-2 py-0.5 bg-[#161616] border border-[#2B2B2B] rounded text-[#A8A8A8]">
                      {item.cluster}
                    </span>
                  </div>

                  <span className="text-[11px] font-mono text-[#777777]">{mem.updatedAt}</span>
                </div>

                {/* Similarity score bar if search is active */}
                {isSearchActive && (
                  <div className="mt-3 p-2 rounded-xl bg-[#171717] border border-[#282828] space-y-1.5">
                    <div className="flex items-center justify-between text-[11px] font-mono">
                      <span className="text-[#AAAAAA]">{item.matchReason}</span>
                      <span className="font-bold text-[var(--accent-primary)]">{simPct}% afinidade</span>
                    </div>
                    <div className="w-full bg-[#202020] h-1.5 rounded-full overflow-hidden">
                      <div 
                        className="bg-gradient-to-r from-red-600 to-[#FF2B2B] h-full rounded-full transition-all duration-300"
                        style={{ width: `${Math.max(10, Math.min(100, simPct))}%` }}
                      />
                    </div>
                  </div>
                )}

                <h4 className="mt-3 font-semibold text-white text-sm font-mono truncate">{mem.key}</h4>
                <p className="mt-1 text-xs text-[#CCCCCC] leading-relaxed font-sans break-words">{mem.value}</p>
              </div>

              {/* Bottom Actions: Inspect Vector, Edit, Delete */}
              <div className="flex items-center justify-between pt-2 border-t border-[#1C1C1C]">
                <button
                  onClick={() => handleOpenVectorInspector(mem, item.cluster, isSearchActive ? simPct : undefined)}
                  className="flex items-center gap-1.5 text-[11px] font-mono text-[#888888] hover:text-white px-2 py-1 rounded-lg bg-[#161616] hover:bg-[#202020] border border-[#282828] transition-colors"
                  title="Ver vetor denso de 32 dimensões"
                >
                  <Cpu className="w-3 h-3 text-[var(--accent-primary)]" />
                  <span>Vetor 32D</span>
                </button>

                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setEditingMemory(mem)}
                    className="p-1.5 text-[#888888] hover:text-white bg-[#171717] hover:bg-[#222222] border border-[#2E2E2E] rounded-xl transition-colors"
                    title="Editar memória"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setDeletingMemory(mem)}
                    className="p-1.5 text-[#888888] hover:text-red-400 bg-[#171717] hover:bg-[#222222] border border-[#2E2E2E] rounded-xl transition-colors"
                    title="Apagar memória"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}

        {displayedItems.length === 0 && (
          <div className="col-span-full bg-[#111111] border border-[#222222] rounded-2xl p-8 text-center text-[#666666] space-y-2">
            <Database className="w-8 h-8 text-[#333333] mx-auto animate-pulse" />
            <p className="text-sm font-medium text-[#888888]">Nenhuma memória encontrada com esses critérios.</p>
            <p className="text-xs text-[#555555]">
              {searchQuery ? 'Tente diminuir o limiar de similaridade cosseno ou mudar para o modo Híbrido.' : 'Cadastre uma memória pelo formulário acima.'}
            </p>
          </div>
        )}
      </div>

      {/* Vector Inspector Modal */}
      {inspectingVector && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
          <div className="bg-[#111111] border border-[#262626] rounded-2xl w-full max-w-xl p-6 shadow-2xl relative space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-xl bg-red-950/70 border border-red-800/60 text-[#FF2B2B]">
                  <Cpu className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">Assinatura Vetorial Dense (32 Dimensões)</h3>
                  <p className="text-xs text-[#888888]">Vetor de embedding normalizado gerado localmente em tempo real</p>
                </div>
              </div>
              <button
                onClick={() => setInspectingVector(null)}
                className="p-1 rounded-lg text-[#888888] hover:text-white hover:bg-[#1C1C1C]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="bg-[#161616] p-3 rounded-xl border border-[#262626] space-y-1">
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="text-[var(--accent-primary)] font-bold">{inspectingVector.entry.key}</span>
                <span className="text-[#888888]">Cluster: {inspectingVector.cluster}</span>
              </div>
              <p className="text-xs text-[#CCCCCC] truncate font-sans">{inspectingVector.entry.value}</p>
              {typeof inspectingVector.similarityWithQuery === 'number' && (
                <div className="text-[11px] font-mono text-emerald-400 pt-1">
                  Afinidade Cosseno com busca atual: <strong>{inspectingVector.similarityWithQuery}%</strong>
                </div>
              )}
            </div>

            {/* Vector Dimensions Grid */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[11px] font-mono text-[#888888]">
                <span>Componentes dos Vetores (Float32 Normalizados):</span>
                <span>Dimensões 0 a 31</span>
              </div>
              <div className="grid grid-cols-4 sm:grid-cols-8 gap-1.5 max-h-56 overflow-y-auto p-1 bg-[#0A0A0A] rounded-xl border border-[#202020]">
                {inspectingVector.vector.map((val, idx) => {
                  const intensity = Math.min(100, Math.round(Math.abs(val) * 120));
                  return (
                    <div 
                      key={idx}
                      className="p-1.5 rounded-lg border border-[#222222] flex flex-col items-center justify-center text-center transition-all"
                      style={{
                        backgroundColor: val > 0 ? `rgba(255, 43, 43, ${intensity / 250})` : `rgba(50, 50, 50, 0.4)`
                      }}
                      title={`Dimensão ${idx}: ${val.toFixed(4)}`}
                    >
                      <span className="text-[9px] font-mono text-[#666666]">d{idx}</span>
                      <span className="text-[10px] font-mono font-bold text-white">{val.toFixed(2)}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Zero Leakage Explanation */}
            <div className="p-3 rounded-xl bg-[#141414] border border-[#252525] flex items-start gap-2.5 text-xs text-[#A8A8A8]">
              <Info className="w-4 h-4 text-[var(--accent-primary)] shrink-0 mt-0.5" />
              <p>
                Este embedding vetorial é computado de forma totalmente estática e determinística no desktop, permitindo que a LIORA encontre informações por conceito sem enviar dados a terceiros ou sofrer latência de rede.
              </p>
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setInspectingVector(null)}
                className="px-4 py-2 bg-[#161616] hover:bg-[#202020] text-xs font-semibold text-[#CCCCCC] hover:text-white rounded-xl border border-[#2B2B2B]"
              >
                Fechar Inspecionador
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Memory Modal */}
      {editingMemory && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
          <div className="bg-[#111111] border border-[#262626] rounded-2xl w-full max-w-md p-6 shadow-2xl relative space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Pencil className="w-4 h-4 text-[var(--accent-primary)]" />
                <span>Editar Memória</span>
              </h3>
              <button
                onClick={() => setEditingMemory(null)}
                className="p-1 rounded-lg text-[#888888] hover:text-white hover:bg-[#1C1C1C]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleUpdate} className="space-y-3">
              <div>
                <label className="text-[11px] font-mono text-[#888888] block mb-1">Categoria</label>
                <select
                  value={editingMemory.category}
                  onChange={(e) => setEditingMemory({ ...editingMemory, category: e.target.value as any })}
                  className="w-full bg-[#171717] border border-[#333333] rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-[var(--accent-primary)]"
                >
                  <option value="preference">Preferência (1.4x)</option>
                  <option value="project">Projeto (1.2x)</option>
                  <option value="fact">Fato / Dado (1.0x)</option>
                  <option value="routine">Rotina (1.1x)</option>
                </select>
              </div>

              <div>
                <label className="text-[11px] font-mono text-[#888888] block mb-1">Chave</label>
                <input
                  type="text"
                  value={editingMemory.key}
                  onChange={(e) => setEditingMemory({ ...editingMemory, key: e.target.value })}
                  className="w-full bg-[#171717] border border-[#333333] rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-[var(--accent-primary)]"
                />
              </div>

              <div>
                <label className="text-[11px] font-mono text-[#888888] block mb-1">Valor</label>
                <textarea
                  rows={3}
                  value={editingMemory.value}
                  onChange={(e) => setEditingMemory({ ...editingMemory, value: e.target.value })}
                  className="w-full bg-[#171717] border border-[#333333] rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-[var(--accent-primary)] resize-none"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingMemory(null)}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-[#888888] hover:text-white bg-[#161616] border border-[#2B2B2B]"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-white bg-[var(--accent-primary)] hover:opacity-90 shadow-md shadow-[var(--accent-glow)]"
                >
                  Salvar Alterações
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingMemory && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
          <div className="bg-[#111111] border border-[#262626] rounded-2xl w-full max-w-md p-6 shadow-2xl relative space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-red-950/80 text-red-400 border border-red-800/60">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Excluir Memória do Cofre?</h3>
                <p className="text-xs text-[#888888]">Esta ação removerá a memória e seu vetor de embedding.</p>
              </div>
            </div>

            <div className="bg-[#161616] p-3 rounded-xl border border-[#262626] font-mono text-xs">
              <span className="text-[var(--accent-primary)] font-bold">{deletingMemory.key}</span>
              <p className="text-[#CCCCCC] font-sans text-xs mt-1 truncate">{deletingMemory.value}</p>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setDeletingMemory(null)}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-[#888888] hover:text-white bg-[#161616] border border-[#2B2B2B]"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => {
                  deleteMemory(deletingMemory.id);
                  setDeletingMemory(null);
                }}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-white bg-red-600 hover:bg-red-500 shadow-md shadow-red-600/20"
              >
                Confirmar Exclusão
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Auto-Extract Suggestions Modal */}
      {isAutoExtractOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
          <div className="bg-[#111111] border border-[#262626] rounded-2xl w-full max-w-lg p-6 shadow-2xl relative space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-xl bg-[var(--accent-bg)] text-[var(--accent-primary)]">
                  <Sparkles className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">Sugestões de Memórias Extraídas</h3>
                  <p className="text-xs text-[#888888]">Detectadas a partir das conversas e interações ativas</p>
                </div>
              </div>
              <button
                onClick={() => setIsAutoExtractOpen(false)}
                className="p-1 rounded-lg text-[#888888] hover:text-white hover:bg-[#1C1C1C]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2.5 max-h-60 overflow-y-auto pr-1">
              {suggestedFacts.map((sug) => (
                <div key={sug.key} className="bg-[#161616] border border-[#262626] rounded-xl p-3 flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <span className="text-[10px] font-mono text-[var(--accent-primary)] uppercase font-bold">{sug.category}</span>
                    <h4 className="font-mono text-xs text-white font-semibold truncate">{sug.key}</h4>
                    <p className="text-xs text-[#A8A8A8] truncate">{sug.value}</p>
                  </div>
                  <button
                    onClick={() => handleApproveSuggestion(sug)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--accent-primary)] hover:opacity-90 text-white text-xs font-semibold rounded-lg shrink-0 shadow-md shadow-[var(--accent-glow)] transition-all"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>Aprovar</span>
                  </button>
                </div>
              ))}

              {suggestedFacts.length === 0 && (
                <p className="text-center text-xs text-[#888888] py-4">Todas as sugestões foram aprovadas ou incorporadas!</p>
              )}
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setIsAutoExtractOpen(false)}
                className="px-4 py-2 bg-[#161616] hover:bg-[#202020] text-xs font-semibold text-[#888888] hover:text-white rounded-xl border border-[#2B2B2B]"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

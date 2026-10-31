# PROJECT_STATE.md — LIORA State (Atualizado)

| Requisito | Estado | Evidência | Próximo Passo |
|---|---|---|---|
| Identidade Visual (Preto/Branco/Vermelho) | IMPLEMENTADO | Design system e CSS tokens ativos | Manter consistência nas novas telas |
| Navegação Multi-Abas & Top Bar | IMPLEMENTADO | Sidebar e Header responsivos | Refinar subabas |
| LIORA CORE 3D (Three.js) | IMPLEMENTADO & REFINADO | Orb com shader líquido, partículas e zoom real | Sincronizar reatividade de áudio |
| Controles de Zoom da Orb | IMPLEMENTADO | Botões de zoom (+, -, Reset) + roda do mouse | Integrar gestos de pinça touch |
| Responsividade e Viewports | IMPLEMENTADO & AUDITADO | Grids flexíveis, truncation e sem overflow horizontal | Testes em dispositivo físico |
| Chat de Texto com Gemini | IMPLEMENTADO | Servidor Express + SDK `@google/genai` | Expandir para tool calling |
| Ponte Local Tauri / Rust & LocalExecutionBridge (Passo 4) | IMPLEMENTADO | `checkBridgeDiagnostics()`, `/api/system/telemetry` com métricas reais de OS, fallback seguro e painel IPC | Empacotamento binário Tauri CLI |
| Voz em Tempo Real (Live API) (Passo 5) | IMPLEMENTADO | Canal WebSocket `/ws/voice`, streaming de chunks PCM 16kHz, VAD acústico e cancelamento imediato (Barge-In 0ms) | Calibração de ganho adaptativo |
| Tool Registry Seguro (Marco 6.1) | IMPLEMENTADO | Bloqueio de execução por padrão, fixtures virtuais, rejeição de IDs duplicados | Expandir para conectores MCP |
| Permission Engine (R0–R3) (Marco 6.2) | IMPLEMENTADO | Avaliação de risco analítica, hash SHA-256 canônico, tokens de consentimento anti-replay | Expandir perfis granulares |
| Verifier Engine (Item 17 do Plano Mestre) | IMPLEMENTADO | Motor de auditoria pós-execução, evidência de integridade de arquivos/saídas e selo VERIFICADO | Integrar testes de regressão |
| Inspetor de Código, Diffs & REA (Passo 2) | IMPLEMENTADO | Subabas de ferramentas, diffs com syntax coloring e auditoria estática de binários REA | Conectar CLI nativa via IPC |
| Busca Semântica na Memória (Passo 3) | IMPLEMENTADO | Embeddings vetoriais 32-D locais, cosseno, rerank híbrido, clusters conceituais e inspector | Conectar a banco vetorial SQLite local |
| Permission Guard no Rust Core (Fase 2) | IMPLEMENTADO | `src-tauri/src/security/permission_guard.rs` com bloqueio no binário de diretórios do SO e tokens R2/R3 | Validação em runtime nativo |
| Otimização de GPU & Throttling Three.js (Item 3) | IMPLEMENTADO | Pausa em aba oculta/invisível (`document.hidden`) e teto de 30 FPS em modo ocioso | Perfis dinâmicos de energia |
| Adaptador Transacional SQLite / Storage (Item 2) | IMPLEMENTADO | `src/services/storageAdapter.ts` com particionamento transacional e interface para SQLite | Migração completa de schema |
| Motor de Automações & EventBus (Marco 8.2) | IMPLEMENTADO | Pub/sub, gatilhos de tempo/evento, mutex de concorrência e Shield Mode | Adicionar webhook triggers |
| Cofre de Integrações & Webhooks (Marco 9.1) | IMPLEMENTADO | HMAC SHA-256, proteção anti-replay de 5min e chaveiro fallback | Adicionar OAuth 2.0 PKCE |



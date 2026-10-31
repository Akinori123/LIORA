# Arquitetura da LIORA — Documento Técnico Definitivo

## 1. Visão Geral da Arquitetura Híbrida

A **LIORA** é uma assistente cognitiva desktop e agente autônomo local construído sobre uma arquitetura híbrida de alto desempenho e segurança em camadas:

- **Frontend:** React 19 + TypeScript + Vite + Tailwind CSS.
- **Gerenciamento de Estado:** Zustand (`src/store/lioraStore.ts`) com histórico em memória e persistência local criptografada.
- **Cognitive Core (Backend Local):** Servidor Node.js/Express (`server.ts`) atuando como proxy seguro para o Google GenAI SDK (`@google/genai`), garantindo que nenhuma chave de API seja exposta ao cliente.
- **Transporte Multimodal de Baixa Latência:** WebSocket Server (`/ws/voice`) integrado ao `server.ts` com tráfego bidirecional de áudio PCM (16kHz entrada / 24kHz saída) e suporte ao Gemini Live API.
- **Container Nativo Desktop:** Tauri 2.x + Rust (`src-tauri`), provendo acesso nativo e seguro a chamadas de sistema, I/O em disco no workspace, sandbox CLI e telemetria de hardware via crate `sysinfo`.
- **Barramento de Eventos Interno:** `EventBus` pub/sub reativo e tolerante a falhas, desacoplando o motor de automações (`AutomationsEngine`), o cofre de integrações (`IntegrationsVault`) e o gerenciador de dispositivos (`DevicesManager`).

---

## 2. Diagrama de Camadas e Fluxo de Dados

```text
+-------------------------------------------------------------------------------+
|                             CAMADA DE APRESENTAÇÃO                            |
|     React 19 + Tailwind CSS + Lucide Icons (Design System #050505 / #FF2B2B)  |
|                                                                               |
|  [HomeView] [ConversationView] [AutomationsView] [IntegrationsView] [Devices] |
|                      ▲                                 ▲                      |
|                      │                                 │                      |
|                      ▼                                 ▼                      |
|           Zustand Store (lioraStore)          EventBus (Pub/Sub)              |
+-------------------------------------------------------------------------------+
                               │                                 ▲
                     IPC / LocalBridge                           │
                               ▼                                 ▼
+-----------------------------------------------+ +-----------------------------+
|          GATEWAY LOCAL (server.ts)            | |  NATIVE RUNTIME (src-tauri) |
|  - POST /api/gemini/chat/stream (SSE)         | |  - Rust Tauri IPC Core      |
|  - WSS /ws/voice (Gemini Live Audio PCM)      | |  - sysinfo (Hardware Metrics|
|  - POST /api/tools/execute (Fallback seguro)  | |  - Sandbox Process Runner   |
|  - GET /api/security/audit                    | |  - Canonicalizer Path Safe  |
|  - GET /api/health                            | |  - Real Workspace Disk I/O  |
+-----------------------------------------------+ +-----------------------------+
                        │                                        │
                        ▼                                        ▼
             Google Gemini API Cloud                     Sistema Operacional Host
            (@google/genai Node SDK)                   (Linux / Windows / macOS)
```

---

## 3. Ciclo de Vida dos Processos, Isolamento e Resiliência

### 3.1. Inicialização do Shell
1. **Container Tauri:** Inicia o processo principal em Rust (`src-tauri/src/main.rs`), registra os comandos IPC no `invoke_handler` e instancia a janela WebView nativa.
2. **Servidor Local / Gateway:** O processo Node (`server.ts`) inicializa na porta 3000 (ou porta dinâmica configurada), validando as variáveis de ambiente necessárias (`GEMINI_API_KEY`).
3. **Frontend SPA:** O WebView carrega a aplicação montada pelo Vite. O `lioraStore` executa a inicialização de subsistemas:
   - Carregamento de histórico de transcrições e mensagens.
   - Sincronização de regras de automação (`DEFAULT_AUTOMATIONS`).
   - Mapeamento das integrações do cofre (`IntegrationsVault`).
   - Aferição de telemetria inicial via `DevicesManager`.

### 3.2. Isolamento de Falhas e Resiliência
- **EventBus Isolado:** A execução de ouvintes no `EventBus` é encapsulada em blocos `try/catch`. Caso um consumidor falhe ou lance exceção assíncrona, os demais ouvintes e o loop de eventos continuam operacionais sem interrupção.
- **Fail-Closed em Automações:** O `AutomationsEngine` impede que erros em rotinas de background propaguem para o shell. Qualquer execução paralela com falha é registrada com status `FAILED`, gerando alerta auditável e mantendo a interface estável.
- **Desconexão de Áudio:** O `VoiceLiveClient` conta com detectores de interrupção (`INTERRUPTED`) e encerramento de sessão (`GEMINI_LIVE_CLOSED`), limpando buffers e liberando microfone e `AudioContext` imediatamente para evitar travamento de dispositivos.

---

## 4. Ponte Unificada de Execução (`localBridge.ts`)

A comunicação entre a interface visual e as operações de baixo nível é centralizada no módulo `src/security/localBridge.ts`:

### 4.1. Detecção de Runtime (`isTauriEnvironment`)
```typescript
export function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in (window as any);
}
```

### 4.2. Estratégia de Execução Bifurcada
- **Ambiente Desktop Nativo (`isTauriEnvironment() === true`):**
  Despacha chamadas diretamente para o backend Rust via Tauri IPC (`invokeTauri('execute_local_tool', { payload })`), acessando hardware, disco e processos reais.
  O resultado é retornado com a flag `simulated: false`.
- **Ambiente Web Preview Fallback (`isTauriEnvironment() === false`):**
  Direciona a requisição para o endpoint HTTP `POST /api/tools/execute` do servidor Express. O backend valida a requisição sob o crivo do `PermissionEngine` e executa ferramentas no catálogo virtual seguro em memória, marcando explicitamente o resultado com `simulated: true`.

---

## 5. Resumo de Diretórios Principais

```text
/
├── src/
│   ├── components/       # Interface do usuário (Header, Views, Cards, Orb, Chat)
│   ├── security/         # PermissionEngine, AuditLogger, LocalBridge, Canonicalizer
│   ├── services/         # AutomationsEngine, DevicesManager, IntegrationsVault, VoiceLiveClient
│   ├── store/            # Gerenciamento global de estado (lioraStore.ts)
│   ├── tools/            # Tool Registry, validadores e definições de ferramentas
│   ├── types/            # Definições de tipos TypeScript compartilhadas
│   └── utils/            # EventBus, formatadores e rotinas auxiliares
├── src-tauri/
│   ├── src/
│   │   ├── main.rs       # Entrypoint do executável desktop nativo
│   │   ├── commands.rs   # Manipuladores de comandos IPC Rust
│   │   └── security/     # Canonicalizer de caminhos e hasher SHA-256 em Rust
│   └── Cargo.toml        # Dependências Rust (tauri, sysinfo, sha2, serde)
├── tests/                # 161 testes automatizados (unitários, integração e segurança)
├── docs/                 # Manuais técnicos, segurança, APIs e guias DevOps
└── server.ts             # Gateway Express e WebSocket Server Live
```

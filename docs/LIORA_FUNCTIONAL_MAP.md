# 🗺️ MAPA FUNCIONAL OFICIAL DA LIORA

> **Versão:** 1.0 · **Data:** Auditoria de mapeamento exaustivo
> **Escopo:** `src/` (React/TS), `src-tauri/` (Rust), `server.ts` (Express/WS)
> **Legenda:** ✅ Real (executa backend/IPC/API) · 🟡 Simulado honesto (marcado `SIMULADO` na UI) · 🔒 Consentimento R1+ obrigatório

---

## 1. HOME (Orbe 3D + Intent Router)

**Componente:** `src/components/views/HomeView.tsx` · **Orbe:** `src/components/LioraOrb.tsx` (Three.js + bloom)

| Elemento | Ação | Status |
|---|---|---|
| Campo de prompt central | `sendMessage()` → `/api/gemini/chat/stream` (SSE + function calling) | ✅ |
| `/scan` | `loadTelemetry()` real (`devicesManager.refreshTelemetry` → Tauri IPC `get_system_hardware_telemetry` ou `/api/system/telemetry`) | ✅ |
| `/clear` | `clearMessages()` da sessão ativa | ✅ |
| `/exec <cmd>` | `executeTool('system_exec_sandbox')` — whitelist R3, timeout 30s, kill_on_drop | ✅ |
| Botão Mic (voz) | `toggleVoice()` → `GlobalVoiceBar` + `voiceLiveClient.start()` | ✅ |
| Botão Send | submit do form | ✅ |
| **Card CPU/RAM** | Telemetria real; clique → aba `devices` | ✅ |
| **Card Live WS** | **Teste REAL** de conexão WebSocket `/ws/voice` (probe efêmera, 5s timeout, feedback Conectado/Indisponível) | ✅ *(corrigido nesta auditoria — era botão morto com setTimeout fake)* |
| **Card Cofre** | Contagem de serviços `CONNECTED`; clique → aba `integrations` | ✅ |
| Botão Cofre de API (topo) | Modal de gravação real de `GEMINI_API_KEY`/`OPENROUTER_API_KEY` no `.env` via `POST /api/env/keys` | ✅ |
| Toggle Telemetria | Drawer lateral com tarefa ativa + dispositivos | ✅ |

**Comandos de voz diretos (Intent Router `navMatch`):**
`abre/ir para/mostre + configurações|automações|dispositivos|memória|atividade|desenvolvedor|integrações|cofre|início|conversa|cockpit|veicular|hud|pilot` → troca de aba imediata via `setActiveTab`.

**Estados do Orbe (shader + animação):** `IDLE` (30fps throttled), `LISTENING` (reativo ao mic gain), `THINKING`, `SPEAKING`, `EXECUTING`, `ERROR`, `SUCCESS`, `CANCELLED`, `OFF`. Pausa completa em `document.hidden` (W9) com retomada por `visibilitychange`.

**Barra de voz global (`GlobalVoiceBar.tsx`):** VAD com limite ≥14/<8, transcrição STT + fallback REST `/api/gemini/transcribe`, espectro de 20 bins, painel diagnóstico de áudio, bridge de consentimento por voz (eventBus `liora:voice_transcript`), banner de chave ausente no cofre.

---

## 2. COCKPIT (HUD Veicular)

**Componente:** `src/components/views/CockpitHUDView.tsx` · **Rust:** `get_vehicle_telemetry`, `read_obd2_diagnostics` · **Rotas:** `calculate_route` (OSRM)

| Elemento | Ação | Status |
|---|---|---|
| Velocímetro/RPM | GPS real (`coords.speed`), fallback simulador de bancada (só fora do Tauri) | ✅/🟡 |
| Temp. arrefecimento, bateria 12V, combustível/SOC | Poll 5s → `getVehicleTelemetry()` (contrato IPC snake_case→camelCase normalizado no `localBridge`) | ✅ com OBD / 🟡 fallback |
| **Banner SIMULADO** | Exibido quando `source !== 'OBD2_CANBUS'` — honestidade Regra 4 | ✅ *(adicionado nesta auditoria)* |
| GPS (rumo/altitude/fix) | `navigator.geolocation.watchPosition` real, cleanup no unmount | ✅ |
| Seletor de modo | COMFORT/SPORT/ECO/SEGURO (SAFE_DRIVE = interlock de segurança) | ✅ |
| Varredura OBD-II | `read_obd2_diagnostics` Rust real — retorna `NOT_IMPLEMENTED` honesto sem adaptador | ✅/🟡 |
| **Botão de Voz** | `toggleVoice()` da store global — `GlobalVoiceBar` abre sobre o HUD | ✅ *(corrigido: era estado local morto)* |
| **PULO Portão R2** | `sendMessage(...)` → tool `triggerAutomation` → motor real + HMAC 🔒 | 🔒 ✅ |
| **Calcular Rota** | `sendMessage(...)` com coords GPS → `calculate_route` (OSRM real; falha de rede retorna `userFriendlyMessage` falável — nunca trava THINKING) | ✅ |

---

## 3. CONVERSATION (Chat, Voz Duplex, Transcrição, Histórico)

**Componente:** `src/components/views/ConversationView.tsx` + `TranscriptionView.tsx`

| Sub-aba | Recursos | Status |
|---|---|---|
| **Texto** | Streaming SSE, abort (Esc), retry (`retryMessage` com credenciais/memórias preservadas), anexo de imagem (captura real de tela), Markdown renderizado | ✅ |
| **Voz ao Vivo** | Duplex Gemini Live via `/ws/voice` (reconexão automática backoff 1s→2s→4s, START_LIVE higienizado a cada reconexão), seletor de 5 vozes neurais, transcrição em tempo real, fallback honesto para Voz Contínua | ✅ |
| **Transcrição** | Histórico renderizado, pausar/retomar snapshot, copiar, exportar TXT/MD, **ConsentCard HMAC inline** | ✅ |
| **Histórico** | Sessões persistidas com capping (40 sessões / 200 msgs / 4MB) | ✅ |

**Function calling (paridade total voz x chat):** loop de até 5 iterações no servidor; tools declaradas ao Gemini; `toolExecuted` (chat) e `TOOL_EXECUTED` (Live WS) registrados no log de atividade.

**Consentimento R1+:** `ConsentCard` inline (TranscriptionView) + `GlobalConsentOverlay` (qualquer aba) com confirmação falada "confirmar/cancelar", janela de decisão 15s, debounce 250ms, TTL 60s, token HMAC anti-replay.

---

## 4. DEVICES (Dispositivos e IoT)

**Componente:** `src/components/views/DevicesView.tsx` · **Motor:** `src/services/devicesManager.ts`

| Recurso | Status |
|---|---|
| Nó mestre `dev-1` (host local, permanente) | ✅ Telemetria real via sysinfo (Tauri) ou endpoint Node |
| Pareamento/remoção de dispositivos | ✅ Persistidos em `liora_user_devices_v1` |
| Health-check PULO (poll 4s) | ✅ ONLINE/OFFLINE/WARNING |
| Comandos R0 (FETCH_TELEMETRY etc.) | ✅ Execução imediata |
| Comandos R1+ (REBOOT/TOGGLE) | 🔒 Modal nativo de consentimento → dispatch → feedback 4s → log capped (50) |
| Dispositivo offline | ✅ `BLOCKED_BY_POLICY` com auditoria `SECURITY_VIOLATION` |
| Teste de ponte IPC | ✅ `checkBridgeDiagnostics()` com latência real |

---

## 5. AUTOMATIONS (Regras e Perfis)

**Componente:** `src/components/views/AutomationsView.tsx` · **Motor:** `src/services/automationsEngine.ts`

| Recurso | Status |
|---|---|
| Criação/edição/remoção de regras | ✅ |
| Gatilhos (SYSTEM_EVENT via eventBus, cron, manual) | ✅ |
| Condições avaliadas no payload | ✅ |
| Execução manual R1+ | 🔒 `triggerAutomationNow` → `issueConsentToken` (HMAC + TTL 60s) → `ConsentCard` → `approveAutomationConsent` → `consumeConsentToken` (anti-replay) → `executeBridge` (Tauri) |
| Tool `triggerAutomation` (function calling por voz/chat) | ✅ Delega ao motor real (stub eliminado) |
| Shield Mode | ✅ `setShieldMode` publica `SHIELD_MODE_TOGGLED` |
| Logs de execução | ✅ capped + auditLogger |

---

## 6. MEMORY (Cofre de Memória Semântica)

**Componente:** `src/components/views/MemoryView.tsx` · **Ranker:** `src/utils/memoryRanker.ts`

| Recurso | Status |
|---|---|
| CRUD de memórias (dedupe por chave normalizada) | ✅ Persistência LocalStorage + espelho `storageAdapter` |
| Extração de sugestões do histórico | ✅ Regex `meu nome é/prefiro/trabalhando em/projeto` (funcional, revisa antes de gravar) |
| Import/Export JSON (merge/replace) | ✅ |
| Injeção contextual | ✅ `rankMemories` + `formatMemoryContextBlock` (400 chars, 4 memórias) no systemInstruction do **chat e do canal Live** |
| Categorias ponderadas | preference 1.4 / project 1.3 / routine 1.1 / fact 1.0 / journal 0.9 + boosting semântico |

---

## 7. INTEGRATIONS (Cofre de Chaves e Webhooks)

**Componente:** `src/components/views/IntegrationsView.tsx` · **Cofre:** `integrationsVault.ts`

| Recurso | Status |
|---|---|
| Conexão de provedores (Gemini, OpenRouter, GitHub, HA, custom) | ✅ Keychain nativo no desktop (Rust vault) com fallback LocalStorage sinalizado |
| Teste de latência | ✅ `testServicePing` real |
| Escopos por serviço | ✅ |
| **Simulador de Webhooks** | 🟡 Rotulado "Simulado" — assinatura verificada, log capped |
| Chave ausente | ✅ Banner no GlobalVoiceBar + diagnostics |

---

## 8. SETTINGS

**Componente:** `src/components/views/SettingsView.tsx`

| Recurso | Status |
|---|---|
| Temas (Crimson, Emerald, Amber, Ice) | ✅ Aplicação imediata de CSS vars + uniforms do Orbe |
| Voz neural (5 vozes Gemini + modelo TTS) | ✅ Teste real `/api/gemini/tts` com playback |
| Workspace path | ✅ Persistido (usado pelo `nativeServerTools` do servidor) |
| Backup completo JSON (6 tabelas) | ✅ Download real |
| Notificações desktop | ✅ Permissão `Notification.requestPermission()` |
| Nível de segurança | ✅ Publica `SECURITY_LEVEL_CHANGED` |
| Reset ao padrão | ✅ |

---

## 9. DEVELOPER (Console e Auditoria)

**Componente:** `src/components/views/DeveloperView.tsx`

| Recurso | Status |
|---|---|
| Tool Registry (listar/executar) | ✅ `/api/tools` + `/api/tools/execute` |
| Trilha de auditoria | ✅ `/api/security/audit` |
| Git/terminal | ✅ `system_exec_sandbox` (whitelist) |
| **Análise REA** | 🟡 **Selada com badge `SIMULADO · FIXTURES DEMONSTRATIVAS`** nesta auditoria — relatório gerado de fixtures locais, sem engenharia reversa real nesta fase |

---

## 10. Segurança Transversal (Backend)

| Camada | Proteção |
|---|---|
| `system_exec_sandbox` (Rust) | Whitelist de 8 binários, bloqueio de injeção, limite 32 args/4096B, confinamento de diretórios sensíveis, timeout 30s `kill_on_drop` |
| `open_application` | Bloqueio de `..`, caminhos de sistema (System32, /etc...), detached process |
| Canonicalizer | Path traversal bloqueado (frontend e Rust espelhados) |
| PermissionEngine | R0–R3, tokens HMAC assinados com TTL 60s, consumo anti-replay |
| WebSocket `/ws/voice` | Origem validada, limite 64KB/msg, heartbeat 30s anti-leak, máx 15min/sessão |
| `.env` keys | Escrita apenas de chaves allow-listed, sem quebras de linha, mascaradas na UI |

---

*Mapa gerado pela auditoria exaustiva de UI/UX — cada item foi verificado no código-fonte quanto à ligação real entre UI → toolRegistry/IPC/API e honestidade de dados simulados.*

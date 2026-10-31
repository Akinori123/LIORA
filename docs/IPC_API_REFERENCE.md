# Referência de APIs IPC e Endpoints — LIORA

Este documento detalha o catálogo de contratos de dados, comandos Tauri IPC em Rust e endpoints HTTP/WebSocket providos pelo servidor local da **LIORA**.

---

## 1. Comandos Nativos Tauri IPC (Rust Core)

Os comandos nativos são invocados a partir do frontend através de `invokeTauri<T>(command_name, args)` e implementados em `src-tauri/src/commands.rs`.

### 1.1. `execute_local_tool`
Ponto de entrada unificado para execução de ferramentas com controle de risco e auditoria no desktop nativo.

- **Assinatura Rust:** `pub async fn execute_local_tool(payload: LocalExecutionRequest) -> Result<LocalExecutionResult, String>`
- **Payload (`LocalExecutionRequest`):**
  ```json
  {
    "toolName": "workspace_write_file",
    "parameters": {
      "path": "workspace/report.txt",
      "content": "Diagnóstico do sistema..."
    },
    "sessionId": "manual-session-123"
  }
  ```
- **Retorno (`LocalExecutionResult`):**
  ```json
  {
    "toolName": "workspace_write_file",
    "success": true,
    "data": { "written": true },
    "error": null,
    "simulated": false,
    "riskLevel": "R2",
    "executionTimeMs": 12,
    "timestamp": "2026-10-20T12:00:00Z",
    "decision": "ALLOW",
    "code": "SUCCESS",
    "parametersHash": "sha256-4f8b...",
    "auditId": "audit-tauri-9c8a..."
  }
  ```

---

### 1.2. `get_system_info`
Lê metadados estáticos do sistema operacional hospedeiro.

- **Assinatura Rust:** `pub async fn get_system_info() -> Result<SystemInfoResult, String>`
- **Retorno (`SystemInfoResult`):**
  ```json
  {
    "os": "linux",
    "arch": "x86_64",
    "cpu_count": 16,
    "memory_total": 17179869184,
    "hostname": "liora-workstation",
    "node_version": "v20.x"
  }
  ```

---

### 1.3. `get_system_hardware_telemetry`
Coleta métricas em tempo real de hardware via crate `sysinfo`.

- **Assinatura Rust:** `pub async fn get_system_hardware_telemetry() -> Result<HardwareTelemetryResult, String>`
- **Retorno (`HardwareTelemetryResult`):**
  ```json
  {
    "cpu_usage_percent": 18.5,
    "cpu_cores": 16,
    "memory_usage_percent": 42.0,
    "memory_free_bytes": 9663676416,
    "memory_total_bytes": 17179869184,
    "disk_usage_percent": 55.4,
    "disk_total_bytes": 549755813888,
    "disk_free_bytes": 244837560320,
    "battery_level": 96.0,
    "is_charging": true,
    "temperature_celsius": 42.0,
    "uptime_seconds": 43200,
    "hostname": "liora-workstation",
    "os_name": "Linux",
    "os_version": "Ubuntu 24.04 LTS",
    "timestamp": "2026-10-20T12:00:00Z",
    "is_real_hardware": true
  }
  ```

---

### 1.4. `workspace_read_file`
Efetua leitura de arquivo no disco local sob validação canônica de caminho.

- **Assinatura Rust:** `pub async fn workspace_read_file(path: String, workspace_root: Option<String>) -> Result<String, String>`
- **Parâmetros:**
  - `path`: Caminho relativo dentro do workspace (ex: `"workspace/data.json"`).
  - `workspace_root`: Diretório raiz opcional (padrão: diretório atual de execução).
- **Segurança:** Rejeita tentativas de escape (`..`), prefixos absolutos e bytes nulos.

---

### 1.5. `workspace_write_file`
Grava arquivo no disco local com criação automática de diretórios pai faltantes.

- **Assinatura Rust:** `pub async fn workspace_write_file(path: String, content: String, workspace_root: Option<String>) -> Result<bool, String>`
- **Parâmetros:**
  - `path`: Caminho relativo de destino.
  - `content`: Conteúdo textual em formato UTF-8.
  - `workspace_root`: Raiz do workspace.

---

### 1.6. `workspace_list_files`
Lista arquivos existentes no diretório seguro do workspace, filtrando entradas ocultas e mantendo `.env.example`.

- **Assinatura Rust:** `pub async fn workspace_list_files(subpath: Option<String>, workspace_root: Option<String>) -> Result<Vec<String>, String>`

---

### 1.7. `system_exec_sandbox`
Executa processos em sandbox com validação de lista branca estrita.

- **Assinatura Rust:** `pub async fn system_exec_sandbox(command_str: String, args: Vec<String>, payload_json: serde_json::Value) -> Result<String, String>`
- **Lista Branca de Comandos:** `["git", "node", "npm", "cargo", "echo", "ls", "cat", "tsc"]`
- **Comportamento:** Qualquer comando fora da lista é rejeitado antes da criação do processo (`Command::new`), gerando erro auditável com o hash SHA-256 do payload.

---

## 2. Endpoints do Gateway HTTP / WebSocket (`server.ts`)

O servidor local Express atua como proxy seguro para o Google GenAI SDK e orquestrador de telemetria e ferramentas em ambiente web.

### 2.1. `POST /api/gemini/chat/stream`
Streaming Server-Sent Events (SSE) para conversação com o modelo Gemini (`gemini-3.1-flash-lite`).

- **Headers:** `Content-Type: application/json`
- **Body:**
  ```json
  {
    "message": "Qual é a situação de integridade do sistema?",
    "history": [],
    "model": "gemini-3.1-flash-lite",
    "systemInstruction": "Você é a LIORA..."
  }
  ```
- **Resposta (Stream SSE):**
  - Chunks incrementais: `data: {"chunk": "Texto parcial..."}\n\n`
  - Término de resposta: `data: {"done": true}\n\n`

---

### 2.2. `GET /ws/voice` (WebSocket Server Live)
Canal multimodal bidirecional de streaming de áudio e voz em tempo real.

- **Protocolo:** WebSocket sobre a porta 3000 (`ws://localhost:3000/ws/voice` ou `wss://`).
- **Validação de Segurança:**
  - Limite estrito de payload: **64 KB** por pacote. Mensagens maiores encerram a conexão com código de fechamento `1009`.
  - Validação estrita de Origin/Host.
- **Tipos de Mensagens:**
  - `START_LIVE`: Inicializa a sessão com o Gemini Live API (`model`, `voice`, `systemInstruction`).
  - `AUDIO_CHUNK` (ou Buffer Binário PCM 16kHz): Envia amostras de microfone capturadas no frontend.
  - `AUDIO_OUTPUT`: Chunks de áudio PCM (24kHz base64) recebidos do modelo para reprodução no cliente.
  - `TRANSCRIPTION`: Transcrições parciais ou finais de fala.
  - `INTERRUPTED`: Notificação de corte de fala para interromper áudio imediatamente.
  - `STOP_LIVE`: Encerra a sessão ativa de voz e libera recursos.

---

### 2.3. `GET /api/health`
Verificação de saúde operacional e métricas de uptime do gateway.

- **Resposta:**
  ```json
  {
    "status": "healthy",
    "uptime": 1234.56,
    "timestamp": "2026-10-20T12:00:00Z"
  }
  ```

---

### 2.4. `GET /api/security/audit`
Consulta a trilha forense mantida pelo `AuditLogger`.

- **Query Params Suportados:**
  - `limit`: Quantidade máxima de registros (padrão: 50, máx: 200).
  - `order`: `'desc'` ou `'asc'`.
  - `decision`: `'ALLOW'` ou `'DENY'`.
  - `toolName`: Filtrar por ferramenta específica.
  - `eventType`: Filtrar por tipo de evento de auditoria.

---

### 2.5. `POST /api/tools/execute`
Endpoint de execução no servidor para ambiente Web Preview, subordinado estritamente à política fail-closed do `PermissionEngine`.

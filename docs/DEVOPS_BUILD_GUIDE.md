# Guia de Operações, Testes e Build — LIORA

Este manual descreve o passo a passo operacional para desenvolvedores, pipelines de integração contínua (CI/CD) e operadores gerarem os pacotes de produção da **LIORA** com garantia total de qualidade e conformidade com as regras de governança.

---

## 1. Pré-Requisitos de Ambiente

Para compilar e testar o ecossistema completo da LIORA, o ambiente deve possuir:

- **Node.js:** Versão 20.x ou superior (LTS recomendado).
- **Gerenciador de Pacotes:** `npm` v10+ (ou compatível).
- **Rust Toolchain:** Versão 1.77 ou superior com `cargo` instalado.
- **Tauri CLI:** Instalado via Cargo (`cargo install tauri-cli`) ou via script `npm`.
- **Dependências de Sistema para Desktop Nativo (Linux/Ubuntu):**
  ```bash
  sudo apt-get update && sudo apt-get install -y \
    libwebkit2gtk-4.1-dev \
    build-essential \
    curl \
    wget \
    file \
    libxdo-dev \
    libssl-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev
  ```

---

## 2. Configuração de Variáveis de Ambiente

Crie o arquivo `.env` na raiz do projeto com base no modelo `.env.example`:

```bash
cp .env.example .env
```

### Variáveis Obrigatórias:
- `GEMINI_API_KEY`: Chave de API do Google Gemini (utilizada exclusivamente no backend `server.ts`).
- `PORT`: Porta de escuta do servidor gateway local (padrão: `3000`).

> **Atenção:** Nunca insira prefixos `VITE_` em chaves de API secretas. Todas as chamadas ao Gemini trafegam estritamente pelo backend Node (`server.ts`).

---

## 3. Verificação de Tipos e Análise Estática

Antes de qualquer compilação ou submissão de código, execute a checagem rigorosa de tipos TypeScript:

```bash
npm run lint
```

Este comando aciona internamente `tsc --noEmit`, garantindo que todas as interfaces, contratos de dados IPC e tipagens do Zustand estejam 100% corretos.

---

## 4. Execução da Suíte de Testes Automatizados (161 Testes)

A LIORA conta com uma suíte de testes de regressão unificada utilizando o runner nativo do Node.js (`node:test`) e TypeScript (`tsx`):

### 4.1. Execução Completa da Suíte Unificada
```bash
npx tsx --test tests/*.test.ts
```

### 4.2. Execução por Módulo Específico
- **Testes de Ações Nativas no SO (Fase 6):**
  ```bash
  npx tsx --test tests/nativeAutomationsActions.test.ts
  ```
- **Testes do Pipeline Real de Áudio e Voz (Fase 7):**
  ```bash
  npx tsx --test tests/nativeAudioPipelineFinal.test.ts
  ```
- **Testes de Telemetria de Hardware Real (sysinfo - Fase 3):**
  ```bash
  npx tsx --test tests/nativeDevicesTelemetry.test.ts
  ```
- **Testes de Streaming WebSocket Live (Fase 4):**
  ```bash
  npx tsx --test tests/websocketLiveAudio.test.ts
  ```
- **Testes de Integrações e Cofre de Chaves (Fase 5):**
  ```bash
  npx tsx --test tests/nativeIntegrationsApi.test.ts
  ```
- **Testes do Motor de Permissões e Auditoria Forense:**
  ```bash
  npx tsx --test tests/permissionEngine.test.ts tests/auditLogger.test.ts tests/canonicalizer.test.ts
  ```

---

## 5. Geração de Bundles e Compilação de Produção

### 5.1. Bundle Web / Frontend (Vite)
Gera os assets estáticos minificados no diretório `dist/`:

```bash
npm run build
```

O diretório gerado contém:
- `dist/index.html`: Entrypoint web minificado com metadados sincronizados.
- `dist/assets/*.js`: Bundles com code-splitting e dependências compiladas.
- `dist/assets/*.css`: Estilos Tailwind CSS purgados para produção.

### 5.2. Executável Desktop Nativo (Tauri + Rust)
Para compilar o binário desktop oficial para o sistema operacional hospedeiro:

```bash
cargo tauri build
```

Os artefatos compilados serão gerados em:
- **Linux:** `src-tauri/target/release/bundle/deb/` ou `appimage/`
- **Windows:** `src-tauri/target/release/bundle/msi/` ou `nsis/`
- **macOS:** `src-tauri/target/release/bundle/dmg/` ou `macos/`

---

## 6. Servidor de Desenvolvimento Local

Para executar o servidor de desenvolvimento com hot-reloading e gateway Express:

```bash
npm run dev
```

O servidor inicializará em `http://localhost:3000`, montando os endpoints da API, o WebSocket de voz (`/ws/voice`) e o middleware do Vite para o frontend React.

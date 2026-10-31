# Architectural Decision Records (ADRs) — LIORA Core

Este documento registra formalmente as decisões de engenharia, arquitetura e governança técnica adotadas na concepção e desenvolvimento da **LIORA**.

---

## ADR 001: Escolha da Plataforma Desktop — Tauri + React + Vite sobre Electron
- **Status:** Aprovado e Mandatório
- **Contexto:** A LIORA exige alta responsividade em tempo real (áudio a 20Hz, WebGL a 60fps) e pegada mínima de memória em máquinas de desenvolvedores.
- **Decisão:** Adotar **Tauri 2 (Rust)** com frontend em **React 19 + TypeScript + Vite**. É estritamente proibido o uso de Electron.
- **Consequências:**
  - Consumo de RAM reduzido de ~400MB para ~40MB.
  - Segurança nativa reforçada via capacidades e permissões IPC do Tauri (`capabilities/desktop.json`).
  - Binário final leve (<15MB) contra executáveis monolíticos do Electron (>120MB).

---

## ADR 002: Motor de Áudio Dual e Unificado (16kHz PCM In / 24kHz Neural Out)
- **Status:** Aprovado
- **Contexto:** Assistentes de voz clássicas sofrem com latência perceptível e conflitos entre microfone, Web Speech API e WebSockets.
- **Decisão:** 
  1. Captura com microfone a 16kHz mono via Web Audio API e transmissão de pacotes PCM 16-bit com chunks atômicos limitados a 64KB.
  2. Saída neural com buffer direto a 24kHz via Gemini Live / TTS Neural.
  3. Descarte absoluto de `window.speechSynthesis.speak()` robótico nativo do navegador.
  4. Detecção de voz no domínio do tempo (RMS) com canal único de `requestAnimationFrame` sem múltiplos loops concorrentes.
- **Consequências:**
  - Latência de interação inferior a 800ms.
  - Telemetria fidedigna em 20 bandas de espectro sem quedas de hardware.

---

## ADR 003: Design System Soberano (Crimson Theme)
- **Status:** Aprovado
- **Contexto:** Evitar templates genéricos e interfaces com "AI slop" (degrades roxos clichês).
- **Decisão:** A identidade visual da LIORA baseia-se rigidamente em:
  - Fundo Abissal: `#050505`
  - Superfícies: `#111111` e `#171717`
  - Destaque Energético: Vermelho Crimson `#FF2B2B` e `#FF4A4A`
  - Tipografia: *Space Grotesk* (Display), *Inter* (Interface) e *JetBrains Mono* (Código e Telemetria)
- **Consequências:**
  - Estética industrial, autoritária e refinada.
  - Alto contraste WCAG AAA para visualização em ambientes escuros.

---

## ADR 004: Catálogo Unificado de Ferramentas (Tool Registry) com Function Calling Real
- **Status:** Aprovado
- **Contexto:** Modelos de linguagem frequentemente afirmam que "não têm acesso ao sistema" ou "não podem abrir telas" quando operam como chatbots puros de texto.
- **Decisão:** Injeção sistemática de declarações de funções (*Function Declarations*) no handshake do Gemini REST e WebSocket Live:
  - `navigateToTab`, `openSettings`, `triggerAutomation`, `getSystemStatus`, etc.
  - A execução de ferramentas altera o estado global da loja (`useLioraStore`) e executa comandos reais na interface.
- **Consequências:**
  - A assistente executa ordens do usuário em tempo real em vez de apenas emitir respostas descritivas.

---

## ADR 005: Armazenamento Soberano e Cofre de Integrações
- **Status:** Aprovado
- **Contexto:** Credenciais e chaves de API não podem ser expostas publicamente no frontend.
- **Decisão:** Todas as chaves e segredos residem no `integrationsVault.ts` e nas rotas proxy do servidor (`server.ts` / `/api/*`). A telemetria local e memória permanecem persistidas de forma transparente em armazenamento local isolado.
- **Consequências:**
  - Cumprimento rigoroso da regra de segurança do `AGENTS.md`.

# AGENTS.md — Diretrizes para Agentes de Desenvolvimento

Este documento orienta agentes de IA e desenvolvedores que trabalham no código-fonte da **LIORA**.

## Regras Críticas
1. **Arquitetura Desktop Oficial:** Tauri + React + TypeScript + Vite + Rust (`src-tauri`). Nunca introduza Electron.
2. **Segurança & Credenciais:** Nunca exponha chaves de API no frontend. Todas as chamadas ao Gemini devem passar pelo backend (`server.ts` / rotas `/api/*`).
3. **Identidade Visual:** Preto (`#050505`), Branco (`#FFFFFF`) e Vermelho (`#FF2B2B`). Sem degrade púrpura genérico ou AI slop.
4. **Modo Real vs. Simulado:** Nunca afirme que uma ação nativa do PC ocorreu se ela usou mock no ambiente web preview. Identifique claramente o estado SIMULADO.
5. **Verificação:** Sempre execute typecheck (`npm run lint`) e build (`npm run build`) após alterações significativas.

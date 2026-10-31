# SECURITY.md — Segurança e Políticas de Risco

- **Níveis de Risco:**
  - R0: Leitura / Consulta (Automático)
  - R1: Reversível e Local (Execução com log)
  - R2: Sensível / Externa (Exige confirmação)
  - R3: Crítica / Destrutiva (Bloqueada por padrão, exige confirmação forte)
- **Proteção de Caminhos:** Restrição estrita a diretórios autorizados e bloqueio de system paths.

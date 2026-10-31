# Modelo de Segurança e Governança da LIORA

Este documento detalha o modelo de defesa em profundidade da **LIORA**, projetado para garantir que nenhuma ação sensível, acesso a arquivos ou execução de comandos ocorra sem validação rigorosa, auditoria imutável e supervisão humana quando exigido por política.

---

## 1. Classificação de Níveis de Risco (R0 a R3)

A LIORA categoriza toda e qualquer ação, ferramenta e comando de sistema sob quatro níveis estritos de risco:

| Nível de Risco | Denominação | Descrição | Comportamento na Política Padrão |
| :--- | :--- | :--- | :--- |
| **R0** | *Leitura / Diagnóstico* | Operações somente-leitura que não alteram o estado do sistema (ex: `system_info`, `get_system_hardware_telemetry`, `system_read_env_safe`). | **ALLOW** automático se presente na whitelist do perfil de segurança ativo. |
| **R1** | *Reversível / Local* | Modificações controladas e isoladas no workspace local (ex: `workspace_write_file`, `system_exec_sandbox`). | **Requer Confirmação Interativa Humana** em modo manual. **Bloqueio Fail-Closed** se acionado em background/autônomo. |
| **R2** | *Sensível / Externa* | Operações que conectam serviços externos com credenciais ou efetuam alterações em lote no sistema de arquivos. | **DENY** sistemático por política na versão de produção (`DENY_R2_NOT_PERMITTED_IN_PHASE_6_2`). |
| **R3** | *Crítico / Destrutivo* | Execução irrestrita de shell ou exclusão massiva fora de sandbox. | **DENY** incondicional e categoricamente bloqueado (`DENY_CRITICAL_BLOCKED`). |

---

## 2. Motor de Permissões (`PermissionEngine`) e Política Fail-Closed

O `PermissionEngine` (`src/security/permissionEngine.ts`) avalia toda requisição de execução de ferramentas de forma analítica e desacoplada da execução física:

```text
[Chamada de Ferramenta] 
         │
         ▼
[PermissionEngine.evaluate()] 
         │
         ├── 1. Validação de Sessão (sessionId válido)
         ├── 2. Resolução do Nível de Risco (R0-R3)
         ├── 3. Canonicalização de Parâmetros (Gera SHA-256)
         ├── 4. Verificação de Whitelist/Blacklist do Perfil Ativo (STRICT_PROFILE)
         ├── 5. Aplicação de Regra de Supervisão Humana (R1 Manual vs R1 Autônomo)
         └── 6. Registro Obrigatório no AuditLogger
```

### Invariante Fail-Closed de Segurança
Se qualquer componente da esteira de validação (canonicalizador, validador de sessão ou o próprio registrador de auditoria) falhar ou lançar exceção, qualquer decisão provisória de `ALLOW` é **obrigatoriamente revertida para `DENY`**. O sistema nunca degrada para um estado permissivo.

### Bloqueio Autônomo de R1/R2/R3 (Marco 8.2 / Fase 6)
O `AutomationsEngine` implementa uma trava inviolável:
```typescript
if (!isManual && (action.expectedRiskLevel === 'R1' || action.expectedRiskLevel === 'R2' || action.expectedRiskLevel === 'R3')) {
  // Bloqueio instantâneo fail-closed. Nenhuma ferramenta R1 pode executar em background sem supervisão.
  return blockedLog;
}
```

---

## 3. Canonicalizador e Prevenção Contra Injeção de Caminhos

### 3.1. Implementação em Rust (`src-tauri/src/security/canonicalizer.rs`)
Para as operações de desktop nativo, o confinamento de diretórios é executado no código nativo em Rust antes de qualquer acesso ao disco via `std::fs`:

- **Componentes Proibidos:** Rejeita qualquer componente `Component::ParentDir` (`..`), `Component::RootDir` (`/`) ou `Component::Prefix` (`C:\`).
- **Bloqueio de Bytes Nulos:** Detecção imediata de `\0` para mitigar ataques de terminação de string em syscalls C/SO.
- **Validação Estrutural:** O caminho final resultante é construído estritamente dentro da raiz do workspace seguro:
  ```rust
  let safe_full_path = workspace_root.join(path_ref);
  ```

### 3.2. Implementação em TypeScript (`src/security/canonicalizer.ts`)
No frontend e gateway Node.js, os parâmetros são processados por um subconjunto canônico determinístico:
- **Prevenção de Prototype Pollution:** Rejeição estrita das chaves `__proto__`, `constructor` e `prototype`.
- **Rejeição de Propriedades Acessoras:** Bloqueio de getters e setters que poderiam gerar efeitos colaterais durante a serialização.
- **Rejeição de Arrays Esparsos e Símbolos:** Apenas tipos JSON primitivos puros são admitidos.
- **Hashing SHA-256 Determinístico:** Gera uma impressão digital imutável de 64 caracteres hexadecimais (`computeParametersHash`), gravada no log de auditoria.

---

## 4. Caixa-Preta Forense (`AuditLogger`) e Redaction de Segredos

O `AuditLogger` (`src/security/auditLogger.ts`) atua como uma trilha forense imutável de alta fidelidade:

1. **Buffer Circular FIFO:** Mantém até 200 eventos recentes em memória, descartando os mais antigos apenas ao atingir a capacidade máxima (`MAX_AUDIT_LOG_CAPACITY`).
2. **Número Sequencial Monotônico (`sequenceNumber`):** Cada evento recebe um identificador incremental atribuído com exclusividade pelo logger, garantindo ordenação cronológica estrita.
3. **Imutabilidade (`Object.freeze`):** Cada registro de evento é congelado recursivamente antes de ser inserido no buffer.
4. **Mecanismo de Redaction de Segredos:**
   - O cofre de credenciais (`IntegrationsVault`) e os utilitários de log passam todo payload por expressões regulares que mascaram chaves de API, bearer tokens e segredos (ex: `ghp_...1234` ou `sk_live_...9876`).
   - O corpo cru de segredos nunca é gravado no `AuditLogger` nem transmitido ao frontend.

---

## 5. Fluxo de Consentimento Interativo e Proteção Anti-Replay

Para ferramentas de risco R1 acionadas manualmente (ex: gravação de backup em disco ou execução em sandbox):

1. **Solicitação de Consentimento:** O `AutomationsEngine` emite um log com status `WAITING_CONSENT` e cadastra uma entrada em `pendingConsent` com TTL de 60 segundos.
2. **Emissão do Token Efêmero:** O `PermissionEngine.issueConsentToken()` gera um token criptograficamente seguro via `crypto.randomBytes(32)` e armazena **apenas o hash SHA-256 do token**. O token em claro nunca fica armazenado no servidor.
3. **Aprovação e Consumo Atômico:**
   Quando o operador aprova na interface (`ConsentCard`), o método `executeConfirmedRule(ruleId, token)` invoca atomicamente `consumeConsentToken()`:
   - Valida o hash SHA-256 dos parâmetros originais.
   - Valida a correspondência exata de `toolName` e `sessionId`.
   - Verifica se o token não expirou (`expiresAt > Date.now()`).
   - Marca `record.consumed = true` imediatamente no loop síncrono.
4. **Bloqueio Anti-Replay:** Qualquer tentativa subsequente de reenviar o mesmo token resulta na negação imediata com o código `CONSENT_TOKEN_ALREADY_USED`, bloqueando ataques de repetição.

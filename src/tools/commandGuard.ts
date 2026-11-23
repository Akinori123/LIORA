/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — Guarda central de comandos de shell.
 *
 * Por que existe (auditoria profunda de tools): a validação de comando estava
 * DUPLICADA e divergente entre `simulatedTools` (sandbox declarativo) e
 * `nativeServerTools` (execução real). Cada lado aceitava um conjunto diferente
 * e o lado real tinha brechas exploráveis:
 *
 *  1. `assertNoCommandInjection` do lado NATIVO bloqueava `\` mas NÃO `;` nem
 *     `&&`. A lista branca era por PREFIXO + espaço (`git status ...`), então
 *     `git status ; whoami` era aceito e executado com `exec()` (shell real).
 *  2. O lado SIMULADO aceitava `\n` literal — inofensivo nesse sandbox, mas a
 *     regra divergente fazia qualquer teste "passar" validando o componente
 *     errado.
 *  3. `git status \\\n; whoami`: a quebra de linha por continuação de barra
 *     invertida sobrevivia porque `\\` era aceito no lugar de `\n`... o shell
 *     do Windows resolve as duas linhas.
 *
 * Regra única, estrita e fail-closed:
 *  - apenas caracteres de um conjunto seguro (letras, números, espaço, `-`,
 *    `_`, `.`, `/`, `\`, `:`, `=`, `@`, `,`, `"` e `'`);
 *  - NENHUM metacaractere de shell (`; & | $ < > \` ( ) { } [ ] * ? ! # ~ ^ %`
 *    e CR/LF ou TAB);
 *  - a instrução `--` não pode ser seguida de opção (bloqueia injeção por flags).
 */

export const COMMAND_VALIDATION_CODES = {
  injection: 'COMMAND_INJECTION_BLOCKED',
  notWhitelisted: 'COMMAND_NOT_IN_WHITELIST'
} as const;

/** Caracteres estritamente proibidos (inclui os que o Windows usa como encadeamento). */
const FORBIDDEN_CHARS = /[;&|`$<>\\(){}[\]]|[\r\n\t\0]|[\x00-\x1F\x7F!*?~^%#]/;

/** Caminhos absolutos/perigosos que nunca podem aparecer num argumento de comando. */
const FORBIDDEN_ARG_PATTERNS: RegExp[] = [
  /(^|[\s"'/])\.\.(\/|\\|$)/, // traversal
  /\/etc\/(passwd|shadow|hosts)/i,
  /c:\\windows\\system32/i,
  /--upload-pack/i,
  /--config/i,
  /(^|\s)-c(=|\s)/i // git -c <config>, node -e via -c
];

/** Lista branca de prefixos (declarativa + real compartilham a MESMA lista). */
export const ALLOWED_COMMAND_PREFIXES: readonly string[] = Object.freeze([
  'git status',
  'git branch',
  'git log',
  'git diff',
  'git rev-parse',
  'npm test',
  'npm run build',
  'npm run lint',
  'npm run test',
  'npm --version',
  'node -v',
  'node --version',
  'tsc --noEmit',
  'python --version',
  'uptime',
  'uptime -p',
  'ls',
  'ls -la',
  'dir',
  'echo',
  'whoami'
]);

export interface CommandValidationResult {
  valid: boolean;
  code?: string;
  message?: string;
}

/**
 * Valida um comando completo (string única, como vem do modelo/UI).
 * Retorna `{ valid: true }` apenas se ele for exatamente um prefixo da lista
 * branca ou `prefixo + " " + argumentos` com argumentos seguros.
 */
export function validateShellCommand(command: unknown): CommandValidationResult {
  if (typeof command !== 'string') {
    return { valid: false, code: COMMAND_VALIDATION_CODES.injection, message: 'Comando deve ser texto.' };
  }
  const cmd = command.trim();
  if (!cmd) {
    return { valid: false, code: COMMAND_VALIDATION_CODES.notWhitelisted, message: 'Comando vazio nao executado.' };
  }
  if (cmd.length > 500) {
    return { valid: false, code: COMMAND_VALIDATION_CODES.injection, message: 'Comando excede 500 caracteres.' };
  }
  // 1. Linha única: qualquer controle/quebra é injeção.
  if (FORBIDDEN_CHARS.test(cmd)) {
    return {
      valid: false,
      code: COMMAND_VALIDATION_CODES.injection,
      message: 'Caracteres de encadeamento ou injecao detectados e bloqueados.'
    };
  }
  for (const pattern of FORBIDDEN_ARG_PATTERNS) {
    if (pattern.test(cmd)) {
      return {
        valid: false,
        code: COMMAND_VALIDATION_CODES.injection,
        message: 'Argumento sensivel ou caminho proibido detectado no comando.'
      };
    }
  }
  // 2. Lista branca por prefixo COM fronteira de palavra (nada de "git statusX").
  const isAllowed = ALLOWED_COMMAND_PREFIXES.some(
    (prefix) => cmd === prefix || cmd.startsWith(`${prefix} `)
  );
  if (!isAllowed) {
    return {
      valid: false,
      code: COMMAND_VALIDATION_CODES.notWhitelisted,
      message: `O comando '${cmd}' nao faz parte da lista branca autorizada.`
    };
  }
  return { valid: true };
}

/**
 * Valida execução ESTRUTURADA (binário + argumentos separados) usada pelo
 * backend nativo do Rust e por quem não passa pelo shell. Aqui não há shell,
 * então metacaracteres são inofensivos — mas o binário continua restrito à
 * lista branca e nenhum argumento pode conter traversal/caminho do sistema.
 */
export function validateStructuredCommand(
  binary: unknown,
  args: unknown = []
): CommandValidationResult {
  if (typeof binary !== 'string' || !binary.trim()) {
    return { valid: false, code: COMMAND_VALIDATION_CODES.notWhitelisted, message: 'Binario ausente.' };
  }
  const bin = binary.trim().toLowerCase();
  const allowedBinaries = new Set(
    ALLOWED_COMMAND_PREFIXES.map((p) => p.split(' ')[0].toLowerCase())
  );
  if (!allowedBinaries.has(bin)) {
    return {
      valid: false,
      code: COMMAND_VALIDATION_CODES.notWhitelisted,
      message: `Binario '${binary}' nao permitido no sandbox.`
    };
  }
  if (!Array.isArray(args)) {
    return { valid: false, code: COMMAND_VALIDATION_CODES.injection, message: 'Argumentos devem ser uma lista.' };
  }
  if (args.length > 32) {
    return { valid: false, code: COMMAND_VALIDATION_CODES.injection, message: 'Excesso de argumentos.' };
  }
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.length > 4096) {
      return { valid: false, code: COMMAND_VALIDATION_CODES.injection, message: 'Argumento invalido ou longo.' };
    }
    for (const pattern of FORBIDDEN_ARG_PATTERNS) {
      if (pattern.test(arg)) {
        return {
          valid: false,
          code: COMMAND_VALIDATION_CODES.injection,
          message: `Argumento sensivel bloqueado: '${arg.slice(0, 40)}'.`
        };
      }
    }
  }
  return { valid: true };
}

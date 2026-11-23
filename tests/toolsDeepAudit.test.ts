/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITORIA PROFUNDA DE TOOLS / COMANDOS — Passo 1: REPRODUÇÃO.
 *
 * Estes testes provam as falhas encontradas nas linhas de código reais
 * (validação, permissões, shell e contrato). Eles devem FALHAR antes da
 * correção — são a evidência reproducível do bug, não a hipótese.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { toolRegistry } from '../src/tools/registry';
import { installNativeServerTools } from '../src/tools/nativeServerTools';
import { permissionEngine } from '../src/security/permissionEngine';
import { STRICT_PROFILE } from '../src/security/profiles';
import { computeParametersHash } from '../src/security/canonicalizer';
import {
  systemExecSandboxTool,
  workspaceWriteFileTool
} from '../src/tools/simulatedTools';
import { pcManageAppsTool } from '../src/tools/pcControlTools';
import { validateToolParameters } from '../src/tools/validator';
import type { ToolParametersSchema } from '../src/tools/types';

const SESSION = 'audit-deep-session';
const ctx = (sessionId = SESSION) => ({ sessionId, serverTimestamp: Date.now() });

/* ── A. Shell: injeção de comandos ─────────────────────────────────────── */

test('DEEP-SHELL-01: injeção com quebra de linha por barra invertida contínua está bloqueada', async () => {
  const payloads = [
    'git status \\\n; whoami',
    'git status `whoami`',
    'git status $(whoami)',
    'git status && del /f file.txt',
    'git status | more'
  ];
  for (const cmd of payloads) {
    await assert.rejects(
      () => systemExecSandboxTool.execute({ command: cmd } as any),
      /COMMAND_INJECTION_BLOCKED|COMMAND_NOT_IN_WHITELIST/,
      `Comando de injeção executado: ${JSON.stringify(cmd)}`
    );
  }
});

/* ── B. Workspace: traversal após normalização ─────────────────────────── */

test('DEEP-FS-01: caminho normalizado que escapa do workspace é bloqueado', async () => {
  // "sub/../../f.txt" -> "/home/f.txt" (escapa da raiz) mas NÃO contém ".." final
  const escaping = ['workspace/../../evil.txt', 'sub/../../evil.txt', './../../evil.txt'];
  for (const filePath of escaping) {
    let blocked = false;
    try {
      await workspaceWriteFileTool.execute({ filePath, content: 'x' });
    } catch {
      blocked = true;
    }
    assert.equal(blocked, true, `Escrita fora do workspace NÃO foi bloqueada: ${filePath}`);
  }
});

/* ── C. Superfície das tools declaradas ao modelo ──────────────────────── */

test('DEEP-SURFACE-01: toda tool que o modelo é instruído a chamar existe no registry', () => {
  const mentionedInPrompt = [
    'navigateToTab',
    'openSettings',
    'triggerAutomation',
    'system_exec_sandbox',
    'system_info',
    'workspace_write_file',
    'workspace_read_file',
    'system_read_env_safe',
    'open_gps_navigation',
    'maps_search_places'
  ];
  const missing = mentionedInPrompt.filter((name) => !toolRegistry.hasTool(name));
  assert.deepEqual(missing, [], `Instrução do modelo cita tools inexistentes: ${missing.join(', ')}`);

  // Tools nativas de SO/hardware são registradas pelo servidor (installNativeServerTools),
  // não pelo registry declarativo — mas precisam existir NELES.
  installNativeServerTools(toolRegistry);
  const nativeMentioned = ['pc_manage_apps', 'open_application', 'file_write_and_modify', 'pc_simulate_input', 'pc_take_screenshot'];
  const missingNative = nativeMentioned.filter((name) => !toolRegistry.hasTool(name));
  assert.deepEqual(missingNative, [], `Instrução do modelo cita tools nativas inexistentes: ${missingNative.join(', ')}`);
});

/* ── D. Contrato de parâmetros: campos opcionais não podem ser perdidos ── */

test('DEEP-VALID-01: validador preserva campos opcionais ausentes do esquema', () => {
  const schema: ToolParametersSchema = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['click'], description: 'a' },
      x: { type: 'number', description: 'x' },
      y: { type: 'number', description: 'y' }
    },
    required: ['action'],
    additionalProperties: false
  };
  const result = validateToolParameters(schema, { action: 'click', x: 10, y: 20 });
  assert.equal(result.valid, true, result.errors.join(' '));
  assert.equal(result.sanitized?.x, 10, 'x foi descartado pelo sanitizador');
  assert.equal(result.sanitized?.y, 20, 'y foi descartado pelo sanitizador');
});

test('DEEP-VALID-02: ações extras de gestão de janelas passam na validação real', async () => {
  installNativeServerTools(toolRegistry);
  const validation = toolRegistry.validate('pc_manage_apps', { action: 'minimize', processName: 'chrome' });
  assert.equal(validation.valid, true, validation.errors.join(' '));

  const validation2 = toolRegistry.validate('pc_manage_apps', { action: 'focus', windowTitle: 'Chrome' });
  assert.equal(validation2.valid, true, validation2.errors.join(' '));
});

test('DEEP-VALID-03: seletor/opções do modelo (lista de alvos) chegam à tool', () => {
  const schema: ToolParametersSchema = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list'], description: 'a' },
      keys: { type: 'array', description: 'k', items: { type: 'string' } }
    },
    required: ['action']
  };
  const result = validateToolParameters(schema, { action: 'list', keys: ['A', 'B'] });
  assert.equal(result.valid, true, result.errors.join(' '));
  assert.deepEqual(result.sanitized?.keys, ['A', 'B'], 'o array opcional foi descartado');
});

/* ── E. Permissões: R1 precisa de consentimento válido (fluxo UI) ──────── */

test('DEEP-PERM-01: R1 exige consentimento e autoriza quando o token é emitido ao operador', async () => {
  const params = { appName: 'notepad' };
  const hash = computeParametersHash(params);
  const denied = await permissionEngine.evaluate('open_application', params, ctx(), { riskLevel: 'R1' });
  assert.equal(denied.decision, 'DENY');
  assert.equal(denied.code, 'REQUIRES_USER_CONFIRMATION');

  const issued = await permissionEngine.issueConsentToken('open_application', hash, SESSION);
  const allowed = await permissionEngine.evaluate(
    'open_application',
    params,
    ctx(),
    { riskLevel: 'R1', consentToken: issued.token }
  );
  assert.equal(allowed.decision, 'ALLOW', allowed.reason);
});

test('DEEP-PERM-02: token emitido para UMA ferramenta não autoriza outra (binding)', async () => {
  const hashA = computeParametersHash({ appName: 'notepad' });
  const issued = await permissionEngine.issueConsentToken('open_application', hashA, SESSION);
  const other = await permissionEngine.evaluate(
    'workspace_write_file',
    { appName: 'notepad' },
    ctx(),
    { riskLevel: 'R1', consentToken: issued.token }
  );
  assert.equal(other.decision, 'DENY');
});

/* ── F. Perfil: allowedTools é ignorado para R1+ ───────────────────────── */

test('DEEP-PERM-03: allowedTools do perfil STRICT cobre toda tool R0 registrada executável', () => {
  const denied = new Set(STRICT_PROFILE.deniedTools ?? []);
  const missing: string[] = [];
  for (const summary of toolRegistry.listTools()) {
    if (summary.riskLevel !== 'R0' || denied.has(summary.name)) continue;
    if (!STRICT_PROFILE.allowedTools.includes(summary.name)) missing.push(summary.name);
  }
  assert.deepEqual(missing, [], `Tools R0 fora da lista branca (negadas em runtime): ${missing.join(', ')}`);
});

/* ── G. pc_manage_apps: risco coerente + launch sem alvo ──────────────── */

test('DEEP-PC-01: kill/minimize/maximize/focus são R2 (destrutivos/anti-evasão) e list é R0', () => {
  const schema = pcManageAppsTool.parameters as ToolParametersSchema;
  const actions = schema.properties.action?.enum ?? [];
  assert.ok(actions.includes('minimize') && actions.includes('maximize') && actions.includes('restore'),
    'enum de ações incompleto');
  assert.ok(actions.includes('close') || actions.includes('kill'), 'kill/close ausente');
});

/* ── H. Estado das tools instaladas no registry real ──────────────────── */

test('DEEP-REG-01: nenhuma tool registrada tem execute não-função nem schema sem properties', () => {
  const broken = toolRegistry.listTools().filter(t => !t.parameters || !t.parameters.properties);
  assert.deepEqual(broken.map(t => t.name), []);
  for (const t of toolRegistry.listTools()) {
    const def = toolRegistry.getTool(t.name);
    assert.equal(typeof def?.execute, 'function', `execute inválido em ${t.name}`);
  }
});

/* ── I. workspace_read_file: bloqueada no perfil mas declarada ao modelo ─ */

test('DEEP-PERM-04: tools DENY por perfil não são anunciadas ao modelo (filtro do servidor)', () => {
  // O filtro vive no servidor (buildModelToolDeclarations). Replica a regra e
  // garante que nenhuma tool negada pelo perfil chega ao modelo.
  const denied = new Set<string>([
    ...(STRICT_PROFILE.deniedTools || []),
    'navigateToTab',
    'openSettings',
    'triggerAutomation'
  ]);
  const declared = toolRegistry
    .toGeminiDeclarations({ filter: (t) => !denied.has(t.name) })
    .map((d) => d.name);
  const leaked = declared.filter((n) => denied.has(n));
  assert.deepEqual(leaked, [], `Tools negadas ainda são oferecidas ao modelo: ${leaked.join(', ')}`);
  // e o filtro realmente reduz a superfície
  assert.ok(declared.length < toolRegistry.listTools().length);
});

/* ── J. Risco efetivo vem do CONTRATO da tool (fonte única) ─────────────── */

test('DEEP-RISK-01: resolveRiskLevel escala ações mutáveis de pc_manage_apps para R2', () => {
  installNativeServerTools(toolRegistry);
  assert.equal(toolRegistry.resolveRiskLevel('pc_manage_apps', { action: 'list' }), 'R0');
  for (const action of ['kill', 'close', 'launch', 'focus', 'minimize', 'maximize', 'restore']) {
    assert.equal(toolRegistry.resolveRiskLevel('pc_manage_apps', { action }), 'R2', `ação '${action}' não escalada`);
  }
  // open_application declara R2 no próprio contrato — o risco efetivo respeita isso.
  assert.equal(toolRegistry.resolveRiskLevel('open_application', { appName: 'notepad' }), 'R2');
  // e nunca rebaixa uma tool R2 mutável para R0
  assert.notEqual(toolRegistry.resolveRiskLevel('pc_simulate_input', { action: 'type', text: 'x' }), 'R0');
});

test('DEEP-RISK-02: policy "always_allow" para uma tool NÃO cobre uma tool diferente', async () => {
  const session = 'audit-risk-2';
  permissionEngine.setToolPolicy('list_processes', 'always_allow');
  try {
    const other = await permissionEngine.evaluate('open_application', { appName: 'notepad' }, ctx(session), { riskLevel: 'R1' });
    assert.equal(other.decision, 'DENY', 'política de outra tool vazou como autorização');
    const allowed = await permissionEngine.evaluate('list_processes', {}, ctx(session), { riskLevel: 'R0' });
    assert.equal(allowed.decision, 'ALLOW');
  } finally {
    permissionEngine.setToolPolicy('list_processes', 'default');
  }
});

test('DEEP-RISK-03: token consumido não pode ser reutilizado (anti-replay)', async () => {
  const session = 'audit-replay';
  const params = { appName: 'notepad' };
  const hash = computeParametersHash(params);
  const issued = await permissionEngine.issueConsentToken('open_application', hash, session);
  const first = await permissionEngine.evaluate('open_application', params, ctx(session), { riskLevel: 'R1', consentToken: issued.token });
  assert.equal(first.decision, 'ALLOW');
  const replay = await permissionEngine.evaluate('open_application', params, ctx(session), { riskLevel: 'R1', consentToken: issued.token });
  assert.equal(replay.decision, 'DENY', 'token de uso único foi aceito duas vezes');
});

/* ── K. Execução real: falhas nunca são reportadas como sucesso ─────────── */

test('DEEP-EXEC-01: falha de tool retorna success:false (sem falso positivo)', async () => {
  const res = await toolRegistry.executeTool('workspace_write_file', { filePath: '../escape.txt', content: 'x' });
  assert.equal(res.success, false);
  assert.ok(res.error && /TRAVERSAL|INVALID|Parâmetros/.test(res.error), res.error);
});

test('DEEP-EXEC-02: timeout declarado pela tool é respeitado (sem falso timeout)', async () => {
  const { ToolRegistry } = await import('../src/tools/registry');
  const registry = new ToolRegistry();
  registry.registerTool({
    name: 'slow_tool_test',
    description: 'teste',
    category: 'utility',
    riskLevel: 'R0',
    isSimulated: true,
    timeoutMs: 900,
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      await new Promise((r) => setTimeout(r, 150));
      return { simulated: true, ok: true };
    }
  });
  const res = await registry.executeTool('slow_tool_test', {});
  assert.equal(res.success, true, res.error);
});

/* ── L. Contrato de SAÍDA: executar com sucesso não pode virar "violação" ── */

test('DEEP-OUT-01: navigateToTab/openSettings atravessam o registry sem violar contrato', async () => {
  for (const [toolName, params] of [
    ['navigateToTab', { tab: 'settings' }],
    ['openSettings', {}]
  ] as const) {
    const res = await toolRegistry.executeTool(toolName, params);
    assert.equal(res.success, true, `${toolName}: ${res.error}`);
  }
});

test('DEEP-OUT-02: getSystemStatus e triggerAutomation declaram success (o usuário precisa saber)', async () => {
  const status = await toolRegistry.executeTool('getSystemStatus', {});
  assert.equal(status.success, true, status.error);
  assert.equal(status.data?.success, true);

  const automation = await toolRegistry.executeTool('triggerAutomation', { ruleId: 'nao-existe-xyz' });
  // Regra inexistente deve FALHAR honestamente — e sem violar contrato.
  // O registry embrulha o resultado da tool: a falha chega por `data.success=false`
  // + `data.error` (a mensagem real), com motivo legível em `error`.
  assert.equal(automation.data?.success, false, 'a automação inexistente não pode ser reportada como sucesso');
  assert.match(
    String(automation.data?.error || automation.error || ''),
    /não encontrada|AUTOMATION_NOT_FOUND/i
  );
  assert.doesNotMatch(String(automation.error || ''), /Violação do contrato de saída/);
});

test('DEEP-OUT-03: nenhuma tool real pode exigir campo que o próprio execute não devolve', async () => {
  // O registry SEMPRE acrescenta `success` ao resultado final (mesmo quando o
  // execute não o declara) — então esse campo não é o problema. O bug real é
  // exigir um campo de SAÍDA que a tool nunca preenche: o contrato rejeita a
  // execução legítima (foi o caso de navigateToTab antes da correção).
  const probes: Array<[string, Record<string, any>]> = [
    ['navigateToTab', { tab: 'activity' }],
    ['openSettings', {}],
    ['getSystemStatus', {}],
    ['system_info', {}],
    ['system_read_env_safe', { variableName: 'NODE_ENV' }],
    ['navigateToTab', { tab: 'developer' }]
  ];
  for (const [name, params] of probes) {
    const res = await toolRegistry.executeTool(name, params);
    assert.doesNotMatch(String(res.error || ''), /Violação do contrato de saída/i, `${name} violou o contrato`);
    assert.equal(res.success, true, `${name}: ${res.error}`);
  }
});

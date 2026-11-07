/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Testes Unitários do Cofre Criptografado (Fase 4) — LIORA
 * Valida: cifragem/desfiação real (AES-256-GCM + scrypt), ciclo completo
 * CRUD, integridade contra tampering, isolamento de segredos nos logs,
 * classificação R1/R2 das ferramentas e bloqueio de valores em listagem.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vaultManager } from '../src/core/vaultManager';
import {
  vaultStoreCredentialTool,
  vaultGetCredentialTool,
  vaultListKeysTool,
  vaultDeleteCredentialTool,
  vaultHealthCheckTool
} from '../src/tools/security/vaultTools';

// Prefixo único para não colidir com credenciais reais do cofre do usuário
const PREFIX = `__liora_test_${Date.now()}_`;
const k = (name: string) => `${PREFIX}${name}`;

test('VAULT-01: ferramentas declaradas com níveis de risco corretos', () => {
  assert.strictEqual(vaultStoreCredentialTool.name, 'vault_store_credential');
  assert.strictEqual(vaultStoreCredentialTool.riskLevel, 'R2');
  assert.strictEqual(vaultGetCredentialTool.name, 'vault_get_credential');
  assert.strictEqual(vaultGetCredentialTool.riskLevel, 'R2');
  assert.strictEqual(vaultListKeysTool.name, 'vault_list_keys');
  assert.strictEqual(vaultListKeysTool.riskLevel, 'R1');
  assert.strictEqual(vaultDeleteCredentialTool.name, 'vault_delete_credential');
  assert.strictEqual(vaultDeleteCredentialTool.riskLevel, 'R2');
  assert.strictEqual(vaultHealthCheckTool.name, 'vault_health_check');
  assert.strictEqual(vaultHealthCheckTool.riskLevel, 'R1');
  assert.strictEqual(vaultStoreCredentialTool.isSimulated, false);
});

test('VAULT-02: set + get roundtrip real (criptografia transparente)', async () => {
  const secret = 'sk-test-SUPERSECRET-12345-çêdong';
  const store = await vaultManager.set(k('roundtrip'), secret, 'teste de roundtrip');
  assert.strictEqual(store.success, true);

  const got = await vaultManager.get(k('roundtrip'));
  assert.strictEqual(got.success, true);
  assert.strictEqual(got.value, secret, 'valor recuperado deve ser idêntico ao original');
  assert.strictEqual(got.description, 'teste de roundtrip');
});

test('VAULT-03: arquivo no disco NÃO contém o segredo em texto claro', async () => {
  const secret = `plaintext-leak-check-${Date.now()}`;
  await vaultManager.set(k('leakcheck'), secret);

  const vaultFile = path.join(os.homedir(), '.liora', 'security', 'vault.enc');
  assert.ok(fs.existsSync(vaultFile), 'arquivo do cofre deve existir');
  const raw = fs.readFileSync(vaultFile, 'utf8');
  assert.ok(!raw.includes(secret), 'o segredo NUNCA pode estar em texto claro no disco');
  assert.ok(raw.startsWith('LVR1|'), 'formato do cofre deve ter o magic header');
});

test('VAULT-04: list retorna apenas identificadores — nunca valores', async () => {
  const secret = `list-secret-${Date.now()}`;
  await vaultManager.set(k('listcheck'), secret);

  const keys = await vaultManager.list();
  assert.ok(Array.isArray(keys));
  const found = keys.find(e => e.key === k('listcheck'));
  assert.ok(found, 'identificador deve aparecer na listagem');
  assert.ok(!JSON.stringify(keys).includes(secret), 'listagem NUNCA pode conter o valor');

  const toolRes = await vaultListKeysTool.execute({});
  assert.strictEqual(toolRes.success, true);
  assert.ok(!JSON.stringify(toolRes).includes(secret), 'tool de listagem NUNCA pode vazar o valor');
});

test('VAULT-05: update preserva createdAt e atualiza updatedAt', async () => {
  const key = k('updatecheck');
  await vaultManager.set(key, 'v1', 'primeira');
  const first = await vaultManager.get(key);
  assert.ok(first.createdAt);

  // Pequena espera para garantir timestamp diferente
  await new Promise(r => setTimeout(r, 20));
  await vaultManager.set(key, 'v2', 'segunda');
  const second = await vaultManager.get(key);

  assert.strictEqual(second.value, 'v2');
  assert.strictEqual(second.createdAt, first.createdAt, 'createdAt preservado no update');
  assert.notStrictEqual(second.updatedAt, first.updatedAt, 'updatedAt deve mudar');
});

test('VAULT-06: get de credencial inexistente falha graciosamente', async () => {
  const res = await vaultManager.get(k('inexistente'));
  assert.strictEqual(res.success, false);
  assert.match(String(res.error), /NOT_FOUND/);

  const toolRes = await vaultGetCredentialTool.execute({ key: k('inexistente') });
  assert.strictEqual(toolRes.success, false);
  assert.match(String(toolRes.error), /NOT_FOUND/);
});

test('VAULT-07: validações de entrada da store', async () => {
  const empty = await vaultManager.set('', 'valor');
  assert.strictEqual(empty.success, false);
  assert.match(String(empty.error), /INVALID_KEY/);

  const badFormat = await vaultManager.set(k('bad key com espaço'), 'valor');
  assert.strictEqual(badFormat.success, false);
  assert.match(String(badFormat.error), /INVALID_KEY_FORMAT/);

  const noValue = await vaultManager.set(k('novalue'), '');
  assert.strictEqual(noValue.success, false);
  assert.match(String(noValue.error), /INVALID_VALUE/);

  const hugeValue = await vaultManager.set(k('huge'), 'x'.repeat(10001));
  assert.strictEqual(hugeValue.success, false);
  assert.match(String(hugeValue.error), /VALUE_TOO_LARGE/);
});

test('VAULT-08: delete remove e get subsequentes falham', async () => {
  const key = k('deletecheck');
  await vaultManager.set(key, 'para-apagar');

  const del = await vaultManager.delete(key);
  assert.strictEqual(del.success, true);

  const after = await vaultManager.get(key);
  assert.strictEqual(after.success, false);
  assert.match(String(after.error), /NOT_FOUND/);

  // Delete duplo falha graciosamente
  const del2 = await vaultManager.delete(key);
  assert.strictEqual(del2.success, false);
  assert.match(String(del2.error), /NOT_FOUND/);

  const toolRes = await vaultDeleteCredentialTool.execute({ key: k('nao-existe') });
  assert.strictEqual(toolRes.success, false);
  assert.match(String(toolRes.error), /NOT_FOUND/);
});

test('VAULT-09: integridade — tampering no disco é detectado pelo GCM', async () => {
  const vaultFile = path.join(os.homedir(), '.liora', 'security', 'vault.enc');
  const original = fs.readFileSync(vaultFile, 'utf8');

  // Corrompe um byte do ciphertext (meio do arquivo)
  const mid = Math.floor(original.length / 2);
  const corruptedChar = original[mid] === 'A' ? 'B' : 'A';
  const tampered = original.slice(0, mid) + corruptedChar + original.slice(mid + 1);
  fs.writeFileSync(vaultFile, tampered, 'utf8');

  vaultManager.resetCache();
  const health = await vaultManager.health();
  assert.strictEqual(health.ok, false, 'GCM deve detectar o tampering (auth tag mismatch)');
  assert.match(String(health.error), /VAULT_DECRYPT_FAILED|VAULT_CORRUPT/);

  // Restaura o arquivo original
  fs.writeFileSync(vaultFile, original, 'utf8');
  vaultManager.resetCache();
  const recovered = await vaultManager.health();
  assert.strictEqual(recovered.ok, true, 'cofre deve voltar a funcionar após restauração');
});

test('VAULT-10: health check da tool reporta integridade sem expor valores', async () => {
  const res = await vaultHealthCheckTool.execute({});
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.ok, true);
  assert.ok(typeof res.entries === 'number');
  assert.ok(!JSON.stringify(res).includes('sk-test'), 'health não pode vazar valores');
});

test('VAULT-11: mensagens das ferramentas nunca incluem o valor do segredo', async () => {
  const secret = `anti-leak-${Date.now()}-SENHA-MUITO-SECRETA`;
  const store = await vaultStoreCredentialTool.execute({ key: k('antileak'), value: secret, description: 'anti-leak' });
  assert.strictEqual(store.success, true);
  assert.ok(!JSON.stringify(store).includes(secret), 'resposta da store NUNCA ecoa o valor');

  // get É a exceção deliberada: entrega no campo estruturado (fluxo R2 consentido)
  const get = await vaultGetCredentialTool.execute({ key: k('antileak') });
  assert.strictEqual(get.success, true);
  assert.strictEqual(get.value, secret, 'get entrega o valor no campo estruturado');
  // Mas a mensagem (se existir) não o ecoa
  if (get.message) assert.ok(!get.message.includes(secret), 'message não deve ecoar o valor');
});

test('VAULT-12: limpeza — remove todas as credenciais de teste', async () => {
  const keys = await vaultManager.list();
  const testKeys = keys.filter(e => e.key.startsWith(PREFIX));
  for (const entry of testKeys) {
    await vaultManager.delete(entry.key);
  }
  const after = await vaultManager.list();
  assert.ok(!after.some(e => e.key.startsWith(PREFIX)), 'todas as credenciais de teste removidas');
});

test('VAULT-13: STRESS — 20 escritas CONCORRENTES não perdem nenhuma credencial', async () => {
  // BUG CRÍTICO CORRIGIDO (race condition): antes, chamadas simultâneas a set()
  // executavam load()→mutação→save() em paralelo e a última sobrescrevia as
  // anteriores — PERDA SILVOSA de credenciais (ex: salvar token de e-mail e API
  // ao mesmo tempo = um dos dois desaparecia). Agora as escritas são serializadas
  // por fila de promessas e TODAS persistem.
  const CONCURRENT = 20;
  const promises: Promise<{ success: boolean }>[] = [];
  for (let i = 0; i < CONCURRENT; i++) {
    promises.push(vaultManager.set(k(`stress_${i}`), `valor-concorrente-${i}`, `stress ${i}`));
  }
  const results = await Promise.all(promises);

  // Todas devem ter sucesso
  assert.strictEqual(results.filter(r => r.success).length, CONCURRENT, 'todas as escritas devem ter sucesso');

  // E TODAS devem estar no cofre (nenhuma perdida na corrida)
  const keys = await vaultManager.list();
  for (let i = 0; i < CONCURRENT; i++) {
    const found = keys.find(e => e.key === k(`stress_${i}`));
    assert.ok(found, `credencial stress_${i} NÃO deve ser perdida na concorrência`);
  }

  // Valores consistentes (cada chave tem o valor da sua iteração)
  for (let i = 0; i < CONCURRENT; i++) {
    const got = await vaultManager.get(k(`stress_${i}`));
    assert.strictEqual(got.value, `valor-concorrente-${i}`, `valor de stress_${i} íntegro`);
  }
});

test('VAULT-14: STRESS — set + delete intercalados não corrompem o cofre', async () => {
  // Cenário: uma ferramenta salva enquanto outra apaga (ex: UI + chat simultâneos)
  const ops: Promise<unknown>[] = [];
  for (let i = 0; i < 10; i++) {
    ops.push(vaultManager.set(k(`mixed_${i}`), `v${i}`));
    if (i % 2 === 0) ops.push(vaultManager.delete(k(`mixed_${i}`)).catch(() => undefined));
  }
  await Promise.all(ops);

  // Após a serialização: ímpares presentes, pares removidos (ou vice-versa —
  // o importante é que o arquivo JSON é válido e nenhuma entrada ficou
  // "meio escrita" corrompendo o cofre)
  const keys = await vaultManager.list();
  const health = await vaultManager.health();
  assert.strictEqual(health.ok, true, 'cofre deve permanecer íntegro após concorrência mista');

  // Cleanup
  for (const entry of keys.filter(e => e.key.startsWith(`${PREFIX}mixed_`))) {
    await vaultManager.delete(entry.key);
  }
});

test('VAULT-15: integridade após ciclo completo de stress — todos os testes limpos', async () => {
  const keys = await vaultManager.list();
  const leftovers = keys.filter(e => e.key.startsWith(PREFIX));
  for (const entry of leftovers) {
    await vaultManager.delete(entry.key);
  }
  const final = await vaultManager.health();
  assert.strictEqual(final.ok, true);
  assert.ok(!JSON.stringify(final).includes('valor-concorrente'), 'cofre limpo após stress');
});

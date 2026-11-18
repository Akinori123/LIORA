/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Testes Unitários: Resolução e Cadastro de Locais Favoritos Ilimitados
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePlaceAliasTool, savePlaceAliasTool } from '../src/tools/navigation/placeAliasTool';

test('ALIAS-01: resolve_place_alias e save_place_alias estão registradas com metadados corretos', () => {
  assert.strictEqual(resolvePlaceAliasTool.name, 'resolve_place_alias');
  assert.strictEqual(resolvePlaceAliasTool.riskLevel, 'R0');

  assert.strictEqual(savePlaceAliasTool.name, 'save_place_alias');
  assert.strictEqual(savePlaceAliasTool.riskLevel, 'R1');
});

test('ALIAS-02: resolve_place_alias valida parâmetro obrigatório', async () => {
  const res = await resolvePlaceAliasTool.execute({ alias: '' });
  assert.strictEqual(res.success, false);
  assert.ok(res.error.includes('MISSING_ALIAS'));
});

test('ALIAS-03: save_place_alias valida parâmetros ausentes', async () => {
  const res = await savePlaceAliasTool.execute({ alias: 'Clube', address: '' });
  assert.strictEqual(res.success, false);
  assert.ok(res.error.includes('MISSING_PARAMS'));
});

test('ALIAS-04: save_place_alias grava local favorito com sucesso', async () => {
  const prevEnv = process.env.LIORA_MEMORY_DIR;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liora-alias-mem-'));
  process.env.LIORA_MEMORY_DIR = tempDir;

  try {
    const res = await savePlaceAliasTool.execute({
      alias: 'Casa do Amigo',
      address: 'Rua Quaresmeira 418, Ponta Grossa'
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.alias, 'Casa do Amigo');
    assert.strictEqual(res.address, 'Rua Quaresmeira 418, Ponta Grossa');
  } finally {
    if (prevEnv === undefined) {
      delete process.env.LIORA_MEMORY_DIR;
    } else {
      process.env.LIORA_MEMORY_DIR = prevEnv;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

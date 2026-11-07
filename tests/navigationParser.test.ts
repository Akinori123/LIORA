/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNavigationIntent, normalizeNavigationText } from '../src/utils/navigationParser.js';

test('normalizeNavigationText sanitiza e remove acentos e pontuações', () => {
  assert.equal(normalizeNavigationText('  Configurações & Ajustes!  '), 'configuracoes ajustes');
  assert.equal(normalizeNavigationText('ÁÉÍÓÚ çãõ'), 'aeiou cao');
});

test('Navegação determinística por palavras isoladas e abreviações (sem prefixo)', () => {
  assert.equal(parseNavigationIntent('config')?.tab, 'settings');
  assert.equal(parseNavigationIntent('configs')?.tab, 'settings');
  assert.equal(parseNavigationIntent('ajustes')?.tab, 'settings');
  assert.equal(parseNavigationIntent('carro')?.tab, 'cockpit');
  assert.equal(parseNavigationIntent('hud')?.tab, 'cockpit');
  assert.equal(parseNavigationIntent('painel')?.tab, 'cockpit');
  assert.equal(parseNavigationIntent('dispositivos')?.tab, 'devices');
  assert.equal(parseNavigationIntent('pulo')?.tab, 'devices');
  assert.equal(parseNavigationIntent('automacoes')?.tab, 'automations');
  assert.equal(parseNavigationIntent('regras')?.tab, 'automations');
  assert.equal(parseNavigationIntent('memoria')?.tab, 'memory');
  assert.equal(parseNavigationIntent('cofre')?.tab, 'memory');
  assert.equal(parseNavigationIntent('integracoes')?.tab, 'integrations');
  assert.equal(parseNavigationIntent('mcp')?.tab, 'integrations');
  assert.equal(parseNavigationIntent('dev')?.tab, 'developer');
  assert.equal(parseNavigationIntent('git')?.tab, 'developer');
  assert.equal(parseNavigationIntent('chat')?.tab, 'conversation');
  assert.equal(parseNavigationIntent('conversa')?.tab, 'conversation');
  assert.equal(parseNavigationIntent('inicio')?.tab, 'home');
  assert.equal(parseNavigationIntent('orbe')?.tab, 'home');
  assert.equal(parseNavigationIntent('atividades')?.tab, 'activity');
});

test('Navegação com prefixos verbais e artigos em variações naturais', () => {
  assert.equal(parseNavigationIntent('abrir config')?.tab, 'settings');
  assert.equal(parseNavigationIntent('abra as configurações')?.tab, 'settings');
  assert.equal(parseNavigationIntent('vai para configurações')?.tab, 'settings');
  assert.equal(parseNavigationIntent('vai pra tela de configs')?.tab, 'settings');
  assert.equal(parseNavigationIntent('mostre o carro')?.tab, 'cockpit');
  assert.equal(parseNavigationIntent('muda para o cockpit')?.tab, 'cockpit');
  assert.equal(parseNavigationIntent('ir para dispositivos')?.tab, 'devices');
  assert.equal(parseNavigationIntent('abra a tela de automações')?.tab, 'automations');
  assert.equal(parseNavigationIntent('acessar memoria')?.tab, 'memory');
  assert.equal(parseNavigationIntent('navegue para desenvolvedor')?.tab, 'developer');
  assert.equal(parseNavigationIntent('voltar para o inicio')?.tab, 'home');
});

test('Perguntas e explicações conceituais NÃO devem navegar falsamente', () => {
  assert.equal(parseNavigationIntent('o que é configuração de rede?'), null);
  assert.equal(parseNavigationIntent('como funciona a memória ram?'), null);
  assert.equal(parseNavigationIntent('explique o painel solar'), null);
  assert.equal(parseNavigationIntent('qual a regra de automação recomendada?'), null);
});


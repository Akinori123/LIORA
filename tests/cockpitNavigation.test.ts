/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Suíte de Testes Unitários: Fluxo Híbrido de Navegação do Cockpit & Parser de Voz
 */

/**
 * CORREÇÃO ANTI-ABAS: dry-run ANTES de qualquer import — testes nunca abrem
 * navegador real (Maps/Waze) no host.
 */
process.env.LIORA_NO_BROWSER = '1';

import test from 'node:test';
import assert from 'node:assert';
import {
  formatGpsNavigationUrl,
  openGpsNavigationTool,
  formatPlacesSearchUrl,
  mapsSearchPlacesTool
} from '../src/tools/navigation/navigationActionTool';
import {
  parseRouteIntent,
  parsePlacesSearchIntent,
  parseNavigationIntent
} from '../src/utils/navigationParser';
import { nativeCalculateRouteTool } from '../src/tools/nativeServerTools';

test('NAV-01: formatGpsNavigationUrl gera URLs válidas para Google Maps e Waze', () => {
  // 1. Google Maps padrão (Origem automática por GPS)
  const gmaps = formatGpsNavigationUrl('Av. Paulista, 1000 - São Paulo', 'google_maps');
  assert.strictEqual(gmaps.provider, 'google_maps');
  assert.strictEqual(gmaps.originMode, 'current_gps');
  assert.ok(gmaps.url.startsWith('https://www.google.com/maps/dir/?api=1'));
  assert.ok(gmaps.url.includes('destination=Av.%20Paulista%2C%201000%20-%20S%C3%A3o%20Paulo'));
  assert.ok(gmaps.url.includes('travelmode=driving'));
  assert.ok(!gmaps.url.includes('origin='), 'Quando não especificada, a origem deve ser omitida para o GPS do Google Maps assumir o local atual');

  // 2. Google Maps com coordenadas numéricas de origem
  const gmapsCoords = formatGpsNavigationUrl('Aeroporto Salgado Filho', 'google_maps', {
    lat: -29.9935,
    lng: -51.1711
  });
  assert.strictEqual(gmapsCoords.originMode, 'coordinates');
  assert.ok(gmapsCoords.url.includes('origin=-29.9935,-51.1711'));
  assert.ok(gmapsCoords.url.includes('destination=Aeroporto%20Salgado%20Filho'));

  // 3. Google Maps com origem nomeada (ex: Ponta Grossa para Curitiba)
  const gmapsNamed = formatGpsNavigationUrl('Curitiba', 'google_maps', 'Ponta Grossa');
  assert.strictEqual(gmapsNamed.originMode, 'named_place');
  assert.ok(gmapsNamed.url.includes('origin=Ponta%20Grossa'));
  assert.ok(gmapsNamed.url.includes('destination=Curitiba'));

  // 4. Waze
  const waze = formatGpsNavigationUrl('Shopping Iguatemi', 'waze');
  assert.strictEqual(waze.provider, 'waze');
  assert.strictEqual(waze.originMode, 'current_gps');
  assert.ok(waze.url.startsWith('https://waze.com/ul?q='));
  assert.ok(waze.url.includes('navigate=yes'));
  assert.ok(waze.url.includes('Shopping%20Iguatemi'));
});

test('NAV-02: openGpsNavigationTool possui contrato R0, suporta origem nomeada/GPS e executa sem simulação falsa', async () => {
  assert.strictEqual(openGpsNavigationTool.name, 'open_gps_navigation');
  assert.strictEqual(openGpsNavigationTool.riskLevel, 'R0');
  assert.strictEqual(openGpsNavigationTool.isSimulated, false);

  // Execução com origem nomeada
  const resNamed = await openGpsNavigationTool.execute({
    origin: 'Ponta Grossa',
    destination: 'Curitiba',
    provider: 'waze'
  });
  assert.strictEqual(resNamed.simulated, false);
  assert.strictEqual(resNamed.provider, 'waze');
  assert.strictEqual(resNamed.destination, 'Curitiba');
  assert.strictEqual(resNamed.origin, 'Ponta Grossa');
  assert.ok(typeof resNamed.message === 'string');

  // Execução com origem automática (sem passar origem)
  const resAuto = await openGpsNavigationTool.execute({
    destination: 'Arena do Grêmio, Porto Alegre',
    provider: 'google_maps'
  });
  assert.strictEqual(resAuto.simulated, false);
  assert.strictEqual(resAuto.provider, 'google_maps');
  assert.strictEqual(resAuto.originMode, 'current_gps');
  assert.ok(resAuto.url.includes('Arena%20do%20Gr%C3%AAmio'));
  assert.ok(resAuto.message.includes('localização GPS atual'));
});

test('NAV-03: formatGpsNavigationUrl higieniza e preserva caracteres de busca veicular', () => {
  const result = formatGpsNavigationUrl('   Posto Ipiranga & Conveniência   ', 'google_maps');
  assert.ok(!result.url.includes('   '), 'Deve remover espaços em branco iniciais e finais');
  assert.ok(result.url.includes('destination=Posto%20Ipiranga%20%26%20Conveni%C3%AAncia'));
});

test('NAV-04: parseRouteIntent extrai comando por voz com Origem e Destino declarados', () => {
  // Cenário 1: "Calcula rota de Ponta Grossa para Curitiba no Waze"
  const intent1 = parseRouteIntent('Calcula rota de Ponta Grossa para Curitiba no Waze');
  assert.ok(intent1 !== null, 'Deveria reconhecer a rota');
  assert.strictEqual(intent1?.origin, 'Ponta Grossa');
  assert.strictEqual(intent1?.destination, 'Curitiba');
  assert.strictEqual(intent1?.provider, 'waze');
  assert.ok(intent1?.spokenFeedback.includes('Ponta Grossa'));
  assert.ok(intent1?.spokenFeedback.includes('Curitiba'));
  assert.ok(intent1?.spokenFeedback.includes('Waze'));

  // Variação 1B: "Traçar rota de Porto Alegre até Gramado pelo Google Maps"
  const intent2 = parseRouteIntent('Traçar rota de Porto Alegre até Gramado pelo Google Maps');
  assert.ok(intent2 !== null);
  assert.strictEqual(intent2?.origin, 'Porto Alegre');
  assert.strictEqual(intent2?.destination, 'Gramado');
  assert.strictEqual(intent2?.provider, 'google_maps');
});

test('NAV-05: parseRouteIntent extrai comando por voz sem origem (Origem Automática por GPS)', () => {
  // Cenário 2: "LIORA, navegar para o Aeroporto no Google Maps"
  const intent1 = parseRouteIntent('LIORA, navegar para o Aeroporto no Google Maps');
  assert.ok(intent1 !== null, 'Deveria reconhecer rota com wake word');
  assert.strictEqual(intent1?.origin, undefined, 'Origem deve ser indefinida para acionar GPS automático');
  assert.strictEqual(intent1?.destination, 'Aeroporto');
  assert.strictEqual(intent1?.provider, 'google_maps');
  assert.ok(intent1?.spokenFeedback.includes('localização atual'));

  // Variação 2B: "Calcular rota para Curitiba no Waze"
  const intent2 = parseRouteIntent('Calcular rota para Curitiba no Waze');
  assert.ok(intent2 !== null);
  assert.strictEqual(intent2?.origin, undefined);
  assert.strictEqual(intent2?.destination, 'Curitiba');
  assert.strictEqual(intent2?.provider, 'waze');

  // Variação 2C: "Como chegar no Shopping Iguatemi"
  const intent3 = parseRouteIntent('Como chegar no Shopping Iguatemi');
  assert.ok(intent3 !== null);
  assert.strictEqual(intent3?.origin, undefined);
  assert.strictEqual(intent3?.destination, 'Shopping Iguatemi');
  assert.strictEqual(intent3?.provider, 'auto');
});

test('NAV-06: parseRouteIntent e parseNavigationIntent não geram falsos positivos mútuos', () => {
  // Aba de configurações não deve ser confundida com rota veicular
  assert.strictEqual(parseRouteIntent('abrir configurações'), null);
  assert.strictEqual(parseRouteIntent('abrir o cockpit'), null);

  // Perguntas conceituais não devem ser interpretadas como rotas
  assert.strictEqual(parseRouteIntent('O que é uma rota de fuga?'), null);
  assert.strictEqual(parseRouteIntent('Como funciona o GPS no celular?'), null);

  // Mas comandos de troca de aba continuam funcionando perfeitamente
  const tabMatch = parseNavigationIntent('abrir configurações');
  assert.ok(tabMatch !== null);
  assert.strictEqual(tabMatch?.tab, 'settings');
});

test('NAV-07: formatPlacesSearchUrl e mapsSearchPlacesTool possuem contrato R0 e buscam no Google Maps Places', async () => {
  // 1. URL com termo e localização
  const placesUrl1 = formatPlacesSearchUrl('farmácia', 'Ponta Grossa');
  assert.ok(placesUrl1.url.startsWith('https://www.google.com/maps/search/?api=1'));
  assert.ok(placesUrl1.url.includes('query=farm%C3%A1cia%20em%20Ponta%20Grossa'));

  // 2. URL com termo relativo "daqui"
  const placesUrl2 = formatPlacesSearchUrl('mercado mais próximo', 'daqui');
  assert.ok(placesUrl2.url.includes('query=mercado%20mais%20pr%C3%B3ximo'));
  assert.ok(!placesUrl2.url.includes('daqui'), 'Termo relativo "daqui" não deve ser embutido como cidade');

  // 3. mapsSearchPlacesTool
  assert.strictEqual(mapsSearchPlacesTool.name, 'maps_search_places');
  assert.strictEqual(mapsSearchPlacesTool.riskLevel, 'R0');
  assert.strictEqual(mapsSearchPlacesTool.isSimulated, false);

  const res = await mapsSearchPlacesTool.execute({
    query: 'posto de gasolina',
    nearLocation: 'Centro'
  });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.simulated, false);
  assert.ok(res.url.includes('posto%20de%20gasolina'));
  assert.ok(res.message.includes('Google Maps'));
});

test('NAV-08: parsePlacesSearchIntent extrai intenções de busca local (mercado, farmácia, posto)', () => {
  // Caso 1: "qual o mercado mais próximo"
  const p1 = parsePlacesSearchIntent('qual o mercado mais próximo');
  assert.ok(p1 !== null, 'Deveria reconhecer busca de mercado');
  assert.strictEqual(p1?.query, 'mercado mais próximo');
  assert.strictEqual(p1?.nearLocation, undefined);
  assert.ok(p1?.spokenFeedback.includes('Google Maps'));

  // Caso 2: "farmácia mais próxima de Ponta Grossa"
  const p2 = parsePlacesSearchIntent('farmácia mais próxima de Ponta Grossa');
  assert.ok(p2 !== null);
  assert.strictEqual(p2?.query, 'farmácia mais próxima');
  assert.strictEqual(p2?.nearLocation, 'Ponta Grossa');

  // Caso 3: "posto de gasolina mais próximo"
  const p3 = parsePlacesSearchIntent('posto de gasolina mais próximo');
  assert.ok(p3 !== null);
  assert.strictEqual(p3?.query, 'posto de gasolina mais próximo');
});

test('NAV-09: parseRouteIntent resolve comandos "daqui até [cidade] quanto tempo?" sem pedir coordenadas manuais', () => {
  // Caso 1: "daqui até São Paulo quanto tempo?"
  const r1 = parseRouteIntent('daqui até São Paulo quanto tempo?');
  assert.ok(r1 !== null, 'Deveria reconhecer rota a partir do ponto atual');
  assert.strictEqual(r1?.origin, undefined, 'Origem "daqui" deve ser normalizada para GPS automático');
  assert.strictEqual(r1?.destination, 'São Paulo');
  assert.ok(r1?.spokenFeedback.includes('localização atual'));

  // Caso 2: "quanto tempo daqui até São Paulo"
  const r2 = parseRouteIntent('quanto tempo daqui até São Paulo');
  assert.ok(r2 !== null);
  assert.strictEqual(r2?.origin, undefined);
  assert.strictEqual(r2?.destination, 'São Paulo');

  // Caso 3: "rota de Ponta Grossa a São Paulo"
  const r3 = parseRouteIntent('rota de Ponta Grossa a São Paulo');
  assert.ok(r3 !== null);
  assert.strictEqual(r3?.origin, 'Ponta Grossa');
  assert.strictEqual(r3?.destination, 'São Paulo');
});

test('NAV-10: nativeCalculateRouteTool aceita destino textual sem exigir coordenadas numéricas manuais', async () => {
  const result = await nativeCalculateRouteTool.execute({
    destination: 'São Paulo'
  });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.destination, 'São Paulo');
  assert.strictEqual(result.simulated, false);
  assert.ok(result.message.includes('São Paulo'));
  assert.ok(result.url.includes('destination=S%C3%A3o%20Paulo'));
});


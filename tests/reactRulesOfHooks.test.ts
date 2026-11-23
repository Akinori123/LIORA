/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Guarda de Regras de Hooks (React).
 *
 * Regressão real: o GestureHUD tinha um `if (!isEnabled) return null` no meio do
 * corpo e hooks (useState/useEffect) DEPOIS dele. Ao ligar a câmera o React
 * quebrava com "Rendered more hooks than during the previous render" e a árvore
 * inteira caía ("An error occurred in the <GestureHUD>").
 *
 * As verificações abaixo são estruturais e específicas dos componentes críticos
 * (sem depender de um parser de TS, que não está disponível como API neste
 * projeto). O objetivo é falhar rápido se o padrão de risco voltar.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function read(rel: string): string {
  return fs.readFileSync(path.resolve(rel), 'utf8');
}

test('RULES-X1: GestureHUD declara 100% dos hooks no componente ativo, antes do JSX', () => {
  const source = read('src/components/gesture/GestureHUD.tsx');

  // O componente que usa hooks deve começar com a assinatura dedicada
  const activeIdx = source.indexOf('const GestureHudActive');
  assert.ok(activeIdx > 0, 'GestureHudActive precisa existir');
  const activeSource = source.slice(activeIdx);

  // O return de JSX do componente começa na coluna da função (2 espaços de
  // indentação) — returns de cleanup dentro de useEffect estão mais indentados.
  const jsxMatch = activeSource.match(/\n {2}return \(/);
  assert.ok(jsxMatch && jsxMatch.index !== undefined, 'GestureHudActive precisa retornar JSX no nível do componente');
  const jsxStart = jsxMatch!.index!;

  const hooksInJsx = activeSource
    .slice(jsxStart)
    .match(/\b(useState|useEffect|useRef|useMemo|useCallback|useReducer|useLayoutEffect)\s*\(/g) || [];

  assert.deepEqual(hooksInJsx, [], `Nenhum hook pode existir dentro do JSX do componente: ${hooksInJsx.join(', ')}`);
});

test('RULES-X2: GestureHUD separa o gate em um componente dedicado (remontagem limpa)', () => {
  const source = read('src/components/gesture/GestureHUD.tsx');
  // O gate cobre câmera de VISÃO e cursor por gestos: com apenas
  // gestureControlEnabled, o modo "câmera ligada para ver" nunca montava o
  // componente que inicia a captura (prévia eternamente "Sem imagem").
  assert.match(
    source,
    /if\s*\(!cameraOn\)\s*return\s+null;/,
    'GestureHUD deve conter o gate de habilitação antes de montar o componente ativo'
  );
  assert.match(
    source,
    /s\.settings\.cameraEnabled\s*\|\|\s*s\.settings\.gestureControlEnabled/,
    'O gate deve considerar a câmera de visão (cameraEnabled) e o cursor por gestos'
  );
  assert.match(
    source,
    /return\s+<GestureHudActive/,
    'GestureHUD deve delegar a UI para GestureHudActive (ordem de hooks estável sem condições)'
  );
});

test('RULES-X3: componentes-chave não chamam hooks dentro de blocos condicionais', () => {
  const files = [
    'src/components/gesture/GestureHUD.tsx',
    'src/components/GlobalVoiceBar.tsx',
    'src/components/views/HomeView.tsx',
    'src/components/views/SettingsView.tsx'
  ];
  const hookCall = /\b(useState|useEffect|useRef|useMemo|useCallback|useReducer|useLayoutEffect)\s*\(/;
  const problems: string[] = [];

  for (const rel of files) {
    const lines = read(rel).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      // Hook numa linha que não está no nível de indenização de corpo (2 espaços)
      // é forte indício de hook dentro de if/loop/callback.
      if (hookCall.test(line) && !/^\s{2}(const|let|var|return|if|use|[A-Za-z_$])/.test(line)) {
        if (!/^\s{2}\S/.test(line)) continue;
      }
      // Hook indentado a 4+ espaços sem ser continuação de uma chamada
      if (hookCall.test(line) && /^\s{4,}/.test(line) && !/^\s{2,6}(const\s+\w+\s*=\s*)?use/.test(line)) {
        const prev = (lines[i - 1] || '').trim();
        if (!prev.endsWith('=') && !prev.endsWith('(') && !prev.endsWith(',')) {
          problems.push(`${rel}:${i + 1} → ${trimmed}`);
        }
      }
    }
  }

  assert.deepEqual(problems, [], `Possível hook condicional/em callback:\n${problems.join('\n')}`);
});

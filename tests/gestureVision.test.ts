/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Testes do rastreamento de mão com CENAS SINTÉTICAS.
 * Reproduzem o sintoma real: "a mão não é reconhecida".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeFrame,
  computeForegroundThreshold,
  isSkinPixel
} from '../src/services/gestureVision';

const W = 160;
const H = 120;

function makeBackground(r: number, g: number, b: number): Float32Array {
  const bg = new Float32Array(W * H * 4);
  for (let i = 0; i < bg.length; i += 4) {
    bg[i] = r;
    bg[i + 1] = g;
    bg[i + 2] = b;
    bg[i + 3] = 255;
  }
  return bg;
}

function cloneAsFrame(bg: Float32Array): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  data.set(bg as unknown as ArrayLike<number>);
  return data;
}

/** Pinta um retângulo (a "mão") no quadro. */
function paint(
  data: Uint8ClampedArray,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  g: number,
  b: number
) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
}

test('GV-01: mão clara sobre fundo escuro é detectada e classificada como mão', () => {
  const bg = makeBackground(20, 20, 20);
  const data = cloneAsFrame(bg);
  // Mão no centro (tom de pele)
  paint(data, 60, 40, 100, 85, 200, 150, 120);

  const result = analyzeFrame({
    data,
    background: bg,
    width: W,
    height: H,
    fgThreshold: computeForegroundThreshold(bg)
  });

  assert.equal(result.isValidTarget, true, 'A mão deve ser um alvo válido');
  assert.ok(result.skinRatio >= 0.18, `skinRatio=${result.skinRatio.toFixed(2)} deveria ser mão`);
  // Centroide próximo do centro do retângulo pintado
  assert.ok(Math.abs(result.handX - 0.5) < 0.06, `handX=${result.handX.toFixed(2)}`);
  assert.ok(Math.abs(result.handY - 0.52) < 0.08, `handY=${result.handY.toFixed(2)}`);
});

test('GV-02: fundo CLARO (parede branca) não engole a mão', () => {
  const bg = makeBackground(235, 232, 228);
  const data = cloneAsFrame(bg);
  paint(data, 55, 45, 95, 90, 205, 155, 125);

  const threshold = computeForegroundThreshold(bg);
  const result = analyzeFrame({ data, background: bg, width: W, height: H, fgThreshold: threshold });

  assert.equal(result.isValidTarget, true, 'Mão sobre parede clara precisa ser detectada');
  assert.ok(result.skinRatio >= 0.18);
});

test('GV-03: cena estática (sem mão) NÃO gera falso positivo', () => {
  const bg = makeBackground(120, 118, 115);
  const data = cloneAsFrame(bg);
  // Ruído leve de sensor (±3 níveis)
  for (let i = 0; i < data.length; i += 4) {
    data[i] += (i % 3) - 1;
    data[i + 1] += ((i + 1) % 3) - 1;
    data[i + 2] += ((i + 2) % 3) - 1;
  }

  const result = analyzeFrame({
    data,
    background: bg,
    width: W,
    height: H,
    fgThreshold: computeForegroundThreshold(bg)
  });

  assert.equal(result.isValidTarget, false, 'Ruído não pode virar alvo');
});

test('GV-04: objeto escuro na mão é rastreado como objeto (não como pele)', () => {
  const bg = makeBackground(60, 60, 65);
  const data = cloneAsFrame(bg);
  paint(data, 50, 30, 90, 80, 30, 30, 30);

  const result = analyzeFrame({
    data,
    background: bg,
    width: W,
    height: H,
    fgThreshold: computeForegroundThreshold(bg)
  });

  assert.equal(result.isValidTarget, true);
  assert.ok(result.skinRatio < 0.18, `skinRatio=${result.skinRatio.toFixed(2)} deveria ser objeto`);
});

test('GV-05: limiar adaptativo cresce com a luz e nunca sai da faixa segura', () => {
  assert.ok(computeForegroundThreshold(makeBackground(0, 0, 0)) >= 8, 'Sempre há piso técnico');
  assert.ok(computeForegroundThreshold(makeBackground(255, 255, 255)) <= 26, 'Nunca acima do teto');
  const dark = computeForegroundThreshold(makeBackground(10, 10, 10));
  const bright = computeForegroundThreshold(makeBackground(240, 240, 240));
  assert.ok(bright > dark, 'Ambiente claro deve exigir mais contraste');
});

test('GV-06: peça laranja/vermelha saturada não é confundida com pele', () => {
  assert.equal(isSkinPixel(250, 60, 20), false, 'Laranja saturado não é pele');
  assert.equal(isSkinPixel(205, 160, 135), true, 'Tom de pele comum é pele');
});
test('GV-07: fundo não degenera após muitos frames (mão continua detectada)', () => {
  // Regressão real: a adaptação do fundo escrevia em índices errados e o alfa
  // era suavizado junto com os canais de cor — após ~2s o fundo ficava ~0 e
  // TODOS os pixels pareciam iguais ao fundo (fgPixels = 0 => "SEM MÃO").
  const bg = makeBackground(70, 70, 75);
  const scene = () => {
    const data = cloneAsFrame(bg);
    paint(data, 60, 45, 100, 80, 205, 160, 135);
    return data;
  };

  let detectedAtStart = false;
  let detectedAfter300 = false;

  for (let frame = 0; frame < 300; frame++) {
    const result = analyzeFrame({
      data: scene(),
      background: bg,
      width: W,
      height: H,
      fgThreshold: computeForegroundThreshold(bg)
    });
    if (frame === 0) detectedAtStart = result.isValidTarget;
    if (frame === 299) detectedAfter300 = result.isValidTarget;
  }

  // O fundo aprendido precisa continuar próximo do original (não zerar)
  const cornerLuma = bg[0] * 0.299 + bg[1] * 0.587 + bg[2] * 0.114;
  assert.ok(cornerLuma > 40, `Fundo degenerou: luminância no canto = ${cornerLuma.toFixed(1)}`);
  assert.equal(bg[3], 255, 'O canal alfa do fundo deve permanecer 255');
  assert.equal(detectedAtStart, true);
  assert.equal(detectedAfter300, true, 'A mão precisa continuar detectada após 300 frames');
});

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Regressões da auditoria de CÂMERA / CURSOR POR GESTOS.
 *
 * Cada teste reproduz um sintoma real observado na UI:
 *  - modo "só visão" (câmera ligada, cursor desligado) nunca abria a câmera;
 *  - cursor visual oculto / HUD desmontada mantinha o serviço clicando às cegas;
 *  - punho fechado rolava a tela ("pulo" ao clicar);
 *  - eixo X invertido nunca chegava ao vídeo da prévia (oscilava invertido);
 *  - toggle "Rastreamento de Objetos" não tinha efeito nenhum.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gestureService } from '../src/services/gestureService';

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf-8');

test('GES-AUD-01: GestureHUD monta também no modo "só visão" (cameraEnabled sem gesto)', () => {
  const source = read('src/components/gesture/GestureHUD.tsx');
  assert.match(
    source,
    /s\.settings\.cameraEnabled\s*\|\|\s*s\.settings\.gestureControlEnabled/,
    'O gate do HUD deve considerar cameraEnabled — senão nenhum componente abre a câmera de visão'
  );
  // e o gate antigo (somente gesto) não pode voltar
  assert.doesNotMatch(
    source,
    /if\s*\(!settingsObj\.gestureControlEnabled\)\s*return\s+null;/,
    'Gate antigo (apenas gesto) reintroduziria o bug de "Sem imagem"'
  );
});

test('GES-AUD-02: Cursor por gestos não fica órfão quando o HUD desmonta', () => {
  const source = read('src/components/gesture/GestureHUD.tsx');
  assert.match(
    source,
    /return \(\) => \{\s*gestureService\.setCursorControlEnabled\(false\);\s*\};/,
    'O efeito de sincronização deve desligar o cursor no unmount'
  );
});

test('GES-AUD-03: setCursorControlEnabled desliga gestos pendentes e ressincroniza o scroll', () => {
  gestureService.setCursorControlEnabled(true);
  assert.equal(gestureService.getCursorControlEnabled(), true);
  gestureService.setCursorControlEnabled(false);
  assert.equal(gestureService.getCursorControlEnabled(), false);
  const state = gestureService.getState();
  assert.equal(state.activeGesture, 'none');
});

test('GES-AUD-04: Rastreamento de objetos tem efeito real no serviço', () => {
  gestureService.setObjectTrackingEnabled(false);
  assert.equal(gestureService.isObjectTrackingEnabled(), false);
  gestureService.setObjectTrackingEnabled(true);
  assert.equal(gestureService.isObjectTrackingEnabled(), true);

  const service = read('src/services/gestureService.ts');
  assert.match(service, /!this\.objectTrackingEnabled/, 'O laço de visão precisa ler a flag');
  const hud = read('src/components/gesture/GestureHUD.tsx');
  assert.match(hud, /setObjectTrackingEnabled\(settings\.gestureObjectTracking\)/);
});

test('GES-AUD-05: Rolagem só ocorre com a mão aberta (punho não rola a tela)', () => {
  const service = read('src/services/gestureService.ts');
  assert.match(
    service,
    /\} else if \(isOpenHand\) \{\s*\/\/ Rolagem suave/,
    'dispatchScrollAction deve estar condicionado a isOpenHand'
  );
  assert.doesNotMatch(service, /\} else if \(!isFist\) \{\s*\/\/ Rolagem suave/);
});

test('GES-AUD-06: Eixo X configurado é o MESMO no vídeo da prévia e no cursor', () => {
  const preview = read('src/components/gesture/CameraPreview.tsx');
  assert.match(
    preview,
    /transform:\s*gestureState\.invertX \? 'scaleX\(-1\)' : 'none'/,
    'O vídeo deve ser espelhado apenas quando invertX está ativo'
  );
  assert.match(
    preview,
    /left: `\$\{Math\.max\(2, Math\.min\(94, gestureState\.boundingBox\.minX \* 100\)\)\}%`/,
    'O bounding box não deve inverter o X de novo'
  );

  const manager = read('src/services/settingsManager.ts');
  assert.match(manager, /gestureInvertX:\s*true/, 'Padrão deve ser espelho (webcam frontal)');
});

test('GES-AUD-07: botão da câmera da Home tem trava contra duplo clique (não liga/desliga)', () => {
  const home = read('src/components/views/HomeView.tsx');
  assert.match(home, /const \[isCameraBusy, setIsCameraBusy\] = useState\(false\)/);
  assert.match(home, /disabled=\{isCameraBusy\}/);
  assert.match(home, /if \(isCameraBusy\) return;/);
});

test('GES-AUD-08: serviço de gestos é registrável fora do navegador (globalThis)', () => {
  const service = read('src/services/gestureService.ts');
  assert.match(
    service,
    /Object\.defineProperty\(globalThis, '__LIORA_GESTURE__'/,
    'O serviço deve ser publicado em globalThis (também no backend/Node)'
  );
  assert.doesNotMatch(
    service,
    /export const gestureService = new GestureService\(\);[\s\S]*export const gestureService = new GestureService\(\);/,
    'Declaração duplicada de gestureService quebra o módulo em runtime (SyntaxError)'
  );
  assert.ok((globalThis as any).__LIORA_GESTURE__ === gestureService);
});

/* ── Visão: centroide da mão quando o fundo absorveu a pele ─────────────── */
const W = 160;
const H = 120;

test('GES-VIS-01: centroide usa a pele ABSOLUTA quando o fundo absorveu a mão', async () => {
  const { analyzeFrame } = await import('../src/services/gestureVision');
  const data = new Uint8ClampedArray(W * H * 4);
  // fundo azul escuro em todo o quadro
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 30; data[i + 1] = 60; data[i + 2] = 90; data[i + 3] = 255;
  }
  // mão (tom de pele) à DIREITA: x 110..140, y 40..80
  for (let y = 40; y < 80; y++) {
    for (let x = 110; x < 140; x++) {
      const i = (y * W + x) * 4;
      data[i] = 224; data[i + 1] = 176; data[i + 2] = 144;
    }
  }
  // fundo aprendido == EXATAMENTE o quadro (a mão foi absorvida pelo modelo)
  const background = new Float32Array(data as unknown as ArrayLike<number>);

  const result = analyzeFrame({ data, background, width: W, height: H, fgThreshold: 14, freezeBackground: true });
  assert.equal(result.skinDetected, true, 'a pele deve ser detectada');
  assert.ok(result.isValidTarget, 'o alvo deve ser válido');
  assert.ok(
    result.handX > 0.6 && result.handX < 0.95,
    `centroide deve acompanhar a mão à direita (>0.6 e <0.95), recebido ${result.handX.toFixed(3)}`
  );
  assert.ok(
    result.handY > 0.25 && result.handY < 0.75,
    `centroide Y deve ser o da mão (${result.handY.toFixed(3)})`
  );
});

test('GES-AUD-09: diagnóstico de boot NUNCA sobrescreve um singleton já vivo', () => {
  const source = read('src/services/gestureDiagnostics.ts');
  assert.match(source, /const existingIsLive =/, 'deve checar instância existente');
  assert.match(source, /if \(existingIsLive\) return;/, 'não pode substituir o serviço usado pela UI');
  // e o diagnóstico só pode ser agendado DEPOIS do render
  const main = read('src/main.tsx');
  assert.match(main, /render\(<App \/>\)[\s\S]*scheduleGestureDiagnostics\(\);/);
});

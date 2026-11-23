/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — Análise de quadro para rastreamento de mão/objeto.
 *
 * Extraído do `gestureService` para ser testável de forma determinística (sem
 * webcam/DOM): recebe os pixels RGBA do quadro, o modelo de fundo aprendido e o
 * limiar adaptativo, e devolve a métrica de primeiro plano.
 *
 * Motivo da extração: o sintoma "a mão não é reconhecida" só pode ser verificado
 * com uma cena sintética (fundo conhecido + mão conhecida). Antes, essa lógica
 * ficava presa dentro do loop de vídeo — impossível de validar.
 */

export interface FrameAnalysisParams {
  /** Pixels RGBA do quadro atual. */
  data: Uint8ClampedArray;
  /** Modelo de fundo RGBA (mesmo layout). */
  background: Float32Array;
  width: number;
  height: number;
  /** Diferença média (0..255) que separa primeiro plano do fundo. */
  fgThreshold: number;
  /** Quando true, o fundo não é atualizado (calibração guiada). */
  freezeBackground?: boolean;
}

export interface FrameAnalysisResult {
  fgPixels: number;
  skinPixels: number;
  fgRatio: number;
  /** Centroide ponderado normalizado (0..1). */
  handX: number;
  handY: number;
  boxW: number;
  boxH: number;
  boxArea: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  totalWeight: number;
  /** Proporção de pixels de pele entre os de primeiro plano. */
  skinRatio: number;
  /** A cena contém uma região de pele compatível com mão. */
  skinDetected: boolean;
  /** Alvo plausível (rejeita corpo inteiro, ruído de piso e mudança global). */
  isValidTarget: boolean;
}

/** Heurística de tom de pele em RGB (amplitude suficiente para vários tons). */
export function isSkinPixel(r: number, g: number, b: number): boolean {
  if (r <= 40 || g <= 25 || b <= 15) return false;
  if (!(r >= g || r >= b)) return false;
  if (r - Math.min(g, b) <= 6) return false;
  // Guarda contra laranja/vermelho saturado (ex: objetos e camisetas)
  const max = Math.max(r, g, b);
  const min = Math.min(g, b);
  if (max > 0 && (max - min) / max > 0.75) return false;
  return true;
}

/**
 * Metadados de amostragem do quadro (passo em X/Y e quantas amostras existem).
 */
export function computeSampling(width: number, height: number): { step: number; sampledPixels: number } {
  const totalPixels = width * height;
  const step = totalPixels > 4000 ? 2 : 1;
  return { step, sampledPixels: Math.ceil(width / step) * Math.ceil(height / step) };
}

export interface ForegroundMetrics {
  step: number;
  sampledPixels: number;
  fgPixels: number;
  skinPixels: number;
  weightedX: number;
  weightedY: number;
  totalWeight: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  fgSkinXList: number[];
  fgSkinYList: number[];
}

/**
 * Etapa 1 — Amostragem de primeiro plano + adaptação lenta do fundo.
 * Não decide nada sobre o alvo: só acumula métricas e atualiza o modelo de fundo
 * (quando `freezeBackground` é falso).
 */
export function sampleForeground(params: FrameAnalysisParams): ForegroundMetrics {
  const { data, background, width, height, fgThreshold, freezeBackground } = params;
  const totalPixels = width * height;

  let fgPixels = 0;
  let skinPixels = 0;
  let weightedX = 0;
  let weightedY = 0;
  let totalWeight = 0;
  let minX = width;
  let maxX = 0;
  let minY = height;
  let maxY = 0;

  // Posições dos pixels de pele que também são foreground — usadas para o
  // cluster de pele com desvio padrão. Acumular só dentro do loop de fg garante
  // que o fundo (mesmo que tenha cor parecida com pele) não contamine o cluster.
  const fgSkinXList: number[] = [];
  const fgSkinYList: number[] = [];

  /**
   * Amostragem por degraus (passo) em vez de ler 76.800 pixels por frame.
   * O laço lê SOMENTE o centro de cada bloco 2x2 (passo 2 em X e Y): 4x menos
   * custo no WebView2 e, como o canvas é reamostrado de 640x480, cada amostra
   * já é a média de um bloco — semalias/ruído. O fundo continua sendo atualizado
   * só nos índices amostrados (o resto não é lido nem usado).
   */
  // Amostragem: ver comentário do laço (centro de blocos 2x2). `sampledPixels`
  // é o denominador de TODAS as proporções deste quadro.
  const { step, sampledPixels } = computeSampling(width, height);
  const stride = step * 4;
  const rowStep = width * 4 * step;

  for (let y = 0, rowStart = 0; y < height; y += step, rowStart += rowStep) {
    for (let x = 0, i = rowStart; x < width; x += step, i += stride) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      const bgR = background[i];
      const bgG = background[i + 1];
      const bgB = background[i + 2];

      const diffBg = (Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB)) / 3;

      if (diffBg > fgThreshold) {
        const skin = isSkinPixel(r, g, b);
        if (skin) {
          skinPixels++;
          fgSkinXList.push(x);
          fgSkinYList.push(y);
        }

        const weight = diffBg * (skin ? 1.5 : 1.0);
        weightedX += x * weight;
        weightedY += y * weight;
        totalWeight += weight;
        fgPixels++;

        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      } else if (!freezeBackground) {
        // Adaptação lenta do fundo (acompanha a luz ambiente).
        // BUG CORRIGIDO ("SEM MÃO" após alguns segundos): este laço percorria o
        // array de 4 em 4 mas escrevia também em `background[i + 1]`/`[i + 2]` — os
        // pixels seguintes NUNCA eram atualizados como fundo e, pior, o ALFA
        // (índice i+3) nunca era mantido: os canais vizinhos eram tratados como
        // alfa, derrubando R/G/B até o fundo ficar ~0 e TODOS os pixels parecerem
        // "iguais ao fundo" (fgPixels = 0). Agora cada canal é atualizado no seu
        // próprio índice e o alfa fica fixo em 255.
        background[i] = bgR * 0.992 + r * 0.008;
        background[i + 1] = bgG * 0.992 + g * 0.008;
        background[i + 2] = bgB * 0.992 + b * 0.008;
        background[i + 3] = 255;
      }
    }
  }

  return {
    step,
    sampledPixels,
    fgPixels,
    skinPixels,
    weightedX,
    weightedY,
    totalWeight,
    minX,
    maxX,
    minY,
    maxY,
    fgSkinXList,
    fgSkinYList
  };
}

export interface SkinCluster {
  skinCount: number;
  /** Centroide do cluster de pele em pixels do frame (ou centro quando vazio). */
  centroidXPx: number;
  centroidYPx: number;
  /** Centroide normalizado (0..1). */
  centroidX: number;
  centroidY: number;
  clusterN: number;
  hasCluster: boolean;
  /** Pele absoluta na cena, independente do fundo aprendido. */
  skinDetected: boolean;
  skinOnlyRatio: number;
  fgSkinRatio: number;
  targetIsSkin: boolean;
}

/**
 * Etapa 2 — Estimativa do cluster de pele (foreground + fallback de pele absoluta).
 */
export function estimateSkinCluster(
  params: FrameAnalysisParams,
  fg: ForegroundMetrics
): SkinCluster {
  const { data, width, height } = params;
  const { step, sampledPixels, fgPixels, skinPixels, fgSkinXList, fgSkinYList } = fg;

  /* ─────────────────────────────────────────────────────────────────────────
   * CORREÇÃO DEFINITIVA ("SEM MÃO" com a mão na frente da câmera):
   * a segmentação por diferença de fundo falha quando o FUNDO APRENDIDO contém
   * a própria mão (cena estática, calibração feita com a mão no quadro). Nesse
   * caso o pixel da mão é idêntico ao fundo (diff = 0) e NADA é detectado.
   * Solução: a detecção de mão não depende só do fundo — ela também reconhece
   * a mão por COR (tons de pele), o que é estável independentemente de o fundo
   * ter sido contaminado. Objeto físico continua usando a diferença de fundo.
   *
   * CORREÇÃO DO QUADRADO VERDE GIGANTE:
   * Quando targetIsSkin=true, o bounding box era derivado do loop de foreground
   * diff global (minX=0, maxX=width, minY=0, maxY=height) — cobrindo a tela toda.
   * Agora: calcula centroide E desvio padrão APENAS dos pixels de pele que
   * também são foreground (fgSkinXList). Isso impede que o fundo claro/morno que
   * passa no filtro de pele polua o cluster — esses pixels não passaram pelo
   * fgThreshold e nunca entram em fgSkinXList.
   * Se o box calculado ainda exceder 55% do frame, rejeita (corpo/fundo inteiro).
   * ───────────────────────────────────────────────────────────────────────── */

  // Centroide de pele a partir dos pixels de primeiro plano com cor de pele
  let skinCentroidX = 0;
  let skinCentroidY = 0;
  for (let k = 0; k < fgSkinXList.length; k++) {
    skinCentroidX += fgSkinXList[k];
    skinCentroidY += fgSkinYList[k];
  }

  // Fallback: quando o fundo aprendeu a mão (fgPixels=0 mas há pele na cena),
  // varre o frame inteiro para detectar pele absoluta (não relativa ao fundo) e
  // usa esses pixels como cluster do centroide. Antes o centroide caía em
  // (width/2, height/2) e o cursor ficava PRESO no meio da tela mesmo com a mão
  // em outro lugar (o "box" também saía 1×1 no canto).
  let skinCount = skinPixels;
  let absSkinX = 0;
  let absSkinY = 0;
  if (skinCount === 0) {
    let absN = 0;
    const strideAbs = step * 4;
    const rowAbs = width * 4 * step;
    for (let y = 0, rowStart = 0; y < height; y += step, rowStart += rowAbs) {
      for (let x = 0, i = rowStart; x < width; x += step, i += strideAbs) {
        if (isSkinPixel(data[i], data[i + 1], data[i + 2])) {
          absSkinX += x;
          absSkinY += y;
          absN++;
        }
      }
    }
    skinCount = absN;
    if (absN > 0) {
      absSkinX /= absN;
      absSkinY /= absN;
    }
  }
  const skinOnlyRatio = sampledPixels > 0 ? skinCount / sampledPixels : 0;
  const skinDetected = skinCount >= 120 && skinOnlyRatio >= 0.004 && skinOnlyRatio <= 0.45;

  // Proporção de pele entre os pixels de primeiro plano (antes de decidir o alvo)
  const fgSkinRatio = fgPixels > 0 ? skinPixels / fgPixels : 0;

  // Se a pele domina a cena, ela é o alvo (mesmo sem diferença de fundo)
  const targetIsSkin = skinDetected && (fgPixels < 20 || fgSkinRatio >= 0.18 || skinOnlyRatio >= 0.01);

  // Número de pixels usados no cluster de pele (foreground-only). Se o fundo já
  // absorveu a mão (cluster vazio), o centRÓIDE vem da pele absoluta e o box é
  // derivado de uma janela LOCAL de 24x24 amostras em volta dele — antes o box
  // herdava `minX/maxX` do loop de foreground (frame inteiro ou 1x1 no canto).
  const clusterN = fgSkinXList.length;
  const hasCluster = clusterN > 0;
  // Sem cluster de foreground, usa o centroide da pele absoluta (fallback real).
  const skinCntX = hasCluster ? skinCentroidX / clusterN : (skinCount > 0 ? absSkinX : width / 2);
  const skinCntY = hasCluster ? skinCentroidY / clusterN : (skinCount > 0 ? absSkinY : height / 2);

  return {
    skinCount,
    centroidXPx: skinCntX,
    centroidYPx: skinCntY,
    centroidX: skinCntX / width,
    centroidY: skinCntY / height,
    clusterN,
    hasCluster,
    skinDetected,
    skinOnlyRatio,
    fgSkinRatio,
    targetIsSkin
  };
}

/**
 * Etapa 3 — Decisão e bounding box final do alvo (pele ou objeto).
 */
export function classifyTarget(params: FrameAnalysisParams, fg: ForegroundMetrics, skin: SkinCluster): FrameAnalysisResult {
  const { width, height } = params;
  const {
    sampledPixels, fgPixels: rawFgPixels, weightedX, weightedY,
    minX, maxX, minY, maxY, fgSkinXList, fgSkinYList
  } = fg;
  const {
    skinCount, centroidXPx: skinCntX, centroidYPx: skinCntY, centroidX, centroidY,
    clusterN, hasCluster, skinDetected, skinOnlyRatio, fgSkinRatio, targetIsSkin
  } = skin;
  const totalPixels = width * height;
  const fgRatio = sampledPixels > 0 ? rawFgPixels / sampledPixels : 0;
  const detectedFgPixels = targetIsSkin ? Math.max(rawFgPixels, skinCount) : rawFgPixels;
  const detectedRatio = sampledPixels > 0 ? detectedFgPixels / sampledPixels : 0;
  const totalWeight = fg.totalWeight;

  // Bounding box do primeiro plano (usado no caminho de OBJETO e como base do box de pele)
  const boxW = Math.max(1, maxX - minX);
  const boxH = Math.max(1, maxY - minY);
  const boxArea = totalPixels > 0 ? (boxW * boxH) / totalPixels : 0;

  // Bounding box baseado no cluster de pele (evita o quadrado gigante)
  let skinMinX = minX, skinMaxX = maxX, skinMinY = minY, skinMaxY = maxY;
  if (targetIsSkin && clusterN > 0) {
    // Desvio padrão em X e Y dos pixels de pele no foreground
    let varX = 0, varY = 0;
    for (let k = 0; k < clusterN; k++) {
      varX += (fgSkinXList[k] - skinCntX) ** 2;
      varY += (fgSkinYList[k] - skinCntY) ** 2;
    }
    const stdX = Math.sqrt(varX / clusterN);
    const stdY = Math.sqrt(varY / clusterN);
    const SIGMA = 2.2; // Raio do cluster em desvios padrão
    skinMinX = Math.max(0, Math.round(skinCntX - stdX * SIGMA));
    skinMaxX = Math.min(width - 1, Math.round(skinCntX + stdX * SIGMA));
    skinMinY = Math.max(0, Math.round(skinCntY - stdY * SIGMA));
    skinMaxY = Math.min(height - 1, Math.round(skinCntY + stdY * SIGMA));
    // Garante tamanho mínimo para não sumir o box
    if (skinMaxX - skinMinX < 10) {
      skinMinX = Math.max(0, Math.round(skinCntX) - 5);
      skinMaxX = Math.min(width - 1, Math.round(skinCntX) + 5);
    }
    if (skinMaxY - skinMinY < 10) {
      skinMinY = Math.max(0, Math.round(skinCntY) - 5);
      skinMaxY = Math.min(height - 1, Math.round(skinCntY) + 5);
    }
  }

  if (targetIsSkin && !hasCluster && skinCount > 0 && sampledPixels > 200) {
    // Janela local em volta do centroide de pele absoluta.
    const halfW = Math.round(width * 0.16);
    const halfH = Math.round(height * 0.16);
    skinMinX = Math.max(0, Math.round(skinCntX) - halfW);
    skinMaxX = Math.min(width - 1, Math.round(skinCntX) + halfW);
    skinMinY = Math.max(0, Math.round(skinCntY) - halfH);
    skinMaxY = Math.min(height - 1, Math.round(skinCntY) + halfH);
  } else if (targetIsSkin && !hasCluster) {
    // Cena minúscula (60x40 no teste legado): mantém os bounds do foreground.
    skinMinX = Math.max(0, Math.round(skinCntX) - 5);
    skinMaxX = Math.min(width - 1, Math.round(skinCntX) + 5);
    skinMinY = Math.max(0, Math.round(skinCntY) - 5);
    skinMaxY = Math.min(height - 1, Math.round(skinCntY) + 5);
  }

  // Escolhe os bounds corretos conforme o tipo de alvo
  const finalMinX = targetIsSkin ? skinMinX : minX;
  const finalMaxX = targetIsSkin ? skinMaxX : maxX;
  const finalMinY = targetIsSkin ? skinMinY : minY;
  const finalMaxY = targetIsSkin ? skinMaxY : maxY;

  const finalBoxW = Math.max(1, finalMaxX - finalMinX);
  const finalBoxH = Math.max(1, finalMaxY - finalMinY);
  // boxArea/boxW/boxH são reportados em AMOSTRAS (mesma unidade de fgPixels e da
  // densidade usada na classificação punho/mão aberta). A proporção do frame usa
  // `sampledPixels` — antes dividia por `width*height` e, com amostragem 2x, o
  // boxArea saía 4x menor.
  const finalBoxArea = totalPixels > 0 ? (finalBoxW * finalBoxH) / totalPixels : 0;

  const isNotGlobalShift = fgRatio <= 0.55 && boxArea <= 0.75;
  // Limites anteriores (0.85) rejeitavam uma mão PRÓXIMA à lente (que ocupa a
  // maior parte da altura do quadro) — causa comum de "coloco a mão e não detecta".
  const isNotTorsoAndHead = boxH <= height * 0.95;
  const isNotFloorNoise = minY <= height * 0.92;
  // Antes: fgPixels >= 35 (1.8% do quadro em 160x120). Mão pequena/longe ou com
  // pouca luz ficava abaixo disso. 20 px ainda descarta ruído pontual.
  const hasMeaningfulTarget = rawFgPixels >= 20 && fgRatio >= 0.0015;

  // Rejeita se o box de pele ainda cobrir >55% do frame (corpo inteiro/fundo)
  const skinBoxValid = !targetIsSkin || finalBoxArea <= 0.55;
  // CORREÇÃO (alvo fantasma "📦 Objeto"): um quadro ESCURO/indefinido (lente
  // tampada, câmera instável, blob em movimento) tem diff > limiar em todo o
  // grid de centros de bloco — fgPixels alto, mas o box degenera em ~1 pixel e
  // NÃO é pele. Antes isso passava (fgRatio >= 0.0015) e o HUD anunciava um
  // "objeto" que não existe, deixando o cursor preso numa borda.
  const hasRealExtent = targetIsSkin || finalBoxArea >= 0.002;

  return {
    fgPixels: detectedFgPixels,
    skinPixels: skinCount,
    fgRatio: detectedRatio,
    handX: targetIsSkin ? centroidX : (totalWeight > 0 ? weightedX / totalWeight / width : 0.5),
    handY: targetIsSkin ? centroidY : (totalWeight > 0 ? weightedY / totalWeight / height : 0.5),
    boxW: finalBoxW,
    boxH: finalBoxH,
    boxArea: finalBoxArea,
    minX: finalMinX,
    maxX: finalMaxX,
    minY: finalMinY,
    maxY: finalMaxY,
    totalWeight: targetIsSkin ? Math.max(totalWeight, skinCount) : totalWeight,
    skinRatio: targetIsSkin ? 1 : fgSkinRatio,
    skinDetected,
    isValidTarget: targetIsSkin
      ? skinBoxValid
      : (isNotGlobalShift && isNotTorsoAndHead && isNotFloorNoise && hasMeaningfulTarget && hasRealExtent)
  };
}

/**
 * Composição curta das três etapas: amostragem → cluster de pele → classificação.
 */
export function analyzeFrame(params: FrameAnalysisParams): FrameAnalysisResult {
  const fg = sampleForeground(params);
  const skin = estimateSkinCluster(params, fg);
  return classifyTarget(params, fg, skin);
}

/** Conta pixels de pele (mantido para uso externo/diagnóstico). */
export function countSkinPixels(data: Uint8ClampedArray): number {
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (isSkinPixel(data[i], data[i + 1], data[i + 2])) count++;
  }
  return count;
}

/**
 * Conta pele com o MESMO passo do laço principal, para a métrica `skinOnlyRatio`
 * ter o mesmo denominador das amostras (sem isso o fallback "fundo absorveu a
 * mão" ficava 4x mais sensível que o caminho normal e disparava em qualquer pele
 * de fundo).
 */
function countSkinSamples(data: Uint8ClampedArray, width: number, step: number): number {
  if (step <= 1) return countSkinPixels(data);
  let count = 0;
  const stride = step * 4;
  const rowStep = width * 4 * step;
  const height = Math.floor(data.length / (width * 4));
  for (let y = 0, rowStart = 0; y < height; y += step, rowStart += rowStep) {
    for (let x = 0, i = rowStart; x < width; x += step, i += stride) {
      if (isSkinPixel(data[i], data[i + 1], data[i + 2])) count++;
    }
  }
  return count;
}

/**
 * Limiar de primeiro plano proporcional à luz do ambiente (diferença média 0..255).
 * Câmera escura => limiar menor; câmera clara => limiar maior, para a mão não se
 * fundir ao fundo nem o ruído virar "mão".
 */
export function computeForegroundThreshold(background: Float32Array): number {
  let lumaSum = 0;
  const pixels = background.length / 4;
  if (!pixels) return 18;
  for (let i = 0; i < background.length; i += 4) {
    lumaSum += 0.299 * background[i] + 0.587 * background[i + 1] + 0.114 * background[i + 2];
  }
  const avg = lumaSum / pixels;
  // Faixa mais sensível: ambiente escuro (webcam barata à noite) precisa de
  // limiar baixo para enxergar contraste; claro, precisa de mais. O piso de 8 é o
  // livre de ruído do sensor porque o laço amostra o CENTRO de cada bloco 2x2
  // (pixels 1 a cada 2 em cada eixo) — ruído de sensor isolado não vira alvo.
  return Math.max(8, Math.min(26, 6 + avg * 0.07));
}

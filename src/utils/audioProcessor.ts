/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — Processamento de áudio do microfone com AudioWorklet.
 *
 * Causa raiz tratada: `ScriptProcessorNode` está DEPRECIADO (o console do
 * WebView2/Chromium emite "The ScriptProcessorNode is deprecated. Use
 * AudioWorkletNode instead"). O AudioWorklet roda em uma thread de áudio
 * dedicada, então também elimina o jank da thread principal durante a escuta.
 *
 * Estratégia sem risco: cria o worklet a partir de um Blob (nenhum arquivo
 * adicional no build); se o ambiente não suportar (`audioWorklet` ausente,
 * registro lança, CSP/WebView restrito), cai transparentemente para o
 * `ScriptProcessorNode` clássico — mesmo contrato de callback, mesmo tamanho
 * de bloco, portanto o pipeline de envio não muda uma linha.
 */

export interface AudioChunkProcessor {
  /** Nó a ser conectado à fonte de microfone. */
  connect(source: AudioNode): void;
  /** Nó de saída (deve ser ligado a um gain 0 → destination para o worklet pulsar). */
  readonly output: AudioNode;
  /** Desconecta e libera recursos (worklet port / processor). */
  dispose(): void;
  /** `true` quando está usando AudioWorklet (sem depreciação). */
  readonly usingWorklet: boolean;
}

const WORKLET_PROCESSOR_NAME = 'liora-mic-tap';
const WORKLET_SOURCE = `
class LioraMicTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const size = (options && options.processorOptions && options.processorOptions.frameSize) || 2048;
    this.frameSize = size;
    this.buffer = new Float32Array(size);
    this.offset = 0;
  }
  process(inputs) {
    const input = inputs && inputs[0] && inputs[0][0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      this.buffer[this.offset++] = input[i];
      if (this.offset >= this.frameSize) {
        const frame = this.buffer.slice(0);
        this.offset = 0;
        this.port.postMessage(frame, [frame.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('${WORKLET_PROCESSOR_NAME}', LioraMicTap);
`;

let workletUrl: string | null = null;

/**
 * Cria o processador de áudio do microfone entregando blocos de `frameSize`
 * amostras ao callback, com a menor latência possível e sem depreciação.
 */
export async function createAudioChunkProcessor(
  ctx: AudioContext,
  frameSize: number,
  onChunk: (data: Float32Array) => void
): Promise<AudioChunkProcessor> {
  // 1. Caminho moderno: AudioWorklet (carga única por página)
  try {
    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      let registered = (ctx as any).__lioraWorkletRegistered === true;
      if (!registered) {
        if (!workletUrl && typeof Blob !== 'undefined' && typeof URL !== 'undefined') {
          workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
        }
        if (workletUrl) {
          await ctx.audioWorklet.addModule(workletUrl);
          (ctx as any).__lioraWorkletRegistered = true;
          registered = true;
        }
      }

      if (registered) {
        const node = new AudioWorkletNode(ctx, WORKLET_PROCESSOR_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
          channelCountMode: 'explicit',
          processorOptions: { frameSize }
        });
        node.port.onmessage = (event: MessageEvent) => {
          const data = event.data;
          if (data instanceof Float32Array) {
            onChunk(data);
          }
        };

        return {
          usingWorklet: true,
          output: node,
          connect(source: AudioNode) {
            source.connect(node);
          },
          dispose() {
            try { node.port.onmessage = null; } catch { }
            try { node.disconnect(); } catch { }
          }
        };
      }
    }
  } catch (err) {
    console.info('[AudioWorklet] Indisponível, usando ScriptProcessor (fallback):', (err as any)?.message || err);
  }

  // 2. Fallback legado: ScriptProcessorNode (mantém o pipeline funcionando em
  //    WebViews antigos/sem AudioWorklet). O aviso de depreciação é esperado aqui.
  const processor = ctx.createScriptProcessor(frameSize, 1, 1);
  const sink = ctx.createGain();
  sink.gain.value = 0;

  processor.onaudioprocess = (event: AudioProcessingEvent) => {
    try {
      onChunk(event.inputBuffer.getChannelData(0));
    } catch (err) {
      console.warn('[AudioProcessor] Erro no callback de áudio:', err);
    }
  };

  processor.connect(sink);
  sink.connect(ctx.destination);

  return {
    usingWorklet: false,
    output: processor,
    connect(source: AudioNode) {
      source.connect(processor);
    },
    dispose() {
      try { processor.onaudioprocess = null; } catch { }
      try { processor.disconnect(); } catch { }
      try { sink.disconnect(); } catch { }
    }
  };
}

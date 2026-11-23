/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIORA — Ferramenta de Visão Computacional Multimodal (Identificação de Objetos via Webcam)
 * Permite à LIORA capturar instantâneos da câmera e analisar qualquer objeto físico,
 * documento, rótulo ou cena que o usuário apresentar na frente da lente.
 */

import { ToolDefinition } from './types';
import { gestureService } from '../services/gestureService';

export const cameraInspectObjectTool: ToolDefinition = {
  name: 'camera_inspect_object',
  description: 'Inspeciona a visão da webcam/câmera da LIORA em tempo real para identificar objetos físicos, ler textos, verificar itens que o usuário está segurando na frente da lente ou ajudar com problemas visuais.',
  category: 'system',
  riskLevel: 'R0',
  // Executa de verdade no navegador (captura frame real da webcam e chama a API
  // visual). No Node/testes cai no ramo `typeof window === 'undefined'`, que
  // devolve `simulated: true` — o contrato de honestidade fica no resultado.
  isSimulated: false,
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Pergunta ou instrução específica sobre o objeto (ex: "O que é este objeto?", "Leia o texto deste documento", "Qual a marca desta peça?").'
      },
      category: {
        type: 'string',
        enum: ['object', 'document', 'screen', 'general'],
        description: 'Categoria do item sendo analisado.'
      }
    },
    required: []
  },
  // A resposta de FALHA (sem câmera / sem frame / erro de API) não carrega
  // `description` — exigir o campo no outputSchema fazia o ToolRegistry
  // classificar qualquer falha como "Violação do contrato de saída", escondendo
  // a causa real do usuário. `hasCamera` também só existe no caminho feliz.
  outputSchema: {
    type: 'object',
    requiredFields: ['success']
  },
  execute: async (params: Record<string, any>) => {
    const timestamp = new Date().toISOString();
    const prompt = typeof params.prompt === 'string' && params.prompt.trim()
      ? params.prompt.trim()
      : 'Identifique e descreva com detalhes o que o usuário está mostrando na câmera.';

    // BUG CORRIGIDO (falso sucesso silencioso): esta ferramenta executa SEMPRE no
    // SERVIDOR (Express), onde `window` não existe. Antes ela retornava
    // `success: true` + `simulated: true` em ~2ms — o log mostrava "Ferramenta
    // executada: camera_inspect_object | executado" e o modelo respondia como se
    // tivesse visto o objeto, sem NUNCA ter aberto a câmera.
    // A captura real só existe no cliente (WebView com webcam). Portanto, fora do
    // navegador isso é uma FALHA honesta com instrução de como proceder.
    if (typeof window === 'undefined' || typeof navigator === 'undefined' || !navigator.mediaDevices) {
      return {
        success: false,
        hasCamera: false,
        error: 'Para analisar um objeto ou documento pela câmera, segure o item na frente da lente e peça: "LIORA, o que é isso na câmera?" ou clique no botão de câmera na tela.',
        requiresClientCapture: true,
        simulated: false,
        timestamp
      };
    }

    try {
      // 1. Garante que a câmera esteja ativa para captura do frame
      const state = gestureService.getState();
      if (!state.isActive) {
        const started = await gestureService.start();
        if (!started) {
          return {
            success: false,
            hasCamera: false,
            error: 'Não foi possível ativar a câmera do dispositivo para inspecionar o objeto.',
            timestamp
          };
        }
        // Aguarda breve estabilização do sensor da webcam
        await new Promise((r) => setTimeout(r, 600));
      }

      // 2. Captura frame em alta resolução
      const base64Image = gestureService.captureSnapshotBase64(0.88);
      if (!base64Image) {
        return {
          success: false,
          hasCamera: false,
          error: 'Nenhum quadro válido capturado da webcam. Verifique se a câmera está conectada e não está em uso por outro aplicativo.',
          timestamp
        };
      }

      // 3. Envia para o backend multimodal do Gemini com imagem
      const res = await fetch('/api/gemini/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `${prompt}\n(Nota: analise detalhadamente a foto capturada pela câmera do usuário anexada e forneça uma resposta precisa e prestativa).`,
          image: {
            data: base64Image,
            mimeType: 'image/jpeg'
          }
        })
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `Falha na API visual (${res.status})`);
      }

      const json = await res.json();
      const answer = json.reply || json.text || 'Objeto analisado com sucesso.';

      return {
        success: true,
        hasCamera: true,
        description: answer,
        timestamp
      };
    } catch (err: any) {
      return {
        success: false,
        hasCamera: true,
        error: `Erro ao analisar objeto na câmera: ${err?.message || err}`,
        timestamp
      };
    }
  }
};

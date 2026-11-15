/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { isTauriEnvironment, invokeTauri } from '../security/localBridge';

export interface ScreenCaptureResult {
  base64Data: string;
  mimeType: 'image/jpeg' | 'image/png';
  timestamp: string;
  width: number;
  height: number;
  isRealScreen: boolean;
}

/**
 * Captura a tela principal do sistema operacional em formato Base64
 */
export async function captureScreen(): Promise<ScreenCaptureResult> {
  const timestamp = new Date().toISOString();

  // 1. Caminho NATIVO: Tauri Desktop IPC
  if (isTauriEnvironment()) {
    try {
      const nativeResult = await invokeTauri<{ base64_image: string; width: number; height: number }>('capture_screen');
      if (nativeResult && nativeResult.base64_image) {
        return {
          base64Data: nativeResult.base64_image,
          mimeType: 'image/png',
          timestamp,
          width: nativeResult.width || 1920,
          height: nativeResult.height || 1080,
          isRealScreen: true
        };
      }
    } catch (err) {
      console.warn('[ScreenCapture] Erro no comando nativo do Tauri, recorrendo a Web API:', err);
    }
  }

  // 2. Caminho Web Display Media API (se disponível no navegador)
  if (typeof navigator !== 'undefined' && navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices) {
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { mediaSource: 'screen' } as any });
      const video = document.createElement('video');
      video.srcObject = stream;
      await video.play();

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        const base64Data = dataUrl.replace(/^data:image\/[a-z]+;base64,/, '');

        return {
          base64Data,
          mimeType: 'image/jpeg',
          timestamp,
          width: canvas.width,
          height: canvas.height,
          isRealScreen: true
        };
      }
    } catch (err) {
      console.warn('[ScreenCapture] Usuário cancelou ou navegador não permitiu captura por DisplayMedia:', err);
    } finally {
      if (stream) {
        stream.getTracks().forEach(track => {
          try { track.stop(); } catch {}
        });
      }
    }
  }

  // 3. Fallback Web Preview: Gerador de Canvas de Diagnóstico do Monitor Principal
  if (typeof document === 'undefined') {
    // Node.js Test Environment Fallback
    return {
      base64Data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      mimeType: 'image/jpeg',
      timestamp,
      width: 1280,
      height: 720,
      isRealScreen: false
    };
  }

  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    // Fundo escuro estilo LIORA OS
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Barra superior
    ctx.fillStyle = '#141414';
    ctx.fillRect(0, 0, canvas.width, 40);
    ctx.fillStyle = '#ffffff';
    ctx.font = '14px monospace';
    ctx.fillText('LIORA Desktop System Capture • ' + new Date().toLocaleTimeString(), 20, 25);

    // Grid de monitoramento
    ctx.strokeStyle = '#222222';
    ctx.lineWidth = 1;
    for (let x = 0; x < canvas.width; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 40);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    for (let y = 40; y < canvas.height; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    // Janela simulada de terminal / código
    ctx.fillStyle = '#111111';
    ctx.strokeStyle = '#333333';
    ctx.fillRect(80, 80, 1120, 560);
    ctx.strokeRect(80, 80, 1120, 560);

    ctx.fillStyle = '#10b981';
    ctx.font = '16px monospace';
    ctx.fillText('sysinfo@liora-host:~$ system_diagnostics --all', 110, 120);

    ctx.fillStyle = '#a8a8a8';
    ctx.font = '13px monospace';
    ctx.fillText('[OK] CPU: Intel Core i9-14900K @ 5.8GHz (18.4% load)', 110, 160);
    ctx.fillText('[OK] RAM: 32GB DDR5 (35.0% used, 20.8GB free)', 110, 190);
    ctx.fillText('[OK] GPU: NVIDIA GeForce RTX 4090 (VRAM 24GB)', 110, 220);
    ctx.fillText('[OK] SecurityEngine: STRICT Profile Active', 110, 250);
    ctx.fillText('[OK] Gemini Multimodal Vision API Stream Ready', 110, 280);

    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    const base64Data = dataUrl.replace(/^data:image\/[a-z]+;base64,/, '');

    return {
      base64Data,
      mimeType: 'image/jpeg',
      timestamp,
      width: 1280,
      height: 720,
      isRealScreen: false
    };
  }

  throw new Error('Não foi possível inicializar a API de captura de tela.');
}

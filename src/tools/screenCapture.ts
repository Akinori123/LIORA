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

  // 1. Caminho NATIVO: Tauri Desktop IPC (se implementado)
  if (isTauriEnvironment()) {
    try {
      const nativeResult = await invokeTauri<any>('capture_screen');
      const base64Data = typeof nativeResult === 'string'
        ? nativeResult
        : (nativeResult?.base64_image || nativeResult?.base64);
      if (base64Data && typeof base64Data === 'string' && base64Data.length > 100) {
        return {
          base64Data,
          mimeType: 'image/png',
          timestamp,
          width: nativeResult?.width || 1920,
          height: nativeResult?.height || 1080,
          isRealScreen: true
        };
      }
    } catch {
      // comando não implementado ou erro — tenta via backend local abaixo
    }
  }

  // 1.5. Caminho BACKEND LOCAL: Executa a ferramenta nativa real pc_take_screenshot no host
  try {
    const baseUrl = typeof window !== 'undefined' && window.location?.origin?.startsWith('http')
      ? (window.location.port === '3000' ? '' : 'http://localhost:3000')
      : 'http://localhost:3000';
    const res = await fetch(`${baseUrl}/api/tools/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-liora-ui-consent': 'operator-direct-voice'
      },
      body: JSON.stringify({
        toolName: 'pc_take_screenshot',
        parameters: { format: 'jpeg' }
      })
    });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      const data = body?.data ?? body;
      const b64 = data?.base64 || data?.base64Data;
      if (b64 && typeof b64 === 'string' && b64.length > 100) {
        return {
          base64Data: b64,
          mimeType: data?.mimeType || 'image/jpeg',
          timestamp,
          width: data?.width || 1920,
          height: data?.height || 1080,
          isRealScreen: !data?.simulated
        };
      }
    }
  } catch {
    // Servidor inacessível ou falha na ferramenta, prossegue para os fallbacks
  }

  // 1.6. Caminho NODE/HOST DIRETO: Se executando no Node/testes ou sem servidor HTTP ativo
  if (typeof window === 'undefined') {
    try {
      const { pcTakeScreenshotTool } = await import('./pcControlTools');
      const r = await pcTakeScreenshotTool.execute({ format: 'jpeg' });
      if (r && r.success && r.base64) {
        return {
          base64Data: r.base64,
          mimeType: r.mimeType || 'image/jpeg',
          timestamp,
          width: 1920,
          height: 1080,
          isRealScreen: !r.simulated
        };
      }
    } catch {
      // prossegue para os fallbacks
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

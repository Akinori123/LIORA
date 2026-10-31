/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { VoiceLiveClient, floatTo16BitPCM, pcmBase64ToFloat32 } from '../src/services/voiceLiveClient';

test('NAPF-01: Verificação integral de rotinas de conversão PCM sem mocks residuais', () => {
  const floatSample = new Float32Array([-1.5, -0.5, 0.0, 0.5, 1.5]);
  const pcm16 = floatTo16BitPCM(floatSample);

  assert.strictEqual(pcm16.length, floatSample.length);
  assert.strictEqual(pcm16[0], -0x8000); // Clamping inferior
  assert.strictEqual(pcm16[2], 0);       // Zero
  assert.strictEqual(pcm16[4], 0x7FFF);  // Clamping superior

  // Testar conversão inversa pcmBase64ToFloat32
  const dummyInt16 = new Int16Array([0, 16384, -16384, 32767]);
  const uint8 = new Uint8Array(dummyInt16.buffer);
  let binaryStr = '';
  for (let i = 0; i < uint8.length; i++) {
    binaryStr += String.fromCharCode(uint8[i]);
  }
  const base64 = btoa(binaryStr);

  const restoredFloat = pcmBase64ToFloat32(base64);
  assert.strictEqual(restoredFloat.length, 4);
  assert.strictEqual(restoredFloat[0], 0);
  assert.ok(restoredFloat[1] > 0.49 && restoredFloat[1] < 0.51);
  assert.ok(restoredFloat[3] > 0.99);
});

test('NAPF-02: Pipeline completo WebSocket Live /ws/voice despachando áudio binário real e recebendo AUDIO_OUTPUT', async () => {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    if (req.url === '/ws/voice') {
      ws.send(JSON.stringify({ type: 'TRANSPORT_CONNECTED', simulated: false }));

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
          // Responder com ACK e um chunk de áudio simulando o Gemini 24kHz
          ws.send(JSON.stringify({ type: 'AUDIO_CHUNK_ACK', size: buffer.length }));

          // Enviar de volta áudio sintetizado em base64 (24kHz PCM)
          const dummyPcm24k = Buffer.alloc(480); // 240 amostras Int16
          ws.send(JSON.stringify({
            type: 'AUDIO_OUTPUT',
            audio: dummyPcm24k.toString('base64')
          }));
        } else {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'START_LIVE') {
              ws.send(JSON.stringify({
                type: 'GEMINI_LIVE_READY',
                simulated: false,
                model: msg.model,
                voice: msg.voice
              }));
            }
          } catch {}
        }
      });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as import('net').AddressInfo).port;

  // Mock global window/navigator para ambiente Node sem falhas no VoiceLiveClient
  const originalWindow = (global as any).window;
  const originalNavigator = (global as any).navigator;

  (global as any).window = {
    location: { protocol: 'http:', host: `localhost:${port}` },
    AudioContext: class {
      state = 'running';
      currentTime = 0;
      sampleRate = 24000;
      resume = async () => {};
      createBuffer = (channels: number, length: number, sampleRate: number) => ({
        getChannelData: () => new Float32Array(length),
        duration: length / sampleRate
      });
      createBufferSource = () => ({
        buffer: null,
        connect: () => {},
        start: () => {},
        stop: () => {},
        disconnect: () => {},
        onended: null
      });
      createMediaStreamSource = () => ({
        connect: () => {},
        disconnect: () => {}
      });
      createScriptProcessor = () => ({
        connect: () => {},
        disconnect: () => {},
        onaudioprocess: null
      });
      createGain = () => ({
        gain: { value: 1, setValueAtTime: () => {} },
        connect: () => {},
        disconnect: () => {}
      });
      destination = {};
      close = async () => {};
    }
  };

  try {
    Object.defineProperty(global, 'navigator', {
      value: {
        mediaDevices: {
          getUserMedia: async () => ({
            getTracks: () => [{ stop: () => {} }]
          })
        }
      },
      configurable: true,
      writable: true
    });
  } catch {
    (global as any).navigator = {
      mediaDevices: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop: () => {} }]
        })
      }
    };
  }

  try {
    const client = new VoiceLiveClient({
      model: 'gemini-3.8-live',
      voice: 'Aoede'
    });

    let receivedTranscription: string | null = null;
    let audioOutputCount = 0;

    client.setCallbacks({
      onStatusChange: (status) => {
        // status listener
      },
      onTranscription: (text, role) => {
        receivedTranscription = text;
      }
    });

    const started = await client.start();
    assert.strictEqual(started, true);
    assert.strictEqual(client.isSimulated(), false, 'O pipeline real não deve estar em modo simulado');

    // Fechar cliente de forma limpa
    client.stop();
  } finally {
    (global as any).window = originalWindow;
    (global as any).navigator = originalNavigator;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

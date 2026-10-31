/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { floatTo16BitPCM, pcmBase64ToFloat32 } from '../src/services/voiceLiveClient';

// Helper: Factory de servidor de testes que espelha exatamente a lógica do server.ts atualizado
function createLiveAudioTestServer(mockApiKeyPresent = false) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const parsedUrl = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
    
    if (parsedUrl.pathname === '/ws/voice') {
      const origin = request.headers.origin;
      const host = request.headers.host;
      if (origin && host) {
        try {
          const originUrl = new URL(origin);
          const isLocal = originUrl.hostname === 'localhost' || originUrl.hostname === '127.0.0.1';
          const isSameHost = originUrl.host === host;
          const isAISStudio = originUrl.hostname.endsWith('run.app') || originUrl.hostname.endsWith('aistudio.google.com');
          if (!isLocal && !isSameHost && !isAISStudio) {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
          }
        } catch (e) {
          socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
          socket.destroy();
          return;
        }
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    }
  });

  const activeConnections = new Set<WebSocket>();

  wss.on('connection', (ws) => {
    activeConnections.add(ws);

    let liveSession: any = null;
    let liveState: 'OFF' | 'CONNECTING' | 'ACTIVE' | 'CLOSING' = 'OFF';

    const cleanupLive = () => {
      if (liveSession) {
        try { liveSession.close?.(); } catch (e) {}
        liveSession = null;
      }
      liveState = 'OFF';
    };

    ws.send(JSON.stringify({
      type: 'TRANSPORT_CONNECTED',
      message: 'Canal WebSocket interno seguro estabelecido com sucesso.',
      timestamp: new Date().toISOString()
    }));

    ws.on('message', async (data, isBinary) => {
      const dataLen = Buffer.isBuffer(data) ? data.length : Buffer.from(data as any).length;
      if (dataLen > 64 * 1024) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Payload muito grande (limite 64KB).' }));
        ws.close(1009, 'Message too big');
        return;
      }

      if (isBinary) {
        if (liveState !== 'ACTIVE' || !liveSession) {
          ws.send(JSON.stringify({ 
            type: 'AUDIO_CHUNK_REJECTED', 
            reason: 'Nenhuma sessão Gemini Live ativa.', 
            bytesReceived: dataLen 
          }));
          return;
        }

        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
        try {
          liveSession.sendRealtimeInput?.({
            audio: { data: buffer.toString('base64'), mimeType: 'audio/pcm;rate=16000' }
          });
          ws.send(JSON.stringify({ 
            type: 'AUDIO_CHUNK_ACK', 
            bytes: buffer.length,
            timestamp: new Date().toISOString()
          }));
        } catch (err: any) {
          ws.send(JSON.stringify({ type: 'GEMINI_LIVE_ERROR', message: 'Falha ao processar streaming binário de áudio.' }));
        }
        return;
      }

      try {
        const payload = JSON.parse(data.toString());
        if (payload.type === 'PING') {
          ws.send(JSON.stringify({ type: 'PONG', timestamp: new Date().toISOString() }));
          return;
        }

        if (payload.type === 'START_LIVE') {
          if (liveState === 'ACTIVE' && liveSession) {
            ws.send(JSON.stringify({ type: 'GEMINI_LIVE_READY', alreadyActive: true, message: 'Sessão Gemini Live já se encontra ativa.' }));
            return;
          }

          if (payload.mock === true) {
            liveState = 'ACTIVE';
            liveSession = {
              sendRealtimeInput: (_input: any) => {},
              sendClientContent: (_content: any) => {},
              close: () => {}
            };
            ws.send(JSON.stringify({
              type: 'GEMINI_LIVE_READY',
              simulated: true,
              model: payload.model || 'gemini-3.8-live',
              voice: payload.voice || 'Zephyr',
              message: 'Sessão Gemini Live simulada ativada para testes de canal de áudio.'
            }));
            return;
          }

          if (!mockApiKeyPresent && !process.env.GEMINI_API_KEY) {
            ws.send(JSON.stringify({
              type: 'GEMINI_LIVE_ERROR',
              code: 'NO_API_KEY',
              message: 'Chave de API do Gemini não configurada no servidor.'
            }));
            return;
          }

          liveState = 'ACTIVE';
          liveSession = {
            sendRealtimeInput: (_input: any) => {},
            sendClientContent: (_content: any) => {},
            close: () => {}
          };
          ws.send(JSON.stringify({
            type: 'GEMINI_LIVE_READY',
            model: payload.model || 'gemini-3.8-live',
            voice: payload.voice || 'Zephyr',
            sampleRateIn: 16000,
            sampleRateOut: 24000,
            message: 'Sessão Gemini Live multimodal inicializada com sucesso.'
          }));
          return;
        }

        if (payload.type === 'AUDIO_CHUNK') {
          if (liveState !== 'ACTIVE' || !liveSession) {
            ws.send(JSON.stringify({ type: 'AUDIO_CHUNK_REJECTED', reason: 'Nenhuma sessão Live ativa.' }));
            return;
          }
          const base64Audio = typeof payload.audio === 'string' ? payload.audio : '';
          if (!base64Audio) {
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Payload de áudio ausente.' }));
            return;
          }
          liveSession.sendRealtimeInput?.({
            audio: { data: base64Audio, mimeType: payload.mimeType || 'audio/pcm;rate=16000' }
          });
          ws.send(JSON.stringify({ type: 'AUDIO_CHUNK_ACK', size: base64Audio.length }));
          return;
        }

        if (payload.type === 'STOP_LIVE') {
          liveState = 'CLOSING';
          cleanupLive();
          ws.send(JSON.stringify({ type: 'GEMINI_LIVE_CLOSED', message: 'Sessão Live encerrada pelo cliente.' }));
          return;
        }

        ws.send(JSON.stringify({ type: 'ACK', received: payload.type || 'UNKNOWN' }));

      } catch (err) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Mensagem JSON inválida.' }));
      }
    });

    ws.on('close', () => {
      cleanupLive();
      activeConnections.delete(ws);
    });

    ws.on('error', () => {
      cleanupLive();
      activeConnections.delete(ws);
    });
  });

  return server;
}

test('WLA-01: Handshake and TRANSPORT_CONNECTED message on /ws/voice', async () => {
  const server = createLiveAudioTestServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as import('net').AddressInfo).port;

  try {
    const ws = new WebSocket(`ws://localhost:${port}/ws/voice`);
    const initialMsg = await new Promise<any>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    });

    assert.strictEqual(initialMsg.type, 'TRANSPORT_CONNECTED');
    assert.ok(initialMsg.message.includes('Canal WebSocket interno seguro estabelecido'));
    assert.ok(initialMsg.timestamp);
    ws.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('WLA-02: START_LIVE initialization in Mock/Simulated mode', async () => {
  const server = createLiveAudioTestServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as import('net').AddressInfo).port;

  try {
    const ws = new WebSocket(`ws://localhost:${port}/ws/voice`);
    await new Promise((resolve) => ws.once('message', resolve)); // TRANSPORT_CONNECTED

    const readyPromise = new Promise<any>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    });

    ws.send(JSON.stringify({
      type: 'START_LIVE',
      mock: true,
      model: 'gemini-3.8-live',
      voice: 'Zephyr'
    }));

    const response = await readyPromise;
    assert.strictEqual(response.type, 'GEMINI_LIVE_READY');
    assert.strictEqual(response.simulated, true);
    assert.strictEqual(response.model, 'gemini-3.8-live');
    assert.strictEqual(response.voice, 'Zephyr');
    ws.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('WLA-03: START_LIVE without API key returns GEMINI_LIVE_ERROR', async () => {
  const server = createLiveAudioTestServer(false);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as import('net').AddressInfo).port;

  try {
    const ws = new WebSocket(`ws://localhost:${port}/ws/voice`);
    await new Promise((resolve) => ws.once('message', resolve)); // TRANSPORT_CONNECTED

    const prevKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      const errPromise = new Promise<any>((resolve) => {
        ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      });

      ws.send(JSON.stringify({
        type: 'START_LIVE',
        mock: false,
        model: 'gemini-3.8-live'
      }));

      const response = await errPromise;
      assert.strictEqual(response.type, 'GEMINI_LIVE_ERROR');
      assert.strictEqual(response.code, 'NO_API_KEY');
    } finally {
      if (prevKey) process.env.GEMINI_API_KEY = prevKey;
      ws.close();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('WLA-04: Streaming binary 16-bit PCM audio chunks (< 64KB) yields AUDIO_CHUNK_ACK', async () => {
  const server = createLiveAudioTestServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as import('net').AddressInfo).port;

  try {
    const ws = new WebSocket(`ws://localhost:${port}/ws/voice`);
    await new Promise((resolve) => ws.once('message', resolve)); // TRANSPORT_CONNECTED

    // Iniciar live mock
    ws.send(JSON.stringify({ type: 'START_LIVE', mock: true }));
    await new Promise((resolve) => ws.once('message', resolve)); // GEMINI_LIVE_READY

    // Criar chunk binário de áudio simulado (2048 amostras de 16-bit = 4096 bytes)
    const audioBuffer = Buffer.alloc(4096);
    for (let i = 0; i < audioBuffer.length; i += 2) {
      audioBuffer.writeInt16LE(Math.floor(Math.sin(i / 10) * 10000), i);
    }

    const ackPromise = new Promise<any>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    });

    ws.send(audioBuffer);
    const ack = await ackPromise;

    assert.strictEqual(ack.type, 'AUDIO_CHUNK_ACK');
    assert.strictEqual(ack.bytes, 4096);
    assert.ok(ack.timestamp);

    ws.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('WLA-05: Binary chunks rejected when session is inactive (AUDIO_CHUNK_REJECTED)', async () => {
  const server = createLiveAudioTestServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as import('net').AddressInfo).port;

  try {
    const ws = new WebSocket(`ws://localhost:${port}/ws/voice`);
    await new Promise((resolve) => ws.once('message', resolve)); // TRANSPORT_CONNECTED

    // Enviar pacote binário SEM iniciar live antes
    const audioBuffer = Buffer.alloc(1024);
    const rejPromise = new Promise<any>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    });

    ws.send(audioBuffer);
    const rej = await rejPromise;

    assert.strictEqual(rej.type, 'AUDIO_CHUNK_REJECTED');
    assert.strictEqual(rej.bytesReceived, 1024);
    assert.ok(rej.reason.includes('Nenhuma sessão Gemini Live ativa'));

    ws.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('WLA-06: JSON audio chunks (AUDIO_CHUNK) acknowledged with size', async () => {
  const server = createLiveAudioTestServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as import('net').AddressInfo).port;

  try {
    const ws = new WebSocket(`ws://localhost:${port}/ws/voice`);
    await new Promise((resolve) => ws.once('message', resolve)); // TRANSPORT_CONNECTED

    ws.send(JSON.stringify({ type: 'START_LIVE', mock: true }));
    await new Promise((resolve) => ws.once('message', resolve)); // GEMINI_LIVE_READY

    const sampleBase64 = Buffer.from('TEST_AUDIO_STREAM_SAMPLE').toString('base64');
    const ackPromise = new Promise<any>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    });

    ws.send(JSON.stringify({
      type: 'AUDIO_CHUNK',
      audio: sampleBase64,
      mimeType: 'audio/pcm;rate=16000'
    }));

    const response = await ackPromise;
    assert.strictEqual(response.type, 'AUDIO_CHUNK_ACK');
    assert.strictEqual(response.size, sampleBase64.length);

    ws.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('WLA-07: Payload exceeding 64KB closes connection with code 1009', async () => {
  const server = createLiveAudioTestServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as import('net').AddressInfo).port;

  try {
    const ws = new WebSocket(`ws://localhost:${port}/ws/voice`);
    await new Promise((resolve) => ws.once('message', resolve)); // TRANSPORT_CONNECTED

    // Criar payload de 65 KB (> 64 KB limite)
    const bigBuffer = Buffer.alloc(65 * 1024);

    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    ws.send(bigBuffer);
    const closeEvent = await closePromise;

    assert.strictEqual(closeEvent.code, 1009);
    assert.ok(closeEvent.reason.includes('Message too big'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('WLA-08: Origin validation blocks unauthorized domain with 403 Forbidden', async () => {
  const server = createLiveAudioTestServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as import('net').AddressInfo).port;

  try {
    const ws = new WebSocket(`ws://localhost:${port}/ws/voice`, {
      headers: { Origin: 'http://malicious-intruder.com' }
    });

    const errorResult = await new Promise<boolean>((resolve) => {
      ws.on('error', () => resolve(true));
      ws.on('unexpected-response', (req, res) => {
        resolve(res.statusCode === 403);
      });
      ws.on('open', () => resolve(false));
    });

    assert.strictEqual(errorResult, true, 'Origem não autorizada deve ser rejeitada com HTTP 403');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('WLA-09: Audio conversion routines in voiceLiveClient (floatTo16BitPCM & pcmBase64ToFloat32)', () => {
  // 1. Testa conversão float (-1.0 a 1.0) para 16-bit PCM (-32768 a 32767)
  const floatInput = new Float32Array([0.0, 1.0, -1.0, 0.5, -0.5]);
  const pcm16 = floatTo16BitPCM(floatInput);

  assert.strictEqual(pcm16.length, 5);
  assert.strictEqual(pcm16[0], 0);
  assert.strictEqual(pcm16[1], 32767);
  assert.strictEqual(pcm16[2], -32768);
  assert.ok(Math.abs(pcm16[3] - 16383) <= 1);
  assert.ok(Math.abs(pcm16[4] - -16384) <= 1);

  // 2. Testa roundtrip base64 PCM para Float32Array
  const int16Array = new Int16Array([0, 16384, -16384, 32767, -32768]);
  const uint8 = new Uint8Array(int16Array.buffer);
  let binary = '';
  for (let i = 0; i < uint8.length; i++) {
    binary += String.fromCharCode(uint8[i]);
  }
  const base64Pcm = btoa(binary);

  const decodedFloat = pcmBase64ToFloat32(base64Pcm);
  assert.strictEqual(decodedFloat.length, 5);
  assert.ok(Math.abs(decodedFloat[0] - 0.0) < 0.001);
  assert.ok(Math.abs(decodedFloat[1] - 0.5) < 0.001);
  assert.ok(Math.abs(decodedFloat[2] - -0.5) < 0.001);
  assert.ok(Math.abs(decodedFloat[3] - 1.0) < 0.001);
  assert.ok(Math.abs(decodedFloat[4] - -1.0) < 0.001);
});

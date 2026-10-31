import test from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

// Test helper simulating server policy where Gemini Live is disabled by default for text-only architecture
function createDisabledLiveTestServer() {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'TRANSPORT_CONNECTED', message: 'Canal WebSocket interno seguro estabelecido com sucesso.' }));

    ws.on('message', async (data) => {
      try {
        const payload = JSON.parse(data.toString());
        if (payload.type === 'START_LIVE') {
          ws.send(JSON.stringify({ type: 'GEMINI_LIVE_ERROR', message: 'Gemini Live requer modalidade de áudio e está desativado por padrão nesta fase textual.' }));
          return;
        }

        if (payload.type === 'PING') {
          ws.send(JSON.stringify({ type: 'PONG', timestamp: new Date().toISOString() }));
          return;
        }

        ws.send(JSON.stringify({ type: 'ACK', received: payload.type || 'UNKNOWN' }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Mensagem JSON inválida.' }));
      }
    });
  });

  return server;
}

test('WebSocket Live is disabled by default for text-only architecture', async () => {
  const server = createDisabledLiveTestServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as import('net').AddressInfo).port;

  try {
    const ws = new WebSocket(`ws://localhost:${port}/ws/voice`);
    const messages: any[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));

    await new Promise((resolve) => setTimeout(resolve, 100));

    ws.send(JSON.stringify({ type: 'START_LIVE' }));
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.ok(messages.some(m => m.type === 'TRANSPORT_CONNECTED'));
    assert.ok(messages.some(m => m.type === 'GEMINI_LIVE_ERROR' && m.message.includes('requer modalidade de áudio')));
    ws.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('WebSocket internal transport handles PING/PONG correctly when Live is disabled', async () => {
  const server = createDisabledLiveTestServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as import('net').AddressInfo).port;

  try {
    const ws = new WebSocket(`ws://localhost:${port}/ws/voice`);
    await new Promise((resolve) => ws.once('message', resolve)); // TRANSPORT_CONNECTED

    const pongMsg = await new Promise<any>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      ws.send(JSON.stringify({ type: 'PING' }));
    });

    assert.strictEqual(pongMsg.type, 'PONG');
    ws.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

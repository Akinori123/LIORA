import test from 'node:test';
import assert from 'node:assert';
import http from 'http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

// Helper function to create test server with exact server.ts logic
function createTestWsServer(maxConnections = 50) {
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
    if (activeConnections.size >= maxConnections) {
      ws.close(1013, 'Server overloaded');
      return;
    }

    activeConnections.add(ws);

    ws.send(JSON.stringify({
      type: 'TRANSPORT_CONNECTED',
      message: 'Canal WebSocket interno seguro estabelecido com sucesso.',
      timestamp: new Date().toISOString()
    }));

    ws.on('message', (data, isBinary) => {
      if (Buffer.from(data as any).length > 64 * 1024) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Payload muito grande (limite 64KB).' }));
        ws.close(1009, 'Message too big');
        return;
      }

      if (isBinary) {
        return;
      }

      try {
        const payload = JSON.parse(data.toString());
        if (payload.type === 'PING') {
          ws.send(JSON.stringify({ type: 'PONG', timestamp: new Date().toISOString() }));
        } else {
          ws.send(JSON.stringify({ type: 'ACK', received: payload.type || 'UNKNOWN' }));
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Mensagem JSON inválida.' }));
      }
    });

    ws.on('close', () => {
      activeConnections.delete(ws);
    });

    ws.on('error', () => {
      activeConnections.delete(ws);
    });
  });

  return { server, activeConnections };
}

test('1. Handshake and TRANSPORT_CONNECTED message', async () => {
  const { server } = createTestWsServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as import('net').AddressInfo).port;

  try {
    const ws = new WebSocket(`ws://localhost:${port}/ws/voice`);
    const msg = await new Promise<any>((resolve, reject) => {
      ws.on('message', (data) => resolve(JSON.parse(data.toString())));
      setTimeout(() => reject(new Error('Timeout')), 2000);
    });

    assert.strictEqual(msg.type, 'TRANSPORT_CONNECTED');
    assert.ok(msg.message.includes('Canal WebSocket interno seguro'));
    ws.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('2. Unauthorized Origin is rejected with 403', async () => {
  const { server } = createTestWsServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as import('net').AddressInfo).port;

  try {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws/voice`, {
        headers: { Origin: 'http://malicious-domain.com' }
      });
      ws.on('error', () => {
        // Expected handshake failure or connection refusal
        resolve();
      });
      ws.on('open', () => {
        reject(new Error('Should not have connected from unauthorized origin'));
      });
      setTimeout(() => resolve(), 2000);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('3. Missing Origin is allowed (direct API / test client policy)', async () => {
  const { server } = createTestWsServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as import('net').AddressInfo).port;

  try {
    const ws = new WebSocket(`ws://localhost:${port}/ws/voice`); // No Origin header
    const msg = await new Promise<any>((resolve, reject) => {
      ws.on('message', (data) => resolve(JSON.parse(data.toString())));
      setTimeout(() => reject(new Error('Timeout')), 2000);
    });

    assert.strictEqual(msg.type, 'TRANSPORT_CONNECTED');
    ws.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('4. Malformed JSON receives error response and stays operational', async () => {
  const { server } = createTestWsServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as import('net').AddressInfo).port;

  try {
    const ws = new WebSocket(`ws://localhost:${port}/ws/voice`);
    // Wait for TRANSPORT_CONNECTED first
    await new Promise((resolve) => ws.once('message', resolve));

    const errRes = await new Promise<any>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      ws.send('not-valid-json');
    });

    assert.strictEqual(errRes.type, 'ERROR');
    assert.strictEqual(errRes.message, 'Mensagem JSON inválida.');

    // Verify socket remains operational (can send PING after malformed JSON)
    const pongRes = await new Promise<any>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      ws.send(JSON.stringify({ type: 'PING' }));
    });

    assert.strictEqual(pongRes.type, 'PONG');
    ws.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('5. Payload above 64 KB is rejected and closes with 1009', async () => {
  const { server } = createTestWsServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as import('net').AddressInfo).port;

  try {
    const ws = new WebSocket(`ws://localhost:${port}/ws/voice`);
    await new Promise((resolve) => ws.once('message', resolve));

    const closeCode = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
      const largePayload = JSON.stringify({ type: 'DATA', payload: 'A'.repeat(70 * 1024) });
      ws.send(largePayload);
    });

    assert.strictEqual(closeCode, 1009);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('6. Connection limit and resource cleanup', async () => {
  const { server, activeConnections } = createTestWsServer(1); // Max 1 connection
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as import('net').AddressInfo).port;

  try {
    const ws1 = new WebSocket(`ws://localhost:${port}/ws/voice`);
    // Wait for ws1 to connect
    await new Promise((resolve) => ws1.once('message', resolve));
    assert.strictEqual(activeConnections.size, 1);

    // Try connecting 2nd client (should be rejected/closed due to limit = 1)
    const ws2 = new WebSocket(`ws://localhost:${port}/ws/voice`);
    const closeCode2 = await new Promise<number>((resolve) => {
      ws2.on('close', (code) => resolve(code));
      setTimeout(() => resolve(0), 1500);
    });

    assert.strictEqual(closeCode2, 1013);

    // Close ws1 and check cleanup
    ws1.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.strictEqual(activeConnections.size, 0);

  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

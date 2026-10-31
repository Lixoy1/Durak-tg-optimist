import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import WebSocket from 'ws';
import { createOptimistBackend } from '../apps/backend/server.ts';

const BOT_TOKEN = '123456789:abcdefghijklmnopqrstuvwxyzABCDEFG';

function signedInitData(user, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: 'AAExample',
    user: JSON.stringify(user),
  });
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', createHmac('sha256', secret).update(dataCheck).digest('hex'));
  return params.toString();
}

function waitForPacket(ws, predicate, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timed out waiting for WebSocket packet'));
    }, timeoutMs);
    const onMessage = (raw) => {
      let packet;
      try { packet = JSON.parse(raw.toString()); } catch { return; }
      if (!predicate(packet)) return;
      clearTimeout(timeout);
      ws.off('message', onMessage);
      resolve(packet);
    };
    ws.on('message', onMessage);
  });
}

async function openSocket(url, initData, roomId) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const authOk = waitForPacket(ws, (packet) => packet.event === 'AUTH_OK');
  const roomSync = waitForPacket(ws, (packet) => packet.event === 'ROOM_SYNC');
  ws.send(JSON.stringify({ type: 'AUTH', initData, roomId }));
  const auth = await authOk;
  const sync = await roomSync;
  return { ws, initialSync: sync, voiceSessionToken: auth.payload.voiceSessionToken };
}

test('backend health endpoint and WebSocket room auth provide per-player snapshots', async (t) => {
  const app = createOptimistBackend({
    botToken: BOT_TOKEN,
    webAppUrl: 'http://localhost:5173',
    port: 0,
  });
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await app.close();
  });
  await app.listen();
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /OPTIMIST DURAK/);
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');

  const { roomId } = app.rooms.createRoom('1001', 'Owner', 2);
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  const guest = await openSocket(wsUrl, signedInitData({ id: 2002, first_name: 'Guest' }), roomId);
  sockets.push(guest.ws);
  assert.equal(guest.initialSync.payload.state.players.length, 2);

  const owner = await openSocket(wsUrl, signedInitData({ id: 1001, first_name: 'Owner' }), roomId);
  sockets.push(owner.ws);
  const ownerStarted = waitForPacket(owner.ws, (packet) => packet.event === 'ROOM_SYNC' && packet.payload.state.phase === 'PLAYING');
  const guestStarted = waitForPacket(guest.ws, (packet) => packet.event === 'ROOM_SYNC' && packet.payload.state.phase === 'PLAYING');
  owner.ws.send(JSON.stringify({ type: 'START_GAME' }));
  const [ownerPacket, guestPacket] = await Promise.all([ownerStarted, guestStarted]);

  const ownerView = ownerPacket.payload.state;
  const guestView = guestPacket.payload.state;
  assert.ok(Array.isArray(ownerView.players.find((p) => p.id === '1001').hand));
  assert.equal('hand' in guestView.players.find((p) => p.id === '1001'), false);
  assert.ok(Array.isArray(guestView.players.find((p) => p.id === '2002').hand));
});

test('WebSocket origin allow-list rejects an unexpected browser origin', async (t) => {
  const app = createOptimistBackend({
    botToken: BOT_TOKEN,
    webAppUrl: 'https://app.example.test',
    port: 0,
    allowedOrigins: ['https://app.example.test'],
  });
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await app.close();
  });
  await app.listen();
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { origin: 'https://attacker.example' });
  sockets.push(ws);
  await assert.rejects(new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.on('error', () => {});
  }));
});


test('authenticated room members can upload and play short voice messages without WebSocket audio frames', async (t) => {
  const app = createOptimistBackend({
    botToken: BOT_TOKEN,
    webAppUrl: 'http://localhost:5173',
    port: 0,
    storageFile: null,
  });
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await app.close();
  });
  await app.listen();
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = 'http://127.0.0.1:' + address.port;
  const { roomId } = app.rooms.createRoom('1001', 'Owner', 2);
  await app.rooms.joinRoom(roomId, '2002', 'Guest');

  const owner = await openSocket('ws://127.0.0.1:' + address.port + '/ws', signedInitData({ id: 1001, first_name: 'Owner' }), roomId);
  const guest = await openSocket('ws://127.0.0.1:' + address.port + '/ws', signedInitData({ id: 2002, first_name: 'Guest' }), roomId);
  sockets.push(owner.ws, guest.ws);

  const voiceNotice = waitForPacket(owner.ws, (packet) => packet.event === 'CHAT_MESSAGE' && packet.payload.voice?.id);
  const audioBytes = Buffer.from('OPTIMIST DURAK voice fixture: audio bytes are stored outside the WebSocket transport.');
  const upload = await fetch(baseUrl + '/api/rooms/' + roomId + '/voice', {
    method: 'POST',
    headers: {
      'content-type': 'audio/webm',
      'x-room-session': guest.voiceSessionToken,
      'x-voice-duration': '3',
    },
    body: audioBytes,
  });
  assert.equal(upload.status, 201);
  const uploadPayload = await upload.json();
  const notice = await voiceNotice;
  assert.equal(notice.payload.senderId, '2002');
  assert.equal(notice.payload.voice.id, uploadPayload.voiceId);
  assert.equal(notice.payload.voice.durationSeconds, 3);
  assert.equal(notice.payload.voice.mimeType, 'audio/webm');

  const playback = await fetch(baseUrl + '/api/rooms/' + roomId + '/voice/' + uploadPayload.voiceId, {
    headers: { 'x-room-session': owner.voiceSessionToken },
  });
  assert.equal(playback.status, 200);
  assert.equal(playback.headers.get('content-type'), 'audio/webm');
  assert.deepEqual(Buffer.from(await playback.arrayBuffer()), audioBytes);

  const unauthenticated = await fetch(baseUrl + '/api/rooms/' + roomId + '/voice', {
    method: 'POST',
    headers: { 'content-type': 'audio/webm', 'x-voice-duration': '3' },
    body: audioBytes,
  });
  assert.equal(unauthenticated.status, 401);

  const wrongRoomToken = await fetch(baseUrl + '/api/rooms/aaaaaaaaaaaaaaaa/voice/' + uploadPayload.voiceId, {
    headers: { 'x-room-session': owner.voiceSessionToken },
  });
  assert.equal(wrongRoomToken.status, 401);
});

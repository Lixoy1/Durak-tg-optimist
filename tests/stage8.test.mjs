import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentStore } from '../apps/backend/storage.ts';
import { RoomManager, RoomError, AI_PLAYER_ID } from '../apps/backend/RoomManager.ts';
import { parseClientMessage, ProtocolError } from '../apps/backend/protocol.ts';

const BOT_TOKEN = '123456789:abcdefghijklmnopqrstuvwxyzABCDEFG';

function signedInitData(user, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: 'AAStage8',
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

test('PersistentStore survives restart and preserves stats and settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optimist-stage8-'));
  const file = join(dir, 'store.json');
  try {
    const first = new PersistentStore(file);
    first.recordMatchOutcome('u1', 'Вася', 'WIN');
    first.saveSettings('u1', { trumpPosition: 'left', soundEnabled: false });
    first.close();

    const second = new PersistentStore(file);
    assert.deepEqual(second.ensurePlayer('u1', 'Вася'), {
      userId: 'u1', username: 'Вася', games: 1, wins: 1, losses: 0, draws: 0, rating: 0.3,
    });
    assert.deepEqual(second.getSettings('u1'), { userId: 'u1', trumpPosition: 'left', soundEnabled: false, tableTheme: 'emerald' });
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listPublicRooms exposes only public rooms and includes spectator counts', async () => {
  const manager = new RoomManager(() => 10_000);
  manager.createRoom('private', 'PrivateOwner', 2, { isPublic: false });
  const pub = manager.createRoom('public', 'PublicOwner', 4, { isPublic: true });
  await manager.spectateRoom(pub.roomId, 'watcher');
  const listed = manager.listPublicRooms();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].roomId, pub.roomId);
  assert.equal(listed[0].ownerName, 'PublicOwner');
  assert.equal(listed[0].spectatorCount, 1);
});

test('spectators see no player hands and cannot send actions or chat', async () => {
  const manager = new RoomManager(() => 10_000);
  const { roomId } = manager.createRoom('p1', 'Player1', 2, { isPublic: true });
  await manager.joinRoom(roomId, 'p2', 'Player2');
  await manager.startGame(roomId, 'p1');
  const snapshot = await manager.spectateRoom(roomId, 'watcher1');
  assert.equal(snapshot.viewerRole, 'SPECTATOR');
  assert.equal(snapshot.spectatorCount, 1);
  for (const player of snapshot.state.players) assert.equal('hand' in player, false);

  await assert.rejects(manager.sendChat(roomId, 'watcher1', 'I am watching'),
    (error) => error instanceof RoomError && error.code === 'NOT_A_MEMBER');
  await assert.rejects(manager.dispatchAction(roomId, 'watcher1', { type: 'PASS', expectedVersion: snapshot.state.version }, 'spectator-command-1'),
    (error) => error instanceof RoomError && error.code === 'NOT_A_MEMBER');
  assert.throws(() => manager.getSnapshot(roomId, 'unknown'),
    (error) => error instanceof RoomError && error.code === 'NOT_A_MEMBER');
});

test('TAKE completes immediately when no remaining attacker can throw a matching rank', async () => {
  const manager = new RoomManager(() => 10_000);
  const { roomId } = manager.createRoom('p1', 'Player1', 2);
  await manager.joinRoom(roomId, 'p2', 'Player2');
  await manager.startGame(roomId, 'p1');

  const engine = manager.getRoom(roomId);
  assert.ok(engine);
  const state = engine.state;
  const attacker = state.players[state.attackerIndex];
  const defender = state.players[state.defenderIndex];
  assert.ok(attacker && defender);
  const attackCard = attacker.hand[0];
  assert.ok(attackCard);

  // Move every other matching-rank card into the discard pile to preserve all 36 cards.
  const moved = attacker.hand.filter((card) => card.id !== attackCard.id && card.rank === attackCard.rank);
  attacker.hand = attacker.hand.filter((card) => card.id === attackCard.id || card.rank !== attackCard.rank);
  state.discardPile.push(...moved);

  await manager.dispatchAction(roomId, attacker.id, {
    type: 'ATTACK', cardId: attackCard.id, expectedVersion: state.version,
  }, 'stage8-attack-001');
  const afterTake = await manager.dispatchAction(roomId, defender.id, {
    type: 'TAKE', expectedVersion: engine.state.version,
  }, 'stage8-take-0001');
  assert.equal(afterTake.state.table.length, 0);
  assert.equal(afterTake.state.isDefenderTaking, false);
  engine.assertCardIntegrity();
});

test('AI action waits in the room queue and notifies room subscribers', async () => {
  const manager = new RoomManager(Date.now, new PersistentStore(null), 75);
  const changed = [];
  manager.setRoomChangeListener((roomId) => changed.push(roomId));
  const { roomId } = await manager.createAiRoom('human', 'Human');
  const engine = manager.getRoom(roomId);
  assert.ok(engine);

  // Force a deterministic human opening attack so the AI has an immediate response.
  const humanIndex = engine.state.players.findIndex((player) => player.id === 'human');
  const aiIndex = engine.state.players.findIndex((player) => player.id === AI_PLAYER_ID);
  assert.ok(humanIndex >= 0 && aiIndex >= 0);
  engine.state.attackerIndex = humanIndex;
  engine.state.defenderIndex = aiIndex;
  engine.state.activeThrowerIndex = humanIndex;
  engine.state.defenderHandStartCount = engine.state.players[aiIndex].hand.length;
  const openingCard = engine.state.players[humanIndex].hand[0];
  assert.ok(openingCard);

  await manager.dispatchAction(roomId, 'human', {
    type: 'ATTACK', cardId: openingCard.id, expectedVersion: engine.state.version,
  }, 'ai-queue-human-1');
  const afterHumanMove = engine.state.version;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(engine.state.version, afterHumanMove, 'the bot must respect the configured delay');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(engine.state.version > afterHumanMove, 'the AI should act after the delay');
  assert.ok(changed.includes(roomId), 'AI state changes should notify subscribers');
  manager.clearAllTimers();
  manager.store.close();
});

test('spectator auth mode is parsed strictly and invalid modes are rejected', () => {
  assert.deepEqual(parseClientMessage(JSON.stringify({
    type: 'AUTH', roomId: '0123456789abcdef', initData: 'signed', mode: 'spectate',
  })), { type: 'AUTH', roomId: '0123456789abcdef', initData: 'signed', mode: 'spectate' });
  assert.throws(() => parseClientMessage(JSON.stringify({
    type: 'AUTH', roomId: '0123456789abcdef', initData: 'signed', mode: 'admin',
  })), (error) => error instanceof ProtocolError && error.code === 'INVALID_AUTH_MODE');
});

test('Mini App uses textContent rather than innerHTML for dynamic data and tracks failed card assets', () => {
  const html = readFileSync(new URL('../apps/mini-app/public/index.html', import.meta.url), 'utf8');
  assert.match(html, /decodedSet/);
  assert.match(html, /failedSet/);
  assert.match(html, /img\.decode\(\)/);
  assert.match(html, /width:68px;height:100px/);
  for (const tab of ['ratingView', 'profileView', 'settingsView', 'lobbyView', 'gameView']) {
    assert.match(html, new RegExp(`id=\"${tab}\"`));
  }
  assert.doesNotMatch(html, /innerHTML/);
});

test('authenticated HTTP API creates public rooms and persists user settings', async (t) => {
  const { createOptimistBackend } = await import('../apps/backend/server.ts');
  const dir = mkdtempSync(join(tmpdir(), 'optimist-stage8-http-'));
  const app = createOptimistBackend({
    botToken: BOT_TOKEN,
    webAppUrl: 'http://localhost:5173',
    port: 0,
    storageFile: join(dir, 'store.json'),
    aiDelayMs: 20,
  });
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await app.listen();
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const initData = signedInitData({ id: 777, first_name: 'Vasya', username: 'vasya' });
  const headers = { 'content-type': 'application/json', 'x-telegram-init-data': initData };

  const unauthenticated = await fetch(`${baseUrl}/api/lobby`);
  assert.equal(unauthenticated.status, 401);

  const createRes = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST', headers, body: JSON.stringify({ maxPlayers: 3, isPublic: true }),
  });
  assert.equal(createRes.status, 201);
  const { roomId } = await createRes.json();
  assert.match(roomId, /^[a-f0-9]{16}$/);

  const [lobbyRes, profileRes, leaderboardRes] = await Promise.all([
    fetch(`${baseUrl}/api/lobby`, { headers }),
    fetch(`${baseUrl}/api/profile`, { headers }),
    fetch(`${baseUrl}/api/leaderboard`, { headers }),
  ]);
  assert.equal(lobbyRes.status, 200);
  assert.equal(profileRes.status, 200);
  assert.equal(leaderboardRes.status, 200);
  assert.equal((await lobbyRes.json()).rooms[0].roomId, roomId);

  const settingsRes = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST', headers, body: JSON.stringify({ trumpPosition: 'left', soundEnabled: false, tableTheme: 'ruby' }),
  });
  assert.equal(settingsRes.status, 200);
  assert.deepEqual((await settingsRes.json()).settings, {
    userId: '777', trumpPosition: 'left', soundEnabled: false, tableTheme: 'ruby',
  });

  const bootstrap = await fetch(`${baseUrl}/api/bootstrap`, { headers });
  assert.equal(bootstrap.status, 200);
  const data = await bootstrap.json();
  assert.equal(data.profile.userId, '777');
  assert.equal(data.settings.trumpPosition, 'left');
  assert.equal(data.lobbyRooms.length, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyTelegramInitData, AuthError } from '../apps/backend/auth.ts';
import { RoomManager, RoomError } from '../apps/backend/RoomManager.ts';

const token = '123456789:abcdefghijklmnopqrstuvwxyzABCDEFG';
function signedInitData(user, authDate) {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: 'AAExample', user: JSON.stringify(user) });
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

test('Telegram initData accepts valid signature and normalizes identity', () => {
  const raw = signedInitData({ id: 12345, first_name: 'Optimist', username: 'optimist' }, 1_700_000_000);
  assert.deepEqual(verifyTelegramInitData(raw, token, { nowSeconds: 1_700_000_010 }), {
    id: '12345', username: 'optimist', firstName: 'Optimist',
  });
});

test('Telegram initData rejects tampering, stale auth_date and future auth_date', () => {
  const valid = signedInitData({ id: 12345, first_name: 'Test' }, 1_700_000_000);
  assert.throws(() => verifyTelegramInitData(valid.replace('12345', '99999'), token, { nowSeconds: 1_700_000_010 }), AuthError);
  assert.throws(() => verifyTelegramInitData(valid, token, { nowSeconds: 1_700_100_000 }), (e) => e instanceof AuthError && e.code === 'EXPIRED_INIT_DATA');
  const future = signedInitData({ id: 12345, first_name: 'Test' }, 1_700_000_100);
  assert.throws(() => verifyTelegramInitData(future, token, { nowSeconds: 1_700_000_000 }), (e) => e instanceof AuthError && e.code === 'EXPIRED_INIT_DATA');
});

test('room rejects non-members and non-owner start attempts', async () => {
  const manager = new RoomManager(() => 10_000);
  const { roomId } = manager.createRoom('owner', 'Owner', 2);
  assert.throws(() => manager.getSnapshot(roomId, 'intruder'), (e) => e instanceof RoomError && e.code === 'NOT_A_MEMBER');
  await manager.joinRoom(roomId, 'guest', 'Guest');
  await assert.rejects(manager.startGame(roomId, 'guest'), (e) => e instanceof RoomError && e.code === 'OWNER_ONLY');
});

test('group lobby rooms require an explicit join and transfer the host when the creator leaves', async () => {
  const manager = new RoomManager(() => 10_000);
  const { roomId } = manager.createRoom('creator', 'Creator', 6, { allowInviteJoin: false });
  assert.equal(manager.canJoinByInvite(roomId), false);
  await assert.rejects(manager.joinRoom(roomId, 'stranger', 'Stranger'), (e) => e instanceof RoomError && e.code === 'NOT_A_MEMBER');
  await manager.joinRoom(roomId, 'friend', 'Friend', true);
  const result = await manager.removeWaitingPlayer(roomId, 'creator');
  assert.equal(result.playerCount, 1);
  assert.equal(result.ownerId, 'friend');
  assert.equal(manager.getOwnerId(roomId), 'friend');
  await assert.rejects(manager.startGame(roomId, 'creator'), (e) => e instanceof RoomError && e.code === 'NOT_A_MEMBER');
  await assert.rejects(manager.startGame(roomId, 'stranger'), (e) => e instanceof RoomError && e.code === 'NOT_A_MEMBER');
});

test('empty waiting rooms can be removed safely from the room manager', async () => {
  const manager = new RoomManager(() => 10_000);
  const { roomId } = manager.createRoom('creator', 'Creator', 2, { allowInviteJoin: false });
  await manager.removeWaitingPlayer(roomId, 'creator');
  assert.equal(await manager.removeRoomIfEmpty(roomId), true);
  assert.equal(manager.getRoom(roomId), undefined);
});

test('room serializes concurrent actions and returns only the viewer hand', async () => {
  const manager = new RoomManager(() => 10_000);
  const { roomId } = manager.createRoom('owner', 'Owner', 2);
  await manager.joinRoom(roomId, 'guest', 'Guest');
  const started = await manager.startGame(roomId, 'owner');
  const state = manager.getRoom(roomId).state;
  const attacker = state.players[state.attackerIndex];
  const card = attacker.hand[0];
  const command = { type: 'ATTACK', cardId: card.id, expectedVersion: state.version };
  const commandId = 'command-0001';
  const results = await Promise.allSettled([
    manager.dispatchAction(roomId, attacker.id, command, commandId),
    manager.dispatchAction(roomId, attacker.id, command, commandId),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2, 'same idempotency key returns safe replay');
  const viewer = manager.getSnapshot(roomId, 'guest');
  assert.equal('hand' in viewer.state.players.find((p) => p.id === 'owner'), false);
  assert.ok(Array.isArray(viewer.state.players.find((p) => p.id === 'guest').hand));
  assert.equal(manager.getRoom(roomId).state.table.length, 1);
  assert.ok(started.state.version < viewer.state.version);
});

test('idempotency key cannot be reused for a different action', async () => {
  const manager = new RoomManager(() => 10_000);
  const { roomId } = manager.createRoom('owner', 'Owner', 2);
  await manager.joinRoom(roomId, 'guest', 'Guest');
  await manager.startGame(roomId, 'owner');
  const state = manager.getRoom(roomId).state;
  const attacker = state.players[state.attackerIndex];
  const first = attacker.hand[0];
  await manager.dispatchAction(roomId, attacker.id, { type: 'ATTACK', cardId: first.id, expectedVersion: state.version }, 'command-0002');
  await assert.rejects(
    manager.dispatchAction(roomId, attacker.id, { type: 'PASS', expectedVersion: manager.getRoom(roomId).state.version }, 'command-0002'),
    (e) => e instanceof RoomError && e.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('chat enforces membership, length, rate limit and a 50-message history', async () => {
  let now = 10_000;
  const manager = new RoomManager(() => now);
  const { roomId } = manager.createRoom('owner', 'Owner', 2);
  await manager.joinRoom(roomId, 'guest', 'Guest');
  await assert.rejects(manager.sendChat(roomId, 'outsider', 'hello'), (e) => e instanceof RoomError && e.code === 'NOT_A_MEMBER');
  await assert.rejects(manager.sendChat(roomId, 'owner', 'x'.repeat(201)), (e) => e instanceof RoomError && e.code === 'MESSAGE_TOO_LONG');
  await manager.sendChat(roomId, 'owner', 'hello');
  await assert.rejects(manager.sendChat(roomId, 'owner', 'too soon'), (e) => e instanceof RoomError && e.code === 'RATE_LIMIT');
  for (let i = 0; i < 55; i++) {
    now += 801;
    await manager.sendChat(roomId, 'guest', `message ${i}`);
  }
  assert.equal(manager.getSnapshot(roomId, 'owner').chatHistory.length, 50);
});

import { parseClientMessage, ProtocolError } from '../apps/backend/protocol.ts';

test('WebSocket protocol rejects malformed, oversized and client-supplied identity fields', () => {
  assert.throws(() => parseClientMessage('{'), (e) => e instanceof ProtocolError && e.code === 'INVALID_JSON');
  assert.throws(() => parseClientMessage('x'.repeat(9_000)), (e) => e instanceof ProtocolError && e.code === 'FRAME_SIZE');
  assert.throws(() => parseClientMessage(JSON.stringify({ type: 'GAME_ACTION', commandId: 'command-123', action: { type: 'ATTACK', playerId: 'victim', cardId: 'hearts_6', expectedVersion: 1 } })), ProtocolError);
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'GAME_ACTION', commandId: 'command-123', action: { type: 'ATTACK', cardId: 'hearts_6', expectedVersion: 1 } })), {
    type: 'GAME_ACTION', commandId: 'command-123', action: { type: 'ATTACK', cardId: 'hearts_6', expectedVersion: 1 },
  });
});

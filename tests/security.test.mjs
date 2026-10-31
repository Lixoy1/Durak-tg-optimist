import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyTelegramInitData, AuthError } from '../apps/backend/auth.ts';
import { RoomManager, RoomError } from '../apps/backend/RoomManager.ts';
import { PersistentStore } from '../apps/backend/storage.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  // The group deep link returns an existing participant to a private chat,
  // where the bot sends a Web App button for this same room. Reopening the
  // room must be idempotent and must not attempt to add a second player.
  const reopened = await manager.joinRoom(roomId, 'friend', 'Friend');
  assert.equal(reopened.state.players.length, 2);
  assert.equal(reopened.state.players.filter((player) => player.id === 'friend').length, 1);
  const result = await manager.removeWaitingPlayer(roomId, 'creator');
  assert.equal(result.playerCount, 1);
  assert.equal(result.ownerId, 'friend');
  assert.equal(manager.getOwnerId(roomId), 'friend');
  await assert.rejects(manager.startGame(roomId, 'creator'), (e) => e instanceof RoomError && e.code === 'NOT_A_MEMBER');
  await assert.rejects(manager.startGame(roomId, 'stranger'), (e) => e instanceof RoomError && e.code === 'NOT_A_MEMBER');
});

test('migrates old saved settings to emerald felt and persists table theme choices', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optimist-settings-'));
  const file = join(dir, 'store.json');
  try {
    writeFileSync(file, JSON.stringify({
      version: 1,
      stats: {},
      settings: {
        legacy: { userId: 'legacy', trumpPosition: 'left', soundEnabled: false },
      },
    }));
    const store = new PersistentStore(file);
    assert.deepEqual(store.getSettings('legacy'), {
      userId: 'legacy',
      trumpPosition: 'left',
      soundEnabled: false,
      tableTheme: 'emerald',
    });
    store.saveSettings('legacy', { tableTheme: 'ruby' });
    store.saveSettings('legacy', { soundEnabled: true });
    assert.deepEqual(store.getSettings('legacy'), {
      userId: 'legacy',
      trumpPosition: 'left',
      soundEnabled: true,
      tableTheme: 'ruby',
    });
    store.close();

    const reopened = new PersistentStore(file);
    assert.equal(reopened.getSettings('legacy').tableTheme, 'ruby');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('empty waiting rooms can be removed safely from the room manager', async () => {
  const manager = new RoomManager(() => 10_000);
  const { roomId } = manager.createRoom('creator', 'Creator', 2, { allowInviteJoin: false });
  await manager.removeWaitingPlayer(roomId, 'creator');
  assert.equal(await manager.removeRoomIfEmpty(roomId), true);
  assert.equal(manager.getRoom(roomId), undefined);
});

test('private group rooms can grant spectator-only access without becoming public', async () => {
  const manager = new RoomManager(() => 15_000);
  const { roomId } = manager.createRoom('owner', 'Owner', 4, { allowInviteJoin: false, allowSpectators: true });
  assert.equal(manager.isPublicRoom(roomId), false);
  await manager.joinRoom(roomId, 'guest', 'Guest', true);
  await assert.rejects(manager.joinRoom(roomId, 'observer', 'Observer'), (e) => e instanceof RoomError && e.code === 'NOT_A_MEMBER');

  const view = await manager.spectateRoom(roomId, 'observer', 'Observer');
  assert.equal(view.viewerRole, 'SPECTATOR');
  assert.equal(view.isPublic, false);
  assert.equal('hand' in view.state.players.find((player) => player.id === 'owner'), false);
  assert.equal(view.spectatorCount, 1);
  assert.equal(manager.getSnapshot(roomId, 'owner').spectatorCount, 1);
});

test('spectator chat is isolated from player chat in both directions', async () => {
  let now = 10_000;
  const manager = new RoomManager(() => now);
  const { roomId } = manager.createRoom('owner', 'Owner', 2, { isPublic: true });
  await manager.joinRoom(roomId, 'guest', 'Guest');
  await manager.spectateRoom(roomId, 'observer');

  const spectatorMessage = await manager.sendSpectatorChat(roomId, 'observer', 'Комментаторы на месте!');
  assert.equal(spectatorMessage.channel, 'SPECTATORS');
  assert.equal(spectatorMessage.senderType, 'SPECTATOR');

  const observerView = manager.getSnapshot(roomId, 'observer');
  const playerView = manager.getSnapshot(roomId, 'owner');
  assert.equal(observerView.chatHistory.length, 0);
  assert.equal(observerView.spectatorChatHistory.length, 1);
  assert.equal(observerView.spectatorChatHistory[0].text, 'Комментаторы на месте!');
  assert.equal(playerView.spectatorChatHistory.length, 0);

  now += 801;
  await manager.sendChat(roomId, 'owner', 'Игроки на связи!');
  assert.equal(manager.getSnapshot(roomId, 'owner').chatHistory.length, 3);
  assert.equal(manager.getSnapshot(roomId, 'owner').chatHistory.at(-1).text, 'Игроки на связи!');
  assert.equal(manager.getSnapshot(roomId, 'observer').spectatorChatHistory.length, 1);
  await assert.rejects(manager.sendChat(roomId, 'observer', 'Не игрок'), (e) => e instanceof RoomError && e.code === 'NOT_A_MEMBER');
  await assert.rejects(manager.sendSpectatorChat(roomId, 'owner', 'Не зритель'), (e) => e instanceof RoomError && e.code === 'SPECTATOR_ONLY');
});

test('spectators can react and trigger cosmetic effects without mutating game state', async () => {
  let now = 20_000;
  const manager = new RoomManager(() => now);
  const { roomId } = manager.createRoom('owner', 'Owner', 2, { isPublic: true });
  await manager.joinRoom(roomId, 'guest', 'Guest');
  await manager.spectateRoom(roomId, 'observer');
  await manager.startGame(roomId, 'owner');
  const before = structuredClone(manager.getRoom(roomId).state);

  const reaction = await manager.sendReaction(roomId, 'observer', '🔥');
  assert.equal(reaction.reaction, '🔥');
  assert.equal(reaction.senderName, 'Зритель');
  await assert.rejects(manager.sendReaction(roomId, 'observer', '😎'), (e) => e instanceof RoomError && e.code === 'RATE_LIMIT');

  now += 4_001;
  const effect = await manager.sendTableEffect(roomId, 'observer', 'curse');
  assert.equal(effect.effect, 'curse');
  assert.equal(effect.senderName, 'Зритель');
  assert.deepEqual(manager.getRoom(roomId).state, before, 'cosmetic effects must never change game rules or state');
  await assert.rejects(manager.sendTableEffect(roomId, 'observer', 'buff'), (e) => e instanceof RoomError && e.code === 'RATE_LIMIT');
  await assert.rejects(manager.sendReaction(roomId, 'outsider', '🔥'), (e) => e instanceof RoomError && e.code === 'NOT_A_MEMBER');
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

test('WebSocket protocol validates spectator chat, reactions and cosmetic effects', () => {
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'SEND_SPECTATOR_CHAT', text: 'Трибуна на связи!' })), {
    type: 'SEND_SPECTATOR_CHAT', text: 'Трибуна на связи!',
  });
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'SEND_REACTION', reaction: '👑' })), {
    type: 'SEND_REACTION', reaction: '👑',
  });
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'SEND_TABLE_EFFECT', effect: 'phoenix' })), {
    type: 'SEND_TABLE_EFFECT', effect: 'phoenix',
  });
  assert.throws(() => parseClientMessage(JSON.stringify({ type: 'SEND_REACTION', reaction: '💸' })), (e) => e instanceof ProtocolError && e.code === 'INVALID_REACTION');
  assert.throws(() => parseClientMessage(JSON.stringify({ type: 'SEND_TABLE_EFFECT', effect: 'pay_to_win' })), (e) => e instanceof ProtocolError && e.code === 'INVALID_TABLE_EFFECT');
});

test('WebSocket protocol rejects malformed, oversized and client-supplied identity fields', () => {
  assert.throws(() => parseClientMessage('{'), (e) => e instanceof ProtocolError && e.code === 'INVALID_JSON');
  assert.throws(() => parseClientMessage('x'.repeat(9_000)), (e) => e instanceof ProtocolError && e.code === 'FRAME_SIZE');
  assert.throws(() => parseClientMessage(JSON.stringify({ type: 'GAME_ACTION', commandId: 'command-123', action: { type: 'ATTACK', playerId: 'victim', cardId: 'hearts_6', expectedVersion: 1 } })), ProtocolError);
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'GAME_ACTION', commandId: 'command-123', action: { type: 'ATTACK', cardId: 'hearts_6', expectedVersion: 1 } })), {
    type: 'GAME_ACTION', commandId: 'command-123', action: { type: 'ATTACK', cardId: 'hearts_6', expectedVersion: 1 },
  });
});

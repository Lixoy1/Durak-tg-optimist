import test from 'node:test';
import assert from 'node:assert/strict';
import { DurakEngine, GameRuleError, formatCardName } from '../packages/game-engine/DurakEngine.ts';
import { computeBotAction, runStressSimulation } from '../packages/game-engine/simulator.ts';

function makeEngine(n = 4, config = { maxPlayers: n, firstBoutMaxCards: 6 }) {
  const engine = new DurakEngine(`test_${n}_${Math.random()}`, config);
  for (let i = 0; i < n; i++) engine.addPlayer(`p${i}`, `Player ${i}`);
  engine.startGame();
  return engine;
}

test('formats cards in clear Russian names for player-facing rule messages', () => {
  assert.equal(formatCardName({ rank: 10, suit: 'hearts' }), '10 червей');
  assert.equal(formatCardName({ rank: 13, suit: 'hearts' }), 'король червей');
  assert.equal(formatCardName({ rank: 13, suit: 'hearts' }, 'accusative'), 'короля червей');
  assert.equal(formatCardName({ rank: 9, suit: 'diamonds' }), '9 бубен');
  assert.equal(formatCardName({ rank: 11, suit: 'spades' }), 'валет пик');
});

test('deals exactly 36 unique cards for 2–6 players', () => {
  for (let n = 2; n <= 6; n++) {
    const engine = makeEngine(n, { maxPlayers: n, firstBoutMaxCards: 6 });
    assert.equal(engine.state.players.length, n);
    assert.ok(engine.state.players.every((p) => p.hand.length === 6));
    assert.equal(engine.state.deck.length, 36 - 6 * n);
    engine.assertCardIntegrity();
  }
});

test('six-player deal uses a dealt card as the visible trump indicator and preserves all 36 cards', () => {
  const engine = new DurakEngine('six-player-room', { maxPlayers: 6, firstBoutMaxCards: 6 });
  for (let i = 0; i < 6; i++) engine.addPlayer(`p${i}`, `Player ${i}`);
  engine.startGame();
  assert.equal(engine.state.deck.length, 0);
  assert.ok(engine.state.trumpCard);
  assert.equal(engine.state.trumpCard.suit, engine.state.trumpSuit);
  assert.equal(engine.state.players[5].hand.some((card) => card.id === engine.state.trumpCard.id), true);
  engine.assertCardIntegrity();
  const publicState = engine.getPublicStateForPlayer('p0');
  assert.equal(publicState.trumpCard?.id, engine.state.trumpCard.id);
  assert.equal(publicState.players.find((player) => player.id === 'p0').hand.length, 6);
  assert.equal(publicState.players.find((player) => player.id === 'p1').hand, undefined);
});

test('six-player gameplay completes with 36-card integrity intact', () => {
  for (let gameNumber = 0; gameNumber < 10; gameNumber++) {
    const engine = new DurakEngine(`six-player-sim-${gameNumber}`, { maxPlayers: 6, firstBoutMaxCards: 6 });
    for (let i = 0; i < 6; i++) engine.addPlayer(`p${i}`, `Player ${i}`);
    engine.startGame();
    let steps = 0;
    while (engine.state.phase === 'PLAYING' && steps < 5_000) {
      steps++;
      const activeId = engine.state.players[engine.state.activeThrowerIndex]?.id;
      const defenderId = engine.state.players[engine.state.defenderIndex]?.id;
      let action = defenderId ? computeBotAction(engine, defenderId) : null;
      if (!action && activeId) action = computeBotAction(engine, activeId);
      assert.ok(action, `deadlock in six-player game ${gameNumber} at step ${steps}`);
      engine.dispatch(action);
      engine.assertCardIntegrity();
    }
    assert.equal(engine.state.phase, 'GAME_OVER', `six-player game ${gameNumber} did not finish`);
  }
});

test('cannot start the same game twice', () => {
  const engine = makeEngine(2);
  const before = structuredClone(engine.state);
  assert.throws(() => engine.startGame(), (e) => e instanceof GameRuleError && e.code === 'GAME_ALREADY_STARTED');
  assert.deepEqual(engine.state, before);
});

test('rejects stale versions without mutating state', () => {
  const engine = makeEngine(2);
  const before = structuredClone(engine.state);
  const actor = engine.state.players[engine.state.attackerIndex].id;
  assert.throws(() => engine.dispatch({ type: 'ATTACK', playerId: actor, cardId: 'missing', expectedVersion: engine.state.version - 1 }),
    (e) => e instanceof GameRuleError && e.code === 'CONFLICT_VERSION');
  assert.deepEqual(engine.state, before);
});

test('does not leak other players’ hands in public state', () => {
  const engine = makeEngine(3);
  const viewer = engine.state.players[0].id;
  const snapshot = engine.getPublicStateForPlayer(viewer);
  assert.ok(Array.isArray(snapshot.players.find((p) => p.id === viewer).hand));
  for (const player of snapshot.players.filter((p) => p.id !== viewer)) assert.equal('hand' in player, false);
});

test('only the active thrower can attack and invalid actions are atomic', () => {
  const engine = makeEngine(3);
  const before = structuredClone(engine.state);
  const offTurn = engine.state.players.find((p, idx) => idx !== engine.state.activeThrowerIndex && idx !== engine.state.defenderIndex);
  if (!offTurn) return;
  assert.throws(() => engine.dispatch({ type: 'ATTACK', playerId: offTurn.id, cardId: offTurn.hand[0].id, expectedVersion: engine.state.version }),
    (e) => e instanceof GameRuleError && e.code === 'NOT_YOUR_TURN');
  assert.deepEqual(engine.state, before);
});

test('the current attacker keeps the turn until PASS', () => {
  const engine = makeEngine(4);
  const oldAttacker = engine.state.attackerIndex;
  const actor = engine.state.players[oldAttacker];
  const card = actor.hand[0];
  engine.dispatch({ type: 'ATTACK', playerId: actor.id, cardId: card.id, expectedVersion: engine.state.version });
  assert.equal(engine.state.activeThrowerIndex, oldAttacker);
  assert.equal(engine.state.table.length, 1);
  engine.dispatch({ type: 'PASS', playerId: actor.id, expectedVersion: engine.state.version });
  assert.notEqual(engine.state.activeThrowerIndex, oldAttacker);
});



test('rejects a throw-in whose rank is not present and keeps state unchanged', () => {
  const engine = makeEngine(4);
  const attacker = engine.state.players[engine.state.attackerIndex];
  const first = attacker.hand[0];
  engine.dispatch({ type: 'ATTACK', playerId: attacker.id, cardId: first.id, expectedVersion: engine.state.version });
  const invalid = attacker.hand.find((card) => card.rank !== first.rank);
  assert.ok(invalid);
  const before = structuredClone(engine.state);
  assert.throws(() => engine.dispatch({ type: 'ATTACK', playerId: attacker.id, cardId: invalid.id, expectedVersion: engine.state.version }),
    (e) => e instanceof GameRuleError && e.code === 'INVALID_THROW_IN_RANK');
  assert.deepEqual(engine.state, before);
});

test('does not allow PASS before the first attack', () => {
  const engine = new DurakEngine('waiting_pass', { maxPlayers: 2, firstBoutMaxCards: 6 });
  engine.addPlayer('p1', 'One');
  engine.addPlayer('p2', 'Two');
  engine.startGame();
  // The table is empty at the beginning of the first bout.
  const actor = engine.state.players[engine.state.activeThrowerIndex];
  assert.throws(() => engine.dispatch({ type: 'PASS', playerId: actor.id, expectedVersion: engine.state.version }),
    (e) => e instanceof GameRuleError && e.code === 'EMPTY_TABLE');
  assert.equal(engine.state.table.length, 0);
});

test('explains an invalid defense using Russian card names', () => {
  const engine = makeEngine(2);
  const allCards = [...engine.state.deck, ...engine.state.players.flatMap((player) => player.hand)];
  const attack = allCards.find((card) => card.suit === 'hearts' && card.rank === 13);
  const defense = allCards.find((card) => card.suit === 'hearts' && card.rank === 10);
  assert.ok(attack);
  assert.ok(defense);

  const defender = engine.state.players[engine.state.defenderIndex];
  engine.state.deck = allCards.filter((card) => card.id !== attack.id && card.id !== defense.id);
  for (const player of engine.state.players) player.hand = [];
  defender.hand = [defense];
  engine.state.table = [{ attack, defense: null }];

  assert.throws(
    () => engine.dispatch({
      type: 'DEFEND',
      playerId: defender.id,
      attackIndex: 0,
      cardId: defense.id,
      expectedVersion: engine.state.version,
    }),
    (error) => error instanceof GameRuleError
      && error.code === 'CANNOT_BEAT'
      && error.message === '10 червей не побьёт короля червей. Нужна карта старше той же масти или козырь.',
  );
});

test('allows same-suit higher card and trump to beat non-trump, but not the reverse', () => {
  const engine = makeEngine(2);
  const trump = engine.state.trumpSuit;
  const nonTrump = ['clubs', 'spades', 'diamonds', 'hearts'].find((suit) => suit !== trump);
  const sameSuitLow = { id: 'x1', suit: 'clubs', rank: 7, assetPath: '' };
  const sameSuitHigh = { id: 'x2', suit: 'clubs', rank: 8, assetPath: '' };
  assert.equal(engine.canBeat(sameSuitLow, sameSuitHigh), true);
  assert.equal(engine.canBeat(sameSuitHigh, sameSuitLow), false);
  const attack = { id: 'x3', suit: nonTrump, rank: 14, assetPath: '' };
  const trumpDefense = { id: 'x4', suit: trump, rank: 6, assetPath: '' };
  assert.equal(engine.canBeat(attack, trumpDefense), true);
  assert.equal(engine.canBeat(trumpDefense, attack), false);
});

test('the game engine passes 1,000 full bot games and preserves card integrity', () => {
  const summary = runStressSimulation(1_000, 5_000);
  assert.equal(summary.completed, 1_000);
  assert.ok(summary.maxSteps < 5_000);
});

import type { Card, GameAction } from '../shared-types/index.ts';
import { DurakEngine } from './DurakEngine.ts';

function cardCost(card: Card, trumpSuit: string | null): number {
  return card.rank + (card.suit === trumpSuit ? 100 : 0);
}

/** Small deterministic-policy bot used for smoke tests, not intended as competitive AI. */
export function computeBotAction(engine: DurakEngine, botId: string): GameAction | null {
  const state = engine.state;
  if (state.phase !== 'PLAYING') return null;
  const botIndex = state.players.findIndex((p) => p.id === botId);
  if (botIndex < 0 || state.players[botIndex]!.status !== 'ACTIVE') return null;
  const bot = state.players[botIndex]!;
  const sortedHand = [...bot.hand].sort((a, b) => cardCost(a, state.trumpSuit) - cardCost(b, state.trumpSuit));

  if (botIndex === state.defenderIndex && !state.isDefenderTaking) {
    const uncoveredIndex = state.table.findIndex((pair) => pair.defense === null);
    if (uncoveredIndex >= 0) {
      const attackCard = state.table[uncoveredIndex]!.attack;
      const defense = sortedHand.find((card) => engine.canBeat(attackCard, card));
      if (defense) {
        return { type: 'DEFEND', playerId: botId, attackIndex: uncoveredIndex, cardId: defense.id, expectedVersion: state.version };
      }
      return { type: 'TAKE', playerId: botId, expectedVersion: state.version };
    }
  }

  if (botIndex !== state.activeThrowerIndex) return null;
  if (state.table.length === 0) {
    const card = sortedHand[0];
    return card ? { type: 'ATTACK', playerId: botId, cardId: card.id, expectedVersion: state.version } : null;
  }

  const maxCards = Math.min(state.isFirstBoutCompleted ? 6 : state.config.firstBoutMaxCards, state.defenderHandStartCount);
  if (state.table.length < maxCards) {
    const ranksOnTable = new Set<number>();
    for (const pair of state.table) {
      ranksOnTable.add(pair.attack.rank);
      if (pair.defense) ranksOnTable.add(pair.defense.rank);
    }
    const candidate = sortedHand.find((card) => ranksOnTable.has(card.rank) && card.suit !== state.trumpSuit)
      ?? sortedHand.find((card) => ranksOnTable.has(card.rank));
    if (candidate) return { type: 'ATTACK', playerId: botId, cardId: candidate.id, expectedVersion: state.version };
  }
  return { type: 'PASS', playerId: botId, expectedVersion: state.version };
}

export interface SimulationSummary {
  games: number;
  completed: number;
  draws: number;
  maxSteps: number;
}

export function runStressSimulation(gamesCount = 1_000, maxStepsPerGame = 5_000): SimulationSummary {
  if (!Number.isInteger(gamesCount) || gamesCount < 1) throw new RangeError('gamesCount must be >= 1');
  let completed = 0;
  let draws = 0;
  let maxStepsObserved = 0;

  for (let gameNumber = 0; gameNumber < gamesCount; gameNumber++) {
    const playerCount = 2 + (gameNumber % 5); // Exercise every supported table size from 2 to 6 players.
    const ids = Array.from({ length: playerCount }, (_, index) => `bot_${index + 1}`);
    const engine = new DurakEngine(`sim_${gameNumber}`, { maxPlayers: playerCount, firstBoutMaxCards: 6 });
    ids.forEach((id) => engine.addPlayer(id, id));
    engine.startGame();

    let steps = 0;
    while (engine.state.phase === 'PLAYING' && steps < maxStepsPerGame) {
      steps++;
      let action: GameAction | null = null;
      // Only one active player can act per cycle; let the current actor answer.
      const activeId = engine.state.players[engine.state.activeThrowerIndex]?.id;
      const defenderId = engine.state.players[engine.state.defenderIndex]?.id;
      if (defenderId) action = computeBotAction(engine, defenderId);
      if (!action && activeId) action = computeBotAction(engine, activeId);
      if (!action) {
        throw new Error(`DEADLOCK in ${engine.state.roomId} at step ${steps}; phase=${engine.state.phase}, thrower=${activeId}, defender=${defenderId}`);
      }
      engine.dispatch(action);
      engine.assertCardIntegrity();
    }
    if (engine.state.phase !== 'GAME_OVER') {
      throw new Error(`Game ${engine.state.roomId} did not finish within ${maxStepsPerGame} actions.`);
    }
    completed++;
    if (engine.state.loserId === null) draws++;
    maxStepsObserved = Math.max(maxStepsObserved, steps);
  }

  return { games: gamesCount, completed, draws, maxSteps: maxStepsObserved };
}

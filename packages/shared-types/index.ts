export type Suit = 'clubs' | 'spades' | 'diamonds' | 'hearts';
export type Rank = 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
export type PlayerStatus = 'ACTIVE' | 'OUT_WINNER' | 'LOSER_DURAK';
export type GamePhase = 'WAITING_FOR_PLAYERS' | 'PLAYING' | 'GAME_OVER';
export type GameMode = 'PODKIDNOY' | 'PEREVODNOY';
export type AfterTakeRule = 'ATTACKER' | 'DEFENDER';

export interface Card {
  id: string;
  suit: Suit;
  rank: Rank;
  assetPath: string;
}

export interface TablePair {
  attack: Card;
  defense: Card | null;
}

export interface PlayerState {
  id: string;
  username: string;
  hand: Card[];
  status: PlayerStatus;
  /** Finishing position; equal positions are allowed for simultaneous exits. */
  finishOrder: number | null;
  /** Once a player passes, they cannot throw in again during this bout. */
  hasPassedBout: boolean;
}

export interface GameConfig {
  maxPlayers: number;
  /** Opening-bout attack cap: 6 for standard rules; 5 is an optional house-rule variant. */
  firstBoutMaxCards: 5 | 6;
  /** Defaults to PODKIDNOY for old room-creation payloads. */
  mode?: GameMode;
  /** Who leads the next bout after the defender takes the cards. */
  afterTake?: AfterTakeRule;
}

export interface GameState {
  roomId: string;
  version: number;
  phase: GamePhase;
  config: GameConfig;
  /** The live stock, with the exposed trump card at index 0 (the last card drawn). */
  deck: Card[];
  discardPile: Card[];
  /** Reference to the exposed trump card; it is also present in deck until drawn. */
  trumpCard: Card | null;
  trumpSuit: Suit | null;
  players: PlayerState[];
  attackerIndex: number;
  defenderIndex: number;
  /** Next eligible opponent allowed to add an attack card, or -1 when none remain. */
  activeThrowerIndex: number;
  /** Number of cards the defender held when this bout began. */
  defenderHandStartCount: number;
  isDefenderTaking: boolean;
  isFirstBoutCompleted: boolean;
  table: TablePair[];
  loserId: string | null;
}

export type GameAction =
  | { type: 'ATTACK'; playerId: string; cardId: string; expectedVersion: number }
  | { type: 'DEFEND'; playerId: string; attackIndex: number; cardId: string; expectedVersion: number }
  | { type: 'TAKE'; playerId: string; expectedVersion: number }
  | { type: 'PASS'; playerId: string; expectedVersion: number }
  | { type: 'TRANSFER'; playerId: string; cardId: string; expectedVersion: number };

/** Client-originated action shape; playerId is always injected by the authenticated server session. */
export type GameActionInput =
  | { type: 'ATTACK'; cardId: string; expectedVersion: number }
  | { type: 'DEFEND'; attackIndex: number; cardId: string; expectedVersion: number }
  | { type: 'TAKE'; expectedVersion: number }
  | { type: 'PASS'; expectedVersion: number }
  | { type: 'TRANSFER'; cardId: string; expectedVersion: number };

export interface PublicPlayerState {
  id: string;
  username: string;
  status: PlayerStatus;
  finishOrder: number | null;
  hasPassedBout: boolean;
  cardCount: number;
  hand?: Card[];
}

export interface PublicGameState {
  roomId: string;
  version: number;
  phase: GamePhase;
  deckCount: number;
  discardCount: number;
  trumpCard: Card | null;
  trumpSuit: Suit | null;
  attackerId: string | undefined;
  defenderId: string | undefined;
  activeThrowerId: string | undefined;
  defenderHandStartCount: number;
  isDefenderTaking: boolean;
  table: TablePair[];
  loserId: string | null;
  players: PublicPlayerState[];
}

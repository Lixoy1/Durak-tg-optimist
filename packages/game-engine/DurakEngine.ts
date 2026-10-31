import type {
  Card,
  GameAction,
  GameConfig,
  GameState,
  PlayerState,
  PublicGameState,
  Rank,
  Suit,
} from '../shared-types/index.ts';

const SUITS: Suit[] = ['clubs', 'spades', 'diamonds', 'hearts'];
const RANKS: Rank[] = [6, 7, 8, 9, 10, 11, 12, 13, 14];
const RANK_FILE_MAP: Record<Rank, string> = {
  6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

const SUIT_NAME: Record<Suit, string> = {
  clubs: 'треф',
  spades: 'пик',
  diamonds: 'бубен',
  hearts: 'червей',
};

/** Russian card name for clear player-facing rule messages. */
export function formatCardName(
  card: Pick<Card, 'rank' | 'suit'>,
  grammaticalCase: 'nominative' | 'accusative' = 'nominative',
): string {
  const rankNames: Record<number, { nominative: string; accusative: string }> = {
    11: { nominative: 'валет', accusative: 'валета' },
    12: { nominative: 'дама', accusative: 'даму' },
    13: { nominative: 'король', accusative: 'короля' },
    14: { nominative: 'туз', accusative: 'туза' },
  };
  const namedRank = rankNames[card.rank];
  const rank = namedRank ? namedRank[grammaticalCase] : String(card.rank);
  return `${rank} ${SUIT_NAME[card.suit]}`;
}

export class GameRuleError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GameRuleError';
    this.code = code;
  }
}

/** Inject randomIndex in tests to make shuffles repeatable; production uses Web Crypto. */
export type RandomIndex = (maxExclusive: number) => number;

function secureRandomIndex(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new RangeError('maxExclusive must be a positive integer');
  }
  // Rejection sampling avoids modulo bias for Fisher–Yates shuffle.
  const range = 0x1_0000_0000;
  const limit = Math.floor(range / maxExclusive) * maxExclusive;
  const values = new Uint32Array(1);
  let value: number;
  do {
    globalThis.crypto.getRandomValues(values);
    value = values[0]!;
  } while (value >= limit);
  return value % maxExclusive;
}

export class DurakEngine {
  public state: GameState;
  private readonly randomIndex: RandomIndex;

  constructor(
    roomId: string,
    config: GameConfig = { maxPlayers: 4, firstBoutMaxCards: 6, mode: 'PODKIDNOY', afterTake: 'ATTACKER' },
    randomIndex: RandomIndex = secureRandomIndex,
  ) {
    if (!roomId.trim()) throw new GameRuleError('INVALID_ROOM', 'У партии должен быть идентификатор комнаты.');
    if (!Number.isInteger(config.maxPlayers) || config.maxPlayers < 2 || config.maxPlayers > 6) {
      throw new GameRuleError('INVALID_PLAYER_LIMIT', 'В стандартном режиме 36 карт поддерживается от 2 до 6 игроков.');
    }
    if (config.firstBoutMaxCards !== 5 && config.firstBoutMaxCards !== 6) {
      throw new GameRuleError('INVALID_CONFIG', 'Лимит первого захода должен быть 5 или 6 карт.');
    }
    if (config.mode !== undefined && config.mode !== 'PODKIDNOY' && config.mode !== 'PEREVODNOY') {
      throw new GameRuleError('INVALID_CONFIG', 'Неизвестный режим игры.');
    }
    if (config.afterTake !== undefined && config.afterTake !== 'ATTACKER' && config.afterTake !== 'DEFENDER') {
      throw new GameRuleError('INVALID_CONFIG', 'Некорректное правило следующего хода.');
    }
    this.randomIndex = randomIndex;
    this.state = {
      roomId,
      version: 1,
      phase: 'WAITING_FOR_PLAYERS',
      config: { ...config, mode: config.mode ?? 'PODKIDNOY', afterTake: config.afterTake ?? 'ATTACKER' },
      deck: [],
      discardPile: [],
      trumpCard: null,
      trumpSuit: null,
      players: [],
      attackerIndex: -1,
      defenderIndex: -1,
      activeThrowerIndex: -1,
      defenderHandStartCount: 0,
      isDefenderTaking: false,
      isFirstBoutCompleted: false,
      table: [],
      loserId: null,
    };
  }

  public addPlayer(id: string, username: string): void {
    if (this.state.phase !== 'WAITING_FOR_PLAYERS') {
      throw new GameRuleError('GAME_ALREADY_STARTED', 'Партия уже началась.');
    }
    if (!id.trim()) throw new GameRuleError('INVALID_PLAYER_ID', 'У игрока должен быть ID.');
    if (this.state.players.some((p) => p.id === id)) {
      throw new GameRuleError('PLAYER_ALREADY_JOINED', 'Игрок уже за столом.');
    }
    if (this.state.players.length >= this.state.config.maxPlayers) {
      throw new GameRuleError('ROOM_FULL', 'Стол заполнен.');
    }
    this.state.players.push({
      id,
      username: username.trim().slice(0, 64) || 'Игрок',
      hand: [],
      status: 'ACTIVE',
      finishOrder: null,
      hasPassedBout: false,
    });
    this.state.version++;
  }

  public startGame(): void {
    if (this.state.phase !== 'WAITING_FOR_PLAYERS') {
      throw new GameRuleError('GAME_ALREADY_STARTED', 'Эту партию уже запускали.');
    }
    if (this.state.players.length < 2 || this.state.players.length > this.state.config.maxPlayers) {
      throw new GameRuleError('NOT_ENOUGH_PLAYERS', 'Для старта нужно от 2 игроков и не больше лимита стола.');
    }

    let dealt = false;
    // A two-player deal can, rarely, leave no trump in either hand. Retry a few times;
    // the deterministic fallback prevents an unbounded loop and keeps every card accounted for.
    for (let attempt = 0; attempt < 8 && !dealt; attempt++) {
      this.dealFreshHands();
      const holder = this.findLowestTrumpPlayerIndex(this.state.trumpSuit!);
      if (holder !== -1) {
        this.state.attackerIndex = holder;
        dealt = true;
      }
    }
    if (!dealt) {
      this.state.attackerIndex = 0;
    }

    this.state.defenderIndex = this.nextActivePlayerIndex(this.state.attackerIndex);
    this.state.activeThrowerIndex = this.state.attackerIndex;
    this.state.defenderHandStartCount = this.state.players[this.state.defenderIndex]!.hand.length;
    this.state.phase = 'PLAYING';
    this.state.version++;
    this.assertCardIntegrity();
  }

  /** The only supported entry point for player actions. Invalid actions are atomic no-ops. */
  public dispatch(action: GameAction): GameState {
    if (this.state.phase !== 'PLAYING') {
      throw new GameRuleError('GAME_NOT_ACTIVE', 'Партия не находится в активной фазе.');
    }
    if (!Number.isInteger(action.expectedVersion) || action.expectedVersion !== this.state.version) {
      throw new GameRuleError('CONFLICT_VERSION', 'Состояние стола изменилось. Обновите данные.');
    }

    const before = structuredClone(this.state);
    try {
      switch (action.type) {
        case 'ATTACK':
          this.handleAttack(action.playerId, action.cardId);
          break;
        case 'DEFEND':
          this.handleDefend(action.playerId, action.attackIndex, action.cardId);
          break;
        case 'TAKE':
          this.handleTake(action.playerId);
          break;
        case 'PASS':
          this.handlePass(action.playerId);
          break;
        case 'TRANSFER':
          this.handleTransfer(action.playerId, action.cardId);
          break;
        default: {
          const unreachable: never = action;
          throw new GameRuleError('UNKNOWN_ACTION', `Неизвестное действие: ${String(unreachable)}`);
        }
      }
      this.state.version++;
      this.assertCardIntegrity();
      return this.state;
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  public canBeat(attackCard: Card, defenseCard: Card): boolean {
    if (defenseCard.suit === attackCard.suit) return defenseCard.rank > attackCard.rank;
    return defenseCard.suit === this.state.trumpSuit && attackCard.suit !== this.state.trumpSuit;
  }

  public getPublicStateForPlayer(viewerId: string): PublicGameState {
    return {
      roomId: this.state.roomId,
      version: this.state.version,
      phase: this.state.phase,
      config: { ...this.state.config },
      deckCount: this.state.deck.length,
      discardCount: this.state.discardPile.length,
      trumpCard: this.state.trumpCard,
      trumpSuit: this.state.trumpSuit,
      attackerId: this.state.players[this.state.attackerIndex]?.id,
      defenderId: this.state.players[this.state.defenderIndex]?.id,
      activeThrowerId: this.state.players[this.state.activeThrowerIndex]?.id,
      defenderHandStartCount: this.state.defenderHandStartCount,
      isDefenderTaking: this.state.isDefenderTaking,
      table: structuredClone(this.state.table),
      loserId: this.state.loserId,
      players: this.state.players.map((p) => ({
        id: p.id,
        username: p.username,
        status: p.status,
        finishOrder: p.finishOrder,
        hasPassedBout: p.hasPassedBout,
        cardCount: p.hand.length,
        ...(p.id === viewerId ? { hand: structuredClone(p.hand) } : {}),
      })),
    };
  }

  public assertCardIntegrity(): void {
    // No cards are dealt while waiting for players.
    if (this.state.phase === 'WAITING_FOR_PLAYERS') return;
    const seen = new Set<string>();
    const collect = (card: Card): void => {
      if (seen.has(card.id)) {
        throw new GameRuleError('CRITICAL_DUPLICATE_CARD', `Обнаружен дубликат карты ${card.id}.`);
      }
      seen.add(card.id);
    };

    this.state.deck.forEach(collect);
    this.state.discardPile.forEach(collect);
    this.state.players.forEach((p) => p.hand.forEach(collect));
    this.state.table.forEach((pair) => {
      collect(pair.attack);
      if (pair.defense) collect(pair.defense);
    });
    if (seen.size !== 36) {
      throw new GameRuleError('CRITICAL_DECK_COUNT', `Нарушен баланс колоды: найдено ${seen.size} карт из 36.`);
    }
  }

  private dealFreshHands(): void {
    const deck = this.createShuffledDeck();
    for (const player of this.state.players) {
      player.hand = [];
      player.status = 'ACTIVE';
      player.finishOrder = null;
      player.hasPassedBout = false;
    }
    // Deal one card at a time around the table, six cards per player.
    for (let round = 0; round < 6; round++) {
      for (const player of this.state.players) player.hand.push(deck.pop()!);
    }
    // With 2–5 players, the next card is the exposed trump at the bottom of the stock.
    // With 6 players all 36 cards are dealt. In that house-rule edge case, use the
    // final card dealt to the last player as the visible trump indicator; the card
    // stays in that player's hand and is still counted only once by integrity checks.
    let trumpCard: Card;
    if (deck.length > 0) {
      trumpCard = deck[0]!;
    } else {
      const lastPlayer = this.state.players[this.state.players.length - 1];
      const lastCard = lastPlayer?.hand[lastPlayer.hand.length - 1];
      if (!lastCard) throw new GameRuleError('MISSING_TRUMP', 'Не удалось определить козырь для полного стола.');
      trumpCard = lastCard;
    }
    this.state.deck = deck;
    this.state.trumpCard = trumpCard;
    this.state.trumpSuit = trumpCard.suit;
    this.state.discardPile = [];
    this.state.table = [];
    this.state.loserId = null;
    this.state.isDefenderTaking = false;
    this.state.isFirstBoutCompleted = false;
    this.state.defenderHandStartCount = 0;
  }

  private createShuffledDeck(): Card[] {
    const deck: Card[] = [];
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        deck.push({
          id: `${suit}_${rank}`,
          suit,
          rank,
          assetPath: `assets/cards/${suit}/${RANK_FILE_MAP[rank]}.webp`,
        });
      }
    }
    for (let i = deck.length - 1; i > 0; i--) {
      const j = this.randomIndex(i + 1);
      if (!Number.isInteger(j) || j < 0 || j > i) {
        throw new GameRuleError('INVALID_RANDOM_SOURCE', 'Источник случайных чисел вернул недопустимый индекс.');
      }
      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
    return deck;
  }

  private findLowestTrumpPlayerIndex(trumpSuit: Suit): number {
    let lowestRank = Number.POSITIVE_INFINITY;
    let holderIndex = -1;
    this.state.players.forEach((player, index) => {
      for (const card of player.hand) {
        if (card.suit === trumpSuit && card.rank < lowestRank) {
          lowestRank = card.rank;
          holderIndex = index;
        }
      }
    });
    return holderIndex;
  }

  private handleAttack(playerId: string, cardId: string): void {
    const playerIndex = this.getActivePlayerIndex(playerId);
    const player = this.state.players[playerIndex]!;
    if (playerIndex !== this.state.activeThrowerIndex) {
      throw new GameRuleError('NOT_YOUR_TURN', 'Сейчас не ваша очередь атаковать или подкидывать.');
    }
    if (playerIndex === this.state.defenderIndex) {
      throw new GameRuleError('DEFENDER_CANNOT_ATTACK', 'Защищающийся не может подкидывать карты.');
    }
    if (this.state.isDefenderTaking === false && this.state.table.length === 0 && playerIndex !== this.state.attackerIndex) {
      throw new GameRuleError('INVALID_OPENING_ATTACKER', 'Первую карту выкладывает только основной атакующий.');
    }

    const cardIndex = player.hand.findIndex((card) => card.id === cardId);
    if (cardIndex < 0) throw new GameRuleError('CARD_NOT_IN_HAND', 'Указанной карты нет у вас в руке.');
    if (this.state.table.length >= this.maxAttackCardsThisBout()) {
      throw new GameRuleError('ATTACK_LIMIT_REACHED', 'На столе уже максимальное количество атакующих карт.');
    }

    const card = player.hand[cardIndex]!;
    if (this.state.table.length > 0) {
      const ranksOnTable = new Set<number>();
      for (const pair of this.state.table) {
        ranksOnTable.add(pair.attack.rank);
        if (pair.defense) ranksOnTable.add(pair.defense.rank);
      }
      if (!ranksOnTable.has(card.rank)) {
        throw new GameRuleError('INVALID_THROW_IN_RANK', 'Подкидывать можно только достоинства, уже присутствующие на столе.');
      }
    }

    player.hand.splice(cardIndex, 1);
    this.state.table.push({ attack: card, defense: null });
    // The current thrower may add several cards in succession; only PASS transfers the turn.
    this.state.activeThrowerIndex = playerIndex;
    this.maybeCompleteBout();
  }

  private handleDefend(playerId: string, attackIndex: number, cardId: string): void {
    const playerIndex = this.getActivePlayerIndex(playerId);
    if (playerIndex !== this.state.defenderIndex) {
      throw new GameRuleError('NOT_DEFENDER', 'Только защищающийся может отбиваться.');
    }
    if (this.state.isDefenderTaking) {
      throw new GameRuleError('ALREADY_TAKING', 'Вы уже объявили «Беру» и не можете продолжить защиту.');
    }
    if (!Number.isInteger(attackIndex)) throw new GameRuleError('INVALID_ATTACK_INDEX', 'Некорректная карта атаки.');
    const pair = this.state.table[attackIndex];
    if (!pair) throw new GameRuleError('INVALID_ATTACK_INDEX', 'Эта карта атаки не найдена на столе.');
    if (pair.defense !== null) throw new GameRuleError('ALREADY_DEFENDED', 'Эта карта уже побита.');

    const defender = this.state.players[playerIndex]!;
    const cardIndex = defender.hand.findIndex((card) => card.id === cardId);
    if (cardIndex < 0) throw new GameRuleError('CARD_NOT_IN_HAND', 'Этой карты нет в вашей руке.');
    const defenseCard = defender.hand[cardIndex]!;
    if (!this.canBeat(pair.attack, defenseCard)) {
      throw new GameRuleError('CANNOT_BEAT', `${formatCardName(defenseCard)} не побьёт ${formatCardName(pair.attack, 'accusative')}. Нужна карта старше той же масти или козырь.`);
    }

    defender.hand.splice(cardIndex, 1);
    pair.defense = defenseCard;
    this.maybeCompleteBout();
  }

  private handleTransfer(playerId: string, cardId: string): void {
    if ((this.state.config.mode ?? 'PODKIDNOY') !== 'PEREVODNOY') {
      throw new GameRuleError('TRANSFER_DISABLED', 'За этим столом подкидной режим. Перевод здесь не действует.');
    }
    const playerIndex = this.getActivePlayerIndex(playerId);
    if (playerIndex !== this.state.defenderIndex) {
      throw new GameRuleError('NOT_DEFENDER', 'Перевести атаку может только защищающийся.');
    }
    if (this.state.isDefenderTaking) {
      throw new GameRuleError('ALREADY_TAKING', 'Ты уже решил брать карты — переводить поздно.');
    }
    if (this.state.table.length === 0 || this.state.table.some((pair) => pair.defense !== null)) {
      throw new GameRuleError('TRANSFER_NOT_ALLOWED', 'Перевод возможен до начала отбоя, пока атака не покрыта.');
    }
    const defender = this.state.players[playerIndex]!;
    const cardIndex = defender.hand.findIndex((card) => card.id === cardId);
    if (cardIndex < 0) throw new GameRuleError('CARD_NOT_IN_HAND', 'Этой карты нет в твоей руке.');
    const card = defender.hand[cardIndex]!;
    if (!this.ranksOnTable().has(card.rank)) {
      throw new GameRuleError('INVALID_TRANSFER_RANK', 'Для перевода нужна карта того же достоинства, что уже лежит на столе.');
    }
    const nextDefenderIndex = this.nextActivePlayerIndex(playerIndex);
    const nextDefender = this.state.players[nextDefenderIndex]!;
    const nextAttackCount = this.state.table.length + 1;
    const attackLimit = Math.min(6, nextDefender.hand.length);
    if (nextAttackCount > attackLimit) {
      throw new GameRuleError('TRANSFER_LIMIT', `У следующего игрока только ${nextDefender.hand.length} карт — столько атак ему не перевести.`);
    }

    defender.hand.splice(cardIndex, 1);
    this.state.table.push({ attack: card, defense: null });
    // The transferor becomes the new attacker; the next active player inherits the defense.
    this.state.attackerIndex = playerIndex;
    this.state.activeThrowerIndex = playerIndex;
    this.state.defenderIndex = nextDefenderIndex;
    this.state.defenderHandStartCount = nextDefender.hand.length;
    this.state.isDefenderTaking = false;
    this.state.players.forEach((entry) => { entry.hasPassedBout = false; });
    this.maybeCompleteBout();
  }

  private handleTake(playerId: string): void {
    const playerIndex = this.getActivePlayerIndex(playerId);
    if (playerIndex !== this.state.defenderIndex) {
      throw new GameRuleError('NOT_DEFENDER', 'Забрать карты может только защищающийся.');
    }
    if (this.state.table.length === 0) throw new GameRuleError('EMPTY_TABLE', 'На столе ещё нет карт.');
    if (this.state.isDefenderTaking) throw new GameRuleError('ALREADY_TAKING', 'Вы уже объявили «Беру».');

    this.state.isDefenderTaking = true;
    this.maybeCompleteBout();
  }

  private handlePass(playerId: string): void {
    const playerIndex = this.getActivePlayerIndex(playerId);
    if (playerIndex !== this.state.activeThrowerIndex) {
      throw new GameRuleError('NOT_YOUR_TURN', 'Сейчас не ваша очередь объявлять «Пас».');
    }
    if (this.state.table.length === 0) throw new GameRuleError('EMPTY_TABLE', 'Нельзя пасовать до первой карты атаки.');
    this.state.players[playerIndex]!.hasPassedBout = true;
    this.state.activeThrowerIndex = this.nextAvailableThrowerIndex(playerIndex);
    this.maybeCompleteBout();
  }

  private maxAttackCardsThisBout(): number {
    const configuredLimit = this.state.isFirstBoutCompleted ? 6 : this.state.config.firstBoutMaxCards;
    return Math.min(configuredLimit, this.state.defenderHandStartCount);
  }

  /** True when at least one non-defending, non-passed active player can legally throw in. */
  public canAnyThrowerAddCard(): boolean {
    if (this.state.table.length === 0 || this.state.table.length >= this.maxAttackCardsThisBout()) return false;
    const uncoveredCount = this.state.table.filter((pair) => pair.defense === null).length;
    if (uncoveredCount >= this.state.defenderHandStartCount) return false;
    const ranksOnTable = this.ranksOnTable();
    return this.state.players.some((player, index) =>
      index !== this.state.defenderIndex &&
      player.status === 'ACTIVE' &&
      !player.hasPassedBout &&
      player.hand.some((card) => ranksOnTable.has(card.rank))
    );
  }

  private ranksOnTable(): Set<number> {
    const ranks = new Set<number>();
    for (const pair of this.state.table) {
      ranks.add(pair.attack.rank);
      if (pair.defense) ranks.add(pair.defense.rank);
    }
    return ranks;
  }

  /** Find an eligible thrower, starting at startIndex and moving clockwise. */
  private firstMatchingThrowerAtOrAfter(startIndex: number): number {
    const ranksOnTable = this.ranksOnTable();
    const total = this.state.players.length;
    if (total === 0) return -1;
    const normalizedStart = ((startIndex % total) + total) % total;
    for (let offset = 0; offset < total; offset++) {
      const index = (normalizedStart + offset) % total;
      const player = this.state.players[index]!;
      if (
        index !== this.state.defenderIndex &&
        player.status === 'ACTIVE' &&
        !player.hasPassedBout &&
        player.hand.some((card) => ranksOnTable.has(card.rank))
      ) return index;
    }
    return -1;
  }

  private maybeCompleteBout(): void {
    const tableIsFull = this.state.table.length >= this.maxAttackCardsThisBout();
    const allCovered = this.state.table.length > 0 && this.state.table.every((pair) => pair.defense !== null);

    // Once the defender has taken, only cards matching ranks on the table may be added.
    // Skip attackers who cannot legally throw; finish immediately when nobody can.
    if (this.state.isDefenderTaking) {
      if (tableIsFull || !this.canAnyThrowerAddCard()) {
        this.completeBout(true);
        return;
      }
      const start = this.state.activeThrowerIndex >= 0
        ? this.state.activeThrowerIndex
        : this.state.attackerIndex;
      const nextThrower = this.firstMatchingThrowerAtOrAfter(start);
      if (nextThrower === -1) this.completeBout(true);
      else this.state.activeThrowerIndex = nextThrower;
      return;
    }

    // At the card limit no more throw-ins are allowed, but the defender may still cover cards.
    if (tableIsFull) this.state.activeThrowerIndex = -1;
    if (allCovered && (tableIsFull || this.state.activeThrowerIndex === -1)) {
      this.completeBout(false);
    }
  }

  private completeBout(defenderTookCards: boolean): void {
    const defender = this.state.players[this.state.defenderIndex];
    if (!defender || defender.status !== 'ACTIVE') {
      throw new GameRuleError('INVALID_DEFENDER_STATE', 'Состояние защищающегося повреждено.');
    }

    if (defenderTookCards) {
      for (const pair of this.state.table) {
        defender.hand.push(pair.attack);
        if (pair.defense) defender.hand.push(pair.defense);
      }
    } else {
      for (const pair of this.state.table) {
        this.state.discardPile.push(pair.attack);
        if (pair.defense) this.state.discardPile.push(pair.defense);
      }
    }

    const previousAttackerIndex = this.state.attackerIndex;
    const previousDefenderIndex = this.state.defenderIndex;
    this.state.table = [];
    this.state.isDefenderTaking = false;
    this.state.isFirstBoutCompleted = true;
    for (const player of this.state.players) player.hasPassedBout = false;

    this.refillHandsInOrder(previousAttackerIndex, previousDefenderIndex);
    this.updateWinnersAndCheckGameOver();
    if (this.state.phase === 'GAME_OVER') return;

    // Configurable house rule: after a pickup either the original attacker
    // or the defender who took the cards leads the next bout.
    const afterTake = this.state.config.afterTake ?? 'ATTACKER';
    const nextAttacker = defenderTookCards && afterTake === 'ATTACKER'
      ? this.firstActiveAtOrAfter(previousAttackerIndex)
      : this.firstActiveAtOrAfter(previousDefenderIndex);

    if (nextAttacker === -1) {
      this.state.loserId = null;
      this.state.phase = 'GAME_OVER';
      return;
    }
    this.state.attackerIndex = nextAttacker;
    this.state.defenderIndex = this.nextActivePlayerIndex(nextAttacker);
    this.state.activeThrowerIndex = nextAttacker;
    this.state.defenderHandStartCount = this.state.players[this.state.defenderIndex]!.hand.length;
  }

  private refillHandsInOrder(attackerIndex: number, defenderIndex: number): void {
    if (this.state.deck.length === 0) return;
    const order: number[] = [];
    for (let offset = 0; offset < this.state.players.length; offset++) {
      const index = (attackerIndex + offset) % this.state.players.length;
      if (index !== defenderIndex && this.state.players[index]!.status === 'ACTIVE') order.push(index);
    }
    if (this.state.players[defenderIndex]!.status === 'ACTIVE') order.push(defenderIndex);

    for (const index of order) {
      const player = this.state.players[index]!;
      while (player.status === 'ACTIVE' && player.hand.length < 6 && this.state.deck.length > 0) {
        player.hand.push(this.state.deck.pop()!);
      }
    }
  }

  private updateWinnersAndCheckGameOver(): void {
    if (this.state.deck.length > 0) return;
    const newlyFinished = this.state.players.filter((p) => p.status === 'ACTIVE' && p.hand.length === 0);
    if (newlyFinished.length > 0) {
      const highestExisting = this.state.players.reduce(
        (max, p) => Math.max(max, p.finishOrder ?? 0),
        0,
      );
      // Players who empty their hands at the same bout boundary share the same place.
      for (const player of newlyFinished) {
        player.status = 'OUT_WINNER';
        player.finishOrder = highestExisting + 1;
      }
    }

    const remaining = this.state.players.filter((p) => p.status === 'ACTIVE');
    if (remaining.length === 1) {
      remaining[0]!.status = 'LOSER_DURAK';
      this.state.loserId = remaining[0]!.id;
      this.state.phase = 'GAME_OVER';
    } else if (remaining.length === 0) {
      this.state.loserId = null;
      this.state.phase = 'GAME_OVER';
    }
  }

  private nextAvailableThrowerIndex(afterIndex: number): number {
    if (this.state.table.length >= this.maxAttackCardsThisBout()) return -1;
    const total = this.state.players.length;
    for (let offset = 1; offset <= total; offset++) {
      const index = (afterIndex + offset) % total;
      const player = this.state.players[index]!;
      if (
        index !== this.state.defenderIndex &&
        player.status === 'ACTIVE' &&
        !player.hasPassedBout &&
        player.hand.length > 0
      ) return index;
    }
    return -1;
  }

  private nextActivePlayerIndex(fromIndex: number): number {
    const total = this.state.players.length;
    for (let offset = 1; offset <= total; offset++) {
      const index = (fromIndex + offset) % total;
      if (this.state.players[index]!.status === 'ACTIVE') return index;
    }
    throw new GameRuleError('NO_ACTIVE_PLAYER', 'Нет активного игрока для следующего хода.');
  }

  /** First active player at or after index; -1 if everyone has finished. */
  private firstActiveAtOrAfter(fromIndex: number): number {
    const total = this.state.players.length;
    for (let offset = 0; offset < total; offset++) {
      const index = (fromIndex + offset) % total;
      if (this.state.players[index]!.status === 'ACTIVE') return index;
    }
    return -1;
  }

  private getActivePlayerIndex(playerId: string): number {
    const index = this.state.players.findIndex((player) => player.id === playerId);
    if (index < 0) throw new GameRuleError('PLAYER_NOT_FOUND', 'Игрок не найден за этим столом.');
    if (this.state.players[index]!.status !== 'ACTIVE') {
      throw new GameRuleError('PLAYER_FINISHED', 'Вы уже вышли из игры.');
    }
    return index;
  }
}

import { randomBytes } from 'node:crypto';
import { DurakEngine } from '../../packages/game-engine/DurakEngine.ts';
import { computeBotAction } from '../../packages/game-engine/simulator.ts';
import type { GameAction, GameActionInput, GameState, PublicGameState } from '../../packages/shared-types/index.ts';
import { PersistentStore, type PlayerStats, type UserSettings } from './storage.ts';

export interface ChatMessage {
  id: string;
  roomId: string;
  senderId: string;
  senderName: string;
  senderType: 'PLAYER' | 'SYSTEM';
  text: string;
  timestamp: number;
}

export interface RoomListItem {
  roomId: string;
  ownerName: string;
  playerCount: number;
  maxPlayers: number;
  spectatorCount: number;
  phase: GameState['phase'];
  canSeat: boolean;
  canWatch: boolean;
}

export interface RoomSnapshot {
  state: PublicGameState;
  chatHistory: ChatMessage[];
  ownerId: string;
  viewerRole: 'PLAYER' | 'SPECTATOR';
  spectatorCount: number;
  isPublic: boolean;
}

export interface CreateRoomOptions {
  /** When false, opening the Mini App link alone never enrolls a stranger. */
  allowInviteJoin?: boolean;
  /** Only rooms marked public appear in the lobby list or allow spectators. */
  isPublic?: boolean;
}

export type GameOverHandler = (state: GameState) => void | Promise<void>;
export type RoomChangeListener = (roomId: string) => void;
export type PlayerConnectedListener = (roomId: string, playerId: string) => void;

export const AI_PLAYER_ID = 'ai_optimist';
const AI_PLAYER_NAME = 'Север (ИИ)';

interface AiQueueTask {
  timer: ReturnType<typeof setTimeout> | null;
  canceled: boolean;
  release: () => void;
}

interface RoomRecord {
  engine: DurakEngine;
  ownerId: string;
  allowInviteJoin: boolean;
  isPublic: boolean;
  spectators: Set<string>;
  onGameOver?: GameOverHandler;
  gameOverNotified: boolean;
  aiTask: AiQueueTask | null;
  createdAt: number;
  chat: ChatMessage[];
  queue: Promise<void>;
  idempotency: Map<string, { fingerprint: string; resultVersion: number }>;
  lastChatAt: Map<string, number>;
}

export class RoomError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'RoomError';
  }
}

export class RoomManager {
  private readonly rooms = new Map<string, RoomRecord>();
  private readonly now: () => number;
  private readonly aiDelayMs: number;
  public readonly store: PersistentStore;
  private onRoomChanged: RoomChangeListener | null = null;
  private onPlayerConnected: PlayerConnectedListener | null = null;

  constructor(now: () => number = Date.now, store = new PersistentStore(), aiDelayMs = 350) {
    if (!Number.isFinite(aiDelayMs) || aiDelayMs < 0 || aiDelayMs > 10_000) {
      throw new RangeError('aiDelayMs must be between 0 and 10000');
    }
    this.now = now;
    this.store = store;
    this.aiDelayMs = aiDelayMs;
  }

  public setRoomChangeListener(listener: RoomChangeListener): void {
    this.onRoomChanged = listener;
  }

  public setPlayerConnectedListener(listener: PlayerConnectedListener | null): void {
    this.onPlayerConnected = listener;
  }

  /** Notify integrations after a verified player has opened a room. */
  public notifyPlayerConnected(roomId: string, playerId: string): void {
    const room = this.rooms.get(roomId);
    if (!room || !room.engine.state.players.some((player) => player.id === playerId)) return;
    this.onPlayerConnected?.(roomId, playerId);
  }

  public createRoom(
    ownerId: string,
    username: string,
    maxPlayers = 4,
    options: CreateRoomOptions = {},
  ): { roomId: string; snapshot: RoomSnapshot } {
    if (!ownerId || !username.trim()) throw new RoomError('INVALID_OWNER', 'Не удалось определить создателя стола.');
    this.store.ensurePlayer(ownerId, username);
    const roomId = randomBytes(8).toString('hex');
    const engine = new DurakEngine(roomId, { maxPlayers, firstBoutMaxCards: 6 });
    engine.addPlayer(ownerId, username);
    const room: RoomRecord = {
      engine,
      ownerId,
      allowInviteJoin: options.allowInviteJoin ?? true,
      isPublic: options.isPublic ?? false,
      spectators: new Set(),
      gameOverNotified: false,
      aiTask: null,
      createdAt: this.now(),
      chat: [],
      queue: Promise.resolve(),
      idempotency: new Map(),
      lastChatAt: new Map(),
    };
    this.rooms.set(roomId, room);
    this.appendChat(room, 'SYSTEM', '✨ Стол OPTIMIST открыт! Здесь ценят смелые ходы, яркие партии и хорошее настроение.', 'SYSTEM');
    return { roomId, snapshot: this.snapshot(roomId, ownerId) };
  }

  public async createAiRoom(ownerId: string, username: string): Promise<{ roomId: string; snapshot: RoomSnapshot }> {
    if (!ownerId || !username.trim()) throw new RoomError('INVALID_OWNER', 'Не удалось определить создателя стола.');
    this.store.ensurePlayer(ownerId, username);
    const roomId = `ai_${randomBytes(3).toString('hex')}`;
    const engine = new DurakEngine(roomId, { maxPlayers: 2, firstBoutMaxCards: 6 });
    engine.addPlayer(ownerId, username);
    engine.addPlayer(AI_PLAYER_ID, AI_PLAYER_NAME);
    engine.startGame();
    const room: RoomRecord = {
      engine,
      ownerId,
      allowInviteJoin: false,
      isPublic: false,
      spectators: new Set(),
      gameOverNotified: false,
      aiTask: null,
      createdAt: this.now(),
      chat: [],
      queue: Promise.resolve(),
      idempotency: new Map(),
      lastChatAt: new Map(),
    };
    this.rooms.set(roomId, room);
    this.appendChat(room, 'SYSTEM', '🤖 Север (ИИ) уже за столом! Карты на руках — покажи, на что способен! Удача любит смелых.', 'SYSTEM');
    this.scheduleAiTurnIfNeeded(roomId, room);
    return { roomId, snapshot: this.snapshot(roomId, ownerId) };
  }

  public getRoom(roomId: string): DurakEngine | undefined { return this.rooms.get(roomId)?.engine; }
  public getOwnerId(roomId: string): string { return this.getRecord(roomId).ownerId; }
  public canJoinByInvite(roomId: string): boolean { return this.getRecord(roomId).allowInviteJoin; }
  public isPublicRoom(roomId: string): boolean { return this.getRecord(roomId).isPublic; }

  public setGameOverHandler(roomId: string, handler: GameOverHandler): void {
    this.getRecord(roomId).onGameOver = handler;
  }

  public listPublicRooms(): RoomListItem[] {
    const list: RoomListItem[] = [];
    for (const [roomId, room] of this.rooms) {
      if (!room.isPublic || room.engine.state.phase === 'GAME_OVER') continue;
      const state = room.engine.state;
      const owner = state.players.find((player) => player.id === room.ownerId);
      list.push({
        roomId,
        ownerName: owner?.username ?? 'Игрок',
        playerCount: state.players.length,
        maxPlayers: state.config.maxPlayers,
        spectatorCount: room.spectators.size,
        phase: state.phase,
        canSeat: state.phase === 'WAITING_FOR_PLAYERS' && state.players.length < state.config.maxPlayers,
        canWatch: true,
      });
    }
    return list.sort((a, b) => a.roomId.localeCompare(b.roomId)).slice(0, 30);
  }

  public getProfile(userId: string, username = 'Игрок'): PlayerStats {
    return this.store.ensurePlayer(userId, username);
  }
  public getLeaderboard(limit = 15): PlayerStats[] { return this.store.getLeaderboard(limit); }
  public getUserSettings(userId: string): UserSettings { return this.store.getSettings(userId); }
  public updateUserSettings(userId: string, patch: { trumpPosition?: 'left' | 'right'; soundEnabled?: boolean }): UserSettings {
    return this.store.saveSettings(userId, patch);
  }

  public async spectateRoom(roomId: string, viewerId: string): Promise<RoomSnapshot> {
    return this.withLock(roomId, (room) => {
      if (!viewerId.trim()) throw new RoomError('INVALID_PLAYER', 'Некорректные данные наблюдателя.');
      const isPlayer = room.engine.state.players.some((player) => player.id === viewerId);
      if (!isPlayer && !room.isPublic) {
        throw new RoomError('NOT_A_MEMBER', 'Наблюдение доступно только за открытыми публичными столами.');
      }
      if (!isPlayer) room.spectators.add(viewerId);
      return this.snapshot(roomId, viewerId);
    });
  }

  public async removeSpectator(roomId: string, viewerId: string): Promise<boolean> {
    const removed = await this.withLock(roomId, (room) => room.spectators.delete(viewerId));
    if (removed) this.onRoomChanged?.(roomId);
    return removed;
  }

  public async removeWaitingPlayer(roomId: string, playerId: string): Promise<{ ownerId: string | null; playerCount: number }> {
    return this.withLock(roomId, (room) => {
      if (room.engine.state.phase !== 'WAITING_FOR_PLAYERS') {
        throw new RoomError('GAME_ALREADY_STARTED', 'Партия уже началась — покинуть стол нельзя.');
      }
      const index = room.engine.state.players.findIndex((player) => player.id === playerId);
      if (index < 0) throw new RoomError('NOT_A_MEMBER', 'Тебя нет за этим столом.');
      room.engine.state.players.splice(index, 1);
      room.engine.state.version++;
      room.spectators.delete(playerId);
      if (room.ownerId === playerId) room.ownerId = room.engine.state.players[0]?.id ?? '';
      return { ownerId: room.ownerId || null, playerCount: room.engine.state.players.length };
    });
  }

  public async removeRoomIfEmpty(roomId: string): Promise<boolean> {
    try {
      return await this.withLock(roomId, (room) => {
        if (room.engine.state.phase !== 'WAITING_FOR_PLAYERS' || room.engine.state.players.length > 0) return false;
        this.clearAiTimer(room);
        this.rooms.delete(roomId);
        return true;
      });
    } catch (error) {
      if (error instanceof RoomError && error.code === 'ROOM_NOT_FOUND') return true;
      throw error;
    }
  }

  public removeRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room) this.clearAiTimer(room);
    this.rooms.delete(roomId);
  }

  public clearAllTimers(): void {
    for (const room of this.rooms.values()) this.clearAiTimer(room);
  }

  public async joinRoom(roomId: string, playerId: string, username: string, viaLobbyButton = false): Promise<RoomSnapshot> {
    return this.withLock(roomId, (room) => {
      if (!playerId || !username.trim()) throw new RoomError('INVALID_PLAYER', 'Некорректные данные игрока.');
      this.store.ensurePlayer(playerId, username);
      const existing = room.engine.state.players.some((player) => player.id === playerId);
      if (!existing) {
        if (!room.allowInviteJoin && !room.isPublic && !viaLobbyButton) {
          throw new RoomError('NOT_A_MEMBER', 'Эта партия уже собирает участников в группе. Сначала нажми «Присоединиться» в сообщении лобби.');
        }
        room.spectators.delete(playerId);
        room.engine.addPlayer(playerId, username);
        this.appendChat(room, 'SYSTEM', `${username.slice(0, 64)} присоединился к команде! За столом становится жарче 🔥`, 'SYSTEM');
      }
      return this.snapshot(roomId, playerId);
    });
  }

  public async startGame(roomId: string, playerId: string): Promise<RoomSnapshot> {
    return this.withLock(roomId, (room) => {
      this.assertMember(room, playerId);
      if (room.ownerId !== playerId) throw new RoomError('OWNER_ONLY', 'Запустить партию может только создатель стола.');
      room.engine.startGame();
      this.appendChat(room, 'SYSTEM', '🃏 Карты розданы! Пусть каждый ход будет красивым, а настрой — победным!', 'SYSTEM');
      this.scheduleAiTurnIfNeeded(roomId, room);
      return this.snapshot(roomId, playerId);
    });
  }

  public async dispatchAction(roomId: string, playerId: string, action: GameActionInput, commandId: string): Promise<RoomSnapshot> {
    return this.withLock(roomId, (room) => {
      this.assertMember(room, playerId);
      if (typeof commandId !== 'string' || !/^[\w-]{8,100}$/.test(commandId)) {
        throw new RoomError('INVALID_COMMAND_ID', 'У команды отсутствует корректный идентификатор.');
      }
      const normalized = { ...action, playerId } as GameAction;
      const fingerprint = JSON.stringify(normalized);
      const key = `${playerId}:${commandId}`;
      const prior = room.idempotency.get(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new RoomError('IDEMPOTENCY_CONFLICT', 'Идентификатор команды уже использован для другого действия.');
        return this.snapshot(roomId, playerId);
      }
      const previousPhase = room.engine.state.phase;
      room.engine.dispatch(normalized);
      room.idempotency.set(key, { fingerprint, resultVersion: room.engine.state.version });
      if (previousPhase === 'PLAYING' && room.engine.state.phase === 'GAME_OVER') {
        this.finalizeGameOver(room);
      } else {
        this.scheduleAiTurnIfNeeded(roomId, room);
      }
      if (room.idempotency.size > 2_000) {
        const first = room.idempotency.keys().next().value;
        if (first) room.idempotency.delete(first);
      }
      return this.snapshot(roomId, playerId);
    });
  }

  public async sendChat(roomId: string, playerId: string, text: string): Promise<ChatMessage> {
    return this.withLock(roomId, (room) => {
      this.assertMember(room, playerId);
      const clean = typeof text === 'string' ? text.trim() : '';
      if (!clean) throw new RoomError('EMPTY_MESSAGE', 'Сообщение не должно быть пустым.');
      if (clean.length > 200) throw new RoomError('MESSAGE_TOO_LONG', 'Сообщение не должно превышать 200 символов.');
      const now = this.now();
      const last = room.lastChatAt.get(playerId) ?? 0;
      if (now - last < 800) throw new RoomError('RATE_LIMIT', 'Не торопись — даже у самого яркого хода есть свой момент. Подожди секунду!');
      room.lastChatAt.set(playerId, now);
      const player = room.engine.state.players.find((entry) => entry.id === playerId)!;
      return this.appendChat(room, playerId, clean, 'PLAYER', player.username);
    });
  }

  public getSnapshot(roomId: string, viewerId: string): RoomSnapshot {
    const room = this.getRecord(roomId);
    this.assertCanView(room, viewerId);
    return this.snapshot(roomId, viewerId);
  }

  public pruneIdleRooms(maxIdleMs = 6 * 60 * 60 * 1000): number {
    const cutoff = this.now() - maxIdleMs;
    let removed = 0;
    for (const [roomId, room] of this.rooms) {
      if (room.createdAt < cutoff && room.engine.state.phase !== 'PLAYING') {
        this.clearAiTimer(room);
        this.rooms.delete(roomId);
        removed++;
      }
    }
    return removed;
  }

  /** Append a delayed AI action to the same FIFO queue used by human actions. */
  private scheduleAiTurnIfNeeded(roomId: string, room: RoomRecord): void {
    this.clearAiTimer(room);
    if (room.engine.state.phase !== 'PLAYING' || !computeBotAction(room.engine, AI_PLAYER_ID)) return;

    const previous = room.queue;
    let release!: () => void;
    room.queue = new Promise<void>((resolve) => { release = resolve; });
    const task: AiQueueTask = { timer: null, canceled: false, release };
    room.aiTask = task;

    void previous.then(() => {
      if (task.canceled) {
        task.release();
        return;
      }
      task.timer = setTimeout(() => {
        task.timer = null;
        void (async () => {
          try {
            if (task.canceled || this.rooms.get(roomId) !== room || room.engine.state.phase !== 'PLAYING') return;
            const action = computeBotAction(room.engine, AI_PLAYER_ID);
            if (!action) return;
            room.engine.dispatch(action);
            const phaseAfterAction = (room.engine.state as GameState).phase;
            if (phaseAfterAction === 'GAME_OVER') {
              this.finalizeGameOver(room);
            } else {
              // Release this task only after scheduling the next AI action, preserving FIFO order.
              room.aiTask = null;
              this.scheduleAiTurnIfNeeded(roomId, room);
            }
            this.onRoomChanged?.(roomId);
          } catch (error) {
            console.error('[room-manager] AI action failed:', error instanceof Error ? error.message : 'unknown');
          } finally {
            if (room.aiTask === task) room.aiTask = null;
            task.release();
          }
        })();
      }, this.aiDelayMs);
      task.timer.unref?.();
    }).catch((error: unknown) => {
      console.error('[room-manager] AI queue failed:', error instanceof Error ? error.message : 'unknown');
      task.release();
    });
  }

  private clearAiTimer(room: RoomRecord): void {
    const task = room.aiTask;
    if (!task) return;
    task.canceled = true;
    if (task.timer) clearTimeout(task.timer);
    room.aiTask = null;
    task.release();
  }

  private finalizeGameOver(room: RoomRecord): void {
    if (room.gameOverNotified) return;
    room.gameOverNotified = true;
    this.clearAiTimer(room);
    const state = room.engine.state;
    for (const player of state.players) {
      if (player.id === AI_PLAYER_ID) continue;
      if (state.loserId === null) this.store.recordMatchOutcome(player.id, player.username, 'DRAW');
      else if (player.id === state.loserId || player.status === 'LOSER_DURAK') this.store.recordMatchOutcome(player.id, player.username, 'LOSS');
      else this.store.recordMatchOutcome(player.id, player.username, 'WIN');
    }
    const notify = room.onGameOver;
    const finalState = structuredClone(state);
    if (notify) {
      queueMicrotask(() => {
        Promise.resolve(notify(finalState)).catch((error: unknown) => {
          console.error('[room-manager] game-over callback failed:', error instanceof Error ? error.message : 'unknown');
        });
      });
    }
  }

  private async withLock<T>(roomId: string, operation: (room: RoomRecord) => T | Promise<T>): Promise<T> {
    const room = this.getRecord(roomId);
    const previous = room.queue;
    let release!: () => void;
    room.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.rooms.get(roomId) !== room) throw new RoomError('ROOM_NOT_FOUND', 'Стол не найден или уже закрыт.');
      return await operation(room);
    } finally {
      release();
    }
  }

  private getRecord(roomId: string): RoomRecord {
    const room = this.rooms.get(roomId);
    if (!room) throw new RoomError('ROOM_NOT_FOUND', 'Стол не найден или уже закрыт.');
    return room;
  }

  private assertMember(room: RoomRecord, playerId: string): void {
    if (!room.engine.state.players.some((player) => player.id === playerId)) {
      throw new RoomError('NOT_A_MEMBER', 'У тебя нет доступа к этому столу.');
    }
  }

  private assertCanView(room: RoomRecord, viewerId: string): void {
    const isPlayer = room.engine.state.players.some((player) => player.id === viewerId);
    if (!isPlayer && !room.spectators.has(viewerId)) throw new RoomError('NOT_A_MEMBER', 'У тебя нет доступа к этому столу.');
  }

  private snapshot(roomId: string, viewerId: string): RoomSnapshot {
    const room = this.getRecord(roomId);
    this.assertCanView(room, viewerId);
    const isPlayer = room.engine.state.players.some((player) => player.id === viewerId);
    return {
      state: room.engine.getPublicStateForPlayer(isPlayer ? viewerId : '__SPECTATOR__'),
      chatHistory: room.chat.map((message) => ({ ...message })),
      ownerId: room.ownerId,
      viewerRole: isPlayer ? 'PLAYER' : 'SPECTATOR',
      spectatorCount: room.spectators.size,
      isPublic: room.isPublic,
    };
  }

  private appendChat(room: RoomRecord, senderId: string, text: string, senderType: ChatMessage['senderType'], senderName?: string): ChatMessage {
    const message: ChatMessage = {
      id: randomBytes(8).toString('hex'),
      roomId: room.engine.state.roomId,
      senderId,
      senderName: senderName ?? (senderType === 'SYSTEM' ? '✨ Стол OPTIMIST' : 'Игрок'),
      senderType,
      text,
      timestamp: this.now(),
    };
    room.chat.push(message);
    if (room.chat.length > 50) room.chat.splice(0, room.chat.length - 50);
    return message;
  }
}

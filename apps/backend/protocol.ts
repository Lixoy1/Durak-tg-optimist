import type { GameActionInput } from '../../packages/shared-types/index.ts';

export type ClientMessage =
  | { type: 'AUTH'; roomId: string; initData: string; mode?: 'play' | 'spectate' }
  | { type: 'START_GAME' }
  | { type: 'GAME_ACTION'; commandId: string; action: GameActionInput }
  | { type: 'SEND_CHAT'; text: string }
  | { type: 'SEND_SPECTATOR_CHAT'; text: string }
  | { type: 'SEND_REACTION'; reaction: '🔥' | '😎' | '😂' | '💀' | '👑' | '🤡' | '👏' | '🙈' }
  | { type: 'SEND_TABLE_EFFECT'; effect: 'curse' | 'buff' | 'lightning' | 'phoenix' };

export class ProtocolError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ProtocolError';
  }
}

const MAX_FRAME_BYTES = 8 * 1024;
const ROOM_ID = /^[a-f0-9]{16}$|^ai_[a-f0-9]{6}$/;
const CARD_ID = /^(clubs|spades|diamonds|hearts)_(6|7|8|9|10|11|12|13|14)$/;

/** Strictly parse untrusted WebSocket JSON before it reaches application logic. */
export function parseClientMessage(raw: string | Uint8Array): ClientMessage {
  const bytes = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength;
  if (bytes === 0 || bytes > MAX_FRAME_BYTES) throw new ProtocolError('FRAME_SIZE', 'Сообщение пустое или слишком большое.');
  let parsed: unknown;
  try { parsed = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')); }
  catch { throw new ProtocolError('INVALID_JSON', 'Некорректный формат сообщения.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ProtocolError('INVALID_MESSAGE', 'Сообщение должно быть объектом.');
  const msg = parsed as Record<string, unknown>;

  if (msg.type === 'AUTH') {
    if (typeof msg.roomId !== 'string' || !ROOM_ID.test(msg.roomId)) throw new ProtocolError('INVALID_ROOM_ID', 'Некорректный ID стола.');
    if (typeof msg.initData !== 'string' || msg.initData.length === 0 || msg.initData.length > 16_384) throw new ProtocolError('INVALID_INIT_DATA', 'Некорректные данные авторизации.');
    if (msg.mode !== undefined && msg.mode !== 'play' && msg.mode !== 'spectate') throw new ProtocolError('INVALID_AUTH_MODE', 'Некорректный режим подключения.');
    return {
      type: 'AUTH', roomId: msg.roomId, initData: msg.initData,
      ...(msg.mode !== undefined ? { mode: msg.mode } : {}),
    };
  }
  if (msg.type === 'START_GAME') return { type: 'START_GAME' };
  if (msg.type === 'SEND_CHAT' || msg.type === 'SEND_SPECTATOR_CHAT') {
    if (typeof msg.text !== 'string' || msg.text.length > 200) throw new ProtocolError('INVALID_CHAT', 'Сообщение должно содержать не более 200 символов.');
    return { type: msg.type, text: msg.text };
  }
  if (msg.type === 'SEND_REACTION') {
    const allowed = ['🔥', '😎', '😂', '💀', '👑', '🤡', '👏', '🙈'] as const;
    if (typeof msg.reaction !== 'string' || !allowed.includes(msg.reaction as typeof allowed[number])) {
      throw new ProtocolError('INVALID_REACTION', 'Недопустимая реакция.');
    }
    return { type: 'SEND_REACTION', reaction: msg.reaction as typeof allowed[number] };
  }
  if (msg.type === 'SEND_TABLE_EFFECT') {
    const allowed = ['curse', 'buff', 'lightning', 'phoenix'] as const;
    if (typeof msg.effect !== 'string' || !allowed.includes(msg.effect as typeof allowed[number])) {
      throw new ProtocolError('INVALID_TABLE_EFFECT', 'Недопустимый визуальный эффект.');
    }
    return { type: 'SEND_TABLE_EFFECT', effect: msg.effect as typeof allowed[number] };
  }
  if (msg.type === 'GAME_ACTION') {
    if (typeof msg.commandId !== 'string' || !/^[\w-]{8,100}$/.test(msg.commandId)) throw new ProtocolError('INVALID_COMMAND_ID', 'Некорректный идентификатор команды.');
    if (!msg.action || typeof msg.action !== 'object' || Array.isArray(msg.action)) throw new ProtocolError('INVALID_ACTION', 'Отсутствует игровое действие.');
    const action = msg.action as Record<string, unknown>;
    if ('playerId' in action || 'userId' in action || 'roomId' in action) throw new ProtocolError('CLIENT_IDENTITY_FORBIDDEN', 'Идентификатор игрока и стола задаёт сервер.');
    if (!Number.isSafeInteger(action.expectedVersion) || (action.expectedVersion as number) < 1) throw new ProtocolError('INVALID_VERSION', 'Некорректная версия стола.');
    if (action.type === 'ATTACK' && typeof action.cardId === 'string' && CARD_ID.test(action.cardId)) {
      return { type: 'GAME_ACTION', commandId: msg.commandId, action: { type: 'ATTACK', cardId: action.cardId, expectedVersion: action.expectedVersion as number } };
    }
    if (action.type === 'DEFEND' && typeof action.cardId === 'string' && CARD_ID.test(action.cardId) && Number.isSafeInteger(action.attackIndex) && (action.attackIndex as number) >= 0 && (action.attackIndex as number) < 6) {
      return { type: 'GAME_ACTION', commandId: msg.commandId, action: { type: 'DEFEND', cardId: action.cardId, attackIndex: action.attackIndex as number, expectedVersion: action.expectedVersion as number } };
    }
    if (action.type === 'TAKE' || action.type === 'PASS') {
      return { type: 'GAME_ACTION', commandId: msg.commandId, action: { type: action.type, expectedVersion: action.expectedVersion as number } };
    }
    if (action.type === 'TRANSFER' && typeof action.cardId === 'string' && CARD_ID.test(action.cardId)) {
      return { type: 'GAME_ACTION', commandId: msg.commandId, action: { type: 'TRANSFER', cardId: action.cardId, expectedVersion: action.expectedVersion as number } };
    }
    throw new ProtocolError('INVALID_ACTION', 'Недопустимый тип или параметры игрового действия.');
  }
  throw new ProtocolError('UNKNOWN_MESSAGE', 'Неизвестный тип сообщения.');
}

import { Bot, InlineKeyboard } from 'grammy';
import type { Chat, User } from 'grammy/types';
import type { GameState } from '../../packages/shared-types/index.ts';
import type { DurakEngine } from '../../packages/game-engine/DurakEngine.ts';
import type { RoomManager } from './RoomManager.ts';

export interface TelegramBotOptions {
  token: string;
  webAppUrl: string;
  rooms: RoomManager;
  /** Username without @, optionally supplied to avoid an extra getMe call. */
  botUsername?: string;
  /** Mini App short name configured in @BotFather (/newapp). */
  appShortName?: string;
  onRoomChanged?: (roomId: string) => void;
}

interface GroupLobby {
  roomId: string;
  chatId: number;
  messageId: number;
  creatorId: string;
  secondsLeft: number;
  timer: ReturnType<typeof setInterval> | null;
  status: 'OPEN' | 'STARTING' | 'STARTED' | 'CLOSED';
}

const MAX_GROUP_PLAYERS = 6;
const LOBBY_DURATION_SECONDS = 60;
const LOBBY_REFRESH_SECONDS = 15;

function miniAppUrl(baseUrl: string, roomId: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('roomId', roomId);
  return url.toString();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function displayName(user: User): string {
  return [user.first_name, user.last_name].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
    || user.username
    || 'Игрок';
}

function isGroup(chat: Chat): boolean {
  return chat.type === 'group' || chat.type === 'supergroup';
}

export function createTelegramBot(options: TelegramBotOptions): Bot {
  const { token, webAppUrl, rooms, onRoomChanged } = options;
  const bot = new Bot(token);
  const activeLobbies = new Map<string, GroupLobby>();
  const activeLobbyByChat = new Map<number, string>();
  let botUsername = options.botUsername?.replace(/^@/, '').trim() || '';
  const appShortName = options.appShortName?.trim() || 'game';

  async function getBotUsername(): Promise<string> {
    if (!botUsername) {
      const info = await bot.api.getMe();
      botUsername = info.username ?? '';
    }
    if (!botUsername) throw new Error('Не удалось определить username бота для прямой ссылки Mini App.');
    return botUsername;
  }

  async function directMiniAppUrl(roomId: string): Promise<string> {
    const username = await getBotUsername();
    const startParam = `room_${roomId}`;
    return `https://t.me/${username}/${encodeURIComponent(appShortName)}?startapp=${encodeURIComponent(startParam)}`;
  }

  function getLobbyEngine(lobby: GroupLobby) {
    return rooms.getRoom(lobby.roomId);
  }

  function renderLobbyText(lobby: GroupLobby): string {
    const engine = getLobbyEngine(lobby);
    if (!engine) return '<b>♠️ OPTIMIST — НЕ ДУРАК ♦️</b>\n\nЭтот стол уже закрыт.';
    const players = engine.state.players;
    const lines = players.map((player, index) => {
      const crown = player.id === lobby.creatorId ? ' 👑 <i>создатель стола</i>' : '';
      return `${index + 1}. <b>${escapeHtml(player.username)}</b>${crown}`;
    });
    if (lines.length === 0) lines.push('<i>Пока никого нет за столом.</i>');
    return [
      '<b>♠️ OPTIMIST — НЕ ДУРАК ♦️</b>',
      '',
      'Собираем компанию на партию в подкидного дурака!',
      '',
      ...lines,
      '',
      `👥 <b>Игроки:</b> ${players.length}/${engine.state.config.maxPlayers}`,
      `⏳ <b>До старта:</b> ${lobby.secondsLeft} сек.`,
      players.length >= 2 ? '\nСоздатель стола может запускать партию.' : '\nНужно хотя бы 2 игрока.',
    ].join('\n');
  }

  function renderLobbyKeyboard(lobby: GroupLobby): InlineKeyboard {
    const engine = getLobbyEngine(lobby);
    const count = engine?.state.players.length ?? 0;
    const keyboard = new InlineKeyboard()
      .text('➕ Присоединиться', `join_${lobby.roomId}`)
      .text('➖ Выйти', `leave_${lobby.roomId}`);
    if (count >= 2) keyboard.row().text('👑 Начать игру', `start_${lobby.roomId}`);
    return keyboard;
  }

  async function updateLobbyMessage(lobby: GroupLobby): Promise<void> {
    if (lobby.status !== 'OPEN' || lobby.messageId === 0) return;
    try {
      await bot.api.editMessageText(lobby.chatId, lobby.messageId, renderLobbyText(lobby), {
        parse_mode: 'HTML',
        reply_markup: renderLobbyKeyboard(lobby),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown';
      // Telegram returns this when two near-simultaneous callbacks render the same state.
      if (!message.includes('message is not modified')) {
        console.warn('[telegram-bot] lobby message update failed:', message);
      }
    }
  }

  function stopLobbyTimer(lobby: GroupLobby): void {
    if (lobby.timer) clearInterval(lobby.timer);
    lobby.timer = null;
  }

  function removeLobbyIndexes(lobby: GroupLobby): void {
    activeLobbies.delete(lobby.roomId);
    if (activeLobbyByChat.get(lobby.chatId) === lobby.roomId) activeLobbyByChat.delete(lobby.chatId);
  }

  async function announceGameResult(chatId: number, state: GameState): Promise<void> {
    const winners = state.players
      .filter((player) => player.status === 'OUT_WINNER')
      .sort((a, b) => (a.finishOrder ?? Number.MAX_SAFE_INTEGER) - (b.finishOrder ?? Number.MAX_SAFE_INTEGER));
    const loser = state.players.find((player) => player.id === state.loserId)
      ?? state.players.find((player) => player.status === 'LOSER_DURAK');
    const lines = ['<b>🏆 OPTIMIST — ИТОГИ ПАРТИИ</b>', '', `🃏 Стол <code>${escapeHtml(state.roomId)}</code>`, ''];
    winners.forEach((player, index) => {
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '✨';
      lines.push(`${medal} <b>${escapeHtml(player.username)}</b> — место ${player.finishOrder ?? index + 1}`);
    });
    lines.push('');
    if (loser) {
      lines.push(`🃏 <b>Хранитель Колоды:</b> ${escapeHtml(loser.username)}`);
    } else {
      lines.push('🤝 <b>Партия завершилась без проигравшего.</b>');
    }
    lines.push('', 'Готовы к реваншу? Накрываем новый стол!');
    await bot.api.sendMessage(chatId, lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('🔄 Новый стол', 'new_table'),
    });
  }

  async function launchGroupGame(lobby: GroupLobby): Promise<void> {
    if (lobby.status !== 'OPEN') return;
    const engine = getLobbyEngine(lobby);
    if (!engine) {
      lobby.status = 'CLOSED';
      stopLobbyTimer(lobby);
      removeLobbyIndexes(lobby);
      return;
    }
    if (engine.state.players.length < 2) {
      await updateLobbyMessage(lobby);
      return;
    }

    // Change status synchronously before the first await to make double-clicks idempotent.
    lobby.status = 'STARTING';
    stopLobbyTimer(lobby);
    let startedEngine: DurakEngine;
    try {
      await rooms.startGame(lobby.roomId, lobby.creatorId);
      const candidate = rooms.getRoom(lobby.roomId);
      if (!candidate || candidate.state.phase !== 'PLAYING') throw new Error('Стол не перешёл в игровую фазу.');
      startedEngine = candidate;
    } catch (error) {
      lobby.status = 'OPEN';
      lobby.secondsLeft = Math.min(lobby.secondsLeft, LOBBY_REFRESH_SECONDS);
      activeLobbies.set(lobby.roomId, lobby);
      activeLobbyByChat.set(lobby.chatId, lobby.roomId);
      lobby.timer = setInterval(() => { void tickLobby(lobby); }, LOBBY_REFRESH_SECONDS * 1000);
      lobby.timer.unref?.();
      console.error('[telegram-bot] game launch failed:', error instanceof Error ? error.message : 'unknown');
      await updateLobbyMessage(lobby);
      return;
    }

    lobby.status = 'STARTED';
    removeLobbyIndexes(lobby);
    rooms.setGameOverHandler(lobby.roomId, async (finalState) => {
      try {
        await announceGameResult(lobby.chatId, finalState);
      } catch (error) {
        console.error('[telegram-bot] could not publish game results:', error instanceof Error ? error.message : 'unknown');
      }
    });
    onRoomChanged?.(lobby.roomId);

    try {
      const players = startedEngine.state.players.map((player) => `<b>${escapeHtml(player.username)}</b>`).join(', ');
      const firstPlayer = startedEngine.state.players[startedEngine.state.attackerIndex]?.username ?? 'Игрок';
      const url = await directMiniAppUrl(lobby.roomId);
      await bot.api.editMessageText(lobby.chatId, lobby.messageId, [
        '<b>🔥 OPTIMIST — ПАРТИЯ НАЧАЛАСЬ!</b>',
        '',
        `👥 <b>За столом:</b> ${players}`,
        `🃏 Карты розданы. Первый ход: <b>${escapeHtml(firstPlayer)}</b>.`,
        '',
        'Открой Mini App по кнопке ниже. Каждый участник увидит только свои карты.',
      ].join('\n'), {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().url('🃏 Открыть OPTIMIST DURAK', url),
      });
    } catch (error) {
      console.error('[telegram-bot] game started but group link could not be published:', error instanceof Error ? error.message : 'unknown');
      await bot.api.sendMessage(lobby.chatId, 'Партия уже началась, но не удалось создать ссылку Mini App. Проверь BOT_USERNAME и APP_SHORT_NAME в настройках бота.').catch(() => {});
    }
  }

  async function closeLobby(lobby: GroupLobby, reason: string): Promise<void> {
    if (lobby.status === 'CLOSED' || lobby.status === 'STARTED') return;
    lobby.status = 'CLOSED';
    stopLobbyTimer(lobby);
    removeLobbyIndexes(lobby);
    rooms.removeRoom(lobby.roomId);
    try {
      await bot.api.editMessageText(lobby.chatId, lobby.messageId, `<b>♠️ OPTIMIST — НЕ ДУРАК ♦️</b>\n\n${escapeHtml(reason)}`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] },
      });
    } catch { /* The group may have deleted the lobby message. */ }
  }

  async function tickLobby(lobby: GroupLobby): Promise<void> {
    if (lobby.status !== 'OPEN') return;
    lobby.secondsLeft = Math.max(0, lobby.secondsLeft - LOBBY_REFRESH_SECONDS);
    const engine = getLobbyEngine(lobby);
    if (!engine) {
      await closeLobby(lobby, 'Стол больше недоступен. Напишите /game, чтобы открыть новый.');
      return;
    }
    if (lobby.secondsLeft === 0) {
      if (engine.state.players.length >= 2) {
        await launchGroupGame(lobby);
      } else {
        await closeLobby(lobby, 'Время ожидания вышло — для партии нужно минимум 2 игрока. Напишите /game, чтобы открыть новый стол.');
      }
      return;
    }
    await updateLobbyMessage(lobby);
  }

  async function openGroupLobby(chatId: number, creatorId: string, creatorName: string): Promise<void> {
    const existingId = activeLobbyByChat.get(chatId);
    const existing = existingId ? activeLobbies.get(existingId) : undefined;
    if (existing?.status === 'OPEN') {
      await bot.api.sendMessage(chatId, '♠️ Стол OPTIMIST уже собирает игроков — присоединяйся к сообщению выше.');
      return;
    }

    const { roomId } = rooms.createRoom(creatorId, creatorName, MAX_GROUP_PLAYERS, { allowInviteJoin: false });
    const lobby: GroupLobby = {
      roomId,
      chatId,
      messageId: 0,
      creatorId,
      secondsLeft: LOBBY_DURATION_SECONDS,
      timer: null,
      status: 'OPEN',
    };
    activeLobbies.set(roomId, lobby);
    activeLobbyByChat.set(chatId, roomId);
    try {
      const message = await bot.api.sendMessage(chatId, renderLobbyText(lobby), {
        parse_mode: 'HTML',
        reply_markup: renderLobbyKeyboard(lobby),
      });
      lobby.messageId = message.message_id;
      lobby.timer = setInterval(() => { void tickLobby(lobby); }, LOBBY_REFRESH_SECONDS * 1000);
      lobby.timer.unref?.();
    } catch (error) {
      lobby.status = 'CLOSED';
      removeLobbyIndexes(lobby);
      rooms.removeRoom(roomId);
      throw error;
    }
  }

  bot.command(['start', 'game', 'durak'], async (ctx) => {
    const telegramUser = ctx.from;
    if (!telegramUser) {
      await ctx.reply('Не удалось определить Telegram-пользователя. Открой бота заново.');
      return;
    }
    const userId = String(telegramUser.id);
    const username = displayName(telegramUser);
    const payload = typeof ctx.match === 'string' ? ctx.match.trim() : '';

    if (ctx.chat.type === 'private' && payload.startsWith('room_')) {
      const roomId = payload.slice('room_'.length);
      const room = rooms.getRoom(roomId);
      if (!room) {
        await ctx.reply('Стол не найден или уже завершён. Создай новый стол через /start.');
        return;
      }
      try {
        const snapshot = await rooms.joinRoom(roomId, userId, username);
        onRoomChanged?.(roomId);
        const keyboard = new InlineKeyboard().webApp('🃏 Открыть OPTIMIST DURAK', miniAppUrl(webAppUrl, roomId));
        await ctx.reply(
          `Ты за столом OPTIMIST DURAK. Игроков: ${snapshot.state.players.length}/${room.state.config.maxPlayers}.`,
          { reply_markup: keyboard },
        );
      } catch (error) {
        await ctx.reply(error instanceof Error ? error.message : 'Не удалось присоединиться к столу.');
      }
      return;
    }

    if (ctx.chat.type === 'private') {
      const keyboard = new InlineKeyboard()
        .text('2 игрока', 'create_2').text('3 игрока', 'create_3').row()
        .text('4 игрока', 'create_4').text('5 игроков', 'create_5').row()
        .text('6 игроков', 'create_6');
      await ctx.reply(
        '♠️ <b>OPTIMIST DURAK</b> ♦️\n\nАвторская колода из 36 карт. Создай личный стол, пригласи друзей и сыграй в подкидного дурака.\n\nДля игры с компанией прямо в группе добавь бота в групповой чат и напиши там /game.\n\nВыбери размер личного стола:',
        { parse_mode: 'HTML', reply_markup: keyboard },
      );
      return;
    }

    if (isGroup(ctx.chat)) {
      try {
        await openGroupLobby(ctx.chat.id, userId, username);
      } catch {
        await ctx.reply('Не удалось открыть стол. Проверь, что бот может отправлять сообщения в этой группе.');
      }
      return;
    }
    await ctx.reply('Игровой стол можно открыть в личном чате с ботом или в группе.');
  });

  for (const playerCount of [2, 3, 4, 5, 6]) {
    bot.callbackQuery(`create_${playerCount}`, async (ctx) => {
      await ctx.answerCallbackQuery();
      const telegramUser = ctx.from;
      const username = displayName(telegramUser);
      const { roomId } = rooms.createRoom(String(telegramUser.id), username, playerCount);
      const usernameFromApi = await getBotUsername();
      const inviteUrl = `https://t.me/${usernameFromApi}?start=room_${roomId}`;
      const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(inviteUrl)}&text=${encodeURIComponent('Залетай за стол OPTIMIST DURAK! 🃏')}`;
      const keyboard = new InlineKeyboard()
        .webApp('🃏 Открыть игровой стол', miniAppUrl(webAppUrl, roomId))
        .row()
        .url('📨 Пригласить друзей', shareUrl);
      await ctx.editMessageText(
        `Стол OPTIMIST DURAK создан.\n\nКомната: ${roomId}\nМест за столом: ${playerCount}\n\nОтправь приглашение друзьям и открывай игру. Запустить партию сможет создатель после подключения минимум двух игроков.`,
        { reply_markup: keyboard },
      );
    });
  }

  bot.callbackQuery(/^join_([a-f0-9]{16})$/, async (ctx) => {
    const roomId = ctx.match[1]!;
    const lobby = activeLobbies.get(roomId);
    const engine = rooms.getRoom(roomId);
    if (!lobby || lobby.status !== 'OPEN' || !engine || engine.state.phase !== 'WAITING_FOR_PLAYERS') {
      await ctx.answerCallbackQuery({ text: 'Этот стол уже запущен или закрыт.', show_alert: true });
      return;
    }
    const userId = String(ctx.from.id);
    // joinRoom is intentionally idempotent, but repeated taps should not trigger
    // a misleading success toast or an unnecessary Telegram message edit.
    if (engine.state.players.some((player) => player.id === userId)) {
      await ctx.answerCallbackQuery({ text: 'Ты уже за столом! Готовь козыри 😎' });
      return;
    }
    try {
      const result = await rooms.joinRoom(roomId, userId, displayName(ctx.from), true);
      onRoomChanged?.(roomId);
      await ctx.answerCallbackQuery({ text: 'Ты в игре! 🔥' });
      if (result.state.players.length >= MAX_GROUP_PLAYERS) {
        await launchGroupGame(lobby);
      } else {
        await updateLobbyMessage(lobby);
      }
    } catch (error) {
      await ctx.answerCallbackQuery({
        text: error instanceof Error ? error.message : 'Не удалось присоединиться к столу.',
        show_alert: true,
      });
    }
  });

  bot.callbackQuery(/^leave_([a-f0-9]{16})$/, async (ctx) => {
    const roomId = ctx.match[1]!;
    const lobby = activeLobbies.get(roomId);
    const engine = rooms.getRoom(roomId);
    if (!lobby || lobby.status !== 'OPEN' || !engine || engine.state.phase !== 'WAITING_FOR_PLAYERS') {
      await ctx.answerCallbackQuery({ text: 'Партия уже идёт или стол закрыт.', show_alert: true });
      return;
    }
    try {
      const result = await rooms.removeWaitingPlayer(roomId, String(ctx.from.id));
      lobby.creatorId = result.ownerId ?? '';
      onRoomChanged?.(roomId);
      if (result.playerCount === 0) {
        await ctx.answerCallbackQuery({ text: 'Ты вышел. Стол закрыт.' });
        await closeLobby(lobby, 'Все игроки разошлись, стол закрыт. Напишите /game для новой партии.');
        return;
      }
      await ctx.answerCallbackQuery({ text: 'Ты вышел из-за стола.' });
      await updateLobbyMessage(lobby);
    } catch (error) {
      await ctx.answerCallbackQuery({
        text: error instanceof Error ? error.message : 'Не удалось выйти из стола.',
        show_alert: true,
      });
    }
  });

  bot.callbackQuery(/^start_([a-f0-9]{16})$/, async (ctx) => {
    const roomId = ctx.match[1]!;
    const lobby = activeLobbies.get(roomId);
    const engine = rooms.getRoom(roomId);
    if (!lobby || lobby.status !== 'OPEN' || !engine) {
      await ctx.answerCallbackQuery({ text: 'Стол не найден или уже запущен.', show_alert: true });
      return;
    }
    if (String(ctx.from.id) !== lobby.creatorId) {
      await ctx.answerCallbackQuery({ text: 'Запустить партию может только создатель стола 👑', show_alert: true });
      return;
    }
    if (engine.state.players.length < 2) {
      await ctx.answerCallbackQuery({ text: 'Нужно минимум 2 игрока для старта.', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Раздаём карты! 🚀' });
    await launchGroupGame(lobby);
  });

  bot.callbackQuery('new_table', async (ctx) => {
    await ctx.answerCallbackQuery();
    const chat = ctx.chat;
    if (!chat || !isGroup(chat)) {
      await ctx.reply('Добавь бота в групповой чат и напиши /game.');
      return;
    }
    try {
      await openGroupLobby(chat.id, String(ctx.from.id), displayName(ctx.from));
    } catch {
      await ctx.reply('Не удалось открыть новый стол. Попробуй команду /game.');
    }
  });

  bot.catch((error) => {
  // Do not log bot tokens or raw initData. Telegram error messages may contain user data.
  console.error('[telegram-bot] handler failed:', String(error));
});

return bot;
}
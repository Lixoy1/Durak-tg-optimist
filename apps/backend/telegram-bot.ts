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

function miniAppUrl(baseUrl: string, roomId: string, mode: 'play' | 'spectate' = 'play'): string {
  const url = new URL(baseUrl);
  url.searchParams.set('roomId', roomId);
  if (mode === 'spectate') url.searchParams.set('mode', 'spectate');
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

  async function getBotUsername(): Promise<string> {
    if (!botUsername) {
      const info = await bot.api.getMe();
      botUsername = info.username ?? '';
    }
    if (!botUsername) throw new Error('Не удалось определить username бота для прямой ссылки Mini App.');
    return botUsername;
  }

  async function groupRoomEntryUrl(roomId: string): Promise<string> {
    const username = await getBotUsername();
    return `https://t.me/${username}?start=${encodeURIComponent(`room_${roomId}`)}`;
  }

  async function groupSpectatorEntryUrl(roomId: string): Promise<string> {
    const username = await getBotUsername();
    return `https://t.me/${username}?start=${encodeURIComponent(`watch_${roomId}`)}`;
  }

  function getLobbyEngine(lobby: GroupLobby) {
    return rooms.getRoom(lobby.roomId);
  }

  async function deleteGroupMessage(chatId: number, messageId: number): Promise<void> {
    try {
      await bot.api.deleteMessage(chatId, messageId);
    } catch (error) {
      console.warn('[telegram-bot] could not delete group message; check can_delete_messages permission:',
        error instanceof Error ? error.message : 'unknown');
    }
  }

  function renderLobbyText(lobby: GroupLobby): string {
    const engine = getLobbyEngine(lobby);
    if (!engine) return '<b>♠️ OPTIMIST — НЕ ДУРАК ♦️</b>\n\nЭтот стол уже сыграл свою партию. Открой новый — впереди ещё победы!';
    const players = engine.state.players;
    const lines = players.map((player, index) => {
      const crown = player.id === lobby.creatorId ? ' 👑 <i>капитан стола</i>' : '';
      return `${index + 1}. <b>${escapeHtml(player.username)}</b>${crown}`;
    });
    if (lines.length === 0) lines.push('<i>Команда только собирается. Стань первым!</i>');
    return [
      '<b>♠️ OPTIMIST — НЕ ДУРАК ♦️</b>',
      '',
      'Собираем команду OPTIMIST! Кто сегодня заберёт победу?',
      '',
      ...lines,
      '',
      `👥 <b>Команда:</b> ${players.length}/${engine.state.config.maxPlayers}`,
      `⏳ <b>До старта:</b> ${lobby.secondsLeft} сек.`,
      players.length >= 2 ? '\nКоманда готова? Капитан может начинать — пусть победит лучший настрой! 🚀' : '\nНужен ещё хотя бы один игрок — позови друга и погнали!',
    ].join('\n');
  }

  async function renderLobbyKeyboard(lobby: GroupLobby): Promise<InlineKeyboard> {
    const engine = getLobbyEngine(lobby);
    const count = engine?.state.players.length ?? 0;
    const keyboard = new InlineKeyboard()
      .text('➕ За стол!', `join_${lobby.roomId}`)
      .text('➖ Выйти', `leave_${lobby.roomId}`);
    if (count >= 2) keyboard.row().text('👑 Погнали!', `start_${lobby.roomId}`);
    keyboard.row().url('👀 На трибуну', await groupSpectatorEntryUrl(lobby.roomId));
    return keyboard;
  }

  async function updateLobbyMessage(lobby: GroupLobby): Promise<void> {
    if (lobby.status !== 'OPEN' || lobby.messageId === 0) return;
    try {
      await bot.api.editMessageText(lobby.chatId, lobby.messageId, renderLobbyText(lobby), {
        parse_mode: 'HTML',
        reply_markup: await renderLobbyKeyboard(lobby),
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
    const lines = [
      '<b>🏆✨ OPTIMIST DURAK — ФИНАЛЬНЫЙ СВИСТОК! ✨🏆</b>',
      '',
      '━━━━━━━━━━━━━━━━━━',
      '<b>РЕЗУЛЬТАТЫ ПАРТИИ</b>',
      '',
    ];
    winners.forEach((player, index) => {
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '🌟';
      lines.push(`${medal} <b>${escapeHtml(player.username)}</b> — место ${player.finishOrder ?? index + 1}`);
    });
    lines.push('');
    if (loser) {
      lines.push(
        `🃏 <b>ХРАНИТЕЛЬ КОЛОДЫ: ${escapeHtml(loser.username)}</b>`,
        '<i>Колода сегодня выбрала своего героя. Не грусти — реванш уже точит козыри! 😎</i>',
      );
    } else {
      lines.push('🤝 <b>Ничья! Сегодня победили дружба и красивый азарт.</b>');
    }

    lines.push('', '━━━━━━━━━━━━━━━━━━', '<b>📊 ЛИЧНАЯ ЛЕТОПИСЬ</b>');
    for (const player of state.players) {
      if (player.id === 'ai_optimist') continue;
      const stats = rooms.getProfile(player.id, player.username);
      lines.push(
        `• <b>${escapeHtml(player.username)}</b>: ${stats.games} игр · 🏆 ${stats.wins} побед · 🤡 ${stats.losses} раз был дураком`,
      );
    }

    const durakTop = rooms.getDurakLeaderboard(3);
    if (durakTop.length) {
      lines.push('', '━━━━━━━━━━━━━━━━━━', '<b>🤡 ЗАЛ СЛАВЫ ХРАНИТЕЛЕЙ КОЛОДЫ</b>');
      durakTop.forEach((player, index) => {
        const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : '🥉';
        lines.push(`${medal} ${escapeHtml(player.username)} — ${player.losses} раз`);
      });
    }

    lines.push('', '🔥 Отличная битва, команда! Кто готов на реванш?');
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
      await deleteGroupMessage(lobby.chatId, lobby.messageId);
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
      const url = await groupRoomEntryUrl(lobby.roomId);
      const spectatorUrl = await groupSpectatorEntryUrl(lobby.roomId);
      await bot.api.editMessageText(lobby.chatId, lobby.messageId, [
        '<b>🔥 OPTIMIST — ПОЕХАЛИ! ПАРТИЯ НАЧАЛАСЬ!</b>',
        '',
        `👥 <b>Команда за столом:</b> ${players}`,
        `🃏 Карты на руках! Первый ход за <b>${escapeHtml(firstPlayer)}</b> — покажи красивую игру!`,
        '',
        'Игроки нажимают «Войти в общую партию». Зрители — «На трибуну»: у них отдельный чат и реакции, но нет доступа к картам игроков.',
      ].join('\\n'), {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .url('🃏 Войти в общую партию', url)
          .row()
          .url('👀 Смотреть матч', spectatorUrl),
      });
    } catch (error) {
      console.error('[telegram-bot] game started but group link could not be published:', error instanceof Error ? error.message : 'unknown');
      await bot.api.sendMessage(lobby.chatId, 'Партия уже началась, но ссылка на игровой стол не собралась. Проверь BOT_USERNAME и APP_SHORT_NAME в настройках бота.').catch(() => {});
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
      await closeLobby(lobby, 'Этот стол завершил работу. Напиши /game — и откроем новый, удача любит решительных!');
      return;
    }
    if (lobby.secondsLeft === 0) {
      if (engine.state.players.length >= 2) {
        await launchGroupGame(lobby);
      } else {
        await closeLobby(lobby, 'Время сбора команды вышло. Для игры нужны хотя бы 2 игрока — напиши /durak и позови друга!');
      }
      return;
    }
    await updateLobbyMessage(lobby);
  }

  async function openGroupLobby(chatId: number, creatorId: string, creatorName: string): Promise<void> {
    const existingId = activeLobbyByChat.get(chatId);
    const existing = existingId ? activeLobbies.get(existingId) : undefined;
    if (existing?.status === 'OPEN') {
      await updateLobbyMessage(existing);
      return;
    }

    const { roomId } = rooms.createRoom(creatorId, creatorName, MAX_GROUP_PLAYERS, { allowInviteJoin: false, allowSpectators: true });
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
        reply_markup: await renderLobbyKeyboard(lobby),
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
      await ctx.reply('Не удалось узнать игрока. Перезапусти бота — и снова в бой!');
      return;
    }
    const userId = String(telegramUser.id);
    const username = displayName(telegramUser);
    const payload = typeof ctx.match === 'string' ? ctx.match.trim() : '';

    if (ctx.chat.type === 'private' && payload.startsWith('watch_')) {
      const roomId = payload.slice('watch_'.length);
      const room = rooms.getRoom(roomId);
      if (!room) {
        await ctx.reply('Матч уже завершён или ушёл в историю. Возвращайся в группу — следующая партия не за горами!');
        return;
      }
      try {
        if (room.state.players.some((player) => player.id === userId)) {
          await ctx.reply('Ты уже игрок этой партии! Для тебя открыта кнопка входа игрока в групповом сообщении. 👑');
          return;
        }
        const spectator = await rooms.spectateRoom(roomId, userId, username);
        onRoomChanged?.(roomId);
        const keyboard = new InlineKeyboard().webApp('👁 Смотреть матч', miniAppUrl(webAppUrl, roomId, 'spectate'));
        await ctx.reply(
          `Ты на трибуне OPTIMIST! В общей партии ${spectator.state.players.length} игроков. Видишь игровое поле, можешь реагировать и общаться в отдельном чате зрителей — карты игроков останутся секретом.`,
          { reply_markup: keyboard },
        );
      } catch (error) {
        await ctx.reply(error instanceof Error ? error.message : 'Не удалось открыть место на трибуне.');
      }
      return;
    }

    if (ctx.chat.type === 'private' && payload.startsWith('room_')) {
      const roomId = payload.slice('room_'.length);
      const room = rooms.getRoom(roomId);
      if (!room) {
        await ctx.reply('Не удалось найти эту общую комнату. Не создавай новую через личный /start — вернись в групповой чат и начни новую партию командой /durak.');
        return;
      }
      try {
        const isGroupRoom = !rooms.canJoinByInvite(roomId) && !rooms.isPublicRoom(roomId);
        const wasAlreadyInRoom = room.state.players.some((player) => player.id === userId);
        const snapshot = await rooms.joinRoom(roomId, userId, username);
        onRoomChanged?.(roomId);
        const keyboard = new InlineKeyboard().webApp('🃏 Открыть OPTIMIST DURAK', miniAppUrl(webAppUrl, roomId));
        const entryText = isGroupRoom
          ? `Ты в общей партии OPTIMIST! Комната ${roomId}. Игроков за столом: ${snapshot.state.players.length}/${room.state.config.maxPlayers}. Это та самая комната из группового чата — нажми кнопку ниже, чтобы войти за свой игровой стол.`
          : `Ты в команде OPTIMIST DURAK! Игроков за столом: ${snapshot.state.players.length}/${room.state.config.maxPlayers}. Открывай игру — удача любит смелых!`;
        if (isGroupRoom && !wasAlreadyInRoom) {
          throw new Error('Эта общая партия предназначена только для игроков, уже присоединившихся к столу в групповом чате.');
        }
        await ctx.reply(entryText, { reply_markup: keyboard });
      } catch (error) {
        await ctx.reply(error instanceof Error ? error.message : 'Не удалось присоединиться к столу.');
      }
      return;
    }

    if (ctx.chat.type === 'private') {
      const keyboard = new InlineKeyboard()
        .text('2 места', 'create_2').text('3 места', 'create_3').row()
        .text('4 места', 'create_4').text('5 мест', 'create_5').row()
        .text('6 мест', 'create_6');
      await ctx.reply(
        '♠️ <b>OPTIMIST DURAK</b> ♦️\n\n36 авторских карт. Золотая колода. Чёрное сукно. Здесь проигрыш — лишь повод вернуться за реваншем. 😎\n\n🎲 <b>Личный стол:</b> выбери вместимость от 2 до 6 мест. Бот откроет отдельную комнату, а ты пригласишь друзей.\n\n👥 <b>Игра в группе:</b> добавь бота в групповой чат и напиши <code>/durak</code> — соберём общий стол прямо здесь.\n\nСколько мест оставим за твоим личным столом?',
        { parse_mode: 'HTML', reply_markup: keyboard },
      );
      return;
    }

    if (isGroup(ctx.chat)) {
      try {
        await openGroupLobby(ctx.chat.id, userId, username);
        // Remove the command itself after handling it; the bot's lobby message remains as the game entry point.
        await ctx.deleteMessage().catch((error: unknown) => {
          console.warn('[telegram-bot] could not delete group command; grant the bot can_delete_messages:',
            error instanceof Error ? error.message : 'unknown');
        });
      } catch {
        await ctx.reply('Не получилось открыть стол. Проверь, что бот может писать в этой группе, и попробуй ещё раз!');
      }
      return;
    }
    await ctx.reply('Стол OPTIMIST можно открыть в личном чате с ботом или прямо в группе. Выбирай компанию и начинай!');
  });

  for (const playerCount of [2, 3, 4, 5, 6]) {
    bot.callbackQuery(`create_${playerCount}`, async (ctx) => {
      await ctx.answerCallbackQuery();
      const telegramUser = ctx.from;
      const username = displayName(telegramUser);
      const { roomId } = rooms.createRoom(String(telegramUser.id), username, playerCount);
      const usernameFromApi = await getBotUsername();
      const inviteUrl = `https://t.me/${usernameFromApi}?start=room_${roomId}`;
      const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(inviteUrl)}&text=${encodeURIComponent('Залетай за стол OPTIMIST DURAK! 36 карт и море азарта — погнали! 🃏')}`;
      const keyboard = new InlineKeyboard()
        .webApp('🃏 Открыть личный стол', miniAppUrl(webAppUrl, roomId))
        .row()
        .url('📨 Пригласить друзей', shareUrl);
      await ctx.editMessageText(
        `Личный стол OPTIMIST DURAK готов! 🚀\n\nКомната: ${roomId}\nМест за столом: ${playerCount}\n\nЭто отдельная личная комната — она не подключает тебя к партии из группового чата. Пригласи друга по ссылке, чтобы он тоже вошёл за этот стол. Когда вас будет минимум двое, капитан сможет начать игру.\n\nДля продолжения уже начатой партии вернись в групповой чат и нажми кнопку «Открыть OPTIMIST DURAK» под сообщением о старте.`,
        { reply_markup: keyboard },
      );
    });
  }

  bot.callbackQuery(/^join_([a-f0-9]{16})$/, async (ctx) => {
    const roomId = ctx.match[1]!;
    const lobby = activeLobbies.get(roomId);
    const engine = rooms.getRoom(roomId);
    if (!lobby || lobby.status !== 'OPEN' || !engine || engine.state.phase !== 'WAITING_FOR_PLAYERS') {
      await ctx.answerCallbackQuery({ text: 'Этот стол уже начал игру или завершил сбор. Открой новый — и вперёд!', show_alert: true });
      return;
    }
    const userId = String(ctx.from.id);
    // joinRoom is intentionally idempotent, but repeated taps should not trigger
    // a misleading success toast or an unnecessary Telegram message edit.
    if (engine.state.players.some((player) => player.id === userId)) {
      await ctx.answerCallbackQuery({ text: 'Ты уже в команде! Готовь козыри и хорошее настроение 😎' });
      return;
    }
    try {
      const result = await rooms.joinRoom(roomId, userId, displayName(ctx.from), true);
      onRoomChanged?.(roomId);
      await ctx.answerCallbackQuery({ text: 'Ты за столом! Пусть начнётся красивая игра 🔥' });
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
      await ctx.answerCallbackQuery({ text: 'Партия уже в движении или стол завершил сбор.', show_alert: true });
      return;
    }
    try {
      const result = await rooms.removeWaitingPlayer(roomId, String(ctx.from.id));
      lobby.creatorId = result.ownerId ?? '';
      onRoomChanged?.(roomId);
      if (result.playerCount === 0) {
        await ctx.answerCallbackQuery({ text: 'Ты покинул стол. Команда разошлась — в следующий раз соберём полный состав!' });
        await closeLobby(lobby, 'Все игроки разошлись, стол закрыт. Напишите /durak для новой партии.');
        return;
      }
      await ctx.answerCallbackQuery({ text: 'Ты вышел из-за стола. Возвращайся, когда захочешь сыграть!' });
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
      await ctx.answerCallbackQuery({ text: 'Кнопка старта у капитана стола 👑', show_alert: true });
      return;
    }
    if (engine.state.players.length < 2) {
      await ctx.answerCallbackQuery({ text: 'Позови ещё одного игрока — и можно раздавать карты!', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Карты на раздачу — начинаем! 🚀' });
    await launchGroupGame(lobby);
  });

  bot.callbackQuery('new_table', async (ctx) => {
    await ctx.answerCallbackQuery();
    const chat = ctx.chat;
    if (!chat || !isGroup(chat)) {
      await ctx.reply('Добавь бота в групповой чат и напиши /durak — соберём команду!');
      return;
    }
    try {
      await openGroupLobby(chat.id, String(ctx.from.id), displayName(ctx.from));
    } catch {
      await ctx.reply('Новый стол пока не открылся. Напиши /game — попробуем ещё раз!');
    }
  });

  bot.catch((error) => {
  // Do not log bot tokens or raw initData. Telegram error messages may contain user data.
  console.error('[telegram-bot] handler failed:', String(error));
});

return bot;
}
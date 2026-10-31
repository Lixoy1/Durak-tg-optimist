import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { RoomManager, RoomError, type ChatMessage, type RoomReaction, type TableEffect } from './RoomManager.ts';
import { PersistentStore } from './storage.ts';
import { verifyTelegramInitData, AuthError } from './auth.ts';
import { parseClientMessage, ProtocolError, type ClientMessage } from './protocol.ts';
import { createTelegramBot } from './telegram-bot.ts';

export interface BackendOptions {
  botToken: string;
  webAppUrl: string;
  port?: number;
  host?: string;
  allowedOrigins?: string[];
  nowSeconds?: () => number;
  storageFile?: string | null;
  aiDelayMs?: number;
}

interface Session {
  userId?: string;
  username?: string;
  roomId?: string;
  viewerRole?: 'PLAYER' | 'SPECTATOR';
  alive: boolean;
  authTimer: ReturnType<typeof setTimeout>;
  frameTimes: number[];
  strikes: number;
}

const MAX_FRAMES_PER_WINDOW = 60;
const FRAME_WINDOW_MS = 10_000;
const AUTH_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage, maxBytes = 4_096): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new ProtocolError('PAYLOAD_TOO_LARGE', 'Слишком большой запрос.');
    chunks.push(buffer);
  }
  if (total === 0) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ProtocolError('INVALID_JSON', 'Некорректный JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProtocolError('INVALID_JSON', 'Ожидался JSON-объект.');
  }
  return parsed as Record<string, unknown>;
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function errorPayload(error: unknown): { event: 'ERROR'; code: string; message: string } {
  if (error instanceof RoomError || error instanceof ProtocolError || error instanceof AuthError) {
    return { event: 'ERROR', code: error.code, message: error.message };
  }
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    return { event: 'ERROR', code: String(error.code), message: String(error.message) };
  }
  return { event: 'ERROR', code: 'INTERNAL_ERROR', message: 'Не удалось обработать запрос. Попробуй ещё раз.' };
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function errorStatus(error: unknown): number {
  if (error instanceof AuthError) return 401;
  if (error instanceof RoomError) return 403;
  if (error instanceof ProtocolError) return error.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
  return 500;
}

export function createOptimistBackend(options: BackendOptions) {
  if (!options.botToken || !options.botToken.includes(':')) throw new Error('BOT_TOKEN не задан или имеет неверный формат.');
  const webApp = new URL(options.webAppUrl);
  if (webApp.protocol !== 'https:' && webApp.hostname !== 'localhost' && webApp.hostname !== '127.0.0.1') {
    throw new Error('WEBAPP_URL должен использовать HTTPS (кроме локальной разработки).');
  }

  const storageFile = options.storageFile !== undefined ? options.storageFile : (process.env.STORAGE_FILE ?? null);
  const store = new PersistentStore(storageFile);
  const rooms = new RoomManager(Date.now, store, options.aiDelayMs ?? 350);
  const sessions = new Map<WebSocket, Session>();
  const roomSockets = new Map<string, Set<WebSocket>>();
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map((origin) => origin.trim()).filter(Boolean));
  if (process.env.NODE_ENV === 'production' && allowedOrigins.size === 0) {
    store.close();
    throw new Error('В production обязательно укажи ALLOWED_ORIGINS.');
  }
  const publicRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../mini-app/public');

  function authenticateHttp(req: IncomingMessage) {
    const rawInitData = req.headers['x-telegram-init-data'];
    if (typeof rawInitData !== 'string' || !rawInitData.trim()) {
      throw new AuthError('MISSING_INIT_DATA', 'Не передан заголовок x-telegram-init-data.');
    }
    return verifyTelegramInitData(rawInitData, options.botToken, {
      nowSeconds: options.nowSeconds?.() ?? Math.floor(Date.now() / 1000),
      maxAgeSeconds: 600,
      futureSkewSeconds: 30,
    });
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/api/')) return false;
    try {
      const user = authenticateHttp(req);

      if (req.method === 'GET' && url.pathname === '/api/lobby') {
        writeJson(res, 200, { rooms: rooms.listPublicRooms() });
        return true;
      }
      if (req.method === 'GET' && url.pathname === '/api/profile') {
        writeJson(res, 200, { profile: rooms.getProfile(user.id, user.username), settings: rooms.getUserSettings(user.id) });
        return true;
      }
      if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
        writeJson(res, 200, { leaderboard: rooms.getLeaderboard(15) });
        return true;
      }
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
        writeJson(res, 200, {
          profile: rooms.getProfile(user.id, user.username),
          leaderboard: rooms.getLeaderboard(15),
          settings: rooms.getUserSettings(user.id),
          lobbyRooms: rooms.listPublicRooms(),
        });
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/api/rooms') {
        const body = await readJsonBody(req);
        if (body.vsAi === true) {
          const created = await rooms.createAiRoom(user.id, user.username);
          writeJson(res, 201, { roomId: created.roomId });
          return true;
        }
        if (body.maxPlayers !== undefined && (typeof body.maxPlayers !== 'number' || !Number.isInteger(body.maxPlayers))) {
          throw new ProtocolError('INVALID_ROOM_CONFIG', 'maxPlayers должен быть целым числом.');
        }
        if (body.isPublic !== undefined && typeof body.isPublic !== 'boolean') {
          throw new ProtocolError('INVALID_ROOM_CONFIG', 'isPublic должен быть логическим значением.');
        }
        const maxPlayers = typeof body.maxPlayers === 'number' ? Math.min(6, Math.max(2, body.maxPlayers)) : 2;
        const isPublic = body.isPublic !== false;
        const rawGameConfig = body.gameConfig === undefined ? {} : body.gameConfig;
        if (!rawGameConfig || typeof rawGameConfig !== 'object' || Array.isArray(rawGameConfig)) {
          throw new ProtocolError('INVALID_ROOM_CONFIG', 'gameConfig должен быть объектом настроек правил.');
        }
        const gameConfig = rawGameConfig as Record<string, unknown>;
        if (gameConfig.firstBoutMaxCards !== undefined && gameConfig.firstBoutMaxCards !== 5 && gameConfig.firstBoutMaxCards !== 6) {
          throw new ProtocolError('INVALID_ROOM_CONFIG', 'Лимит первого захода может быть только 5 или 6 карт.');
        }
        if (gameConfig.mode !== undefined && gameConfig.mode !== 'PODKIDNOY' && gameConfig.mode !== 'PEREVODNOY') {
          throw new ProtocolError('INVALID_ROOM_CONFIG', 'Режим должен быть PODKIDNOY или PEREVODNOY.');
        }
        if (gameConfig.afterTake !== undefined && gameConfig.afterTake !== 'ATTACKER' && gameConfig.afterTake !== 'DEFENDER') {
          throw new ProtocolError('INVALID_ROOM_CONFIG', 'Правило после взятия должно быть ATTACKER или DEFENDER.');
        }
        const created = rooms.createRoom(user.id, user.username, maxPlayers, {
          allowInviteJoin: true,
          isPublic,
          gameConfig: {
            firstBoutMaxCards: (gameConfig.firstBoutMaxCards as 5 | 6 | undefined) ?? 6,
            mode: (gameConfig.mode as 'PODKIDNOY' | 'PEREVODNOY' | undefined) ?? 'PODKIDNOY',
            afterTake: (gameConfig.afterTake as 'ATTACKER' | 'DEFENDER' | undefined) ?? 'ATTACKER',
          },
        });
        writeJson(res, 201, { roomId: created.roomId });
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/api/settings') {
        const body = await readJsonBody(req);
        if (body.trumpPosition !== undefined && body.trumpPosition !== 'left' && body.trumpPosition !== 'right') {
          throw new ProtocolError('INVALID_SETTINGS', 'trumpPosition должен быть left или right.');
        }
        if (body.soundEnabled !== undefined && typeof body.soundEnabled !== 'boolean') {
          throw new ProtocolError('INVALID_SETTINGS', 'soundEnabled должен быть логическим значением.');
        }
        if (body.tableTheme !== undefined && body.tableTheme !== 'emerald' && body.tableTheme !== 'ruby' && body.tableTheme !== 'night') {
          throw new ProtocolError('INVALID_SETTINGS', 'tableTheme должен быть emerald, ruby или night.');
        }
        const settings = rooms.updateUserSettings(user.id, {
          ...(body.trumpPosition !== undefined ? { trumpPosition: body.trumpPosition } : {}),
          ...(body.soundEnabled !== undefined ? { soundEnabled: body.soundEnabled } : {}),
          ...(body.tableTheme !== undefined ? { tableTheme: body.tableTheme } : {}),
        });
        writeJson(res, 200, { settings });
        return true;
      }
      writeJson(res, 404, { error: 'Not found' });
      return true;
    } catch (error) {
      const payload = errorPayload(error);
      writeJson(res, errorStatus(error), payload);
      return true;
    }
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://localhost'); }
    catch { writeJson(res, 400, { error: 'Bad request' }); return; }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      writeJson(res, 200, { status: 'ok', service: 'optimist-durak', timestamp: new Date().toISOString() });
      return;
    }
    if (await handleApi(req, res, url)) return;
    if (req.method !== 'GET' || (url.pathname !== '/' && !url.pathname.startsWith('/assets/'))) {
      writeJson(res, 404, { error: 'Not found' });
      return;
    }

    let requestPath: string;
    try { requestPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); }
    catch { writeJson(res, 400, { error: 'Malformed path' }); return; }
    const filePath = resolve(publicRoot, `.${requestPath}`);
    const rel = relative(publicRoot, filePath);
    if (rel.startsWith('..') || rel.includes('\\') || rel === '') {
      writeJson(res, 403, { error: 'Forbidden' });
      return;
    }

    try {
      const body = await readFile(filePath);
      const extension = extname(filePath).toLowerCase();
      const contentType: Record<string, string> = {
        '.html': 'text/html; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png',
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
        '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      };
      res.writeHead(200, {
        'content-type': contentType[extension] ?? 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'cache-control': extension === '.html' ? 'no-cache' : 'public, max-age=86400',
        'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://telegram.org; connect-src 'self' ws: wss:; frame-ancestors https://web.telegram.org https://*.telegram.org",
      });
      res.end(body);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR') writeJson(res, 404, { error: 'Not found' });
      else {
        console.error('[http] static-file error:', code ?? 'unknown');
        writeJson(res, 500, { error: 'Internal server error' });
      }
    }
  }

  const server = createServer((req, res) => {
    void handleHttp(req, res).catch((error: unknown) => {
      console.error('[http] request failed:', error instanceof Error ? error.message : 'unknown');
      if (!res.headersSent) writeJson(res, 500, { error: 'Internal server error' });
      else res.destroy();
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024, perMessageDeflate: false });

  function roomSet(roomId: string): Set<WebSocket> {
    let set = roomSockets.get(roomId);
    if (!set) { set = new Set<WebSocket>(); roomSockets.set(roomId, set); }
    return set;
  }

  function broadcastRoomSync(roomId: string): void {
    for (const ws of roomSockets.get(roomId) ?? []) {
      const session = sessions.get(ws);
      if (!session?.userId) continue;
      try { sendJson(ws, { event: 'ROOM_SYNC', payload: rooms.getSnapshot(roomId, session.userId) }); }
      catch (error) {
        sendJson(ws, errorPayload(error));
        ws.close(4403, 'Room access revoked');
      }
    }
  }

  rooms.setRoomChangeListener(broadcastRoomSync);

  function broadcastChat(roomId: string, message: ChatMessage): void {
    // One shared room chat for players and spectators alike.
    for (const ws of roomSockets.get(roomId) ?? []) {
      if (sessions.has(ws)) sendJson(ws, { event: 'CHAT_MESSAGE', payload: message });
    }
  }

  function broadcastRoomMoment(roomId: string, event: 'TABLE_REACTION' | 'TABLE_EFFECT', payload: RoomReaction | TableEffect): void {
    for (const ws of roomSockets.get(roomId) ?? []) sendJson(ws, { event, payload });
  }

  async function handleAuthenticatedMessage(ws: WebSocket, session: Session, msg: ClientMessage): Promise<void> {
    if (!session.userId || !session.roomId) {
      if (msg.type !== 'AUTH') throw new ProtocolError('AUTH_REQUIRED', 'Сначала авторизуйся через Telegram.');
      const user = verifyTelegramInitData(msg.initData, options.botToken, {
        nowSeconds: options.nowSeconds?.() ?? Math.floor(Date.now() / 1000),
        maxAgeSeconds: 600,
        futureSkewSeconds: 30,
      });
      const engine = rooms.getRoom(msg.roomId);
      if (!engine) throw new RoomError('ROOM_NOT_FOUND', 'Стол не найден.');
      const isMember = engine.state.players.some((player) => player.id === user.id);
      if (!isMember) {
        if (msg.mode === 'spectate') {
          await rooms.spectateRoom(msg.roomId, user.id, user.username);
          session.viewerRole = 'SPECTATOR';
        } else {
          if (!rooms.canJoinByInvite(msg.roomId) && !rooms.isPublicRoom(msg.roomId)) {
            throw new RoomError('NOT_A_MEMBER', 'Эта партия собирает игроков в группе. Сначала нажми «Присоединиться» в сообщении лобби.');
          }
          await rooms.joinRoom(msg.roomId, user.id, user.username);
          session.viewerRole = 'PLAYER';
        }
      } else {
        session.viewerRole = 'PLAYER';
      }
      session.userId = user.id;
      session.username = user.username;
      session.roomId = msg.roomId;
      clearTimeout(session.authTimer);
      roomSet(msg.roomId).add(ws);
      sendJson(ws, { event: 'AUTH_OK', payload: { userId: user.id, username: user.username, roomId: msg.roomId } });
      broadcastRoomSync(msg.roomId);
      return;
    }

    if (msg.type === 'AUTH') throw new ProtocolError('ALREADY_AUTHENTICATED', 'Соединение уже авторизовано.');
    const roomId = session.roomId;
    const playerId = session.userId;
    switch (msg.type) {
      case 'START_GAME':
        await rooms.startGame(roomId, playerId);
        broadcastRoomSync(roomId);
        return;
      case 'GAME_ACTION':
        await rooms.dispatchAction(roomId, playerId, msg.action, msg.commandId);
        broadcastRoomSync(roomId);
        return;
      case 'SEND_CHAT': {
        const message = await rooms.sendChat(roomId, playerId, msg.text);
        broadcastChat(roomId, message);
        return;
      }
      case 'SEND_SPECTATOR_CHAT': {
        const message = await rooms.sendChat(roomId, playerId, msg.text);
        broadcastChat(roomId, message);
        return;
      }
      case 'SEND_REACTION': {
        const reaction = await rooms.sendReaction(roomId, playerId, msg.reaction);
        broadcastRoomMoment(roomId, 'TABLE_REACTION', reaction);
        return;
      }
      case 'SEND_TABLE_EFFECT': {
        const effect = await rooms.sendTableEffect(roomId, playerId, msg.effect);
        broadcastRoomMoment(roomId, 'TABLE_EFFECT', effect);
        return;
      }
      default: {
        const exhaustive: never = msg;
        throw new ProtocolError('UNKNOWN_MESSAGE', `Неподдерживаемое сообщение: ${String(exhaustive)}`);
      }
    }
  }

  server.on('upgrade', (request, socket, head) => {
    let url: URL;
    try { url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`); }
    catch { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    const origin = request.headers.origin;
    if (allowedOrigins.size > 0 && (!origin || !allowedOrigins.has(origin))) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });

  wss.on('connection', (ws) => {
    const session: Session = {
      alive: true,
      frameTimes: [],
      strikes: 0,
      authTimer: setTimeout(() => ws.close(4401, 'Authentication timeout'), AUTH_TIMEOUT_MS),
    };
    sessions.set(ws, session);
    ws.on('pong', () => { session.alive = true; });

    let inboundQueue: Promise<void> = Promise.resolve();
    ws.on('message', (raw: RawData) => {
      inboundQueue = inboundQueue.then(async () => {
        const now = Date.now();
        session.frameTimes = session.frameTimes.filter((time) => now - time < FRAME_WINDOW_MS);
        session.frameTimes.push(now);
        if (session.frameTimes.length > MAX_FRAMES_PER_WINDOW) { ws.close(4429, 'Rate limit exceeded'); return; }
        try {
          const msg = parseClientMessage(rawDataToBuffer(raw));
          await handleAuthenticatedMessage(ws, session, msg);
        } catch (error) {
          session.strikes++;
          sendJson(ws, errorPayload(error));
          if (session.strikes >= 5 || error instanceof AuthError) ws.close(4400, 'Invalid client messages');
        }
      }).catch((error: unknown) => {
        console.error('[ws] unhandled message failure:', error instanceof Error ? error.message : 'unknown');
        sendJson(ws, { event: 'ERROR', code: 'INTERNAL_ERROR', message: 'Внутренняя ошибка. Попробуй ещё раз.' });
      });
    });

    ws.on('close', () => {
      clearTimeout(session.authTimer);
      sessions.delete(ws);
      if (session.roomId) {
        const roomId = session.roomId;
        const set = roomSockets.get(roomId);
        set?.delete(ws);
        if (set?.size === 0) roomSockets.delete(roomId);
        if (session.viewerRole === 'SPECTATOR' && session.userId) {
          const anotherSession = [...sessions.values()].some((other) =>
            other.roomId === roomId && other.userId === session.userId && other.viewerRole === 'SPECTATOR'
          );
          if (!anotherSession) void rooms.removeSpectator(roomId, session.userId).catch(() => {});
        }
      }
    });
    ws.on('error', (error: Error) => console.warn('[ws] socket error:', error.message));
  });

  const heartbeat = setInterval(() => {
    for (const [ws, session] of sessions) {
      if (!session.alive) { ws.terminate(); continue; }
      session.alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  const roomCleanup = setInterval(() => { rooms.pruneIdleRooms(); }, 10 * 60 * 1000);
  roomCleanup.unref();

  const bot = createTelegramBot({
    token: options.botToken,
    webAppUrl: options.webAppUrl,
    ...(process.env.BOT_USERNAME ? { botUsername: process.env.BOT_USERNAME } : {}),
    ...(process.env.APP_SHORT_NAME ? { appShortName: process.env.APP_SHORT_NAME } : {}),
    rooms,
    onRoomChanged: broadcastRoomSync,
  });

  async function listen(): Promise<void> {
    const port = options.port ?? 3000;
    const host = options.host ?? '0.0.0.0';
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolveListen(); });
    });
  }

  function startBot(): void {
    void (async () => {
      try {
        // /start is commonly used by other game bots in shared groups.
        // Publish a bot-specific /durak entry instead of competing for that command.
        await bot.api.setMyCommands([
          { command: 'durak', description: 'Открыть стол OPTIMIST в группе' },
          { command: 'game', description: 'Собрать компанию за столом' },
        ], { scope: { type: 'all_group_chats' } });
        await bot.api.setMyCommands([
          { command: 'start', description: 'Открыть OPTIMIST DURAK' },
          { command: 'durak', description: 'Открыть OPTIMIST DURAK' },
        ], { scope: { type: 'all_private_chats' } });
        console.log('[telegram-bot] command menus registered for private and group chats');
      } catch (error) {
        // A command-menu update must never prevent the bot from polling updates.
        console.warn('[telegram-bot] command menu registration failed:', error instanceof Error ? error.message : 'unknown');
      }

      try {
        await bot.start({ onStart: (botInfo) => console.log(`[telegram-bot] @${botInfo.username} started`) });
      } catch (error) {
        console.error('[telegram-bot] polling failed:', error instanceof Error ? error.message : 'unknown');
      }
    })();
  }

  async function close(): Promise<void> {
    clearInterval(heartbeat);
    clearInterval(roomCleanup);
    rooms.clearAllTimers();
    try { bot.stop(); } catch { /* Bot polling was not started (e.g. test shutdown). */ }
    for (const ws of sessions.keys()) ws.close(1001, 'Server shutting down');
    await new Promise<void>((resolveClose) => wss.close(() => resolveClose()));
    if (server.listening) await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    rooms.store.close();
  }

  return { server, wss, bot, rooms, listen, startBot, close, broadcastRoomSync };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const token = process.env.BOT_TOKEN ?? '';
  const webAppUrl = process.env.WEBAPP_URL ?? '';
  if (!webAppUrl) throw new Error('Нужно задать WEBAPP_URL.');
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (process.env.NODE_ENV === 'production' && allowedOrigins.length === 0) {
    throw new Error('В production обязательно укажи ALLOWED_ORIGINS.');
  }
  const app = createOptimistBackend({ botToken: token, webAppUrl, port: Number(process.env.PORT ?? 3000), allowedOrigins });
  await app.listen();
  app.startBot();
  console.log(`[backend] listening on ${process.env.PORT ?? 3000}; health endpoint: /healthz`);

  const shutdown = () => { void app.close().then(() => process.exit(0)); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

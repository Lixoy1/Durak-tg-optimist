# Stage 3 — Integration runbook

## What is included

- `apps/backend/server.ts`: HTTP static serving, health check, WebSocket authentication, room broadcast, heartbeat, per-connection throttling, graceful shutdown.
- `apps/backend/telegram-bot.ts`: Telegram `/start`, private 2–6 player rooms, group `/game` lobby, room deep links, direct Mini App links, host handoff and end-of-game group results.
- `apps/mini-app/public/index.html`: starter dark/gold/ruby UI, hand, table, legal game actions, chat drawer, reconnect and error handling.
- `tests/backend.test.mjs`: health/static route, Telegram HMAC auth, personalized hand visibility and origin allow-list tests.

## Configuration

Copy `.env.example` to `.env`; fill `BOT_TOKEN`; configure `APP_SHORT_NAME` to match the Mini App short name from `@BotFather` and optionally set `BOT_USERNAME`; set `WEBAPP_URL`; set `ALLOWED_ORIGINS` to the exact origin from which the Mini App is served. The server uses long polling for the bot and serves the Mini App in the same process, so `WEBAPP_URL` is usually the public base URL of the same service.

For local-only HTTP smoke testing, `WEBAPP_URL=http://localhost:3000` and `ALLOWED_ORIGINS=http://localhost:3000` are accepted. But Telegram's Web App button requires an HTTPS URL, so for an end-to-end Telegram test use an HTTPS tunnel or deployed domain forwarding to port 3000:

```dotenv
BOT_TOKEN=123456789:your_real_token
WEBAPP_URL=https://your-tunnel-domain.example
PORT=3000
ALLOWED_ORIGINS=https://your-tunnel-domain.example
NODE_ENV=development
```

Run:

```bash
npm install
npm run typecheck
npm test
npm run simulate
npm start
```

## Protocol

1. Client connects to `ws(s)://<host>/ws`.
2. First frame must be `{ "type": "AUTH", "roomId": "<room id>", "initData": "<Telegram.WebApp.initData>" }`.
3. The server verifies the Telegram HMAC and freshness. Private invite rooms may enroll a user from the invite link; group rooms require prior membership in the lobby roster.
4. `AUTH_OK` confirms the server-derived identity. `ROOM_SYNC` includes that viewer's safe snapshot and the last 50 chat messages.
5. `START_GAME` can only be used by the room owner. `GAME_ACTION` requires a unique `commandId` and the current `expectedVersion`. `SEND_CHAT` is room-member only and rate-limited.
6. After a state change, each socket receives a separately sanitized `ROOM_SYNC`; no player's hand is sent to opponents.

## Before public launch

- Put the service behind TLS/HTTPS and ensure the reverse proxy forwards WebSocket `Upgrade` headers.
- Set `NODE_ENV=production` and configure `ALLOWED_ORIGINS`.
- The 36 custom card faces and card back are included in the packaged public paths; `tests/card-assets.test.mjs` verifies all assets.
- Test in Telegram on Android, iOS and Desktop.
- Replace in-memory room state with PostgreSQL persistence before promising reliable recovery.
- Decide how long abandoned lobbies survive and review monitoring / backup policy.

# OPTIMIST DURAK — Engine, Security, and Telegram Integration

This is the current OPTIMIST DURAK prototype: a server-authoritative Durak engine, Telegram bot, in-memory room manager, authenticated WebSocket gateway, Telegram Mini App, the 36 custom WebP card faces, and the separate OPTIMIST card back. Group lobbies and 2–6-player games are supported. Room/chat history is still in memory; PostgreSQL persistence is not implemented yet.

## Requirements

- Node.js 22.6+ (uses Node's experimental built-in TypeScript stripping for tests)
- TypeScript 5.8+ for type-checking

## Commands

```bash
npm test
npm run typecheck
npm run simulate
```

`npm test` runs the regression suite, including 1,000 complete simulated games and a 36-card integrity check after each action. `npm run typecheck` checks the TypeScript source with strict options. The Node TypeScript stripping warning is expected with Node 22 and does not mean the tests failed.

## Main files

- `packages/shared-types/index.ts` — shared card, player, game state, and action contracts.
- `packages/game-engine/DurakEngine.ts` — server-authoritative game engine.
- `packages/game-engine/simulator.ts` — lightweight bot strategy and stress simulation.
- `apps/backend/telegram-bot.ts` — private table creation and group lobby (`/game`, 60-second countdown, join/leave, host transfer, results announcement).
- `apps/backend/RoomManager.ts` — room membership, owner permissions, serialized actions, invite policy, and game-over callbacks.
- `apps/backend/server.ts` — HTTP/static hosting, initData validation, WebSocket gateway, and per-player state sync.
- `apps/mini-app/public/index.html` — Mini App UI, including Direct Link `startapp` support.
- `tests/engine.test.mjs` and `tests/security.test.mjs` — automated regression tests.
- `docs/ENGINE-AUDIT.md` — engine rules and edge-case decisions.

## Assets

The 36 custom WebP faces and the separate OPTIMIST card back are already included in `apps/mini-app/public/assets/cards/`. The engine uses `J`, `Q`, `K`, `A` file names for ranks 11–14.

## Security layer (stage 2)

See `docs/SECURITY-AUDIT.md`. This revision adds Telegram `initData` verification, serialized room operations, room membership/owner checks, idempotent game commands, chat rate/length limits, and strict WebSocket message parsing. Run `npm test` and `npm run typecheck`.


## Telegram bot, WebSocket gateway, and Mini App

This stage adds a runnable single-process integration: `apps/backend/server.ts` serves the Mini App at `/`, static card assets at `/assets/...`, health checks at `/healthz`, and WebSocket gameplay on `/ws`. `apps/backend/telegram-bot.ts` adds `/start`, private room creation for 2–6 players, deep-link invitations, and group lobbies. The Mini App is a starter UI with per-player card rendering, table actions, an optimistic chat drawer, and safe text rendering.

### Install and run locally

1. Install Node.js 22.6 or newer.
2. Copy `.env.example` to `.env`.
3. Create a bot with Telegram's `@BotFather` and put its token in `BOT_TOKEN`. Never commit `.env`.
4. For local HTTP smoke testing, use `WEBAPP_URL=http://localhost:3000` and `ALLOWED_ORIGINS=http://localhost:3000`. For end-to-end testing inside Telegram, use a publicly reachable HTTPS URL/tunnel for both values; Telegram Web App buttons require HTTPS.
5. Run `npm install`, then `npm run typecheck`, `npm test`, and `npm start`. Open `http://localhost:3000/healthz` to confirm the service is alive.
6. In a private chat, use `/start` to create a personal room and invite players. For a group game, add the bot to a group and send `/durak` (or `/game`). Prefer `/durak` in groups with other game bots because `/start` is commonly used by those bots. On startup the bot registers `/durak` and `/game` in Telegram's group command menu. Join from the lobby message. The lobby stays open for 60 seconds, updates every 15 seconds, lets the creator start with 2–6 players, and auto-starts when full or when the countdown expires with at least two participants.
7. In `@BotFather`, create a Mini App using `/newapp` and set its short name to `game` (or change `APP_SHORT_NAME`). Set `BOT_USERNAME` to the actual bot username, or leave it blank to let the server resolve it through Telegram. After a group game starts, the group button opens `https://t.me/<bot>?start=room_<id>`. The bot then sends each already-registered participant a native Web App button whose URL contains the same `roomId`; both participants therefore enter the same in-memory room. Group rooms reject users who did not join from the lobby message. This avoids relying on a configured Direct Mini App short name for group entry.

The server and Mini App expect the 36 final card files under `apps/mini-app/public/assets/cards/{clubs,spades,diamonds,hearts}/` using filenames `6.webp`, `7.webp`, `8.webp`, `9.webp`, `10.webp`, `J.webp`, `Q.webp`, `K.webp`, and `A.webp`; put the designed back at `apps/mini-app/public/assets/cards/back.webp`. If a face image is missing, the starter UI falls back to a readable rank-and-suit tile. The 36 custom WebP card faces and the separate OPTIMIST card back are included in `apps/mini-app/public/assets/cards/`. Automated tests verify every expected asset path and the card-back file signature.

### Current limits

- Room/game/chat state remains in memory. A process restart loses unfinished rooms and history; PostgreSQL persistence is the next stage.
- Bot updates use long polling for the first single-instance deployment. Do not run multiple replicas with the same token using polling.
- The group lobby and direct Mini App flow still need an end-to-end test with a real bot token, a registered Mini App short name, and a reachable HTTPS URL before public launch.
- A six-player game deals all 36 cards. In that one edge case, the last card dealt to the sixth player is also exposed as the trump indicator; it remains a card in that player’s hand and is counted only once by integrity checks.
- `ALLOWED_ORIGINS` must contain exact origins only (scheme + host + optional port, no path). Production startup refuses to proceed without it.


## Continuous integration

GitHub Actions runs the TypeScript type-check, full automated test suite, card asset verification, and a 1,000-game simulation on pushes to `main` and `feature/**`, pull requests, and manual dispatches. See `.github/workflows/ci.yml`.

## Stage 8 — persistence, public lobby and spectators

Stage 8 adds a JSON-backed profile store for ratings and player preferences, authenticated HTTP endpoints (`/api/bootstrap`, `/api/lobby`, `/api/profile`, `/api/leaderboard`, `/api/settings`, and `/api/rooms`), public/private room visibility, read-only spectator sessions, and queued AI turns. Spectators can use a separate spectator-only chat and send room-wide emoji reactions without seeing or posting in the players' chat. The engine now completes a defender's `TAKE` immediately when no eligible attacker can add a matching rank; all card moves still pass the 36-card integrity check.

Set `STORAGE_FILE` in `.env` to a writable path (the example uses `.data/optimist-store.json`) to persist profile data across restarts. Tests can pass `storageFile: null` or a temporary path to keep state isolated.

The Mini App includes five views (rating, profile, settings, lobby, and table), 68×100 px hand cards with horizontal scrolling, image decode tracking and a text fallback, role-aware player/observer controls, a separate spectator chat, quick emoji reactions, and cosmetic-only table effects (curse, buff, lightning, phoenix). Cosmetic effects are ephemeral broadcasts and never mutate game state. Dynamic player and chat text is inserted through DOM `textContent`/element APIs rather than `innerHTML`.


## Stage 9 — spectator social layer and table cosmetics

Spectators of public rooms can write to an isolated spectator chat; player chat is delivered only to player sessions, and spectator chat only to spectator sessions. Both roles can send rate-limited room-wide emoji reactions. The table also supports rate-limited visual-only effects (curse, buff, lightning, phoenix), broadcast as transient events and never applied to the game engine. These live room messages and cosmetic events remain in memory and disappear when the process restarts; no additional paid database is required for this prototype.

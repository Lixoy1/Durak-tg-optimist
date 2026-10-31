# Stage 5 — group lobby and six-player rules

## Group flow

1. A group member sends `/game` or `/start`; the bot posts one lobby message for that group.
2. The creator is seated automatically. Friends join or leave through inline buttons. The player list and 60-second countdown are edited in place every 15 seconds.
3. The creator may start with 2–6 players. A full six-player table starts immediately. If the timer expires with 2–5 players, the game starts automatically; with fewer than two players, the lobby closes.
4. If the creator leaves while the lobby is open, the first remaining player becomes the owner. If everyone leaves, the room is removed.
5. The bot replaces the lobby message with a Direct Link Mini App URL. The Mini App reads `start_param` from Telegram WebApp launch data, then sends raw `initData` to the backend for HMAC validation.
6. The game-over callback posts the finishing order and the final `Хранитель Колоды` to the original group.

## Security boundaries

- Group rooms use `allowInviteJoin: false`. Opening a Mini App URL does not enroll a user; the server requires the Telegram-authenticated account to already be in the lobby roster.
- Private rooms keep their existing invite-by-deep-link behavior.
- The server remains authoritative for game actions and private hands. The Mini App does not supply a trusted user ID.
- The shared inline keyboard is the same for every member of a Telegram group. The start callback is therefore visible in the group to all members, but the backend handler accepts it only from the current creator and rejects everybody else.

## Six-player trump rule

A 36-card deck cannot provide a remaining trump indicator after six players receive six cards each. With six players, the last card dealt to the sixth player is retained in that hand and used as the visible trump indicator. This card is referenced, not duplicated: the 36-card integrity check counts it only as a hand card. With 2–5 players, the indicator remains the first card in the remaining stock and is drawn last.

## Telegram configuration

- Set `BOT_TOKEN` to the token from `@BotFather`.
- Create a Mini App in `@BotFather` using `/newapp`; set `APP_SHORT_NAME` to its actual short name (the example uses `game`).
- `BOT_USERNAME` is optional; when empty, the bot resolves its own username through `getMe`.
- Use a public HTTPS `WEBAPP_URL` and matching exact `ALLOWED_ORIGINS` for end-to-end tests in Telegram.

## Verification notes

The engine, card assets and security tests can run without Telegram credentials. A real Telegram group/Mini App end-to-end test is still required to confirm BotFather configuration, actual Mini App deep-link behavior and group permissions. The local environment used to prepare this build did not have npm dependencies installed, so the full WebSocket integration suite and TypeScript type-check were not run here.

# Durak TG Optimist

Telegram Mini App adaptation of the Durak card game.

## Project status

- Repository created for the Optimist version.
- Base implementation will be adapted from [lFreid/telegram-durak-game](https://github.com/lFreid/telegram-durak-game).
- Custom deck assets: 36 playing-card faces and one custom card-back image (the joker artwork is the card back, not a playable joker).
- Planned deployment: Vercel for the web app; a separate persistent host may be needed if the existing game server uses WebSockets or long-running Python processes.

## Next steps

1. Import and review the original game source.
2. Add and verify the custom card assets without changing their filenames or card identities.
3. Test the game on mobile and inside Telegram.
4. Configure deployment and Telegram Mini App launch settings.

## Upstream

The original project is licensed under the license included in the upstream repository. Preserve applicable attribution and license terms when adapting its code.

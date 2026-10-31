# Stage 7 — Mobile hand layout

## Change
- Fixed card width on mobile; the card face is no longer compressed to fit every card in one row.
- Overlap adjacent cards by half their width to retain visible rank/suit corners.
- Enable horizontal scrolling when the hand exceeds the screen width.
- Keep the selected card above neighbouring cards and preserve a visible keyboard focus state.
- Prevent the card image itself from intercepting the card-button tap.

## Validation
- Run `npm test` for the project test suite and `npm run typecheck` after installing dependencies.
- Check the real Telegram Mini App at 360px and 320px widths with 6, 10, and 12 cards. Confirm each card's rank/suit marker is readable, horizontal swipe works, and the selected card remains visible.

The CSS patch is applied to the Stage 6 project. A real-device Telegram visual test is still required; this archive does not claim that device verification has been completed.

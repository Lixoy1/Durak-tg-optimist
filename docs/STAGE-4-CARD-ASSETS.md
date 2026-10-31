# Stage 4 — OPTIMIST card assets

- Added 36 individually mapped playing-card fronts to `apps/mini-app/public/assets/cards/{clubs,spades,diamonds,hearts}/`.
- Converted the supplied PNG fronts to 512×768 WebP, quality 82; the complete 37-image asset set is about 5 MB.
- Added `back.webp` from the author's OPTIMIST/joker card and placed it in the Mini App top bar beside the remaining-deck count.
- Added `tests/card-assets.test.mjs`, which checks that the engine's 36 canonical paths exist and that the separate back asset is installed.
- Added `assets/cards/ASSET-MAP.md` documenting source-to-card mapping and noting two extra J variants excluded from the standard deck.

## Verification

Passed: asset mapping tests, engine tests (including 1,000 full bot simulations), and security tests — 19 tests total.

The complete `npm test` command could not start `tests/backend.test.mjs` in this environment because the `ws` dependency was not installed; `npm install` timed out. Install dependencies on a network-enabled Node 22.6+ environment and run `npm install`, `npm test`, and `npm run typecheck` for the full verification.

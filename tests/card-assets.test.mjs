import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DurakEngine } from '../packages/game-engine/DurakEngine.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/mini-app/public');

test('all 36 engine card paths resolve to real WebP assets', () => {
  const engine = new DurakEngine('asset-audit');
  const seen = new Set();
  // Exercise the canonical deck generator through a started game so cards carry production paths.
  engine.addPlayer('a', 'A');
  engine.addPlayer('b', 'B');
  engine.startGame();
  const cards = [
    ...engine.state.players.flatMap((p) => p.hand),
    ...engine.state.deck,
  ];
  assert.equal(cards.length, 36);
  for (const card of cards) {
    assert.match(card.assetPath, /^assets\/cards\/(clubs|spades|diamonds|hearts)\/(6|7|8|9|10|J|Q|K|A)\.webp$/);
    const file = resolve(root, card.assetPath);
    assert.ok(existsSync(file), `missing ${card.assetPath}`);
    assert.ok(statSync(file).size > 10_000, `asset unexpectedly small: ${card.assetPath}`);
    assert.equal(readFileSync(file).subarray(0, 4).toString('hex'), '52494646', `${card.assetPath} is not RIFF/WebP`);
    seen.add(card.assetPath);
  }
  assert.equal(seen.size, 36);
});

test('subdued matte-gold card back is installed and used by the Mini App', () => {
  const back = resolve(root, 'assets/cards/back.svg');
  assert.ok(existsSync(back));
  const svg = readFileSync(back, 'utf8');
  assert.match(svg, /<svg/);
  assert.match(svg, /OPTIMIST/);
  const html = readFileSync(resolve(root, 'index.html'), 'utf8');
  assert.match(html, /class="deck-back" src="\\/assets\\/cards\\/back\\.svg"/);
  assert.match(html, /id="sideDeckBack" class="side-deck-back" src="\\/assets\\/cards\\/back\\.svg"/);
});;

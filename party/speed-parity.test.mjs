/* index.html とサーバーのスピードコアが export を除き一致することを検証。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as core from './speed-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const coreSrc = readFileSync(join(here, 'speed-core.js'), 'utf8');
const match = html.match(/\/\* SPEED-CORE-BEGIN[^\n]*\*\/\n([\s\S]*?)\/\* SPEED-CORE-END \*\//);
if (!match) { console.error('SPEED-CORE block not found'); process.exit(2); }

let pass = 0, fail = 0;
const ck = (name, cond) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name);
};
const clientSrc = match[1], stripped = coreSrc.replace(/^export /gm, '');
ck('verbatim-text-equal', clientSrc === stripped);
const names = [
  'SPEED_SUITS', 'makeSpeedDeck', 'shuffleSpeed', 'speedRanksAdjacent',
  'newSpeedRound', 'speedTop', 'speedCardPlayable', 'speedLegalMoves',
  'speedStuck', 'speedCanShowdown', 'speedPlay', 'speedReady',
];
const ref = await import('data:text/javascript,' + encodeURIComponent(clientSrc + '\nexport {' + names.join(',') + '};'));
let seedA = 91, seedB = 91;
const rngA = () => ((seedA = (seedA * 1664525 + 1013904223) >>> 0) / 4294967296);
const rngB = () => ((seedB = (seedB * 1664525 + 1013904223) >>> 0) / 4294967296);
const a = core.newSpeedRound(core.shuffleSpeed(core.makeSpeedDeck(), rngA));
const b = ref.newSpeedRound(ref.shuffleSpeed(ref.makeSpeedDeck(), rngB));
ck('seeded-round-equal', JSON.stringify(a) === JSON.stringify(b));

let same = true, guard = 0;
while (!a.ended && guard++ < 1000) {
  let moved = false;
  for (const seat of [0, 1]) {
    const ma = core.speedLegalMoves(a, seat)[0], mb = ref.speedLegalMoves(b, seat)[0];
    if (!!ma !== !!mb) { same = false; break; }
    if (ma) {
      const ra = core.speedPlay(a, seat, ma.slot, ma.pile, a.pileVersions[ma.pile]);
      const rb = ref.speedPlay(b, seat, mb.slot, mb.pile, b.pileVersions[mb.pile]);
      if (JSON.stringify([ra, a]) !== JSON.stringify([rb, b])) { same = false; break; }
      moved = true;
    }
    if (a.ended) break;
  }
  if (!same || a.ended) break;
  if (!moved && core.speedCanShowdown(a)) {
    const ra0 = core.speedReady(a, 0), rb0 = ref.speedReady(b, 0);
    const ra1 = core.speedReady(a, 1), rb1 = ref.speedReady(b, 1);
    if (JSON.stringify([ra0, ra1, a]) !== JSON.stringify([rb0, rb1, b])) { same = false; break; }
  } else if (!moved) break;
}
ck('full-game-equal', same && a.ended && b.ended && JSON.stringify(a) === JSON.stringify(b));
console.log(`\n[speed parity] pass=${pass} fail=${fail}`);
if (fail) process.exit(1);

/* index.html と server のページワンコアが export を除き一致することを検証。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as core from './pageone-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const coreSrc = readFileSync(join(here, 'pageone-core.js'), 'utf8');
const match = html.match(/\/\* PAGEONE-CORE-BEGIN[^\n]*\*\/\n([\s\S]*?)\/\* PAGEONE-CORE-END \*\//);
if (!match) { console.error('PAGEONE-CORE block not found'); process.exit(2); }

let pass = 0, fail = 0;
const ck = (name, cond) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name);
};
const clientSrc = match[1], stripped = coreSrc.replace(/^export /gm, '');
ck('verbatim-text-equal', clientSrc === stripped);
const names = [
  'PAGEONE_SUITS', 'normalizePageOnePlayers', 'makePageOneDeck', 'shufflePageOne',
  'isPageOneJoker', 'sortPageOneHand', 'newPageOneRound', 'pageOneTop',
  'pageOneCardPlayable', 'pageOneLegalCards', 'pageOnePlay', 'pageOneDraw', 'pageOneCpuChoose',
];
const ref = await import('data:text/javascript,' + encodeURIComponent(clientSrc + '\nexport {' + names.join(',') + '};'));
let s1 = 73, s2 = 73;
const rnd1 = () => ((s1 = (s1 * 1664525 + 1013904223) >>> 0) / 4294967296);
const rnd2 = () => ((s2 = (s2 * 1664525 + 1013904223) >>> 0) / 4294967296);
const a = core.newPageOneRound(4, core.shufflePageOne(core.makePageOneDeck(), rnd1));
const b = ref.newPageOneRound(4, ref.shufflePageOne(ref.makePageOneDeck(), rnd2));
ck('seeded-round-equal', JSON.stringify(a) === JSON.stringify(b));
let same = true, guard = 0;
while (!a.ended && guard++ < 4000) {
  const seat = a.turn;
  const ma = core.pageOneCpuChoose(a, seat);
  const mb = ref.pageOneCpuChoose(b, seat);
  const ra = ma.type === 'play'
    ? core.pageOnePlay(a, seat, ma.cardId, { suit: ma.suit, pageOne: true }, rnd1)
    : core.pageOneDraw(a, seat, rnd1);
  const rb = mb.type === 'play'
    ? ref.pageOnePlay(b, seat, mb.cardId, { suit: mb.suit, pageOne: true }, rnd2)
    : ref.pageOneDraw(b, seat, rnd2);
  if (JSON.stringify([ma, ra, a]) !== JSON.stringify([mb, rb, b])) { same = false; break; }
}
ck('full-cpu-game-equal', same && a.ended && b.ended);
console.log(`\n[pageone parity] pass=${pass} fail=${fail}`);
if (fail) process.exit(1);

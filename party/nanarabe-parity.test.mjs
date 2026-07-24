/* index.html と server の七並べコアが export を除き一致することを検証。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as core from './nanarabe-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const coreSrc = readFileSync(join(here, 'nanarabe-core.js'), 'utf8');
const m = html.match(/\/\* NANARABE-CORE-BEGIN[^\n]*\*\/\n([\s\S]*?)\/\* NANARABE-CORE-END \*\//);
if (!m) { console.error('NANARABE-CORE block not found'); process.exit(2); }

let pass = 0, fail = 0;
const ck = (name, cond) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name);
};
const clientSrc = m[1], stripped = coreSrc.replace(/^export /gm, '');
ck('verbatim-text-equal', clientSrc === stripped);
const names = [
  'NANA_SUITS','normalizeNanaPlayers','makeNanaDeck','shuffleNana','sortNanaHand',
  'newNanaRound','nanaCardPlayable','nanaLegalCards','nanaPlay','nanaPass','nanaCpuChoose',
];
const ref = await import('data:text/javascript,' + encodeURIComponent(clientSrc + '\nexport {' + names.join(',') + '};'));
let s1 = 42, s2 = 42;
const rnd1 = () => ((s1 = (s1 * 1664525 + 1013904223) >>> 0) / 4294967296);
const rnd2 = () => ((s2 = (s2 * 1664525 + 1013904223) >>> 0) / 4294967296);
const a = core.newNanaRound(4, core.shuffleNana(core.makeNanaDeck(), rnd1));
const b = ref.newNanaRound(4, ref.shuffleNana(ref.makeNanaDeck(), rnd2));
ck('seeded-round-equal', JSON.stringify(a) === JSON.stringify(b));
let same = true, guard = 0;
while (!a.ended && guard++ < 1000) {
  const seat = a.turn;
  const ma = core.nanaCpuChoose(a, seat, () => 0.9);
  const mb = ref.nanaCpuChoose(b, seat, () => 0.9);
  const ra = ma.type === 'play' ? core.nanaPlay(a, seat, ma.cardId) : core.nanaPass(a, seat);
  const rb = mb.type === 'play' ? ref.nanaPlay(b, seat, mb.cardId) : ref.nanaPass(b, seat);
  if (JSON.stringify([ma, ra, a]) !== JSON.stringify([mb, rb, b])) { same = false; break; }
}
ck('full-cpu-game-equal', same && a.ended && b.ended);
console.log(`\n[nanarabe parity] pass=${pass} fail=${fail}`);
if (fail) process.exit(1);

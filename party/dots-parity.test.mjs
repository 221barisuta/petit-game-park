/* ドット&ボックス コアロジック パリティテスト (divergence厳禁の機械担保)
   ──────────────────────────────────────────────────────────
   index.html 内の DOTS-CORE を抽出し、party/dots-core.js と「全く同じ出力」になることを確認する。
   実行: node party/dots-parity.test.mjs   (非0終了で失敗) */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as core from './dots-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

const start = html.indexOf('/* DOTS-CORE-BEGIN');
const end = html.indexOf('/* DOTS-CORE-END */', start);
if (start < 0 || end < 0) { console.error('index.html から DOTS-CORE を抽出できませんでした'); process.exit(2); }
const refSrc = html.slice(start, end)
  + '\nexport {DOTS_N,DOTS_H,DOTS_V,DOTS_EDGES,DOTS_BOXES,dotsBoxEdges,dotsEdgeBoxes,dotsBoxCount,dotsCompletedBy,dotsFull,dotsWinner};';
const ref = await import('data:text/javascript,' + encodeURIComponent(refSrc));

let pass = 0, fail = 0; const log = [];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ck = (name, cond) => { cond ? pass++ : (fail++, log.push(name)); };

ck('DOTS_EDGES一致', core.DOTS_EDGES === ref.DOTS_EDGES && core.DOTS_EDGES === 40);
ck('DOTS_BOXES一致', core.DOTS_BOXES === ref.DOTS_BOXES && core.DOTS_BOXES === 16);

// 全箱の 4辺、全辺の 隣接箱 を突き合わせ (構造)
for (let bx = 0; bx < 16; bx++) ck('boxEdges#' + bx, eq(core.dotsBoxEdges(bx), ref.dotsBoxEdges(bx)));
for (let e = 0; e < 40; e++) ck('edgeBoxes#' + e, eq(core.dotsEdgeBoxes(e), ref.dotsEdgeBoxes(e)));

// 相互整合: 箱の4辺 それぞれの edgeBoxes に その箱が含まれる
{ let ok = true; for (let bx = 0; bx < 16; bx++) for (const e of ref.dotsBoxEdges(bx)) if (!ref.dotsEdgeBoxes(e).includes(bx)) ok = false;
  ck('box-edge-consistency', ok); }

// ランダム盤面 fuzz: 同一盤面で boxCount/completedBy/full/winner を突き合わせ
let seed = 20250723;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const vals = ['black', 'white', null];
let fuzzFail = false;
for (let t = 0; t < 6000 && !fuzzFail; t++) {
  const b = new Array(40).fill(null);
  for (let i = 0; i < 40; i++) b[i] = vals[Math.floor(rnd() * 3)];
  if (core.dotsFull(b) !== ref.dotsFull(b)) { fuzzFail = true; log.push('fuzz-full#' + t); break; }
  const boxes = new Array(16).fill(null);
  for (let bx = 0; bx < 16; bx++) { if (core.dotsBoxCount(b, bx) !== ref.dotsBoxCount(b, bx)) { fuzzFail = true; log.push('fuzz-count#' + t + ':' + bx); break; } boxes[bx] = rnd() < 0.5 ? 'black' : (rnd() < 0.5 ? 'white' : null); }
  if (fuzzFail) break;
  if (core.dotsWinner(boxes) !== ref.dotsWinner(boxes)) { fuzzFail = true; log.push('fuzz-winner#' + t); break; }
  for (let e = 0; e < 40; e++) if (b[e] && !eq(core.dotsCompletedBy(b, e), ref.dotsCompletedBy(b, e))) { fuzzFail = true; log.push('fuzz-comp#' + t + ':' + e); break; }
}
if (!fuzzFail) pass++;

console.log('[parity dots-core] pass=' + pass + ' / fail=' + fail, log.length ? log : '');
process.exit(fail ? 1 : 0);

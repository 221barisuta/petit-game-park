/* オセロ コアロジック パリティテスト (divergence厳禁の機械担保)
   ──────────────────────────────────────────────────────────
   index.html 内のオセロ盤面ロジック(OTH_N/othInitial/getFlips/getValidMoves/
   applyMove/countStones/isGameOver/getWinner)を抽出し、party/othello-core.js と
   「全く同じ出力」になることを確認する (五目 parity.test.mjs と同方式)。
   - 初期配置 + 大量のランダム盤面で 反転/合法手/勝敗 を突き合わせ。
   実行: node party/othello-parity.test.mjs   (非0終了で失敗)
*/
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as core from './othello-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

// index.html から オセロ盤面ロジック一式を抽出して評価 (= クライアント正本)
const start = html.indexOf('const OTH_N=8;');
const end = html.indexOf('// --- #9', start);           // getWinner 直後のコメントを終端に
if (start < 0 || end < 0) { console.error('index.html から othello コアを抽出できませんでした'); process.exit(2); }
const refSrc = html.slice(start, end)
  + '\nexport {OTH_N,othOpp,othInitial,getFlips,getValidMoves,applyMove,countStones,isGameOver,getWinner};';
const ref = await import('data:text/javascript,' + encodeURIComponent(refSrc));

let pass = 0, fail = 0; const log = [];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ck = (name, cond) => { cond ? pass++ : (fail++, log.push(name)); };

ck('OTH_N一致', core.OTH_N === ref.OTH_N && core.OTH_N === 8);
ck('othInitial一致', eq(core.othInitial(), ref.othInitial()));
ck('othOpp一致', core.othOpp('black') === ref.othOpp('black') && core.othOpp('white') === ref.othOpp('white'));

// 初期盤の合法手/反転
{ const b = ref.othInitial();
  ck('initial-moves', eq(core.getValidMoves(b, 'black'), ref.getValidMoves(b, 'black')));
  for (const i of ref.getValidMoves(b, 'black')) ck('initial-flip#' + i, eq(core.getFlips(b, i, 'black'), ref.getFlips(b, i, 'black')));
}

// ランダム盤面 fuzz: 同一盤面で 反転/合法手/applyMove/勝敗 を突き合わせ (決定的シード)
let seed = 987654321;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
let fuzzFail = false;
for (let t = 0; t < 6000 && !fuzzFail; t++) {
  const b = new Array(64).fill(null);
  const k = Math.floor(rnd() * 60);
  for (let j = 0; j < k; j++) { const i = Math.floor(rnd() * 64); b[i] = rnd() < 0.5 ? 'black' : (rnd() < 0.5 ? 'white' : null); }
  const color = rnd() < 0.5 ? 'black' : 'white';
  if (!eq(core.getValidMoves(b, color), ref.getValidMoves(b, color))) { fuzzFail = true; log.push('fuzz-moves#' + t); break; }
  if (!eq(core.countStones(b), ref.countStones(b))) { fuzzFail = true; log.push('fuzz-count#' + t); break; }
  if (core.isGameOver(b) !== ref.isGameOver(b)) { fuzzFail = true; log.push('fuzz-over#' + t); break; }
  if (core.getWinner(b) !== ref.getWinner(b)) { fuzzFail = true; log.push('fuzz-winner#' + t); break; }
  for (let i = 0; i < 64; i++) {
    if (!eq(core.getFlips(b, i, color), ref.getFlips(b, i, color))) { fuzzFail = true; log.push('fuzz-flip#' + t + ':' + i); break; }
    if (!eq(core.applyMove(b, i, color), ref.applyMove(b, i, color))) { fuzzFail = true; log.push('fuzz-apply#' + t + ':' + i); break; }
  }
}
if (!fuzzFail) pass++;

console.log('[parity othello-core] pass=' + pass + ' / fail=' + fail, log.length ? log : '');
process.exit(fail ? 1 : 0);

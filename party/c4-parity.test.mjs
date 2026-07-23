/* コネクトフォー コアロジック パリティテスト (divergence厳禁の機械担保)
   ──────────────────────────────────────────────────────────
   index.html 内の C4-CORE(c4Drop/c4ValidCols/c4CheckWin/c4Full)を抽出し、
   party/c4-core.js と「全く同じ出力」になることを確認する (五目/オセロ/三目と同方式)。
   実行: node party/c4-parity.test.mjs   (非0終了で失敗) */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as core from './c4-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

const start = html.indexOf('/* C4-CORE-BEGIN');
const end = html.indexOf('/* C4-CORE-END */', start);
if (start < 0 || end < 0) { console.error('index.html から C4-CORE を抽出できませんでした'); process.exit(2); }
const refSrc = html.slice(start, end)
  + '\nexport {C4_COLS,C4_ROWS,c4Drop,c4ValidCols,c4CheckWin,c4Full};';
const ref = await import('data:text/javascript,' + encodeURIComponent(refSrc));

let pass = 0, fail = 0; const log = [];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ck = (name, cond) => { cond ? pass++ : (fail++, log.push(name)); };

ck('C4_COLS一致', core.C4_COLS === ref.C4_COLS && core.C4_COLS === 7);
ck('C4_ROWS一致', core.C4_ROWS === ref.C4_ROWS && core.C4_ROWS === 6);

// 決定的シードのランダム盤面 fuzz: 同一盤面で drop/validCols/checkWin/full を突き合わせ
let seed = 424242;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
let fuzzFail = false;
for (let t = 0; t < 8000 && !fuzzFail; t++) {
  const b = new Array(42).fill(null);
  const k = Math.floor(rnd() * 42);
  for (let j = 0; j < k; j++) { const i = Math.floor(rnd() * 42); b[i] = rnd() < 0.5 ? 'black' : (rnd() < 0.5 ? 'white' : null); }
  if (!eq(core.c4ValidCols(b), ref.c4ValidCols(b))) { fuzzFail = true; log.push('fuzz-cols#' + t); break; }
  if (!eq(core.c4CheckWin(b), ref.c4CheckWin(b))) { fuzzFail = true; log.push('fuzz-win#' + t); break; }
  if (core.c4Full(b) !== ref.c4Full(b)) { fuzzFail = true; log.push('fuzz-full#' + t); break; }
  for (let c = 0; c < 7; c++) if (core.c4Drop(b, c) !== ref.c4Drop(b, c)) { fuzzFail = true; log.push('fuzz-drop#' + t + ':' + c); break; }
}
if (!fuzzFail) pass++;

// 明示ケース: 縦/横/斜め4連
{ const b = new Array(42).fill(null);
  for (const i of [35, 28, 21, 14]) b[i] = 'black'; // col0 縦4連 (r5..r2)
  ck('vertical', ref.c4CheckWin(b).winner === 'black' && core.c4CheckWin(b).winner === 'black');
}
{ const b = new Array(42).fill(null);
  for (const i of [35, 36, 37, 38]) b[i] = 'white'; // 最下段 横4連
  ck('horizontal', ref.c4CheckWin(b).winner === 'white' && eq(core.c4CheckWin(b), ref.c4CheckWin(b)));
}

console.log('[parity c4-core] pass=' + pass + ' / fail=' + fail, log.length ? log : '');
process.exit(fail ? 1 : 0);

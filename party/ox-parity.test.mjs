/* checkWin パリティテスト (divergence厳禁の機械担保)
   ──────────────────────────────────────────────────────────
   index.html 内の checkWin を抽出し、party/ox-core.js と「全く同じ出力」になることを確認する。
   - 8勝ち筋 × ○/× と black/white(オンライン席色) の両方 + ランダム盤面で winner/line を突き合わせ。
   実行: node party/ox-parity.test.mjs   (非0終了で失敗)
*/
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkWin as coreCheck } from './ox-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

// index.html から checkWin 関数本体を抽出して評価 (= クライアント正本)
const fnStart = html.indexOf('function checkWin(');
const fnEnd = html.indexOf('\n}', fnStart) + 2;
if (fnStart < 0) { console.error('index.html から checkWin を抽出できませんでした'); process.exit(2); }
const refSrc = html.slice(fnStart, fnEnd) + '\nexport {checkWin as htmlCheck};';
const ref = await import('data:text/javascript,' + encodeURIComponent(refSrc));
const htmlCheck = ref.htmlCheck;

let pass = 0, fail = 0; const log = [];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ck = (name, cond) => { cond ? pass++ : (fail++, log.push(name)); };

const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

// 8勝ち筋 × 2つのマーク領域 (ローカル=○/×, オンライン=black/white) で突き合わせ
for (const [ma, mb] of [['○', '×'], ['black', 'white']]) {
  for (const mark of [ma, mb]) {
    for (const ln of LINES) {
      const b = new Array(9).fill(null); for (const i of ln) b[i] = mark;
      ck('win ' + mark + ' ' + ln, eq(coreCheck(b), htmlCheck(b)));
    }
  }
}
// 引分・未決着・空盤
ck('draw', eq(coreCheck(['○', '×', '○', '○', '×', '×', '×', '○', '○']), htmlCheck(['○', '×', '○', '○', '×', '×', '×', '○', '○'])));
ck('undecided', eq(coreCheck(['○', '×', null, null, null, null, '○', null, null]), htmlCheck(['○', '×', null, null, null, null, '○', null, null])));
ck('empty', eq(coreCheck(new Array(9).fill(null)), htmlCheck(new Array(9).fill(null))));

// ランダム盤面 fuzz: 同一盤面で出力突き合わせ (決定的シード)
let seed = 987654321;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const vals = ['black', 'white', null];
let fuzzOk = true;
for (let t = 0; t < 3000; t++) {
  const b = new Array(9).fill(null);
  for (let i = 0; i < 9; i++) b[i] = vals[Math.floor(rnd() * 3)];
  if (!eq(coreCheck(b), htmlCheck(b))) { fuzzOk = false; log.push('fuzz#' + t); break; }
}
if (fuzzOk) pass++; else fail++;

console.log('[parity checkWin] pass=' + pass + ' / fail=' + fail, log.length ? log : '');
process.exit(fail ? 1 : 0);

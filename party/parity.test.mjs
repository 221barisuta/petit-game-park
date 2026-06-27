/* checkGomoku パリティテスト (divergence厳禁の機械担保)
   ──────────────────────────────────────────────────────────
   index.html 内の checkGomoku / GO_N を抽出し、party/gomoku-core.js と
   「全く同じ出力」になることを確認する。
   - 既存の決まり手バッテリ + 大量のランダム盤面で winner/line を突き合わせ。
   実行: node party/parity.test.mjs   (非0終了で失敗)
*/
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GO_N as CORE_N, checkGomoku as coreCheck } from './gomoku-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

// index.html から GO_N と checkGomoku 関数本体を抽出して評価 (= クライアント正本)
const goN = html.match(/const GO_N=\d+;/);
const fnStart = html.indexOf('function checkGomoku(');
const fnEnd = html.indexOf('\n}', fnStart) + 2;
if (!goN || fnStart < 0) { console.error('index.html から checkGomoku を抽出できませんでした'); process.exit(2); }
const refSrc = goN[0] + '\n' + html.slice(fnStart, fnEnd) + '\nexport {checkGomoku as htmlCheck, GO_N as HTML_N};';
const ref = await import('data:text/javascript,' + encodeURIComponent(refSrc));
const htmlCheck = ref.htmlCheck, HTML_N = ref.HTML_N;

let pass = 0, fail = 0; const log = [];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ck = (name, cond) => { cond ? pass++ : (fail++, log.push(name)); };

ck('GO_N一致', CORE_N === HTML_N && CORE_N === 15);

const N = CORE_N, idx = (x, y) => y * N + x;
// 決まり手バッテリ (横/縦/両斜め/長連/端折返し無し/4連未決着)
const cases = [
  [[0, 1, 2, 3, 4].map(x => idx(x, 7)), 'black', idx(2, 7)],
  [[3, 4, 5, 6, 7].map(y => idx(5, y)), 'white', idx(5, 5)],
  [[0, 1, 2, 3, 4].map(k => idx(2 + k, 2 + k)), 'black', idx(4, 4)],
  [[0, 1, 2, 3, 4].map(k => idx(10 - k, 2 + k)), 'white', idx(8, 4)],
  [[0, 1, 2, 3, 4, 5].map(x => idx(x, 0)), 'black', idx(3, 0)],
  [[idx(13, 0), idx(14, 0), idx(0, 1), idx(1, 1), idx(2, 1)], 'black', idx(14, 0)],
  [[0, 1, 2, 3].map(x => idx(x, 5)), 'black', idx(3, 5)],
];
for (let t = 0; t < cases.length; t++) {
  const [cells, color, mv] = cases[t];
  const b = new Array(N * N).fill(null); for (const i of cells) b[i] = color;
  ck('battery#' + t, eq(coreCheck(b, mv), htmlCheck(b, mv)));
}

// ランダム盤面 fuzz: 同一盤面・同一 lastIndex で出力突き合わせ (決定的シード)
let seed = 123456789;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (let t = 0; t < 4000; t++) {
  const b = new Array(N * N).fill(null);
  const k = Math.floor(rnd() * 40);
  let lastI = Math.floor(rnd() * N * N);
  for (let j = 0; j < k; j++) {
    const i = Math.floor(rnd() * N * N);
    b[i] = rnd() < 0.5 ? 'black' : 'white';
    lastI = i;
  }
  // たまに「並びやすい」横連を注入して勝ち筋も踏ませる
  if (rnd() < 0.5) {
    const y = Math.floor(rnd() * N), x0 = Math.floor(rnd() * (N - 5)), col = rnd() < 0.5 ? 'black' : 'white';
    for (let x = x0; x < x0 + 5 + (rnd() < 0.3 ? 1 : 0); x++) b[idx(x, y)] = col;
    lastI = idx(x0 + 2, y);
  }
  if (!eq(coreCheck(b, lastI), htmlCheck(b, lastI))) { fail++; log.push('fuzz#' + t); break; }
}
if (!log.some(s => s.startsWith('fuzz'))) pass++;

console.log('[parity checkGomoku] pass=' + pass + ' / fail=' + fail, log.length ? log : '');
process.exit(fail ? 1 : 0);

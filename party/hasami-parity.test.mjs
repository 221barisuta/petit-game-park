/* はさみ将棋 コアロジック パリティテスト (divergence厳禁の機械担保)
   ──────────────────────────────────────────────────────────
   index.html 内の HASAMI-CORE を抽出し、party/hasami-core.js と「全く同じ出力」になることを確認する。
   実行: node party/hasami-parity.test.mjs   (非0終了で失敗) */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as core from './hasami-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

const start = html.indexOf('/* HASAMI-CORE-BEGIN');
const end = html.indexOf('/* HASAMI-CORE-END */', start);
if (start < 0 || end < 0) { console.error('index.html から HASAMI-CORE を抽出できませんでした'); process.exit(2); }
const refSrc = html.slice(start, end)
  + '\nexport {HAS_N,HAS_CAP_TO_WIN,hasOpp,hasInitial,hasLegalTo,hasCapturedBy,hasApply,hasCount};';
const ref = await import('data:text/javascript,' + encodeURIComponent(refSrc));

let pass = 0, fail = 0; const log = [];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ck = (name, cond) => { cond ? pass++ : (fail++, log.push(name)); };

ck('HAS_N一致', core.HAS_N === ref.HAS_N && core.HAS_N === 9);
ck('HAS_CAP_TO_WIN一致', core.HAS_CAP_TO_WIN === ref.HAS_CAP_TO_WIN && core.HAS_CAP_TO_WIN === 5);
ck('hasInitial一致', eq(core.hasInitial(), ref.hasInitial()));

// ランダム盤面 fuzz: 同一盤面で legalTo/capturedBy/apply/count を突き合わせ
let seed = 13572468;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const vals = ['black', 'white', null, null];
let fuzzFail = false;
for (let t = 0; t < 4000 && !fuzzFail; t++) {
  const b = new Array(81).fill(null);
  for (let i = 0; i < 81; i++) b[i] = vals[Math.floor(rnd() * 4)];
  if (!eq(core.hasCount(b), ref.hasCount(b))) { fuzzFail = true; log.push('fuzz-count#' + t); break; }
  const color = rnd() < 0.5 ? 'black' : 'white';
  for (let i = 0; i < 81; i++) {
    if (!eq(core.hasLegalTo(b, i, color), ref.hasLegalTo(b, i, color))) { fuzzFail = true; log.push('fuzz-legal#' + t + ':' + i); break; }
    if (b[i] === color) { // 自駒なら 合法手のいくつかで capturedBy / apply を突き合わせ
      for (const to of core.hasLegalTo(b, i, color)) {
        if (!eq(core.hasApply(b, i, to, color), ref.hasApply(b, i, to, color))) { fuzzFail = true; log.push('fuzz-apply#' + t + ':' + i + '>' + to); break; }
      }
    }
    if (b[i] != null) { // 任意マスへ 置いた前提の capturedBy も直接突き合わせ
      const cc = b[i];
      if (!eq(core.hasCapturedBy(b, i, cc), ref.hasCapturedBy(b, i, cc))) { fuzzFail = true; log.push('fuzz-cap#' + t + ':' + i); break; }
    }
  }
}
if (!fuzzFail) pass++;

// 明示ケース: 挟み取り / 角取り
{ const b = new Array(81).fill(null); b[4 * 9 + 3] = 'black'; b[4 * 9 + 4] = 'white'; b[4 * 9 + 5] = 'black';
  ck('挟み取り(横)', eq(core.hasCapturedBy(b, 4 * 9 + 5, 'black'), ref.hasCapturedBy(b, 4 * 9 + 5, 'black')) && core.hasCapturedBy(b, 4 * 9 + 5, 'black').includes(4 * 9 + 4)); }
{ const b = new Array(81).fill(null); b[0] = 'white'; b[1] = 'black'; b[9] = 'black';
  ck('角取り', core.hasCapturedBy(b, 1, 'black').includes(0) && eq(core.hasCapturedBy(b, 1, 'black'), ref.hasCapturedBy(b, 1, 'black'))); }

console.log('[parity hasami-core] pass=' + pass + ' / fail=' + fail, log.length ? log : '');
process.exit(fail ? 1 : 0);

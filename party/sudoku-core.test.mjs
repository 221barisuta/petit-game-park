/* 数独コア 唯一解検証 (機械担保)
   ──────────────────────────────────────────────────────────
   index.html 内の __SUDOKU_CORE__ ブロック(sdSolveCount/sdGenerateSolution/
   sdMakePuzzle)を抽出し、生成100盤(日替わりシード相当 × 3難易度)が
   「唯一解・完成解の部分集合・妥当な手がかり数」であることを決定的に検証する。
   実行: node party/sudoku-core.test.mjs   (非0終了で失敗)
*/
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

const START = '/* __SUDOKU_CORE_START__';
const END = '/* __SUDOKU_CORE_END__ */';
const s = html.indexOf(START), e = html.indexOf(END);
if (s < 0 || e < 0) { console.error('index.html から SUDOKU_CORE を抽出できませんでした'); process.exit(2); }
const coreSrc = html.slice(s, e + END.length)
  + '\nexport { sdSolveCount, sdGenerateSolution, sdMakePuzzle, sdBoxIndex };';
const core = await import('data:text/javascript,' + encodeURIComponent(coreSrc));
const { sdSolveCount, sdGenerateSolution, sdMakePuzzle } = core;

// index.html と同一の mulberry32 (決定的シード乱数)
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}

function isComplete(g){
  if (g.length !== 81) return false;
  for (let r=0;r<9;r++){const set=new Set();for(let c=0;c<9;c++){const v=g[r*9+c];if(v<1||v>9)return false;set.add(v);}if(set.size!==9)return false;}
  for (let c=0;c<9;c++){const set=new Set();for(let r=0;r<9;r++)set.add(g[r*9+c]);if(set.size!==9)return false;}
  for (let b=0;b<9;b++){const set=new Set(),br=((b/3)|0)*3,bc=(b%3)*3;for(let r=0;r<3;r++)for(let c=0;c<3;c++)set.add(g[(br+r)*9+bc+c]);if(set.size!==9)return false;}
  return true;
}

let fail = 0; const log = [];
const bad = (name) => { fail++; if (log.length < 30) log.push(name); };

// スモークテスト
if (sdSolveCount(new Array(81).fill(0), 2) !== 2) bad('empty-should-have-many-solutions');
{ const sol = sdGenerateSolution(mulberry32(42));
  if (!isComplete(sol)) bad('generated-solution-not-complete');
  if (sdSolveCount(sol, 2) !== 1) bad('complete-solution-not-unique'); }

// 100盤: 日替わりシード相当(dateSeed) × 3難易度
const targets = { easy: 45, normal: 33, hard: 17 };
const diffs = Object.keys(targets);
let boards = 0;
for (let day = 0; boards < 100; day++) {
  const seedBase = 20260101 + day;
  for (let di = 0; di < diffs.length && boards < 100; di++) {
    const d = diffs[di];
    const rng = mulberry32(seedBase * 17 + di * 101 + 1);
    const { puzzle, solution } = sdMakePuzzle(rng, targets[d]);
    boards++;
    const tag = day + '/' + d;
    if (!isComplete(solution)) bad('solution-invalid@' + tag);
    let filled = 0, subset = true;
    for (let i = 0; i < 81; i++) { if (puzzle[i]) { filled++; if (puzzle[i] !== solution[i]) subset = false; } }
    if (!subset) bad('not-subset@' + tag);
    const cnt = sdSolveCount(puzzle, 2);
    if (cnt !== 1) bad('not-unique(' + cnt + ')@' + tag);
    if (filled < 17 || filled > 60) bad('clues-oob(' + filled + ')@' + tag); // 17未満の唯一解は存在しない
  }
}

// 決定性: 同シードは同一パズル
{ const a = sdMakePuzzle(mulberry32(9991), 33).puzzle, b = sdMakePuzzle(mulberry32(9991), 33).puzzle;
  if (a.join(',') !== b.join(',')) bad('not-deterministic-by-seed'); }

console.log('[sudoku-core tests] boards=' + boards + ' fail=' + fail, log.length ? log : '');
if (boards !== 100 || fail > 0) { console.error('FAIL'); process.exit(1); }
console.log('OK: 生成' + boards + '盤 すべて唯一解 (unique solution guaranteed)');

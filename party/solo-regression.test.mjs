/* 直近ソロ4種 (2048 / ことばあて / ナンプレ / マインスイーパー) の
   index.html 内純ロジック selftest を headless Node で直接実行する回帰テスト。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const extract = (start, end) => {
  const a = html.indexOf(start), b = html.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`extract failed: ${start} .. ${end}`);
  return html.slice(a, b);
};
const mulberry32 = seed => {
  let a = seed | 0;
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
};
let totalPass = 0, totalFail = 0;
const makeTest = game => {
  let pass = 0, fail = 0;
  return {
    ck(name, cond) {
      cond ? (pass++, totalPass++) : (fail++, totalFail++);
      console.log((cond ? 'ok   ' : 'FAIL ') + game + ':' + name);
    },
    done() {
      console.log(`[solo ${game}] pass=${pass} fail=${fail}`);
      return { pass, fail };
    },
  };
};

const src2048 = extract('function t2048Lines', "registerGame({\n  id:'2048'");
const api2048 = new Function('makeTest', src2048 + '\nreturn {run2048Tests};')(makeTest);
api2048.run2048Tests();

const srcWordle = extract('const WD_WORDS=', "registerGame({\n  id:'wordle'");
const apiWordle = new Function('makeTest', srcWordle + '\nreturn {runWordleTests};')(makeTest);
apiWordle.runWordleTests();

const srcSudoku = extract('/* __SUDOKU_CORE_START__', "registerGame({\n  id:'sudoku'");
const apiSudoku = new Function('makeTest', 'mulberry32', srcSudoku + '\nreturn {runSudokuTests};')(makeTest, mulberry32);
apiSudoku.runSudokuTests();

const srcMines = extract('/* __MINES_CORE_START__', "registerGame({\n  id:'mines'");
const apiMines = new Function('makeTest', 'mulberry32', srcMines + '\nreturn {runMinesTests};')(makeTest, mulberry32);
apiMines.runMinesTests();

console.log(`\n[solo regression 4 games] pass=${totalPass} fail=${totalFail}`);
if (totalFail) process.exit(1);

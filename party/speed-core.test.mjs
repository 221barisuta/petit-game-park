import {
  makeSpeedDeck, newSpeedRound, speedRanksAdjacent, speedLegalMoves,
  speedPlay, speedCanShowdown, speedReady,
} from './speed-core.js';

let pass = 0, fail = 0;
const ck = (name, cond) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name);
};

ck('52枚デッキ', makeSpeedDeck().length === 52 && new Set(makeSpeedDeck().map(c => c.id)).size === 52);
ck('A-K循環', speedRanksAdjacent(1, 13) && speedRanksAdjacent(13, 1));
ck('同値と±2は不可', !speedRanksAdjacent(7, 7) && !speedRanksAdjacent(4, 6));

const round = newSpeedRound(makeSpeedDeck());
ck('各26枚を場4+台1+山21へ配る',
  round.fields.every(f => f.length === 4) &&
  round.centers.every(p => p.length === 1) &&
  round.stocks.every(s => s.length === 21));
const moves = speedLegalMoves(round, 0);
ck('初期の4を5へ出せる', moves.some(m => m.slot === 3 && m.pile === 0));
const played = speedPlay(round, 0, 3, 0, 0);
ck('出すと山から同じ場枠へ補充', played.ok && round.fields[0][3].id === 5 && round.stocks[0].length === 20);
ck('台札世代を更新', round.pileVersions[0] === 1 && round.centers[0].at(-1).r === 4);
ck('旧世代は先着負けで拒否', speedPlay(round, 1, 3, 0, 0).code === 'stale');

const stuck = newSpeedRound(makeSpeedDeck());
stuck.fields = [
  [8, 9, 10, 11].map((r, i) => ({ id: 100 + i, s: 0, r })),
  [8, 9, 10, 11].map((r, i) => ({ id: 110 + i, s: 1, r })),
];
stuck.centers = [[{ id: 120, s: 2, r: 2 }], [{ id: 121, s: 3, r: 2 }]];
stuck.stocks = [[{ id: 122, s: 0, r: 6 }], [{ id: 123, s: 1, r: 12 }]];
ck('両者出せない時だけせーの可能', speedCanShowdown(stuck));
ck('片方readyでは更新しない', speedReady(stuck, 0).updated === false && stuck.centers[0].at(-1).r === 2);
const update = speedReady(stuck, 1);
ck('双方readyを単一同期更新', update.updated && stuck.centers[0].at(-1).r === 6 &&
  stuck.centers[1].at(-1).r === 12 && stuck.pileVersions.join() === '1,1');

console.log(`\n[speed core] pass=${pass} fail=${fail}`);
if (fail) process.exit(1);

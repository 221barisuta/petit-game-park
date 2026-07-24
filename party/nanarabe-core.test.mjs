/* 七並べコアの純ロジックテスト。実行: node party/nanarabe-core.test.mjs */
import {
  makeNanaDeck, newNanaRound, nanaCardPlayable, nanaLegalCards,
  nanaPlay, nanaPass, nanaCpuChoose,
} from './nanarabe-core.js';

let pass = 0, fail = 0;
const ck = (name, cond) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name);
};

const g = newNanaRound(4, makeNanaDeck());
ck('52枚を配り7を4枚初期配置', g.hands.reduce((n, h) => n + h.length, 0) === 48
  && g.board.every(row => row[6] && row[6].r === 7));
ck('初手は各suitの6/8だけ合法', nanaLegalCards(g, 0).every(c => c.r === 6 || c.r === 8));
const first = nanaLegalCards(g, 0)[0];
ck('場の隣札は合法', nanaCardPlayable(g, first));
const bad = g.hands[0].find(c => !nanaCardPlayable(g, c));
ck('離れた札は拒否', !nanaPlay(g, 0, bad.id).ok);
const r1 = nanaPlay(g, 0, first.id);
ck('合法札を場へ配置', r1.ok && g.board[first.s][first.r - 1].id === first.id && !g.hands[0].some(c => c.id === first.id));
ck('手番外を拒否', !nanaPass(g, 0).ok);

const forced = {
  n: 3,
  hands: [
    [{ id: 0, s: 0, r: 1 }, { id: 2, s: 0, r: 3 }],
    [{ id: 18, s: 1, r: 6 }],
    [{ id: 32, s: 2, r: 7 }],
  ],
  board: Array.from({ length: 4 }, () => new Array(13).fill(null)),
  turn: 0, passes: [2, 0, 0], status: ['playing', 'playing', 'playing'],
  finishOrder: [], eliminationOrder: [], ranking: [], last: null, ended: false,
};
forced.board.forEach((row, s) => { row[6] = { id: s * 13 + 6, s, r: 7 }; });
const pr = nanaPass(forced, 0);
ck('3回目パスで脱落', pr.ok && pr.eliminatedSeat === 0 && forced.status[0] === 'eliminated');
ck('脱落手札を場へ強制公開', forced.hands[0].length === 0
  && forced.board[0][0].id === 0 && forced.board[0][2].id === 2 && pr.revealed.length === 2);

const cpu = {
  n: 3,
  hands: [[{ id: 5, s: 0, r: 6 }, { id: 0, s: 0, r: 1 }], [], []],
  board: Array.from({ length: 4 }, () => new Array(13).fill(null)),
  turn: 0, passes: [0, 0, 0], status: ['playing', 'finished', 'finished'],
};
cpu.board[0][6] = { id: 6, s: 0, r: 7 };
cpu.board[0][1] = { id: 1, s: 0, r: 2 }; // Aも合法にする
ck('CPUは端札より中央寄りを優先', nanaCpuChoose(cpu, 0, () => 0.9).cardId === 5);
cpu.hands[0] = [
  { id: 2, s: 0, r: 3 }, { id: 10, s: 0, r: 11 },
  { id: 15, s: 1, r: 3 }, { id: 23, s: 1, r: 11 }, { id: 28, s: 2, r: 3 },
];
cpu.board[0][3] = { id: 3, s: 0, r: 4 };
cpu.board[0][9] = { id: 9, s: 0, r: 10 };
cpu.board[1][3] = { id: 16, s: 1, r: 4 };
cpu.board[1][9] = { id: 22, s: 1, r: 10 };
cpu.board[2][3] = { id: 29, s: 2, r: 4 };
ck('CPUは遠い端だけなら最初の1回だけ戦略パス', nanaCpuChoose(cpu, 0, () => 0).type === 'pass');
cpu.passes[0] = 1;
ck('CPUは残りパスを温存して札を出す', nanaCpuChoose(cpu, 0, () => 0).type === 'play');

const rank = {
  n: 3,
  hands: [[{ id: 5, s: 0, r: 6 }], [{ id: 18, s: 1, r: 6 }], [{ id: 31, s: 2, r: 6 }]],
  board: Array.from({ length: 4 }, () => new Array(13).fill(null)),
  turn: 0, passes: [0, 2, 2], status: ['playing', 'playing', 'playing'],
  finishOrder: [], eliminationOrder: [], ranking: [], last: null, ended: false,
};
rank.board.forEach((row, s) => { row[6] = { id: s * 13 + 6, s, r: 7 }; });
nanaPlay(rank, 0, 5); // seat0 上がり
nanaPass(rank, 1);    // seat1 先に脱落
nanaPass(rank, 2);    // seat2 後に脱落
ck('順位は上がり順、その後は後脱落が上位', rank.ended && rank.ranking.join(',') === '0,2,1');

console.log(`\n[nanarabe core] pass=${pass} fail=${fail}`);
if (fail) process.exit(1);

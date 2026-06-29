/* PartyKit サーバーの権威ロジック headless テスト (モックroom/conn)
   検証: 座席割当 / 着手検証(手番・観戦・空きマス・盤外) / 勝敗確定 / 再接続 / rematch先後入替
   実行: node party/server.test.mjs   (非0終了で失敗) */
import GomokuServer from './server.js';
import { GO_N } from './gomoku-core.js';

// crypto.randomUUID が無い環境向けの保険 (Node18+ には globalThis.crypto あり)
if (!globalThis.crypto) globalThis.crypto = (await import('node:crypto')).webcrypto;

const idx = (x, y) => y * GO_N + x;
class Conn {
  constructor(id) { this.id = id; this.state = undefined; this.sent = []; }
  setState(s) { this.state = s; }
  send(s) { this.sent.push(JSON.parse(s)); }
  last() { return this.sent[this.sent.length - 1]; }
  lastOf(t) { return [...this.sent].reverse().find(m => m.type === t); }
}
class Room {
  constructor() {
    this.conns = new Set();
    const m = new Map();
    this.alarm = null; // setAlarm の値を保持 (テストで確認用)
    this.storage = {
      get: async k => m.get(k), put: async (k, v) => void m.set(k, v),
      setAlarm: async ts => { this.alarm = ts; }, getAlarm: async () => this.alarm,
      deleteAlarm: async () => { this.alarm = null; },
    };
  }
  getConnections() { return this.conns; }
  broadcast(s) { for (const c of this.conns) c.send(s); }
}

let pass = 0, fail = 0; const log = [];
const ck = (n, c) => { c ? pass++ : (fail++, log.push(n)); };

const room = new Room();
const srv = new GomokuServer(room);
await srv.onStart();
const hello = (c, name, token) => srv.onMessage(JSON.stringify({ type: 'hello', name, token }), c);
const move = (c, index) => srv.onMessage(JSON.stringify({ type: 'move', index }), c);
const rematch = (c, on = true) => srv.onMessage(JSON.stringify({ type: 'rematch', on }), c);
const connect = (c) => { room.conns.add(c); srv.onConnect(c); };

// ── 座席割当 ──
const b = new Conn('b'); connect(b); await hello(b, 'くろ');
const w = new Conn('w'); connect(w); await hello(w, 'しろ');
const s = new Conn('s'); connect(s); await hello(s, 'みる人');
ck('seat:black', b.lastOf('assigned').seat === 'black');
ck('seat:white', w.lastOf('assigned').seat === 'white');
ck('seat:spectator', s.lastOf('assigned').seat === 'spectator');
ck('seat:spectator-no-token', s.lastOf('assigned').token === null);
const tokB = b.lastOf('assigned').token, tokW = w.lastOf('assigned').token;
ck('state:names', b.lastOf('state').seats.black.name === 'くろ' && b.lastOf('state').seats.white.name === 'しろ');
ck('state:spectators=1', b.lastOf('state').spectators === 1);

// ── 着手検証 ──
await move(w, idx(7, 7));        // 白が黒手番に打つ → 拒否
ck('reject:wrong-turn', w.lastOf('error') && b.lastOf('state').last === -1);
await move(s, idx(7, 7));        // 観戦者の着手 → 拒否
ck('reject:spectator', s.lastOf('error'));
await move(b, idx(7, 7));        // 黒OK
ck('accept:black-center', b.lastOf('state').last === idx(7, 7) && b.lastOf('state').turn === 'white');
await move(b, idx(8, 8));        // 連続で黒（手番は白）→ 拒否
ck('reject:turn-after', b.lastOf('error'));
await move(w, idx(7, 7));        // 埋まったマス → 拒否
ck('reject:occupied', w.lastOf('error'));
await move(w, -1);               // 盤外 → 拒否
ck('reject:out-of-range', w.lastOf('error'));

// ── 横5連で黒勝ち (中央付近を避けて (0..4, 5) で) ──
// 現状: (7,7)=黒, turn=white。改めてクリーンに勝ちを作る
await move(w, idx(0, 0));        // 白は飛び石(連にならない)で手番だけ消化
await move(b, idx(0, 5)); await move(w, idx(2, 0));
await move(b, idx(1, 5)); await move(w, idx(4, 0));
await move(b, idx(2, 5)); await move(w, idx(6, 0));
await move(b, idx(3, 5)); await move(w, idx(8, 0));
await move(b, idx(4, 5));        // 黒 (0..4,5) で5連
const st = b.lastOf('state');
ck('win:black', st.result && st.result.winner === 'black' && st.result.line.length === 5);
await move(w, idx(5, 0));        // 決着後の着手 → 拒否
ck('reject:after-result', w.lastOf('error'));

// ── 再接続: 黒が切断→同トークンで復帰し盤面維持 ──
room.conns.delete(b); await srv.onClose(b);
const b2 = new Conn('b2'); connect(b2); await hello(b2, 'くろ復帰', tokB);
ck('reconnect:same-seat', b2.lastOf('assigned').seat === 'black');
ck('reconnect:board-restored', b2.lastOf('state').last === idx(4, 5) && b2.lastOf('state').result.winner === 'black');

// ── rematch: 両者合意でリセット + 先後入替 ──
await rematch(b2);
ck('rematch:wait-both', b2.lastOf('state').result !== null); // 片方だけでは継続
await rematch(w);
const r = w.lastOf('state');
ck('rematch:reset', r.result === null && r.board.every(c => c === null) && r.last === -1);
ck('rematch:gameNo', r.gameNo === 2);
ck('rematch:swap-seats', tokB === undefined ? false : true); // トークンは保持
ck('rematch:conn-seat-swapped', b2.state.seat === 'white' && w.state.seat === 'black'); // 先後入替が接続にも反映
// #3: 入替後に各接続へ新しい assigned が再送される (これが無いと client の seat が古いまま=手番ズレ)
ck('rematch:reassigned-b2', b2.lastOf('assigned').seat === 'white' && b2.lastOf('assigned').token === tokB);
ck('rematch:reassigned-w', w.lastOf('assigned').seat === 'black' && w.lastOf('assigned').token === tokW);

// ── 席解放タイムアウト (onClose で切断記録 → onAlarm で解放。時刻は srv.now で注入) ──
async function freshSrv() {
  const room = new Room(); const srv = new GomokuServer(room); await srv.onStart();
  return { room, srv,
    connect: c => { room.conns.add(c); srv.onConnect(c); },
    hello: (c, n, t) => srv.onMessage(JSON.stringify({ type: 'hello', name: n, token: t }), c),
    move: (c, i) => srv.onMessage(JSON.stringify({ type: 'move', index: i }), c),
    undo: c => srv.onMessage(JSON.stringify({ type: 'undo' }), c),
    rematch: c => srv.onMessage(JSON.stringify({ type: 'rematch', on: true }), c) };
}
// ① 30秒経過で席解放 → 空席に新規着席できる / 猶予内の onAlarm 空振りでは解放しない
{ const { room, srv, connect, hello } = await freshSrv();
  srv.now = () => 1000;
  const B = new Conn('B'); connect(B); await hello(B, 'くろ');
  const W = new Conn('W'); connect(W); await hello(W, 'しろ');
  room.conns.delete(W); await srv.onClose(W);
  ck('release:alarm-set', room.alarm === 1000 + 30000);
  ck('release:not-yet', srv.game.seats.white !== null);
  srv.now = () => 1000 + 29000; await srv.onAlarm();         // 猶予内 → 空振り
  ck('release:within-grace-keeps', srv.game.seats.white !== null);
  srv.now = () => 1000 + 31000; await srv.onAlarm();         // 猶予超過 → 解放
  ck('release:freed', srv.game.seats.white === null);
  ck('release:alarm-cleared', room.alarm === null);
  const N = new Conn('N'); connect(N); await hello(N, 'あたらしい人'); // 空席に着席可
  ck('release:new-can-sit', N.lastOf('assigned').seat === 'white');
}
// ② 猶予内に同トークン再接続 → 席維持 (その後アラームが発火しても解放されない=冪等)
{ const { room, srv, connect, hello } = await freshSrv();
  srv.now = () => 5000;
  const B = new Conn('B'); connect(B); await hello(B, 'くろ');
  const W = new Conn('W'); connect(W); await hello(W, 'しろ');
  const wTok = W.lastOf('assigned').token;
  room.conns.delete(W); await srv.onClose(W);
  srv.now = () => 5000 + 10000;
  const W2 = new Conn('W2'); connect(W2); await hello(W2, 'しろ復帰', wTok);
  ck('reconnect-grace:same-seat', W2.lastOf('assigned').seat === 'white');
  ck('reconnect-grace:disc-cleared', srv.game.seats.white.disc == null);
  srv.now = () => 5000 + 40000; await srv.onAlarm();
  ck('reconnect-grace:still-seated', srv.game.seats.white !== null && W2.state.seat === 'white');
}
// ③ 対局途中の解放 → 盤リセット (gameNo++, 盤空, result null, 残存席は保持)
{ const { room, srv, connect, hello, move } = await freshSrv();
  srv.now = () => 0;
  const B = new Conn('B'); connect(B); await hello(B, 'くろ');
  const W = new Conn('W'); connect(W); await hello(W, 'しろ');
  await move(B, idx(7, 7)); await move(W, idx(7, 8)); await move(B, idx(8, 8)); // 途中
  const before = srv.game.gameNo;
  ck('midgame:has-moves', srv.game.board.some(c => c) && !srv.game.result);
  room.conns.delete(W); await srv.onClose(W);
  srv.now = () => 31000; await srv.onAlarm();
  ck('midgame:seat-freed', srv.game.seats.white === null);
  ck('midgame:board-reset', srv.game.board.every(c => c === null) && srv.game.turn === 'black' && srv.game.result === null && srv.game.last === -1);
  ck('midgame:gameNo++', srv.game.gameNo === before + 1);
  ck('midgame:black-kept', srv.game.seats.black !== null);
  const N = new Conn('N'); connect(N); await hello(N, '新');
  ck('midgame:new-sits-white', N.lastOf('assigned').seat === 'white');
}
// ④ 決着後の解放 → 盤リセットしない (席だけ解放)
{ const { room, srv, connect, hello, move } = await freshSrv();
  srv.now = () => 0;
  const B = new Conn('B'); connect(B); await hello(B, 'くろ');
  const W = new Conn('W'); connect(W); await hello(W, 'しろ');
  const fill = [[B, idx(0, 5)], [W, idx(0, 0)], [B, idx(1, 5)], [W, idx(2, 0)], [B, idx(2, 5)], [W, idx(4, 0)], [B, idx(3, 5)], [W, idx(6, 0)], [B, idx(4, 5)]];
  for (const [c, i] of fill) await move(c, i);
  ck('decided:has-result', srv.game.result && srv.game.result.winner === 'black');
  const gn = srv.game.gameNo;
  room.conns.delete(W); await srv.onClose(W);
  srv.now = () => 31000; await srv.onAlarm();
  ck('decided:seat-freed', srv.game.seats.white === null);
  ck('decided:no-reset', srv.game.result && srv.game.result.winner === 'black' && srv.game.gameNo === gn);
}

// ── #4 待った (undo): 直前手の本人だけ・相手応手前だけ・直前1手のみ・相手へ通知 ──
{ const { room, srv, connect, hello, move, undo } = await freshSrv();
  const B = new Conn('B'); connect(B); await hello(B, 'くろ');
  const W = new Conn('W'); connect(W); await hello(W, 'しろ');
  await move(B, idx(7, 7));            // 黒が打つ → 手番は白、直前手は黒
  // 相手(白=手番側)の待ったは無効
  await undo(W);
  ck('undo:opponent-rejected', W.lastOf('error') && srv.game.board[idx(7, 7)] === 'black');
  // 直前手の本人(黒)の待ったは成立 → 石が消え手番が黒へ戻る
  await undo(B);
  ck('undo:self-ok-removed', srv.game.board[idx(7, 7)] === null && srv.game.last === -1 && srv.game.turn === 'black');
  ck('undo:opponent-toast', W.lastOf('toast') && /まった/.test(W.lastOf('toast').msg));
  // 連続待った(もう直前手が無い)は不可
  const errsBefore = B.sent.filter(m => m.type === 'error').length;
  await undo(B);
  ck('undo:no-prev-rejected', B.sent.filter(m => m.type === 'error').length === errsBefore + 1);
  // 相手が打った後は待った不可: 黒(7,7)→白(8,8)、ここで黒のundoは「直前手が白」で不可
  await move(B, idx(7, 7)); await move(W, idx(8, 8));
  const e2 = B.sent.filter(m => m.type === 'error').length;
  await undo(B);
  ck('undo:after-opp-move-rejected', B.sent.filter(m => m.type === 'error').length === e2 + 1 && srv.game.board[idx(8, 8)] === 'white');
}

// ── #8 シリーズ: 決着ごとに勝者pidを記録、再戦(先後入替)を跨いでも安定 ──
{ const { room, srv, connect, hello, move, rematch } = await freshSrv();
  const B = new Conn('B'); connect(B); await hello(B, 'くろ');
  const W = new Conn('W'); connect(W); await hello(W, 'しろ');
  const pidB = srv.game.seats.black.pid, pidW = srv.game.seats.white.pid;
  ck('series:pids-distinct', pidB && pidW && pidB !== pidW);
  ck('series:pid-in-state', B.lastOf('state').seats.black.pid === pidB); // pidはstateで配信
  // 1局目: 黒(0..4,5)で勝ち
  const win = c => { const seq = [[B, idx(0, 5)], [W, idx(0, 0)], [B, idx(1, 5)], [W, idx(2, 0)], [B, idx(2, 5)], [W, idx(4, 0)], [B, idx(3, 5)], [W, idx(6, 0)], [B, idx(4, 5)]]; return seq; };
  for (const [cc, i] of win()) await move(cc, i);
  ck('series:g1-winner', srv.game.series.length === 1 && srv.game.series[0].winner === pidB);
  // 再戦 → 先後入替 (B=白, W=黒)。pidは保持
  await rematch(B); await rematch(W);
  ck('series:rematch-swap', srv.game.seats.white.pid === pidB && srv.game.seats.black.pid === pidW);
  // 2局目: いまの黒(=元W,pidW)が勝つ
  const seq2 = [[W, idx(0, 5)], [B, idx(0, 0)], [W, idx(1, 5)], [B, idx(2, 0)], [W, idx(2, 5)], [B, idx(4, 0)], [W, idx(3, 5)], [B, idx(6, 0)], [W, idx(4, 5)]];
  for (const [cc, i] of seq2) await move(cc, i);
  ck('series:g2-winner-pid-stable', srv.game.series.length === 2 && srv.game.series[1].winner === pidW);
  ck('series:in-state', B.lastOf('state').series.length === 2);
}

console.log('[server logic] pass=' + pass + ' / fail=' + fail, log.length ? log : '');
process.exit(fail ? 1 : 0);

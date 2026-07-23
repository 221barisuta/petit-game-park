/* コネクトフォー オンライン権威ロジック headless テスト (モックroom/conn)
   検証: 座席割当 / 着手検証(手番・観戦・重力違反・盤外) / 縦横斜め4連 / 待った / rematch先後入替 /
         切断グレース席解放(alarm)。共通基盤(versus-server.js→SimpleGridServer)を固有フック経由で通す統合テスト。
   実行: node party/c4-server.test.mjs   (非0終了で失敗) */
import Connect4Server from './c4-server.js';
import { C4_COLS, c4Drop } from './c4-core.js';

if (!globalThis.crypto) globalThis.crypto = (await import('node:crypto')).webcrypto;

class Conn {
  constructor(id) { this.id = id; this.state = undefined; this.sent = []; this.closed = false; this.room = null; }
  setState(s) { this.state = s; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.closed = true; if (this.room) this.room.conns.delete(this); }
  last() { return this.sent[this.sent.length - 1]; }
  lastOf(t) { return [...this.sent].reverse().find(m => m.type === t); }
}
class Room {
  constructor() {
    this.conns = new Set();
    const m = new Map();
    this.alarm = null;
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
const srv = new Connect4Server(room);
await srv.onStart();
const hello = (c, name, token) => srv.onMessage(JSON.stringify({ type: 'hello', name, token }), c);
const move = (c, index) => srv.onMessage(JSON.stringify({ type: 'move', index }), c);
const undo = (c) => srv.onMessage(JSON.stringify({ type: 'undo' }), c);
const rematch = (c, on = true) => srv.onMessage(JSON.stringify({ type: 'rematch', on }), c);
const connect = (c) => { c.room = room; room.conns.add(c); srv.onConnect(c); };
const board = () => b.lastOf('state').board;
const drop = (bd, col) => c4Drop(bd, col); // 現盤面での列→着地index

// ── 座席割当 ──
const b = new Conn('b'); connect(b); await hello(b, 'くろ');
const w = new Conn('w'); connect(w); await hello(w, 'しろ');
const s = new Conn('s'); connect(s); await hello(s, 'みる人');
ck('seat:black', b.lastOf('assigned').seat === 'black');
ck('seat:white', w.lastOf('assigned').seat === 'white');
ck('seat:spectator', s.lastOf('assigned').seat === 'spectator');
ck('state:board42', b.lastOf('state').board.length === 42);

// ── 着手検証: 手番・観戦・重力違反・盤外 ──
await move(w, drop(board(), 3)); // 白が黒手番に打つ → 拒否
ck('reject:wrong-turn', w.lastOf('error') && board().every(v => v === null));
await move(s, drop(board(), 3)); // 観戦者 → 拒否
ck('reject:spectator', s.lastOf('error'));
// 重力違反: 列3の一番上(index 3, r=0)へ直接置く(直下が空なので浮きマス) → 拒否
await move(b, 3);
ck('reject:gravity', b.lastOf('error') && board()[3] === null);
await move(b, 42); ck('reject:out-hi', b.lastOf('error'));
await move(b, -1); ck('reject:out-lo', b.lastOf('error'));
// 黒: 列3の底(index 38)へ着地
const land = drop(board(), 3);
ck('drop:landing-is-bottom', land === 38);
await move(b, land);
ck('accept:black-drop', board()[38] === 'black' && b.lastOf('state').turn === 'white' && b.lastOf('state').last === 38);

// ── 待った: 直前手=黒(38)・白未応手 → 黒が取消可 ──
await undo(b);
ck('undo:cleared', board()[38] === null && b.lastOf('state').turn === 'black' && b.lastOf('state').last === -1);

// ── 縦4連(黒): 列0に黒4段積み。白は列1,2,3を消化して手番だけ回す ──
{
  await move(b, drop(board(), 0)); await move(w, drop(board(), 1)); // 黒 col0(r5) / 白 col1
  await move(b, drop(board(), 0)); await move(w, drop(board(), 2)); // 黒 col0(r4) / 白 col2
  await move(b, drop(board(), 0)); await move(w, drop(board(), 3)); // 黒 col0(r3) / 白 col3
  await move(b, drop(board(), 0)); // 黒 col0(r2) = 縦4連
  const win = b.lastOf('state');
  ck('win:vertical-black', win.result && win.result.winner === 'black' && win.result.line.length === 4);
  ck('win:turn-frozen', win.turn === 'black');
  ck('win:no-more-move', (await move(w, drop(win.board, 4)), w.lastOf('error')));
  ck('series:1game', win.series.length === 1 && win.series[0].winner === win.seats.black.pid);
}

// ── もう一局: 両者合意で盤リセット + 先後入替 ──
await rematch(b); await rematch(w);
const rg = b.lastOf('state');
ck('rematch:reset', rg.board.every(c => c === null) && rg.result === null && rg.gameNo === 2);
ck('rematch:swap', rg.seats.black.name === 'しろ' && rg.seats.white.name === 'くろ');

// ── 横4連(別Room・黒): 黒 col0..3(底), 白は col0..2 の2段目を消化 ──
{
  const room2 = new Room(); const srv2 = new Connect4Server(room2); await srv2.onStart();
  const h2 = (c, n) => srv2.onMessage(JSON.stringify({ type: 'hello', name: n }), c);
  const m2 = (c, i) => srv2.onMessage(JSON.stringify({ type: 'move', index: i }), c);
  const b2 = new Conn('b2'); b2.room = room2; room2.conns.add(b2); srv2.onConnect(b2); await h2(b2, 'B');
  const w2 = new Conn('w2'); w2.room = room2; room2.conns.add(w2); srv2.onConnect(w2); await h2(w2, 'W');
  const bd2 = () => b2.lastOf('state').board;
  // 黒 col0,1,2,3 の底に横並び / 白 col0,1,2 の2段目(害なし)
  await m2(b2, c4Drop(bd2(), 0)); await m2(w2, c4Drop(bd2(), 0));
  await m2(b2, c4Drop(bd2(), 1)); await m2(w2, c4Drop(bd2(), 1));
  await m2(b2, c4Drop(bd2(), 2)); await m2(w2, c4Drop(bd2(), 2));
  await m2(b2, c4Drop(bd2(), 3)); // 黒 底row 0,1,2,3 = 横4連
  const win = b2.lastOf('state');
  ck('win:horizontal-black', win.result && win.result.winner === 'black' && win.result.line.length === 4);
}

// ── 切断グレース席解放(alarm) ──
{
  const room3 = new Room(); const srv3 = new Connect4Server(room3); await srv3.onStart();
  let fakeNow = 100000; srv3.now = () => fakeNow;
  const h3 = (c, n) => srv3.onMessage(JSON.stringify({ type: 'hello', name: n }), c);
  const b3 = new Conn('b3'); b3.room = room3; room3.conns.add(b3); srv3.onConnect(b3); await h3(b3, 'B3');
  const w3 = new Conn('w3'); w3.room = room3; room3.conns.add(w3); srv3.onConnect(w3); await h3(w3, 'W3');
  w3.close(); await srv3.onClose(w3);
  ck('alarm:set', room3.alarm != null);
  fakeNow += 31000; await srv3.onAlarm();
  ck('alarm:white-released', b3.lastOf('state').seats.white === null);
}

console.log('[c4 server logic] pass=' + pass + ' / fail=' + fail, log.length ? log : '');
process.exit(fail ? 1 : 0);

/* はさみ将棋 オンライン権威ロジック headless テスト (モックroom/conn)
   検証: 座席割当 / hmove検証(手番・観戦・自駒でない・非合法移動・盤外) / 挟み取り / 角取り /
         5枚取り勝ち / まった(取りも巻き戻る) / 切断グレース席解放(alarm)。
   実行: node party/hasami-server.test.mjs   (非0終了で失敗) */
import HasamiServer from './hasami-server.js';
import { hasInitial, hasCapturedBy, hasApply, HAS_N } from './hasami-core.js';

if (!globalThis.crypto) globalThis.crypto = (await import('node:crypto')).webcrypto;

class Conn {
  constructor(id) { this.id = id; this.state = undefined; this.sent = []; this.closed = false; this.room = null; }
  setState(s) { this.state = s; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.closed = true; if (this.room) this.room.conns.delete(this); }
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
const RC = (r, c) => r * HAS_N + c;

let pass = 0, fail = 0; const log = [];
const ck = (n, c) => { c ? pass++ : (fail++, log.push(n)); };

// ── コア単体: 挟み取り / 角取り (盤を直接組んで確認) ──
{
  // 横挟み: black が (4,3)(4,5) を持ち、(4,4)=white を挟む。black を (4,5) に置いた後の取り判定
  const b = new Array(81).fill(null);
  b[RC(4, 3)] = 'black'; b[RC(4, 4)] = 'white'; b[RC(4, 5)] = 'black';
  ck('core:挟み取り(横)', hasCapturedBy(b, RC(4, 5), 'black').includes(RC(4, 4)));
  // 角取り: (0,0)=white, 隣接(0,1)(1,0)=black → 角の white を取る
  const b2 = new Array(81).fill(null);
  b2[RC(0, 0)] = 'white'; b2[RC(0, 1)] = 'black'; b2[RC(1, 0)] = 'black';
  ck('core:角取り', hasCapturedBy(b2, RC(0, 1), 'black').includes(RC(0, 0)));
  // hasApply: 移動+取り
  const b3 = new Array(81).fill(null);
  b3[RC(4, 3)] = 'black'; b3[RC(4, 4)] = 'white'; b3[RC(4, 7)] = 'black';
  const r = hasApply(b3, RC(4, 7), RC(4, 5), 'black'); // (4,7)→(4,5) で (4,4)white を挟む
  ck('core:hasApply取り', r.captured.includes(RC(4, 4)) && r.board[RC(4, 4)] === null && r.board[RC(4, 5)] === 'black');
}

const room = new Room();
const srv = new HasamiServer(room);
await srv.onStart();
const hello = (c, name) => srv.onMessage(JSON.stringify({ type: 'hello', name }), c);
const hmove = (c, from, to) => srv.onMessage(JSON.stringify({ type: 'hmove', from, to }), c);
const undo = (c) => srv.onMessage(JSON.stringify({ type: 'undo' }), c);
const connect = (c) => { c.room = room; room.conns.add(c); srv.onConnect(c); };
const st = () => b.lastOf('state');

const b = new Conn('b'); connect(b); await hello(b, 'せんて');
const w = new Conn('w'); connect(w); await hello(w, 'ごて');
const s = new Conn('s'); connect(s); await hello(s, 'みる人');
ck('seat:black', b.lastOf('assigned').seat === 'black');
ck('state:board81', st().board.length === 81);
ck('state:initial', st().board[RC(0, 0)] === 'white' && st().board[RC(8, 0)] === 'black');
ck('state:caps0', st().caps.black === 0 && st().caps.white === 0);

// ── hmove 検証 (初期盤: 黒手番。row1..7 は空) ──
await hmove(w, RC(0, 0), RC(1, 0));   // 白が黒手番に → 拒否
ck('reject:wrong-turn', w.lastOf('error') && st().board[RC(8, 0)] === 'black');
await hmove(s, RC(8, 0), RC(7, 0));   // 観戦者 → 拒否
ck('reject:spectator', s.lastOf('error'));
await hmove(b, RC(0, 0), RC(1, 0));   // 黒が白駒を動かす → 拒否
ck('reject:not-own', b.lastOf('error'));
await hmove(b, RC(8, 1), RC(7, 2));   // 斜め移動は飛車動きでない → 拒否
ck('reject:illegal-move', b.lastOf('error') && st().board[RC(7, 2)] === null);
await hmove(b, RC(8, 0), RC(2, 0));   // 縦に真っ直ぐ(間は空) → 合法
ck('accept:black-first', st().board[RC(2, 0)] === 'black' && st().board[RC(8, 0)] === null && st().turn === 'white');

// ── 挟み取りを実戦手順で: 白(0,3)→ 黒で挟む状況を作る ──
// 手数がかかるので 別Roomで盤を直接注入せず、コアは上で検証済み。ここは「取ったら caps 増加+手番交代」を確認する。
{
  const room2 = new Room(); const srv2 = new HasamiServer(room2); await srv2.onStart();
  // storage に細工した盤を入れて onStart で復元させる: black(4,3),(4,5) / white(4,4) を挟める状況、black手番
  const rigged = {
    board: (() => { const bb = new Array(81).fill(null); bb[RC(4, 2)] = 'black'; bb[RC(4, 4)] = 'white'; bb[RC(4, 5)] = 'black'; return bb; })(),
    turn: 'black', last: -1, from: -1, caps: { black: 0, white: 0 }, history: [], result: null,
    seats: { black: null, white: null }, rematch: { black: false, white: false }, gameNo: 1, series: [],
  };
  await room2.storage.put('game', rigged);
  const srv2b = new HasamiServer(room2); await srv2b.onStart();
  const h2 = (c, n) => srv2b.onMessage(JSON.stringify({ type: 'hello', name: n }), c);
  const hm2 = (c, f, t2) => srv2b.onMessage(JSON.stringify({ type: 'hmove', from: f, to: t2 }), c);
  const b2 = new Conn('b2'); b2.room = room2; room2.conns.add(b2); srv2b.onConnect(b2); await h2(b2, 'B');
  const w2 = new Conn('w2'); w2.room = room2; room2.conns.add(w2); srv2b.onConnect(w2); await h2(w2, 'W');
  // black (4,2)→(4,3) で (4,4)white を (4,3)-(4,5) で挟む
  await hm2(b2, RC(4, 2), RC(4, 3));
  const g2 = b2.lastOf('state');
  ck('capture:white-taken', g2.board[RC(4, 4)] === null && g2.caps.black === 1);
  ck('capture:turn-swaps', g2.turn === 'white');
  ck('capture:from-published', g2.from === RC(4, 2) && g2.last === RC(4, 3));
  // まった → 取りも巻き戻る
  await srv2b.onMessage(JSON.stringify({ type: 'undo' }), b2);
  const gu = b2.lastOf('state');
  ck('undo:restores-capture', gu.board[RC(4, 4)] === 'white' && gu.board[RC(4, 2)] === 'black' && gu.caps.black === 0 && gu.turn === 'black');
}

// ── 5枚取り先取で勝ち ──
{
  const room3 = new Room();
  // black が (r,1)(r,3) を持ち各 (r,2)=white を挟んで 5枚取る形を r=0..4 で用意…だと複雑。
  // 代わりに caps を 4 まで進めた状態を注入し、1回の取りで 5 到達→勝ちを確認。
  const rigged = {
    board: (() => { const bb = new Array(81).fill(null); bb[RC(4, 2)] = 'black'; bb[RC(4, 4)] = 'white'; bb[RC(4, 5)] = 'black'; return bb; })(),
    turn: 'black', last: -1, from: -1, caps: { black: 4, white: 0 }, history: [], result: null,
    seats: { black: null, white: null }, rematch: { black: false, white: false }, gameNo: 1, series: [],
  };
  await room3.storage.put('game', rigged);
  const srv3 = new HasamiServer(room3); await srv3.onStart();
  const h3 = (c, n) => srv3.onMessage(JSON.stringify({ type: 'hello', name: n }), c);
  const hm3 = (c, f, t3) => srv3.onMessage(JSON.stringify({ type: 'hmove', from: f, to: t3 }), c);
  const b3 = new Conn('b3'); b3.room = room3; room3.conns.add(b3); srv3.onConnect(b3); await h3(b3, 'B3');
  const w3 = new Conn('w3'); w3.room = room3; room3.conns.add(w3); srv3.onConnect(w3); await h3(w3, 'W3');
  await hm3(b3, RC(4, 2), RC(4, 3)); // 5枚目を取る
  const g3 = b3.lastOf('state');
  ck('win:5-captures', g3.caps.black === 5 && g3.result && g3.result.winner === 'black' && g3.turn === 'black');
  ck('win:series-recorded', g3.series.length === 1 && g3.series[0].winner === g3.seats.black.pid);
  await hm3(w3, RC(0, 0), RC(1, 0)); // 決着後は着手不可
  ck('win:no-move-after', w3.lastOf('error'));
}

// ── 切断グレース席解放(alarm) ──
{
  const room4 = new Room(); const srv4 = new HasamiServer(room4); await srv4.onStart();
  let fakeNow = 100000; srv4.now = () => fakeNow;
  const h4 = (c, n) => srv4.onMessage(JSON.stringify({ type: 'hello', name: n }), c);
  const b4 = new Conn('b4'); b4.room = room4; room4.conns.add(b4); srv4.onConnect(b4); await h4(b4, 'B4');
  const w4 = new Conn('w4'); w4.room = room4; room4.conns.add(w4); srv4.onConnect(w4); await h4(w4, 'W4');
  w4.close(); await srv4.onClose(w4);
  ck('alarm:set', room4.alarm != null);
  fakeNow += 31000; await srv4.onAlarm();
  ck('alarm:white-released', b4.lastOf('state').seats.white === null);
}

console.log('[hasami server logic] pass=' + pass + ' / fail=' + fail, log.length ? log : '');
process.exit(fail ? 1 : 0);

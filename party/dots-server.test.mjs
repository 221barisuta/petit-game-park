/* ドット&ボックス オンライン権威ロジック headless テスト (モックroom/conn)
   検証: 座席割当 / 着手検証(手番・観戦・引き済み・盤外) / 箱完成での【手番継続】(最重要) /
         得点(boxes配信) / まった(継続手も戻る) / 満局勝敗 / 切断グレース席解放(alarm)。
   実行: node party/dots-server.test.mjs   (非0終了で失敗) */
import DotsServer from './dots-server.js';
import { dotsWinner } from './dots-core.js';

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

let pass = 0, fail = 0; const log = [];
const ck = (n, c) => { c ? pass++ : (fail++, log.push(n)); };

const room = new Room();
const srv = new DotsServer(room);
await srv.onStart();
const hello = (c, name) => srv.onMessage(JSON.stringify({ type: 'hello', name }), c);
const move = (c, index) => srv.onMessage(JSON.stringify({ type: 'move', index }), c);
const undo = (c) => srv.onMessage(JSON.stringify({ type: 'undo' }), c);
const connect = (c) => { c.room = room; room.conns.add(c); srv.onConnect(c); };
const st = () => b.lastOf('state');

const b = new Conn('b'); connect(b); await hello(b, 'くろ');
const w = new Conn('w'); connect(w); await hello(w, 'しろ');
const s = new Conn('s'); connect(s); await hello(s, 'みる人');
ck('seat:black', b.lastOf('assigned').seat === 'black');
ck('seat:white', w.lastOf('assigned').seat === 'white');
ck('state:board40', st().board.length === 40);
ck('state:boxes16', st().boxes.length === 16);

// ── 着手検証 ──
await move(w, 0);                 // 白が黒手番に → 拒否
ck('reject:wrong-turn', w.lastOf('error') && st().board.every(v => v === null));
await move(s, 0);                 // 観戦者 → 拒否
ck('reject:spectator', s.lastOf('error'));
await move(b, 40); ck('reject:out-hi', b.lastOf('error'));
await move(b, -1); ck('reject:out-lo', b.lastOf('error'));

// ── 通常着手(箱未完成)→ 手番交代 ──
await move(b, 0);                 // 黒 辺0
ck('accept:black', st().board[0] === 'black' && st().turn === 'white' && st().last === 0);
await move(b, 4);                 // 連続で黒 → 拒否(手番は白)
ck('reject:turn-after', b.lastOf('error'));
await move(w, 0);                 // 引き済み辺 → 拒否
ck('reject:drawn', w.lastOf('error'));

// ── 箱0(辺 0,4,20,21)を黒が完成 → 【手番継続】+ 得点。白は遠くの辺(19,18,17)を消化 ──
await move(w, 19); await move(b, 4); await move(w, 18); await move(b, 20); await move(w, 17);
// ここまで箱0 は辺 0,4,20 の3辺。黒手番で辺21を引くと完成。
ck('pre:box0-not-yet', st().boxes[0] === null && st().turn === 'black');
await move(b, 21);               // 箱0 完成 → 黒得点 + 手番維持
const cont = st();
ck('continue:box0-owned-black', cont.boxes[0] === 'black');
ck('continue:turn-stays-black', cont.turn === 'black');     // ★ 手番継続の核心
ck('continue:board-has-21', cont.board[21] === 'black' && cont.last === 21);
// 継続手: 黒がもう1手 (箱未完成の辺16) → 手番交代
await move(b, 16);
ck('continue:extra-move-then-swap', st().board[16] === 'black' && st().turn === 'white');

// ── まった: 継続で取った手も綺麗に戻る (白の直前手16の前=黒の16を白は戻せない/黒が戻す) ──
// 直前手=黒(16)。白の番。黒は「直前手が自分・相手未応手」なので戻せる。
await undo(b);
ck('undo:reverts-16', st().board[16] === null && st().turn === 'black');
// さらに黒が undo → 箱0完成手(21)が戻り 得点も消える・手番は黒(21を引く直前の手番=黒)
await undo(b);
ck('undo:reverts-box0', st().board[21] === null && st().boxes[0] === null && st().turn === 'black');

// ── 満局勝敗(別Room): 40辺を index順に「その時の手番の席」で全て引き切る ──
{
  const room2 = new Room(); const srv2 = new DotsServer(room2); await srv2.onStart();
  const h2 = (c, n) => srv2.onMessage(JSON.stringify({ type: 'hello', name: n }), c);
  const m2 = (c, i) => srv2.onMessage(JSON.stringify({ type: 'move', index: i }), c);
  const b2 = new Conn('b2'); b2.room = room2; room2.conns.add(b2); srv2.onConnect(b2); await h2(b2, 'B');
  const w2 = new Conn('w2'); w2.room = room2; room2.conns.add(w2); srv2.onConnect(w2); await h2(w2, 'W');
  const cur = () => (b2.lastOf('state').turn === 'black' ? b2 : w2);
  for (let e = 0; e < 40; e++) { const g = b2.lastOf('state'); if (g.result) break; await m2(cur(), e); }
  const fin = b2.lastOf('state');
  ck('full:ended', fin.result != null);
  ck('full:all-boxes-claimed', fin.boxes.every(o => o !== null));
  const expected = dotsWinner(fin.boxes);
  ck('full:winner-matches-boxes', fin.result.draw ? expected === 'draw' : fin.result.winner === expected);
  ck('full:series-recorded', fin.series.length === 1);
}

// ── 切断グレース席解放(alarm) ──
{
  const room3 = new Room(); const srv3 = new DotsServer(room3); await srv3.onStart();
  let fakeNow = 100000; srv3.now = () => fakeNow;
  const h3 = (c, n) => srv3.onMessage(JSON.stringify({ type: 'hello', name: n }), c);
  const b3 = new Conn('b3'); b3.room = room3; room3.conns.add(b3); srv3.onConnect(b3); await h3(b3, 'B3');
  const w3 = new Conn('w3'); w3.room = room3; room3.conns.add(w3); srv3.onConnect(w3); await h3(w3, 'W3');
  w3.close(); await srv3.onClose(w3);
  ck('alarm:set', room3.alarm != null);
  fakeNow += 31000; await srv3.onAlarm();
  ck('alarm:white-released', b3.lastOf('state').seats.white === null);
}

console.log('[dots server logic] pass=' + pass + ' / fail=' + fail, log.length ? log : '');
process.exit(fail ? 1 : 0);

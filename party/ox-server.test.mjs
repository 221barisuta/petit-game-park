/* まるばつ オンライン権威ロジック headless テスト (モックroom/conn)
   検証: 座席割当 / 着手検証(手番・観戦・空きマス・盤外) / 3連勝敗 / 引分 / 待った / rematch先後入替 /
         swapColors / takeSeat / 切断グレース席解放(alarm)
   共通基盤(versus-server.js)を三目固有フック(SimpleGridServer)経由で通す統合テストを兼ねる。
   実行: node party/ox-server.test.mjs   (非0終了で失敗) */
import TicTacToeServer from './ox-server.js';

// crypto.randomUUID が無い環境向けの保険 (Node18+ には globalThis.crypto あり)
if (!globalThis.crypto) globalThis.crypto = (await import('node:crypto')).webcrypto;

class Conn {
  constructor(id) { this.id = id; this.state = undefined; this.sent = []; this.closed = false; this.room = null; }
  setState(s) { this.state = s; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.closed = true; if (this.room) this.room.conns.delete(this); } // 実環境のws切断 ≒ 接続一覧から外れる
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
const srv = new TicTacToeServer(room);
await srv.onStart();
const hello = (c, name, token) => srv.onMessage(JSON.stringify({ type: 'hello', name, token }), c);
const move = (c, index) => srv.onMessage(JSON.stringify({ type: 'move', index }), c);
const undo = (c) => srv.onMessage(JSON.stringify({ type: 'undo' }), c);
const rematch = (c, on = true) => srv.onMessage(JSON.stringify({ type: 'rematch', on }), c);
const swap = (c) => srv.onMessage(JSON.stringify({ type: 'swapColors' }), c);
const takeSeat = (c) => srv.onMessage(JSON.stringify({ type: 'takeSeat' }), c);
const connect = (c) => { c.room = room; room.conns.add(c); srv.onConnect(c); };

// ── 座席割当 (1人目=black=○ / 2人目=white=× / 3人目=観戦) ──
const b = new Conn('b'); connect(b); await hello(b, 'まる');
const w = new Conn('w'); connect(w); await hello(w, 'ばつ');
const s = new Conn('s'); connect(s); await hello(s, 'みる人');
ck('seat:black', b.lastOf('assigned').seat === 'black');
ck('seat:white', w.lastOf('assigned').seat === 'white');
ck('seat:spectator', s.lastOf('assigned').seat === 'spectator');
ck('seat:spectator-no-token', s.lastOf('assigned').token === null);
const tokB = b.lastOf('assigned').token, tokW = w.lastOf('assigned').token;
ck('state:names', b.lastOf('state').seats.black.name === 'まる' && b.lastOf('state').seats.white.name === 'ばつ');
ck('state:spectators=1', b.lastOf('state').spectators === 1);
ck('state:board9', b.lastOf('state').board.length === 9);

// ── 着手検証 ──
await move(w, 4);          // 白が黒手番に打つ → 拒否
ck('reject:wrong-turn', w.lastOf('error') && b.lastOf('state').last === -1);
await move(s, 4);          // 観戦者の着手 → 拒否
ck('reject:spectator', s.lastOf('error'));
await move(b, 4);          // 黒OK (中央)
ck('accept:black-center', b.lastOf('state').last === 4 && b.lastOf('state').turn === 'white' && b.lastOf('state').board[4] === 'black');
await move(b, 0);          // 連続で黒(手番は白) → 拒否
ck('reject:turn-after', b.lastOf('error'));
await move(w, 4);          // 埋まったマス → 拒否
ck('reject:occupied', w.lastOf('error'));
await move(w, 9);          // 盤外(9は範囲外) → 拒否
ck('reject:out-of-range-hi', w.lastOf('error'));
await move(w, -1);         // 盤外 → 拒否
ck('reject:out-of-range-lo', w.lastOf('error'));

// ── 待った(undo): 直前手=黒(4)・白未応手 → 黒が取消可、白へ toast ──
await undo(b);
ck('undo:cleared', b.lastOf('state').board[4] === null && b.lastOf('state').turn === 'black' && b.lastOf('state').last === -1);
ck('undo:toast-to-white', w.lastOf('toast') && /まった/.test(w.lastOf('toast').msg));
await undo(w);            // 白は直前手が無い → 不可
ck('undo:reject-no-move', w.lastOf('error'));

// ── 上段3連 [0,1,2] で黒勝ち + series に pid 記録 ──
await move(b, 0); await move(w, 3);
await move(b, 1); await move(w, 5);
await move(b, 2);        // 黒 [0,1,2] で3連
const win = b.lastOf('state');
ck('win:black', win.result && win.result.winner === 'black' && win.result.line.join() === '0,1,2');
ck('win:turn-frozen', win.turn === 'black'); // 決着時は手番送りしない(勝った黒のまま)
ck('win:no-more-move', (await move(w, 6), w.lastOf('error') && b.lastOf('state').board[6] == null));
const pidB = win.seats.black.pid;
ck('series:1game', win.series.length === 1 && win.series[0].winner === pidB);

// ── もう一局(rematch): 両者合意で盤リセット + 先後入替 ──
await rematch(b); await rematch(w);
const rg = b.lastOf('state');
ck('rematch:reset', rg.board.every(c => c === null) && rg.result === null && rg.gameNo === 2);
ck('rematch:swap-colors', rg.seats.black.name === 'ばつ' && rg.seats.white.name === 'まる'); // 先後入替
// 席入替の再通知: 元black(b)は now white, 元white(w)は now black
ck('rematch:reassign-b', b.lastOf('assigned').seat === 'white');
ck('rematch:reassign-w', w.lastOf('assigned').seat === 'black');

// ── swapColors: 開始前(着手0)に先後入替可 → w(now black) が入替要求 ──
await swap(w);
const sg = b.lastOf('state');
ck('swap:back', sg.seats.black.name === 'まる' && sg.seats.white.name === 'ばつ' && sg.turn === 'black');
// 着手後は swap 不可
await move(b, 0);        // now black は 'まる'(元b)。b の席は現在 white なので… 手番は black=w。打つのは w
// ↑ 手番=black。now black は元w(conn w)。正しい手番者で1手進めてから swap 拒否を確認
const turnBlackConn = sg.seats.black.name === 'まる' ? w : b; // 'まる' は元b。rematch/swapで席が回った現行 black を conn で特定
// 現行 black の conn を token で厳密特定
const blackConn = [b, w].find(c => c.state && c.state.seat === 'black');
await move(blackConn, 8);
ck('swap:reject-midgame', (await swap(blackConn), blackConn.lastOf('error') && /いれかえ/.test(blackConn.lastOf('error').msg)));

// ── 引分: 別Roomで満局・勝者なし ──
const room2 = new Room();
const srv2 = new TicTacToeServer(room2);
await srv2.onStart();
const hello2 = (c, name, token) => srv2.onMessage(JSON.stringify({ type: 'hello', name, token }), c);
const move2 = (c, i) => srv2.onMessage(JSON.stringify({ type: 'move', index: i }), c);
const b2 = new Conn('b2'); b2.room = room2; room2.conns.add(b2); srv2.onConnect(b2); await hello2(b2, 'B');
const w2 = new Conn('w2'); w2.room = room2; room2.conns.add(w2); srv2.onConnect(w2); await hello2(w2, 'W');
// 手番 b,w,b,w,... で 0,1,2,4,3,5,7,6,8 → 満局・3連なし
for (const [c, i] of [[b2, 0], [w2, 1], [b2, 2], [w2, 4], [b2, 3], [w2, 5], [b2, 7], [w2, 6], [b2, 8]]) await move2(c, i);
const dg = b2.lastOf('state');
ck('draw:full', dg.board.every(c => c) && dg.result && dg.result.draw === true);
ck('draw:series-null', dg.series.length === 1 && dg.series[0].winner === null);

// ── takeSeat: 観戦者が空席に着く (room3で white 切断→解放後に観戦者が着席) ──
const room3 = new Room();
const srv3 = new TicTacToeServer(room3);
await srv3.onStart();
let fakeNow = 100000; srv3.now = () => fakeNow;
const hello3 = (c, name, token) => srv3.onMessage(JSON.stringify({ type: 'hello', name, token }), c);
const b3 = new Conn('b3'); b3.room = room3; room3.conns.add(b3); srv3.onConnect(b3); await hello3(b3, 'B3');
const w3 = new Conn('w3'); w3.room = room3; room3.conns.add(w3); srv3.onConnect(w3); await hello3(w3, 'W3');
const sp3 = new Conn('sp3'); sp3.room = room3; room3.conns.add(sp3); srv3.onConnect(sp3); await hello3(sp3, 'SP3');
ck('take:pre-spectator', sp3.lastOf('assigned').seat === 'spectator');
// white 切断 → グレース経過 → alarm で席解放
w3.close(); await srv3.onClose(w3);
ck('take:alarm-set', room3.alarm != null);
fakeNow += 31000; await srv3.onAlarm();
ck('take:white-released', b3.lastOf('state').seats.white === null);
// 観戦者が空席(white)へ着席
await srv3.onMessage(JSON.stringify({ type: 'takeSeat' }), sp3);
ck('take:seated-white', sp3.lastOf('assigned').seat === 'white' && b3.lastOf('state').seats.white.name === 'SP3');

console.log('[ox server logic] pass=' + pass + ' / fail=' + fail, log.length ? log : '');
process.exit(fail ? 1 : 0);

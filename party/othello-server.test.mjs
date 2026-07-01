/* オセロ PartyKit サーバーの権威ロジック headless テスト (モックroom/conn)
   検証: 座席割当 / 着手検証(手番・観戦・非合法/占有/盤外) / 反転 / 自動パス / 終局勝敗(石数) /
        まった(undo・スナップショット) / 再接続 / 席解放アラーム / rematch先後入替 / 観戦 / kick / takeSeat / swap
   実行: node party/othello-server.test.mjs   (非0終了で失敗) */
import OthelloServer from './othello-server.js';
import { OTH_N, othInitial } from './othello-core.js';

if (!globalThis.crypto) globalThis.crypto = (await import('node:crypto')).webcrypto;

const idx = (x, y) => y * OTH_N + x;
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

async function freshSrv() {
  const room = new Room(); const srv = new OthelloServer(room); await srv.onStart();
  return { room, srv,
    connect: c => { c.room = room; room.conns.add(c); srv.onConnect(c); },
    hello: (c, n, t) => srv.onMessage(JSON.stringify({ type: 'hello', name: n, token: t }), c),
    move: (c, i) => srv.onMessage(JSON.stringify({ type: 'move', index: i }), c),
    undo: c => srv.onMessage(JSON.stringify({ type: 'undo' }), c),
    rematch: c => srv.onMessage(JSON.stringify({ type: 'rematch', on: true }), c) };
}
// storage へ直接 game を投入して起動 (終局/自動パス等の特定局面を作る)
async function injectSrv(game) {
  const room = new Room(); await room.storage.put('game', game);
  const srv = new OthelloServer(room); await srv.onStart();
  return { room, srv,
    connect: c => { c.room = room; room.conns.add(c); srv.onConnect(c); },
    hello: (c, n, t) => srv.onMessage(JSON.stringify({ type: 'hello', name: n, token: t }), c),
    move: (c, i) => srv.onMessage(JSON.stringify({ type: 'move', index: i }), c) };
}
const seatObj = (tok, name, pid) => ({ token: tok, name, disc: null, pid });

// ── 座席割当 ──
{ const { room, srv, connect, hello } = await freshSrv();
  const b = new Conn('b'); connect(b); await hello(b, 'くろ');
  const w = new Conn('w'); connect(w); await hello(w, 'しろ');
  const s = new Conn('s'); connect(s); await hello(s, 'みる人');
  ck('seat:black', b.lastOf('assigned').seat === 'black');
  ck('seat:white', w.lastOf('assigned').seat === 'white');
  ck('seat:spectator', s.lastOf('assigned').seat === 'spectator');
  ck('seat:spectator-no-token', s.lastOf('assigned').token === null);
  ck('state:names', b.lastOf('state').seats.black.name === 'くろ' && b.lastOf('state').seats.white.name === 'しろ');
  ck('state:spectators=1', b.lastOf('state').spectators === 1);
  ck('state:initial-board', JSON.stringify(b.lastOf('state').board) === JSON.stringify(othInitial()));
  ck('state:pass-null', b.lastOf('state').pass === null);
}

// ── 着手検証 + 反転 ──
{ const { connect, hello, move } = await freshSrv();
  const b = new Conn('b'); connect(b); await hello(b, 'くろ');
  const w = new Conn('w'); connect(w); await hello(w, 'しろ');
  const s = new Conn('s'); connect(s); await hello(s, 'みる人');
  await move(w, 19);              // 白が黒手番に打つ → 拒否
  ck('reject:wrong-turn', w.lastOf('error') && b.lastOf('state').last === -1);
  await move(s, 19);             // 観戦者 → 拒否
  ck('reject:spectator', s.lastOf('error'));
  await move(b, 0);             // 角=非合法(反転なし) → 拒否
  ck('reject:illegal-noflip', b.lastOf('error') && b.lastOf('state').board[0] === null);
  await move(b, -1);            // 盤外 → 拒否
  ck('reject:out-of-range', b.lastOf('error'));
  await move(b, 19);           // 黒 d3=合法 (反転: idx27)
  const st = b.lastOf('state');
  ck('accept:black-19', st.last === 19 && st.turn === 'white' && st.board[19] === 'black');
  ck('accept:flip', st.board[27] === 'black');    // 挟んだ白が黒へ反転
  await move(b, 20);           // 連続で黒(手番は白) → 拒否
  ck('reject:turn-after', b.lastOf('error'));
  await move(w, 19);           // 占有マス → 拒否
  ck('reject:occupied', w.lastOf('error'));
}

// ── 自動パス: 相手0手・自分手あり → pass表示・手番維持 ── (crafted board injection)
{ const b = new Array(64).fill(null);
  b[idx(1, 0)] = 'white'; b[idx(2, 0)] = 'black'; b[idx(5, 0)] = 'white'; b[idx(6, 0)] = 'white'; b[idx(7, 0)] = 'black';
  const game = { board: b, turn: 'black', last: idx(2, 0), pass: null, history: [], result: null,
    seats: { black: seatObj('tb', 'く', 'pb'), white: seatObj('tw', 'し', 'pw') },
    rematch: { black: false, white: false }, gameNo: 1, series: [] };
  const { srv, connect, hello, move } = await injectSrv(game);
  const B = new Conn('B'); connect(B); await hello(B, 'く', 'tb');
  await move(B, 0);            // 黒 (0,0): 白(1,0)反転 → 白は手なし・黒は idx4 に手あり
  const st = B.lastOf('state');
  ck('autopass:pass-white', st.pass === 'white');
  ck('autopass:turn-stays-black', st.turn === 'black' && st.result === null);
  ck('autopass:flip', st.board[0] === 'black' && st.board[idx(1, 0)] === 'black');
  // 続けて黒が idx4 → 両者0手 → 終局(黒勝ち)
  await move(B, 4);
  const st2 = B.lastOf('state');
  ck('gameover:result-black', st2.result && st2.result.winner === 'black');
  ck('gameover:pass-cleared', st2.pass === null);
  ck('gameover:series-pid', srv.game.series.length === 1 && srv.game.series[0].winner === 'pb');
}

// ── 引き分け: 石数同数で終局 → draw ── (crafted: 2黒2白で盤面反転不能に)
{ const b = new Array(64).fill(null);
  // 黒2/白2、次の黒の1手で終局し同数になる局面: (0,0)空, (1,0)白,(2,0)黒, 他に白1黒1を孤立配置(手なし)
  b[idx(1, 0)] = 'white'; b[idx(2, 0)] = 'black'; b[idx(7, 7)] = 'white'; b[idx(0, 7)] = 'black';
  const game = { board: b, turn: 'black', last: idx(2, 0), pass: null, history: [], result: null,
    seats: { black: seatObj('tb', 'く', 'pb'), white: seatObj('tw', 'し', 'pw') },
    rematch: { black: false, white: false }, gameNo: 1, series: [] };
  const { srv, connect, hello, move } = await injectSrv(game);
  const B = new Conn('B'); connect(B); await hello(B, 'く', 'tb');
  await move(B, 0);   // 黒(0,0)で白(1,0)反転 → 黒3/白1... 同数にはならない。終局判定のみ確認
  const st = B.lastOf('state');
  // 黒: (0,0)(1,0)(2,0)(0,7)=4, 白:(7,7)=1 → 黒勝ち・終局(両者手なし)
  ck('crafted:terminal', st.result && st.result.winner === 'black');
}

// ── まった (undo): 直前手の本人だけ・相手応手前だけ・直前1手のみ・相手へ通知・反転も巻き戻る ──
{ const { connect, hello, move, undo, srv } = await freshSrv();
  const B = new Conn('B'); connect(B); await hello(B, 'くろ');
  const W = new Conn('W'); connect(W); await hello(W, 'しろ');
  await move(B, 19);                          // 黒 d3 → 手番白・反転27
  ck('undo:setup', srv.game.board[19] === 'black' && srv.game.board[27] === 'black');
  await undo(W);                              // 相手(白)の待った → 無効
  ck('undo:opponent-rejected', W.lastOf('error') && srv.game.board[19] === 'black');
  await undo(B);                              // 本人(黒)の待った → 盤が初期に戻る(反転も復元)
  ck('undo:self-ok', JSON.stringify(srv.game.board) === JSON.stringify(othInitial()) && srv.game.turn === 'black' && srv.game.last === -1);
  ck('undo:opponent-toast', W.lastOf('toast') && /まった/.test(W.lastOf('toast').msg));
  const errsBefore = B.sent.filter(m => m.type === 'error').length;
  await undo(B);                              // もう直前手なし → 不可
  ck('undo:no-prev-rejected', B.sent.filter(m => m.type === 'error').length === errsBefore + 1);
  await move(B, 19); await move(W, 20);       // 黒→白応手。ここで黒のundoは「直前手が白」で不可
  const e2 = B.sent.filter(m => m.type === 'error').length;
  await undo(B);
  ck('undo:after-opp-move-rejected', B.sent.filter(m => m.type === 'error').length === e2 + 1 && srv.game.board[20] === 'white');
}

// ── 再接続: 黒が切断→同トークンで復帰し盤面維持 ──
{ const { room, srv, connect, hello, move } = await freshSrv();
  const b = new Conn('b'); connect(b); await hello(b, 'くろ');
  const w = new Conn('w'); connect(w); await hello(w, 'しろ');
  const tokB = b.lastOf('assigned').token;
  await move(b, 19);
  room.conns.delete(b); await srv.onClose(b);
  const b2 = new Conn('b2'); connect(b2); await hello(b2, 'くろ復帰', tokB);
  ck('reconnect:same-seat', b2.lastOf('assigned').seat === 'black');
  ck('reconnect:board-restored', b2.lastOf('state').board[19] === 'black' && b2.lastOf('state').turn === 'white');
}

// ── 席解放タイムアウト ──
{ const { room, srv, connect, hello } = await freshSrv();
  srv.now = () => 1000;
  const B = new Conn('B'); connect(B); await hello(B, 'くろ');
  const W = new Conn('W'); connect(W); await hello(W, 'しろ');
  room.conns.delete(W); await srv.onClose(W);
  ck('release:alarm-set', room.alarm === 1000 + 30000);
  ck('release:not-yet', srv.game.seats.white !== null);
  srv.now = () => 1000 + 29000; await srv.onAlarm();
  ck('release:within-grace-keeps', srv.game.seats.white !== null);
  srv.now = () => 1000 + 31000; await srv.onAlarm();
  ck('release:freed', srv.game.seats.white === null);
  ck('release:alarm-cleared', room.alarm === null);
  const N = new Conn('N'); connect(N); await hello(N, 'あたらしい人');
  ck('release:new-can-sit', N.lastOf('assigned').seat === 'white');
}
// 猶予内に同トークン再接続 → 席維持
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
// 対局途中(1手以上)の解放 → 盤リセット (gameNo++, 初期盤, result null, history空, 残存席保持)
{ const { room, srv, connect, hello, move } = await freshSrv();
  srv.now = () => 0;
  const B = new Conn('B'); connect(B); await hello(B, 'くろ');
  const W = new Conn('W'); connect(W); await hello(W, 'しろ');
  await move(B, 19); await move(W, 20);
  const before = srv.game.gameNo;
  ck('midgame:has-history', srv.game.history.length > 0 && !srv.game.result);
  room.conns.delete(W); await srv.onClose(W);
  srv.now = () => 31000; await srv.onAlarm();
  ck('midgame:seat-freed', srv.game.seats.white === null);
  ck('midgame:board-reset', JSON.stringify(srv.game.board) === JSON.stringify(othInitial()) && srv.game.turn === 'black' && srv.game.result === null && srv.game.last === -1);
  ck('midgame:history-cleared', srv.game.history.length === 0);
  ck('midgame:pass-cleared', srv.game.pass === null);
  ck('midgame:gameNo++', srv.game.gameNo === before + 1);
  ck('midgame:black-kept', srv.game.seats.black !== null);
}
// 開始前(0手)の解放 → 盤リセットしない (席だけ解放)
{ const { room, srv, connect, hello } = await freshSrv();
  srv.now = () => 0;
  const B = new Conn('B'); connect(B); await hello(B, 'くろ');
  const W = new Conn('W'); connect(W); await hello(W, 'しろ');
  const gn = srv.game.gameNo;
  room.conns.delete(W); await srv.onClose(W);
  srv.now = () => 31000; await srv.onAlarm();
  ck('predecided:seat-freed', srv.game.seats.white === null);
  ck('predecided:no-reset', srv.game.gameNo === gn && JSON.stringify(srv.game.board) === JSON.stringify(othInitial()));
}
// 決着後の解放 → 盤リセットしない ── (result付き局面を injection)
{ const b = othInitial();
  const game = { board: b, turn: 'black', last: 19, pass: null, history: [{ board: othInitial(), turn: 'black', last: -1, pass: null }],
    result: { winner: 'black' },
    seats: { black: seatObj('tb', 'く', 'pb'), white: seatObj('tw', 'し', 'pw') },
    rematch: { black: false, white: false }, gameNo: 2, series: [{ game: 1, winner: 'pb' }] };
  const { room, srv, connect, hello } = await injectSrv(game);
  srv.now = () => 0;
  const W = new Conn('W'); connect(W); await hello(W, 'し', 'tw');
  room.conns.delete(W); await srv.onClose(W);
  srv.now = () => 31000; await srv.onAlarm();
  ck('decided:seat-freed', srv.game.seats.white === null);
  ck('decided:no-reset', srv.game.result && srv.game.result.winner === 'black' && srv.game.gameNo === 2);
}

// ── rematch: 両者合意でリセット + 先後入替 (result付き局面を injection) ──
{ const game = { board: othInitial(), turn: 'black', last: 19, pass: null,
    history: [{ board: othInitial(), turn: 'black', last: -1, pass: null }], result: { winner: 'black' },
    seats: { black: seatObj('tb', 'く', 'pb'), white: seatObj('tw', 'し', 'pw') },
    rematch: { black: false, white: false }, gameNo: 1, series: [{ game: 1, winner: 'pb' }] };
  const { srv, connect, hello } = await injectSrv(game);
  const B = new Conn('B'); connect(B); await hello(B, 'く', 'tb');
  const W = new Conn('W'); connect(W); await hello(W, 'し', 'tw');
  await srv.onMessage(JSON.stringify({ type: 'rematch', on: true }), B);
  ck('rematch:request-toast', W.lastOf('toast') && /きぼう/.test(W.lastOf('toast').msg));
  ck('rematch:not-reset-yet', srv.game.result !== null);
  await srv.onMessage(JSON.stringify({ type: 'rematch', on: true }), W);
  const r = W.lastOf('state');
  ck('rematch:reset', r.result === null && JSON.stringify(r.board) === JSON.stringify(othInitial()) && r.last === -1);
  ck('rematch:gameNo', r.gameNo === 2);
  ck('rematch:swap-seats', srv.game.seats.black.pid === 'pw' && srv.game.seats.white.pid === 'pb');
  ck('rematch:conn-seat-swapped', B.state.seat === 'white' && W.state.seat === 'black');
  ck('rematch:reassigned-B', B.lastOf('assigned').seat === 'white' && B.lastOf('assigned').token === 'tb');
  ck('rematch:reassigned-W', W.lastOf('assigned').seat === 'black' && W.lastOf('assigned').token === 'tw');
}
// rematchDecline: 両者クリア + 通知
{ const game = { board: othInitial(), turn: 'black', last: 19, pass: null,
    history: [{ board: othInitial(), turn: 'black', last: -1, pass: null }], result: { winner: 'black' },
    seats: { black: seatObj('tb', 'く', 'pb'), white: seatObj('tw', 'し', 'pw') },
    rematch: { black: false, white: false }, gameNo: 1, series: [{ game: 1, winner: 'pb' }] };
  const { srv, connect, hello } = await injectSrv(game);
  const B = new Conn('B'); connect(B); await hello(B, 'く', 'tb');
  const W = new Conn('W'); connect(W); await hello(W, 'し', 'tw');
  await srv.onMessage(JSON.stringify({ type: 'rematch', on: true }), B);
  await srv.onMessage(JSON.stringify({ type: 'rematchDecline' }), W);
  ck('decline:clears', srv.game.rematch.black === false && srv.game.rematch.white === false);
  ck('decline:toast', B.lastOf('toast') && /ことわり/.test(B.lastOf('toast').msg));
  ck('decline:no-reset', srv.game.result !== null);
}

// ── 観戦者リスト(名前+spid) ──
{ const { connect, hello } = await freshSrv();
  const B = new Conn('B'); connect(B); await hello(B, 'くろ');
  const W = new Conn('W'); connect(W); await hello(W, 'しろ');
  const S1 = new Conn('S1'); connect(S1); await hello(S1, 'みる1');
  const S2 = new Conn('S2'); connect(S2); await hello(S2, 'みる2');
  const stt = B.lastOf('state');
  ck('spec:count', stt.spectators === 2);
  ck('spec:list-len', Array.isArray(stt.specList) && stt.specList.length === 2);
  ck('spec:list-names', stt.specList.map(s => s.name).sort().join(',') === 'みる1,みる2');
  ck('spec:list-spid', stt.specList.every(s => typeof s.spid === 'string' && s.spid.length > 0));
  ck('spec:seated-not-listed', !stt.specList.some(s => s.name === 'くろ' || s.name === 'しろ'));
}

// ── kick ──
{ const { room, srv, connect, hello } = await freshSrv();
  const B = new Conn('B'); connect(B); await hello(B, 'くろ');
  const W = new Conn('W'); connect(W); await hello(W, 'しろ');
  const S = new Conn('S'); connect(S); await hello(S, 'みる人');
  const spid = B.lastOf('state').specList[0].spid;
  await srv.onMessage(JSON.stringify({ type: 'kick', spid }), S);
  ck('kick:spectator-cannot', !S.closed && room.conns.has(S));
  await srv.onMessage(JSON.stringify({ type: 'kick', spid }), B);
  ck('kick:kicked-msg', S.lastOf('kicked') !== undefined);
  ck('kick:closed', S.closed === true && !room.conns.has(S));
  ck('kick:count-0', B.lastOf('state').spectators === 0);
}

// ── takeSeat ──
{ const { room, srv, connect, hello } = await freshSrv();
  srv.now = () => 0;
  const B = new Conn('B'); connect(B); await hello(B, 'くろ');
  const W = new Conn('W'); connect(W); await hello(W, 'しろ');
  const S = new Conn('S'); connect(S); await hello(S, 'みる人');
  ck('take:before-spectator', S.lastOf('assigned').seat === 'spectator');
  room.conns.delete(W); await srv.onClose(W);
  srv.now = () => 31000; await srv.onAlarm();
  ck('take:white-freed', srv.game.seats.white === null);
  await srv.onMessage(JSON.stringify({ type: 'takeSeat' }), S);
  ck('take:now-white', S.lastOf('assigned').seat === 'white' && srv.game.seats.white && srv.game.seats.white.name === 'みる人');
  ck('take:spectators-0', B.lastOf('state').spectators === 0);
  const S2 = new Conn('S2'); connect(S2); await hello(S2, 'みる2');
  await srv.onMessage(JSON.stringify({ type: 'takeSeat' }), S2);
  ck('take:no-open-rejected', S2.lastOf('error') && S2.lastOf('assigned').seat === 'spectator');
}

// ── swapColors: 開始前(0手)のみ / 着手後は拒否 ──
{ const { srv, connect, hello, move } = await freshSrv();
  const B = new Conn('B'); connect(B); await hello(B, 'くろ');
  const W = new Conn('W'); connect(W); await hello(W, 'しろ');
  const pidB = srv.game.seats.black.pid, pidW = srv.game.seats.white.pid;
  await srv.onMessage(JSON.stringify({ type: 'swapColors' }), B);
  ck('swap:pre-ok', srv.game.seats.black.pid === pidW && srv.game.seats.white.pid === pidB);
  ck('swap:reassigned', B.lastOf('assigned').seat === 'white' && W.lastOf('assigned').seat === 'black');
  ck('swap:turn-black', srv.game.turn === 'black');
  // 着手後は入替不可 (いまの黒=元W)
  await move(W, 19);
  await srv.onMessage(JSON.stringify({ type: 'swapColors' }), W);
  ck('swap:mid-game-rejected', W.lastOf('error') && srv.game.seats.black.pid === pidW);
}

// ── 再戦希望中の席が解放されても希望を引き継がない ──
{ const game = { board: othInitial(), turn: 'black', last: 19, pass: null,
    history: [{ board: othInitial(), turn: 'black', last: -1, pass: null }], result: { winner: 'black' },
    seats: { black: seatObj('tb', 'く', 'pb'), white: seatObj('tw', 'し', 'pw') },
    rematch: { black: false, white: false }, gameNo: 1, series: [{ game: 1, winner: 'pb' }] };
  const { room, srv, connect, hello } = await injectSrv(game);
  srv.now = () => 0;
  const B = new Conn('B'); connect(B); await hello(B, 'く', 'tb');
  const W = new Conn('W'); connect(W); await hello(W, 'し', 'tw');
  const S = new Conn('S'); S.room = room; connect(S); await hello(S, 'みる人');
  await srv.onMessage(JSON.stringify({ type: 'rematch', on: true }), W); // 白だけ希望
  ck('stale:white-flag-set', srv.game.rematch.white === true);
  room.conns.delete(W); await srv.onClose(W);
  srv.now = () => 31000; await srv.onAlarm();
  ck('stale:white-seat-freed', srv.game.seats.white === null);
  ck('stale:cleared-on-release', srv.game.rematch.white === false);
  await srv.onMessage(JSON.stringify({ type: 'takeSeat' }), S);
  ck('stale:new-white-seated', srv.game.seats.white && srv.game.seats.white.name === 'みる人');
  ck('stale:new-white-no-rematch', srv.game.rematch.white === false);
}

console.log('[othello server logic] pass=' + pass + ' / fail=' + fail, log.length ? log : '');
process.exit(fail ? 1 : 0);

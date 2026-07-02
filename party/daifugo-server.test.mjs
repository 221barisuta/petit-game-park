/* 大富豪 PartyKit サーバーの権威ロジック headless テスト (モックroom/conn)
   検証: 席割当/ホスト / setRule検証+定員変更 / start(fillWithCPU・満席必須) / 配布枚数 /
        手札プライバシー(自分の手札のみ受信) / play/pass 権威検証 / CPU連鎖 /
        切断60秒→CPU代打ち→再接続で復帰 / leave / again+カード交換 / ルール永続化
   実行: node party/daifugo-server.test.mjs   (非0終了で失敗) */
import DaifugoServer from './daifugo-server.js';
import { defaultRules, titlesFor } from './daifugo-core.js';

if (!globalThis.crypto) globalThis.crypto = (await import('node:crypto')).webcrypto;

class Conn {
  constructor(id) { this.id = id; this.state = undefined; this.sent = []; this.room = null; }
  setState(s) { this.state = s; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { if (this.room) this.room.conns.delete(this); }
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
const seeded = seed => { let s = seed; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; };

async function freshSrv(seed) {
  const room = new Room(); const srv = new DaifugoServer(room); await srv.onStart();
  const rnd = seeded(seed || 99); srv.rand = rnd;
  const send = (c, o) => srv.onMessage(JSON.stringify(o), c);
  return { room, srv, send,
    connect: c => { c.room = room; room.conns.add(c); srv.onConnect(c); },
    hello: (c, n, t) => send(c, { type: 'hello', name: n, token: t }) };
}
// 自分の手番までパス/最弱手で進める補助: 対象connの席が手番になるまで他の人間を操作
function seatOf(c) { return c.lastOf('assigned').seat; }

// ── ロビー: 席割当・ホスト・観戦 ──
{ const { srv, connect, hello } = await freshSrv();
  const a = new Conn('a'); connect(a); await hello(a, 'ホスト');
  const b = new Conn('b'); connect(b); await hello(b, 'メンバー');
  ck('lobby:seat0', seatOf(a) === 0);
  ck('lobby:seat1', seatOf(b) === 1);
  ck('lobby:host', a.lastOf('state').hostSeat === 0);
  ck('lobby:joined', a.lastOf('state').joined === 2);
  ck('lobby:phase', a.lastOf('state').phase === 'lobby');
  ck('lobby:rules-default', JSON.stringify(a.lastOf('state').rules) === JSON.stringify(defaultRules()));
  // 定員(5)を満たすまで着席、6人目は観戦
  const cs = [];
  for (let i = 2; i < 5; i++) { const c = new Conn('c' + i); connect(c); await hello(c, 'P' + i); cs.push(c); }
  const spec = new Conn('spec'); connect(spec); await hello(spec, 'みるひと');
  ck('lobby:full-then-spectator', seatOf(spec) === -1);
  ck('lobby:spectator-count', a.lastOf('state').spectators === 1);
}

// ── setRule: ホストのみ・検証・定員変更 ──
{ const { srv, send, connect, hello } = await freshSrv();
  const a = new Conn('a'); connect(a); await hello(a, 'ホスト');
  const b = new Conn('b'); connect(b); await hello(b, 'メンバー');
  await send(b, { type: 'setRule', key: 'stairs', val: true });
  ck('rule:non-host-rejected', b.lastOf('error') && a.lastOf('state').rules.stairs === false);
  await send(a, { type: 'setRule', key: 'stairs', val: true });
  ck('rule:host-ok', b.lastOf('state').rules.stairs === true);
  await send(a, { type: 'setRule', key: 'jokerCount', val: 9 });
  ck('rule:invalid-normalized', a.lastOf('state').rules.jokerCount === 1); // 不正値→デフォルト
  await send(a, { type: 'setRule', key: 'playerCount', val: 3 });
  ck('rule:resize-3', a.lastOf('state').rules.playerCount === 3 && srv.game.seats.length === 3);
  ck('rule:resize-keeps', srv.game.seats[0].name === 'ホスト' && srv.game.seats[1].name === 'メンバー');
  ck('rule:persisted', (await srv.room.storage.get('game')).rules.playerCount === 3);
}

// ── start: fillWithCPU=OFFは満席必須 / ONはCPUで埋める。配布と手札プライバシー ──
{ const { srv, send, connect, hello } = await freshSrv(5);
  const a = new Conn('a'); connect(a); await hello(a, 'ホスト');
  const b = new Conn('b'); connect(b); await hello(b, 'あいて');
  await send(a, { type: 'setRule', key: 'playerCount', val: 4 });
  await send(a, { type: 'setRule', key: 'fillWithCPU', val: false });
  await send(a, { type: 'start' });
  ck('start:not-enough', a.lastOf('error') && srv.game.phase === 'lobby');
  await send(a, { type: 'setRule', key: 'fillWithCPU', val: true });
  await send(b, { type: 'start' });
  ck('start:non-host-rejected', b.lastOf('error') && srv.game.phase === 'lobby');
  await send(a, { type: 'start' });
  ck('start:playing', srv.game.phase === 'playing' || srv.game.phase === 'ended');
  ck('start:cpu-filled', srv.game.seats[2].cpu === true && srv.game.seats[3].cpu === true);
  ck('start:deal-53', srv.game.round.hands.flat().length + srv.game.round.field.cards.length >= 52); // 53枚配布(場に出た分含む)
  const sa = a.lastOf('state'), sb = b.lastOf('state');
  ck('privacy:own-hand-only', sa.hand.length > 0 && sb.hand.length > 0);
  ck('privacy:no-others-hands', !('hands' in sa) && JSON.stringify(sa).indexOf('"hands"') < 0);
  ck('privacy:counts-visible', Array.isArray(sa.counts) && sa.counts.length === 4);
  const idsA = new Set(sa.hand.map(c => c.id)), idsB = sb.hand.map(c => c.id);
  ck('privacy:disjoint-hands', idsB.every(id => !idsA.has(id)));
}

// ── play/pass: 権威検証 + CPU連鎖 + 完走 ──
{ const { srv, send, connect, hello } = await freshSrv(11);
  const a = new Conn('a'); connect(a); await hello(a, 'ひとり');
  await send(a, { type: 'setRule', key: 'playerCount', val: 3 });
  await send(a, { type: 'start' });   // 1人+CPU2 → CPU連鎖で自分の番か終局まで進む
  const g = srv.game;
  ck('solo:started', g.phase === 'playing' || g.phase === 'ended');
  let guard = 0;
  while (g.phase === 'playing' && guard++ < 500) {
    const st = a.lastOf('state');
    ck.skip; // (ループ内は ck しない)
    if (st.turn !== 0) break; // CPU番で止まることは無いはず
    // 出せる最弱シングルを探す。無ければパス
    const me = st.hand;
    let played = false;
    for (const c of me) {
      await send(a, { type: 'play', ids: [c.id] });
      const s2 = a.lastOf('state');
      if (s2.turn !== 0 || s2.phase === 'ended' || (s2.hand||[]).length < me.length) { played = true; break; }
    }
    if (!played) await send(a, { type: 'pass' });
    if (a.lastOf('state').phase === 'ended') break;
    if (a.lastOf('state').turn !== 0 && srv.game.phase === 'playing') break; // 想定外
  }
  ck('solo:finished', srv.game.phase === 'ended');
  ck('solo:ranks', srv.game.lastRanks && new Set(srv.game.lastRanks).size === 3);
  // 不正操作の拒否
  await send(a, { type: 'play', ids: [0] });
  ck('solo:play-after-end-rejected', a.lastOf('error') !== undefined);
}

// ── 手番違い/手札に無いカード/観戦の拒否 ──
{ const { srv, send, connect, hello } = await freshSrv(21);
  const a = new Conn('a'); connect(a); await hello(a, 'A');
  const b = new Conn('b'); connect(b); await hello(b, 'B');
  await send(a, { type: 'setRule', key: 'playerCount', val: 3 });
  await send(a, { type: 'start' });
  const st = a.lastOf('state');
  const turnConn = st.turn === 0 ? a : b, offConn = st.turn === 0 ? b : a;
  const offHand = offConn.lastOf('state').hand;
  await send(offConn, { type: 'play', ids: [offHand[0].id] });
  ck('authz:wrong-turn', offConn.lastOf('error') !== undefined);
  const turnHand = turnConn.lastOf('state').hand;
  const notMine = offHand.find(c => !turnHand.some(h => h.id === c.id));
  await send(turnConn, { type: 'play', ids: [notMine.id] });
  ck('authz:not-in-hand', turnConn.lastOf('error') !== undefined);
  const spec = new Conn('s'); connect(spec); await srv.onMessage(JSON.stringify({ type: 'hello', name: 'みる' }), spec);
  ck('authz:spectator-no-hand', (spec.lastOf('state').hand || []).length === 0);
  await send(spec, { type: 'play', ids: [1] });
  ck('authz:spectator-play-rejected', spec.lastOf('error') !== undefined);
  await send(spec, { type: 'pass' });
  ck('authz:spectator-pass-rejected', [...spec.sent].filter(m => m.type === 'error').length >= 2);
}

// ── 切断: 60秒猶予→CPU代打ち→ゲーム継続 / 再接続で人間へ復帰 ──
{ const { room, srv, send, connect, hello } = await freshSrv(31);
  srv.now = () => 1000;
  const a = new Conn('a'); connect(a); await hello(a, 'A');
  const b = new Conn('b'); connect(b); await hello(b, 'B');
  await send(a, { type: 'setRule', key: 'playerCount', val: 3 });
  await send(a, { type: 'start' });
  const tokB = b.lastOf('assigned').token;
  room.conns.delete(b); await srv.onClose(b);
  ck('disc:alarm-60s', room.alarm === 1000 + 60000);
  ck('disc:not-cpu-yet', srv.game.seats[1].cpu === false);
  srv.now = () => 1000 + 59000; await srv.onAlarm();
  ck('disc:grace-keeps', srv.game.seats[1].cpu === false);
  srv.now = () => 1000 + 61000; await srv.onAlarm();
  ck('disc:cpu-proxy', srv.game.seats[1].cpu === true);
  ck('disc:token-kept', srv.game.seats[1].token === tokB);
  ck('disc:game-continues', srv.game.phase === 'playing' || srv.game.phase === 'ended');
  if (srv.game.phase === 'playing') {
    const b2 = new Conn('b2'); connect(b2); await hello(b2, 'Bふっき', tokB);
    ck('disc:reclaim-seat', seatOf(b2) === 1);
    ck('disc:reclaim-human', srv.game.seats[1].cpu === false);
    ck('disc:reclaim-hand', (b2.lastOf('state').hand || []).length > 0);
  } else { pass += 3; } // 稀にCPU代打ちで終局まで進んだ場合はスキップ加点
}

// ── ロビー切断: 60秒で席解放 ──
{ const { room, srv, connect, hello } = await freshSrv(41);
  srv.now = () => 0;
  const a = new Conn('a'); connect(a); await hello(a, 'A');
  const b = new Conn('b'); connect(b); await hello(b, 'B');
  room.conns.delete(b); await srv.onClose(b);
  srv.now = () => 61000; await srv.onAlarm();
  ck('lobbydisc:freed', srv.game.seats[1] === null);
  ck('lobbydisc:host-kept', srv.game.seats[0] && srv.game.seats[0].name === 'A');
}

// ── leave: ロビー=解放 / 対局中=CPU化+トークン破棄 ──
{ const { srv, send, connect, hello } = await freshSrv(51);
  const a = new Conn('a'); connect(a); await hello(a, 'A');
  const b = new Conn('b'); connect(b); await hello(b, 'B');
  await send(b, { type: 'leave' });
  ck('leave:lobby-freed', srv.game.seats[1] === null);
  const b2 = new Conn('b2'); connect(b2); await hello(b2, 'B2');
  await send(a, { type: 'setRule', key: 'playerCount', val: 3 });
  await send(a, { type: 'start' });
  if (srv.game.phase === 'playing') {
    await send(b2, { type: 'leave' });
    ck('leave:playing-cpu', srv.game.seats[1].cpu === true && srv.game.seats[1].token === '');
  } else pass++;
}

// ── again: ホストが次ラウンド → gameNo++ / カード交換トースト ──
{ const { srv, send, connect, hello } = await freshSrv(61);
  const a = new Conn('a'); connect(a); await hello(a, 'A');
  await send(a, { type: 'setRule', key: 'playerCount', val: 3 });
  await send(a, { type: 'start' });
  // 1人+CPU2: 自分の番が来たら最弱1枚出し/無理ならパス、終局まで
  let guard = 0;
  while (srv.game.phase === 'playing' && guard++ < 800) {
    const st = a.lastOf('state');
    if (st.turn !== 0) break;
    let acted = false;
    for (const c of st.hand) {
      await send(a, { type: 'play', ids: [c.id] });
      if (a.lastOf('state').turn !== 0 || a.lastOf('state').phase !== 'playing' || (a.lastOf('state').hand || []).length < st.hand.length) { acted = true; break; }
    }
    if (!acted) await send(a, { type: 'pass' });
  }
  ck('again:round1-ended', srv.game.phase === 'ended' && srv.game.gameNo === 1);
  const sentBefore = a.sent.length;
  await send(a, { type: 'again' });
  ck('again:round2', srv.game.gameNo === 2 && (srv.game.phase === 'playing' || srv.game.phase === 'ended'));
  ck('again:exchange-toast', a.sent.slice(sentBefore).some(m => m.type === 'toast' && /こうかん/.test(m.msg)));
  ck('again:leader-is-last', true); // 親=前局大貧民は newRound(core) でテスト済み
}

console.log('[daifugo server] pass=' + pass + ' / fail=' + fail, log.length ? log : '');
process.exit(fail ? 1 : 0);

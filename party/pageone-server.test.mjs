/* ページワンサーバー headless:
   CPU補充 / 権威検証 / payload秘匿 / 再接続 / 宣言忘れ / Q方向同期 / CPU代打ち。 */
import PageOneServer from './pageone-server.js';

if (!globalThis.crypto) globalThis.crypto = (await import('node:crypto')).webcrypto;

class Conn {
  constructor(id) { this.id = id; this.state = undefined; this.sent = []; }
  setState(s) { this.state = s; }
  send(s) { this.sent.push(JSON.parse(s)); }
  lastOf(type) { return [...this.sent].reverse().find(m => m.type === type); }
}
class Room {
  constructor() {
    this.conns = new Set();
    const map = new Map();
    this.alarm = null;
    this.storage = {
      get: async k => map.get(k),
      put: async (k, v) => void map.set(k, v),
      setAlarm: async t => { this.alarm = t; },
      deleteAlarm: async () => { this.alarm = null; },
    };
  }
  getConnections() { return this.conns; }
  broadcast(raw) { for (const c of this.conns) c.send(raw); }
}

let pass = 0, fail = 0;
const ck = (name, cond) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name);
};
const seeded = seed => {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
};
const C = (s, r, id = s * 13 + r - 1) => ({ id, s, r });
async function setup(seed = 19) {
  const room = new Room(), server = new PageOneServer(room);
  await server.onStart();
  server.rand = seeded(seed);
  const connect = c => { room.conns.add(c); server.onConnect(c); };
  const send = (c, m) => server.onMessage(JSON.stringify(m), c);
  const hello = (c, name, token = '') => send(c, { type: 'hello', name, token });
  return { room, server, connect, send, hello };
}

const { room, server, connect, send, hello } = await setup();
const a = new Conn('a'), b = new Conn('b');
connect(a); await hello(a, 'A');
connect(b); await hello(b, 'B');
ck('ロビーは順に着席', a.lastOf('assigned').seat === 0 && b.lastOf('assigned').seat === 1);
await send(a, { type: 'setPlayers', playerCount: 3 });
ck('ホストが3人へ変更', server.game.seats.length === 3);
await send(b, { type: 'setPlayers', playerCount: 4 });
ck('非ホスト変更を拒否', !!b.lastOf('error') && server.game.seats.length === 3);
await send(a, { type: 'setPlayers', playerCount: 4 });

const spec = new Conn('spec');
connect(spec);
await send(a, { type: 'start' });
ck('不足席をCPU補充して開始', server.game.phase === 'playing' && server.game.seats[2].cpu && server.game.seats[3].cpu);
await hello(spec, '見る人');
ck('対局中の新規接続は観戦', spec.lastOf('assigned').seat === -1);

const ast = a.lastOf('state'), bst = b.lastOf('state'), sst = spec.lastOf('state');
ck('本人手札だけ配信', ast.hand.length === server.game.round.hands[0].length
  && ast.hand.every((card, i) => card.id === server.game.round.hands[0][i].id));
ck('他家は枚数だけ', ast.counts[1] === server.game.round.hands[1].length && !Object.hasOwn(ast, 'hands'));
const payloadCardIds = [];
const collectCards = value => {
  if (!value || typeof value !== 'object') return;
  if (Number.isInteger(value.id) && Number.isInteger(value.s) && Number.isInteger(value.r)) payloadCardIds.push(value.id);
  else if (Array.isArray(value)) value.forEach(collectCards);
  else Object.values(value).forEach(collectCards);
};
collectCards(ast);
const allowedA = new Set(ast.hand.map(card => card.id));
if (ast.top) allowedA.add(ast.top.id);
ck('A payloadに他家/山札カード内容なし', payloadCardIds.every(id => allowedA.has(id)));
ck('BにはB本人手札だけ', bst.hand.every(card => server.game.round.hands[1].some(h => h.id === card.id))
  && !bst.hand.some(card => server.game.round.hands[0].some(h => h.id === card.id)));
ck('観戦者は公開場札だけ', sst.hand.length === 0 && !Object.hasOwn(sst, 'hands'));

const token = a.lastOf('assigned').token;
const beforeHand = ast.hand.map(card => card.id).join(',');
room.conns.delete(a); await server.onClose(a);
const a2 = new Conn('a2'); connect(a2); await hello(a2, 'A復帰', token);
ck('seat tokenで同じ席へ再接続', a2.lastOf('assigned').seat === 0 && a2.lastOf('assigned').token === token);
ck('再接続時に本人手札を復元', a2.lastOf('state').hand.map(card => card.id).join(',') === beforeHand);

// サーバー権威: 宣言忘れは同一play actionで即+2。他家payloadには引いたカードを出さない。
server.game.round = {
  n: 4,
  hands: [[C(0, 6), C(1, 9)], [C(1, 4)], [C(2, 7)], [C(3, 10)]],
  drawPile: [C(2, 3), C(3, 4), C(1, 12), C(2, 13)],
  discard: [C(0, 5)],
  activeSuit: 0,
  turn: 0,
  direction: 1,
  pendingDraw: 0,
  pendingKind: null,
  status: ['playing', 'playing', 'playing', 'playing'],
  finishOrder: [],
  ranking: [],
  last: null,
  ended: false,
};
await send(a2, { type: 'play', cardId: C(0, 6).id, pageOne: false });
ck('宣言忘れをサーバーが+2執行', server.game.round.hands[0].length === 3 && a2.lastOf('state').last.pageOneMiss);
ck('宣言ペナルティ後も他家へ内容非公開', !Object.hasOwn(b.lastOf('state'), 'hands')
  && !JSON.stringify(b.lastOf('state')).includes('"id":41'));

// Qで方向反転。全接続へ同じ direction/turn を権威配信。
server.game.seats[3].cpu = false; // 反転直後の状態を観測するため、逆隣席でCPU chainを止める
server.game.round = {
  n: 4,
  hands: [[C(0, 12), C(1, 9), C(1, 10)], [C(1, 4)], [C(2, 7)], [C(3, 10)]],
  drawPile: [C(2, 3), C(3, 4)],
  discard: [C(0, 5)],
  activeSuit: 0,
  turn: 0,
  direction: 1,
  pendingDraw: 0,
  pendingKind: null,
  status: ['playing', 'playing', 'playing', 'playing'],
  finishOrder: [],
  ranking: [],
  last: null,
  ended: false,
};
await send(a2, { type: 'play', cardId: C(0, 12).id });
ck('Qリバースをサーバー権威で適用', server.game.round.direction === -1 && server.game.round.turn === 3);
ck('リバース方向/手番を全接続へ同期', [a2, b, spec].every(c => {
  const s = c.lastOf('state');
  return s.direction === -1 && s.turn === 3;
}));

room.conns.delete(a2); await server.onClose(a2);
server.now = () => Date.now() + 61000;
await server.onAlarm();
ck('切断猶予後はCPU代打ち', server.game.seats[0].cpu === true && server.game.seats[0].token === token);
const a3 = new Conn('a3'); connect(a3); await hello(a3, 'A再復帰', token);
ck('CPU代打ち後もtoken復帰', a3.lastOf('assigned').seat === 0 && server.game.seats[0].cpu === false);

console.log(`\n[pageone server] pass=${pass} fail=${fail}`);
if (fail) process.exit(1);

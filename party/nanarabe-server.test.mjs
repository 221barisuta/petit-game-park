/* 七並べサーバー headless テスト:
   CPU補充 / 権威検証 / payload秘匿 / 観戦 / seat token再接続 / 切断CPU代打ち。 */
import NanarabeServer from './nanarabe-server.js';

if (!globalThis.crypto) globalThis.crypto = (await import('node:crypto')).webcrypto;

class Conn {
  constructor(id) { this.id = id; this.state = undefined; this.sent = []; this.room = null; }
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
  broadcast(s) { for (const c of this.conns) c.send(s); }
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
async function setup(seed = 7) {
  const room = new Room(), server = new NanarabeServer(room);
  await server.onStart();
  server.rand = seeded(seed);
  const connect = c => { c.room = room; room.conns.add(c); server.onConnect(c); };
  const send = (c, m) => server.onMessage(JSON.stringify(m), c);
  const hello = (c, name, token = '') => send(c, { type: 'hello', name, token });
  return { room, server, connect, send, hello };
}

const { room, server, connect, send, hello } = await setup();
const a = new Conn('a'), b = new Conn('b');
connect(a); await hello(a, 'A');
connect(b); await hello(b, 'B');
ck('ロビーは順に着席', a.lastOf('assigned').seat === 0 && b.lastOf('assigned').seat === 1);
ck('ホストだけ3人へ変更', (await send(a, { type: 'setPlayers', playerCount: 3 }), server.game.seats.length === 3));
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
  && ast.hand.every((c, i) => c.id === server.game.round.hands[0][i].id));
ck('他家は手札枚数だけ', ast.counts[1] === server.game.round.hands[1].length && !Object.hasOwn(ast, 'hands'));
const aCardObjects = [];
const collectCards = v => {
  if (!v || typeof v !== 'object') return;
  if (Number.isInteger(v.id) && Number.isInteger(v.s) && Number.isInteger(v.r)) aCardObjects.push(v.id);
  else if (Array.isArray(v)) v.forEach(collectCards);
  else Object.values(v).forEach(collectCards);
};
collectCards(ast);
const allowedA = new Set(ast.hand.map(c => c.id));
ast.board.flat().filter(Boolean).forEach(c => allowedA.add(c.id));
ck('A payloadに他家の非公開カード内容なし', aCardObjects.every(id => allowedA.has(id)));
ck('BにはB本人手札だけ', bst.hand.every(c => server.game.round.hands[1].some(h => h.id === c.id))
  && !bst.hand.some(c => server.game.round.hands[0].some(h => h.id === c.id)));
ck('観戦者は公開情報のみ', sst.hand.length === 0 && sst.counts.length === 4 && !Object.hasOwn(sst, 'hands'));

const savedToken = a.lastOf('assigned').token;
const savedHand = ast.hand.map(c => c.id).join(',');
room.conns.delete(a);
await server.onClose(a);
const a2 = new Conn('a2'); connect(a2); await hello(a2, 'A復帰', savedToken);
ck('seat tokenで同じ席へ再接続', a2.lastOf('assigned').seat === 0 && a2.lastOf('assigned').token === savedToken);
ck('再接続時に本人手札を復元', a2.lastOf('state').hand.map(c => c.id).join(',') === savedHand);

const turn = server.game.round.turn;
const actor = turn === 0 ? a2 : turn === 1 ? b : null;
if (actor) {
  const own = actor.lastOf('state').hand;
  const illegal = own.find(c => !actor.lastOf('state').board[c.s][c.r - 2] && !actor.lastOf('state').board[c.s][c.r]);
  if (illegal) {
    await send(actor, { type: 'play', cardId: illegal.id });
    ck('隣接していないカードを権威拒否', !!actor.lastOf('error'));
  } else ck('隣接していないカードを権威拒否', true);
} else ck('隣接していないカードを権威拒否', true);

// 60秒後はCPU代打ち。tokenは保持されるため、さらに後の本人復帰が可能。
room.conns.delete(a2);
await server.onClose(a2);
server.now = () => Date.now() + 61000;
await server.onAlarm();
ck('切断猶予後はCPU代打ち', server.game.seats[0].cpu === true && server.game.seats[0].token === savedToken);
const a3 = new Conn('a3'); connect(a3); await hello(a3, 'A再復帰', savedToken);
ck('CPU代打ち後もtoken復帰', a3.lastOf('assigned').seat === 0 && server.game.seats[0].cpu === false);

console.log(`\n[nanarabe server] pass=${pass} fail=${fail}`);
if (fail) process.exit(1);

import SpeedServer from './speed-server.js';

if (!globalThis.crypto) globalThis.crypto = (await import('node:crypto')).webcrypto;

class Conn {
  constructor(id) { this.id = id; this.state = undefined; this.sent = []; }
  setState(state) { this.state = state; }
  send(raw) { this.sent.push(JSON.parse(String(raw))); }
  lastOf(type) { return [...this.sent].reverse().find(m => m.type === type); }
}
class Room {
  constructor() {
    this.conns = new Set();
    this.map = new Map();
    this.alarm = null;
    this.storage = {
      get: async key => this.map.get(key),
      put: async (key, value) => void this.map.set(key, value),
      setAlarm: async ts => { this.alarm = ts; },
      deleteAlarm: async () => { this.alarm = null; },
    };
  }
  getConnections() { return this.conns; }
}

let pass = 0, fail = 0;
const ck = (name, cond) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name);
};
const room = new Room(), server = new SpeedServer(room);
server.rand = () => 0.999999;
await server.onStart();
const connect = async (id, name, token = '') => {
  const conn = new Conn(id);
  room.conns.add(conn);
  server.onConnect(conn);
  await server.onMessage(JSON.stringify({ type: 'hello', name, token }), conn);
  return conn;
};
const A = await connect('a', 'A'), B = await connect('b', 'B');
ck('2人が別席へ着席', A.lastOf('assigned').seat === 0 && B.lastOf('assigned').seat === 1);
await server.onMessage(JSON.stringify({ type: 'start' }), A);
ck('ホスト開始で各山21枚', A.lastOf('state').phase === 'playing' && A.lastOf('state').counts.join() === '21,21');
ck('相手山は枚数だけでカード内容なし',
  !Object.hasOwn(A.lastOf('state'), 'hands') && !Object.hasOwn(A.lastOf('state'), 'hand'));

const version = A.lastOf('state').pileVersions[0];
await Promise.all([
  server.onMessage(JSON.stringify({ type: 'play', opId: 'race-a', slot: 3, pile: 0, expectedVersion: version }), A),
  server.onMessage(JSON.stringify({ type: 'play', opId: 'race-b', slot: 3, pile: 0, expectedVersion: version }), B),
]);
ck('競合は先着1件だけaccepted', !!A.lastOf('playAccepted') && !B.lastOf('playAccepted'));
ck('後着はstale reject', B.lastOf('playRejected').code === 'stale');
ck('rejectに正規stateと戻る場札を同梱',
  B.lastOf('playRejected').state.fields[1][3].r === 4 &&
  B.lastOf('playRejected').state.pileVersions[0] === version + 1);

const tokenB = B.lastOf('assigned').token;
server.now = () => 1000;
room.conns.delete(B);
await server.onClose(B);
ck('切断で一時停止', A.lastOf('state').status === 'paused' && room.alarm === 61000);
const before = A.lastOf('state').pileVersions[1];
await server.onMessage(JSON.stringify({ type: 'play', opId: 'paused-a', slot: 2, pile: 1, expectedVersion: before }), A);
ck('一時停止中の操作拒否', A.lastOf('playRejected').code === 'paused');
server.now = () => 11000;
const B2 = await connect('b2', 'B復帰', tokenB);
ck('seat tokenで同席復帰', B2.lastOf('assigned').seat === 1 && B2.lastOf('state').status === 'playing');
room.conns.delete(B2);
await server.onClose(B2);
server.now = () => 72000;
await server.onAlarm();
ck('60秒後は相手の不戦勝', A.lastOf('state').phase === 'ended' &&
  A.lastOf('state').result.winner === 0 && A.lastOf('state').result.forfeit);

console.log(`\n[speed server] pass=${pass} fail=${fail}`);
if (fail) process.exit(1);

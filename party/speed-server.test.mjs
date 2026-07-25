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
const connectTo = async (testRoom, testServer, id, name, token = '') => {
  const conn = new Conn(id);
  testRoom.conns.add(conn);
  testServer.onConnect(conn);
  await testServer.onMessage(JSON.stringify({ type: 'hello', name, token }), conn);
  return conn;
};
const connect = (id, name, token = '') => connectTo(room, server, id, name, token);
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
const afterRaceVersion = A.lastOf('state').pileVersions[0];
await server.onMessage(JSON.stringify({
  type: 'play', opId: 'race-a', slot: 3, pile: 0, expectedVersion: version,
}), A);
ck('同一opId再送は冪等で二重に出さない',
  A.lastOf('playAccepted').duplicate === true && A.lastOf('state').pileVersions[0] === afterRaceVersion);

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
ck('不戦勝確定時に失効席を解放して過去alarmを再登録しない',
  server.game.seats[1] === null && room.alarm === null);
const C = await connect('c', 'C');
ck('不戦勝後の空席へ新規参加してロビーへ戻れる',
  C.lastOf('assigned').seat === 1 && C.lastOf('state').phase === 'lobby');

const leaveRoom = new Room(), leaveServer = new SpeedServer(leaveRoom);
leaveServer.rand = () => 0.999999;
await leaveServer.onStart();
const LA = await connectTo(leaveRoom, leaveServer, 'la', 'LA');
const LB = await connectTo(leaveRoom, leaveServer, 'lb', 'LB');
await leaveServer.onMessage(JSON.stringify({ type: 'start' }), LA);
leaveServer.finishForfeit(0, 1);
await leaveServer.save();
leaveServer.broadcastState();
await leaveServer.onMessage(JSON.stringify({ type: 'leave' }), LB);
ck('終了後の退出で席を解放する', leaveServer.game.seats[1] === null);
const LC = await connectTo(leaveRoom, leaveServer, 'lc', 'LC');
ck('終了後の退出席へ新規参加してロビーへ戻れる',
  LC.lastOf('assigned').seat === 1 && LC.lastOf('state').phase === 'lobby');

const expiryRoom = new Room(), expiryServer = new SpeedServer(expiryRoom);
expiryServer.rand = () => 0.999999;
await expiryServer.onStart();
const EA = await connectTo(expiryRoom, expiryServer, 'ea', 'EA');
const EB = await connectTo(expiryRoom, expiryServer, 'eb', 'EB');
await expiryServer.onMessage(JSON.stringify({ type: 'start' }), EA);
expiryServer.finishForfeit(0, 1);
await expiryServer.save();
expiryServer.broadcastState();
expiryServer.now = () => 5000;
expiryRoom.conns.delete(EB);
await expiryServer.onClose(EB);
expiryServer.now = () => 65001;
await expiryServer.onAlarm();
ck('終了後の切断席を60秒で解放してalarmを解除する',
  expiryServer.game.seats[1] === null && expiryRoom.alarm === null);
const EC = await connectTo(expiryRoom, expiryServer, 'ec', 'EC');
ck('終了後に失効した席へ新規参加してロビーへ戻れる',
  EC.lastOf('assigned').seat === 1 && EC.lastOf('state').phase === 'lobby');

console.log(`\n[speed server] pass=${pass} fail=${fail}`);
if (fail) process.exit(1);

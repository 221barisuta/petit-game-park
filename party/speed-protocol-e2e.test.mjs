/* スピード同時操作プロトコルE2E。
   2接続が同じ台札世代へほぼ同時にplayし、先着1件だけ受理されること、
   せーのreadyが2接続分そろった時だけ単一更新されることを検証する。 */
import SpeedServer from './speed-server.js';

if (!globalThis.crypto) globalThis.crypto = (await import('node:crypto')).webcrypto;

class Room {
  constructor() {
    this.conns = new Set();
    const map = new Map();
    this.storage = {
      get: async key => map.get(key),
      put: async (key, value) => void map.set(key, value),
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    };
  }
  getConnections() { return this.conns; }
}
class Client {
  constructor(id, room, server) {
    this.messages = [];
    this.conn = {
      id,
      state: undefined,
      setState(state) { this.state = state; },
      send: raw => this.messages.push(JSON.parse(String(raw))),
    };
    this.room = room;
    this.server = server;
    room.conns.add(this.conn);
    server.onConnect(this.conn);
  }
  send(data) { return this.server.onMessage(JSON.stringify(data), this.conn); }
  latest(type) { return [...this.messages].reverse().find(m => m.type === type); }
}

let pass = 0, fail = 0;
const ck = (name, cond) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name);
};
const publicSnap = s => JSON.stringify({
  phase: s.phase, fields: s.fields, centers: s.centers,
  counts: s.counts, pileVersions: s.pileVersions, ready: s.ready, result: s.result,
});

const room = new Room(), server = new SpeedServer(room);
server.rand = () => 0.999999; // デッキ順を保ち、双方の「4」を台札「5」へ競合可能にする。
await server.onStart();
const A = new Client('a', room, server), B = new Client('b', room, server);
await A.send({ type: 'hello', name: 'A' });
await B.send({ type: 'hello', name: 'B' });
await A.send({ type: 'start' });
const initial = A.latest('state'), observedVersion = initial.pileVersions[0];

await Promise.all([
  A.send({ type: 'play', opId: 'sim-a', slot: 3, pile: 0, expectedVersion: observedVersion }),
  B.send({ type: 'play', opId: 'sim-b', slot: 3, pile: 0, expectedVersion: observedVersion }),
]);
const accepted = [A.latest('playAccepted'), B.latest('playAccepted')].filter(Boolean);
const rejected = [A.latest('playRejected'), B.latest('playRejected')].filter(Boolean);
ck('同一台札への同時playはacceptedが1件だけ', accepted.length === 1);
ck('後着1件は世代競合としてreject', rejected.length === 1 && rejected[0].code === 'stale');
ck('競合後の権威stateが両接続で一致',
  publicSnap(A.latest('state')) === publicSnap(B.latest('state')) &&
  A.latest('state').pileVersions[0] === observedVersion + 1);
const loserSeat = B.latest('playRejected') ? 1 : 0;
ck('負けた側の場札は正規stateで元の枠へ戻る',
  rejected[0].state.fields[loserSeat][3] && rejected[0].state.fields[loserSeat][3].r === 4);

// 実際の ready メッセージ経路を検証するため、権威状態を「双方合法手なし」のfixtureへ置く。
const r = server.game.round;
r.fields = [
  [8, 9, 10, 11].map((rank, i) => ({ id: 200 + i, s: 0, r: rank })),
  [8, 9, 10, 11].map((rank, i) => ({ id: 210 + i, s: 1, r: rank })),
];
r.centers = [[{ id: 220, s: 2, r: 2 }], [{ id: 221, s: 3, r: 2 }]];
r.stocks = [[{ id: 222, s: 0, r: 6 }], [{ id: 223, s: 1, r: 12 }]];
r.pileVersions = [9, 12];
r.ready = [false, false];
server.broadcastState();

await A.send({ type: 'ready' });
ck('片側readyだけでは台札を更新しない',
  A.latest('state').ready[0] === true && A.latest('state').pileVersions.join() === '9,12');
await B.send({ type: 'ready' });
ck('両側readyで2山を同時に一度だけ更新',
  A.latest('state').pileVersions.join() === '10,13' &&
  A.latest('state').centers[0].r === 6 && A.latest('state').centers[1].r === 12);
ck('せーの更新後も両接続stateが一致',
  publicSnap(A.latest('state')) === publicSnap(B.latest('state')) &&
  A.latest('state').ready.join() === 'false,false');

console.log(`\n[speed protocol e2e] pass=${pass} fail=${fail}`);
if (fail) process.exit(1);

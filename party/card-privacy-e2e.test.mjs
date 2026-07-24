/* 実DOランタイムで手札秘匿と再接続復元を検証するE2E。
   先に: cd party && npx wrangler dev --port 8791 --local
   実行: node party/card-privacy-e2e.test.mjs

   A/B/観戦者が実WebSocketで受けた生state payloadを直接走査し、
   A payloadにB手札カード object が1枚も無いこと、枚数だけはあること、
   seat token再接続後にA本人の同じ手札が復元されることをassertする。 */
import NanarabeServer from './nanarabe-server.js';

if (!globalThis.crypto) globalThis.crypto = (await import('node:crypto')).webcrypto;

const HOST = process.env.PARTY_E2E_HOST || '';
const NETWORK = !!HOST;
let pass = 0, fail = 0;
const ck = (name, cond) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (fn, ms = 8000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const v = fn();
    if (v) return v;
    await sleep(40);
  }
  return null;
};

if (NETWORK) {
  try {
    await fetch(`http://${HOST}/`);
  } catch (e) {
    console.error(`[card privacy e2e] ${HOST} に接続できません`);
    process.exit(2);
  }
}

const room = 'priv' + Math.random().toString(36).slice(2, 7);
let inProcess = null;
if (!NETWORK) {
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
    broadcast(raw) { for (const c of this.conns) c.send(raw); }
  }
  const serverRoom = new Room();
  const server = new NanarabeServer(serverRoom);
  await server.onStart();
  inProcess = { room: serverRoom, server, nextId: 0 };
}

async function client(name, token = '') {
  const messages = [];
  let ws;
  if (NETWORK) {
    const { default: WS } = await import('ws');
    ws = new WS(`ws://${HOST}/parties/nanarabe/${room}`);
    ws.on('message', raw => {
      try { messages.push({ raw: raw.toString(), data: JSON.parse(raw.toString()) }); } catch (e) {}
    });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ type: 'hello', name, token }));
  } else {
    const conn = {
      id: 'inproc-' + (++inProcess.nextId),
      state: undefined,
      setState(state) { this.state = state; },
      send(raw) {
        try { messages.push({ raw: String(raw), data: JSON.parse(String(raw)) }); } catch (e) {}
      },
    };
    inProcess.room.conns.add(conn);
    inProcess.server.onConnect(conn);
    ws = {
      send(raw) { void inProcess.server.onMessage(raw, conn); },
      close() {
        inProcess.room.conns.delete(conn);
        void inProcess.server.onClose(conn);
      },
    };
    ws.send(JSON.stringify({ type: 'hello', name, token }));
  }
  const assigned = await until(() => [...messages].reverse().find(x => x.data.type === 'assigned'));
  if (!assigned) throw new Error(name + ': assigned timeout');
  const state = await until(() => [...messages].reverse().find(x =>
    x.data.type === 'state' && x.data.youSeat === assigned.data.seat));
  if (!state) throw new Error(name + ': state timeout');
  return {
    ws, messages,
    assigned: assigned.data,
    send: data => ws.send(JSON.stringify(data)),
    latestState: () => {
      const m = [...messages].reverse().find(x => x.data.type === 'state');
      return m && m.data;
    },
    latestRawState: () => {
      const m = [...messages].reverse().find(x => x.data.type === 'state');
      return m && m.raw;
    },
  };
}

function cardIds(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Number.isInteger(value.id) && Number.isInteger(value.s) && Number.isInteger(value.r)) {
    out.push(value.id);
    return out;
  }
  if (Array.isArray(value)) value.forEach(v => cardIds(v, out));
  else Object.values(value).forEach(v => cardIds(v, out));
  return out;
}

const A = await client('E2E-A');
const B = await client('E2E-B');
ck('A/Bが別席へ着席', A.assigned.seat === 0 && B.assigned.seat === 1);
A.send({ type: 'start' });
const aPlaying = await until(() => {
  const s = A.latestState();
  return s && s.phase === 'playing' && s.hand && s.hand.length ? s : null;
});
const bPlaying = await until(() => {
  const s = B.latestState();
  return s && s.phase === 'playing' && s.hand && s.hand.length ? s : null;
});
if (!aPlaying || !bPlaying) throw new Error('playing state timeout');

const aHandIds = aPlaying.hand.map(c => c.id);
const bHandIds = bPlaying.hand.map(c => c.id);
const boardIds = aPlaying.board.flat().filter(Boolean).map(c => c.id);
const allowedForA = new Set([...aHandIds, ...boardIds]);
const cardsVisibleToA = cardIds(aPlaying);

ck('A受信payloadは本人handだけ', aHandIds.length > 0 && !Object.hasOwn(aPlaying, 'hands'));
ck('A payloadに他家は枚数だけ', aPlaying.counts[B.assigned.seat] === bHandIds.length);
ck('A/B本人手札は別集合', aHandIds.every(id => !bHandIds.includes(id)));
ck('Aの生payloadにB手札カード内容なし',
  cardsVisibleToA.every(id => allowedForA.has(id)) && bHandIds.every(id => !cardsVisibleToA.includes(id)));
ck('A生payloadに全手札コンテナなし', !/"hands"\s*:/.test(A.latestRawState()));

const spectator = await client('E2E-WATCH');
const specState = await until(() => {
  const s = spectator.latestState();
  return s && s.phase === 'playing' && s.youSeat === -1 ? s : null;
});
const specCardIds = cardIds(specState);
ck('観戦者はhand空', specState && specState.hand.length === 0);
ck('観戦者は場札以外のカード内容なし',
  specCardIds.every(id => boardIds.includes(id)) && !/"hands"\s*:/.test(spectator.latestRawState()));

const token = A.assigned.token, seat = A.assigned.seat;
const beforeReconnect = aHandIds.slice().sort((a, b) => a - b).join(',');
A.ws.close();
await sleep(120);
const A2 = await client('E2E-A-RETURN', token);
const restored = await until(() => {
  const s = A2.latestState();
  return s && s.youSeat === seat && s.hand && s.hand.length ? s : null;
});
ck('seat tokenで同じ席へ再接続', A2.assigned.seat === seat && A2.assigned.token === token);
ck('再接続時に本人手札を復元',
  restored && restored.hand.map(c => c.id).sort((a, b) => a - b).join(',') === beforeReconnect);

for (const c of [A2, B, spectator]) {
  try { c.ws.close(); } catch (e) {}
}
console.log(`\n[card privacy e2e:${NETWORK ? 'websocket-do' : 'in-process-protocol'}] pass=${pass} fail=${fail}`);
if (fail) process.exit(1);

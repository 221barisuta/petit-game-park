/* ページワン手札秘匿E2E。
   既定はプロセス内transport。実DOは先に wrangler dev --port 8791 --local を起動し、
   PARTY_E2E_HOST=127.0.0.1:8791 を付けて実WebSocketでも同じ契約を検証する。 */
import PageOneServer from './pageone-server.js';

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
    const value = fn();
    if (value) return value;
    await sleep(40);
  }
  return null;
};

if (NETWORK) {
  try { await fetch(`http://${HOST}/`); }
  catch {
    console.error(`[pageone privacy e2e] ${HOST} に接続できません`);
    process.exit(2);
  }
}

const roomCode = 'ppriv' + Math.random().toString(36).slice(2, 7);
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
  const room = new Room();
  const server = new PageOneServer(room);
  await server.onStart();
  inProcess = { room, server, nextId: 0 };
}

async function client(name, token = '') {
  const messages = [];
  let ws;
  if (NETWORK) {
    const { default: WS } = await import('ws');
    ws = new WS(`ws://${HOST}/parties/page-one/${roomCode}`);
    ws.on('message', raw => {
      try { messages.push({ raw: raw.toString(), data: JSON.parse(raw.toString()) }); } catch {}
    });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
  } else {
    const conn = {
      id: 'inproc-' + (++inProcess.nextId),
      state: undefined,
      setState(state) { this.state = state; },
      send(raw) {
        try { messages.push({ raw: String(raw), data: JSON.parse(String(raw)) }); } catch {}
      },
    };
    inProcess.room.conns.add(conn);
    inProcess.server.onConnect(conn);
    ws = {
      readyState: 1,
      send(raw) { void inProcess.server.onMessage(raw, conn); },
      close() {
        inProcess.room.conns.delete(conn);
        void inProcess.server.onClose(conn);
      },
    };
  }
  ws.send(JSON.stringify({ type: 'hello', name, token }));
  const assigned = await until(() => [...messages].reverse().find(x => x.data.type === 'assigned'));
  if (!assigned) throw new Error(name + ': assigned timeout');
  const state = await until(() => [...messages].reverse().find(x =>
    x.data.type === 'state' && x.data.youSeat === assigned.data.seat));
  if (!state) throw new Error(name + ': state timeout');
  return {
    ws,
    messages,
    assigned: assigned.data,
    send: data => ws.send(JSON.stringify(data)),
    latestState: () => {
      const found = [...messages].reverse().find(x => x.data.type === 'state');
      return found && found.data;
    },
    latestRawState: () => {
      const found = [...messages].reverse().find(x => x.data.type === 'state');
      return found && found.raw;
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

const A = await client('PAGE-A');
const B = await client('PAGE-B');
ck('A/Bが別席へ着席', A.assigned.seat === 0 && B.assigned.seat === 1);
A.send({ type: 'start' });
const aPlaying = await until(() => {
  const state = A.latestState();
  return state && state.phase === 'playing' && state.hand && state.hand.length ? state : null;
});
const bPlaying = await until(() => {
  const state = B.latestState();
  return state && state.phase === 'playing' && state.hand && state.hand.length ? state : null;
});
if (!aPlaying || !bPlaying) throw new Error('playing state timeout');

const aHandIds = aPlaying.hand.map(card => card.id);
const bHandIds = bPlaying.hand.map(card => card.id);
const allowedForA = new Set(aHandIds);
if (aPlaying.top) allowedForA.add(aPlaying.top.id);
const cardsVisibleToA = cardIds(aPlaying);

ck('A受信payloadは本人handだけ', aHandIds.length === 5 && !Object.hasOwn(aPlaying, 'hands'));
ck('A payloadに他家は枚数だけ', aPlaying.counts[B.assigned.seat] === bHandIds.length);
ck('A/B本人手札は別集合', aHandIds.every(id => !bHandIds.includes(id)));
ck('A生payloadにB手札/山札カード内容なし',
  cardsVisibleToA.every(id => allowedForA.has(id)) && bHandIds.every(id => !cardsVisibleToA.includes(id)));
ck('A生payloadに全手札コンテナなし', !/"hands"\s*:/.test(A.latestRawState()));

const spectator = await client('PAGE-WATCH');
const specState = await until(() => {
  const state = spectator.latestState();
  return state && state.phase === 'playing' && state.youSeat === -1 ? state : null;
});
const spectatorCards = cardIds(specState);
ck('観戦者はhand空', specState && specState.hand.length === 0);
ck('観戦者は公開場札以外のカード内容なし',
  spectatorCards.every(id => id === specState.top.id) && !/"hands"\s*:/.test(spectator.latestRawState()));

const token = A.assigned.token, seat = A.assigned.seat;
const beforeReconnect = aHandIds.slice().sort((a, b) => a - b).join(',');
A.ws.close();
await sleep(120);
const A2 = await client('PAGE-A-RETURN', token);
const restored = await until(() => {
  const state = A2.latestState();
  return state && state.youSeat === seat && state.hand && state.hand.length ? state : null;
});
ck('seat tokenで同じ席へ再接続', A2.assigned.seat === seat && A2.assigned.token === token);
ck('再接続時に本人手札を復元',
  restored && restored.hand.map(card => card.id).sort((a, b) => a - b).join(',') === beforeReconnect);

for (const c of [A2, B, spectator]) {
  try { c.ws.close(); } catch {}
}
console.log(`\n[pageone privacy e2e:${NETWORK ? 'websocket-do' : 'in-process-protocol'}] pass=${pass} fail=${fail}`);
if (fail) process.exit(1);

/* 接続別state projector の秘匿契約テスト。
   実行: node party/private-state.test.mjs */
import { authenticatedSeat, hiddenHandState } from './private-state.js';

let pass = 0, fail = 0;
const ck = (name, cond) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name);
};
const conn = state => ({ state });
const seats = [
  { token: 'seat-token-a', name: 'A' },
  { token: 'seat-token-b', name: 'B' },
  { token: '', name: 'CPU', cpu: true },
];
const hands = [
  [{ id: 1, secret: 'ONLY-A' }],
  [{ id: 2, secret: 'ONLY-B' }, { id: 3, secret: 'ONLY-B-2' }],
  [{ id: 4, secret: 'ONLY-CPU' }],
];
const publicState = { field: [{ id: 99, public: true }] };

const a = hiddenHandState({ conn: conn({ seat: 0, token: 'seat-token-a' }), seats, hands, publicState });
const spectator = hiddenHandState({ conn: conn({ seat: -1, token: '' }), seats, hands, publicState });
const forged = hiddenHandState({ conn: conn({ seat: 1, token: 'seat-token-a' }), seats, hands, publicState });

ck('token一致だけ本人席として認証', authenticatedSeat(conn({ seat: 0, token: 'seat-token-a' }), seats) === 0);
ck('別席tokenの偽装は観戦扱い', authenticatedSeat(conn({ seat: 1, token: 'seat-token-a' }), seats) === -1);
ck('本人には本人手札を配信', a.youSeat === 0 && a.hand.length === 1 && a.hand[0].secret === 'ONLY-A');
ck('他家は枚数だけ公開', JSON.stringify(a.counts) === '[1,2,1]');
ck('本人payloadに他家手札内容なし', !JSON.stringify(a).includes('ONLY-B') && !JSON.stringify(a).includes('ONLY-CPU'));
ck('観戦者payloadに全手札内容なし', spectator.youSeat === -1 && spectator.hand.length === 0
  && !JSON.stringify(spectator).includes('ONLY-A') && !JSON.stringify(spectator).includes('ONLY-B'));
ck('偽装接続へ手札を出さない', forged.youSeat === -1 && forged.hand.length === 0);
ck('公開場は全員へ配信', a.field[0].public === true && spectator.field[0].public === true);

console.log(`\n[private-state] pass=${pass} fail=${fail}`);
if (fail) process.exit(1);

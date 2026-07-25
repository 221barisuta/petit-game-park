/* index.html のスピード楽観UIが、同一描画フレームまでに届いた複数REJECTを
   一括回収し、サーバー権威stateと表示を完全同期することを検証する。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const match = html.match(/\/\* SPEED-REJECT-QUEUE-BEGIN \*\/\n([\s\S]*?)\/\* SPEED-REJECT-QUEUE-END \*\//);
if (!match) {
  console.error('index.html から SPEED-REJECT-QUEUE を抽出できませんでした');
  process.exit(2);
}
const { drainSpeedRejects } = new Function(
  `${match[1]}\nreturn { drainSpeedRejects };`,
)();

let pass = 0, fail = 0;
const ck = (name, cond) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name);
};
const pending = [
  { opId: 'op-a', card: { id: 10 }, slot: 0, pile: 0 },
  { opId: 'op-keep', card: { id: 11 }, slot: 1, pile: 1 },
  { opId: 'op-b', card: { id: 12 }, slot: 2, pile: 0 },
];
const rejectedQueue = [
  { type: 'playRejected', opId: 'op-b', code: 'stale' },
  { type: 'playRejected', opId: 'op-a', code: 'stale' },
];
const result = drainSpeedRejects(rejectedQueue, pending);

ck('同一フレームの2件をopIdごとに回収',
  result.returned.map(v => v.op.opId).sort().join() === 'op-a,op-b');
ck('REJECT時は対象外を含む全pending overlayを破棄', result.pending.length === 0);
ck('REJECTキューを一括で空にする', rejectedQueue.length === 0);
ck('各pendingに対応するREJECTを保持',
  result.returned.every(v => v.reject.opId === v.op.opId));

const authoritative = {
  fields: [[
    { id: 10, r: 2, s: 0 },
    { id: 11, r: 3, s: 0 },
    { id: 12, r: 4, s: 0 },
  ]],
};
const displayedFields = (state, optimistic) => {
  const fields = state.fields.map(row => row.slice());
  for (const op of optimistic) fields[0][op.slot] = null;
  return fields;
};
ck('連続REJECT後の手札表示がサーバー権威stateと一致',
  JSON.stringify(displayedFields(authoritative, result.pending)) === JSON.stringify(authoritative.fields));

const untouched = drainSpeedRejects([], pending);
ck('REJECTが無いフレームではpendingを維持',
  untouched.pending === pending && untouched.returned.length === 0);

console.log(`\n[speed client reconcile] pass=${pass} fail=${fail}`);
if (fail) process.exit(1);

/* index.html のスピード楽観UIが、同一描画フレームまでに届いた複数REJECTを
   opIdごとに一括回収し、無関係なpendingだけを残すことを検証する。 */
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
ck('拒否されていないpendingだけ残す',
  result.pending.length === 1 && result.pending[0].opId === 'op-keep');
ck('REJECTキューを一括で空にする', rejectedQueue.length === 0);
ck('各pendingに対応するREJECTを保持',
  result.returned.every(v => v.reject.opId === v.op.opId));

console.log(`\n[speed client reconcile] pass=${pass} fail=${fail}`);
if (fail) process.exit(1);

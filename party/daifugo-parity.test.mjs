/* 大富豪コアロジック パリティテスト (divergence厳禁の機械担保)
   ──────────────────────────────────────────────────────────
   index.html 内の DAIFUGO-CORE-BEGIN..END ブロックが party/daifugo-core.js の
   「export を外しただけ」の verbatim コピーであることをテキスト一致で検証し、
   さらに抽出コードを評価して代表的な出力一致(挙動)も確認する。
   実行: node party/daifugo-parity.test.mjs   (非0終了で失敗) */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as core from './daifugo-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const coreSrc = readFileSync(join(here, 'daifugo-core.js'), 'utf8');

let pass = 0, fail = 0; const log = [];
const ck = (n, c) => { c ? pass++ : (fail++, log.push(n)); };

// ── ① テキスト一致 (export削除後の core と index.html ブロックが同一) ──
const m = html.match(/\/\* DAIFUGO-CORE-BEGIN[^\n]*\*\/\n([\s\S]*?)\/\* DAIFUGO-CORE-END \*\//);
if (!m) { console.error('index.html から DAIFUGO-CORE ブロックを抽出できませんでした'); process.exit(2); }
const clientSrc = m[1];
const strippedCore = coreSrc.replace(/^export /gm, '');
ck('verbatim-text-equal', clientSrc === strippedCore);

// ── ② 挙動一致 (抽出コードを評価して代表関数の出力を突き合わせ) ──
const names = ['RULE_DEFS', 'defaultRules', 'normalizeRules', 'makeDeck', 'shuffle', 'strengthOf',
  'analyzeHand', 'playEffects', 'canFollow', 'nextLock', 'legalMoves', 'cpuChoose', 'titlesFor',
  'newRound', 'ctxOf', 'applyAction', 'cpuAct', 'applyExchange'];
const refSrc = clientSrc + '\nexport {' + names.join(',') + '};';
const ref = await import('data:text/javascript,' + encodeURIComponent(refSrc));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

ck('defs-equal', eq(core.RULE_DEFS, ref.RULE_DEFS));
ck('default-equal', eq(core.defaultRules(), ref.defaultRules()));
const R = core.defaultRules();
ck('deck-equal', eq(core.makeDeck(R), ref.makeDeck(R)));
// 乱数注入で同一シャッフル→同一ラウンド→CPU同士で1局完走して全スナップショット一致
let s1 = 777, s2 = 777;
const rnd1 = () => (s1 = (s1 * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const rnd2 = () => (s2 = (s2 * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const rl = core.normalizeRules({ stairs: true, elevenBack: true, fiveSkip: true, reverse: true, spade3Return: true, playerCount: 4 });
const g1 = core.newRound(rl, core.shuffle(core.makeDeck(rl), rnd1), null);
const g2 = ref.newRound(rl, ref.shuffle(ref.makeDeck(rl), rnd2), null);
ck('round-equal', eq(g1, g2));
let same = true, steps = 0;
while (!g1.ended && steps++ < 3000) {
  const r1 = core.cpuAct(g1, rl), r2 = ref.cpuAct(g2, rl);
  if (!eq(r1, r2) || !eq(g1, g2)) { same = false; break; }
}
ck('full-game-equal(' + steps + 'steps)', same && g1.ended && g2.ended);

console.log('[parity daifugo-core] pass=' + pass + ' / fail=' + fail, log.length ? log : '');
process.exit(fail ? 1 : 0);

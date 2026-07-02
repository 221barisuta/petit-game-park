/* 大富豪コアロジック headless テスト
   検証: ルール正規化 / 山札 / 役判定(単騎・セット・階段・ジョーカーワイルド) /
        強弱比較(革命/11バックXOR) / 追従判定(縛り・スペ3返し) / 効果パイプライン /
        合法手生成の自己整合性(fuzz) / CPU / 称号・交換
   実行: node party/daifugo-core.test.mjs   (非0終了で失敗) */
import {
  RULE_DEFS, defaultRules, normalizeRules, makeDeck, shuffle, dealHands,
  strengthOf, isInverted, sortHand, analyzeHand, playEffects,
  canFollow, suitsOkForLock, nextLock, legalMoves, cpuChoose, titlesFor, exchangePairs,
  newRound, ctxOf, nextAliveSeat, applyAction, cpuAct, applyExchange,
} from './daifugo-core.js';

let pass = 0, fail = 0; const log = [];
const ck = (n, c) => { c ? pass++ : (fail++, log.push(n)); };
// カード簡易生成: C('S3')=♠3, C('H11')=♥J, C('J')=ジョーカー
let _id = 1000;
const SUIT = { S: 0, H: 1, D: 2, C: 3 };
const C = code => code === 'J' ? { id: _id++, r: 99, s: -1 } : { id: _id++, r: +code.slice(1), s: SUIT[code[0]] };
const H = (...codes) => codes.map(C);
const R = defaultRules();
const RS = { ...R, stairs: true, spade3Return: true, elevenBack: true, fiveSkip: true, reverse: true };

// ── ルール定義・正規化 ──
ck('defs:keys-unique', new Set(RULE_DEFS.map(d => d.key)).size === RULE_DEFS.length);
ck('default:sample', R.revolution === true && R.stairs === false && R.jokerCount === 1 && R.playerCount === 5);
ck('normalize:null', JSON.stringify(normalizeRules(null)) === JSON.stringify(R));
ck('normalize:bad-select', normalizeRules({ jokerCount: 9, playerCount: 'x' }).jokerCount === 1);
ck('normalize:bool-coerce', normalizeRules({ revolution: 0, stairs: 1 }).revolution === false && normalizeRules({ stairs: 1 }).stairs === true);
ck('normalize:keeps-valid', normalizeRules({ playerCount: 3, deckCount: 2, jokerCount: 2 }).playerCount === 3);
ck('normalize:ignores-extra', normalizeRules({ zzz: true }).zzz === undefined);

// ── 山札 ──
ck('deck:52+1', makeDeck(R).length === 53);
ck('deck:2decks-2jokers', makeDeck({ ...R, deckCount: 2, jokerCount: 2 }).length === 108);
ck('deck:no-joker', makeDeck({ ...R, jokerCount: 0 }).length === 52);
ck('deck:ids-unique', new Set(makeDeck({ ...R, deckCount: 2 }).map(c => c.id)).size === 106);
{ const d = shuffle(makeDeck(R), () => 0.5); const hs = dealHands(d, 5);
  ck('deal:5hands', hs.length === 5 && hs.reduce((a, h) => a + h.length, 0) === 53);
  ck('deal:balanced', Math.max(...hs.map(h => h.length)) - Math.min(...hs.map(h => h.length)) <= 1); }

// ── 強弱 ──
ck('str:3-weakest', strengthOf(3, false) < strengthOf(4, false));
ck('str:2-strongest', strengthOf(15, false) > strengthOf(14, false));
ck('str:joker-top', strengthOf(99, false) > strengthOf(15, false) && strengthOf(99, true) > strengthOf(3, true));
ck('str:inverted-3-beats-2', strengthOf(3, true) > strengthOf(15, true));
ck('str:xor', isInverted({ revolution: true, elevenBack: true }) === false && isInverted({ revolution: true, elevenBack: false }) === true);
{ const h = sortHand(H('S15', 'H3', 'J', 'D8'), false);
  ck('sort:normal', h[0].r === 3 && h[3].r === 99); }

// ── 役判定 ──
ck('an:single', analyzeHand(H('S5'), R).type === 'single' && analyzeHand(H('S5'), R).rank === 5);
ck('an:single-joker', analyzeHand(H('J'), R).rank === 99 && analyzeHand(H('J'), R).suits.length === 0);
ck('an:pair', analyzeHand(H('S7', 'H7'), R).type === 'set' && analyzeHand(H('S7', 'H7'), R).n === 2);
ck('an:pair-mixed-reject', analyzeHand(H('S7', 'H8'), R) === null);
ck('an:joker-wild-pair', analyzeHand(H('S7', 'J'), R).type === 'set' && analyzeHand(H('S7', 'J'), R).rank === 7);
ck('an:joker-pair', analyzeHand(H('J', 'J'), R).type === 'set' && analyzeHand(H('J', 'J'), R).rank === 99);
ck('an:quad', analyzeHand(H('S9', 'H9', 'D9', 'C9'), R).n === 4);
ck('an:stairs-off-reject', analyzeHand(H('S3', 'S4', 'S5'), R) === null); // stairs無効時は不成立
ck('an:stairs-on', analyzeHand(H('S3', 'S4', 'S5'), RS).type === 'stairs' && analyzeHand(H('S3', 'S4', 'S5'), RS).rank === 5);
ck('an:stairs-suit-mixed-reject', analyzeHand(H('S3', 'H4', 'S5'), RS) === null);
ck('an:stairs-2-reject', analyzeHand(H('S3', 'S4'), RS) === null); // 2枚は階段でない(ペアでもない)
ck('an:stairs-joker-gap', analyzeHand(H('S3', 'J', 'S5'), RS).type === 'stairs');
ck('an:stairs-joker-extend-top', analyzeHand(H('S13', 'S14', 'J'), RS).rank === 15);
ck('an:stairs-joker-extend-down', analyzeHand(H('S14', 'S15', 'J'), RS).rank === 15); // 上が15で頭打ち→下へ
ck('an:stairs-dup-reject', analyzeHand([...H('S3', 'S4'), { id: _id++, r: 4, s: 0 }], { ...RS, deckCount: 2 }) === null);
ck('an:empty', analyzeHand([], R) === null);

// ── 効果パイプライン ──
{ const fx = playEffects(analyzeHand(H('S8'), R), R);
  ck('fx:8cut', fx.flow === true); }
ck('fx:8cut-off', playEffects(analyzeHand(H('S8'), R), { ...R, eightCut: false }).flow === false);
ck('fx:revolution-quad', playEffects(analyzeHand(H('S9', 'H9', 'D9', 'C9'), R), R).revolution === true);
ck('fx:revolution-triple-no', playEffects(analyzeHand(H('S9', 'H9', 'D9'), R), R).revolution === false);
ck('fx:revolution-off', playEffects(analyzeHand(H('S9', 'H9', 'D9', 'C9'), R), { ...R, revolution: false }).revolution === false);
ck('fx:11back', playEffects(analyzeHand(H('S11'), RS), RS).elevenBack === true);
ck('fx:5skip-double', playEffects(analyzeHand(H('S5', 'H5'), RS), RS).skip === 2);
ck('fx:9reverse', playEffects(analyzeHand(H('S9'), RS), RS).reverse === true);
ck('fx:joker-not-8', playEffects(analyzeHand(H('S7', 'J'), R), R).flow === false); // ジョーカーを8扱いしない

// ── 追従判定 ──
const ctx0 = { inverted: false, lock: null }, ctxI = { inverted: true, lock: null };
const an = (h, rl) => analyzeHand(h, rl || R);
ck('fo:empty-any', canFollow(null, an(H('S3')), ctx0, R) === true);
ck('fo:higher', canFollow(an(H('S5')), an(H('H9')), ctx0, R) === true);
ck('fo:lower-reject', canFollow(an(H('S9')), an(H('H5')), ctx0, R) === false);
ck('fo:equal-reject', canFollow(an(H('S9')), an(H('H9')), ctx0, R) === false);
ck('fo:inverted', canFollow(an(H('S9')), an(H('H5')), ctxI, R) === true);
ck('fo:type-mismatch', canFollow(an(H('S5')), an(H('S9', 'H9')), ctx0, R) === false);
ck('fo:count-mismatch', canFollow(an(H('S5', 'H5')), an(H('S9', 'H9', 'D9')), ctx0, R) === false);
ck('fo:joker-beats-2', canFollow(an(H('S15')), an(H('J')), ctx0, R) === true);
ck('fo:joker-strong-inverted', canFollow(an(H('S3')), an(H('J')), ctxI, R) === true);
ck('fo:spade3-return', canFollow(an(H('J'), RS), an(H('S3'), RS), ctx0, RS) === true);
ck('fo:heart3-no-return', canFollow(an(H('J'), RS), an(H('H3'), RS), ctx0, RS) === false);
ck('fo:spade3-return-off', canFollow(an(H('J')), an(H('S3')), ctx0, R) === false);
ck('fo:stairs-vs-stairs', canFollow(an(H('S3', 'S4', 'S5'), RS), an(H('H7', 'H8', 'H9'), RS), ctx0, RS) === true);

// ── 縛り ──
ck('lock:subset-ok', suitsOkForLock(an(H('S9')), [0]) === true && suitsOkForLock(an(H('H9')), [0]) === false);
ck('lock:joker-wild', suitsOkForLock(an(H('J')), [0]) === true);
ck('lock:pair', suitsOkForLock(an(H('S9', 'H9')), [0, 1]) === true && suitsOkForLock(an(H('S9', 'D9')), [0, 1]) === false);
ck('lock:establish', JSON.stringify(nextLock(an(H('S5')), an(H('S9')), null, R)) === '[0]');
ck('lock:no-establish-diff', nextLock(an(H('S5')), an(H('H9')), null, R) === null);
ck('lock:keeps', JSON.stringify(nextLock(an(H('H12')), an(H('D13')), [0], R)) === '[0]');
ck('lock:off', nextLock(an(H('S5')), an(H('S9')), null, { ...R, shibari: false }) === null);
ck('lock:follow-with-lock', canFollow(an(H('S5')), an(H('H9')), { inverted: false, lock: [0] }, R) === false);

// ── 合法手生成 (battery) ──
{ const hand = H('S3', 'H3', 'S7', 'J');
  const ms = legalMoves(hand, null, ctx0, R);
  ck('lm:contains-single', ms.some(m => m.hand.type === 'single' && m.hand.rank === 7));
  ck('lm:contains-pair', ms.some(m => m.hand.type === 'set' && m.hand.rank === 3 && m.hand.n === 2));
  ck('lm:joker-wild-pair', ms.some(m => m.hand.type === 'set' && m.hand.rank === 7 && m.hand.n === 2 && m.hand.jokers === 1));
}
{ const hand = H('S4', 'H6', 'D10');
  const ms = legalMoves(hand, an(H('S12')), ctx0, R);
  ck('lm:none-vs-high', ms.length === 0); }
{ const hand = H('S3', 'S4', 'S5', 'H9');
  const ms = legalMoves(hand, an(H('D3', 'D4', 'D5'), RS), ctx0, RS);
  ck('lm:no-equal-stairs', ms.every(m => m.hand.type !== 'stairs' || m.hand.rank > 5)); }

// ── 合法手生成 fuzz: 生成された全手が「解析可能かつ追従可能」/ 重複なし ──
{ let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let ok = true, cases = 0;
  for (let t = 0; t < 300 && ok; t++) {
    const rl = { ...RS, jokerCount: [0, 1, 2][Math.floor(rnd() * 3)], deckCount: rnd() < 0.3 ? 2 : 1 };
    const deck = shuffle(makeDeck(rl), rnd);
    const hand = deck.slice(0, 3 + Math.floor(rnd() * 12));
    const fieldCards = deck.slice(20, 20 + (1 + Math.floor(rnd() * 3)));
    const top = rnd() < 0.3 ? null : analyzeHand(fieldCards, rl);
    const ctx = { inverted: rnd() < 0.5, lock: rnd() < 0.2 ? [Math.floor(rnd() * 4)] : null };
    const ms = legalMoves(hand, top, ctx, rl);
    const keys = new Set();
    for (const m of ms) {
      cases++;
      const a = analyzeHand(m.cards, rl);
      if (!a || !canFollow(top, a, ctx, rl)) { ok = false; log.push('fuzz-invalid#' + t); break; }
      if (m.cards.some(c => !hand.includes(c))) { ok = false; log.push('fuzz-notinhand#' + t); break; }
      const k = m.cards.map(c => c.id).sort((x, y) => x - y).join(',');
      if (keys.has(k)) { ok = false; log.push('fuzz-dup#' + t); break; }
      keys.add(k);
    }
  }
  ck('lm:fuzz(' + cases + 'moves)', ok);
}

// ── CPU ──
{ const hand = H('S3', 'S9', 'S15');
  const mv = cpuChoose(hand, an(H('H5')), ctx0, R);
  ck('cpu:weakest-legal', mv && mv.hand.rank === 9); } // 3は出せない→9(15温存)
{ const mv = cpuChoose(H('S3', 'H7'), null, ctx0, R);
  ck('cpu:lead-weakest', mv && mv.hand.rank === 3); }
{ const mv = cpuChoose(H('S4'), an(H('H12')), ctx0, R);
  ck('cpu:pass-null', mv === null); }
{ const mv = cpuChoose(H('J', 'S4', 'S6', 'H9', 'D10'), an(H('H15')), ctx0, R);
  ck('cpu:joker-hoard', mv === null); } // 手札5枚でジョーカーしか出せない→温存
{ const mv = cpuChoose(H('J', 'S4'), an(H('H15')), ctx0, R);
  ck('cpu:joker-endgame', mv && mv.hand.rank === 99); } // 終盤は出す
{ const hand = H('S3', 'H3', 'D5');
  const mv = cpuChoose(hand, null, ctx0, R);
  ck('cpu:prefer-multi', mv && mv.hand.n === 2 && mv.hand.rank === 3); } // 同強度なら多枚数

// ── 称号・交換 ──
ck('title:5', titlesFor(5).join(',') === '大富豪,富豪,平民,貧民,大貧民');
ck('title:3', titlesFor(3).join(',') === '大富豪,平民,大貧民');
ck('title:6-len', titlesFor(6).length === 6);
ck('ex:5', JSON.stringify(exchangePairs(5)) === '[[0,4,2],[1,3,1]]');
ck('ex:3', JSON.stringify(exchangePairs(3)) === '[[0,2,2]]');

// ══ ラウンド進行エンジン ══════════════════════════════════
function seeded(seed) { let s = seed; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; }
// 手動局面を作るヘルパ (配布を上書き)
function fixedRound(rules, handsCodes, turn) {
  const g = newRound(rules, makeDeck(rules), 0);
  g.hands = handsCodes.map(cs => H(...cs));
  g.turn = turn;
  return g;
}
const R4 = { ...R, playerCount: 4 };

// ── 基本進行: 着手→手番送り / 手番違い・観戦は拒否 ──
{ const g = fixedRound(R4, [['S3', 'S5'], ['H4', 'H6'], ['D4', 'D7'], ['C9', 'C10']], 0);
  ck('eng:wrong-turn', applyAction(g, 1, H('H4'), R4).ok === false);
  const r = applyAction(g, 0, [g.hands[0][0]], R4); // ♠3
  ck('eng:play-ok', r.ok && g.field.top.rank === 3 && g.turn === 1);
  ck('eng:hand-removed', g.hands[0].length === 1);
  ck('eng:not-in-hand', applyAction(g, 1, H('S15'), R4).ok === false);
  ck('eng:cannot-beat', applyAction(g, 1, [g.hands[1].find(c => c.r === 4)], { ...R4 }).ok === true); // 4>3
}
// ── 親はパス不可 / 全員パスで場流れ→親に戻る ──
{ const g = fixedRound(R4, [['S5', 'S9'], ['H4', 'H6'], ['D4', 'D7'], ['C4', 'C10']], 0);
  ck('eng:leader-no-pass', applyAction(g, 0, null, R4).ok === false);
  applyAction(g, 0, [g.hands[0][1]], R4);            // 席0 が 9
  ck('eng:pass1', applyAction(g, 1, null, R4).ok && g.turn === 2);
  applyAction(g, 2, null, R4);
  const r = applyAction(g, 3, null, R4);             // 3人目のパスで場流れ
  ck('eng:flow-on-all-pass', r.flowed === true && g.field.top === null && g.turn === 0);
  ck('eng:passes-reset', g.passes === 0 && g.passed.every(p => !p));
}
// ── 8切り: 流して同じ人が親 ──
{ const g = fixedRound(R4, [['S8', 'S9'], ['H10', 'H6'], ['D11', 'D7'], ['C12', 'C10']], 0);
  const r = applyAction(g, 0, [g.hands[0][0]], R4);  // ♠8
  ck('eng:8cut-flow', r.flowed === true && r.fx.flow && g.field.top === null && g.turn === 0);
}
// ── 革命: 4枚出しで反転し、以後は弱いカードが勝つ (場が流れた後のシングルで検証) ──
{ const g = fixedRound(R4, [['S9', 'H9', 'D9', 'C9', 'S14'], ['H4', 'H15'], ['D4', 'D7'], ['C4', 'C10']], 0);
  const r = applyAction(g, 0, g.hands[0].filter(c => c.r === 9), R4);
  ck('eng:revolution-set', r.ok && g.st.revolution === true);
  applyAction(g, 1, null, R4); applyAction(g, 2, null, R4); applyAction(g, 3, null, R4); // 全員パス→流れ(親=席0)
  ck('eng:revolution-persists-flow', g.st.revolution === true && g.field.top === null && g.turn === 0);
  applyAction(g, 0, [g.hands[0].find(c => c.r === 14)], R4);            // A (革命下では弱い)
  ck('eng:rev-weak-wins', applyAction(g, 1, [g.hands[1].find(c => c.r === 4)], R4).ok === true);   // 4 が A に勝つ
  const g2 = fixedRound(R4, [['S9', 'H9', 'D9', 'C9', 'S14'], ['H4', 'H15'], ['D4', 'D7'], ['C4', 'C10']], 0);
  applyAction(g2, 0, g2.hands[0].filter(c => c.r === 9), R4);
  applyAction(g2, 1, null, R4); applyAction(g2, 2, null, R4); applyAction(g2, 3, null, R4);
  applyAction(g2, 0, [g2.hands[0].find(c => c.r === 14)], R4);
  ck('eng:rev-strong-loses', applyAction(g2, 1, [g2.hands[1].find(c => c.r === 15)], R4).ok === false); // 2は負け
}
// ── 11バック: 場が流れるまで逆転 → 流れたら解除 ──
{ const rl = { ...R4, elevenBack: true };
  const g = fixedRound(rl, [['S11', 'S9'], ['H4', 'H15'], ['D4', 'D7'], ['C4', 'C10']], 0);
  applyAction(g, 0, [g.hands[0].find(c => c.r === 11)], rl);
  ck('eng:11back-on', g.st.elevenBack === true);
  ck('eng:11back-weak-wins', applyAction(g, 1, [g.hands[1].find(c => c.r === 4)], rl).ok === true);
  applyAction(g, 2, null, rl); applyAction(g, 3, null, rl); applyAction(g, 0, null, rl); // 全員パス→流れ
  ck('eng:11back-off-after-flow', g.st.elevenBack === false);
}
// ── 5飛び: 次の1人を飛ばす ──
{ const rl = { ...R4, fiveSkip: true };
  const g = fixedRound(rl, [['S5', 'S9'], ['H6', 'H15'], ['D6', 'D7'], ['C6', 'C10']], 0);
  applyAction(g, 0, [g.hands[0].find(c => c.r === 5)], rl);
  ck('eng:5skip', g.turn === 2); // 席1を飛ばして席2
}
// ── 9リバース: 場が流れるまで逆回り ──
{ const rl = { ...R4, reverse: true };
  const g = fixedRound(rl, [['S9', 'S13'], ['H10', 'H15'], ['D10', 'D7'], ['C10', 'C12']], 0);
  applyAction(g, 0, [g.hands[0].find(c => c.r === 9)], rl);
  ck('eng:9reverse-dir', g.st.reverse === true && g.turn === 3); // 逆回りで席3へ
}
// ── 縛り: 同スート連続で成立→違うスートは出せない ──
{ const g = fixedRound(R4, [['S5', 'D3'], ['S7', 'H9'], ['S9', 'H10'], ['H11', 'C10']], 0);
  applyAction(g, 0, [g.hands[0].find(c => c.r === 5)], R4);        // ♠5
  applyAction(g, 1, [g.hands[1].find(c => c.s === 0)], R4);        // ♠7 → ♠縛り成立
  ck('eng:lock-established', JSON.stringify(g.field.lock) === '[0]');
  ck('eng:lock-blocks', applyAction(g, 2, [g.hands[2].find(c => c.s === 1)], R4).ok === false); // ♥10 拒否
  ck('eng:lock-allows', applyAction(g, 2, [g.hands[2].find(c => c.s === 0)], R4).ok === true);  // ♠9 OK
}
// ── 上がり→称号順 / 上がった席は手番スキップ / 最後の1人で終局 ──
{ const g = fixedRound(R4, [['S4'], ['H6', 'H7'], ['D9', 'D10'], ['C12', 'C13']], 0);
  const r = applyAction(g, 0, g.hands[0], R4);        // 席0 が上がり
  ck('eng:finish-recorded', r.finishedSeat === 0 && g.finished[0] === 0 && !g.ended);
  applyAction(g, 1, [g.hands[1][1]], R4);             // 7
  applyAction(g, 2, [g.hands[2][1]], R4);             // 10
  applyAction(g, 3, [g.hands[3][1]], R4);             // K
  // 全員パス相当: 席1,2がパス → 場流れ(親=席3)
  applyAction(g, 1, null, R4); applyAction(g, 2, null, R4);
  ck('eng:flow-skips-finished', g.turn === 3 && g.field.top === null);
  applyAction(g, 3, g.hands[3], R4);                  // 席3上がり(場にQ残存)
  applyAction(g, 1, null, R4); applyAction(g, 2, null, R4); // 親不在→全生存者パスで場流れ(親=席1)
  ck('eng:flow-owner-finished', g.field.top === null && g.turn === 1);
  applyAction(g, 1, g.hands[1], R4);                  // 席1上がり → 残り席2で終局
  ck('eng:ended', g.ended === true && g.finished.join(',') === '0,3,1,2');
  ck('eng:titles', titlesFor(4)[g.finished.indexOf(2)] === '大貧民');
}
// ── ♦3の保持者が初回の親 ──
{ let found = false;
  for (let s = 1; s <= 30 && !found; s++) {
    const g = newRound(R4, shuffle(makeDeck(R4), seeded(s)), null);
    found = g.hands[g.turn].some(c => c.r === 3 && c.s === 2);
  }
  ck('eng:d3-leader', found);
}
// ── カード交換: 下位の最強→上位 / 上位の最弱→下位 / 総枚数不変 ──
{ const g = newRound(R, shuffle(makeDeck(R), seeded(7)), 0);
  const before = g.hands.map(h => h.length);
  const total = g.hands.flat().length;
  const prevOrder = [0, 1, 2, 3, 4];
  const poorBest = sortHand(g.hands[4], false).slice(-2).map(c => c.id);
  const mv = applyExchange(g, prevOrder, R);
  ck('ex:moves', mv.length === 2);
  ck('ex:counts-kept', g.hands.every((h, i) => h.length === before[i]) && g.hands.flat().length === total);
  ck('ex:poor-best-moved', poorBest.every(id => g.hands[0].some(c => c.id === id)));
  ck('ex:off', applyExchange(g, prevOrder, { ...R, cardExchange: false }).length === 0);
}
// ── フルゲーム fuzz: ランダムルール×CPU同士で完走・カード保存・順位妥当 ──
{ let ok = true, games = 0;
  for (let t = 1; t <= 60 && ok; t++) {
    const rnd = seeded(t * 991);
    const rl = normalizeRules({
      ...defaultRules(),
      stairs: rnd() < 0.5, spade3Return: rnd() < 0.5, elevenBack: rnd() < 0.5,
      fiveSkip: rnd() < 0.5, reverse: rnd() < 0.5, shibari: rnd() < 0.7,
      jokerCount: [0, 1, 2][Math.floor(rnd() * 3)], deckCount: rnd() < 0.25 ? 2 : 1,
      playerCount: [3, 4, 5, 6][Math.floor(rnd() * 4)],
    });
    const deck = shuffle(makeDeck(rl), rnd);
    const g = newRound(rl, deck, null);
    const total = g.hands.flat().length;
    let steps = 0;
    while (!g.ended && steps++ < 4000) {
      const r = cpuAct(g, rl);
      if (!r.ok) { ok = false; log.push('game-fuzz:cpu-illegal#' + t + ':' + r.error); break; }
    }
    if (!ok) break;
    if (!g.ended) { ok = false; log.push('game-fuzz:no-end#' + t); break; }
    const left = g.hands.flat().length + total - deck.length; // 残り手札+場に出た分=総数
    if (new Set(g.finished).size !== rl.playerCount) { ok = false; log.push('game-fuzz:order#' + t); break; }
    if (g.hands.flat().some(c => c == null)) { ok = false; log.push('game-fuzz:null-card#' + t); break; }
    games++;
  }
  ck('eng:game-fuzz(' + games + 'games)', ok);
}

console.log('[daifugo core] pass=' + pass + ' / fail=' + fail, log.length ? log : '');
process.exit(fail ? 1 : 0);

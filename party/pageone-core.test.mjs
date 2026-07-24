/* ページワン純コア:
   合法手 / 宣言忘れ / 2重ね最大+8 / 8 / J / Q / Joker / CPU / 順位を検証。 */
import {
  makePageOneDeck, newPageOneRound, pageOneCardPlayable, pageOneLegalCards,
  pageOnePlay, pageOneDraw, pageOneCpuChoose,
} from './pageone-core.js';

let pass = 0, fail = 0;
const ck = (name, cond) => {
  cond ? pass++ : fail++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name);
};
const C = (s, r, id = s * 13 + r - 1) => ({ id, s, r });
const JOKER = id => ({ id, s: 4, r: 0, joker: true });
function fixed(hands, top = C(0, 5, 4), turn = 0) {
  return {
    n: hands.length,
    hands: hands.map(h => h.slice()),
    drawPile: makePageOneDeck().filter(c => !hands.flat().some(h => h.id === c.id) && c.id !== top.id),
    discard: [top],
    activeSuit: top.s,
    turn,
    direction: 1,
    pendingDraw: 0,
    pendingKind: null,
    status: new Array(hands.length).fill('playing'),
    finishOrder: [],
    ranking: [],
    last: null,
    ended: false,
  };
}

ck('54枚デッキ', makePageOneDeck().length === 54 && makePageOneDeck().filter(c => c.joker).length === 2);
const round = newPageOneRound(4, makePageOneDeck());
ck('初期5枚ずつ', round.hands.every(h => h.length === 5));
ck('配札+場札+山札=54', round.hands.flat().length + round.discard.length + round.drawPile.length === 54);
ck('初期場札は特殊札でない', ![0, 2, 8, 11, 12].includes(round.discard[0].r));

{
  const g = fixed([[C(0, 9), C(2, 5), C(1, 7), JOKER(52)], [C(1, 3)], [C(2, 4)]]);
  ck('同スート合法', pageOneCardPlayable(g, g.hands[0][0]));
  ck('同ランク合法', pageOneCardPlayable(g, g.hands[0][1]));
  ck('別スート別ランク不可', !pageOneCardPlayable(g, g.hands[0][2]));
  ck('ジョーカー常時合法', pageOneCardPlayable(g, g.hands[0][3]));
}

{
  const g = fixed([[C(0, 6), C(1, 9)], [C(2, 4)], [C(3, 7)]]);
  const beforeDeck = g.drawPile.length;
  const r = pageOnePlay(g, 0, g.hands[0][0].id, {});
  ck('宣言忘れは即2枚', r.ok && r.pageOneMiss && r.penalty === 2 && g.hands[0].length === 3);
  ck('宣言忘れは公開イベントのみ', g.last.pageOneMiss === true && g.drawPile.length === beforeDeck - 2);
}

{
  const g = fixed([[C(0, 6), C(1, 9)], [C(2, 4)], [C(3, 7)]]);
  const r = pageOnePlay(g, 0, g.hands[0][0].id, { pageOne: true });
  ck('同一action宣言で残り1枚', r.ok && !r.pageOneMiss && g.hands[0].length === 1 && g.last.pageOne);
}

{
  const twos = [C(0, 2), C(1, 2), C(2, 2), C(3, 2)];
  const g = fixed([
    [twos[0], C(0, 9)], [twos[1], C(1, 9)], [twos[2], C(2, 9)], [twos[3], C(3, 9)],
  ], C(0, 5));
  for (let seat = 0; seat < 4; seat++) {
    const r = pageOnePlay(g, seat, twos[seat].id, { pageOne: true });
    ck('2重ね #' + (seat + 1), r.ok && g.pendingDraw === (seat + 1) * 2);
  }
  ck('2重ね上限は実カード4枚=+8', g.pendingDraw === 8 && pageOneLegalCards(g, 0).length === 0);
  const r = pageOneDraw(g, 0, () => 0.5);
  ck('+8をまとめて引いて手番終了', r.ok && r.count === 8 && g.pendingDraw === 0 && g.turn === 1);
}

{
  const g = fixed([[C(0, 8), C(1, 9)], [C(2, 4)], [C(3, 7)]]);
  ck('8はスート指定必須', !pageOnePlay(g, 0, g.hands[0][0].id, {}).ok);
  const r = pageOnePlay(g, 0, g.hands[0][0].id, { suit: 3, pageOne: true });
  ck('8で指定スート同期', r.ok && g.activeSuit === 3);
}

{
  const g = fixed([[C(0, 11), C(1, 9), C(1, 10)], [C(2, 4)], [C(3, 7)], [C(2, 10)]]);
  pageOnePlay(g, 0, g.hands[0][0].id);
  ck('Jは次の1人をskip', g.turn === 2);
}

{
  const g = fixed([[C(0, 12), C(1, 9), C(1, 10)], [C(2, 4)], [C(3, 7)], [C(2, 10)]]);
  pageOnePlay(g, 0, g.hands[0][0].id);
  ck('Qは方向反転して逆隣へ', g.direction === -1 && g.turn === 3);
}

{
  const g = fixed([[JOKER(52), C(1, 9)], [C(2, 4)], [C(3, 7)]]);
  const r = pageOnePlay(g, 0, 52, { suit: 2, pageOne: true });
  ck('ジョーカーは指定スート+4', r.ok && g.pendingDraw === 4 && g.pendingKind === 'joker' && g.activeSuit === 2);
  ck('+4は重ね返し不可', pageOneLegalCards(g, 1).length === 0);
  const d = pageOneDraw(g, 1, () => 0.5);
  ck('ジョーカー+4を引く', d.ok && d.count === 4);
}

{
  const g = fixed([[C(0, 5), C(0, 9), C(0, 11)], [C(1, 5)], [C(2, 5)]]);
  const m = pageOneCpuChoose(g, 0);
  ck('CPUは出せる通常札を特殊札より温存', m.type === 'play' && m.cardId === C(0, 5).id);
}

{
  const g = fixed([[C(0, 6), C(1, 9)], [C(2, 4)], [C(3, 7)]]);
  const m = pageOneCpuChoose(g, 0);
  ck('CPUは残り1枚時に確実に宣言', m.type === 'play' && m.pageOne === true);
}

{
  const g = fixed([[C(0, 6)], [C(2, 6)], [C(3, 6)]]);
  pageOnePlay(g, 0, g.hands[0][0].id);
  pageOnePlay(g, 1, g.hands[1][0].id);
  ck('上がり順+最後を自動最下位', g.ended && g.ranking.join(',') === '0,1,2');
}

console.log(`\n[pageone core] pass=${pass} fail=${fail}`);
if (fail) process.exit(1);

/* ページワン共有コア (クライアント/サーバー共通の純ロジック)。
   採用ルール:
   - 3〜4人、54枚 (通常52+ジョーカー2)、初期5枚。
   - 同じ suit / rank またはジョーカーを出す。出せない時だけ1枚引き、手番終了。
   - 2は次の人へ+2。同スート条件を無視して2を重ねられ、4枚=+8が上限。
   - 8は suit 指定、Jは次の1人をskip、Qは方向反転、ジョーカーは suit 指定+4。
   - +4は重ね返せない。特殊札で上がっても効果を適用する。
   - 2枚から1枚へ出す同一actionで pageOne=true が必要。忘れると即座に2枚引く。
   - 上がり順で順位を決め、最後の1人は自動的に最下位。 */

export const PAGEONE_SUITS = ['♠', '♥', '♦', '♣'];

export function normalizePageOnePlayers(v) {
  return Number(v) === 3 ? 3 : 4;
}

export function makePageOneDeck() {
  const out = [];
  for (let s = 0; s < 4; s++) for (let r = 1; r <= 13; r++) out.push({ id: s * 13 + r - 1, s, r });
  out.push({ id: 52, s: 4, r: 0, joker: true }, { id: 53, s: 4, r: 0, joker: true });
  return out;
}

export function shufflePageOne(cards, rng = Math.random) {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

export function isPageOneJoker(card) {
  return !!(card && (card.joker || card.r === 0));
}

export function sortPageOneHand(cards) {
  return cards.slice().sort((a, b) =>
    Number(isPageOneJoker(a)) - Number(isPageOneJoker(b))
    || a.s - b.s || a.r - b.r || a.id - b.id);
}

function pageOneInitialCard(card) {
  return card && !isPageOneJoker(card) && ![2, 8, 11, 12].includes(card.r);
}

export function newPageOneRound(playerCount, deck = makePageOneDeck()) {
  const n = normalizePageOnePlayers(playerCount);
  const drawPile = deck.slice();
  const hands = Array.from({ length: n }, () => []);
  for (let k = 0; k < 5; k++) {
    for (let seat = 0; seat < n; seat++) {
      const card = drawPile.pop();
      if (card) hands[seat].push(card);
    }
  }
  let topIndex = -1;
  for (let i = drawPile.length - 1; i >= 0; i--) {
    if (pageOneInitialCard(drawPile[i])) { topIndex = i; break; }
  }
  if (topIndex < 0) topIndex = drawPile.length - 1;
  const top = drawPile.splice(topIndex, 1)[0] || null;
  for (let seat = 0; seat < n; seat++) hands[seat] = sortPageOneHand(hands[seat]);
  return {
    n,
    hands,
    drawPile,
    discard: top ? [top] : [],
    activeSuit: top ? top.s : 0,
    turn: 0,
    direction: 1,
    pendingDraw: 0,
    pendingKind: null,
    status: new Array(n).fill('playing'),
    finishOrder: [],
    ranking: [],
    last: null,
    ended: false,
  };
}

export function pageOneTop(g) {
  return g && g.discard && g.discard.length ? g.discard[g.discard.length - 1] : null;
}

export function pageOneCardPlayable(g, card) {
  if (!g || !card || g.ended) return false;
  if (g.pendingDraw > 0) return g.pendingKind === 'two' && card.r === 2 && !isPageOneJoker(card);
  const top = pageOneTop(g);
  return isPageOneJoker(card) || !top || card.s === g.activeSuit || card.r === top.r;
}

export function pageOneLegalCards(g, seat) {
  if (!g || !Number.isInteger(seat) || !g.hands[seat] || g.status[seat] !== 'playing') return [];
  return g.hands[seat].filter(card => pageOneCardPlayable(g, card));
}

function pageOneRefill(g, rng) {
  if (g.drawPile.length || g.discard.length <= 1) return;
  const top = g.discard[g.discard.length - 1];
  g.drawPile = shufflePageOne(g.discard.slice(0, -1), rng);
  g.discard = [top];
}

function pageOneDrawCards(g, seat, count, rng) {
  const cards = [];
  for (let i = 0; i < count; i++) {
    pageOneRefill(g, rng);
    const card = g.drawPile.pop();
    if (!card) break;
    g.hands[seat].push(card);
    cards.push(card);
  }
  g.hands[seat] = sortPageOneHand(g.hands[seat]);
  return cards;
}

function pageOneFinishIfNeeded(g) {
  const active = [];
  for (let seat = 0; seat < g.n; seat++) if (g.status[seat] === 'playing') active.push(seat);
  if (active.length > 1) return false;
  if (active.length === 1) {
    g.status[active[0]] = 'finished';
    g.finishOrder.push(active[0]);
  }
  g.ranking = g.finishOrder.slice();
  g.ended = true;
  return true;
}

function pageOneAdvance(g, from, steps = 1) {
  if (pageOneFinishIfNeeded(g)) return;
  let seat = from;
  for (let step = 0; step < steps; step++) {
    for (let k = 1; k <= g.n; k++) {
      const candidate = (seat + g.direction * k + g.n * 2) % g.n;
      if (g.status[candidate] === 'playing') { seat = candidate; break; }
    }
  }
  g.turn = seat;
}

function validChosenSuit(v) {
  return Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) < 4;
}

export function pageOnePlay(g, seat, cardId, options = {}, rng = Math.random) {
  if (!g || g.ended) return { ok: false, error: 'ゲームは おわっています' };
  if (seat !== g.turn || g.status[seat] !== 'playing') return { ok: false, error: 'あなたの ばんでは ありません' };
  const index = g.hands[seat].findIndex(card => card.id === Number(cardId));
  if (index < 0) return { ok: false, error: 'てふだに ない カードです' };
  const card = g.hands[seat][index];
  if (!pageOneCardPlayable(g, card)) return { ok: false, error: 'そのカードは だせません' };
  const choosesSuit = isPageOneJoker(card) || card.r === 8;
  if (choosesSuit && !validChosenSuit(options.suit)) return { ok: false, error: 'つぎの マークを えらんでください' };

  const before = g.hands[seat].length;
  g.hands[seat].splice(index, 1);
  g.discard.push(card);
  g.activeSuit = choosesSuit ? Number(options.suit) : card.s;

  let steps = 1;
  if (card.r === 2 && !isPageOneJoker(card)) {
    g.pendingDraw += 2;
    g.pendingKind = 'two';
  } else if (isPageOneJoker(card)) {
    g.pendingDraw = 4;
    g.pendingKind = 'joker';
  } else {
    g.pendingDraw = 0;
    g.pendingKind = null;
    if (card.r === 11) steps = 2;
    else if (card.r === 12) g.direction *= -1;
  }

  const pageOneNeeded = before === 2 && g.hands[seat].length === 1;
  const pageOneMiss = pageOneNeeded && options.pageOne !== true;
  const penaltyCards = pageOneMiss ? pageOneDrawCards(g, seat, 2, rng) : [];
  let finishedSeat = null;
  if (!g.hands[seat].length) {
    g.status[seat] = 'finished';
    g.finishOrder.push(seat);
    finishedSeat = seat;
  }
  g.last = {
    seat,
    type: 'play',
    card,
    activeSuit: g.activeSuit,
    pageOne: pageOneNeeded && !pageOneMiss,
    pageOneMiss,
    penalty: penaltyCards.length,
  };
  pageOneAdvance(g, seat, steps);
  return {
    ok: true,
    card,
    pageOneMiss,
    penalty: penaltyCards.length,
    finishedSeat,
    ended: g.ended,
  };
}

export function pageOneDraw(g, seat, rng = Math.random) {
  if (!g || g.ended) return { ok: false, error: 'ゲームは おわっています' };
  if (seat !== g.turn || g.status[seat] !== 'playing') return { ok: false, error: 'あなたの ばんでは ありません' };
  const pending = g.pendingDraw;
  if (!pending && pageOneLegalCards(g, seat).length) return { ok: false, error: 'だせる カードが あります' };
  const kind = g.pendingKind;
  const cards = pageOneDrawCards(g, seat, pending || 1, rng);
  g.pendingDraw = 0;
  g.pendingKind = null;
  g.last = { seat, type: pending ? 'penalty' : 'draw', count: cards.length, penaltyKind: kind };
  pageOneAdvance(g, seat, 1);
  return { ok: true, cards, count: cards.length, penalty: pending, ended: g.ended };
}

function pageOneBestSuit(hand, fallback = 0) {
  const counts = [0, 0, 0, 0];
  for (const card of hand) if (!isPageOneJoker(card) && card.s >= 0 && card.s < 4) counts[card.s]++;
  let best = fallback >= 0 && fallback < 4 ? fallback : 0;
  for (let suit = 0; suit < 4; suit++) if (counts[suit] > counts[best]) best = suit;
  return best;
}

function pageOneSpecialCost(card) {
  if (isPageOneJoker(card)) return 1000;
  if (card.r === 2) return 300;
  if (card.r === 8) return 220;
  if (card.r === 11) return 140;
  if (card.r === 12) return 130;
  return 0;
}

export function pageOneCpuChoose(g, seat) {
  const legal = pageOneLegalCards(g, seat);
  if (!legal.length) return { type: 'draw' };
  const hand = g.hands[seat];
  const ranked = legal.map(card => {
    const rest = hand.filter(c => c.id !== card.id);
    const suit = pageOneBestSuit(rest, isPageOneJoker(card) ? g.activeSuit : card.s);
    const keptSuitCount = rest.filter(c => !isPageOneJoker(c) && c.s === (card.r === 8 || isPageOneJoker(card) ? suit : card.s)).length;
    return { card, suit, keptSuitCount, cost: pageOneSpecialCost(card) };
  }).sort((a, b) =>
    a.cost - b.cost
    || b.keptSuitCount - a.keptSuitCount
    || a.card.r - b.card.r
    || a.card.id - b.card.id);
  const best = ranked[0];
  return {
    type: 'play',
    cardId: best.card.id,
    suit: (best.card.r === 8 || isPageOneJoker(best.card)) ? best.suit : undefined,
    pageOne: hand.length === 2,
  };
}

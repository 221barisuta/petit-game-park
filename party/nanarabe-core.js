/* 七並べ 共有コア (クライアント/サーバー共通の純ロジック)。
   カード: {id:0..51,s:0..3,r:1..13} / suit順 ♠♥♦♣。
   7は配札直後に場へ置く。場のカードと同じ suit の両隣だけを出せる。
   パス3回で脱落し、残り手札はすべて公開して場へ強制配置する。 */

export const NANA_SUITS = ['♠', '♥', '♦', '♣'];

export function normalizeNanaPlayers(v) {
  return Number(v) === 3 ? 3 : 4;
}

export function makeNanaDeck() {
  const out = [];
  for (let s = 0; s < 4; s++) for (let r = 1; r <= 13; r++) out.push({ id: s * 13 + r - 1, s, r });
  return out;
}

export function shuffleNana(cards, rng = Math.random) {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

export function sortNanaHand(cards) {
  return cards.slice().sort((a, b) => a.s - b.s || a.r - b.r || a.id - b.id);
}

export function newNanaRound(playerCount, deck = makeNanaDeck()) {
  const n = normalizeNanaPlayers(playerCount);
  const hands = Array.from({ length: n }, () => []);
  deck.forEach((c, i) => hands[i % n].push(c));
  const board = Array.from({ length: 4 }, () => new Array(13).fill(null));
  for (let seat = 0; seat < n; seat++) {
    const keep = [];
    for (const c of hands[seat]) {
      if (c.r === 7) board[c.s][6] = c;
      else keep.push(c);
    }
    hands[seat] = sortNanaHand(keep);
  }
  const status = new Array(n).fill('playing');
  const finishOrder = [];
  for (let seat = 0; seat < n; seat++) {
    if (!hands[seat].length) { status[seat] = 'finished'; finishOrder.push(seat); }
  }
  const first = status.findIndex(v => v === 'playing');
  const g = {
    n, hands, board, turn: first < 0 ? 0 : first,
    passes: new Array(n).fill(0),
    status,
    finishOrder,
    eliminationOrder: [],
    ranking: [],
    last: null,
    ended: first < 0,
  };
  if (g.ended) g.ranking = finishOrder.slice();
  return g;
}

export function nanaCardPlayable(g, card) {
  if (!g || !card || card.r === 7 || !g.board[card.s] || g.board[card.s][card.r - 1]) return false;
  const left = card.r > 1 && g.board[card.s][card.r - 2];
  const right = card.r < 13 && g.board[card.s][card.r];
  return !!(left || right);
}

export function nanaLegalCards(g, seat) {
  if (!g || !Number.isInteger(seat) || !g.hands[seat] || g.status[seat] !== 'playing') return [];
  return g.hands[seat].filter(c => nanaCardPlayable(g, c));
}

function nanaFinish(g) {
  const active = g.status.filter(v => v === 'playing').length;
  if (active) return false;
  g.ended = true;
  // 上がった人が先。脱落者同士は、より長く残った人を上位にする。
  g.ranking = g.finishOrder.concat(g.eliminationOrder.slice().reverse());
  return true;
}

function nanaAdvance(g, from) {
  if (nanaFinish(g)) return;
  for (let k = 1; k <= g.n; k++) {
    const seat = (from + k) % g.n;
    if (g.status[seat] === 'playing') { g.turn = seat; return; }
  }
}

export function nanaPlay(g, seat, cardId) {
  if (!g || g.ended) return { ok: false, error: 'ゲームは おわっています' };
  if (seat !== g.turn || g.status[seat] !== 'playing') return { ok: false, error: 'あなたの ばんでは ありません' };
  const i = g.hands[seat].findIndex(c => c.id === Number(cardId));
  if (i < 0) return { ok: false, error: 'てふだに ない カードです' };
  const card = g.hands[seat][i];
  if (!nanaCardPlayable(g, card)) return { ok: false, error: 'そのカードは まだ だせません' };
  g.hands[seat].splice(i, 1);
  g.board[card.s][card.r - 1] = card;
  g.last = { seat, type: 'play', card };
  let finishedSeat = null;
  if (!g.hands[seat].length) {
    g.status[seat] = 'finished';
    g.finishOrder.push(seat);
    finishedSeat = seat;
  }
  nanaAdvance(g, seat);
  return { ok: true, card, finishedSeat, ended: g.ended };
}

export function nanaPass(g, seat) {
  if (!g || g.ended) return { ok: false, error: 'ゲームは おわっています' };
  if (seat !== g.turn || g.status[seat] !== 'playing') return { ok: false, error: 'あなたの ばんでは ありません' };
  g.passes[seat]++;
  let eliminatedSeat = null;
  const revealed = [];
  if (g.passes[seat] >= 3) {
    eliminatedSeat = seat;
    g.status[seat] = 'eliminated';
    g.eliminationOrder.push(seat);
    for (const card of g.hands[seat]) {
      g.board[card.s][card.r - 1] = card;
      revealed.push(card);
    }
    g.hands[seat] = [];
  }
  g.last = { seat, type: 'pass', revealed: revealed.slice() };
  nanaAdvance(g, seat);
  return { ok: true, eliminatedSeat, revealed, ended: g.ended };
}

export function nanaCpuChoose(g, seat, rng = Math.random) {
  const legal = nanaLegalCards(g, seat);
  if (!legal.length) return { type: 'pass' };
  const hand = g.hands[seat];
  const ownsOutward = c => {
    const r = c.r < 7 ? c.r - 1 : c.r + 1;
    return r >= 1 && r <= 13 && hand.some(h => h.s === c.s && h.r === r);
  };
  // 7から遠い端札を後に残し、次の外側も自分が持つ列を優先して主導権を保つ。
  legal.sort((a, b) =>
    (Math.abs(a.r - 7) * 10 - (ownsOutward(a) ? 3 : 0))
    - (Math.abs(b.r - 7) * 10 - (ownsOutward(b) ? 3 : 0))
    || a.s - b.s || a.r - b.r);
  const best = legal[0];
  // 戦略パスは最初の1回だけ。残り2回は詰まり用に温存し、脱落リスクを避ける。
  if (g.passes[seat] === 0 && hand.length > 4 && Math.abs(best.r - 7) >= 4 && rng() < 0.35)
    return { type: 'pass' };
  return { type: 'play', cardId: best.id };
}

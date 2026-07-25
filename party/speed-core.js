/* スピード共有コア（クライアント / サーバー共通）。
   カード: {id:0..51,s:0..3,r:1..13}。A(1) と K(13) は隣接する。
   各自26枚を 場札4 + 初期台札1 + 伏せ山21 に分ける。 */

export const SPEED_SUITS = ['♠', '♥', '♦', '♣'];

export function makeSpeedDeck() {
  const out = [];
  for (let s = 0; s < 4; s++)
    for (let r = 1; r <= 13; r++) out.push({ id: s * 13 + r - 1, s, r });
  return out;
}

export function shuffleSpeed(cards, rng = Math.random) {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

export function speedRanksAdjacent(a, b) {
  const d = Math.abs(Number(a) - Number(b));
  return d === 1 || d === 12;
}

export function newSpeedRound(deck = makeSpeedDeck()) {
  if (!Array.isArray(deck) || deck.length !== 52) throw new Error('speed deck must contain 52 cards');
  const halves = [deck.slice(0, 26), deck.slice(26, 52)];
  const fields = halves.map(cards => cards.slice(0, 4));
  const centers = halves.map(cards => [cards[4]]);
  const stocks = halves.map(cards => cards.slice(5));
  return {
    stocks,
    fields,
    centers,
    pileVersions: [0, 0],
    ready: [false, false],
    last: { type: 'start', cards: centers.map(p => p[p.length - 1]) },
    ended: false,
    result: null,
  };
}

export function speedTop(g, pile) {
  const p = g && g.centers && g.centers[pile];
  return Array.isArray(p) && p.length ? p[p.length - 1] : null;
}

export function speedCardPlayable(g, card, pile) {
  const top = speedTop(g, pile);
  return !!(card && top && speedRanksAdjacent(card.r, top.r));
}

export function speedLegalMoves(g, seat) {
  if (!g || g.ended || (seat !== 0 && seat !== 1) || !Array.isArray(g.fields[seat])) return [];
  const out = [];
  for (let slot = 0; slot < g.fields[seat].length; slot++) {
    const card = g.fields[seat][slot];
    if (!card) continue;
    for (let pile = 0; pile < 2; pile++)
      if (speedCardPlayable(g, card, pile)) out.push({ slot, pile, cardId: card.id });
  }
  return out;
}

export function speedStuck(g) {
  return !!(g && !g.ended && speedLegalMoves(g, 0).length === 0 && speedLegalMoves(g, 1).length === 0);
}

export function speedCanShowdown(g) {
  return speedStuck(g) && g.stocks.some(stock => stock.length > 0);
}

function finishIfExhausted(g, seat) {
  if (g.stocks[seat].length || g.fields[seat].some(Boolean)) return false;
  g.ended = true;
  g.result = { winner: seat };
  return true;
}

function finishDeadlock(g) {
  if (!speedStuck(g) || g.stocks.some(stock => stock.length)) return false;
  g.ended = true;
  g.result = { draw: true, reason: 'deadlock' };
  return true;
}

export function speedPlay(g, seat, slot, pile, expectedVersion) {
  if (!g || g.ended) return { ok: false, error: 'ゲームは おわっています', code: 'ended' };
  if (seat !== 0 && seat !== 1) return { ok: false, error: 'かんせん中は だせません', code: 'spectator' };
  slot = Number(slot); pile = Number(pile);
  if (!Number.isInteger(slot) || slot < 0 || slot >= 4 || !Number.isInteger(pile) || pile < 0 || pile >= 2)
    return { ok: false, error: 'カードか 台札が ただしくありません', code: 'range' };
  if (Number(expectedVersion) !== g.pileVersions[pile])
    return { ok: false, error: '相手のカードが ひと足さきでした', code: 'stale' };
  const card = g.fields[seat][slot];
  if (!card) return { ok: false, error: 'そのカードは もう ありません', code: 'missing' };
  if (!speedCardPlayable(g, card, pile))
    return { ok: false, error: 'その台札には だせません', code: 'rank' };

  g.centers[pile].push(card);
  g.pileVersions[pile]++;
  const replacement = g.stocks[seat].length ? g.stocks[seat].shift() : null;
  g.fields[seat][slot] = replacement;
  g.ready = [false, false];
  g.last = {
    type: 'play', seat, slot, pile, card,
    replacement: replacement ? { seat, slot } : null,
    pileVersion: g.pileVersions[pile],
  };
  const won = finishIfExhausted(g, seat);
  if (!won) finishDeadlock(g);
  return { ok: true, card, replacement, won, ended: g.ended, result: g.result };
}

export function speedReady(g, seat) {
  if (!g || g.ended) return { ok: false, error: 'ゲームは おわっています', code: 'ended' };
  if (seat !== 0 && seat !== 1) return { ok: false, error: 'かんせん中は おせません', code: 'spectator' };
  if (!speedCanShowdown(g)) return { ok: false, error: 'まだ だせるカードが あります', code: 'not-stuck' };
  g.ready[seat] = true;
  if (!g.ready[0] || !g.ready[1]) return { ok: true, updated: false };

  const cards = [null, null];
  for (let pile = 0; pile < 2; pile++) {
    if (!g.stocks[pile].length) continue;
    const card = g.stocks[pile].shift();
    g.centers[pile].push(card);
    g.pileVersions[pile]++;
    cards[pile] = card;
  }
  g.ready = [false, false];
  g.last = { type: 'showdown', cards, pileVersions: g.pileVersions.slice() };
  finishDeadlock(g);
  return { ok: true, updated: true, cards, ended: g.ended, result: g.result };
}

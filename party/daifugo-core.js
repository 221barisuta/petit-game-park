/* 大富豪 共有コアロジック (クライアント=index.html / サーバー=party/daifugo-server.js で一致させる)
   ──────────────────────────────────────────────────────────
   設計方針(優先度S):
   - ルールは RULE_DEFS(定義テーブル)+rules(設定オブジェクト)で一元管理。
     ロジックは rules を引数に取る純関数で、個別ルールの if-else を各所に散在させない。
   - 特殊効果(8切り/革命/11バック/5飛び/9リバース)は EFFECT_DEFS の
     宣言的パイプラインで適用する (ルール追加=テーブルに1行追加)。
   - 強弱比較は strengthOf() 1箇所のみ。革命/11バックは inverted フラグ(XOR)で反転。
   - index.html を正本とし、本ファイルへ verbatim でコピーする。
     一致は party/daifugo-parity.test.mjs が機械的に検証する。

   カード表現: {id:number, r:number, s:number}
     r: 3..10, 11=J, 12=Q, 13=K, 14=A, 15=2, 99=ジョーカー
     s: 0=♠ 1=♥ 2=♦ 3=♣, ジョーカーは -1
   役(analyzeHand の戻り): {type:'single'|'set'|'stairs', n, rank, suits, jokers, ranks}
     rank=比較用の代表ランク(階段は最上位) / ranks=実カードのランク(効果判定用。ジョーカー除く)
     suits=非ジョーカーのスート配列(縛り判定用) */

// ── ルール定義テーブル (設定UI・正規化・デフォルトの単一ソース) ──
export const RULE_DEFS = [
  { key: 'revolution',   label: 'かくめい',       type: 'bool',   def: true },
  { key: 'eightCut',     label: '8ぎり',          type: 'bool',   def: true },
  { key: 'shibari',      label: 'しばり',         type: 'bool',   def: true },
  { key: 'stairs',       label: 'かいだん',       type: 'bool',   def: false },
  { key: 'spade3Return', label: 'スペ3がえし',    type: 'bool',   def: false },
  { key: 'elevenBack',   label: '11バック',       type: 'bool',   def: false },
  { key: 'fiveSkip',     label: '5とび',          type: 'bool',   def: false },
  { key: 'reverse',      label: '9リバース',      type: 'bool',   def: false },
  { key: 'cardExchange', label: 'カードこうかん', type: 'bool',   def: true },
  { key: 'fillWithCPU',  label: 'あきせきCPU',    type: 'bool',   def: true },
  { key: 'jokerCount',   label: 'ジョーカー',     type: 'select', opts: [0, 1, 2], def: 1 },
  { key: 'deckCount',    label: 'トランプ',       type: 'select', opts: [1, 2], def: 1 },
  { key: 'playerCount',  label: 'プレイ人数',     type: 'select', opts: [3, 4, 5, 6], def: 5 },
];
export function defaultRules() {
  const o = {};
  for (const d of RULE_DEFS) o[d.key] = d.def;
  return o;
}
// 保存データ/受信データを検証付きで正規化 (不正値はデフォルトへ)。副作用なし
export function normalizeRules(src) {
  const o = defaultRules();
  if (!src || typeof src !== 'object') return o;
  for (const d of RULE_DEFS) {
    const v = src[d.key];
    if (v === undefined) continue;
    if (d.type === 'bool') o[d.key] = !!v;
    else if (d.type === 'select' && d.opts.includes(v)) o[d.key] = v;
  }
  return o;
}

// ── 山札 ─────────────────────────────────────────────────
export function makeDeck(rules) {
  const deck = []; let id = 0;
  for (let dk = 0; dk < rules.deckCount; dk++)
    for (let s = 0; s < 4; s++)
      for (let r = 3; r <= 15; r++) deck.push({ id: id++, r, s });
  for (let j = 0; j < rules.jokerCount * rules.deckCount; j++) deck.push({ id: id++, r: 99, s: -1 });
  return deck;
}
// Fisher-Yates。rand は 0<=x<1 の注入可能な乱数 (テスト決定化用)
export function shuffle(arr, rand) {
  const a = arr.slice(); rand = rand || Math.random;
  for (let i = a.length - 1; i > 0; i--) { const k = Math.floor(rand() * (i + 1)); const t = a[i]; a[i] = a[k]; a[k] = t; }
  return a;
}
export function dealHands(deck, n) {
  const hands = Array.from({ length: n }, () => []);
  deck.forEach((c, i) => hands[i % n].push(c));
  return hands;
}

// ── 強弱 (唯一の比較点) ──────────────────────────────────
// inverted = 革命 XOR 11バック。ジョーカーは常に最強 (スペ3返しは canFollow の特例)
export function strengthOf(r, inverted) {
  if (r === 99) return 99;
  return inverted ? 18 - r : r; // 3..15 ⇔ 15..3
}
export function isInverted(st) { return !!st.revolution !== !!st.elevenBack; }
// 手札の表示順ソート (弱→強)。同ランクはスート順
export function sortHand(cards, inverted) {
  return cards.slice().sort((a, b) =>
    strengthOf(a.r, inverted) - strengthOf(b.r, inverted) || a.s - b.s || a.id - b.id);
}

// ── 役判定 (純関数) ──────────────────────────────────────
export function analyzeHand(cards, rules) {
  if (!Array.isArray(cards) || !cards.length) return null;
  const n = cards.length;
  const jokers = cards.filter(c => c.r === 99);
  const normals = cards.filter(c => c.r !== 99).slice().sort((a, b) => a.r - b.r);
  const ranks = normals.map(c => c.r), suits = normals.map(c => c.s);
  if (n === 1) {
    const c = cards[0];
    return { type: 'single', n: 1, rank: c.r, suits: c.r === 99 ? [] : [c.s], jokers: jokers.length, ranks };
  }
  // セット: 同ランク複数 (ジョーカーはワイルド補充。全ジョーカーは rank=99)
  if (normals.every(c => c.r === normals[0].r)) {
    const rank = normals.length ? normals[0].r : 99;
    return { type: 'set', n, rank, suits, jokers: jokers.length, ranks };
  }
  // 階段: 同スート連番 n>=3 (ジョーカーが隙間を埋める。余りは上へ延長、上限15を超えたら下へ)
  if (rules.stairs && n >= 3 && normals.length && suits.every(s => s === suits[0])) {
    const uq = [...new Set(ranks)];
    if (uq.length !== ranks.length) return null;             // 同ランク重複は階段不可
    const min = uq[0], max = uq[uq.length - 1];
    const gaps = (max - min + 1) - uq.length;
    if (gaps > jokers.length) return null;
    let extra = jokers.length - gaps;
    const up = Math.min(extra, 15 - max), top = max + up, bottom = min - (extra - up);
    if (bottom < 3) return null;
    return { type: 'stairs', n, rank: top, suits: [suits[0]], jokers: jokers.length, ranks };
  }
  return null;
}

// ── 特殊効果パイプライン (宣言的テーブル。ルール追加はここに1行) ──
// when(hand) が真なら apply(fx,hand)。rules[rule] が OFF なら評価しない
const EFFECT_DEFS = [
  { rule: 'eightCut',   when: h => h.ranks.includes(8),  apply: fx => { fx.flow = true; } },
  { rule: 'revolution', when: h => h.type === 'set' && h.n >= 4, apply: fx => { fx.revolution = true; } },
  { rule: 'elevenBack', when: h => h.ranks.includes(11), apply: fx => { fx.elevenBack = true; } },
  { rule: 'fiveSkip',   when: h => h.ranks.includes(5),  apply: (fx, h) => { fx.skip += h.ranks.filter(r => r === 5).length; } },
  { rule: 'reverse',    when: h => h.ranks.includes(9),  apply: fx => { fx.reverse = true; } },
];
// 着手の発動効果を返す (盤面は変更しない純関数)
// flow=場流れ / revolution=革命トグル / elevenBack=場が流れるまで逆転 / skip=n人飛ばし / reverse=場が流れるまで逆回り
export function playEffects(hand, rules) {
  const fx = { flow: false, revolution: false, elevenBack: false, skip: 0, reverse: false };
  for (const d of EFFECT_DEFS) if (rules[d.rule] && d.when(hand)) d.apply(fx, hand);
  return fx;
}

// ── 追従判定 (純関数) ─────────────────────────────────────
// top=場の役(null=場が空) / next=出す役 / ctx={inverted,lock}
export function canFollow(top, next, ctx, rules) {
  if (!next) return false;
  if (!suitsOkForLock(next, ctx.lock)) return false;
  if (!top) return true; // 場が空なら任意の役
  // スペ3返し: 単騎ジョーカーに ♠3 単騎で勝てる (強弱の特例)
  if (rules.spade3Return && top.type === 'single' && top.rank === 99
    && next.type === 'single' && next.rank === 3 && next.suits[0] === 0) return true;
  if (top.type !== next.type || top.n !== next.n) return false;
  return strengthOf(next.rank, ctx.inverted) > strengthOf(top.rank, ctx.inverted);
}
// 縛り: lock(スート多重集合)へ非ジョーカーのスートが全て収まるか (ジョーカーはワイルド)
export function suitsOkForLock(hand, lock) {
  if (!lock) return true;
  const need = lock.slice();
  for (const s of hand.suits) { const i = need.indexOf(s); if (i < 0) return false; need.splice(i, 1); }
  return true;
}
// 縛りの成立/維持: 直前役と同スート構成が連続したら lock 成立。成立後は場が流れるまで維持
export function nextLock(prevTop, played, lock, rules) {
  if (!rules.shibari) return null;
  if (lock) return lock;
  if (!prevTop) return null;
  const a = prevTop.suits.slice().sort(), b = played.suits.slice().sort();
  if (a.length && a.length === b.length && a.every((v, i) => v === b[i])) return b;
  return null;
}

// ── 合法手生成 (CPU/アシスト/サーバー検証用。純関数) ─────
export function legalMoves(hand, top, ctx, rules) {
  const cand = [];
  const jokers = hand.filter(c => c.r === 99);
  const byRank = new Map();
  for (const c of hand) if (c.r !== 99) { if (!byRank.has(c.r)) byRank.set(c.r, []); byRank.get(c.r).push(c); }
  for (const c of hand) cand.push([c]); // シングル
  // セット: 自然札prefix+ジョーカー補充 (スート組合せの全列挙はしない=CPU用途に十分)
  for (const cs of byRank.values())
    for (let k = 2; k <= cs.length + jokers.length; k++) {
      const take = Math.min(k, cs.length), need = k - take;
      if (need > jokers.length) continue;
      cand.push([...cs.slice(0, take), ...jokers.slice(0, need)]);
    }
  if (jokers.length >= 2) cand.push(jokers.slice(0, 2)); // ジョーカーペア
  // 階段: スートごとの窓走査+ジョーカー補充
  if (rules.stairs) {
    const bySuit = new Map();
    for (const c of hand) if (c.r !== 99) { if (!bySuit.has(c.s)) bySuit.set(c.s, []); bySuit.get(c.s).push(c); }
    for (const cs0 of bySuit.values()) {
      const cs = [...new Map(cs0.map(c => [c.r, c])).values()].sort((a, b) => a.r - b.r);
      for (let i = 0; i < cs.length; i++) for (let j = i; j < cs.length; j++) {
        const seg = cs.slice(i, j + 1);
        const span = seg[seg.length - 1].r - seg[0].r + 1, need = span - seg.length;
        if (need > jokers.length) continue;
        for (let extra = 0; need + extra <= jokers.length; extra++) {
          if (span + extra < 3) continue;
          cand.push([...seg, ...jokers.slice(0, need + extra)]);
        }
      }
    }
  }
  const seen = new Set(), out = [];
  for (const mv of cand) {
    const key = mv.map(c => c.id).sort((x, y) => x - y).join(',');
    if (seen.has(key)) continue; seen.add(key);
    const a = analyzeHand(mv, rules);
    if (a && canFollow(top, a, ctx, rules)) out.push({ cards: mv, hand: a });
  }
  return out;
}

// ── CPU (ルールベース簡易戦略) ────────────────────────────
// 弱い手から出す / ジョーカーは温存 / 場が空なら多枚数の弱い役で手札を減らす。手なし/温存判断は null(=パス)
export function cpuChoose(hand, top, ctx, rules) {
  const ms = legalMoves(hand, top, ctx, rules);
  if (!ms.length) return null;
  ms.sort((A, B) =>
    A.hand.jokers - B.hand.jokers
    || strengthOf(A.hand.rank, ctx.inverted) - strengthOf(B.hand.rank, ctx.inverted)
    || B.hand.n - A.hand.n);
  const best = ms[0];
  if (top && best.hand.jokers > 0 && hand.length > 4) return null; // ジョーカー温存パス
  return best;
}

// ── 称号 (上がり順→大富豪..大貧民) ───────────────────────
export function titlesFor(n) {
  const t = {
    3: ['大富豪', '平民', '大貧民'],
    4: ['大富豪', '富豪', '貧民', '大貧民'],
    5: ['大富豪', '富豪', '平民', '貧民', '大貧民'],
    6: ['大富豪', '富豪', '平民', '平民', '貧民', '大貧民'],
  };
  return t[n] || t[5];
}
// カード交換の枚数ペア: [[与える側(上位), 受ける側(下位), 枚数], ...]
export function exchangePairs(n) {
  return n >= 4 ? [[0, n - 1, 2], [1, n - 2, 1]] : [[0, n - 1, 2]];
}

/* ── ラウンド進行エンジン (サーバー権威/ローカルCPU対戦で共用する純関数群) ──
   g(ラウンド状態) = {
     n, hands:[[card]..], field:{top,cards,owner,lock}, st:{revolution,elevenBack,reverse},
     turn, passes(連続パス数), passed:[bool](表示用), finished:[seat..], ended
   }
   パスは「一時パス」方式: 誰かが着手すると解除。連続パスが(親以外の)全生存者に達したら場流れ。
   9リバース/11バックは場が流れるまで。革命は永続(再革命で戻る)。 */
export function newRound(rules, deck, leader) {
  const n = rules.playerCount;
  const hands = dealHands(deck, n).map(h => sortHand(h, false));
  let turn = leader;
  if (turn == null || turn < 0 || turn >= n) { // 初回は ♦3 保持者が親 (いなければ席0)
    turn = 0;
    for (let i = 0; i < n; i++) if (hands[i].some(c => c.r === 3 && c.s === 2)) { turn = i; break; }
  }
  return {
    n, hands,
    field: { top: null, cards: [], owner: null, lock: null },
    st: { revolution: false, elevenBack: false, reverse: false },
    turn, passes: 0, passed: Array(n).fill(false), finished: [], ended: false,
  };
}
export function ctxOf(g) { return { inverted: isInverted(g.st), lock: g.field.lock }; }
function aliveList(g) { const a = []; for (let i = 0; i < g.n; i++) if (!g.finished.includes(i)) a.push(i); return a; }
// from から steps 人ぶん、生存席だけを回して進める (dir は 9リバース反映)
export function nextAliveSeat(g, from, steps) {
  const dir = g.st.reverse ? -1 : 1;
  let i = from, guard = 0;
  while (steps > 0 && guard++ < 200) {
    i = (i + dir + g.n) % g.n;
    if (!g.finished.includes(i)) steps--;
  }
  return i;
}
function flowField(g) {
  g.field = { top: null, cards: [], owner: null, lock: null };
  g.st.elevenBack = false; g.st.reverse = false;   // 場が流れるまでの効果を解除
  g.passes = 0; g.passed = g.passed.map(() => false);
}
// 着手(cards)/パス(cards=null)を適用。戻り {ok, error?, fx?, flowed, finishedSeat?, ended}
export function applyAction(g, seat, cards, rules) {
  if (g.ended) return { ok: false, error: 'すでに しゅうりょう しています' };
  if (seat !== g.turn) return { ok: false, error: 'あなたの ばんでは ありません' };
  // ── パス ──
  if (!cards || !cards.length) {
    if (!g.field.top) return { ok: false, error: 'おやは パスできません' };
    g.passes++; g.passed[seat] = true;
    const ownerAlive = g.field.owner != null && !g.finished.includes(g.field.owner);
    const threshold = aliveList(g).length - (ownerAlive ? 1 : 0);
    if (g.passes >= threshold) { // 親以外の全生存者がパス → 場流れ。親(上がり済なら次の生存者)が親に
      const leader = ownerAlive ? g.field.owner : nextAliveSeat(g, g.field.owner, 1);
      flowField(g); g.turn = leader;
      return { ok: true, fx: null, flowed: true, ended: false };
    }
    g.turn = nextAliveSeat(g, seat, 1);
    return { ok: true, fx: null, flowed: false, ended: false };
  }
  // ── 着手 (権威検証: 手札に実在 / 役成立 / 追従可能) ──
  const hand = g.hands[seat];
  if (!cards.every(c => hand.some(h => h.id === c.id))) return { ok: false, error: 'てふだに ない カードです' };
  const a = analyzeHand(cards, rules);
  if (!a) return { ok: false, error: 'その くみあわせは だせません' };
  if (!canFollow(g.field.top, a, ctxOf(g), rules)) return { ok: false, error: 'その てでは かてません' };
  g.hands[seat] = hand.filter(h => !cards.some(c => c.id === h.id));
  const fx = playEffects(a, rules);
  g.field = { top: a, cards: cards.slice(), owner: seat, lock: nextLock(g.field.top, a, g.field.lock, rules) };
  if (fx.revolution) g.st.revolution = !g.st.revolution;
  if (fx.elevenBack) g.st.elevenBack = true;
  if (fx.reverse) g.st.reverse = !g.st.reverse;
  g.passes = 0; g.passed = g.passed.map(() => false); // 着手でパスは解除(一時パス方式)
  // ── 上がり判定 ──
  let finishedSeat;
  if (!g.hands[seat].length) {
    g.finished.push(seat); finishedSeat = seat;
    if (g.finished.length >= g.n - 1) { // 残り1人 → 終局。最後の1人を末尾に
      for (let i = 0; i < g.n; i++) if (!g.finished.includes(i)) g.finished.push(i);
      g.ended = true;
      return { ok: true, fx, flowed: false, finishedSeat, ended: true };
    }
  }
  // ── 手番送り: 8切り=流して同じ人が親 / 5飛びは生存席を余分に進める ──
  if (fx.flow) {
    flowField(g);
    g.turn = g.finished.includes(seat) ? nextAliveSeat(g, seat, 1) : seat;
    return { ok: true, fx, flowed: true, finishedSeat, ended: false };
  }
  g.turn = nextAliveSeat(g, seat, 1 + fx.skip);
  return { ok: true, fx, flowed: false, finishedSeat, ended: false };
}
// CPUの1手 (cpuChoose→applyAction)。戻りは applyAction と同じ
export function cpuAct(g, rules) {
  const mv = cpuChoose(g.hands[g.turn], g.field.top, ctxOf(g), rules);
  return applyAction(g, g.turn, mv ? mv.cards : null, rules);
}
// カード交換 (2局目以降・自動): 下位は最強k枚を上位へ、上位は最弱k枚を下位へ。prevOrder=前局のfinished
export function applyExchange(g, prevOrder, rules) {
  if (!rules.cardExchange || !prevOrder || prevOrder.length !== g.n) return [];
  const moves = [];
  for (const [hi, lo, k] of exchangePairs(g.n)) {
    const rich = prevOrder[hi], poor = prevOrder[lo];
    if (rich == null || poor == null || rich === poor) continue;
    const give = sortHand(g.hands[poor], false).slice(-k);          // 下位→最強k枚
    const back = sortHand(g.hands[rich], false).slice(0, k);        // 上位→最弱k枚 (簡易自動)
    g.hands[poor] = g.hands[poor].filter(c => !give.includes(c)).concat(back);
    g.hands[rich] = g.hands[rich].filter(c => !back.includes(c)).concat(give);
    moves.push({ rich, poor, k });
  }
  for (let i = 0; i < g.n; i++) g.hands[i] = sortHand(g.hands[i], false);
  return moves;
}

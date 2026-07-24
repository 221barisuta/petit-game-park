/* 大富豪 オンライン対戦 PartyKit サーバー (部屋=1 Party = 1 Durable Object)
   ──────────────────────────────────────────────────────────
   - ゲーム進行は daifugo-core.js の純関数(newRound/applyAction/cpuChoose)に委譲。
     サーバーは「席・接続・権威検証・配信」だけを担当する。
   - 手札はサーバーのみが保持。state_sync では各接続に
     「自分の手札 + 他プレイヤーの残枚数」だけを送る (チート防止)。
   - 部屋の定員 = rules.playerCount。ホスト(最初の入室者)がロビーでルール変更/開始。
   - fillWithCPU: 開始時に空席をCPUで埋める。CPUの手番はサーバー側で連鎖処理。
   - 切断: 60秒猶予(GRACE_MS)。ロビー中は席解放 / 対局中はCPUが代打ち。
     同トークンで再接続すれば同じ席・手札に復帰してCPU代打ちを解除。

   メッセージ (JSON):
     client→server: hello{token?,name} / setRule{key,val}(ホスト・ロビーのみ) / start(ホスト)
                    play{ids:[cardId..]} / pass / again(ホスト・次ラウンド) / leave / rename{name}
     server→client: assigned{seat,token} / state{...(per-conn tailored)} / toast{msg} / error{msg} */
import {
  normalizeRules, defaultRules, makeDeck, shuffle, titlesFor,
  newRound, applyAction, cpuChoose, ctxOf, applyExchange,
} from './daifugo-core.js';
import { hiddenHandState, sendProjectedState, broadcastProjectedState } from './private-state.js';

const GRACE_MS = 60000; // 切断猶予: 再接続が無ければ ロビー=席解放 / 対局中=CPU代打ち

function sanitizeName(v) {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 12);
  return s || 'ゲスト';
}
function freshGame() {
  const rules = defaultRules();
  return {
    phase: 'lobby',                                     // 'lobby' | 'playing' | 'ended'
    rules,
    seats: new Array(rules.playerCount).fill(null),     // {token,name,disc,pid,cpu} | null
    round: null,                                        // daifugo-core の g (playing/ended 中のみ)
    gameNo: 0,
    lastRanks: null,                                    // 前局の finished (カード交換/親決め用)
  };
}

export default class DaifugoServer {
  constructor(room) {
    this.room = room;
    this.game = null;
  }

  async onStart() {
    const g = (await this.room.storage.get('game')) || freshGame();
    g.rules = normalizeRules(g.rules);
    if (!Array.isArray(g.seats)) g.seats = new Array(g.rules.playerCount).fill(null);
    this.game = g;
  }
  async save() { await this.room.storage.put('game', this.game); }

  now() { return Date.now(); }               // テストで時刻注入
  rand() { return Math.random(); }           // テストで乱数注入 (シャッフル決定化)

  hostSeat() { // ホスト = 最小indexの人間席
    const g = this.game;
    for (let i = 0; i < g.seats.length; i++) if (g.seats[i] && !g.seats[i].cpu) return i;
    return -1;
  }
  humanCount() { return this.game.seats.filter(s => s && !s.cpu).length; }

  // ── 接続/切断 ───────────────────────────────────────────
  onConnect(conn) { this.sendState(conn); }
  async onClose(conn) {
    const st = conn && conn.state;
    if (st && st.seat >= 0 && st.token) {
      const seat = this.game.seats[st.seat];
      if (seat && seat.token === st.token && !this.liveTokens(conn.id).has(st.token)) {
        seat.disc = this.now();
        await this.save();
        await this.scheduleAlarm();
      }
    }
    this.broadcastState();
  }
  onError() { this.broadcastState(); }

  liveTokens(excludeId) {
    const set = new Set();
    for (const c of this.room.getConnections()) {
      if (excludeId && c.id === excludeId) continue;
      const cs = c.state;
      if (cs && cs.seat >= 0 && cs.token) set.add(cs.token);
    }
    return set;
  }
  async scheduleAlarm() {
    const g = this.game, live = this.liveTokens();
    let next = Infinity;
    for (const s of g.seats)
      if (s && !s.cpu && s.disc != null && !live.has(s.token)) next = Math.min(next, s.disc + GRACE_MS);
    if (next === Infinity) await this.room.storage.deleteAlarm();
    else await this.room.storage.setAlarm(next);
  }
  // 猶予超過: ロビー=席解放 / 対局中=CPU代打ち (tokenは保持し、再接続で人間へ戻す)
  async onAlarm() {
    const g = this.game, now = this.now(), live = this.liveTokens();
    let changed = false;
    for (let i = 0; i < g.seats.length; i++) {
      const s = g.seats[i];
      if (s && !s.cpu && s.disc != null && !live.has(s.token) && now - s.disc >= GRACE_MS) {
        changed = true;
        if (g.phase === 'lobby') g.seats[i] = null;
        else { s.cpu = true; this.toastAll(s.name + 'さんの かわりに CPUが うちます'); }
      }
    }
    if (changed && g.phase === 'playing') this.runCpuChain();
    await this.save();
    await this.scheduleAlarm();
    if (changed) this.broadcastState();
  }

  // ── CPU 連鎖: 手番がCPU席のあいだ core の cpuChoose/applyAction で進める ──
  runCpuChain() {
    const g = this.game;
    let guard = 0;
    while (g.phase === 'playing' && g.round && !g.round.ended && guard++ < 500) {
      const seat = g.round.turn;
      const s = g.seats[seat];
      if (!s || !s.cpu) break;
      const mv = cpuChoose(g.round.hands[seat], g.round.field.top, ctxOf(g.round), g.rules);
      const r = applyAction(g.round, seat, mv ? mv.cards : null, g.rules);
      if (!r.ok) { applyAction(g.round, seat, null, g.rules); continue; } // 保険: 不正なら強制パス
      this.emitEvents(r, seat);
    }
  }
  emitEvents(r, seat) { // 演出トースト (全員に公開できる情報のみ)
    const g = this.game;
    if (r.fx && r.fx.revolution) this.toastAll('かくめい！');
    else if (r.fx && r.fx.flow) this.toastAll('8ぎり！');
    if (r.finishedSeat != null) {
      const nm = g.seats[r.finishedSeat] ? g.seats[r.finishedSeat].name : '？';
      const ti = titlesFor(g.round.n)[g.round.finished.indexOf(r.finishedSeat)];
      this.toastAll(nm + 'さん あがり！（' + ti + '）');
    }
    if (r.ended) { g.phase = 'ended'; g.lastRanks = g.round.finished.slice(); }
  }
  toastAll(msg) {
    for (const c of this.room.getConnections()) {
      try { c.send(JSON.stringify({ type: 'toast', msg })); } catch (e) {}
    }
  }

  // ── ラウンド開始 (start/again 共通)。カード交換→CPU連鎖まで ──
  startRound() {
    const g = this.game;
    g.gameNo++;
    const leader = (g.gameNo > 1 && g.lastRanks && g.lastRanks.length === g.rules.playerCount)
      ? g.lastRanks[g.lastRanks.length - 1] : null;   // 2局目以降は前局の大貧民が親
    g.round = newRound(g.rules, shuffle(makeDeck(g.rules), () => this.rand()), leader);
    if (g.gameNo > 1 && g.lastRanks && g.lastRanks.length === g.rules.playerCount
      && applyExchange(g.round, g.lastRanks, g.rules).length) this.toastAll('カードこうかん！');
    g.phase = 'playing';
    this.runCpuChain();
  }

  async onMessage(raw, conn) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.type !== 'string') return;
    const g = this.game;

    if (m.type === 'hello') {
      const name = sanitizeName(m.name);
      const token = String(m.token || '');
      let seat = -1; // -1 = 観戦
      // ① 既存トークンの席へ復帰 (対局中のCPU代打ちを解除)
      for (let i = 0; i < g.seats.length; i++)
        if (g.seats[i] && g.seats[i].token === token && token) { seat = i; break; }
      if (seat >= 0) {
        const s = g.seats[seat];
        s.name = name; s.disc = null;
        if (s.cpu) { s.cpu = false; this.toastAll(name + 'さんが ふっき！'); }
      } else if (g.phase === 'lobby') {
        // ② ロビー中は空席へ着席
        const open = g.seats.findIndex(s => !s);
        if (open >= 0) {
          seat = open;
          g.seats[open] = { token: crypto.randomUUID(), name, disc: null, pid: crypto.randomUUID().slice(0, 8), cpu: false };
        }
      }
      conn.setState({ seat, token: seat >= 0 ? g.seats[seat].token : '', name });
      conn.send(JSON.stringify({ type: 'assigned', seat, token: seat >= 0 ? g.seats[seat].token : null, name }));
      await this.save();
      await this.scheduleAlarm();
      this.broadcastState();
      return;
    }

    const st = conn.state || {};
    const seat = (st.seat != null && st.seat >= 0 && g.seats[st.seat] && g.seats[st.seat].token === st.token) ? st.seat : -1;

    if (m.type === 'rename') {
      const name = sanitizeName(m.name);
      conn.setState({ ...st, name });
      if (seat >= 0) { g.seats[seat].name = name; await this.save(); }
      this.broadcastState();
      return;
    }

    if (m.type === 'setRule') {
      // ホストがロビーでルール変更 → normalizeRules で検証して全員へ配信
      if (seat < 0 || seat !== this.hostSeat()) return this.err(conn, 'ホストだけが へんこうできます');
      if (g.phase !== 'lobby') return this.err(conn, 'たいきょくちゅうは へんこうできません');
      const next = normalizeRules({ ...g.rules, [String(m.key)]: m.val });
      if (next.playerCount !== g.seats.length) {
        // 定員変更: 着席者を維持したまま詰め替え。人数超過なら拒否
        const occupied = g.seats.filter(s => s);
        if (occupied.length > next.playerCount) return this.err(conn, 'いまの にんずうより ちいさくできません');
        g.seats = [...occupied, ...new Array(next.playerCount - occupied.length).fill(null)];
        this.reassignSeats();
      }
      g.rules = next;
      await this.save();
      this.broadcastState();
      return;
    }

    if (m.type === 'start' || m.type === 'again') {
      if (seat < 0 || seat !== this.hostSeat()) return this.err(conn, 'ホストだけが かいしできます');
      if (m.type === 'start' && g.phase !== 'lobby') return this.err(conn, 'すでに かいしずみです');
      if (m.type === 'again' && g.phase !== 'ended') return this.err(conn, 'まだ おわっていません');
      // 空席処理: fillWithCPU=ON なら CPUで埋める / OFF なら満席必須
      for (let i = 0; i < g.seats.length; i++) {
        if (!g.seats[i]) {
          if (!g.rules.fillWithCPU) return this.err(conn, 'メンバーが たりません（あと' + g.seats.filter(s => !s).length + '人）');
          g.seats[i] = { token: '', name: 'CPU ' + (i + 1), disc: null, pid: 'cpu' + i, cpu: true };
        }
      }
      this.startRound();
      await this.save();
      this.broadcastState();
      return;
    }

    if (m.type === 'play' || m.type === 'pass') {
      if (g.phase !== 'playing' || !g.round) return this.err(conn, 'たいきょくちゅうでは ありません');
      if (seat < 0) return this.err(conn, 'かんせんちゅうは だせません');
      let cards = null;
      if (m.type === 'play') {
        const ids = Array.isArray(m.ids) ? m.ids.map(Number) : [];
        cards = g.round.hands[seat].filter(c => ids.includes(c.id));
        if (cards.length !== ids.length) return this.err(conn, 'てふだに ない カードです');
      }
      const r = applyAction(g.round, seat, cards, g.rules); // 権威検証はコアに委譲
      if (!r.ok) return this.err(conn, r.error || 'その てでは だせません');
      this.emitEvents(r, seat);
      this.runCpuChain();     // 続くCPU手番を進める (人間の番か終局まで)
      await this.save();
      this.broadcastState();
      return;
    }

    if (m.type === 'leave') {
      // 明示退室: ロビー=席解放 / 対局中=CPU代打ち(トークン破棄=戻れない)
      if (seat < 0) return;
      if (g.phase === 'lobby') g.seats[seat] = null;
      else { g.seats[seat].cpu = true; g.seats[seat].token = ''; this.toastAll(g.seats[seat].name + 'さんが たいしつ（CPUだいうち）'); }
      conn.setState({ ...st, seat: -1, token: '' });
      if (g.phase === 'playing') this.runCpuChain();
      await this.save();
      this.broadcastState();
      return;
    }
  }

  // 定員変更で席indexが動いた接続へ assigned を再送
  reassignSeats() {
    const g = this.game;
    for (const c of this.room.getConnections()) {
      const cs = c.state; if (!cs || !cs.token) continue;
      const ns = g.seats.findIndex(s => s && s.token === cs.token);
      if (ns !== cs.seat) {
        c.setState({ ...cs, seat: ns });
        c.send(JSON.stringify({ type: 'assigned', seat: ns, token: ns >= 0 ? cs.token : null, name: cs.name }));
      }
    }
  }

  // ── 配信 (per-conn tailored: 手札は本人のみ) ─────────────
  err(conn, msg) { conn.send(JSON.stringify({ type: 'error', msg })); }

  stateFor(conn) {
    const g = this.game, live = this.liveTokens();
    let spectators = 0;
    for (const c of this.room.getConnections()) {
      const s2 = c.state;
      if (!(s2 && s2.seat >= 0 && s2.token && g.seats[s2.seat] && g.seats[s2.seat].token === s2.token)) spectators++;
    }
    const seatsPub = g.seats.map(s => s ? { name: s.name, cpu: !!s.cpu, connected: s.cpu ? true : live.has(s.token), pid: s.pid } : null);
    const r = g.round;
    const publicState = {
      status: g.phase === 'lobby' ? 'waiting' : (g.phase === 'ended' ? 'ended' : 'playing'),
      phase: g.phase, gameNo: g.gameNo, rules: g.rules,
      hostSeat: this.hostSeat(),
      joined: g.seats.filter(s => s && !s.cpu).length,
      canStart: g.phase === 'lobby' && (g.rules.fillWithCPU ? this.humanCount() >= 1 : g.seats.every(s => s)),
      seatsPub, spectators,
    };
    if (r) {
      publicState.turn = r.turn;
      publicState.passed = r.passed;
      publicState.finished = r.finished;
      publicState.field = { top: r.field.top, cards: r.field.cards, owner: r.field.owner, lock: r.field.lock };
      publicState.st = r.st;
    }
    return hiddenHandState({
      conn,
      seats: g.seats,
      hands: r ? r.hands : [],
      publicState,
    });
  }
  sendState(conn) { sendProjectedState(conn, c => this.stateFor(c)); }
  broadcastState() { broadcastProjectedState(this.room, c => this.stateFor(c)); }
}

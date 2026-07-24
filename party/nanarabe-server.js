/* 七並べ オンライン対戦サーバー。
   全手札はDO内だけに保持し、private-state.js で本人手札＋公開情報へ投影する。
   3〜4人、空席CPU補充、seat token再接続、切断60秒後CPU代打ち。 */
import {
  normalizeNanaPlayers, makeNanaDeck, shuffleNana, newNanaRound,
  nanaPlay, nanaPass, nanaCpuChoose,
} from './nanarabe-core.js';
import { authenticatedSeat, hiddenHandState, sendProjectedState, broadcastProjectedState } from './private-state.js';

const GRACE_MS = 60000;

function sanitizeName(v) {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 12);
  return s || 'ゲスト';
}

function freshGame() {
  const playerCount = 4;
  return {
    phase: 'lobby',
    rules: { playerCount },
    seats: new Array(playerCount).fill(null),
    round: null,
    gameNo: 0,
  };
}

export default class NanarabeServer {
  constructor(room) {
    this.room = room;
    this.game = null;
  }

  async onStart() {
    const g = (await this.room.storage.get('game')) || freshGame();
    g.rules = { playerCount: normalizeNanaPlayers(g.rules && g.rules.playerCount) };
    if (!Array.isArray(g.seats)) g.seats = new Array(g.rules.playerCount).fill(null);
    if (g.seats.length !== g.rules.playerCount)
      g.seats = g.seats.slice(0, g.rules.playerCount).concat(new Array(Math.max(0, g.rules.playerCount - g.seats.length)).fill(null));
    this.game = g;
  }

  async save() { await this.room.storage.put('game', this.game); }
  now() { return Date.now(); }
  rand() { return Math.random(); }

  hostSeat() {
    for (let i = 0; i < this.game.seats.length; i++) {
      const s = this.game.seats[i];
      if (s && !s.cpu) return i;
    }
    return -1;
  }

  humanCount() { return this.game.seats.filter(s => s && !s.cpu).length; }

  liveTokens(excludeId) {
    const set = new Set();
    for (const c of this.room.getConnections()) {
      if (excludeId && c.id === excludeId) continue;
      const cs = c.state;
      if (cs && Number.isInteger(cs.seat) && cs.seat >= 0 && cs.token) set.add(cs.token);
    }
    return set;
  }

  onConnect(conn) { this.sendState(conn); }

  async onClose(conn) {
    const st = conn && conn.state;
    if (st && Number.isInteger(st.seat) && st.seat >= 0 && st.token) {
      const s = this.game.seats[st.seat];
      if (s && s.token === st.token && !this.liveTokens(conn.id).has(st.token)) {
        s.disc = this.now();
        await this.save();
        await this.scheduleAlarm();
      }
    }
    this.broadcastState();
  }

  onError() { this.broadcastState(); }

  async scheduleAlarm() {
    const live = this.liveTokens();
    let next = Infinity;
    for (const s of this.game.seats) {
      if (s && !s.cpu && s.disc != null && !live.has(s.token)) next = Math.min(next, s.disc + GRACE_MS);
    }
    if (next === Infinity) await this.room.storage.deleteAlarm();
    else await this.room.storage.setAlarm(next);
  }

  async onAlarm() {
    const g = this.game, live = this.liveTokens(), now = this.now();
    let changed = false;
    for (let i = 0; i < g.seats.length; i++) {
      const s = g.seats[i];
      if (!s || s.cpu || s.disc == null || live.has(s.token) || now - s.disc < GRACE_MS) continue;
      changed = true;
      if (g.phase === 'lobby') g.seats[i] = null;
      else { s.cpu = true; this.toastAll(s.name + 'さんの かわりに CPUが うちます'); }
    }
    if (changed && g.phase === 'playing') this.runCpuChain();
    await this.save();
    await this.scheduleAlarm();
    if (changed) this.broadcastState();
  }

  toastAll(msg) {
    for (const c of this.room.getConnections()) {
      try { c.send(JSON.stringify({ type: 'toast', msg })); } catch (e) {}
    }
  }

  emitResult(r, seat) {
    const g = this.game;
    if (r.finishedSeat != null) this.toastAll(g.seats[seat].name + 'さん あがり！');
    if (r.eliminatedSeat != null) this.toastAll(g.seats[seat].name + 'さん パス3回で だつらく…');
    if (r.ended) g.phase = 'ended';
  }

  runCpuChain() {
    const g = this.game;
    let guard = 0;
    while (g.phase === 'playing' && g.round && !g.round.ended && guard++ < 500) {
      const seat = g.round.turn, s = g.seats[seat];
      if (!s || !s.cpu) break;
      const move = nanaCpuChoose(g.round, seat, () => this.rand());
      const r = move.type === 'play' ? nanaPlay(g.round, seat, move.cardId) : nanaPass(g.round, seat);
      if (!r.ok) {
        const fallback = nanaPass(g.round, seat);
        if (!fallback.ok) break;
        this.emitResult(fallback, seat);
      } else this.emitResult(r, seat);
    }
  }

  startRound() {
    const g = this.game;
    g.gameNo++;
    g.round = newNanaRound(g.rules.playerCount, shuffleNana(makeNanaDeck(), () => this.rand()));
    g.phase = g.round.ended ? 'ended' : 'playing';
    this.runCpuChain();
  }

  async onMessage(raw, conn) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.type !== 'string') return;
    const g = this.game;

    if (m.type === 'hello') {
      const name = sanitizeName(m.name), token = String(m.token || '');
      let seat = -1;
      for (let i = 0; i < g.seats.length; i++) {
        if (token && g.seats[i] && g.seats[i].token === token) { seat = i; break; }
      }
      if (seat >= 0) {
        const s = g.seats[seat];
        s.name = name; s.disc = null;
        if (s.cpu) { s.cpu = false; this.toastAll(name + 'さんが ふっき！'); }
      } else if (g.phase === 'lobby') {
        const open = g.seats.findIndex(s => !s);
        if (open >= 0) {
          seat = open;
          g.seats[open] = {
            token: crypto.randomUUID(), name, disc: null,
            pid: crypto.randomUUID().slice(0, 8), cpu: false,
          };
        }
      }
      conn.setState({ seat, token: seat >= 0 ? g.seats[seat].token : '', name });
      conn.send(JSON.stringify({ type: 'assigned', seat, token: seat >= 0 ? g.seats[seat].token : null, name }));
      await this.save();
      await this.scheduleAlarm();
      this.broadcastState();
      return;
    }

    const seat = authenticatedSeat(conn, g.seats);

    if (m.type === 'rename') {
      const name = sanitizeName(m.name);
      conn.setState({ ...(conn.state || {}), name });
      if (seat >= 0) { g.seats[seat].name = name; await this.save(); }
      this.broadcastState();
      return;
    }

    if (m.type === 'setPlayers') {
      if (seat < 0 || seat !== this.hostSeat()) return this.err(conn, 'ホストだけが へんこうできます');
      if (g.phase !== 'lobby') return this.err(conn, 'たいきょくちゅうは へんこうできません');
      const playerCount = normalizeNanaPlayers(m.playerCount);
      const occupied = g.seats.filter(Boolean);
      if (occupied.length > playerCount) return this.err(conn, 'いまの にんずうより ちいさくできません');
      g.rules.playerCount = playerCount;
      g.seats = occupied.concat(new Array(playerCount - occupied.length).fill(null));
      this.reassignSeats();
      await this.save();
      this.broadcastState();
      return;
    }

    if (m.type === 'start' || m.type === 'again') {
      if (seat < 0 || seat !== this.hostSeat()) return this.err(conn, 'ホストだけが かいしできます');
      if (m.type === 'start' && g.phase !== 'lobby') return this.err(conn, 'すでに かいしずみです');
      if (m.type === 'again' && g.phase !== 'ended') return this.err(conn, 'まだ おわっていません');
      for (let i = 0; i < g.seats.length; i++) {
        if (!g.seats[i]) g.seats[i] = { token: '', name: 'CPU ' + (i + 1), disc: null, pid: 'cpu' + i, cpu: true };
      }
      this.startRound();
      await this.save();
      this.broadcastState();
      return;
    }

    if (m.type === 'play' || m.type === 'pass') {
      if (g.phase !== 'playing' || !g.round) return this.err(conn, 'たいきょくちゅうでは ありません');
      if (seat < 0) return this.err(conn, 'かんせんちゅうは だせません');
      const r = m.type === 'play' ? nanaPlay(g.round, seat, m.cardId) : nanaPass(g.round, seat);
      if (!r.ok) return this.err(conn, r.error || 'その ては できません');
      this.emitResult(r, seat);
      this.runCpuChain();
      await this.save();
      this.broadcastState();
      return;
    }

    if (m.type === 'leave') {
      if (seat < 0) return;
      if (g.phase === 'lobby') g.seats[seat] = null;
      else {
        g.seats[seat].cpu = true;
        g.seats[seat].token = '';
        this.toastAll(g.seats[seat].name + 'さんが たいしつ（CPUだいうち）');
      }
      conn.setState({ ...(conn.state || {}), seat: -1, token: '' });
      if (g.phase === 'playing') this.runCpuChain();
      await this.save();
      this.broadcastState();
    }
  }

  reassignSeats() {
    for (const c of this.room.getConnections()) {
      const cs = c.state;
      if (!cs || !cs.token) continue;
      const seat = this.game.seats.findIndex(s => s && s.token === cs.token);
      if (seat !== cs.seat) {
        c.setState({ ...cs, seat });
        c.send(JSON.stringify({ type: 'assigned', seat, token: seat >= 0 ? cs.token : null, name: cs.name }));
      }
    }
  }

  err(conn, msg) { conn.send(JSON.stringify({ type: 'error', msg })); }

  stateFor(conn) {
    const g = this.game, r = g.round, live = this.liveTokens();
    let spectators = 0;
    for (const c of this.room.getConnections()) if (authenticatedSeat(c, g.seats) < 0) spectators++;
    const seatsPub = g.seats.map(s => s ? {
      name: s.name, cpu: !!s.cpu, connected: s.cpu ? true : live.has(s.token), pid: s.pid,
    } : null);
    const publicState = {
      status: g.phase === 'lobby' ? 'waiting' : (g.phase === 'ended' ? 'ended' : 'playing'),
      phase: g.phase,
      gameNo: g.gameNo,
      rules: g.rules,
      hostSeat: this.hostSeat(),
      joined: this.humanCount(),
      canStart: g.phase === 'lobby' && this.humanCount() >= 1,
      seatsPub,
      spectators,
    };
    if (r) Object.assign(publicState, {
      board: r.board,
      turn: r.turn,
      passes: r.passes,
      playerStatus: r.status,
      finishOrder: r.finishOrder,
      eliminationOrder: r.eliminationOrder,
      ranking: r.ranking,
      last: r.last,
    });
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

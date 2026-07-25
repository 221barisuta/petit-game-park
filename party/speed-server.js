/* スピード オンライン対戦サーバー。
   DO が全カードを保持し、接続別stateには場札・台札と伏せ山の枚数だけを投影する。
   play は到着順キュー + 台札世代で直列化し、同じ旧台札を見た競合は先着だけ受理する。 */
import {
  makeSpeedDeck, shuffleSpeed, newSpeedRound,
  speedTop, speedPlay, speedReady, speedCanShowdown,
} from './speed-core.js';
import {
  authenticatedSeat, hiddenHandState, sendProjectedState, broadcastProjectedState,
} from './private-state.js';

const GRACE_MS = 60000;

function sanitizeName(v) {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 12);
  return s || 'ゲスト';
}

function freshGame() {
  return { phase: 'lobby', seats: [null, null], round: null, gameNo: 0 };
}

export default class SpeedServer {
  constructor(room) {
    this.room = room;
    this.game = null;
    this.messageQueue = Promise.resolve();
  }

  async onStart() {
    const g = (await this.room.storage.get('game')) || freshGame();
    if (!Array.isArray(g.seats) || g.seats.length !== 2) g.seats = [null, null];
    if (g.round) {
      if (!Array.isArray(g.round.ready)) g.round.ready = [false, false];
      if (!Array.isArray(g.round.pileVersions)) g.round.pileVersions = [0, 0];
      if (!Array.isArray(g.round.acceptedOps)) g.round.acceptedOps = [[], []];
    }
    this.game = g;
  }

  async save() { await this.room.storage.put('game', this.game); }
  now() { return Date.now(); }
  rand() { return Math.random(); }

  hostSeat() {
    return this.game.seats.findIndex(Boolean);
  }

  liveTokens(excludeId) {
    const out = new Set();
    for (const c of this.room.getConnections()) {
      if (excludeId && c.id === excludeId) continue;
      const cs = c.state;
      if (cs && Number.isInteger(cs.seat) && cs.seat >= 0 && cs.token) out.add(cs.token);
    }
    return out;
  }

  connectedSeats() {
    const live = this.liveTokens();
    return this.game.seats.map(s => !!(s && live.has(s.token)));
  }

  pausedSeats() {
    if (this.game.phase !== 'playing') return [];
    const connected = this.connectedSeats(), out = [];
    for (let i = 0; i < 2; i++) if (this.game.seats[i] && !connected[i]) out.push(i);
    return out;
  }

  onConnect(conn) { this.sendState(conn); }

  async onClose(conn) {
    const st = conn && conn.state;
    if (st && Number.isInteger(st.seat) && st.seat >= 0 && st.token) {
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

  async scheduleAlarm() {
    const live = this.liveTokens();
    let next = Infinity;
    for (const s of this.game.seats)
      if (s && s.disc != null && !live.has(s.token)) next = Math.min(next, s.disc + GRACE_MS);
    if (next === Infinity) await this.room.storage.deleteAlarm();
    else await this.room.storage.setAlarm(next);
  }

  finishForfeit(winner, loser) {
    const r = this.game.round;
    if (!r || r.ended) return;
    r.ended = true;
    r.result = winner == null ? { draw: true, forfeit: true } : { winner, loser, forfeit: true };
    r.last = { type: 'forfeit', winner, loser };
    this.game.phase = 'ended';
  }

  async onAlarm() {
    const g = this.game, live = this.liveTokens(), now = this.now();
    const expired = [];
    for (let i = 0; i < 2; i++) {
      const s = g.seats[i];
      if (s && s.disc != null && !live.has(s.token) && now - s.disc >= GRACE_MS) expired.push(i);
    }
    if (expired.length) {
      if (g.phase === 'playing') {
        if (expired.length === 2) this.finishForfeit(null, null);
        else this.finishForfeit(1 - expired[0], expired[0]);
      } else if (g.phase === 'lobby') {
        for (const seat of expired) g.seats[seat] = null;
      }
      await this.save();
      this.broadcastState();
    }
    await this.scheduleAlarm();
  }

  startRound() {
    const g = this.game;
    g.gameNo++;
    g.round = newSpeedRound(shuffleSpeed(makeSpeedDeck(), () => this.rand()));
    g.round.acceptedOps = [[], []];
    g.phase = 'playing';
  }

  onMessage(raw, conn) {
    const task = () => this.handleMessage(raw, conn);
    this.messageQueue = this.messageQueue.then(task, task);
    return this.messageQueue;
  }

  async handleMessage(raw, conn) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.type !== 'string') return;
    const g = this.game;

    if (m.type === 'hello') {
      const name = sanitizeName(m.name), token = String(m.token || '');
      let seat = -1;
      for (let i = 0; i < 2; i++)
        if (token && g.seats[i] && g.seats[i].token === token) { seat = i; break; }
      if (seat >= 0) {
        g.seats[seat].name = name;
        g.seats[seat].disc = null;
      } else if (g.phase === 'lobby') {
        const open = g.seats.findIndex(s => !s);
        if (open >= 0) {
          seat = open;
          g.seats[open] = {
            token: crypto.randomUUID(), name, disc: null,
            pid: crypto.randomUUID().slice(0, 8),
          };
        }
      }
      const assignedToken = seat >= 0 ? g.seats[seat].token : '';
      conn.setState({ seat, token: assignedToken, name });
      conn.send(JSON.stringify({ type: 'assigned', seat, token: assignedToken || null, name }));
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

    if (m.type === 'start' || m.type === 'again') {
      if (seat < 0 || seat !== this.hostSeat()) return this.err(conn, 'ホストだけが かいしできます');
      if (m.type === 'start' && g.phase !== 'lobby') return this.err(conn, 'すでに かいしずみです');
      if (m.type === 'again' && g.phase !== 'ended') return this.err(conn, 'まだ おわっていません');
      if (g.seats.some(s => !s) || this.connectedSeats().some(v => !v))
        return this.err(conn, '2人 そろってから はじめてね');
      this.startRound();
      await this.save();
      this.broadcastState();
      return;
    }

    if (m.type === 'play') {
      const opId = String(m.opId || '').slice(0, 64);
      if (g.phase !== 'playing' || !g.round) return this.reject(conn, opId, 'たいきょく中では ありません', 'phase');
      if (seat < 0) return this.reject(conn, opId, 'かんせん中は だせません', 'spectator');
      if (this.pausedSeats().length) return this.reject(conn, opId, '相手の さいせつぞくを まっています', 'paused');
      if (!opId) return this.reject(conn, '', 'そうさIDが ありません', 'op-id');
      const accepted = g.round.acceptedOps[seat];
      if (accepted.includes(opId)) {
        conn.send(JSON.stringify({ type: 'playAccepted', opId, duplicate: true }));
        this.sendState(conn);
        return;
      }
      const result = speedPlay(g.round, seat, m.slot, m.pile, m.expectedVersion);
      if (!result.ok) return this.reject(conn, opId, result.error, result.code);
      accepted.push(opId);
      if (accepted.length > 32) accepted.splice(0, accepted.length - 32);
      if (g.round.ended) g.phase = 'ended';
      await this.save();
      conn.send(JSON.stringify({
        type: 'playAccepted', opId, pile: Number(m.pile),
        pileVersion: g.round.pileVersions[Number(m.pile)],
      }));
      this.broadcastState();
      return;
    }

    if (m.type === 'ready') {
      if (g.phase !== 'playing' || !g.round) return this.err(conn, 'たいきょく中では ありません');
      if (seat < 0) return this.err(conn, 'かんせん中は おせません');
      if (this.pausedSeats().length) return this.err(conn, '相手の さいせつぞくを まっています');
      const result = speedReady(g.round, seat);
      if (!result.ok) return this.err(conn, result.error);
      if (g.round.ended) g.phase = 'ended';
      await this.save();
      this.broadcastState();
      return;
    }

    if (m.type === 'leave') {
      if (seat < 0) return;
      if (g.phase === 'playing') this.finishForfeit(1 - seat, seat);
      else if (g.phase === 'lobby') g.seats[seat] = null;
      conn.setState({ ...(conn.state || {}), seat: -1, token: '' });
      await this.save();
      await this.scheduleAlarm();
      this.broadcastState();
    }
  }

  err(conn, msg) { conn.send(JSON.stringify({ type: 'error', msg })); }

  reject(conn, opId, reason, code) {
    conn.send(JSON.stringify({
      type: 'playRejected', opId, reason, code,
      state: this.stateFor(conn),
    }));
  }

  stateFor(conn) {
    const g = this.game, r = g.round, live = this.liveTokens();
    const pausedSeats = this.pausedSeats();
    const seatsPub = g.seats.map(s => s ? {
      name: s.name, pid: s.pid, connected: live.has(s.token),
    } : null);
    const publicState = {
      status: g.phase === 'lobby' ? 'waiting'
        : g.phase === 'ended' ? 'ended'
        : pausedSeats.length ? 'paused' : 'playing',
      phase: g.phase,
      gameNo: g.gameNo,
      seatsPub,
      hostSeat: this.hostSeat(),
      joined: g.seats.filter(Boolean).length,
      canStart: g.phase === 'lobby' && g.seats.every(Boolean),
      paused: pausedSeats.length > 0,
      pausedSeats,
      pauseDeadline: pausedSeats.length
        ? Math.min(...pausedSeats.map(i => Number(g.seats[i].disc || this.now()) + GRACE_MS))
        : null,
    };
    if (r) Object.assign(publicState, {
      fields: r.fields,
      centers: [speedTop(r, 0), speedTop(r, 1)],
      pileVersions: r.pileVersions,
      ready: r.ready,
      canShowdown: speedCanShowdown(r),
      last: r.last,
      result: r.result,
    });
    return hiddenHandState({
      conn,
      seats: g.seats,
      hands: r ? r.stocks : [],
      publicState,
      privateView: () => ({}),
    });
  }

  sendState(conn) { sendProjectedState(conn, c => this.stateFor(c)); }
  broadcastState() { broadcastProjectedState(this.room, c => this.stateFor(c)); }
}

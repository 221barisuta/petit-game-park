/* 五目並べ オンライン対戦 PartyKit サーバー (部屋=1 Party = 1 Durable Object)
   ──────────────────────────────────────────────────────────
   - 盤面を権威的に保持・検証 (クライアントを信用しない)
   - 座席: 1人目=黒(先手) / 2人目=白(後手) / 3人目以降=観戦
   - 再接続: 席トークンで同席復帰 (DO生存中は席を保持)
   - もう一局: 両者合意でリセット + 先手後手入替
   - WebSocket Hibernation 対応 (状態は storage と conn.state に永続)

   メッセージ (JSON):
     client→server: hello{token?,name} / move{index} / rename{name} / rematch{on}
     server→client: assigned{seat,token} / state{...} / error{msg} */
import { GO_N, checkGomoku } from './gomoku-core.js';

const SIZE = GO_N * GO_N; // 225
const MARKS = ['black', 'white'];

function sanitizeName(v) {
  // 改行・制御文字を除去し、前後空白トリム、12文字制限。空なら 'ゲスト'
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 12);
  return s || 'ゲスト';
}
function freshGame() {
  return {
    board: new Array(SIZE).fill(null),
    turn: 'black',
    last: -1,
    result: null,                                   // {winner,line} | {draw:true}
    seats: { black: null, white: null },            // {token,name} | null
    rematch: { black: false, white: false },
    gameNo: 1,
  };
}

export default class GomokuServer {
  constructor(room) {
    this.room = room;
    this.game = null; // onStart で storage から復元
  }

  async onStart() {
    this.game = (await this.room.storage.get('game')) || freshGame();
  }
  async save() {
    await this.room.storage.put('game', this.game);
  }

  // ── 接続/切断 ───────────────────────────────────────────
  onConnect(conn) {
    // hello を受けて座席割当する。接続直後に現在状態だけ送る (観戦者にも盤面が見える)
    conn.send(JSON.stringify(this.stateMsg()));
  }
  onClose() { this.broadcastState(); } // 切断 → 接続状態(connected)が変わるので再配信
  onError() { this.broadcastState(); }

  async onMessage(raw, conn) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.type !== 'string') return;
    const g = this.game;

    if (m.type === 'hello') {
      const name = sanitizeName(m.name);
      const token = String(m.token || '');
      let seat = 'spectator';
      // ① 既存トークンと一致する席があれば同席復帰
      for (const c of MARKS) if (g.seats[c] && g.seats[c].token === token) seat = c;
      // ② 空席があれば着席 (黒→白の順)
      if (seat === 'spectator') {
        const open = MARKS.find(c => !g.seats[c]);
        if (open) {
          seat = open;
          g.seats[open] = { token: crypto.randomUUID(), name };
        }
      } else {
        g.seats[seat].name = name; // 復帰時に名前を更新
      }
      // conn に座席を紐付け (hibernation を越えて保持)
      conn.setState({ seat, token: seat === 'spectator' ? '' : g.seats[seat].token, name });
      conn.send(JSON.stringify({
        type: 'assigned',
        seat,
        token: seat === 'spectator' ? null : g.seats[seat].token,
        name,
      }));
      await this.save();
      this.broadcastState();
      return;
    }

    const st = conn.state || {};

    if (m.type === 'move') {
      // ── 権威検証: 着席プレイヤー / 手番一致 / 未決着 / 盤内かつ空きマス ──
      if (st.seat !== 'black' && st.seat !== 'white') return this.err(conn, '観戦中は着手できません');
      if (g.result) return this.err(conn, 'すでに決着しています');
      if (g.turn !== st.seat) return this.err(conn, 'あなたの手番ではありません');
      const i = m.index;
      if (!Number.isInteger(i) || i < 0 || i >= SIZE) return this.err(conn, '盤外です');
      if (g.board[i] !== null) return this.err(conn, 'すでに石があります');
      // 受理
      g.board[i] = st.seat;
      g.last = i;
      const r = checkGomoku(g.board, i);
      if (r.winner) g.result = { winner: r.winner, line: r.line };
      else if (g.board.every(c => c)) g.result = { draw: true };
      else g.turn = g.turn === 'black' ? 'white' : 'black';
      await this.save();
      this.broadcastState();
      return;
    }

    if (m.type === 'rename') {
      const name = sanitizeName(m.name);
      conn.setState({ ...st, name });
      if (st.seat === 'black' || st.seat === 'white') {
        if (g.seats[st.seat]) g.seats[st.seat].name = name;
        await this.save();
      }
      this.broadcastState();
      return;
    }

    if (m.type === 'rematch') {
      if (st.seat !== 'black' && st.seat !== 'white') return;
      g.rematch[st.seat] = m.on !== false; // 既定 true。on:false で取り消し
      // 両席合意 → リセット + 先手後手入替
      if (g.rematch.black && g.rematch.white) {
        const sw = g.seats.black; g.seats.black = g.seats.white; g.seats.white = sw; // 席(=トークン+名前)を入替
        g.board = new Array(SIZE).fill(null);
        g.turn = 'black'; g.last = -1; g.result = null;
        g.rematch = { black: false, white: false };
        g.gameNo++;
        // 各接続の seat を「トークンがいまどちらの席にあるか」で更新
        for (const c of this.room.getConnections()) {
          const cs = c.state; if (!cs || !cs.token) continue;
          const ns = MARKS.find(mk => g.seats[mk] && g.seats[mk].token === cs.token) || 'spectator';
          if (ns !== cs.seat) c.setState({ ...cs, seat: ns });
        }
      }
      await this.save();
      this.broadcastState();
      return;
    }
  }

  // ── 配信 ─────────────────────────────────────────────────
  err(conn, msg) { conn.send(JSON.stringify({ type: 'error', msg })); }

  // 現在ライブ接続から「席の接続状態」と「観戦者数」を集計
  presence() {
    const liveTokens = new Set();
    let spectators = 0;
    for (const c of this.room.getConnections()) {
      const cs = c.state;
      if (cs && (cs.seat === 'black' || cs.seat === 'white') && cs.token) liveTokens.add(cs.token);
      else spectators++;
    }
    const seat = c => {
      const s = this.game.seats[c];
      return s ? { name: s.name, connected: liveTokens.has(s.token) } : null;
    };
    return { black: seat('black'), white: seat('white'), spectators };
  }
  stateMsg() {
    const g = this.game;
    const p = this.presence();
    return {
      type: 'state',
      board: g.board, turn: g.turn, last: g.last, result: g.result,
      gameNo: g.gameNo, rematch: g.rematch,
      seats: { black: p.black, white: p.white }, spectators: p.spectators,
    };
  }
  broadcastState() { this.room.broadcast(JSON.stringify(this.stateMsg())); }
}

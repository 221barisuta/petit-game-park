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
const GRACE_MS = 30000; // 席解放の猶予: 切断後この時間 再接続が無ければ席を解放

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
    moves: [],                                      // 着手index履歴 (待ったで pop / last復元に使う)
    result: null,                                   // {winner,line} | {draw:true}
    seats: { black: null, white: null },            // {token,name,disc,pid} | null
    rematch: { black: false, white: false },
    gameNo: 1,
    series: [],                                     // シリーズ成績 [{game, winner: pid|null(引分)}]
  };
}
// 盤だけ新規化 (席/シリーズ/トークンは保持)。再戦リセットで使う
function resetBoard(g) {
  g.board = new Array(SIZE).fill(null);
  g.turn = 'black'; g.last = -1; g.moves = []; g.result = null;
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

  now() { return Date.now(); } // テストで時刻を注入できるよう関数化

  // ── 接続/切断 ───────────────────────────────────────────
  onConnect(conn) {
    // hello を受けて座席割当する。接続直後に現在状態だけ送る (観戦者にも盤面が見える)
    conn.send(JSON.stringify(this.stateMsg()));
  }
  async onClose(conn) {
    // 席プレイヤーが切断 → 切断時刻を記録し解放アラームを仕掛ける (猶予内に再接続が無ければ onAlarm で解放)
    const st = conn && conn.state;
    if (st && (st.seat === 'black' || st.seat === 'white') && st.token) {
      const seat = this.game.seats[st.seat];
      if (seat && seat.token === st.token && !this.liveTokens(conn.id).has(st.token)) {
        seat.disc = this.now();
        await this.save();
        await this.scheduleAlarm();
      }
    }
    this.broadcastState(); // 接続状態(connected)が変わるので再配信
  }
  onError() { this.broadcastState(); }

  // 着席トークンのうち「ライブ接続が存在する」ものの集合 (excludeId の接続は除外)
  liveTokens(excludeId) {
    const set = new Set();
    for (const c of this.room.getConnections()) {
      if (excludeId && c.id === excludeId) continue;
      const cs = c.state;
      if (cs && (cs.seat === 'black' || cs.seat === 'white') && cs.token) set.add(cs.token);
    }
    return set;
  }
  // 切断中の席のうち最も早い解放期限にアラームを設定 (無ければ解除)。冪等
  async scheduleAlarm() {
    const g = this.game, live = this.liveTokens();
    let next = Infinity;
    for (const mark of MARKS) {
      const s = g.seats[mark];
      if (s && s.disc != null && !live.has(s.token)) next = Math.min(next, s.disc + GRACE_MS);
    }
    if (next === Infinity) await this.room.storage.deleteAlarm();
    else await this.room.storage.setAlarm(next);
  }
  // アラーム発火: 猶予超過した切断席を解放する (現状を見て判定する冪等な作り)
  async onAlarm() {
    const g = this.game, now = this.now(), live = this.liveTokens();
    let released = false, midGameReset = false;
    for (const mark of MARKS) {
      const s = g.seats[mark];
      if (s && s.disc != null && !live.has(s.token) && now - s.disc >= GRACE_MS) {
        g.seats[mark] = null; released = true;
        if (!g.result && g.board.some(c => c)) midGameReset = true; // 対局途中の解放 → 盤リセット
      }
    }
    if (released && midGameReset) { // fresh盤で残存席+新規がクリーンに開始できるように
      g.board = new Array(SIZE).fill(null); g.turn = 'black'; g.last = -1; g.result = null;
      g.rematch = { black: false, white: false }; g.gameNo++;
    }
    await this.save();
    await this.scheduleAlarm();        // 残りの切断席へ再設定 / 無ければ解除 (空振りでも破綻しない)
    if (released) this.broadcastState();
  }

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
          // token=再接続用の秘密 / pid=公開のプレイヤー識別(シリーズ集計用。全員へ配信してよい)
          g.seats[open] = { token: crypto.randomUUID(), name, disc: null, pid: crypto.randomUUID().slice(0, 8) };
        }
      } else {
        g.seats[seat].name = name; // 復帰時に名前を更新
        g.seats[seat].disc = null; // 同席復帰 → 席を解放しない
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
      await this.scheduleAlarm(); // 復帰で解放対象が無くなればアラーム解除
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
      g.last = i; g.moves.push(i);
      const r = checkGomoku(g.board, i);
      if (r.winner) { // 勝者の pid をシリーズに記録 (色は毎局入替なので pid で識別)
        g.result = { winner: r.winner, line: r.line };
        g.series.push({ game: g.gameNo, winner: g.seats[r.winner] ? g.seats[r.winner].pid : null });
      } else if (g.board.every(c => c)) {
        g.result = { draw: true };
        g.series.push({ game: g.gameNo, winner: null });
      } else g.turn = g.turn === 'black' ? 'white' : 'black';
      await this.save();
      this.broadcastState();
      return;
    }

    if (m.type === 'undo') {
      // 待った: 直前に着手した本人だけ・相手が打つ前だけ取り消せる (合意不要・レース無し)
      if (st.seat !== 'black' && st.seat !== 'white') return; // 観戦者は無視
      if (g.result || g.last < 0) return this.err(conn, 'まったは できません');
      if (g.board[g.last] !== st.seat) return this.err(conn, 'まったは できません'); // 直前手が自分の石でない
      if (g.turn === st.seat) return this.err(conn, 'まったは できません');          // 自分の手番=まだ打ってない/相手が打った後
      g.board[g.last] = null;             // 直前1手を取り消し
      g.moves.pop();
      g.last = g.moves.length ? g.moves[g.moves.length - 1] : -1;
      g.turn = st.seat;                   // 手番を本人へ戻す
      await this.save();
      this.broadcastState();
      // 相手へ通知トースト (requester以外の着席相手)
      const opp = st.seat === 'black' ? 'white' : 'black';
      for (const c of this.room.getConnections()) {
        const cs = c.state;
        if (cs && cs.seat === opp) c.send(JSON.stringify({ type: 'toast', msg: 'あいてが まったを しました' }));
      }
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
        const sw = g.seats.black; g.seats.black = g.seats.white; g.seats.white = sw; // 席(=トークン+名前+pid)を入替
        resetBoard(g);                       // 盤だけ初期化 (series/席は保持)
        g.rematch = { black: false, white: false };
        g.gameNo++;
        // 各接続の seat を「トークンがいまどちらの席にあるか」で更新し、新しい assigned を再送
        for (const c of this.room.getConnections()) {
          const cs = c.state; if (!cs || !cs.token) continue;
          const ns = MARKS.find(mk => g.seats[mk] && g.seats[mk].token === cs.token) || 'spectator';
          if (ns !== cs.seat) {
            c.setState({ ...cs, seat: ns });
            // ★#3修正: 入替後の席をクライアントへ通知。これが無いと client の state.seat が古いまま=手番ズレで両者打てない
            c.send(JSON.stringify({ type: 'assigned', seat: ns, token: ns === 'spectator' ? null : cs.token, name: cs.name }));
          }
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
    const live = this.liveTokens();
    let spectators = 0;
    for (const c of this.room.getConnections()) {
      const cs = c.state;
      if (!(cs && (cs.seat === 'black' || cs.seat === 'white') && cs.token)) spectators++;
    }
    const seat = c => {
      const s = this.game.seats[c];
      return s ? { name: s.name, connected: live.has(s.token), pid: s.pid } : null; // pid=公開ID(集計用)
    };
    return { black: seat('black'), white: seat('white'), spectators };
  }
  stateMsg() {
    const g = this.game;
    const p = this.presence();
    return {
      type: 'state',
      board: g.board, turn: g.turn, last: g.last, result: g.result,
      gameNo: g.gameNo, rematch: g.rematch, series: g.series,
      seats: { black: p.black, white: p.white }, spectators: p.spectators,
    };
  }
  broadcastState() { this.room.broadcast(JSON.stringify(this.stateMsg())); }
}

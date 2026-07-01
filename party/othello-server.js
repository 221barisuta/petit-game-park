/* オセロ オンライン対戦 PartyKit サーバー (部屋=1 Party = 1 Durable Object)
   ──────────────────────────────────────────────────────────
   五目(server.js)の GomokuServer をコピー流用 (案ii)。席/手番/再戦/観戦/kick/入替/
   グレース席解放は「ゲーム非依存」でそのまま。ゲーム固有ロジックだけ差し替え:
     - 盤: 8x8=64マス・初期4石 (othInitial)
     - 着手: 合法手のみ (getFlips が空=非合法で拒否) → 反転を反映
     - 手番: 相手に手あり=交代 / 相手0手・自分手あり=自動パス(手番維持,pass表示) / 両者0手=終局
     - 勝敗: 終局時に石数(getWinner)で判定
     - まった(undo): 盤スナップショット方式 (反転も自動パスも綺麗に巻き戻る)

   メッセージ (JSON):
     client→server: hello{token?,name} / move{index} / undo / rename{name}
                    rematch{on} / rematchDecline / kick{spid} / takeSeat / swapColors
     server→client: assigned{seat,token} / state{...,pass,series,seats[].pid,specList[{name,spid}]}
                    toast{msg} / kicked / error{msg}
   - state.pass: 直前に自動パスされた色 (次着手まで表示)。null なら通常。
   - series: [{game,winner: pid|null}] をstateで配信。pid=公開のプレイヤー識別(色は毎局入替のため)
   - 接続パス: wss://<host>/parties/othello/<部屋コード> (DOバインディング "Othello") */
import { OTH_N, othOpp, othInitial, getFlips, getValidMoves, getWinner } from './othello-core.js';

const SIZE = OTH_N * OTH_N; // 64
const MARKS = ['black', 'white'];
const GRACE_MS = 30000; // 席解放の猶予: 切断後この時間 再接続が無ければ席を解放

function sanitizeName(v) {
  // 改行・制御文字を除去し、前後空白トリム、12文字制限。空なら 'ゲスト'
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 12);
  return s || 'ゲスト';
}
function freshGame() {
  return {
    board: othInitial(),                            // 8x8=64・初期4石 (黒先手)
    turn: 'black',
    last: -1,
    pass: null,                                     // 直前に自動パスされた色 | null
    history: [],                                    // まった用スナップショット [{board,turn,last,pass}]
    result: null,                                   // {winner} | {draw:true}
    seats: { black: null, white: null },            // {token,name,disc,pid} | null
    rematch: { black: false, white: false },
    gameNo: 1,
    series: [],                                     // シリーズ成績 [{game, winner: pid|null(引分)}]
  };
}
// 盤だけ新規化 (席/シリーズ/トークンは保持)。再戦リセットで使う
function resetBoard(g) {
  g.board = othInitial();
  g.turn = 'black'; g.last = -1; g.pass = null; g.history = []; g.result = null;
}

export default class OthelloServer {
  constructor(room) {
    this.room = room;
    this.game = null; // onStart で storage から復元
  }

  async onStart() {
    const g = (await this.room.storage.get('game')) || freshGame();
    // 旧形式/欠損フィールドの正規化 (新DOなので通常は不要だが冪等保険)
    if (!Array.isArray(g.history)) g.history = [];
    if (!Array.isArray(g.series)) g.series = [];
    if (!g.rematch) g.rematch = { black: false, white: false };
    if (g.pass === undefined) g.pass = null;
    for (const c of MARKS) if (g.seats[c] && !g.seats[c].pid) g.seats[c].pid = crypto.randomUUID().slice(0, 8);
    this.game = g;
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
        g.seats[mark] = null; g.rematch[mark] = false; released = true; // 解放席の再戦希望もクリア(新着席者へ引き継がない。相手側の希望は維持)
        if (!g.result && g.history.length) midGameReset = true; // 対局途中(1手以上)の解放 → 盤リセット (othは初期盤に石があるので手数で判定)
      }
    }
    if (released && midGameReset) { // fresh盤で残存席+新規がクリーンに開始できるように (history も必ずクリア)
      resetBoard(g);
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
      // conn に座席を紐付け (hibernation を越えて保持)。観戦者には spid(公開ハンドル) を振り、名前表示/追い出しの識別に使う
      const spid = seat === 'spectator' ? crypto.randomUUID().slice(0, 8) : '';
      conn.setState({ seat, token: seat === 'spectator' ? '' : g.seats[seat].token, name, spid });
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
      // ── 権威検証: 着席プレイヤー / 手番一致 / 未決着 / 盤内かつ空きマス / 合法手(反転あり) ──
      if (st.seat !== 'black' && st.seat !== 'white') return this.err(conn, '観戦中は着手できません');
      if (g.result) return this.err(conn, 'すでに決着しています');
      if (g.turn !== st.seat) return this.err(conn, 'あなたの手番ではありません');
      const i = m.index;
      if (!Number.isInteger(i) || i < 0 || i >= SIZE) return this.err(conn, '盤外です');
      if (g.board[i] !== null) return this.err(conn, 'すでに石があります');
      const flips = getFlips(g.board, i, st.seat);
      if (!flips.length) return this.err(conn, 'そこには おけません');
      // 受理: まった用スナップショットを積んでから反転を反映
      g.history.push({ board: g.board.slice(), turn: g.turn, last: g.last, pass: g.pass });
      g.board[i] = st.seat; for (const f of flips) g.board[f] = st.seat;
      g.last = i; g.pass = null;
      // 手番送り: 相手に手あり=交代 / 相手0手・自分手あり=自動パス(手番維持) / 両者0手=終局
      const opp = othOpp(st.seat);
      if (getValidMoves(g.board, opp).length) {
        g.turn = opp;
      } else if (getValidMoves(g.board, st.seat).length) {
        g.pass = opp; // 相手を自動パス。手番は自分のまま
      } else {
        const w = getWinner(g.board); // 両者打てない → 終局。石数で勝敗
        g.result = w === 'draw' ? { draw: true } : { winner: w };
        g.series.push({ game: g.gameNo, winner: (w !== 'draw' && g.seats[w]) ? g.seats[w].pid : null });
      }
      await this.save();
      this.broadcastState();
      return;
    }

    if (m.type === 'undo') {
      // 待った: 直前に着手した本人だけ・相手応手前だけ取り消せる (合意不要・レース無し)
      // スナップショット top.turn = その手を打った色。それが自分なら「直前手が自分・相手未応手」。
      if (st.seat !== 'black' && st.seat !== 'white') return; // 観戦者は無視
      if (g.result || !g.history.length) return this.err(conn, 'まったは できません');
      const top = g.history[g.history.length - 1];
      if (top.turn !== st.seat) return this.err(conn, 'まったは できません'); // 直前手が自分でない(相手が応手した後 等)
      g.history.pop();
      g.board = top.board; g.turn = top.turn; g.last = top.last; g.pass = top.pass; // 直前1手を巻き戻し(反転/自動パス込み)
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
      const on = m.on !== false; // 既定 true(リクエスト/承認)。on:false で自分の希望を取り消し
      g.rematch[st.seat] = on;
      const opp0 = st.seat === 'black' ? 'white' : 'black';
      // 承認方式: 片方だけが希望した時点で相手へ「もう一局きぼう」を通知 (相手はうける/ことわるを選べる)
      if (on && !(g.rematch.black && g.rematch.white)) {
        for (const c of this.room.getConnections()) {
          const cs = c.state;
          if (cs && cs.seat === opp0) c.send(JSON.stringify({ type: 'toast', msg: 'あいてが もう一局を きぼう！' }));
        }
      }
      // 両席合意 → リセット + 先手後手入替
      if (g.rematch.black && g.rematch.white) {
        const sw = g.seats.black; g.seats.black = g.seats.white; g.seats.white = sw; // 席(=トークン+名前+pid)を入替
        resetBoard(g);                       // 盤だけ初期化 (series/席は保持)
        g.rematch = { black: false, white: false };
        g.gameNo++;
        this.reassignSeats(); // 入替後の席を各接続へ再通知 (手番ズレ防止)
      }
      await this.save();
      this.broadcastState();
      return;
    }

    if (m.type === 'rematchDecline') {
      // もう一局を「ことわる」: 両者の希望をクリアし、希望していた相手へ通知
      if (st.seat !== 'black' && st.seat !== 'white') return;
      g.rematch = { black: false, white: false };
      const opp = st.seat === 'black' ? 'white' : 'black';
      for (const c of this.room.getConnections()) {
        const cs = c.state;
        if (cs && cs.seat === opp) c.send(JSON.stringify({ type: 'toast', msg: 'あいては もう一局を ことわりました' }));
      }
      await this.save();
      this.broadcastState();
      return;
    }

    if (m.type === 'kick') {
      // 着席プレイヤーが観戦者を部屋から追い出す (spid で識別)
      if (st.seat !== 'black' && st.seat !== 'white') return;
      const spid = String(m.spid || '');
      if (!spid) return;
      for (const c of this.room.getConnections()) {
        const cs = c.state;
        if (cs && cs.seat === 'spectator' && cs.spid && cs.spid === spid) {
          try { c.send(JSON.stringify({ type: 'kicked' })); } catch (e) {}
          try { c.close(); } catch (e) {}
        }
      }
      this.broadcastState();
      return;
    }

    if (m.type === 'takeSeat') {
      // 観戦者が空席に着いて対局へ参加 (空席がある時のみ)
      if (st.seat === 'black' || st.seat === 'white') return; // すでに着席
      const open = MARKS.find(c => !g.seats[c]);
      if (!open) return this.err(conn, 'あきせきが ありません');
      const name = sanitizeName(st.name);
      g.seats[open] = { token: crypto.randomUUID(), name, disc: null, pid: crypto.randomUUID().slice(0, 8) };
      g.rematch[open] = false; // 防御: 前任者の再戦希望を新着席者へ引き継がない(相手側の希望は維持)
      conn.setState({ seat: open, token: g.seats[open].token, name, spid: '' });
      conn.send(JSON.stringify({ type: 'assigned', seat: open, token: g.seats[open].token, name }));
      await this.save();
      await this.scheduleAlarm();
      this.broadcastState();
      return;
    }

    if (m.type === 'swapColors') {
      // 先手(黒)後手(白)の入替。対局開始前(着手0・未決着)かつ2人そろっている時のみ
      if (st.seat !== 'black' && st.seat !== 'white') return;
      if (g.history.length !== 0 || g.result) return this.err(conn, 'たいきょくちゅうは いれかえできません');
      if (!g.seats.black || !g.seats.white) return this.err(conn, 'あいてが そろってから');
      const sw = g.seats.black; g.seats.black = g.seats.white; g.seats.white = sw;
      g.turn = 'black';
      this.reassignSeats();
      await this.save();
      this.broadcastState();
      return;
    }
  }

  // 席入替後、各接続の seat を実トークン位置で更新し、変わった接続へ新しい assigned を再送
  // (これが無いと client の state.seat が古いまま=手番ズレで両者打てない)
  reassignSeats() {
    const g = this.game;
    for (const c of this.room.getConnections()) {
      const cs = c.state; if (!cs || !cs.token) continue;
      const ns = MARKS.find(mk => g.seats[mk] && g.seats[mk].token === cs.token) || 'spectator';
      if (ns !== cs.seat) {
        c.setState({ ...cs, seat: ns });
        c.send(JSON.stringify({ type: 'assigned', seat: ns, token: ns === 'spectator' ? null : cs.token, name: cs.name }));
      }
    }
  }

  // ── 配信 ─────────────────────────────────────────────────
  err(conn, msg) { conn.send(JSON.stringify({ type: 'error', msg })); }

  // 現在ライブ接続から「席の接続状態」「観戦者数」「観戦者リスト(名前+spid)」を集計
  presence() {
    const live = this.liveTokens();
    let spectators = 0;
    const specList = []; // 名前表示/追い出し用。payload肥大を避け先頭20件まで
    for (const c of this.room.getConnections()) {
      const cs = c.state;
      if (!(cs && (cs.seat === 'black' || cs.seat === 'white') && cs.token)) {
        spectators++;
        if (cs && cs.seat === 'spectator' && specList.length < 20) specList.push({ name: cs.name || 'ゲスト', spid: cs.spid || '' });
      }
    }
    const seat = c => {
      const s = this.game.seats[c];
      return s ? { name: s.name, connected: live.has(s.token), pid: s.pid } : null; // pid=公開ID(集計用)
    };
    return { black: seat('black'), white: seat('white'), spectators, specList };
  }
  stateMsg() {
    const g = this.game;
    const p = this.presence();
    return {
      type: 'state',
      board: g.board, turn: g.turn, last: g.last, result: g.result, pass: g.pass,
      gameNo: g.gameNo, rematch: g.rematch, series: g.series,
      seats: { black: p.black, white: p.white }, spectators: p.spectators, specList: p.specList,
    };
  }
  broadcastState() { this.room.broadcast(JSON.stringify(this.stateMsg())); }
}

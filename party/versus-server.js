/* 2人対戦オンライン 共通サーバー基盤 (ゲーム非依存)
   ──────────────────────────────────────────────────────────
   五目(server.js) / オセロ(othello-server.js) / まるばつ(ox-server.js) が共有する
   「席・マッチング(部屋=1DO)・状態同期・再戦・観戦・kick・グレース席解放」を一元化。
   ゲーム固有ロジックは以下のフックだけで表現する (サブクラスが実装):

     freshGame()             : 初期ゲーム状態を返す (board/turn/last/result/seats/rematch/gameNo/series + ゲーム固有フィールド)
     resetBoard(g)           : 盤だけ新規化 (席/シリーズ/トークンは保持)。再戦・途中解放リセットで使う
     normalizeGame(g)        : 旧/欠損 storage の ゲーム固有フィールド補完 (series/rematch/pid は基盤側で補完済み)
     applyMove(g,i,seat)     : 着手を検証&反映。非合法なら error文字列を返す (成立=null)。board/turn/last/result 等を更新
     undoMove(g,seat)        : 待った(直前1手取消)。不可なら error文字列を返す (成立=null)
     hasProgress(g)          : 1手以上進行したか (途中解放リセット・先後入替ガードで使用)
     extraState(g)           : state配信に足すゲーム固有フィールド (例 オセロ {pass})

   共通契約 (全ゲーム共有):
     - 盤の空きマスは null。盤サイズは g.board.length で判定 (ゲーム非依存)
     - 席の値/盤セル値は 'black' | 'white' (先手=black)。表示記号はクライアント側が担当
     - result: {winner:'black'|'white', line?} | {draw:true} | null。series は基盤が winner の pid で記録
   接続パス互換: wss://<host>/parties/<party>/<部屋コード> (party は wrangler の DOバインディング名 kebab) */

export const MARKS = ['black', 'white'];
export const GRACE_MS = 30000; // 席解放の猶予: 切断後この時間 再接続が無ければ席を解放

export function sanitizeName(v) {
  // 改行・制御文字を除去し、前後空白トリム、12文字制限。空なら 'ゲスト'
  const s = String(v ?? '').split('').filter(ch => { const cc = ch.charCodeAt(0); return cc > 31 && cc !== 127; }).join('').trim().slice(0, 12);
  return s || 'ゲスト';
}

export class VersusServer {
  constructor(room) {
    this.room = room;
    this.game = null; // onStart で storage から復元
  }

  // ── ゲーム固有フック (サブクラスで必ず実装) ─────────────
  freshGame() { throw new Error('freshGame() not implemented'); }
  resetBoard(g) { throw new Error('resetBoard() not implemented'); }
  normalizeGame(g) { /* 既定: ゲーム固有の補完なし */ }
  applyMove(g, i, seat) { throw new Error('applyMove() not implemented'); }
  undoMove(g, seat) { throw new Error('undoMove() not implemented'); }
  hasProgress(g) { throw new Error('hasProgress() not implemented'); }
  extraState(g) { return {}; }

  // ── ライフサイクル ───────────────────────────────────────
  async onStart() {
    const g = (await this.room.storage.get('game')) || this.freshGame();
    // 旧形式storage(本機能デプロイ前から残る部屋)の正規化: 共通フィールドを補完して例外を防ぐ
    if (!Array.isArray(g.series)) g.series = [];
    if (!g.rematch) g.rematch = { black: false, white: false };
    for (const c of MARKS) if (g.seats[c] && !g.seats[c].pid) g.seats[c].pid = crypto.randomUUID().slice(0, 8);
    this.normalizeGame(g); // ゲーム固有フィールド(moves/history/pass 等)の補完
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
        if (!g.result && this.hasProgress(g)) midGameReset = true; // 対局途中の解放 → 盤リセット
      }
    }
    if (released && midGameReset) { // fresh盤で残存席+新規がクリーンに開始できるように
      this.resetBoard(g);
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
      // ── 共通の権威検証: 着席プレイヤー / 手番一致 / 未決着 / 盤内かつ空きマス ──
      if (st.seat !== 'black' && st.seat !== 'white') return this.err(conn, '観戦中は着手できません');
      if (g.result) return this.err(conn, 'すでに決着しています');
      if (g.turn !== st.seat) return this.err(conn, 'あなたの手番ではありません');
      const i = m.index;
      if (!Number.isInteger(i) || i < 0 || i >= g.board.length) return this.err(conn, '盤外です');
      if (g.board[i] !== null) return this.err(conn, 'すでに石があります');
      // ── ゲーム固有: 合法性検証&反映(反転/手番送り/勝敗) ──
      const err = this.applyMove(g, i, st.seat);
      if (err) return this.err(conn, err);
      // 新たに決着した場合のみ シリーズ記録 (上で g.result 無しを保証済み)。winner=black/white | 引分=undefined
      if (g.result) {
        const w = g.result.winner || null;
        g.series.push({ game: g.gameNo, winner: (w && g.seats[w]) ? g.seats[w].pid : null });
      }
      await this.save();
      this.broadcastState();
      return;
    }

    if (m.type === 'undo') {
      // 待った: 直前に着手した本人だけ・相手応手前だけ取り消せる (合意不要・レース無し)
      if (st.seat !== 'black' && st.seat !== 'white') return; // 観戦者は無視
      const err = this.undoMove(g, st.seat);
      if (err) return this.err(conn, err);
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
        this.resetBoard(g);                  // 盤だけ初期化 (series/席は保持)
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
      if (this.hasProgress(g) || g.result) return this.err(conn, 'たいきょくちゅうは いれかえできません');
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
      board: g.board, turn: g.turn, last: g.last, result: g.result,
      gameNo: g.gameNo, rematch: g.rematch, series: g.series,
      seats: { black: p.black, white: p.white }, spectators: p.spectators, specList: p.specList,
      ...this.extraState(g), // ゲーム固有フィールド (例 オセロ {pass})
    };
  }
  broadcastState() { this.room.broadcast(JSON.stringify(this.stateMsg())); }
}

/* SimpleGridServer: 「空マスへ石を1つ置くだけ(反転なし)」の2人対戦の共通実装。
   五目(gomoku) と まるばつ(ox) が共有する。サブクラスは次の2つだけ与える:
     newBoard()             : 空盤 (Array(N).fill(null)) を返す
     checkResult(board,last): {winner:'black'|'white'|null, line} を返す純関数 (index.htmlと同一の勝敗判定)
   待った(undo)は moves 履歴を1つ戻すだけ (置くだけなので綺麗に巻き戻る)。 */
export class SimpleGridServer extends VersusServer {
  newBoard() { throw new Error('newBoard() not implemented'); }
  checkResult(board, last) { throw new Error('checkResult() not implemented'); }

  freshGame() {
    return {
      board: this.newBoard(),
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
  resetBoard(g) {
    g.board = this.newBoard();
    g.turn = 'black'; g.last = -1; g.moves = []; g.result = null;
  }
  normalizeGame(g) {
    // 進行中なら直前手をseed(待った可能に)
    if (!Array.isArray(g.moves)) g.moves = (g.last != null && g.last >= 0) ? [g.last] : [];
  }
  hasProgress(g) { return g.moves.length > 0; }

  applyMove(g, i, seat) {
    g.board[i] = seat;
    g.last = i; g.moves.push(i);
    const r = this.checkResult(g.board, i);
    if (r.winner) g.result = { winner: r.winner, line: r.line };
    else if (g.board.every(c => c)) g.result = { draw: true };
    else g.turn = seat === 'black' ? 'white' : 'black';
    return null; // 空マス着手は常に合法 (基盤側で空き検証済み)
  }
  undoMove(g, seat) {
    if (g.result || g.last < 0) return 'まったは できません';
    if (g.board[g.last] !== seat) return 'まったは できません'; // 直前手が自分の石でない
    if (g.turn === seat) return 'まったは できません';          // 自分の手番=まだ打ってない/相手が打った後
    g.board[g.last] = null;             // 直前1手を取り消し
    g.moves.pop();
    g.last = g.moves.length ? g.moves[g.moves.length - 1] : -1;
    g.turn = seat;                      // 手番を本人へ戻す
    return null;
  }
}

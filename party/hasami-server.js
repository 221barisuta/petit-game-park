/* はさみ将棋 オンライン対戦 PartyKit サーバー (部屋=1 Party = 1 Durable Object)
   ──────────────────────────────────────────────────────────
   席・マッチング・状態同期・再戦・観戦・kick・グレース席解放は versus-server.js の
   共通基盤 (VersusServer) に集約済み。ただし着手は from/to の2点(飛車動き)なので、
   共通の単一index 'move' ではなく 'hmove' {from,to} を独自に受ける(onMessageを拡張)。

   固有ロジック:
     - 盤: 9×9 / 歩のみ各9枚 / 飛車動き / 挟み・角取り (hasami-core.js)
     - 勝敗: 5枚取り先取 (caps[色] >= HAS_CAP_TO_WIN)
     - まった(undo): 盤スナップショット方式 (取りも巻き戻る)
   共通契約に加えるゲーム固有フィールド: state.caps({black,white}=取った枚数) / state.from(直前手の移動元) を extraState で配信。
   接続パス: wss://<host>/parties/hasami/<部屋コード> (DOバインディング "Hasami")。 */
import { HAS_N, HAS_CAP_TO_WIN, hasOpp, hasInitial, hasLegalTo, hasApply } from './hasami-core.js';
import { VersusServer } from './versus-server.js';

export default class HasamiServer extends VersusServer {
  freshGame() {
    return {
      board: hasInitial(),                            // 9×9=81・各9枚
      turn: 'black',
      last: -1,                                       // 直前手の着地マス
      from: -1,                                       // 直前手の移動元 (盤面の表示用)
      caps: { black: 0, white: 0 },                   // 各色が取った枚数
      history: [],                                    // まった用スナップショット [{board,turn,last,from,caps}]
      result: null,                                   // {winner} のみ (引分は基本起きない)
      seats: { black: null, white: null },
      rematch: { black: false, white: false },
      gameNo: 1,
      series: [],
    };
  }
  resetBoard(g) {
    g.board = hasInitial();
    g.turn = 'black'; g.last = -1; g.from = -1; g.caps = { black: 0, white: 0 }; g.history = []; g.result = null;
  }
  normalizeGame(g) {
    if (!Array.isArray(g.history)) g.history = [];
    if (!g.caps) g.caps = { black: 0, white: 0 };
    if (g.from === undefined) g.from = -1;
  }
  hasProgress(g) { return g.history.length > 0; }
  extraState(g) { return { caps: g.caps, from: g.from }; }
  // 単一index move は使わない(hmove を使う)。抽象実装義務のためエラーを返す。
  applyMove() { return 'この ゲームは hmove を つかいます'; }
  undoMove(g, seat) {
    // 待った: 直前手を指した席(=top.turn)が自分で・未決着なら1手戻す (取りも巻き戻る)
    if (g.result || !g.history.length) return 'まったは できません';
    const top = g.history[g.history.length - 1];
    if (top.turn !== seat) return 'まったは できません';
    g.history.pop();
    g.board = top.board; g.turn = top.turn; g.last = top.last; g.from = top.from;
    g.caps = { black: top.caps.black, white: top.caps.white };
    return null;
  }

  // 共通 onMessage を拡張: 'hmove' を横取りし、それ以外(hello/undo/rematch/kick/takeSeat…)は基盤へ委譲。
  async onMessage(raw, conn) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m && m.type === 'hmove') return this.handleHmove(m, conn);
    return super.onMessage(raw, conn);
  }
  async handleHmove(m, conn) {
    const g = this.game, st = conn.state || {};
    // 共通の権威検証(base の move と同型)
    if (st.seat !== 'black' && st.seat !== 'white') return this.err(conn, '観戦中は着手できません');
    if (g.result) return this.err(conn, 'すでに決着しています');
    if (g.turn !== st.seat) return this.err(conn, 'あなたの手番ではありません');
    const from = m.from, to = m.to;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= HAS_N * HAS_N || to < 0 || to >= HAS_N * HAS_N)
      return this.err(conn, 'ばんがいです');
    if (g.board[from] !== st.seat) return this.err(conn, 'じぶんの こまを うごかしてください');
    if (!hasLegalTo(g.board, from, st.seat).includes(to)) return this.err(conn, 'そこには うごけません');
    // 受理: スナップショットを積んでから 移動+取り を反映
    g.history.push({ board: g.board.slice(), turn: g.turn, last: g.last, from: g.from, caps: { black: g.caps.black, white: g.caps.white } });
    const res = hasApply(g.board, from, to, st.seat);
    g.board = res.board; g.from = from; g.last = to; g.caps[st.seat] += res.captured.length;
    if (g.caps[st.seat] >= HAS_CAP_TO_WIN) g.result = { winner: st.seat };
    else g.turn = hasOpp(st.seat);
    if (g.result) {
      const w = g.result.winner;
      g.series.push({ game: g.gameNo, winner: (w && g.seats[w]) ? g.seats[w].pid : null });
    }
    await this.save();
    this.broadcastState();
  }
}

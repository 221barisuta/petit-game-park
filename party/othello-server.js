/* オセロ オンライン対戦 PartyKit サーバー (部屋=1 Party = 1 Durable Object)
   ──────────────────────────────────────────────────────────
   席・マッチング・状態同期・再戦・観戦・kick・グレース席解放は versus-server.js の
   共通基盤 (VersusServer) に集約済み。ここはオセロ固有ロジックだけを差し替える:
     - 盤: 8x8=64マス・初期4石 (othInitial)
     - 着手: 合法手のみ (getFlips が空=非合法で拒否) → 反転を反映
     - 手番: 相手に手あり=交代 / 相手0手・自分手あり=自動パス(手番維持,pass表示) / 両者0手=終局
     - 勝敗: 終局時に石数(getWinner)で判定
     - まった(undo): 盤スナップショット方式 (反転も自動パスも綺麗に巻き戻る)

   共通契約に加えるゲーム固有フィールド:
     - state.pass: 直前に自動パスされた色 (次着手まで表示)。null なら通常。 (extraState で配信)
   接続パス: wss://<host>/parties/othello/<部屋コード> (DOバインディング "Othello")。 */
import { OTH_N, othOpp, othInitial, getFlips, getValidMoves, getWinner } from './othello-core.js';
import { VersusServer } from './versus-server.js';

export default class OthelloServer extends VersusServer {
  freshGame() {
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
  resetBoard(g) {
    g.board = othInitial();
    g.turn = 'black'; g.last = -1; g.pass = null; g.history = []; g.result = null;
  }
  normalizeGame(g) {
    // 旧形式/欠損フィールドの正規化 (新DOなので通常は不要だが冪等保険)
    if (!Array.isArray(g.history)) g.history = [];
    if (g.pass === undefined) g.pass = null;
  }
  hasProgress(g) { return g.history.length > 0; } // 初期盤に石があるので手数(スナップショット数)で判定
  extraState(g) { return { pass: g.pass }; }

  applyMove(g, i, seat) {
    const flips = getFlips(g.board, i, seat);
    if (!flips.length) return 'そこには おけません';
    // 受理: まった用スナップショットを積んでから反転を反映
    g.history.push({ board: g.board.slice(), turn: g.turn, last: g.last, pass: g.pass });
    g.board[i] = seat; for (const f of flips) g.board[f] = seat;
    g.last = i; g.pass = null;
    // 手番送り: 相手に手あり=交代 / 相手0手・自分手あり=自動パス(手番維持) / 両者0手=終局
    const opp = othOpp(seat);
    if (getValidMoves(g.board, opp).length) {
      g.turn = opp;
    } else if (getValidMoves(g.board, seat).length) {
      g.pass = opp; // 相手を自動パス。手番は自分のまま
    } else {
      const w = getWinner(g.board); // 両者打てない → 終局。石数で勝敗
      g.result = w === 'draw' ? { draw: true } : { winner: w };
    }
    return null;
  }
  undoMove(g, seat) {
    // 待った: スナップショット top.turn = その手を打った色。それが自分なら「直前手が自分・相手未応手」。
    if (g.result || !g.history.length) return 'まったは できません';
    const top = g.history[g.history.length - 1];
    if (top.turn !== seat) return 'まったは できません'; // 直前手が自分でない(相手が応手した後 等)
    g.history.pop();
    g.board = top.board; g.turn = top.turn; g.last = top.last; g.pass = top.pass; // 直前1手を巻き戻し(反転/自動パス込み)
    return null;
  }
}

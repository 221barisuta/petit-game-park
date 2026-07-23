/* ドット&ボックス オンライン対戦 PartyKit サーバー (部屋=1 Party = 1 Durable Object)
   ──────────────────────────────────────────────────────────
   席・マッチング・状態同期・再戦・観戦・kick・グレース席解放は versus-server.js の
   共通基盤 (VersusServer) に集約済み。ここはドット&ボックス固有だけを差し替える:
     - 盤: 40辺(board) + 16箱の所有(boxes)。着手=辺を1本引く (move.index=辺index)
     - 手番継続(最重要): 引いた辺で 1つ以上の箱が完成したら 得点し「手番を維持」(=もう1手)。
       完成0なら手番交代。これを g.turn に載せてサーバー権威で全clientへ配信する。
     - 勝敗: 全40辺が引かれたら 箱の多い席が勝ち (同数=引分)
     - まった(undo): 盤スナップショット方式 (箱獲得/手番継続も綺麗に巻き戻る)

   共通契約に加えるゲーム固有フィールド: state.boxes (16箱の所有席色) を extraState で配信。
   接続パス: wss://<host>/parties/dots/<部屋コード> (DOバインディング "Dots")。 */
import { DOTS_EDGES, DOTS_BOXES, dotsCompletedBy, dotsFull, dotsWinner } from './dots-core.js';
import { VersusServer } from './versus-server.js';

export default class DotsServer extends VersusServer {
  freshGame() {
    return {
      board: new Array(DOTS_EDGES).fill(null),        // 40辺: null | 'black' | 'white'(引いた席)
      turn: 'black',
      last: -1,
      boxes: new Array(DOTS_BOXES).fill(null),        // 16箱の所有席色
      history: [],                                    // まった用スナップショット [{board,boxes,turn,last}]
      result: null,                                   // {winner} | {draw:true}
      seats: { black: null, white: null },
      rematch: { black: false, white: false },
      gameNo: 1,
      series: [],
    };
  }
  resetBoard(g) {
    g.board = new Array(DOTS_EDGES).fill(null);
    g.boxes = new Array(DOTS_BOXES).fill(null);
    g.turn = 'black'; g.last = -1; g.history = []; g.result = null;
  }
  normalizeGame(g) {
    if (!Array.isArray(g.history)) g.history = [];
    if (!Array.isArray(g.boxes)) g.boxes = new Array(DOTS_BOXES).fill(null);
  }
  hasProgress(g) { return g.history.length > 0; }
  extraState(g) { return { boxes: g.boxes }; }

  applyMove(g, i, seat) {
    // (共通基盤が範囲 0..39・board[i]===null を検証済み)
    g.history.push({ board: g.board.slice(), boxes: g.boxes.slice(), turn: g.turn, last: g.last });
    g.board[i] = seat; g.last = i;
    const done = dotsCompletedBy(g.board, i);
    for (const bx of done) g.boxes[bx] = seat; // 完成箱を得点
    if (dotsFull(g.board)) {                    // 全辺 → 終局。箱数で勝敗
      const w = dotsWinner(g.boxes);
      g.result = w === 'draw' ? { draw: true } : { winner: w };
    } else if (done.length > 0) {
      g.turn = seat;                            // 手番継続 (箱を取ったら もう1手)
    } else {
      g.turn = seat === 'black' ? 'white' : 'black'; // 交代
    }
    return null;
  }
  undoMove(g, seat) {
    // 待った: 直前手を引いた席(=top.turn)が自分で・未決着なら1手戻す
    if (g.result || !g.history.length) return 'まったは できません';
    const top = g.history[g.history.length - 1];
    if (top.turn !== seat) return 'まったは できません';
    g.history.pop();
    g.board = top.board; g.boxes = top.boxes; g.turn = top.turn; g.last = top.last;
    return null;
  }
}

/* コネクトフォー オンライン対戦 PartyKit サーバー (部屋=1 Party = 1 Durable Object)
   ──────────────────────────────────────────────────────────
   席・マッチング・状態同期・再戦・観戦・kick・グレース席解放は versus-server.js の
   共通基盤 (SimpleGridServer) に集約済み。ここはコネクトフォー固有だけを与える:
     - 盤: 7列×6段=42マス / 4連判定 (c4CheckWin)
     - 重力: クライアントは重力解決済みの着地index(=列の最下段の空き)を move.index で送る。
       サーバーは権威検証として「そのマスが列の最下段の空きか」を applyMove で再検証し、
       浮いたマス(重力違反)を拒否する。(共通基盤の move ハンドラが 範囲内・空きマス は検証済み)

   座席: 1人目=黒(先手) / 2人目=白(後手) / 3人目以降=観戦。盤には席色 'black'/'white' を格納。
   まった(undo): SimpleGridServer の moves 履歴で直前1手を戻す (重力上つねに列の最上段が直前手)。
   接続パス: wss://<host>/parties/c4/<部屋コード> (DOバインディング "Connect4")。 */
import { C4_COLS, C4_ROWS, c4CheckWin } from './c4-core.js';
import { SimpleGridServer } from './versus-server.js';

const SIZE = C4_COLS * C4_ROWS; // 42

export default class Connect4Server extends SimpleGridServer {
  newBoard() { return new Array(SIZE).fill(null); }
  // 縦横斜め4連を走査 (置くだけ・last不要)。純関数・index.htmlと同一。
  checkResult(board) { return c4CheckWin(board); }
  // 重力の権威検証: 着地index i は 最下段(r=5) か 直下(i+7)が埋まっている時のみ合法。
  applyMove(g, i, seat) {
    const c = i % C4_COLS, r = (i - c) / C4_COLS;
    if (!(r === C4_ROWS - 1 || g.board[i + C4_COLS] !== null)) return 'そこには おけません'; // 浮きマス=重力違反
    return super.applyMove(g, i, seat); // board[i]=seat / moves履歴 / 4連・満局判定 / 手番送り
  }
}

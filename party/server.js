/* 五目並べ オンライン対戦 PartyKit サーバー (部屋=1 Party = 1 Durable Object)
   ──────────────────────────────────────────────────────────
   席・マッチング・状態同期・再戦・観戦・kick・グレース席解放は versus-server.js の
   共通基盤 (SimpleGridServer) に集約済み。ここは五目固有(盤サイズ 15x15 / 5連判定)だけを与える。

   - 盤面を権威的に保持・検証 (クライアントを信用しない)
   - 座席: 1人目=黒(先手) / 2人目=白(後手) / 3人目以降=観戦
   - 再接続: 席トークンで同席復帰 (DO生存中は席を保持)
   - もう一局: 両者合意でリセット + 先手後手入替
   - まった(undo): 直前手の本人だけ・相手応手前だけ取消可 (SimpleGridServer が moves 履歴で処理)
   - 勝敗判定は純関数 checkGomoku(board,lastIndex) に分離 (index.html と同一・parity.test.mjs が担保)

   メッセージ/接続パス互換は versus-server.js の共通契約どおり (wss://<host>/parties/main/<code>)。 */
import { GO_N, checkGomoku } from './gomoku-core.js';
import { SimpleGridServer } from './versus-server.js';

const SIZE = GO_N * GO_N; // 225

export default class GomokuServer extends SimpleGridServer {
  newBoard() { return new Array(SIZE).fill(null); }
  // lastIndex から4方向を見て5連を判定 (winner + 勝ち連 line)。純関数・index.htmlと同一。
  checkResult(board, lastIndex) { return checkGomoku(board, lastIndex); }
}

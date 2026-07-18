/* まるばつ(三目並べ) オンライン対戦 PartyKit サーバー (部屋=1 Party = 1 Durable Object)
   ──────────────────────────────────────────────────────────
   席・マッチング・状態同期・再戦・観戦・kick・グレース席解放は versus-server.js の
   共通基盤 (SimpleGridServer) に集約済み。ここは三目固有(盤 3x3=9マス / 3連判定)だけを与える。

   - 座席: 1人目=黒(先手=○表示) / 2人目=白(後手=×表示) / 3人目以降=観戦
     ※盤には席色 'black'/'white' を格納 (共通基盤の契約)。○/× への読み替えはクライアントが担当。
   - まった(undo): 直前手の本人だけ・相手応手前だけ取消可 (SimpleGridServer が moves 履歴で処理)
   - 勝敗判定は純関数 checkWin(board) に分離 (index.html と同一・ox-parity.test.mjs が担保)

   接続パス: wss://<host>/parties/ox/<部屋コード> (DOバインディング "Ox")。 */
import { OX_N, checkWin } from './ox-core.js';
import { SimpleGridServer } from './versus-server.js';

const SIZE = OX_N * OX_N; // 9

export default class TicTacToeServer extends SimpleGridServer {
  newBoard() { return new Array(SIZE).fill(null); }
  // 8本の勝ち筋を走査し winner + 勝ち筋line を返す (置くだけなので last は不要)。純関数・index.htmlと同一。
  checkResult(board) { return checkWin(board); }
}

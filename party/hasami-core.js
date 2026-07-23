/* はさみ将棋 共有コアロジック
   ──────────────────────────────────────────────────────────
   クライアント=index.html / サーバー=party/hasami-server.js で「同一」でなければならない。
   index.html を正本とし、本ファイルへ verbatim でコピーする。
   一致は party/hasami-parity.test.mjs が機械的に検証する (divergence厳禁)。

   採用ルール(報告に明記):
   - 盤: 9×9=81マス (index=r*9+c, r=0 が最上段)。歩のみ各9枚。
   - 初期配置: 後手(white)=最上段 row0 / 先手(black)=最下段 row8。black先手。
   - 移動: 飛車動き(縦横に任意マス・駒を飛び越えない)。空マスにのみ着地。
   - 取り(挟み): 着手後、着地マスから4方向を見て「相手の歩が1枚以上連続し、その先が自分の歩」で
     挟めていれば その相手の歩を全て取る(オセロの反転と同型だが取り除く)。
   - 角(かど)取り: 盤の四隅の相手歩は、隣接する2マス(辺沿い)が両方 自分の歩なら取る。
   - 勝敗: 5枚取り先取で勝ち(CAP_TO_WIN=5・固定)。 */
export const HAS_N = 9;
export const HAS_CAP_TO_WIN = 5;

export function hasOpp(color) { return color === 'black' ? 'white' : 'black'; }
export function hasInitial() {
  const b = new Array(HAS_N * HAS_N).fill(null);
  for (let c = 0; c < HAS_N; c++) { b[c] = 'white'; b[(HAS_N - 1) * HAS_N + c] = 'black'; }
  return b;
}
/* from の歩(color)が飛車動きで行けるマスのindex配列(昇順)。fromがcolorの歩でなければ []。副作用なし。 */
export function hasLegalTo(board, from, color) {
  if (from < 0 || from >= HAS_N * HAS_N || board[from] !== color) return [];
  const N = HAS_N, x = from % N, y = (from - x) / N, out = [];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    let cx = x + dx, cy = y + dy;
    while (cx >= 0 && cx < N && cy >= 0 && cy < N && board[cy * N + cx] === null) { out.push(cy * N + cx); cx += dx; cy += dy; }
  }
  return out;
}
/* board(=mover を to に置いた後の盤)で、to の着手により取れる相手歩のindex配列。副作用なし。
   挟み(4方向)+ 角取り(四隅)。重複は除く。 */
export function hasCapturedBy(board, to, color) {
  const N = HAS_N, x = to % N, y = (to - x) / N, opp = hasOpp(color), caps = new Set();
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const line = []; let cx = x + dx, cy = y + dy;
    while (cx >= 0 && cx < N && cy >= 0 && cy < N && board[cy * N + cx] === opp) { line.push(cy * N + cx); cx += dx; cy += dy; }
    if (line.length && cx >= 0 && cx < N && cy >= 0 && cy < N && board[cy * N + cx] === color) for (const i of line) caps.add(i);
  }
  // 角取り: 四隅の相手歩を 辺沿い2隣接が両方 自分の歩なら取る
  const corners = [
    [0, 1, N],                          // (0,0)
    [N - 1, N - 2, 2 * N - 1],          // (0,8)
    [(N - 1) * N, (N - 1) * N + 1, (N - 2) * N],           // (8,0)
    [N * N - 1, N * N - 2, N * N - 1 - N],                 // (8,8)
  ];
  for (const [corner, n1, n2] of corners)
    if (board[corner] === opp && board[n1] === color && board[n2] === color) caps.add(corner);
  return [...caps];
}
/* from→to(color)を適用した {board:新盤面, captured:[取ったindex]} を返す。入力boardは不変。
   合法性(from/toの妥当性)は呼び出し側が hasLegalTo で検証済みの前提。 */
export function hasApply(board, from, to, color) {
  const nb = board.slice();
  nb[from] = null; nb[to] = color;
  const captured = hasCapturedBy(nb, to, color);
  for (const i of captured) nb[i] = null;
  return { board: nb, captured };
}
/* 盤上の 各色の歩数。副作用なし。 */
export function hasCount(board) {
  let bk = 0, wt = 0;
  for (const v of board) { if (v === 'black') bk++; else if (v === 'white') wt++; }
  return { black: bk, white: wt };
}

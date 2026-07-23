/* ドット&ボックス 共有コアロジック
   ──────────────────────────────────────────────────────────
   クライアント=index.html / サーバー=party/dots-server.js で「同一」でなければならない。
   index.html を正本とし、本ファイルへ verbatim でコピーする。
   一致は party/dots-parity.test.mjs が機械的に検証する (divergence厳禁)。

   盤: 5×5ドット = 4×4=16箱 (DOTS_N=4)。辺(edge)は 40本:
     - 横辺(H) 20本: hRow 0..4 × hCol 0..3 → index = hRow*4 + hCol           (0..19)
     - 縦辺(V) 20本: vRow 0..3 × vCol 0..4 → index = 20 + vRow*5 + vCol       (20..39)
   箱(br,bc) (br,bc in 0..3, index=br*4+bc) を囲む4辺:
     top=br*4+bc / bottom=(br+1)*4+bc / left=20+br*5+bc / right=20+br*5+bc+1
   盤(board[40]) の各辺は null(未) / 'black' / 'white'(引いた席色)。boxes[16] は各箱の所有席色。 */
export const DOTS_N = 4;            // 1辺あたりの箱数
export const DOTS_H = (DOTS_N + 1) * DOTS_N;     // 横辺 20
export const DOTS_V = DOTS_N * (DOTS_N + 1);     // 縦辺 20
export const DOTS_EDGES = DOTS_H + DOTS_V;       // 40
export const DOTS_BOXES = DOTS_N * DOTS_N;       // 16

/* 箱box(0..15)を囲む4辺の global edge index [top,bottom,left,right]。副作用なし。 */
export function dotsBoxEdges(box) {
  const br = Math.floor(box / DOTS_N), bc = box % DOTS_N;
  return [
    br * DOTS_N + bc,               // top    (H)
    (br + 1) * DOTS_N + bc,         // bottom (H)
    DOTS_H + br * (DOTS_N + 1) + bc,       // left  (V)
    DOTS_H + br * (DOTS_N + 1) + bc + 1,   // right (V)
  ];
}
/* 辺edgeに接する箱のindex配列 (1つ or 2つ)。副作用なし。 */
export function dotsEdgeBoxes(edge) {
  const out = [];
  if (edge < DOTS_H) { // 横辺: hRow の 上下の箱
    const hRow = Math.floor(edge / DOTS_N), hCol = edge % DOTS_N;
    if (hRow - 1 >= 0) out.push((hRow - 1) * DOTS_N + hCol);       // 上の箱
    if (hRow < DOTS_N) out.push(hRow * DOTS_N + hCol);             // 下の箱
  } else {             // 縦辺: vCol の 左右の箱
    const v = edge - DOTS_H, vRow = Math.floor(v / (DOTS_N + 1)), vCol = v % (DOTS_N + 1);
    if (vCol - 1 >= 0) out.push(vRow * DOTS_N + (vCol - 1));       // 左の箱
    if (vCol < DOTS_N) out.push(vRow * DOTS_N + vCol);             // 右の箱
  }
  return out;
}
/* 箱boxの 現在引かれている辺の数 (0..4)。副作用なし。 */
export function dotsBoxCount(board, box) {
  let n = 0; for (const e of dotsBoxEdges(box)) if (board[e]) n++; return n;
}
/* board(edge引き済み)で、辺edgeによって新たに完成した箱のindex配列。副作用なし。
   edge は board[edge] が既に非nullである前提 (引いた直後に呼ぶ)。 */
export function dotsCompletedBy(board, edge) {
  const out = [];
  for (const bx of dotsEdgeBoxes(edge)) if (dotsBoxCount(board, bx) === 4) out.push(bx);
  return out;
}
/* 全辺が引かれたか (=全箱決着)。副作用なし。 */
export function dotsFull(board) { return board.every(e => e !== null); }
/* boxes(所有席色配列)から勝者を返す。全箱決着時に呼ぶ: 'black'|'white'|'draw'。 */
export function dotsWinner(boxes) {
  let bk = 0, wt = 0;
  for (const o of boxes) { if (o === 'black') bk++; else if (o === 'white') wt++; }
  return bk > wt ? 'black' : wt > bk ? 'white' : 'draw';
}

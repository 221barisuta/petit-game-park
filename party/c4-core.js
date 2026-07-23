/* コネクトフォー(重力付き四目) 共有コアロジック
   ──────────────────────────────────────────────────────────
   クライアント=index.html / サーバー=party/c4-server.js で「同一」でなければならない。
   index.html を正本とし、本ファイルへ verbatim でコピーする。
   一致は party/c4-parity.test.mjs が機械的に検証する (五目/オセロ/三目と同運用・divergence厳禁)。

   盤: 7列×6段=42マス。index = r*7+c (r=0 が最上段、r=5 が最下段=着地列の底)。
   マスの値は null(空) / 'black' / 'white' (先手=black)。表示は色非依存(クライアント側)。 */
export const C4_COLS = 7;
export const C4_ROWS = 6;

/* col列に石を落とした時の着地index (最下段の空きマス) を返す。列が満杯なら -1。副作用なし。 */
export function c4Drop(board, col) {
  if (col < 0 || col >= C4_COLS) return -1;
  for (let r = C4_ROWS - 1; r >= 0; r--) { const i = r * C4_COLS + col; if (board[i] === null) return i; }
  return -1;
}

/* 現在おける列(満杯でない列)のindex配列を昇順で返す。副作用なし。 */
export function c4ValidCols(board) {
  const out = [];
  for (let c = 0; c < C4_COLS; c++) if (board[c] === null) out.push(c); // 最上段(r=0)が空なら落とせる
  return out;
}

/* 縦横斜め4連を走査し {winner, line} を返す。無ければ {winner:null, line:null}。副作用なし。
   line は勝ち筋4マスのindex配列 (コピー返し)。空マスは null(falsy)。 */
export function c4CheckWin(board) {
  const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]]; // →, ↓, ↘, ↙
  for (let r = 0; r < C4_ROWS; r++) for (let c = 0; c < C4_COLS; c++) {
    const v = board[r * C4_COLS + c];
    if (!v) continue;
    for (const [dr, dc] of DIRS) {
      const line = [r * C4_COLS + c];
      let ok = true;
      for (let k = 1; k < 4; k++) {
        const nr = r + dr * k, nc = c + dc * k;
        if (nr < 0 || nr >= C4_ROWS || nc < 0 || nc >= C4_COLS || board[nr * C4_COLS + nc] !== v) { ok = false; break; }
        line.push(nr * C4_COLS + nc);
      }
      if (ok) return { winner: v, line };
    }
  }
  return { winner: null, line: null };
}

/* 盤が満杯か (=全マス埋まり)。副作用なし。 */
export function c4Full(board) { return board.every(c => c !== null); }

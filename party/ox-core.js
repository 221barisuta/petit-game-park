/* まるばつ(三目並べ) 共有コアロジック (クライアント=index.html / サーバー=party/ox-server.js で一致させる)
   ──────────────────────────────────────────────────────────
   この checkWin は index.html の同名関数と「同一」でなければならない (divergence厳禁)。
   index.html を正本とし、本ファイルへ verbatim でコピーする。
   一致は party/ox-parity.test.mjs が機械的に検証する (CIで落ちる)。
   (五目の gomoku-core.js / オセロの othello-core.js と同じ運用)

   ※ checkWin は色非依存: マスの値が '○'/'×'(ローカル対戦) でも 'black'/'white'(オンライン) でも動く。
     オンラインは席色 'black'/'white' を盤に格納するので winner も 'black'/'white' が返る。 */
export const OX_N = 3; // 3x3

/* 8本の勝ち筋を走査し、3つ同色そろった線を返す。空マスは null(falsy)。副作用なし。
   line は勝ち筋の3マスindexを返す (line.slice() でコピー返し = 内部定数 L に mutation が波及しない)。 */
export function checkWin(board){
  const L=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for(const line of L){
    const [a,b,c]=line;
    if(board[a]&&board[a]===board[b]&&board[a]===board[c])
      return {winner:board[a],line:line.slice()}; // コピー返し: 呼び出し側のmutationが内部定数Lに波及しない
  }
  return {winner:null,line:null};
}

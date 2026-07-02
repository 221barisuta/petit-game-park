/* オセロ 共有コアロジック (クライアント=index.html / サーバー=party/othello-server.js で一致させる)
   ──────────────────────────────────────────────────────────
   この盤面ロジック(OTH_N/othOpp/othInitial/getFlips/getValidMoves/applyMove/
   countStones/isGameOver/getWinner)は index.html の同名関数と「同一」でなければならない。
   index.html を正本とし、本ファイルへ verbatim でコピーする。
   一致は party/othello-parity.test.mjs が機械的に検証する (CIで落ちる)。
   (五目の gomoku-core.js と同じ運用: divergence厳禁) */
export const OTH_N=8;
const OTH_DIRS=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]; // 8方向
export function othOpp(color){return color==='black'?'white':'black';}
export function othInitial(){
  const b=Array(OTH_N*OTH_N).fill(null);
  b[27]='white';b[36]='white';b[28]='black';b[35]='black';return b;
}
// その手で反転するマスのindex配列を返す。空(非合法)なら []。副作用なし。
export function getFlips(board,index,color){
  if(index<0||index>=OTH_N*OTH_N||board[index]!==null)return [];
  const N=OTH_N,x=index%N,y=Math.floor(index/N),opp=othOpp(color),flips=[];
  for(const [dx,dy] of OTH_DIRS){
    const line=[];let cx=x+dx,cy=y+dy;
    while(cx>=0&&cx<N&&cy>=0&&cy<N&&board[cy*N+cx]===opp){line.push(cy*N+cx);cx+=dx;cy+=dy;}
    if(line.length&&cx>=0&&cx<N&&cy>=0&&cy<N&&board[cy*N+cx]===color)flips.push(...line); // 自石で挟めた時のみ確定
  }
  return flips;
}
// color が打てる合法手のindex配列 (昇順・決定的)。副作用なし。
export function getValidMoves(board,color){
  const moves=[];
  for(let i=0;i<board.length;i++)if(board[i]===null&&getFlips(board,i,color).length)moves.push(i);
  return moves;
}
// 着手+反転を反映した新盤面を返す (入力 board は不変)。非合法手なら内容不変のコピーを返す。
export function applyMove(board,index,color){
  const flips=getFlips(board,index,color);
  const nb=board.slice();
  if(!flips.length)return nb;
  nb[index]=color;for(const f of flips)nb[f]=color;return nb;
}
export function countStones(board){
  let black=0,white=0;
  for(const c of board){if(c==='black')black++;else if(c==='white')white++;}
  return {black,white};
}
// 両者とも合法手なし (盤が埋まった場合も含む) で終局。副作用なし。
export function isGameOver(board){
  return getValidMoves(board,'black').length===0&&getValidMoves(board,'white').length===0;
}
export function getWinner(board){
  const {black,white}=countStones(board);
  return black>white?'black':white>black?'white':'draw';
}

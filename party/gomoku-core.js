/* 五目並べ 共有コアロジック (クライアント=index.html / サーバー=party/server.js で一致させる)
   ──────────────────────────────────────────────────────────
   この checkGomoku は index.html の同名関数と「同一」でなければならない (divergence厳禁)。
   index.html を正本とし、本ファイルへ verbatim でコピーする。
   一致は party/parity.test.mjs が機械的に検証する (CIで落ちる)。 */
export const GO_N = 15; // 連珠規格 15x15

/* lastIndex から4方向に同色連続を数え、5以上で勝ち。
   line は勝ち連の全長を「負方向端→正方向端」の順で返す
   (右上がり[1,-1]だけは数値降順。描画は端点利用なので順序非依存)。副作用なし。 */
export function checkGomoku(board,lastIndex){
  if(lastIndex==null||lastIndex<0||lastIndex>=GO_N*GO_N||!board[lastIndex])return {winner:null,line:null};
  const color=board[lastIndex];
  const x=lastIndex%GO_N, y=Math.floor(lastIndex/GO_N);
  const dirs=[[1,0],[0,1],[1,1],[1,-1]]; // 横・縦・右下がり・左下がり
  for(const [dx,dy] of dirs){
    const run=[lastIndex];
    for(let k=1;k<GO_N;k++){ // 正方向
      const nx=x+dx*k,ny=y+dy*k;
      if(nx<0||nx>=GO_N||ny<0||ny>=GO_N||board[ny*GO_N+nx]!==color)break;
      run.push(ny*GO_N+nx);
    }
    for(let k=1;k<GO_N;k++){ // 逆方向 (先頭へ積む = 負方向端から順)
      const nx=x-dx*k,ny=y-dy*k;
      if(nx<0||nx>=GO_N||ny<0||ny>=GO_N||board[ny*GO_N+nx]!==color)break;
      run.unshift(ny*GO_N+nx);
    }
    if(run.length>=5)return {winner:color,line:run.slice()}; // コピー返し: 呼び出し側のmutationが波及しない
  }
  return {winner:null,line:null};
}

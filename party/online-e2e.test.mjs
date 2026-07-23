/* オンライン対戦UIの実プロトコルE2E (PR #33 のレビュー指摘で checked-in 化)
   ──────────────────────────────────────────────────────────
   index.html から makeOnlineNet〜makeVsOnlineUI を抽出し、ローカルの実DOサーバに
   2クライアントで接続して、五目=着席/1タップ非確定/着手ミラー/待った/決着演出1回/
   再戦オファー→承諾→新対局/退室、オセロ=非合法マス拒否/着手ミラー を機械検証する。

   実行:  cd party && npx wrangler dev --port 8787 --local   (別ターミナル)
          node party/online-e2e.test.mjs                      (リポジトリルートから)
   依存:  devDependencies の ws (npm install 済みであること)
   注意:  --local のDOはメモリ内なので本番データには一切触れない */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocket as WS } from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const HOST = process.env.E2E_HOST || 'localhost:8787';

// ── 接続先の事前チェック (wrangler dev 未起動なら分かりやすく終了) ──
try {
  await fetch(`http://${HOST}/`);
} catch (e) {
  console.error(`[online e2e] ${HOST} に接続できません。先に \`cd party && npx wrangler dev --port 8787 --local\` を起動してください`);
  process.exit(2);
}

// ── index.html からネット層〜オンラインUIファクトリを抽出 (連続領域) ──
const s1 = html.indexOf('function makeOnlineNet(opts){');
const e1 = html.indexOf('return {st,enter,leave,mirror,showHint,undoOk,drawButtons,onTap};');
if (s1 < 0 || e1 < 0) { console.error('[online e2e] index.html から makeOnlineNet/makeVsOnlineUI を抽出できませんでした'); process.exit(2); }
const src = html.slice(s1, html.indexOf('\n}', e1) + 2);
// オセロ盤ロジック (合法手計算用。othello-parity.test.mjs と同じアンカー)
const s2 = html.indexOf('const OTH_N=8;');
const othSrc = html.slice(s2, html.indexOf('// --- #9', s2));
// コネクトフォー コア (重力・4連。c4-parity.test.mjs と同じアンカー)
const s3 = html.indexOf('/* C4-CORE-BEGIN');
const c4Src = html.slice(s3, html.indexOf('/* C4-CORE-END */', s3));

let pass = 0, fail = 0;
const ck = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'ok   ' : 'FAIL ') + name); };
const until = async (f, ms = 8000, tick) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (tick) tick(); if (f()) return true; await new Promise(r => setTimeout(r, 60)); }
  return false;
};

function makeEnv() { // クライアント1人分の隔離スコープ (store/席トークンを分離)
  const el = { value: '', textContent: '', classList: { add() {}, remove() {} } };
  const env = {
    store: { _m: {}, get(k, d) { return k in this._m ? this._m[k] : d; }, set(k, v) { this._m[k] = v; } },
    window: { PGP_CONFIG: { partyHost: HOST }, open() {} },
    location: { origin: 'http://e2e', pathname: '/' }, history: { replaceState() {} },
    document: {}, navigator: {},
    banner: m => env.banners.push(m), banners: [],
    AudioKit: { pop() {}, bad() {}, coin() {}, ok() {}, fever() {} }, vib() {},
    $: () => el, renderOnlineBar() {},
    drawBtn: (g, b, label) => env.labels.push(label), labels: [],
    hitBtn: (b, x, y) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h,
    WebSocket: WS, setTimeout, clearTimeout,
    // #14 以降の PROFILE 依存に対応 (それ以前の index.html では未使用パラメータになるだけ)
    PROFILE: { randName: () => 'e2e', getName: () => 'e2e', setName() {},
      getAvatar: () => '', setAvatar() {}, dispName: () => '🤖e2e',
      optIn: () => false, setOptIn() {} },
  };
  const keys = Object.keys(env);
  const fn = new Function(...keys, src + '\n' + othSrc + '\n' + c4Src +
    '\nreturn {GomokuNet,OthelloNet,TicTacToeNet,Connect4Net,makeVsOnlineUI,getFlips,getValidMoves,c4Drop,c4CheckWin};');
  return { api: fn(...keys.map(k => env[k])), env };
}

const BL = { x: 0, y: 900, w: 10, h: 10 }, BR = { x: 20, y: 900, w: 10, h: 10 }, BX = { x: 40, y: 900, w: 10, h: 10 };
function mkClient(kind) { // kind: 'gomoku' | 'othello' | 'ox' | 'connect4'
  const { api, env } = makeEnv();
  const net = kind === 'gomoku' ? api.GomokuNet : kind === 'ox' ? api.TicTacToeNet : kind === 'connect4' ? api.Connect4Net : api.OthelloNet;
  const c = { api, env, net, board: [], result: null, results: 0, newGames: 0, turnSeat: '' };
  const base = {
    net, btnL: BL, btnR: BR, btnExit: BX,
    cellAt: (x, y) => y === 0 ? x : -1,       // テスト用: タップは (セル番号, 0) で表現
    onResult() { c.results++; },
    enterReset() {}, leaveReset() {}, newGameReset() { c.newGames++; },
    applyState(ng) { c.board = ng.board.slice(); c.turnSeat = ng.turn; c.result = ng.result || null; },
    hintIdx: () => -1, onHint() {},
  };
  // 五目/三目は同じ「置くだけ」cfg (undoNeedsOppTurn:true / 空マス合法)。
  // コネクトフォーは着地index+重力検証。オセロだけ反転判定。
  c.OL = api.makeVsOnlineUI(
    (kind === 'gomoku' || kind === 'ox') ? {
      ...base, exitSize: 15, hintCol: '#3a9bdc', undoNeedsOppTurn: true,
      snapOf: ng => ng.turn + '/' + ng.last + '/' + ng.gameNo,
      canPut: (ng, cc) => ng.board[cc] === null,
    } : kind === 'connect4' ? {
      ...base, hintCol: '#f2a541', undoNeedsOppTurn: true,
      snapOf: ng => ng.turn + '/' + ng.last + '/' + ng.gameNo,
      // 着地index(=列最下段の空き)のみ合法。重力: 最下段 or 直下が埋まっている。
      canPut: (ng, cc) => cc >= 0 && ng.board[cc] === null && (Math.floor(cc / 7) === 5 || ng.board[cc + 7] !== null),
    } : {
      ...base, hintCol: '#f2a541',
      snapOf: ng => ng.turn + '/' + ng.last + '/' + ng.gameNo + '/' + (ng.pass || ''),
      canPut: (ng, cc, seat) => ng.board[cc] === null && api.getFlips(ng.board, cc, seat).length > 0,
    });
  c.mirror = () => c.OL.mirror();
  c.tapCell = cc => c.OL.onTap(cc, 0);
  c.tapL = () => c.OL.onTap(5, 905); c.tapR = () => c.OL.onTap(25, 905); c.tapExit = () => c.OL.onTap(45, 905);
  return c;
}
const code = () => 'e2e' + Math.random().toString(36).slice(2, 5); // 実行ごとに別部屋

// ══ 五目: フルシナリオ ══
{
  const A = mkClient('gomoku'), B = mkClient('gomoku');
  const room = code();
  A.OL.enter(); B.OL.enter();
  A.net.connect(room); B.net.connect(room);
  ck('gomoku:両者着席', await until(() => A.net.state.seat && B.net.state.seat && A.net.state.game && B.net.state.game, 8000, () => { A.mirror(); B.mirror(); }));
  const black = A.net.state.seat === 'black' ? A : B, white = A.net.state.seat === 'black' ? B : A;
  black.tapCell(0); // 仮置き (1タップでは打たれない)
  await new Promise(r => setTimeout(r, 250)); black.mirror(); white.mirror();
  ck('gomoku:1タップでは未着手', black.board[0] === null && black.OL.st.pending === 0);
  black.tapCell(0); // 同マス2度目=確定
  ck('gomoku:着手が相手にミラー', await until(() => white.board[0] === 'black', 6000, () => { A.mirror(); B.mirror(); }));
  ck('gomoku:待った可否', black.OL.undoOk() === true && white.OL.undoOk() === false);
  black.tapL();
  ck('gomoku:待ったで盤が戻る', await until(() => white.board[0] === null, 6000, () => { A.mirror(); B.mirror(); }));
  for (let i = 0; i < 5; i++) { // 黒:0..4(横5連) / 白:100..103
    black.tapCell(i); black.tapCell(i);
    await until(() => white.board[i] === 'black' || white.result, 6000, () => { A.mirror(); B.mirror(); });
    if (i < 4) {
      white.tapCell(100 + i); white.tapCell(100 + i);
      await until(() => black.board[100 + i] === 'white', 6000, () => { A.mirror(); B.mirror(); });
    }
  }
  ck('gomoku:決着(黒勝ち)', await until(() => A.result && B.result, 6000, () => { A.mirror(); B.mirror(); }) && A.result.winner === 'black');
  ck('gomoku:決着演出は各1回', A.results === 1 && B.results === 1);
  black.tapL(); // 再戦リクエスト
  await until(() => { white.env.labels.length = 0; white.OL.drawButtons({}); return white.env.labels.some(l => String(l).includes('うける')); }, 6000, () => { A.mirror(); B.mirror(); });
  white.env.labels.length = 0; white.OL.drawButtons({});
  ck('gomoku:再戦オファーが相手ボタンに反映', white.env.labels.some(l => String(l).includes('うける')));
  white.tapL(); // うける
  ck('gomoku:再戦で新対局(盤リセット)', await until(() => !A.result && !B.result && A.board[0] === null && A.newGames >= 2, 8000, () => { A.mirror(); B.mirror(); }));
  black.tapExit();
  ck('gomoku:退室でidle', black.net.state.status === 'idle');
  white.net.leave();
}

// ══ オセロ: 非合法マス拒否 + 数手のミラー ══
{
  const A = mkClient('othello'), B = mkClient('othello');
  const room = code();
  A.OL.enter(); B.OL.enter();
  A.net.connect(room); B.net.connect(room);
  ck('othello:両者着席', await until(() => A.net.state.seat && B.net.state.seat && A.net.state.game && B.net.state.game, 8000, () => { A.mirror(); B.mirror(); }));
  for (let ply = 0; ply < 4; ply++) {
    const cur = A.net.state.seat === ((ply % 2 === 0) ? 'black' : 'white') ? A : B;
    const seat = cur.net.state.seat;
    await until(() => cur.turnSeat === seat, 6000, () => { A.mirror(); B.mirror(); });
    if (ply === 0) { // 既に石があるマスは2度タップしても打てない
      const occ = cur.net.state.game.board.findIndex(v => v);
      cur.tapCell(occ); cur.tapCell(occ);
      await new Promise(r => setTimeout(r, 200)); A.mirror(); B.mirror();
      ck('othello:非合法マス拒否', cur.net.state.game.board.filter(v => v).length === 4);
    }
    const mv = cur.api.getValidMoves(cur.net.state.game.board, seat)[0];
    cur.tapCell(mv); cur.tapCell(mv);
    const other = cur === A ? B : A;
    ck('othello:着手ミラー ply' + ply, await until(() => other.board[mv] !== null, 6000, () => { A.mirror(); B.mirror(); }));
  }
  A.net.leave(); B.net.leave();
}

// ══ オセロ: フル対局で 自動パス→終局→石数 を実機プロトコルで検証 ══
// 「手番の席」を持つ側が常に最小indexの合法手を打つと 対局は決定的に60手で終局する(白45/黒19)。
// 途中で黒が複数回 自動パスされ(手番維持のまま白が連打する)、パス時の手番同期・終局判定・石数一致を
// 実DOプロトコル越しに検証する。 (task: パス処理はオンライン同期での手番ズレの温床 → パス→終局を必ず検証)
{
  const A = mkClient('othello'), B = mkClient('othello');
  const room = code();
  A.OL.enter(); B.OL.enter();
  A.net.connect(room); B.net.connect(room);
  ck('othello終局:両者着席', await until(() => A.net.state.seat && B.net.state.seat && A.net.state.game && B.net.state.game, 8000, () => { A.mirror(); B.mirror(); }));
  const seatOf = c => c.net.state.seat; // 席は対局中固定 (rematch/swapなし)
  const oppC = c => c === 'black' ? 'white' : 'black';
  // must-fix#1: パスは「間接(sawPassフラグ)」でなく、発生時のサーバー権威stateを捕捉して
  //   ①どの色がパスされたか(pass色配信) ②手番がパス色の相手で維持/スキップされるか を直接検証する。
  let passEv = null;                          // 最初の自動パス発生時のスナップショット
  let prevMover = null, sawConsecutive = false; // 同色が連続で手番=パスで相手がスキップされた証跡(連打)
  let guard = 0;
  while (!(A.result || B.result) && guard++ < 200) {
    A.mirror(); B.mirror();
    const st = A.net.state.game; // サーバー権威state (両者へ同一broadcast)
    if (!st) { await new Promise(r => setTimeout(r, 60)); continue; }
    if (st.pass && !passEv) {                       // 自動パス発生: pass=飛ばされた色 / turn=打ち続ける相手色
      await until(() => B.net.state.game && B.net.state.game.pass, 3000, () => { A.mirror(); B.mirror(); }); // 相手clientも同broadcast受信まで待つ(片側snapshotはフレーク源)
      const ast = A.net.state.game, bst = B.net.state.game;
      passEv = {
        passColor: ast.pass,                        // どの色がパスされたか(pass色配信)
        turn: ast.turn,                             // 手番はパス色の相手で維持されているはず
        passMoves: A.api.getValidMoves(ast.board, ast.pass).length,  // パスされた色は合法手0(正しくスキップ)
        turnMoves: A.api.getValidMoves(ast.board, ast.turn).length,  // 手番側は合法手あり
        bPass: bst && bst.pass, bTurn: bst && bst.turn,             // 相手clientにも同じpass色/手番が配信されるか
      };
    }
    const turnSeat = st.turn;
    const cur = seatOf(A) === turnSeat ? A : B;     // 手番の席を持つクライアントが打つ
    const mv = cur.api.getValidMoves(st.board, turnSeat)[0];
    if (mv === undefined) { await new Promise(r => setTimeout(r, 60)); continue; } // 自動パス反映待ち
    if (prevMover === turnSeat) sawConsecutive = true; // 直前と同色が再度手番=パスで相手がスキップ(連打)
    prevMover = turnSeat;
    const before = st.board.filter(v => v).length;
    cur.tapCell(mv); cur.tapCell(mv);               // 2タップ確定
    await until(() => A.result || B.result || (A.net.state.game && A.net.state.game.board.filter(v => v).length > before), 6000, () => { A.mirror(); B.mirror(); });
  }
  // must-fix#2: 片側のresult受信だけで抜けるとフレーク。両clientの終局受信を待ってから検証する。
  const bothEnded = await until(() => !!(A.result && B.result), 6000, () => { A.mirror(); B.mirror(); });
  // ── 自動パスの色・手番維持を直接検証 (must-fix#1) ──
  ck('othello終局:自動パス発生でpass色が配信される', !!(passEv && passEv.passColor));
  ck('othello終局:パスされた色は合法手0で正しくスキップ', !!(passEv && passEv.passMoves === 0));
  ck('othello終局:手番はパス色の相手で維持(合法手あり)', !!(passEv && passEv.turn === oppC(passEv.passColor) && passEv.turnMoves > 0));
  ck('othello終局:pass色/手番が両クライアントへ同一配信', !!(passEv && passEv.passColor === passEv.bPass && passEv.turn === passEv.bTurn));
  ck('othello終局:パスで同色が連続して手番を得る(相手が連打)', sawConsecutive);
  ck('othello終局:終局到達(両クライアント)', bothEnded);
  const fb = A.net.state.game.board; let bk = 0, wt = 0; for (const v of fb) { if (v === 'black') bk++; else if (v === 'white') wt++; }
  const majority = bk > wt ? 'black' : wt > bk ? 'white' : undefined; // 石数の多い方が勝者(同数=引分)
  ck('othello終局:石数と勝者が整合', A.result && (A.result.draw ? majority === undefined : A.result.winner === majority));
  ck('othello終局:両クライアントの盤/勝者が一致', JSON.stringify(A.net.state.game.board) === JSON.stringify(B.net.state.game.board) && JSON.stringify(A.result) === JSON.stringify(B.result));
  ck('othello終局:決着演出は各1回', A.results === 1 && B.results === 1);
  A.net.leave(); B.net.leave();
}

// ══ まるばつ(三目): 着席/着手ミラー/3連決着/決着演出1回 ══
{
  const A = mkClient('ox'), B = mkClient('ox');
  const room = code();
  A.OL.enter(); B.OL.enter();
  A.net.connect(room); B.net.connect(room);
  ck('ox:両者着席', await until(() => A.net.state.seat && B.net.state.seat && A.net.state.game && B.net.state.game && A.net.state.game.board.length === 9, 8000, () => { A.mirror(); B.mirror(); }));
  const black = A.net.state.seat === 'black' ? A : B, white = A.net.state.seat === 'black' ? B : A;
  black.tapCell(4); // 仮置き (1タップでは打たれない)
  await new Promise(r => setTimeout(r, 250)); black.mirror(); white.mirror();
  ck('ox:1タップでは未着手', black.board[4] === null && black.OL.st.pending === 4);
  black.tapCell(4); // 同マス2度目=確定 (中央4に着手)
  ck('ox:着手が相手にミラー', await until(() => white.board[4] === 'black', 6000, () => { A.mirror(); B.mirror(); }));
  // 黒 [0,1,2] で上段3連(勝者)。白は 3,5,6 で手番だけ消化する。
  // 白の3手 {3,5,6} はどの3連ライン(行/列/対角)も作らず、黒の勝ち筋 0,1,2 も塞がない
  // ため、黒が2を置く最終手まで決着せず、意図どおり黒が [0,1,2] で勝つ。
  // (旧手順の 6→7→8 は下段3連で白が先に勝ってしまい誤り: PR#62 reviewer 指摘)
  white.tapCell(3); white.tapCell(3);
  await until(() => black.board[3] === 'white', 6000, () => { A.mirror(); B.mirror(); });
  black.tapCell(0); black.tapCell(0);
  await until(() => white.board[0] === 'black', 6000, () => { A.mirror(); B.mirror(); });
  white.tapCell(5); white.tapCell(5);
  await until(() => black.board[5] === 'white', 6000, () => { A.mirror(); B.mirror(); });
  black.tapCell(1); black.tapCell(1);
  await until(() => white.board[1] === 'black', 6000, () => { A.mirror(); B.mirror(); });
  white.tapCell(6); white.tapCell(6);
  await until(() => black.board[6] === 'white', 6000, () => { A.mirror(); B.mirror(); });
  black.tapCell(2); black.tapCell(2); // 黒 [0,1,2] で3連
  ck('ox:決着(黒勝ち)', await until(() => A.result && B.result, 6000, () => { A.mirror(); B.mirror(); }) && A.result.winner === 'black' && A.result.line.join() === '0,1,2');
  ck('ox:決着演出は各1回', A.results === 1 && B.results === 1);
  A.net.leave(); B.net.leave();
}

// ══ コネクトフォー: 着席/重力落下ミラー/非合法(浮きマス)拒否/縦4連決着/決着演出1回 ══
{
  const A = mkClient('connect4'), B = mkClient('connect4');
  const room = code();
  A.OL.enter(); B.OL.enter();
  A.net.connect(room); B.net.connect(room);
  ck('c4:両者着席', await until(() => A.net.state.seat && B.net.state.seat && A.net.state.game && B.net.state.game && A.net.state.game.board.length === 42, 8000, () => { A.mirror(); B.mirror(); }));
  const black = A.net.state.seat === 'black' ? A : B, white = A.net.state.seat === 'black' ? B : A;
  const drop = (c, col) => api_c4Drop(c, col);
  function api_c4Drop(c, col) { return c.api.c4Drop(c.net.state.game.board, col); }
  // 黒が列3にドロップ → 底(index38)へ着地して相手にミラー
  const l0 = drop(black, 3);
  ck('c4:着地は列の底', l0 === 38);
  black.tapCell(l0); // 仮置き
  await new Promise(r => setTimeout(r, 250)); black.mirror(); white.mirror();
  ck('c4:1タップでは未着手', black.board[l0] === null && black.OL.st.pending === l0);
  black.tapCell(l0); // 確定
  ck('c4:重力落下が相手にミラー', await until(() => white.board[38] === 'black', 6000, () => { A.mirror(); B.mirror(); }));
  // 浮きマス(index24=列3のr3。直下31が空なので重力違反)を白が2度タップ → canPutで弾かれ着手されない
  white.tapCell(24); white.tapCell(24);
  await new Promise(r => setTimeout(r, 200)); A.mirror(); B.mirror();
  ck('c4:浮きマス拒否', white.board[24] === null && white.OL.st.pending < 0);
  // ここまでで黒が col3(38) に1手・白の番。縦4連(黒 col0=35,28,21,14)まで進める。
  // 白は col1(36,29,22)→col2(37) を消化し どこにも4連を作らない。最後の黒 col0 で決着。
  const seq = [[white, 1], [black, 0], [white, 1], [black, 0], [white, 1], [black, 0], [white, 2], [black, 0]];
  for (let s = 0; s < seq.length; s++) {
    const [cur, col] = seq[s];
    await until(() => cur.turnSeat === cur.net.state.seat, 6000, () => { A.mirror(); B.mirror(); });
    const land = drop(cur, col);
    cur.tapCell(land); cur.tapCell(land);
    await until(() => A.result || B.result || (A.net.state.game && A.net.state.game.board[land] !== null), 6000, () => { A.mirror(); B.mirror(); });
  }
  ck('c4:縦4連で決着(黒勝ち)', await until(() => A.result && B.result, 6000, () => { A.mirror(); B.mirror(); }) && A.result.winner === 'black' && A.result.line.length === 4);
  ck('c4:両クライアントの盤/勝者一致', JSON.stringify(A.net.state.game.board) === JSON.stringify(B.net.state.game.board) && JSON.stringify(A.result) === JSON.stringify(B.result));
  ck('c4:決着演出は各1回', A.results === 1 && B.results === 1);
  A.net.leave(); B.net.leave();
}

console.log(`[online e2e] pass=${pass} / fail=${fail}`);
process.exit(fail ? 1 : 0);

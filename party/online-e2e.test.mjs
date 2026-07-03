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
  const fn = new Function(...keys, src + '\n' + othSrc +
    '\nreturn {GomokuNet,OthelloNet,makeVsOnlineUI,getFlips,getValidMoves};');
  return { api: fn(...keys.map(k => env[k])), env };
}

const BL = { x: 0, y: 900, w: 10, h: 10 }, BR = { x: 20, y: 900, w: 10, h: 10 }, BX = { x: 40, y: 900, w: 10, h: 10 };
function mkClient(kind) { // kind: 'gomoku' | 'othello'
  const { api, env } = makeEnv();
  const net = kind === 'gomoku' ? api.GomokuNet : api.OthelloNet;
  const c = { api, env, net, board: [], result: null, results: 0, newGames: 0, turnSeat: '' };
  const base = {
    net, btnL: BL, btnR: BR, btnExit: BX,
    cellAt: (x, y) => y === 0 ? x : -1,       // テスト用: タップは (セル番号, 0) で表現
    onResult() { c.results++; },
    enterReset() {}, leaveReset() {}, newGameReset() { c.newGames++; },
    applyState(ng) { c.board = ng.board.slice(); c.turnSeat = ng.turn; c.result = ng.result || null; },
    hintIdx: () => -1, onHint() {},
  };
  c.OL = api.makeVsOnlineUI(kind === 'gomoku' ? {
    ...base, exitSize: 15, hintCol: '#3a9bdc', undoNeedsOppTurn: true,
    snapOf: ng => ng.turn + '/' + ng.last + '/' + ng.gameNo,
    canPut: (ng, cc) => ng.board[cc] === null,
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

console.log(`[online e2e] pass=${pass} / fail=${fail}`);
process.exit(fail ? 1 : 0);

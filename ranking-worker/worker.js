/* プチゲー★パーク / ぽちっとミニゲームパーク 共用ランキングAPI
   Cloudflare Workers + KV (binding: RANK)

   エンドポイント:
     POST /score  ... スコア送信 {gameId, score, mode?, date?|dailyKey?, name?}
     GET  /top    ... 上位取得   ?game=&date=(YYYYMMDD|all)&mode=(daily|free)
     POST /total  ... [Phase1] トータル成績送信（匿名オプトイン）{game, nickname, value, uid?}
     GET  /total  ... [Phase1] game別 Top-N トータル成績  ?game=&limit=

   デイリーチャレンジの seed (= 日付) と同じキーで集計するので、
   date を揃えれば「同じ問題を解いた人同士」のランキングになる。
   累計は date=all。エントリは各キー上位50件・40日で自動失効 (all は無期限)。
   /total は独立keyspace total: で nickname 別に集計（既存挙動に影響なし）。 */

const GAMES = new Set(['tea', 'lane', 'spot']);
const MAX_SCORE = 99990;
const TOP_N = 50;
const TTL_DAYS = 40;

/* --- Phase1: game別トータル成績ランキング（案B: 匿名オプトイン） ---
   既存のデイリー/累計(top:)とは別keyspace(total:)で、nickname別に集計する。
   各ゲームの主指標は TOTAL_METRICS で設定（レビューで確定）。
     agg 'max' = ベスト値 / agg 'sum' = 累計
   uid(端末ごとの匿名ID)が来た場合はuid優先で同一人物を照合し、改名時も
   同じエントリを追従更新する（nicknameのみの旧データはnicknameでフォールバック照合）。 */
const TOTAL_METRICS = {
  tea:  { metric: 'best', agg: 'max' },
  lane: { metric: 'best', agg: 'max' },
  spot: { metric: 'best', agg: 'max' },
};
const DEFAULT_METRIC = { metric: 'best', agg: 'max' };
const TOTAL_MAX = 9999999; // トータル値クランプ上限
const TOTAL_N = 100;       // 保持・返却する最大件数
const RL_MAX = 20;         // 同一IPあたり最大送信数 / ウィンドウ
const RL_TTL = 60;         // レート制限ウィンドウ秒（KV最小TTL）

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  });
}

/* 'YYYY-MM-DD' / YYYYMMDD / 'all' を 'YYYYMMDD' or 'all' に正規化 */
function normDate(v) {
  const s = String(v ?? '').trim();
  if (s === 'all') return 'all';
  const digits = s.replace(/-/g, '');
  if (/^\d{8}$/.test(digits)) return digits;
  return todayKey();
}
function todayKey() { // JST基準の日付キー
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  return jst.toISOString().slice(0, 10).replace(/-/g, '');
}
function sanitizeName(v) {
  return String(v ?? '').replace(/[\x00-\x1F<>]/g, '').trim().slice(0, 12) || null;
}
function sanitizeUid(v) {
  return String(v ?? '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64) || null;
}
function keyOf(date, game, mode) { return `top:${date}:${game}:${mode}`; }

async function pushEntry(env, key, entry, ttlDays) {
  const cur = (await env.RANK.get(key, 'json')) || [];
  cur.push(entry);
  cur.sort((a, b) => b.score - a.score || a.t - b.t);
  const top = cur.slice(0, TOP_N);
  const opts = ttlDays ? { expirationTtl: ttlDays * 86400 } : {};
  await env.RANK.put(key, JSON.stringify(top), opts);
  const idx = top.findIndex(e => e === entry);
  return { rank: idx >= 0 ? idx + 1 : null, total: top.length };
}

async function postScore(req, env) {
  let b;
  try { b = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const game = String(b.gameId || b.game || '').slice(0, 16);
  const score = Math.max(0, Math.min(MAX_SCORE, Math.round(Number(b.score) || 0)));
  if (!GAMES.has(game)) return json({ ok: false, error: 'unknown game' }, 400);
  if (!(score > 0)) return json({ ok: false, error: 'no score' }, 400);
  const mode = (b.mode === 'daily' || b.daily === true) ? 'daily' : 'free';
  const date = normDate(b.date ?? b.dailyKey);
  const entry = { score, name: sanitizeName(b.name), t: Date.now() };
  const daily = await pushEntry(env, keyOf(date, game, mode), entry, TTL_DAYS);
  await pushEntry(env, keyOf('all', game, mode), entry, 0); // 累計
  return json({ ok: true, date, mode, rank: daily.rank, total: daily.total });
}

async function getTop(url, env) {
  const game = String(url.searchParams.get('game') || '').slice(0, 16);
  if (!GAMES.has(game)) return json({ ok: false, error: 'unknown game' }, 400);
  const date = normDate(url.searchParams.get('date'));
  const mode = url.searchParams.get('mode') === 'free' ? 'free' : 'daily';
  const entries = (await env.RANK.get(keyOf(date, game, mode), 'json')) || [];
  return json({ ok: true, game, date, mode, entries });
}

/* --- game別トータル成績（nickname集計） --- */
function metricOf(game) { return TOTAL_METRICS[game] || DEFAULT_METRIC; }

/* 軽いレート制限: 同一IPで RL_TTL 秒あたり RL_MAX 件まで（スライディングウィンドウ） */
async function rateLimited(env, ip) {
  if (!ip) return false;
  const key = `rl:total:${ip}`;
  const now = Date.now();
  const arr = ((await env.RANK.get(key, 'json')) || []).filter(t => now - t < RL_TTL * 1000);
  if (arr.length >= RL_MAX) return true;
  arr.push(now);
  await env.RANK.put(key, JSON.stringify(arr), { expirationTtl: RL_TTL });
  return false;
}

async function pushTotal(env, game, nickname, value, uid) {
  const cfg = metricOf(game);
  const key = `total:${game}`;
  const cur = (await env.RANK.get(key, 'json')) || [];
  // uid優先で同一人物を特定（改名しても追従）。uid未設定の古いエントリはnicknameでフォールバック照合
  let e = uid ? cur.find(x => x.uid === uid) : null;
  if (!e) e = cur.find(x => x.nickname === nickname && !x.uid);
  if (!e) { e = { nickname, value: 0, metric: cfg.metric, n: 0, ts: 0 }; if (uid) e.uid = uid; cur.push(e); }
  e.nickname = nickname; // 改名を反映（既存エントリを別人扱いにせず追従更新）
  if (uid) e.uid = uid;
  e.value = cfg.agg === 'sum' ? e.value + value : Math.max(e.value, value);
  e.value = Math.min(TOTAL_MAX, e.value);
  e.metric = cfg.metric;
  e.n += 1;
  e.ts = Date.now();
  cur.sort((a, b) => b.value - a.value || a.ts - b.ts);
  const top = cur.slice(0, TOTAL_N);
  await env.RANK.put(key, JSON.stringify(top), {}); // トータルは無期限
  const idx = top.indexOf(e);
  return { rank: idx >= 0 ? idx + 1 : null, total: top.length, value: e.value };
}

async function postTotal(req, env) {
  const ip = req.headers.get('CF-Connecting-IP') || '';
  if (await rateLimited(env, ip)) return json({ ok: false, error: 'rate limited' }, 429);
  let b;
  try { b = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const game = String(b.game || b.gameId || '').slice(0, 16);
  if (!GAMES.has(game)) return json({ ok: false, error: 'unknown game' }, 400);
  const nickname = sanitizeName(b.nickname ?? b.name);
  if (!nickname) return json({ ok: false, error: 'nickname required' }, 400);
  const value = Math.max(0, Math.min(TOTAL_MAX, Math.round(Number(b.value) || 0)));
  if (!(value > 0)) return json({ ok: false, error: 'no value' }, 400);
  const uid = sanitizeUid(b.uid);
  const res = await pushTotal(env, game, nickname, value, uid);
  return json({ ok: true, game, metric: metricOf(game).metric, nickname, value: res.value, rank: res.rank, total: res.total });
}

async function getTotal(url, env) {
  const game = String(url.searchParams.get('game') || '').slice(0, 16);
  if (!GAMES.has(game)) return json({ ok: false, error: 'unknown game' }, 400);
  const limit = Math.max(1, Math.min(TOTAL_N, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
  const all = (await env.RANK.get(`total:${game}`, 'json')) || [];
  const entries = all.slice(0, limit).map(e => ({ nickname: e.nickname, value: e.value, n: e.n }));
  return json({ ok: true, game, metric: metricOf(game).metric, entries });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method === 'POST' && url.pathname === '/score') return postScore(req, env);
    if (req.method === 'GET' && url.pathname === '/top') return getTop(url, env);
    if (req.method === 'POST' && url.pathname === '/total') return postTotal(req, env);
    if (req.method === 'GET' && url.pathname === '/total') return getTotal(url, env);
    return json({ ok: false, error: 'not found' }, 404);
  },
};

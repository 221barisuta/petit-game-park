/* ranking-worker (Cloudflare Workers + KV) headless テスト (モックKV)
   検証: /total 送信のuid優先照合(改名しても同一人物として追従・rank算出) /
        uid未設定の旧データはnicknameでフォールバック照合 / 新クライアント移行(レガシー行へのuid付与) /
        レート制限(RL_MAX超過で429) / 必須項目チェック
   実行: node ranking-worker/worker.test.mjs   (非0終了で失敗) */
import worker from './worker.js';

class MockKV {
  constructor() { this.m = new Map(); }
  async get(key, type) {
    const v = this.m.get(key);
    if (v === undefined) return null;
    return type === 'json' ? JSON.parse(v) : v;
  }
  async put(key, value) { this.m.set(key, value); }
}

function req(method, path, body) {
  return new Request('https://example.com' + path, {
    method,
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.1' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

let pass = 0, fail = 0; const log = [];
const ck = (n, c) => { c ? pass++ : (fail++, log.push(n)); };

// ── uid優先照合: 改名しても同一エントリとして追従更新される (#13 名前不一致バグ修正) ──
{
  const env = { RANK: new MockKV() };
  const r1 = await worker.fetch(req('POST', '/total', { game: 'tea', nickname: 'むらさきのライオン', value: 100, uid: 'uid-abc' }), env);
  ck('post1-ok', (await r1.json()).ok === true);
  // 改名後、同じuidで送信 → 別人ではなく同一エントリのnicknameが更新される
  const r2 = await worker.fetch(req('POST', '/total', { game: 'tea', nickname: 'つつ', value: 150, uid: 'uid-abc' }), env);
  const j2 = await r2.json();
  ck('post2-ok', j2.ok === true);
  const top = await env.RANK.get('total:tea', 'json');
  ck('single-entry-after-rename', top.length === 1);
  ck('entry-nickname-updated', top[0].nickname === 'つつ');
  ck('entry-value-max', top[0].value === 150);
  ck('entry-uid-kept', top[0].uid === 'uid-abc');
}

// ── uid未設定の既存エントリはnicknameでフォールバック照合 (後方互換) ──
{
  const env = { RANK: new MockKV() };
  await env.RANK.put('total:tea', JSON.stringify([{ nickname: 'ぷちお', value: 50, metric: 'best', n: 1, ts: 0 }]));
  const r = await worker.fetch(req('POST', '/total', { game: 'tea', nickname: 'ぷちお', value: 80 }), env);
  ck('legacy-post-ok', (await r.json()).ok === true);
  const top = await env.RANK.get('total:tea', 'json');
  ck('legacy-still-single-entry', top.length === 1);
  ck('legacy-value-updated', top[0].value === 80);
}

// ── 新クライアント移行経路: uidなしの既存レガシー行に、同名+uidありで送信 → 新規行にならずuidが付与される ──
{
  const env = { RANK: new MockKV() };
  await env.RANK.put('total:lane', JSON.stringify([{ nickname: 'あおいネコ', value: 40, metric: 'best', n: 1, ts: 0 }]));
  const r = await worker.fetch(req('POST', '/total', { game: 'lane', nickname: 'あおいネコ', value: 60, uid: 'uid-migrate' }), env);
  ck('migrate-post-ok', (await r.json()).ok === true);
  const top = await env.RANK.get('total:lane', 'json');
  ck('migrate-still-single-entry', top.length === 1);
  ck('migrate-uid-attached', top[0].uid === 'uid-migrate');
  ck('migrate-value-updated', top[0].value === 60);
}

// ── uid違いは別人として新規エントリになる ──
{
  const env = { RANK: new MockKV() };
  await worker.fetch(req('POST', '/total', { game: 'tea', nickname: 'あかいキツネ', value: 10, uid: 'uid-1' }), env);
  await worker.fetch(req('POST', '/total', { game: 'tea', nickname: 'あかいキツネ', value: 20, uid: 'uid-2' }), env);
  const top = await env.RANK.get('total:tea', 'json');
  ck('different-uid-two-entries', top.length === 2);
}

// ── 必須項目/バリデーション ──
{
  const env = { RANK: new MockKV() };
  const rNoNick = await worker.fetch(req('POST', '/total', { game: 'tea', value: 10 }), env);
  ck('nickname-required', (await rNoNick.json()).ok === false);
  const rBadGame = await worker.fetch(req('POST', '/total', { game: 'unknown', nickname: 'x', value: 10 }), env);
  ck('unknown-game-rejected', (await rBadGame.json()).ok === false);
  const rZero = await worker.fetch(req('POST', '/total', { game: 'tea', nickname: 'x', value: 0 }), env);
  ck('zero-value-rejected', (await rZero.json()).ok === false);
}

// ── レート制限: 同一IPでRL_MAX(20件)を超えると429 ──
{
  const env = { RANK: new MockKV() };
  let last;
  for (let i = 0; i < 21; i++) {
    last = await worker.fetch(req('POST', '/total', { game: 'tea', nickname: 'れいと', value: 1 + i, uid: 'uid-rl' }), env);
  }
  ck('rate-limited-after-max', last.status === 429 && (await last.json()).ok === false);
}

console.log('[ranking-worker logic] pass=' + pass + ' / fail=' + fail, log.length ? log : '');
process.exit(fail ? 1 : 0);

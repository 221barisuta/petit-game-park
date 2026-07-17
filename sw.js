/* プチゲー★パーク service worker
   HTML(ナビゲーション) は network-first、その他アセットは cache優先(stale-while-revalidate)。
   インストール済みPWAでも、オンラインで開けば常に最新の index.html を表示する。
   オフライン時はキャッシュにフォールバックして起動できる。
   ファイルを更新したら CACHE_VERSION を上げること（古いキャッシュは自動削除）。 */
const CACHE_VERSION = 'pgp2-v60';
const NAV_TIMEOUT = 3500; // HTMLのネットワーク取得がこれを超えたらキャッシュfallback(ms)
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './og.jpg'
];

self.addEventListener('install', e => {
  // skipWaiting は install では呼ばない。更新トーストのボタン操作で待機SWを起こす
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then(c => c.addAll(PRECACHE))
  );
});

// 更新トーストの「こうしん」ボタンから待機SWを即時有効化
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// HTML(ナビゲーション)用 network-first: 取得成功でキャッシュ更新しつつ返す。
// 遅い/失敗時は短いタイムアウトでキャッシュfallback(取得は裏で続行しキャッシュ更新)。
function networkFirstHtml(req) {
  return caches.open(CACHE_VERSION).then(cache => {
    const fallback = cache.match(req).then(hit => hit || cache.match('./index.html'));
    const network = fetch(req).then(res => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    });
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        fallback.then(hit => { if (hit) resolve(hit); }); // 無ければネット完了を待つ
      }, NAV_TIMEOUT);
      network.then(res => { clearTimeout(timer); resolve(res); })
             .catch(() => { clearTimeout(timer); fallback.then(resolve); });
    });
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // 外部(GA等)は素通し

  // ナビゲーション/HTML は network-first
  const isHtml = req.mode === 'navigate'
    || url.pathname === '/' || url.pathname.endsWith('/index.html');
  if (isHtml) {
    e.respondWith(networkFirstHtml(req));
    return;
  }

  // その他アセット: cache優先 + stale-while-revalidate
  e.respondWith(
    caches.match(req).then(hit => {
      const fetched = fetch(req).then(res => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(req, clone));
        }
        return res;
      }).catch(() => hit);
      return hit || fetched;
    })
  );
});

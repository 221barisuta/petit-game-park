/* プチゲー★パーク service worker
   キャッシュ優先 + ネットワークフォールバック。オフラインでも起動できる。
   ファイルを更新したら CACHE_VERSION を上げること（古いキャッシュは自動削除）。 */
const CACHE_VERSION = 'pgp2-v13';
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

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // 外部(GA等)は素通し
  e.respondWith(
    caches.match(e.request).then(hit => {
      const fetched = fetch(e.request).then(res => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => hit);
      return hit || fetched;
    })
  );
});

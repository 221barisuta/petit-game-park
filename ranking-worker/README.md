# ランキングAPI（プチゲー★パーク / ぽちっとミニゲームパーク 共用）

Cloudflare Workers + KV。エンドポイントは2本だけ。

| メソッド | パス | 役割 |
|---|---|---|
| `POST` | `/score` | スコア送信 `{gameId, score, mode?, date?\|dailyKey?, name?}` |
| `GET` | `/top?game=&date=&mode=` | 上位50件取得。`date=YYYYMMDD`（日替わり）/ `date=all`（累計） |

- デイリーチャレンジの日付seedと同じキーで集計（同じ問題を解いた人同士で比較が成立）
- `date` は `YYYYMMDD` / `YYYY-MM-DD` どちらでも受ける（pochitto/petit両対応）
- スコアは0〜99990にクランプ、各キー上位50件、日別キーは40日で自動失効

## デプロイ（3ステップ・所要5分）

```bash
cd ranking-worker
npx wrangler login                          # 1. ブラウザでCloudflareにログイン（初回のみ）
npx wrangler kv namespace create RANK      # 2. 出力された id を wrangler.toml に貼る
npx wrangler deploy                         # 3. → https://pgp-ranking.<あなた>.workers.dev
```

## サイト側の設定（デプロイ後）

**プチゲー★パーク** — `index.html` 冒頭の `PGP_CONFIG`:
```js
rankingBase: 'https://pgp-ranking.<あなた>.workers.dev'
```

**ぽちっとミニゲームパーク** — `index.html` の `APP_CONFIG`:
```js
rankingEndpoint: 'https://pgp-ranking.<あなた>.workers.dev/score'
```

## 動作確認

```bash
curl -X POST https://pgp-ranking.<あなた>.workers.dev/score \
  -H 'content-type: application/json' \
  -d '{"gameId":"tea","score":500,"mode":"daily"}'
curl 'https://pgp-ranking.<あなた>.workers.dev/top?game=tea&mode=daily'
```

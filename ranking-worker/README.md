# ランキングAPI（プチゲー★パーク / ぽちっとミニゲームパーク 共用）

Cloudflare Workers + KV。デイリー/累計の2本＋トータル成績ランキング（Phase1）＋週間ランキング（backlog1）。

> ⚠️ **このREADMEのリクエスト例をそのまま本番URLに向けて実行しない。**
> 過去に本ドキュメントの例をそのまま本番へcurlしたと思われるダミーデータ混入が発生したことがある
> （実機フィードバック第4弾 項目11）。動作確認は `node ranking-worker/worker.test.mjs`（モックKV・ネットワーク不要）か、
> 自分専用の開発用KV namespace/workerを別途用意してから行うこと。

| メソッド | パス | 役割 |
|---|---|---|
| `POST` | `/score` | スコア送信 `{gameId, score, mode?, date?\|dailyKey?, name?}` |
| `GET` | `/top?game=&date=&mode=` | 上位50件取得。`date=YYYYMMDD`（日替わり）/ `date=all`（累計） |
| `POST` | `/total` | **[Phase1]** トータル成績送信（匿名オプトイン）`{game, nickname, value, uid?}` |
| `GET` | `/total?game=&limit=` | **[Phase1]** game別 Top-N トータル成績ランキング |
| `POST` | `/weekly` | **[backlog1]** 週間成績送信（`/total`と同形式）`{game, nickname, value, uid?}` |
| `GET` | `/weekly?game=&limit=&week=` | **[backlog1]** game別 Top-N 週間成績ランキング（`week`省略時は今週） |

- デイリーチャレンジの日付seedと同じキーで集計（同じ問題を解いた人同士で比較が成立）
- `date` は `YYYYMMDD` / `YYYY-MM-DD` どちらでも受ける（pochitto/petit両対応）
- スコアは0〜99990にクランプ、各キー上位50件、日別キーは40日で自動失効

## トータル成績ランキング（Phase1 / 案B：匿名オプトイン）

ゲームごとの**トータル成績**を nickname 別に集計したグローバルランキング。
既存のデイリー/累計（`top:` keyspace）とは独立（`total:` keyspace）で、既存挙動には影響しない。

**主指標（`TOTAL_METRICS`）**: レビューで確定。現案は tea / lane / spot とも
`metric=best`（`agg=max` = プレイヤーのベスト値）。累計に変えたいゲームは `agg:'sum'` に切替可。

### 送信 `POST /total`（フロント統合の契約）

オプトイン時のみ、ゲーム終了成績を送る。**匿名・PIIなし（nickname のみ保存）**。

リクエスト（架空の例。実際に本番URLへ送らないこと）:
```jsonc
{ "game": "tea", "nickname": "サンプルなまえ", "value": 1200, "uid": "端末ごとの匿名ID(任意)" }
// game … 'tea'|'lane'|'spot'（GAMES）
// nickname … 必須・記号除去して最大12文字にサニタイズ
// value … 0〜9999999 にクランプ、>0 必須
// uid … 任意。指定するとuid優先で同一人物を照合し、改名しても同じ順位エントリを追従更新する
```
レスポンス:
```jsonc
{ "ok": true, "game": "tea", "metric": "best",
  "nickname": "サンプルなまえ", "value": 1200, "rank": 3, "total": 42 }
```
エラー: `400`（bad json / unknown game / nickname required / no value）、`429`（rate limited）。

**サーバ側の防御**: 値クランプ（0〜9999999）＋ IPレート制限（`CF-Connecting-IP` 基準・60秒あたり最大20件）。

### 取得 `GET /total?game=<g>&limit=<n>`（フロント統合の契約）

`limit` は 1〜100（既定50）。トータル値の降順。
```jsonc
{ "ok": true, "game": "tea", "metric": "best",
  "entries": [ { "nickname": "サンプルなまえ", "value": 1200, "n": 8 }, ... ] }
// n … そのnicknameの送信回数
```

- 保持は各ゲーム上位100件（`total:{game}`・無期限）。それ未満に落ちた nickname は保持対象外。
- KVの read-modify-write は既存 `/score` と同方式（無料枠・低頻度前提）。

## 週間ランキング（backlog1）

`total:` とは独立の keyspace `weekly:<ISO週>:<game>` で、直近1週間の成績を集計する。
uid照合・改名追従のロジックは `/total` と完全に共通（同じ`pushRanked`関数を使用）。

- ISO週キー（`YYYY-Www`）は JST基準・月曜0時で自然に切り替わる（`isoWeekKey()`関数、`index.html`側にも同一ロジックのコピーあり）
- エントリは **5週間で自動失効**（`total:` は無期限だが `weekly:` はTTLあり）
- `POST /weekly` は常に「今週」のキーに書き込む（過去週への遡り投稿は不可）
- `GET /weekly?week=YYYY-Www` で過去週を明示指定して取得できる（省略時は今週）
- レート制限は `/total` とは別枠（同じIPでも週間送信が総合送信の制限に巻き込まれない）

リクエスト/レスポンスの形は `/total` と同一（`week`フィールドが追加される点のみ異なる）。

## デプロイ（3ステップ・所要5分）

> ⚠️ **/weekly エンドポイントを本番で使えるようにするには、この worker.js の再デプロイが必要です。**
> コード変更はPRに含まれていますが、実際の `wrangler deploy` はユーザー側で実施してください
> （既存の `total:` データや `wrangler.toml` の設定はそのまま維持されます・破壊的変更なし）。

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

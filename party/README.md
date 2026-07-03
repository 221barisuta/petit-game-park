# petit-gomoku — 五目並べ オンライン対戦サーバー (Cloudflare Workers + Durable Objects / partyserver)

五目並べの **部屋作成＆共有方式オンライン2人対戦**のバックエンド。
部屋 = 1つの Durable Object。サーバーが盤面を**権威的に保持・検証**する。
ログイン不要。ターン制で通信量が極小なので **Cloudflare 無料枠で実質 $0**。

> マネージド版 `partykit.dev` のインフラ障害を受け、**自分の Cloudflare アカウントへ wrangler で直接デプロイ**する
> [partyserver](https://github.com/cloudflare/partyserver) 構成へ移行（既存 `ranking-worker/` と同じ運用）。ロジックは不変。

## 構成
| ファイル | 役割 |
|---|---|
| `index.js` | Worker エントリ。`routePartykitRequest` でルーティングし、`Gomoku extends Server`(partyserver) が `server.js` のロジックを委譲実行 |
| `server.js` | ゲーム権威ロジック本体（座席割当・着手検証・勝敗確定・再接続・**席解放アラーム(30秒)**・観戦・もう一局先後入替）。framework非依存 |
| `gomoku-core.js` | `GO_N` と `checkGomoku` の**単一ソース**。`index.html` と verbatim 一致させる |
| `parity.test.mjs` | `index.html` の `checkGomoku` と `gomoku-core.js` が同一出力か検証（divergence厳禁） |
| `server.test.mjs` | サーバー権威ロジックの単体テスト（モック room/conn・席解放含む） |
| `wrangler.toml` | Workers/DO 設定（DOバインディング `Main`→party `main`、SQLite-backed DO、migration） |

## メッセージ仕様（WebSocket / JSON）
- client→server: `hello{token?,name}` / `move{index}` / `undo` / `rename{name}` / `rematch{on}`
- server→client: `assigned{seat,token}` / `state{board,turn,last,result,seats,spectators,gameNo,rematch,series}` / `toast{msg}` / `error{msg}`
- 座席: 1人目=黒(先手) / 2人目=白(後手) / 3人目以降=観戦。`hello.token` が既存席と一致すれば同席復帰。
- `undo`(待った): 直前に着手した本人だけ・相手応手前だけ取消可。成立時は相手へ `toast` 通知。
- `series`: `[{game, winner: pid|null}]`。`seats[].pid` は公開のプレイヤー識別（色は毎局入替のため pid で集計）。
- 再戦成立時は先後を入替え、席が変わった接続へ新しい `assigned` を再送（クライアントの seat 更新）。
- 接続パス: `wss://<host>/parties/main/<部屋コード>`（DOバインディング `Main` が kebab 化されて party `main` に対応）。

## セットアップ（依存インストール）
```sh
cd party
npm install            # partyserver + wrangler (devDependencies)
```

## ローカル開発
```sh
cd party
npx wrangler dev       # 既定 http://127.0.0.1:8787 で起動 (ws://127.0.0.1:8787)
```
`index.html` の `PGP_CONFIG.partyHost` を `127.0.0.1:8787` にすると、クライアントは自動で `ws://` 接続する
（localhost/IP/ポート付きは ws、本番ドメインは wss を使う判定）。
2タブ（または2ブラウザ）で開いて「部屋をつくる」→ もう一方で「あいことば」入力 or `?room=CODE` リンクで参加。
切断して30秒放置すると席が解放され、新規参加者が着席できる（DO Alarm）。

## テスト（デプロイ前に実行）
```sh
node party/parity.test.mjs     # checkGomoku クライアント/サーバー一致
node party/server.test.mjs     # サーバー権威ロジック（座席・検証・勝敗・再接続・rematch・席解放）
```

### 実DOランタイムE2E（オンラインUI×実サーバー・16項目）
`index.html` のオンラインUI層（makeOnlineNet/makeVsOnlineUI）を抽出し、ローカルの実DOに
2クライアントで接続して 着席／1タップ非確定→2度タップ確定／着手ミラー／待った可否と巻き戻し／
決着演出1回だけ／再戦オファー→承諾→新対局／退室／オセロ非合法マス拒否 を機械検証する。
```sh
cd party && npx wrangler dev --port 8787 --local   # 別ターミナルで起動（--local=メモリ内DO・本番に触れない）
node party/online-e2e.test.mjs                     # [online e2e] pass=16 / fail=0 で成功
```

## デプロイ（★ユーザー操作が必要 — Cloudflare アカウント）
```sh
cd party
npx wrangler login      # 初回のみ。ブラウザで Cloudflare 認証
npx wrangler deploy     # *.workers.dev に無料デプロイ。発行URLが表示される
```
1. 発行URL（例: `https://petit-gomoku.<サブドメイン>.workers.dev`）の**ホスト名**を控える。
2. `index.html` の `window.PGP_CONFIG.partyHost` に設定（プロトコルなしでよい。クライアントが `wss://` を補う）。
   ```js
   partyHost:'petit-gomoku.YOURSUBDOMAIN.workers.dev'
   ```
3. `index.html` を変更したら `sw.js` の `CACHE_VERSION` を上げてサイトを公開（GitHub Pages 等）。
   ※ 本移行ではクライアントの接続パスは互換維持のため index.html は無変更（ホスト設定だけ）。
4. `partyHost` が空のままなら、オンライン対戦ボタンは「準備中」で無効化され、ローカル対戦・他ゲームは無傷。

## 運用メモ
- 状態は DO storage（`game`）と各接続の `conn.state` に永続（WebSocket Hibernation 有効: `static options={hibernate:true}`）。
- 席解放: 席プレイヤー切断後 30秒（`GRACE_MS`）再接続が無ければ席解放。DO Alarm で実装（ハイバネーションを越える）。対局途中の解放は盤リセット。
- 観戦者の昇格（席が空いたら観戦→対局）は MVP では行わない。
- `ranking-worker/` とは別 Worker。互いに非干渉。

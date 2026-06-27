# petit-gomoku — 五目並べ オンライン対戦サーバー (PartyKit)

五目並べの **部屋作成＆共有方式オンライン2人対戦**のバックエンド。
部屋 = 1つの Party（Cloudflare Durable Object）。サーバーが盤面を**権威的に保持・検証**する。
ログイン不要。通信はターン制で極小なので Cloudflare 無料枠で実質 $0。

## 構成
| ファイル | 役割 |
|---|---|
| `server.js` | PartyKit Server 本体（座席割当・着手検証・勝敗確定・再接続・観戦・もう一局） |
| `gomoku-core.js` | `GO_N` と `checkGomoku` の**単一ソース**。`index.html` と verbatim 一致させる |
| `parity.test.mjs` | `index.html` の `checkGomoku` と `gomoku-core.js` が同一出力か検証（divergence厳禁） |
| `server.test.mjs` | サーバー権威ロジックの単体テスト（モック room/conn） |
| `../partykit.json` | PartyKit 設定（`main: party/server.js`、project名 `petit-gomoku`） |

## メッセージ仕様（WebSocket / JSON）
- client→server: `hello{token?,name}` / `move{index}` / `rename{name}` / `rematch{on}`
- server→client: `assigned{seat,token}` / `state{board,turn,last,result,seats,spectators,gameNo,rematch}` / `error{msg}`
- 座席: 1人目=黒(先手) / 2人目=白(後手) / 3人目以降=観戦。`hello.token` が既存席と一致すれば同席復帰。

## ローカル開発
```sh
# リポジトリルートで
npx partykit dev            # http://127.0.0.1:1999 で起動 (ws://127.0.0.1:1999)
```
`index.html` の `PGP_CONFIG.partyHost` を `127.0.0.1:1999` にすると、クライアントは自動で `ws://` 接続する（localhost/IP/ポート付きは ws、本番ドメインは wss を使う判定）。
2タブ（または2ブラウザ）で開いて「部屋をつくる」→ もう一方で「あいことば」入力 or `?room=CODE` リンクで参加。

## テスト（デプロイ前に実行）
```sh
node party/parity.test.mjs     # checkGomoku クライアント/サーバー一致
node party/server.test.mjs     # サーバー権威ロジック（座席・検証・勝敗・再接続・rematch）
# 実ランタイムE2E（任意）: npx partykit dev を起動した状態で ws クライアントから疎通確認
```

## デプロイ（★ユーザー操作が必要）
PartyKit/Cloudflare アカウント連携とデプロイは**人手**で行う（エージェントはコードと手順まで）。
```sh
npx partykit deploy            # 初回は CLI でブラウザログインを求められる（Cloudflare/GitHub等）
```
1. デプロイ成功で発行される URL（例: `petit-gomoku.<ユーザー名>.partykit.dev`）を控える。
2. `index.html` の `window.PGP_CONFIG.partyHost` にそのホスト名を設定（プロトコルなしでよい）。
   ```js
   partyHost:'petit-gomoku.YOURNAME.partykit.dev'
   ```
3. `sw.js` の `CACHE_VERSION` を上げて（index.html を変更したため）、サイトを公開（GitHub Pages 等）。
4. `partyHost` が空のままなら、オンライン対戦ボタンは「準備中」表示で無効化され、ローカル対戦・他ゲームは無傷で動作する。

## 運用メモ
- 状態は Durable Object の storage と各接続の `conn.state` に永続（WebSocket Hibernation 対応）。
- MVP では席は DO 生存中ずっと保持（再接続猶予）。長時間放置部屋の自動掃除（storage.deleteAll + alarm）は将来の改善余地。
- 観戦者の昇格（席が空いたら観戦→対局）は MVP では行わない。

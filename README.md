# プチゲー★パーク v2 🎮

ブラウザで遊べる完全オリジナルのミニゲーム集。**1プレイ25秒**・Canvas描画・依存ゼロ・PWA対応。

▶ **あそぶ: https://221barisuta.github.io/petit-game-park/**

スマホはタップ/フリック、PCはクリック/ドラッグ（＋キーボード）。ホーム画面に追加すればオフラインでも起動します。

## 収録ゲーム

| ゲーム | あそびかた | メカニクス |
|---|---|---|
| 🍵 おちゃそそぎ名人 | 長押しで注ぎ、キンいろゾーンで離す | ゲージ制御 |
| 🍣 くるくるレーン | お題に合うものを中央ゾーンで上フリック | スワイプ仕分け |
| 💡 スポットライト☆ダンス | 光がリングに重なった瞬間タップ | 一点タイミング |

## v2の特徴（中毒性 × 拡散性）

- **段階判定** PERFECT/GREAT/GOOD（100/60/30）＋コンボ倍率＋**フィーバー**（8コンボで6秒×2倍）
- **減点なし**：ミスはコンボ解除のみ。スコアは必ず0以上
- **ニアミス表示**：「あと0.05びょう はやければ…！」「あと3%だった…！」「EARLY/LATE」
- **BEST常時表示**＆更新の瞬間に祝福。結果画面に「次の小さな目標」
- **ワンタップ即リスタート**（結果画面の特大ボタン／スペースキー。リトライ時はGO!のみで即開始）
- 初回3プレイは判定ひろめ・最初の器/5秒はゆっくり。チュートリアルは初回のみ（カードの「?」で再表示）
- **📅 デイリーチャレンジ**：日付seedで全員同じ問題（譜面・お題・器の順番）。日別ベスト保存
- **シェア**：結果画面からスコア入り画像を生成して Web Share / X に投稿（画像保存も可）
- **称号＆見た目解放**：プレイ数で称号、各ゲーム5回/15回で色スキン解放（性能差なし）
- バイブ（対応端末）、WebAudio合成SE、初回サウンドON確認

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` | 本体（CSS/JS全部入り・単一ファイル） |
| `manifest.webmanifest` | PWAマニフェスト |
| `sw.js` | Service Worker（オフラインキャッシュ。更新時は `CACHE_VERSION` を上げる） |
| `icon-192.png` / `icon-512.png` | アプリアイコン |
| `og.jpg` | OGP画像（1200×630） |

## 🔧 差し替え箇所（フォーク/移設する場合）

### 1. OGPドメイン
`index.html` 冒頭の `<!-- OGP -->` ブロック内、`og:url` / `og:image` / `twitter:image` の
`https://221barisuta.github.io/petit-game-park/` を自分のURLに変更。
（シェア機能のフォールバックURLは `shareUrl()` 内にもあります）

### 2. GA4 / Plausible（計測）
`index.html` 冒頭の `PGP_CONFIG.analytics` に設定するだけ。**未設定（空）なら計測タグは一切読み込まれません。**

```js
window.PGP_CONFIG = {
  analytics: {provider: 'ga4', id: 'G-XXXXXXXXXX'},   // または {provider:'plausible', id:'あなたのドメイン'}
  ...
};
```
イベントは `track()` ラッパー経由で送信済み: `game_start` / `game_end` / `howto_shown` / `fever` / `share_click`
（game・score・daily・record などのパラメータ付き。ゲーム別プレイ数やhowto離脱が見られます）

### 3. オンラインランキング（実装済み・URLを入れるだけ）
バックエンドは同リポジトリの [`ranking-worker/`](ranking-worker/)（Cloudflare Workers + KV、
`POST /score` と `GET /top` の2本）。デプロイ手順は [ranking-worker/README.md](ranking-worker/README.md)（3コマンド・5分）。

デプロイしたら `PGP_CONFIG.rankingBase` にURLを入れるだけで送信が始まります。
未設定なら何も送りません。デイリーチャレンジの日付seedとキーが連動しており、
「同じ問題を解いた人同士」のランキングになります（ぽちっとミニゲームパークと共用可）。

### 4. デイリーチャレンジの仕組み
`todaySeed()`（YYYYMMDD）を `mulberry32` に渡してゲームへ `ctx.rng` として注入。
譜面・お題順・器の順番がこのrngから決まるため、同じ日付なら全員同じ問題になります。

## ミニゲームを追加する

`index.html` の「ミニゲーム登録ゾーン」に `registerGame({...})` を1ブロック追加するだけ。
`create(ctx)` で受け取る `ctx.judge('perfect'|'great'|'good'|...)` を呼べば、スコア・コンボ・フィーバー・
演出・バイブまで共通システムが処理します。入力は `onDown/onUp/onFlick/onKey` フックで受ける
（自前で `addEventListener` しない＝ゲーム切替時のリスナー漏れ防止）。

## ローカル開発

```bash
python3 -m http.server 8642
# → http://localhost:8642/ （Service Workerはhttp(s)でのみ登録されます）
```

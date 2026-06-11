# プチゲー★パーク v2 🎮

ブラウザで遊べる完全オリジナルのミニゲーム集。**1プレイ20〜25秒**・Canvas描画・依存ゼロ・PWA対応。

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
`index.html` の `<!-- ANALYTICS（差し込み口） -->` ブロックのコメントを外し、`G-XXXXXXXXXX` を自分の測定IDに。
イベントは `track()` ラッパー経由で送信済み: `game_start` / `game_end` / `howto_shown` / `fever` / `share_click`
（game・score・daily・record などのパラメータ付き。ゲーム別プレイ数やhowto離脱が見られます）

### 3. オンラインランキング（フックのみ実装済み）
`index.html` の `window.PGP_RANKING` がフック。現状は何もしない実装です。

```js
window.PGP_RANKING = {
  // 結果画面表示時に毎回呼ばれる
  async submitScore(gameId, score, {daily, seed, date}) {
    await fetch('https://your-api.example.com/score', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({gameId, score, daily, date})
    });
  },
  async fetchTop(gameId, opts) { /* ランキング取得 */ }
};
```

バックエンド候補: **Cloudflare Workers + KV**（dateキーで日替わりランキング）/ **Supabase**（scoresテーブル＋RLS）。
デイリーは `date`（YYYYMMDD数値）と `daily:true` が渡るので、日別・累計の両方を集計できます。

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

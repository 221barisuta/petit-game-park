# メニュー タブ分離（ひとり / たいせん）仕様書 — petit-game-park

作成日: 2026-06-25
ステータス: 📋 作成中（設計レビュー待ち）
担当: Claude Code（実装） / Cowork（設計・管理）
ブランチ: feature/menu-tabs
対象リポジトリ: petit-game-park（`Products/mini-games/`、単一ファイル index.html）

> 姉妹サイト pochitto-mini-game-park にも同じ変更を入れる（そちらは Codex 担当）。
> 前提: ox・gomoku（type:'versus'）がマージ済みの main から分岐すること（たいせんタブに2本並ぶ状態でテストするため）。

---

## 1. 背景・目的
- 現状の選択画面（buildCards）は tea/lane/spot/ox/gomoku を**フラットに混在**表示。
- さらにデイリーチャレンジが**全ゲームから抽選**するため、対戦ゲーム（ox/gomoku）がデイリーに当たると「スコア競争」が成立しない歪みがある。
- 「ひとりであそぶ（タイム制スコア）」と「たいせん（2人対戦）」を**タブで分離**し、体験を整理する。

## 2. 採用方針
- 選択画面 `#scr-select` の上部に**タブ切替**（「🎯 ひとりであそぶ」／「⚔️ たいせん」）を追加。
- ゲーム分類は `def.type==='versus'` を基準にする（versus=たいせん、それ以外=ひとり）。新規ゲーム追加時も type で自動振り分け。
- コア改変は buildCards 周辺＋デイリー抽選プール＋小さなCSS/状態に限定。既存ゲームのプレイ体験は不変。

## 3. 機能要件

### Must
- [ ] `#scr-select` 上部にタブUI（「ひとりであそぶ」「たいせん」）。タップで表示リストを切替。
- [ ] **ひとりタブ**: デイリーチャレンジカード ＋ 非versusゲーム（tea/lane/spot）。
- [ ] **たいせんタブ**: versusゲーム（ox/gomoku）のみ。デイリーカードは出さない。
- [ ] **デイリーチャレンジの抽選対象を「非versusゲームのみ」に限定**（versusがデイリーに選ばれないよう修正）。これは buildCards / refreshBests / openGame(daily) など daily 参照箇所すべてで一貫させる。
- [ ] アクティブタブを保持（`store` / localStorage）。次回起動時も復元。
- [ ] ベスト表示・ランキング・解放など既存機能は「ひとり」側で従来通り動作。

### Should
- [ ] タブにゲーム数バッジや簡単なアイコン。
- [ ] 初回はひとりタブをデフォルト表示。

### Could
- [ ] たいせんタブに「ローカル2人用」の注記（将来オンライン対戦と区別）。

## 4. 技術仕様
- 分類ヘルパ: `soloGames = GAMES.filter(g=>g.type!=='versus')` / `versusGames = GAMES.filter(g=>g.type==='versus')`。
- `buildCards()` を「アクティブタブに応じて該当リストを描画」する形に変更。たいせんタブではデイリーカード生成をスキップ。
- **デイリー定義の算出を soloGames 基準に変更**: 既存の `GAMES[ds%GAMES.length]` を `soloGames[ds%soloGames.length]` に置換（daily を参照する全箇所）。
- タブ状態は `store.get('pgp2_menutab', 'solo')` などで保持。タブ切替で再描画。
- CSS は既存トーン（cqwスケール・配色）を流用してタブを実装。

## 5. 非機能要件
- 対応: Chrome / Safari 最新、モバイル必須、sw.js 変更不要。
- パフォーマンス: 影響なし（描画対象の絞り込みのみ）。

## 6. テスト観点
- ひとりタブ: tea/lane/spot ＋ デイリーカードが出る。デイリーは**versusに当たらない**（soloのみ抽選）。
- たいせんタブ: ox/gomoku のみ。デイリーカードなし。
- タブ保持: 切替→再起動で復元。
- 回帰: 既存のスコア/ランキング/解放/シェア/howto が従来通り。versusゲームのプレイ・勝敗も従来通り。
- 表示: スマホ実機でタブ・カードが崩れない。

## 7. 完了条件（DoD）
- [ ] タブ切替が動作し、ひとり/たいせんが正しく分離表示
- [ ] デイリー抽選が非versusのみ
- [ ] 既存5ゲーム（tea/lane/spot/ox/gomoku）が回帰なく動作
- [ ] タブ状態の保持
- [ ] スマホ実機確認
- [ ] commit & push（feature/menu-tabs）→ PR

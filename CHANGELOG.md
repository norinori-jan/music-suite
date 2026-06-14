# music-suite 開発ログ

## リポジトリ構成
```
music-suite/
├── index.html              ハブ（プロジェクト管理・4アプリナビ）
└── apps/
    ├── vocal-lab.html      既存・安定版（手元にあり、変更なし）
    ├── vocal-lab-v2.html   ダークUI・YINピッチ検出・カード化ベース
    ├── vocal-lab-v3.html   AI補正Phase1・score-editor送信対応
    ├── chord-lab.html      既存完成品（変更なし）
    ├── beat-lab.html       既存完成品（変更なし）
    └── score-editor-v2.html 4バグ修正済み・vocal-lab配列受け取り対応
```

---

## セッション1: vocal-lab-v2 新規実装
**ファイル:** `apps/vocal-lab-v2.html`
**内容:**
- v1(vocal-lab.html)からの刷新：ダークUI、デスクトップレイアウト
- YIN autocorrelation ピッチ検出（v1のautocorrelationより精度向上）
- リアルタイム波形Canvas・ピッチロールCanvas
- オフライン解析：音符セグメント化・0.25拍量子化
- フレーズカード保存（感情タグ付き）
- Web Audio APIサイン波シンセ試聴
- JSONエクスポート（start/dur拍単位・confidence保持）
**v3への引き継ぎポイント:**
- `detectedNotes[]: {name, midiR, hz, start, dur, confidence}` 構造
- `confidence < 0.7` → AI補正対象フラグとして使用

---

## セッション2: score-editor-v2 バグ修正
**ファイル:** `apps/score-editor-v2.html`
**元ファイル:** score-editor-v2-complete.html（featureStub×300のスケルトン）→ 差し替え

**修正した4バグ:**
1. `renderGrid()` → `refreshAll()` (関数が存在しなかった)
2. `proj.timeSig` → `PROJ.timeSig` (小文字typo)
3. `document.getElementById('time-sig')` → 削除 (該当DOMが存在しない)
4. Claude APIヘッダー未設定 → `x-api-key`, `anthropic-version`, `anthropic-dangerous-direct-browser-access` 追加、モデル名を `claude-sonnet-4-6` に更新

**実装済み機能:**
- COMPOSE: ステップ入力 + Quick Composer（コード進行）
- ROLL: ピアノロール（PEN/SEL/ERASE、ドラッグ移動・リサイズ）
- DRUM: ドラムグリッド（beat-labと同等）
- ARR: アレンジメント（セクションブロックのドラッグ並び替え）
- AI: リージョン生成（Claude/Gemini/OpenAI）
- MIDI Format1 エクスポート
- JSON インポート（chord-lab/beat-lab共通フォーマット対応）

---

## セッション3: vocal-lab-v3 AI補正Phase1
**ファイル:** `apps/vocal-lab-v3.html`
**v2からの追加:**

### おまかせ補正モード
- 検出音符 + 感情タグ → Claude API
- 量子化・スケール補正・confidence低い音の補正
- 補正前/補正後 切り替え試聴（比較UI）

### 候補選択モード  
- 検出傾向 → Claude API → 3候補生成
- 各候補タップ試聴 → 選択 → カード化 → 次フレーズへ
- フレーズ番号カウンタ

### 共通
- 感情タグ → AIプロンプトのスケールヒントに反映
  - sad → マイナースケール優先
  - happy → メジャースケール優先
  - tense → 短2度・増4度含む緊張感
  - 等
- LocalStorage APIキー保存
- カードに `rawNotes`(生) + `notes`(AI補正後) + `aiComment` を両方保持

### score-editor送信（今セッション追加）
- 「🎼 score-editor へ送る」ボタン
- 全カードのnotesを時系列結合 → melody.notesフォーマット
- URLハッシュ `#import=base64` で送信（chord-lab/beat-labと同じ方式）
- `apps/`内からの相対パス解決対応

---

## セッション4: index.html ハブ + 連携完成
**ファイル:** `index.html`

**実装:**
- 4アプリへのカードナビ（アイコン・説明・タグ）
- プロジェクト管理（localStorage `msuite_projects`）
  - JSONインポート（ファイル選択 + ドラッグ&ドロップ）
  - プロジェクト一覧表示・削除
  - クリック → 対応アプリをURLハッシュ経由で開く
  - vocal-lab配列形式JSONの自動検出・変換
- データフロー図（4アプリ間の流れ可視化）
- vocal-lab v2（旧版）へのフッターリンク

**score-editor-v2.html 追加修正:**
- `importExternalData` 冒頭に `Array.isArray(data)` 判定追加
- vocal-lab v3のカード配列 → `melody.notes` 共通フォーマット変換
- ROLLのMelodyトラックとして展開

---

## 共通フォーマット（アプリ間JSON）
```json
{
  "version": "1.0",
  "source": "vocal-lab|chord-lab|beat-lab|score-editor",
  "name": "プロジェクト名",
  "bpm": 120,
  "timeSig": 4,
  "melody": { "notes": [{"pitch":69,"startBeat":0,"durationBeats":1,"vel":80}] },
  "chords":  { "sections": [{"progression":[{"chord":"Am","beats":4,"notes":[57,60,64]}]}] },
  "bass":    { "notes": [...] },
  "drums":   { "notes": [{"pitch":36,"startBeat":0,"durationBeats":0.25,"vel":80}] },
  "exported": "2026-06-14T..."
}
```
vocal-lab v3 は配列形式 `[{id,name,emotion,notes:[{name,midiR,hz,start,dur,conf}],...}]` でもエクスポート可（index.html / score-editorが自動変換）

---

## 残りタスク
- [ ] UIテスト・バグ修正（実ブラウザ確認）
- [ ] 作曲キャンバス（カードをドラッグ自由配置・サビ/没案グルーピング）
- [ ] vocal-lab-v3 → index.html プロジェクト自動保存（localStorage連携）
- [ ] OpenUtau / VOICEVOX 連携（後段）
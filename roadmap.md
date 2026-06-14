# music-suite 開発状況 & ロードマップ
最終更新: 2026-06-14

---

## ✅ 完成済み（全ファイル）

### ディレクトリ構成
```
music-suite/
├── index.html               ✅ ハブ（ナビ + プロジェクト管理 + データフロー図）
└── apps/
    ├── vocal-lab.html        ✅ 既存安定版（変更なし）
    ├── vocal-lab-v2.html     ✅ ダークUI + YINピッチ検出 + カード化
    ├── vocal-lab-v3.html     ✅ AI補正Phase1 + localStorage + score-editor送信
    ├── canvas.html           ✅ 作曲キャンバス（ドラッグ配置・グルーピング）
    ├── chord-lab.html        ✅ 既存完成品（変更なし）
    ├── beat-lab.html         ✅ 既存完成品（変更なし）
    └── score-editor-v2.html  ✅ バグ修正済み + vocal-lab配列受け取り対応
```

---

## 各ファイルの実装内容

### index.html
- 5アプリへのカードナビ（vocal-lab v3 / canvas / chord-lab / beat-lab / score-editor v2）
- プロジェクト管理: localStorage `msuite_projects`
- JSONインポート（ファイル選択 + ドラッグ&ドロップ）
- プロジェクト一覧 → クリックで対応アプリをURLハッシュ経由で起動
- vocal-lab配列形式JSONの自動検出・変換
- データフロー図（4アプリ間の流れ）

### vocal-lab-v2.html
- YIN autocorrelation ピッチ検出（v1より精度向上）
- リアルタイム波形Canvas + ピッチロールCanvas
- オフライン解析: 音符セグメント化 → 0.25拍量子化
- フレーズカード保存（感情タグ付き）
- Web Audio API サイン波シンセ試聴
- JSONエクスポート（start/dur拍単位 + confidence保持）

### vocal-lab-v3.html ★ メイン
- v2の全機能を継承
- **おまかせ補正モード**: 検出音符 + 感情タグ → Claude API → スケール補正 → 補正前/後 切り替え試聴
- **候補選択モード**: 検出傾向 → Claude API → 3候補生成 → タップ試聴 → 選択 → カード化
- 感情タグ → AIプロンプトのスケールヒント反映（sad→マイナー / happy→メジャー 等）
- LocalStorage APIキー保存（`vl3_claude_key`）
- カードに rawNotes + AI補正後notes + aiComment を両方保持
- localStorage自動保存（`vl3_cards`）: カード保存・削除のたびに自動同期
- 「🎼 score-editor へ送る」ボタン: 全カードを結合 → URLハッシュ経由で送信

### canvas.html ★ 新規
- vocal-lab-v3のlocalStorage(`vl3_cards`)から自動読み込み
- フレーズカードをドラッグで自由配置（16pxグリッドスナップ）
- グループ割り当て: イントロ/Aメロ/Bメロ/サビ/アウトロ/アイデア/没案/転調案
- グループゾーン: 同一グループを色付き破線で囲んで可視化
- カスタムグループ追加
- 自動整列（グループ別カラム）
- Ctrl+ホイール / ボタンでズーム（30%〜200%）
- シンセ試聴（カード上の▶ボタン）
- レイアウト保存: localStorage `msuite_canvas_layout`
- score-editor-v2.html / index.html へのナビリンク

### score-editor-v2.html
- 元のfeatureStub×300スケルトンから完全実装版に差し替え
- **修正した4バグ**: renderGrid()→refreshAll() / proj→PROJ / time-sig DOM除去 / Claude authヘッダー追加
- COMPOSE: ステップ入力 + Quick Composer
- ROLL: ピアノロール（PEN/SEL/ERASE、ノートドラッグ・リサイズ）
- DRUM: ドラムグリッド
- ARR: アレンジメント（ドラッグ並び替え）
- AI: リージョン生成（Claude/Gemini/OpenAI）
- MIDI Format1エクスポート
- vocal-lab配列形式の自動変換受け取り（importExternalData先頭で Array.isArray 判定）

---

## アプリ間データフロー

```
vocal-lab-v3
  │ localStorage["vl3_cards"]
  ├─→ canvas.html（自動読み込み・ドラッグ構成管理）
  └─→ score-editor-v2（URLハッシュ #import=base64 → メロディトラック）

chord-lab
  └─→ score-editor-v2（URLハッシュ → コード+ベーストラック）

beat-lab
  └─→ score-editor-v2（URLハッシュ → ドラムトラック）

score-editor-v2
  └─→ GarageBand（MIDI Format1 ダウンロード）

index.html
  ├─← 各アプリのJSONエクスポートをインポート管理
  └─→ 各アプリをURLハッシュ経由で起動
```

## 共通JSONフォーマット（アプリ間連携）
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
  "exported": "ISO8601"
}
```
vocal-lab v3 の配列形式 `[{id,name,emotion,notes:[{name,midiR,hz,start,dur,conf}],...}]`
→ index.html / score-editor が自動変換

---

## 🔲 残りタスク（優先順）

### Phase 2（次セッション候補）
| # | タスク | 難度 | 推定行数 | 説明 |
|---|--------|------|----------|------|
| 1 | **UIテスト・バグ修正** | 低 | 修正のみ | 実ブラウザで各アプリを動かして不具合を潰す |
| 2 | **canvas.html → score-editor送信** | 低 | +30行 | キャンバスの配置順でメロディ結合してscore-editorへ |
| 3 | **vocal-lab-v3 候補モードのフレーズ積み上げ** | 中 | +50行 | 複数フレーズを録り続けてひとつの曲として出力 |
| 4 | **vocal-lab-v3 → canvas 自動リンク** | 低 | +10行 | v3のヘッダーに「🗺️ キャンバスで開く」ボタン追加 |

### Phase 3（中期）
| # | タスク | 難度 | 推定行数 | 説明 |
|---|--------|------|----------|------|
| 5 | **chord-lab → canvas 連携** | 中 | +100行 | コード進行カードもキャンバスに表示・管理 |
| 6 | **OpenUtau 連携** | 高 | 新規 | vocal-labのメロディ+歌詞をOpenUtau用USTファイル出力 |
| 7 | **VOICEVOX 連携** | 高 | 新規 | ローカルVOICEVOX APIへのリクエスト・音声プレビュー |
| 8 | **vocal-lab-v3 AI補正 Phase 2** | 中 | +100行 | 前フレーズの調・スケールを文脈として次のAI補正に渡す |

### Phase 4（長期）
| # | タスク | 説明 |
|---|--------|------|
| 9 | **モバイル対応** | vocal-lab-v3 / canvas のタッチ操作最適化 |
| 10 | **PWA化** | オフライン動作・ホーム画面追加対応 |
| 11 | **クラウド同期** | Firebase / Supabase でプロジェクトを複数端末共有 |
| 12 | **score-editor トラックミキサー** | 音量・パン・ミュートをリアルタイム調整 |

---

## 次セッション開始メモ

次のセッションでは **このファイル(ROADMAP.md)を貼り付けて** 開始してください。
優先タスクは上記 Phase 2 の #1〜#4 です。

### すぐ着手できるもの（小さい順）
1. `vocal-lab-v3.html` ヘッダーに `🗺️ キャンバス` ボタン追加（10行）
2. `canvas.html` から score-editor への送信ボタン追加（30行）
3. ブラウザで実際に開いてバグ報告 → 修正
# music-suite 開発状況 & ロードマップ
最終更新: 2026-06-20

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

## 2026-06-20 統合判断メモ

### canvas.html と archive/canvas_old.html の扱い
- 現行 `apps/canvas.html` は `vocal-lab-v3 -> canvas -> score-editor-v2` の統合線に乗っているため、当面はこちらを正とする。
- `archive/canvas_old.html` は単体キャンバスとしてのUI/プロジェクト保存機能が多く、参考実装として残す。
- いま交換はしない。交換すると、今回揃えた `vl3_cards` 自動読み込み、配置順のメロディ結合、`score-editor-v2` 送信の流れが崩れるリスクがある。
- 今後は `archive/canvas_old.html` から「良いUI部品」だけを現行 `apps/canvas.html` に段階移植する。

### 2026-06-20 完了
- `vocal-lab-v3.html`: `#import=` 経由で受け取ったカード束を復元し、`vl3_cards` に同期。
- `canvas.html`: `vl3_cards` / `{ cards: [...] }` の読み込みに対応し、音符形式の揺れを吸収。
- `canvas.html`: `midiR/start/dur/conf` と `pitch/startBeat/durationBeats/confidence` の両形式を試聴・送信で扱えるよう補強。
- `score-editor-v2.html`: vocal-lab の配列形式だけでなく `{ cards: [...] }` 形式も受信可能に。
- `index.html`: データフロー表示を `vocal-lab / canvas / chord-lab / beat-lab -> score-editor` に更新。
- 構文チェック: `index.html`, `apps/canvas.html`, `apps/vocal-lab-v3.html`, `apps/score-editor-v2.html` のHTML内JavaScriptはOK。

---

## UI ワークロードマップ

### UI方針
- ハブ `index.html` は「入口とプロジェクト管理」に専念する。
- `vocal-lab-v3` は録音・補正・カード化に集中する。
- `canvas` は曲の構成を考える作業台にする。カードの配置、グループ、曲順、没案管理を担当する。
- `score-editor-v2` は最終編集・MIDI出力の場にする。
- 画面ごとの役割を混ぜすぎず、送る/戻る/保存の導線だけを明確にする。

### Phase UI-1: 統合の信頼性確認
| # | タスク | 優先度 | 完了条件 |
|---|--------|--------|----------|
| 1 | ブラウザで4画面の導線確認 | 高 | `index -> vocal-lab -> canvas -> score-editor -> index` が迷わず往復できる |
| 2 | localStorageキー確認 | 高 | `vl3_cards`, `msuite_canvas_layout`, `msuite_projects` が衝突しない |
| 3 | 空データ時の表示改善 | 中 | カードなし、配置なし、送信不可の状態が自然に分かる |
| 4 | 受信データのエラー表示 | 中 | 壊れたJSONや空カードで無反応にならない |

### Phase UI-2: canvas の作業性改善
| # | タスク | 優先度 | 完了条件 |
|---|--------|--------|----------|
| 1 | archive版UIの良い部品を棚卸し | 高 | 取り込む/取り込まない部品を一覧化 |
| 2 | 曲順パネル追加 | 高 | x座標だけでなく、明示的な順番でscore-editorへ送れる |
| 3 | グループ編集UI改善 | 中 | グループ名変更、色変更、削除ができる |
| 4 | カード詳細パネル | 中 | raw/AI補正、音符数、長さ、感情、メモを確認できる |
| 5 | レイアウト操作 | 中 | 全体フィット、選択カードへ移動、ズーム表示が自然 |

### Phase UI-3: vocal-lab の制作フロー改善
| # | タスク | 優先度 | 完了条件 |
|---|--------|--------|----------|
| 1 | 録音からカード化までの状態表示 | 高 | 録音中、解析中、AI補正中、保存済みが明確 |
| 2 | カード名・感情・補正状態の編集 | 中 | 保存後でも最小限の修正ができる |
| 3 | canvasへ送る導線の強調 | 中 | 保存後に自然に「キャンバスで構成」へ進める |
| 4 | 複数フレーズ録音の連続作業 | 中 | 次の録音にすぐ移れる |

### Phase UI-4: score-editor の受け入れ体験改善
| # | タスク | 優先度 | 完了条件 |
|---|--------|--------|----------|
| 1 | インポート直後の表示位置調整 | 高 | 受信したノートがすぐ見える位置に表示される |
| 2 | 受信元ごとのトラック命名 | 中 | `Canvas Melody`, `Vocal Melody`, `Beat Drums` など識別できる |
| 3 | 既存トラックへ追加/新規追加の選択 | 中 | インポート時の上書き不安がなくなる |
| 4 | MIDI出力前チェック | 低 | 空トラックや極端な長さを警告できる |

### Phase UI-5: 全体の仕上げ
| # | タスク | 優先度 | 完了条件 |
|---|--------|--------|----------|
| 1 | 文言統一 | 中 | `送る`, `読み込み`, `保存`, `エクスポート` の意味が画面間で一致 |
| 2 | モバイル/タッチ確認 | 中 | vocal-lab と canvas の基本操作がタッチで破綻しない |
| 3 | 見た目の密度調整 | 低 | 主要画面でボタン過多・説明過多にならない |
| 4 | 操作確認チェックリスト作成 | 低 | 変更ごとに確認すべき導線が明文化される |

---

## 🔲 残りタスク（優先順）

### Phase 2（次セッション候補）
| # | タスク | 難度 | 推定行数 | 説明 |
|---|--------|------|----------|------|
| 1 | **UIテスト・バグ修正** | 低 | 修正のみ | 実ブラウザで各アプリを動かして不具合を潰す |
| 2 | **canvas 曲順パネル** | 中 | +80行 | x座標順だけでなく、明示順でscore-editorへ送る |
| 3 | **archive版canvasのUI部品選別** | 低 | 調査 | 現行に移植する価値のある部品だけ抽出 |
| 4 | **vocal-lab-v3 候補モードのフレーズ積み上げ** | 中 | +50行 | 複数フレーズを録り続けてひとつの曲として出力 |

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

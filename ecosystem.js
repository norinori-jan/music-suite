// ecosystem.js
// ─────────────────────────────
// 共通設定・タグ読み込み・APIキー管理
// ─────────────────────────────

export function loadEcosystemTags() {
  try {
    const raw = localStorage.getItem('ecosystem_tags');
    if (!raw) return [];
    const { tags } = JSON.parse(raw);
    return tags || [];
  } catch(_) { return []; }
}

export function loadApiKeys() {
  try {
    const raw = localStorage.getItem('ml_keys');
    if (!raw) return {};
    return JSON.parse(raw);
  } catch(_) { return {}; }
}

export function saveApiKeys(keys) {
  localStorage.setItem('ml_keys', JSON.stringify(keys));
}

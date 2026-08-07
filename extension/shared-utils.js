// Shared, side-effect-free helpers used by extension pages and the service worker.
// Keep this file browser-compatible; it is also loaded directly by Node's test runner.
(() => {
  function confidenceValue(hit) {
    if (hit?.confidence === null || hit?.confidence === undefined || hit?.confidence === '') return null;
    const value = Number(hit.confidence);
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
  }

  function filterAndSortHits(hits, config = {}) {
    const source = Array.isArray(hits) ? hits : [];
    const threshold = Number(config.confThreshold) || 0;
    const showConfidence = Boolean(config.showConfidence);
    const annotated = source.filter((hit) => confidenceValue(hit) !== null).length;
    let hidden = 0;
    let visible = source;

    if (showConfidence && threshold > 0) {
      hidden = source.filter((hit) => {
        const confidence = confidenceValue(hit);
        return confidence !== null && confidence < threshold;
      }).length;
      visible = source.filter((hit) => {
        const confidence = confidenceValue(hit);
        return confidence === null || confidence >= threshold;
      });
    }

    if (showConfidence) {
      visible = visible.map((hit, index) => ({ hit, index })).sort((a, b) => {
        const aValue = confidenceValue(a.hit);
        const bValue = confidenceValue(b.hit);
        if (aValue !== null && bValue !== null) return bValue - aValue || a.index - b.index;
        if (aValue !== null) return -1;
        if (bValue !== null) return 1;
        return a.index - b.index;
      }).map(({ hit }) => hit);
    }
    return { hits: visible, hidden, annotated };
  }

  function faviconHashValues(features = {}) {
    return [...new Set([features.faviconHash, ...(features.faviconHashes || [])].filter(Boolean))];
  }

  function mergeRules(existingRules = [], rulesToAdd = []) {
    const byId = new Map(existingRules.map((rule) => [rule.id, rule]));
    for (const rule of rulesToAdd) byId.set(rule.id, rule);
    return [...byId.values()];
  }

  function mergeConvertedRules(rules = []) {
    const byId = new Map();
    for (const rule of rules) {
      const existing = byId.get(rule.id);
      if (!existing) {
        byId.set(rule.id, { ...rule });
        continue;
      }
      existing.matchers = [...(existing.matchers || []), ...(rule.matchers || [])];
      existing.implies = [...new Set([...(existing.implies || []), ...(rule.implies || [])])];
      existing.excludes = [...new Set([...(existing.excludes || []), ...(rule.excludes || [])])];
    }
    return [...byId.values()];
  }

  function extractYaml(text) {
    const source = String(text || '');
    const match = source.match(/```(?:yaml|yml)?[^\S\r\n]*\r?\n([\s\S]*?)```/i);
    return (match ? match[1] : source).trim();
  }

  const api = { confidenceValue, filterAndSortHits, faviconHashValues, mergeRules, mergeConvertedRules, extractYaml };
  globalThis.GoPainterUtils = Object.freeze(api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

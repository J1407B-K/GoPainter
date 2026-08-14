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
    let annotated = 0;
    let hidden = 0;
    const visible = [];
    for (let index = 0; index < source.length; index++) {
      const hit = source[index];
      const confidence = confidenceValue(hit);
      if (confidence !== null) annotated++;
      if (showConfidence && threshold > 0 && confidence !== null && confidence < threshold) {
        hidden++;
        continue;
      }
      visible.push(showConfidence ? { hit, index, confidence } : hit);
    }

    if (showConfidence) {
      visible.sort((a, b) => {
        const aValue = a.confidence;
        const bValue = b.confidence;
        if (aValue !== null && bValue !== null) return bValue - aValue || a.index - b.index;
        if (aValue !== null) return -1;
        if (bValue !== null) return 1;
        return a.index - b.index;
      });
      return { hits: visible.map(({ hit }) => hit), hidden, annotated };
    }
    return { hits: visible, hidden, annotated };
  }

  function filterRules(rules = [], query = '', limit = 300) {
    const source = Array.isArray(rules) ? rules : [];
    const needle = String(query || '').trim().toLowerCase();
    const max = Math.max(0, Number(limit) || 0);
    const items = [];
    let total = 0;
    for (const rule of source) {
      if (needle && !`${rule?.id || ''}\n${rule?.name || ''}`.toLowerCase().includes(needle)) continue;
      total++;
      if (items.length < max) items.push(rule);
    }
    return { items, total };
  }

  function crawlRenderSignature(resp = {}) {
    const results = Array.isArray(resp.results) ? resp.results : [];
    const failed = Array.isArray(resp.failed) ? resp.failed : [];
    const last = results[results.length - 1] || {};
    const lastFailed = failed[failed.length - 1] || {};
    return [results.length, failed.length, last.url || '', last.status || '', (last.hits || []).length,
      lastFailed.url || '', lastFailed.error || ''].join('|');
  }

  function popupResultSnapshot(features = {}, result = {}, at = Date.now()) {
    const hits = (result.hits || []).slice(0, 100).map((hit) => ({
      id: hit.id,
      name: hit.name,
      confidence: hit.confidence,
      source: hit.source,
      evidence: (hit.evidence || []).slice(0, 20).map((item) => ({
        type: item.type || item.matcher,
        part: item.part || item.location,
        detail: String(item.detail ?? item.matched ?? '').slice(0, 500),
      })),
    }));
    return {
      features: {
        url: features.url || '', title: features.title || '', status: features.status || 0,
        headers: { server: features.headers?.server || '' }, favicon: features.favicon || '',
        faviconHashes: (features.faviconHashes || []).slice(0, 20),
      },
      result: { note: result.note, hits, totalHits: (result.hits || []).length },
      at,
    };
  }

  function limitedObject(value, limit = 80, valueLimit = 500) {
    const out = {};
    for (const [key, item] of Object.entries(value || {}).slice(0, limit)) {
      out[String(key).slice(0, 200)] = String(item ?? '').slice(0, valueLimit);
    }
    return out;
  }

  function agentPageSnapshot(features = {}, at = Date.now()) {
    return {
      url: features.url || '', title: features.title || '', status: features.status ?? null,
      headers: limitedObject(features.headers, 50), meta: limitedObject(features.meta, 100),
      scripts: (features.scripts || []).slice(0, 100).map((value) => String(value).slice(0, 500)),
      faviconHashes: (features.faviconHashes || []).slice(0, 20),
      js: limitedObject(features.js, 100),
      domHits: limitedObject(features.domHits, 100, 20),
      at,
    };
  }

  function faviconHashValues(features = {}) {
    return [...new Set((features.faviconHashes || []).filter(Boolean))];
  }

  // Convert raw bytes to the binary string expected by btoa. TextDecoder('latin1')
  // is a Windows-1252 alias in browsers, so bytes 0x80-0x9f are not round-tripped.
  function bytesToBinaryString(bytes) {
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const chunks = [];
    for (let offset = 0; offset < input.length; offset += 0x8000) {
      chunks.push(String.fromCharCode(...input.subarray(offset, offset + 0x8000)));
    }
    return chunks.join('');
  }

  function mergeRules(existingRules = [], rulesToAdd = []) {
    const byId = new Map(existingRules.map((rule) => [rule.id, rule]));
    for (const rule of rulesToAdd) byId.set(rule.id, rule);
    return [...byId.values()];
  }

  // 规则集保存在 ruleSets；rules 是当前激活规则集的兼容镜像，供匹配层和旧版本 UI 读取。
  // 首次升级时把旧 rules 无损迁入默认规则集。
  function normalizeRuleSets(ruleSets, activeRuleSetId, legacyRules = []) {
    const sets = Array.isArray(ruleSets)
      ? ruleSets.filter((set) => set && typeof set.id === 'string' && set.id && Array.isArray(set.rules))
        .map((set) => ({ id: set.id, name: String(set.name || set.id), rules: set.rules }))
      : [];
    if (!sets.length) sets.push({ id: 'default', name: '默认规则集', rules: Array.isArray(legacyRules) ? legacyRules : [] });
    const active = sets.find((set) => set.id === activeRuleSetId) || sets[0];
    return { ruleSets: sets, activeRuleSetId: active.id, rules: active.rules };
  }

  function replaceActiveRuleSetRules(state, rules) {
    const normalized = normalizeRuleSets(state?.ruleSets, state?.activeRuleSetId, state?.rules);
    const nextRules = Array.isArray(rules) ? rules : [];
    return {
      ...normalized,
      ruleSets: normalized.ruleSets.map((set) => set.id === normalized.activeRuleSetId ? { ...set, rules: nextRules } : set),
      rules: nextRules,
    };
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

  // 从 AI 回复里抠 JSON：剥 ```json 围栏，跳到首个 {/[，按括号配平截断尾随散文
  function extractJson(text) {
    const source = String(text || '').trim();
    if (!source) return { ok: false };
    let candidate = source;
    const fence = source.match(/```(?:json)?[^\S\r\n]*\r?\n([\s\S]*?)```/i);
    if (fence) candidate = fence[1].trim();
    const start = candidate.search(/[[{]/);
    if (start === -1) return { ok: false };
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          try { return { ok: true, value: JSON.parse(candidate.slice(start, i + 1)) }; } catch { return { ok: false }; }
        }
      }
    }
    return { ok: false };
  }

  // AI evidence 规范化 → 引擎兼容 {type, part, detail, pattern}
  // header/meta/script/title/url/raw/body 是"位置"语义 → 归一成 {type:'word', part, detail}
  function normalizeAiEvidence(e) {
    if (!e || typeof e !== 'object') return null;
    const type = String(e.type || '').trim().toLowerCase();
    if (!type) return null;
    const detail = String(e.detail ?? e.pattern ?? e.value ?? '').trim();
    if (!detail) return null;
    const locTypes = { header: 'header', meta: 'meta', script: 'script', title: 'title', url: 'url', raw: 'raw', body: 'body' };
    const ev = { type, detail };
    if (locTypes[type]) { ev.type = 'word'; ev.part = locTypes[type]; }
    else if (type === 'status') ev.type = 'status';
    else if (type === 'icon_hash') ev.type = 'icon_hash';
    // word / regex / js / dom 原样保留
    if (e.part) ev.part = e.part;
    if (e.pattern) ev.pattern = e.pattern;
    return ev;
  }

  // 单条 tech 规范化：name 必填，confidence 0-1 → 0-100，evidence 逐条清洗
  function normalizeAiTech(t) {
    if (!t || typeof t !== 'object') return null;
    const name = String(t.name || '').trim();
    if (!name) return null;
    let confidence = null;
    if (t.confidence != null && t.confidence !== '') {
      const n = Number(t.confidence);
      if (Number.isFinite(n)) confidence = Math.round(n > 1 ? n : n * 100);
    }
    if (confidence != null) confidence = Math.max(0, Math.min(100, confidence));
    const evidence = (Array.isArray(t.evidence) ? t.evidence : []).map(normalizeAiEvidence).filter(Boolean);
    return { name, confidence, evidence };
  }

  // 组合入口：把 AI 回复解析成 techs；解析失败时原样文本回给调用方兜底展示
  function techsFromAiReply(text) {
    const raw = String(text || '').trim();
    const parsed = extractJson(raw);
    let list = null;
    if (parsed.ok) {
      if (Array.isArray(parsed.value)) list = parsed.value;
      else if (parsed.value && Array.isArray(parsed.value.techs)) list = parsed.value.techs;
      else if (parsed.value && Array.isArray(parsed.value.technologies)) list = parsed.value.technologies;
    }
    if (!Array.isArray(list)) return { techs: [], raw };
    return { techs: list.map(normalizeAiTech).filter(Boolean), raw: '' };
  }

  // 技术名 → 已有规则（按 id 或 name，大小写不敏感）
  function ruleByTechName(rules = [], name = '') {
    const needle = String(name || '').trim().toLowerCase();
    if (!needle) return null;
    for (const r of rules) {
      if (String(r.id || '').toLowerCase() === needle || String(r.name || '').toLowerCase() === needle) return r;
    }
    return null;
  }

  // --- AI 生成规则的清洗 ---
  // goNormalizeRules 要求字段类型严格（words/hash 必须是数组、confidence 必须是 0-100 整数），
  // AI 输出常有偏差（confidence: 0.92、words: "x"、单个 matcher 不装数组……），一处不对整条规则就被丢。
  // 这里在喂 wasm 之前把常见形态都规整好：标量→数组、0-1 置信度→0-100、丢掉坏 matcher。

  function toStrArray(v) {
    if (v == null) return [];
    if (Array.isArray(v)) return v.map((x) => String(x ?? '')).filter(Boolean);
    return [String(v)];
  }

  function toIntArray(v) {
    if (v == null) return [];
    const list = Array.isArray(v) ? v : [v];
    return list.map(Number).filter((n) => Number.isFinite(n)).map((n) => Math.trunc(n));
  }

  // 0-1 → 0-100；浮点四舍五入；越界/非数字 → null（与引擎 validConfidence 语义一致）
  function normalizeConfidence(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    let c = n > 1 ? n : n * 100;
    c = Math.round(c);
    return (c >= 0 && c <= 100) ? c : null;
  }

  function sanitizeMatcher(m) {
    if (!m || typeof m !== 'object') return null;
    const type = String(m.type || '').trim();
    if (!type) return null;
    const out = { type };
    if (m.part) out.part = String(m.part);
    if (m.condition) out.condition = String(m.condition);
    if (m.negative) out.negative = !!m.negative;
    const conf = normalizeConfidence(m.confidence);
    if (conf != null) out.confidence = conf;
    switch (type) {
      case 'word': {
        out.words = toStrArray(m.words);
        if (!out.words.length) return null;
        break;
      }
      case 'regex': {
        out.regex = toStrArray(m.regex);
        if (!out.regex.length) return null;
        break;
      }
      case 'status': {
        out.status = toIntArray(m.status);
        if (!out.status.length) return null;
        break;
      }
      case 'icon_hash': {
        out.hash = toIntArray(m.hash);
        if (!out.hash.length) return null;
        break;
      }
      case 'dsl': {
        out.dsl = toStrArray(m.dsl);
        if (!out.dsl.length) return null;
        break;
      }
      case 'js': {
        const list = Array.isArray(m.js) ? m.js : (m.js && typeof m.js === 'object' ? [m.js] : []);
        out.js = list
          .filter((p) => p && typeof p === 'object' && String(p.path || '').trim())
          .map((p) => {
            const probe = { path: String(p.path) };
            if (p.pattern) probe.pattern = String(p.pattern);
            return probe;
          });
        if (!out.js.length) return null;
        break;
      }
      case 'dom': {
        const list = Array.isArray(m.dom) ? m.dom : (m.dom && typeof m.dom === 'object' ? [m.dom] : []);
        out.dom = list
          .filter((p) => p && typeof p === 'object' && String(p.sel || '').trim())
          .map((p) => {
            const probe = { sel: String(p.sel) };
            if (p.text) probe.text = String(p.text);
            if (p.attrs && typeof p.attrs === 'object') {
              probe.attrs = Object.fromEntries(Object.entries(p.attrs).map(([k, v]) => [k, String(v)]));
            }
            return probe;
          });
        if (!out.dom.length) return null;
        break;
      }
      default:
        return null; // 不支持的 matcher 类型直接丢
    }
    return out;
  }

  function sanitizeRule(r) {
    if (!r || typeof r !== 'object') return null;
    const id = String(r.id || '').trim();
    if (!id) return null;
    const name = String(r.name || id).trim();
    const rawMatchers = Array.isArray(r.matchers) ? r.matchers : (r.matchers && typeof r.matchers === 'object' ? [r.matchers] : []);
    const matchers = rawMatchers.map(sanitizeMatcher).filter(Boolean);
    if (!matchers.length) return null;
    const out = { id, name, matchers };
    const condition = r['matchers-condition'] || r.matchersCondition;
    if (condition) out['matchers-condition'] = String(condition);
    const conf = normalizeConfidence(r.confidence);
    if (conf != null) out.confidence = conf;
    if (r.implies) out.implies = toStrArray(r.implies);
    if (r.excludes) out.excludes = toStrArray(r.excludes);
    return out;
  }

  // 把 jsyaml.loadAll 的结果（文档数组，元素可能是对象或数组）洗成扁平的合法规则对象数组
  function sanitizeRuleDocs(docs) {
    const out = [];
    for (const d of docs) {
      if (Array.isArray(d)) out.push(...d.map(sanitizeRule).filter(Boolean));
      else if (d && typeof d === 'object') {
        const r = sanitizeRule(d);
        if (r) out.push(r);
      }
    }
    return out;
  }

  function scanHistoryEntry(features = {}, result = {}, source = 'page', at = Date.now()) {
    return {
      url: String(features.url || ''),
      title: String(features.title || ''),
      status: Number.isInteger(features.status) ? features.status : 0,
      faviconHashes: (features.faviconHashes || []).map((h) => (Number.isFinite(h) ? h : 0)),
      source,
      at,
      hits: (result.hits || []).map((hit) => ({
        id: String(hit.id || ''),
        name: String(hit.name || hit.id || ''),
        confidence: confidenceValue(hit),
        evidence: Array.isArray(hit.evidence) ? hit.evidence.map(reportEvidence) : [],
      })),
    };
  }

  // Export evidence has stable semantics: what matched vs. the rule expression.
  // Accept the legacy shape too, so existing stored history remains exportable.
  function reportEvidence(item = {}) {
    const evidence = {
      matcher: String(item.matcher || item.type || ''),
      location: String(item.location || item.part || ''),
      matched: String(item.matched ?? item.detail ?? ''),
    };
    const expression = item.expression || item.pattern;
    if (expression) evidence.expression = String(expression);
    return evidence;
  }

  function mergeScanHistory(history = [], entry, limit = 300) {
    if (!entry?.url) return Array.isArray(history) ? history : [];
    return [entry, ...history.filter((item) => item?.url !== entry.url)].slice(0, limit);
  }

  function normalizeHistoryLimit(value, fallback = 300) {
    const number = Number.parseInt(value, 10);
    if (!Number.isInteger(number)) return fallback;
    return Math.min(5000, Math.max(50, number));
  }

  function csvCell(value) {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function scanHistoryReport(history = [], generatedAt = Date.now()) {
    return {
      schemaVersion: 1,
      generatedAt: new Date(generatedAt).toISOString(),
      scans: history.map((item) => ({
        timestamp: new Date(item.at).toISOString(),
        source: item.source,
        target: {
          url: item.url,
          title: item.title || '',
          status: item.status || 0,
          faviconHashes: item.faviconHashes || [],
        },
        detections: (item.hits || []).map((hit) => ({
          id: hit.id || '',
          name: hit.name || hit.id || '',
          confidence: hit.confidence ?? null,
          evidence: (hit.evidence || []).map(reportEvidence),
        })),
      })),
    };
  }

  function scanHistoryCsv(history = []) {
    const header = [
      'time', 'source', 'url', 'title', 'status', 'favicon_hash',
      'fingerprint_id', 'fingerprint_name', 'confidence', 'matcher', 'location', 'matched', 'expression',
    ];
    const rows = [];
    for (const item of history) {
      const base = [new Date(item.at).toISOString(), item.source, item.url, item.title, item.status, (item.faviconHashes || []).join(' ')];
      const hits = item.hits || [];
      if (!hits.length) {
        rows.push([...base, '', '', '', '', '', '', ''].map(csvCell).join(','));
        continue;
      }
      for (const hit of hits) {
        const hitColumns = [hit.id || '', hit.name || hit.id || '', hit.confidence ?? ''];
        const evidence = (hit.evidence || []).map(reportEvidence);
        if (!evidence.length) {
          rows.push([...base, ...hitColumns, '', '', '', ''].map(csvCell).join(','));
          continue;
        }
        for (const itemEvidence of evidence) {
          rows.push([
            ...base, ...hitColumns, itemEvidence.matcher, itemEvidence.location,
            itemEvidence.matched, itemEvidence.expression || '',
          ].map(csvCell).join(','));
        }
      }
    }
    return [header.join(','), ...rows].join('\r\n');
  }

  const api = {
    confidenceValue, filterAndSortHits, filterRules, crawlRenderSignature, popupResultSnapshot, agentPageSnapshot, faviconHashValues, bytesToBinaryString, mergeRules, mergeConvertedRules,
    normalizeRuleSets, replaceActiveRuleSetRules, extractYaml,
    extractJson, normalizeAiEvidence, normalizeAiTech, techsFromAiReply, ruleByTechName,
    sanitizeRuleDocs, sanitizeRule, sanitizeMatcher,
    scanHistoryEntry, mergeScanHistory, normalizeHistoryLimit, scanHistoryReport, scanHistoryCsv,
  };
  globalThis.GoPainterUtils = Object.freeze(api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

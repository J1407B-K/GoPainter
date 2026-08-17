// Bookmark organization host: browser I/O, bounded fetch concurrency and optional legacy AI fallback.
(() => {
  function selectedBookmarks(tree, onlyIds) {
    const wanted = onlyIds?.length ? new Set(onlyIds) : null;
    const selected = [];
    const visit = (nodes) => {
      for (const node of nodes) {
        if (node.url && /^https?:/.test(node.url) && (!wanted || wanted.has(node.id))) {
          selected.push(node);
        }
        if (node.children) visit(node.children);
      }
    };
    visit(tree);
    return selected;
  }

  async function getOrCreateFolder(parentId, title) {
    const children = await chrome.bookmarks.getChildren(parentId);
    const found = children.find((item) => !item.url && item.title === title);
    return found || chrome.bookmarks.create({ parentId, title });
  }

  async function classifyBookmark(bookmark, prompt) {
    const features = await GoPainterPageFetch.fetchFeatures(bookmark.url);
    const result = await appendHashHit(features, await runMatch(features));
    const ruleName = result.hits?.[0]?.name;
    if (ruleName) return { name: ruleName, ai: false };
    if (!prompt) return null;
    const answer = (await GoPainterLegacyAI.call(prompt, features)).trim();
    if (!answer || answer === '未知' || answer.length >= 50) return null;
    return { name: answer, ai: true };
  }

  async function classifyAll(bookmarks, prompt, summary) {
    const groups = new Map();
    let next = 0;
    const worker = async () => {
      while (next < bookmarks.length) {
        const bookmark = bookmarks[next++];
        try {
          const classification = await classifyBookmark(bookmark, prompt);
          if (!classification) continue;
          if (classification.ai) summary.aiMatched++;
          else summary.matched++;
          if (!groups.has(classification.name)) groups.set(classification.name, []);
          groups.get(classification.name).push(bookmark);
        } catch {
          summary.failed++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, bookmarks.length) }, worker));
    return groups;
  }

  async function moveGroups(tree, groups, summary) {
    if (!groups.size) return;
    const bar = tree[0].children.find((item) => item.id === '1') || tree[0].children[0];
    const root = await getOrCreateFolder(bar.id, '🎨 指纹分类');
    for (const [name, bookmarks] of groups) {
      const folder = await getOrCreateFolder(root.id, name);
      for (const bookmark of bookmarks) {
        try {
          await chrome.bookmarks.move(bookmark.id, { parentId: folder.id });
          summary.moved++;
          summary.groups[name] = (summary.groups[name] || 0) + 1;
        } catch { /* A single stale bookmark must not abort the whole organization job. */ }
      }
    }
  }

  async function organize({ ids, useAI }) {
    const tree = await chrome.bookmarks.getTree();
    const bookmarks = selectedBookmarks(tree, ids);
    const summary = {
      total: bookmarks.length,
      matched: 0,
      aiMatched: 0,
      moved: 0,
      failed: 0,
      groups: {},
    };
    const prompt = useAI ? await GoPainterLegacyAI.prompt('bookmark') : null;
    const groups = await classifyAll(bookmarks, prompt, summary);
    await moveGroups(tree, groups, summary);
    return { ok: true, summary };
  }

  globalThis.GoPainterBookmarksHost = Object.freeze({
    handlers: Object.freeze({ organizeBookmarks: organize }),
  });
})();

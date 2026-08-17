// One-time cleanup for removed product features. The external-script feature was
// retired in v0.6.5, so its stored source code must not remain in extension storage.
(() => {
  const CLEANUP_KEY = 'storageCleanup:v0.6.5';

  async function removeRetiredExternalScripts() {
    const stored = await chrome.storage.local.get(CLEANUP_KEY);
    if (stored[CLEANUP_KEY]) return;
    await chrome.storage.local.remove('userScripts');
    await chrome.storage.local.set({ [CLEANUP_KEY]: true });
  }

  removeRetiredExternalScripts().catch((error) => {
    console.warn('清理已移除的外接脚本数据失败:', error);
  });
})();

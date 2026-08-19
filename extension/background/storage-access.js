// Persistent settings include rules, history, and optional AI credentials.
// Content scripts do not read storage.local directly, so keep that data available
// only to trusted extension contexts (service worker and extension pages).
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch((error) => {
  console.warn('限制本地存储访问失败:', error);
});

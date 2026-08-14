// 页面特征读取共用层：工具只能读取当前 agent 绑定的 tab，不能任意枚举标签页。
(() => {
  function checkedTabId(input, context) {
    const tabId = context.tabId ?? input.tabId;
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error('需要当前页面上下文');
    if (context.tabId != null && input.tabId != null && input.tabId !== context.tabId) throw new Error('不允许读取其他标签页');
    return tabId;
  }
  async function getFeatures(input, context) {
    const tabId = checkedTabId(input, context);
    const load = async () => {
      const stored = await chrome.storage.session.get(`result:${tabId}`);
      const features = stored[`result:${tabId}`]?.features;
      if (!features) throw new Error('当前页面尚无特征，请先刷新页面');
      return features;
    };
    if (!context.cache) return load();
    context.cache.pageFeatures ||= load();
    return context.cache.pageFeatures;
  }
  async function getOverview(input, context) {
    const tabId = checkedTabId(input, context);
    const load = async () => {
      const key = `agent:${tabId}`;
      const stored = await chrome.storage.session.get(key);
      if (stored[key]?.url) return stored[key];
      const features = await getFeatures({}, context);
      return GoPainterUtils.agentPageSnapshot ? GoPainterUtils.agentPageSnapshot(features) : features;
    };
    if (!context.cache) return load();
    context.cache.pageOverview ||= load();
    return context.cache.pageOverview;
  }
  function string(value) { return String(value ?? ''); }
  function limit(value, fallback, max) {
    const number = Number(value ?? fallback);
    if (!Number.isInteger(number) || number < 1 || number > max) throw new Error(`limit 必须是 1-${max} 的整数`);
    return number;
  }
  globalThis.GoPainterAgentPage = Object.freeze({ getFeatures, getOverview, string, limit });
})();

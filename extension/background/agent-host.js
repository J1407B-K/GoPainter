// Long-lived Agent port. Visible trace events exclude model-private reasoning.
(() => {
  function createPermissionChannel(port) {
    let pending = null;
    return Object.freeze({
      request: (request) => new Promise((resolve) => {
        pending = resolve;
        port.postMessage({ type: 'permission', request });
      }),
      answer: (decision) => {
        if (!pending) return;
        const resolve = pending;
        pending = null;
        resolve(decision);
      },
    });
  }

  async function runAgent(port, controller, permission, msg) {
    try {
      const result = await GoPainterAgentLoop.run({
        goalId: msg.goalId,
        tabId: msg.tabId,
        input: msg.input || '',
        grants: [],
        signal: controller.signal,
        onTrace: (item) => port.postMessage({ type: 'trace', item }),
        onPermissionRequest: permission.request,
      });
      port.postMessage({ type: 'complete', result });
    } catch (error) {
      port.postMessage({ type: 'error', error: String(error.message || error) });
    }
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'gopainter-agent') return;
    const controller = new AbortController();
    const permission = createPermissionChannel(port);
    let running = false;

    port.onMessage.addListener(async (msg) => {
      if (msg?.type === 'keepalive') {
        port.postMessage({ type: 'keepaliveAck' });
        return;
      }
      if (msg?.type === 'permissionResponse') {
        permission.answer({ granted: Boolean(msg.granted), remember: Boolean(msg.remember) });
        return;
      }
      if (msg?.type !== 'runAgent') return;
      if (running) {
        port.postMessage({ type: 'error', error: 'Agent 已在执行中' });
        return;
      }
      running = true;
      await runAgent(port, controller, permission, msg);
      running = false;
    });

    port.onDisconnect.addListener(() => {
      controller.abort();
      permission.answer({ granted: false, remember: false });
    });
  });
})();

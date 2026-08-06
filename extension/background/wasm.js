// WASM engine lifecycle.

let wasmReady = null;

function ensureWasm() {
  if (!wasmReady) {
    wasmReady = (async () => {
      const go = new Go();
      const resp = await fetch(chrome.runtime.getURL('wasm/matcher.wasm'));
      const { instance } = await WebAssembly.instantiateStreaming(resp, go.importObject);
      go.run(instance); // 不会返回，Go 那边 select{} 常驻
      if (typeof globalThis.goMatch !== 'function') {
        throw new Error('wasm 加载了但 goMatch 没注册上');
      }
    })();
    wasmReady.catch(() => { wasmReady = null; }); // 失败了下次重试
  }
  return wasmReady;
}

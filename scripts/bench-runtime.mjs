// Shared WASM boot and synthetic matching fixture for cold/steady benchmarks.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function loadMatcherWasm() {
  await import(join(ROOT, 'extension/wasm/wasm_exec.js'));
  const go = new globalThis.Go();
  const bytes = readFileSync(join(ROOT, 'extension/wasm/matcher.wasm'));
  const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
  go.run(instance);
}

export function createMatchFixture(numRules, bodySize) {
  const filler = 'x'.repeat(bodySize / 2);
  const body = `<html><head><title>Test Site</title></head><body>${filler}<div class="wordpress-content">hello world wp-content theme</div><script src="/wp-includes/js/jquery.js"></script></body></html>`;
  const common = ['jquery', 'wp-content', 'wp-includes', 'bootstrap', 'nginx', 'react', 'vue', 'api', 'cdn', 'theme', 'css', 'js'];
  const parts = ['body', 'body', 'body', 'meta', 'script', 'title', 'header'];
  const rules = Array.from({ length: numRules }, (_, index) => ({
    id: `rule-${index}`,
    name: `Tech ${index}`,
    'matchers-condition': 'or',
    matchers: [{
      type: 'word',
      part: parts[index % parts.length],
      words: [`sig${index}`, common[index % common.length], `tech-${index % 50}`].slice(0, 1 + (index % 3)),
    }],
  }));
  const features = {
    url: 'https://blog.example.com/',
    title: 'Test Site',
    body,
    headers: { server: 'nginx', 'content-type': 'text/html' },
    status: 200,
    meta: { generator: 'TestCMS', viewport: 'width=device-width' },
    scripts: ['/wp-includes/js/jquery.js', '/assets/app.js'],
    faviconHashes: [],
  };
  return {
    body,
    rulesJSON: JSON.stringify(rules),
    featuresJSON: JSON.stringify(features),
  };
}

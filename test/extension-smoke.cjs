// 拡張機能を実際に Chromium へ読み込み、service worker から content script を注入できるか確認する。
//   - manifest が読み込めるか
//   - content script（ISOLATED world）から Translator API が見えるか
//   - 1 回目の注入で ON、2 回目で OFF になるか
//   - ページ側（MAIN world）から拡張機能の内部状態が見えないか
//
//   npm run test:extension
//
// 自動テストではツールバーボタンを押せない（= activeTab が付与されない）ため、
// 一時ディレクトリに拡張機能をコピーし、テスト用サーバーにだけ host_permissions を付けて実行する。
// テスト用 Chromium の Translator API は応答しないので、翻訳そのものは確認しない。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rje-ext-'));
  fs.cpSync(path.join(__dirname, '../extension'), tmp, { recursive: true });
  const manifestPath = path.join(tmp, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  const html = fs.readFileSync(path.join(__dirname, 'fixture.html'));
  const server = http.createServer((_, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium', // 拡張機能は新しい headless モードでのみ動く
    headless: true,
    args: [`--disable-extensions-except=${tmp}`, `--load-extension=${tmp}`],
  });
  try {
    const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
    const page = await ctx.newPage();
    await page.goto(url);

    const result = await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
      const target = { tabId: tab.id };
      const [probe] = await chrome.scripting.executeScript({ target, func: () => typeof Translator });
      await chrome.scripting.insertCSS({ target, files: ['src/content.css'] });
      const [first] = await chrome.scripting.executeScript({ target, files: ['src/content.js'] });
      const [second] = await chrome.scripting.executeScript({ target, files: ['src/content.js'] });
      return { translatorInIsolatedWorld: probe.result, first: first.result, second: second.result };
    });
    console.log(result);
    assert.notEqual(result.translatorInIsolatedWorld, 'undefined', 'Translator should be visible from content scripts');
    assert.equal(result.first, true);
    assert.equal(result.second, false);
    assert.equal(await page.evaluate(() => typeof window.__readingEnglishJaEn), 'undefined');
    console.log('extension smoke test passed');
  } finally {
    await ctx.close();
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

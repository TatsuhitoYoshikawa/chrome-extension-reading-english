// content script の自動テスト。
// 実際の Translator API は Chrome 本体（デスクトップ）にしか無いため、モックを使って
// DOM への挿入・スキップ・トグル・動的追加・キャッシュ・ダウンロード進捗表示を確認する。
//
//   npm test   (= node test/run.cjs)
//
// Playwright が必要（npm i -D playwright && npx playwright install chromium）。

const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../extension');
const FIXTURE = 'file://' + path.join(__dirname, 'fixture.html');
const CONTENT_JS = path.join(ROOT, 'src/content.js');
const CONTENT_CSS = path.join(ROOT, 'src/content.css');
const MOCK_JS = path.join(__dirname, 'mock-translator.js');

/** 拡張機能のボタンを押したのと同じ（content.js をもう一度実行し、戻り値を返す） */
async function clickAction(page) {
  const fs = require('node:fs');
  const code = fs.readFileSync(CONTENT_JS, 'utf8');
  return page.evaluate((src) => (0, eval)(src), code);
}

async function openPage(browser, { availability = 'available', mock = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(FIXTURE);
  await page.addStyleTag({ path: CONTENT_CSS });
  if (mock) {
    await page.addScriptTag({ path: MOCK_JS });
    await page.evaluate((a) => { globalThis.__mock.availability = a; }, availability);
  }
  return page;
}

const trOf = (page, id) =>
  page.evaluate((id) => {
    const el = document.getElementById(id);
    const tr = [...el.children].find((c) => c.localName === 'rje-translation');
    return tr ? { text: tr.textContent, hidden: tr.hidden, state: tr.dataset.rjeState } : null;
  }, id);

const bannerVisible = (page) =>
  page.evaluate(() => {
    const b = document.querySelector('rje-banner');
    return !!b && !b.hidden;
  });

const tests = {
  async 'translates headings and paragraphs, skips non-Japanese/inputs/code'(browser) {
    const page = await openPage(browser);
    assert.equal(await clickAction(page), true);
    await page.waitForFunction(() => document.querySelectorAll('rje-translation[data-rje-state="done"]').length >= 8);

    assert.equal((await trOf(page, 'h1')).text, 'EN[日本語の見出しです]');
    assert.equal((await trOf(page, 'p1')).text, 'EN[これは日本語の段落です。英訳が直下に表示されるはずです。]');
    assert.equal(await trOf(page, 'p-en'), null);
    assert.equal((await trOf(page, 'ruby')).text, 'EN[漢字を読みます]', 'ruby text (rt) is excluded');
    assert.equal((await trOf(page, 'div-text')).text, 'EN[ディブ直下のテキスト]\nEN[二行目のテキスト]');
    assert.equal(await trOf(page, 'br-only-jp'), null, 'too short');
    assert.equal(await trOf(page, 'nav'), null);
    assert.equal(await trOf(page, 'editable'), null);
    assert.equal(await trOf(page, 'pre'), null);
    const inForm = await page.evaluate(() =>
      document.body.innerHTML.includes('EN[入力欄') || document.body.innerHTML.includes('EN[コード') ||
      document.body.innerHTML.includes('EN[スクリプト'));
    assert.equal(inForm, false);

    // 入れ子：li の中の p には p 側だけ。親 li の訳は子リストの前に入る
    assert.equal(await trOf(page, 'li-p'), null);
    assert.equal((await trOf(page, 'p-in-li')).text, 'EN[リストの中の段落です]');
    const nestedOrder = await page.evaluate(() =>
      [...document.getElementById('li-nested').childNodes].map((n) => n.nodeName).join(','));
    assert.equal(nestedOrder, '#text,RJE-TRANSLATION,UL');
    assert.equal((await trOf(page, 'li-child')).text, 'EN[子の項目です]');
    await page.close();
  },

  async 'toggle hides and shows translations'(browser) {
    const page = await openPage(browser);
    await clickAction(page);
    await page.waitForFunction(() => document.querySelector('#p1 > rje-translation[data-rje-state="done"]'));
    assert.equal(await clickAction(page), false);
    assert.equal((await trOf(page, 'p1')).hidden, true);
    const visibleHeight = await page.evaluate(() => document.querySelector('#p1 > rje-translation').offsetHeight);
    assert.equal(visibleHeight, 0);
    assert.equal(await clickAction(page), true);
    assert.equal((await trOf(page, 'p1')).hidden, false);
    await page.close();
  },

  async 'caches identical text'(browser) {
    const page = await openPage(browser);
    await clickAction(page);
    await page.waitForFunction(() =>
      document.querySelector('#dup1 > rje-translation[data-rje-state="done"]') &&
      document.querySelector('#dup2 > rje-translation[data-rje-state="done"]'));
    const calls = await page.evaluate(() => globalThis.__mock.calls.filter((c) => c === '同じ文章です。').length);
    assert.equal(calls, 1);
    await page.close();
  },

  async 'handles dynamically added and changed elements'(browser) {
    const page = await openPage(browser);
    await clickAction(page);
    await page.waitForFunction(() => document.querySelector('#p1 > rje-translation[data-rje-state="done"]'));

    await page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'added';
      p.textContent = '後から追加された段落です';
      document.body.prepend(p);
    });
    await page.waitForFunction(() => document.querySelector('#added > rje-translation[data-rje-state="done"]'));
    assert.equal((await trOf(page, 'added')).text, 'EN[後から追加された段落です]');

    await page.evaluate(() => { document.getElementById('p1').firstChild.data = '書き換えられた段落です'; });
    await page.waitForFunction(() =>
      document.querySelector('#p1 > rje-translation')?.textContent === 'EN[書き換えられた段落です]');

    await page.evaluate(() => { document.getElementById('p1').firstChild.data = 'Now English'; });
    await page.waitForFunction(() => !document.querySelector('#p1 > rje-translation'));
    await page.close();
  },

  async 'translates lazily when scrolled into view'(browser) {
    const page = await openPage(browser);
    await clickAction(page);
    await page.waitForFunction(() => document.querySelector('#p1 > rje-translation[data-rje-state="done"]'));
    await page.waitForTimeout(300);
    assert.equal(await trOf(page, 'far'), null);
    await page.evaluate(() => document.getElementById('far').scrollIntoView());
    await page.waitForFunction(() => document.querySelector('#far > rje-translation[data-rje-state="done"]'));
    await page.close();
  },

  async 'asks for a click and shows download progress on first use'(browser) {
    const page = await openPage(browser, { availability: 'downloadable' });
    assert.equal(await clickAction(page), true);
    await page.waitForFunction(() => document.querySelector('rje-banner') && !document.querySelector('rje-banner').hidden);
    assert.equal(await page.evaluate(() => document.querySelectorAll('rje-translation').length), 0);

    // 閉じた Shadow DOM なので座標でボタン（カード下端）を押す
    const box = await page.locator('rje-banner').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 30);
    await page.waitForFunction(() => document.querySelector('#p1 > rje-translation[data-rje-state="done"]'));
    assert.equal(await page.evaluate(() => globalThis.__mock.created), 1);
    // 準備完了メッセージの後、自動で閉じる
    await page.waitForFunction(() => document.querySelector('rje-banner').hidden, null, { timeout: 5000 });
    await page.close();
  },

  async 'shows an error when Translator API is missing'(browser) {
    const page = await openPage(browser, { mock: false });
    // テスト用 Chromium には Translator が定義されている（が応答しない）ので消しておく
    await page.evaluate(() => { delete globalThis.Translator; });
    assert.equal(await clickAction(page), true);
    await page.waitForTimeout(200);
    assert.equal(await bannerVisible(page), true);
    assert.equal(await page.evaluate(() => document.querySelectorAll('rje-translation').length), 0);
    await page.close();
  },
};

(async () => {
  const browser = await chromium.launch();
  let failed = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn(browser);
      console.log(`ok   - ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL - ${name}\n${err.stack}`);
    }
  }
  await browser.close();
  console.log(failed ? `\n${failed} test(s) failed` : '\nall tests passed');
  process.exit(failed ? 1 : 0);
})();

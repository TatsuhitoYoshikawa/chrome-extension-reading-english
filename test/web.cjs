// ウェブアプリ（web/）の自動テスト。スマホ相当の画面サイズで実際に操作して確認する。
//
//   npm test
//
// Playwright が必要（npm install && npx playwright install chromium）。

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const WEB = path.join(__dirname, '../web');
const TOKEN_RE = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
};

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(WEB, rel);
    if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const key = (w) => {
  const k = w.toLowerCase().replace(/’/g, "'");
  return k.endsWith("'s") ? k.slice(0, -2) : k;
};
function expectedStats(paragraphs) {
  const words = paragraphs.flatMap((p) => p.en.match(TOKEN_RE) ?? []);
  return { total: words.length, unique: new Set(words.map(key)).size };
}

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(WEB, rel), 'utf8'));
const statText = async (page, id) => Number((await page.textContent(`#${id}`)).replace(/,/g, ''));
const word = (page, i, text) =>
  page.locator(`.para[data-i="${i}"] .w`).filter({ hasText: new RegExp(`^${text}$`) }).first();

const tests = {
  'every word in every text has a meaning'() {
    const common = readJson('texts/common.json');
    for (const { id } of readJson('texts/index.json')) {
      const work = readJson(`texts/${id}.json`);
      work.paragraphs.forEach((p, i) => {
        assert.ok(p.en && p.ja, `${id} #${i}: en/ja missing`);
        for (const w of p.en.match(TOKEN_RE)) {
          const exact = w.toLowerCase().replace(/’/g, "'");
          const found = [exact, key(w)].some((k) => k in p.g || k in common);
          assert.ok(found, `${id} #${i}: no meaning for "${w}"`);
        }
      });
    }
  },

  async 'tap a word to see its meaning, tap again to save it'({ page, url }) {
    await page.goto(`${url}#/read/selfish-giant`);
    await word(page, 0, 'afternoon').click();
    assert.equal(await page.textContent('#sheet-meaning'), '午後');
    assert.match(await page.textContent('#sheet-sentence'), /^EVERY afternoon, as they were coming/);
    assert.equal(await page.textContent('#sheet-sentence mark'), 'afternoon');
    assert.match(await page.textContent('#sheet-status'), /もう一度タップ/);

    // 別の単語は意味が切り替わるだけ（登録されない）
    await word(page, 0, 'garden').click();
    assert.equal(await page.textContent('#sheet-meaning'), '庭');
    await word(page, 0, 'garden').click();
    assert.match(await page.textContent('#sheet-status'), /登録しました/);
    await word(page, 0, 'garden').click(); // 3 回目でも重複登録しない

    // 文の中の正しい位置が強調される（1 段落に複数文ある場合）
    await word(page, 1, 'listen').click();
    assert.match(await page.textContent('#sheet-sentence'), /^The birds sat on the trees/);
    assert.equal(await page.textContent('#sheet-sentence mark'), 'listen');

    await page.reload();
    await page.goto(`${url}#/vocab`);
    await page.waitForSelector('.vocab li');
    const items = await page.locator('.vocab li').allTextContents();
    assert.equal(items.length, 1);
    assert.match(items[0], /garden/);
    assert.match(items[0], /庭/);
  },

  async 'marking paragraphs as read updates word counts and persists'({ page, url }) {
    const work = readJson('texts/selfish-giant.json');
    await page.goto(url);
    assert.equal(await statText(page, 'stat-total'), 0);

    await page.goto(`${url}#/read/selfish-giant`);
    await page.click('.para[data-i="1"] .mark'); // 2 段落目まで読んだ
    await page.goto(url);
    let exp = expectedStats(work.paragraphs.slice(0, 2));
    assert.equal(await statText(page, 'stat-total'), exp.total);
    assert.equal(await statText(page, 'stat-unique'), exp.unique);
    assert.ok(exp.unique < exp.total);

    // 最後に読んだ段落をもう一度押すと 1 段落戻る
    await page.goto(`${url}#/read/selfish-giant`);
    await page.click('.para[data-i="1"] .mark');
    await page.reload();
    await page.goto(url);
    exp = expectedStats(work.paragraphs.slice(0, 1));
    assert.equal(await statText(page, 'stat-total'), exp.total);
    assert.equal(exp.total, 19); // "EVERY afternoon, ... the Giant’s garden."
    assert.equal(exp.unique, 18); // the が 2 回

    // 全部読むと「読了」
    await page.goto(`${url}#/read/selfish-giant`);
    await page.click(`.para[data-i="${work.paragraphs.length - 1}"] .mark`);
    await page.goto(url);
    assert.match(await page.textContent('.works'), /読了/);
    exp = expectedStats(work.paragraphs);
    assert.equal(await statText(page, 'stat-total'), exp.total);
  },

  async 'Japanese toggle is remembered'({ page, url }) {
    await page.goto(`${url}#/read/selfish-giant`);
    assert.equal(await page.isVisible('.para[data-i="0"] .ja'), true);
    await page.click('.toggle');
    assert.equal(await page.isVisible('.para[data-i="0"] .ja'), false);
    await page.reload();
    assert.equal(await page.isVisible('.para[data-i="0"] .ja'), false);
  },

  async 'works offline after the first visit'({ page, url, context }) {
    await page.goto(`${url}#/read/selfish-giant`);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload(); // SW の管理下で本文データもキャッシュさせる
    await page.waitForSelector('.para');
    await context.setOffline(true);
    await page.reload();
    await page.waitForSelector('.para[data-i="0"] .en');
    await context.setOffline(false);
  },
};

(async () => {
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  let failed = 0;
  for (const [name, fn] of Object.entries(tests)) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    try {
      await fn({ page, url, context });
      assert.deepEqual(errors, [], 'no errors in the page (including CSP violations)');
      console.log(`ok   - ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL - ${name}\n${err.stack}`);
    }
    await context.close();
  }
  await browser.close();
  server.close();
  console.log(failed ? `\n${failed} test(s) failed` : '\nall tests passed');
  process.exit(failed ? 1 : 0);
})();

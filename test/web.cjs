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

// render.yaml の全ページ共通ヘッダー（Strict-Transport-Security は http では無意味なので除く）
const RENDER_HEADERS = [...fs.readFileSync(path.join(__dirname, '../render.yaml'), 'utf8')
  .matchAll(/- path: \/\*\n\s+name: (\S+)\n\s+value: "?([^"\n]+)"?/g)]
  .map((m) => [m[1], m[2]])
  .filter(([name]) => name !== 'Strict-Transport-Security');

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(WEB, rel);
    if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream');
    for (const [name, value] of RENDER_HEADERS) res.setHeader(name, value); // 本番（Render）と同じヘッダー
    res.end(fs.readFileSync(file));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const key = (w) => {
  const k = w.toLowerCase().replace(/’/g, "'");
  return k.endsWith("'s") ? k.slice(0, -2) : k;
};
const lemma = (w) => readJson('texts/lemmas.json')[key(w)] ?? key(w);
const tokens = (work) => work.paragraphs.flatMap((p) => p.en.match(TOKEN_RE) ?? []);
function expectedStats(work, count) {
  const words = tokens(work).slice(0, count);
  return { total: words.length, unique: new Set(words.map(lemma)).size };
}

/** マウスで長押し */
async function longPress(page, locator) {
  await locator.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
}

/** 指で長押し（Chrome DevTools Protocol でタッチ操作を送る） */
async function touchLongPress(page, locator) {
  await locator.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const box = await locator.boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
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

  'Render config serves web/ with the same CSP as index.html'() {
    const yaml = fs.readFileSync(path.join(__dirname, '../render.yaml'), 'utf8');
    assert.match(yaml, /staticPublishPath: \.\/web/);
    const header = yaml.match(/name: Content-Security-Policy\s+value: "([^"]+)"/)[1];
    const meta = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8')
      .match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    assert.equal(header, `${meta}; frame-ancestors 'none'`);
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

  'inflected forms are listed with existing base forms'() {
    const lemmas = readJson('texts/lemmas.json');
    for (const [form, base] of Object.entries(lemmas)) {
      assert.notEqual(form, base);
      assert.equal(lemmas[base], undefined, `${base} (base of ${form}) must not be inflected again`);
    }
  },

  async 'long-press a word to mark reading progress up to it'({ page, url }) {
    const work = readJson('texts/selfish-giant.json');
    await page.goto(url);
    assert.equal(await statText(page, 'stat-total'), 0);

    await page.goto(`${url}#/read/selfish-giant`);
    await longPress(page, word(page, 0, 'school')); // EVERY afternoon, as they were coming from school
    assert.equal(await page.isVisible('#sheet'), false, 'long-press must not open the meaning panel');
    assert.match(await page.textContent('#toast'), /ここまで読みました：8語/);
    assert.equal(await page.locator('.w.read').count(), 8);
    assert.equal(await page.textContent('.w.last'), 'school');

    // 2 段落目の最後の単語まで
    await longPress(page, page.locator('.para[data-i="1"] .w').last());
    const count2 = tokens({ paragraphs: work.paragraphs.slice(0, 2) }).length;
    await page.goto(url);
    let exp = expectedStats(work, count2);
    assert.equal(await statText(page, 'stat-total'), exp.total);
    assert.equal(await statText(page, 'stat-unique'), exp.unique);
    assert.match(await page.textContent('.works'), new RegExp(`${count2} / `));

    // 前の単語を長押しすると、そこまでに戻る。取り消しで元に戻る
    await page.goto(`${url}#/read/selfish-giant`);
    await longPress(page, word(page, 0, 'garden'));
    assert.equal(await page.locator('.w.read').count(), 19);
    await page.click('#toast button');
    assert.equal(await page.locator('.w.read').count(), count2);
    await longPress(page, word(page, 0, 'garden'));

    await page.reload();
    await page.goto(url);
    exp = expectedStats(work, 19);
    assert.equal(await statText(page, 'stat-total'), 19); // "EVERY afternoon, ... the Giant’s garden."
    assert.equal(await statText(page, 'stat-unique'), 18); // the が 2 回（were は be として 1 語）
    assert.deepEqual(exp, { total: 19, unique: 18 });

    // 最後の単語まで読むと「読了」ボタンを案内する。活用形をまとめるので種類数は見出し形より少ない
    await page.goto(`${url}#/read/selfish-giant`);
    await longPress(page, page.locator('.w').last());
    assert.match(await page.textContent('#toast'), /読了/);
    await page.goto(url);
    const n = tokens(work).length.toLocaleString('en-US');
    assert.equal(await page.textContent('.works .status'), `${n} / ${n} 語`);
    exp = expectedStats(work, Infinity);
    assert.equal(await statText(page, 'stat-total'), exp.total);
    assert.equal(await statText(page, 'stat-unique'), exp.unique);
    assert.ok(exp.unique < new Set(tokens(work).map(key)).size);
  },

  async 'touch long-press marks progress without opening the meaning panel'({ page, url }) {
    await page.goto(`${url}#/read/selfish-giant`);
    await touchLongPress(page, word(page, 0, 'school'));
    await page.waitForTimeout(300);
    assert.equal(await page.isVisible('#sheet'), false);
    assert.equal(await page.locator('.w.read').count(), 8);
    // 普通のタップは今までどおり意味を表示する
    await word(page, 0, 'garden').tap();
    assert.equal(await page.textContent('#sheet-meaning'), '庭');
  },

  async 'shows the base form of an inflected word'({ page, url }) {
    await page.goto(`${url}#/read/selfish-giant`);
    await word(page, 3, 'ran').click();
    assert.match(await page.textContent('#sheet-word'), /^ran原形 run$/);
    await word(page, 3, 'ran').click();
    await page.goto(`${url}#/vocab`);
    await page.waitForSelector('.vocab li');
    assert.match(await page.textContent('.vocab li'), /ran（run）/);
  },

  async 'finishing a work adds all its words, and re-reading adds them again'({ page, url }) {
    const work = readJson('texts/selfish-giant.json');
    const all = expectedStats(work, Infinity);
    await page.goto(`${url}#/read/selfish-giant`);
    await longPress(page, word(page, 0, 'school')); // 読みかけ（8 語）
    await page.click('.finish');
    await page.waitForSelector('.stats');
    assert.equal(await statText(page, 'stat-total'), all.total, 'finished work counts fully (no double count)');
    assert.equal(await statText(page, 'stat-unique'), all.unique);
    assert.match(await page.textContent('.works .status'), /^読了 1 回$/);

    // 取り消すと元の読みかけ（8 語）に戻る
    await page.click('#toast button');
    await page.waitForFunction(() => /^8 \//.test(document.querySelector('.works .status')?.textContent));
    assert.equal(await statText(page, 'stat-total'), 8);

    // もう一度読了 → 2 回目を途中まで → 延べ数だけ増え、語彙数は増えない
    await page.goto(`${url}#/read/selfish-giant`);
    await page.click('.finish');
    await page.goto(`${url}#/read/selfish-giant`);
    assert.equal(await page.locator('.w.read').count(), 0, 're-reading starts from the beginning');
    await longPress(page, word(page, 0, 'garden')); // 19 語
    await page.goto(url);
    assert.equal(await statText(page, 'stat-total'), all.total + 19);
    assert.equal(await statText(page, 'stat-unique'), all.unique);
    assert.match(await page.textContent('.works .status'), /^読了 1 回・2 回目 19 \//);

    await page.reload();
    assert.equal(await statText(page, 'stat-total'), all.total + 19);
  },

  async 'totals are summed across works'({ page, url }) {
    // テスト用に 2 作品目を差し込む
    const mini = {
      id: 'mini', title: 'Mini', titleJa: 'ミニ', author: 'Test', year: 2000, source: 'test',
      paragraphs: [{ en: 'The giant went home. A new word!', ja: 'テスト', g: { home: '家', new: '新しい', word: '単語' } }],
    };
    const index = [...readJson('texts/index.json'), { id: 'mini', title: 'Mini', titleJa: 'ミニ', author: 'Test' }];
    await page.route('**/texts/index.json', (r) => r.fulfill({ json: index }));
    await page.route('**/texts/mini.json', (r) => r.fulfill({ json: mini }));

    await page.goto(`${url}#/read/selfish-giant`);
    await longPress(page, word(page, 0, 'garden')); // 19 語・18 種類
    await page.goto(`${url}#/read/mini`);
    await page.waitForSelector('.finish');
    await page.click('.finish'); // the giant went home a new word：7 語、新しい原形は home a new word の 4 つ
    await page.waitForSelector('.stats');
    assert.equal(await statText(page, 'stat-total'), 19 + 7);
    assert.equal(await statText(page, 'stat-unique'), 18 + 4); // the, giant, go(went) は 1 作品目で既出
  },

  async 'backup: save to a file and restore from it'({ page, url }) {
    await page.goto(`${url}#/read/selfish-giant`);
    await longPress(page, word(page, 0, 'school'));
    await word(page, 0, 'garden').click();
    await word(page, 0, 'garden').click(); // 単語帳に 1 語
    await page.goto(url);
    await page.waitForSelector('#backup-download');

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#backup-download')]);
    assert.match(download.suggestedFilename(), /^bilingual-reader-backup-\d{4}-\d{2}-\d{2}\.json$/);
    const file = await download.path();
    const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(backup.app, 'bilingual-reader');
    assert.equal(backup.data.read['selfish-giant'], 8);
    assert.equal(backup.data.vocab[0].w, 'garden');

    // 記録を消してから読み込む
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    assert.equal(await statText(page, 'stat-total'), 0);
    const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
    await page.setInputFiles('.backup input[type=file]', file);
    await page.waitForFunction(() => document.getElementById('stat-total')?.textContent === '8');
    assert.equal(await statText(page, 'stat-vocab'), 1);
    assert.match(dialogs[0], /置き換えます/);

    // 別のファイルは読み込まない
    await page.setInputFiles('.backup input[type=file]', {
      name: 'other.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}'),
    });
    await page.waitForTimeout(300);
    assert.match(dialogs.at(-1), /このアプリのバックアップファイルではありません/);
    assert.equal(await statText(page, 'stat-total'), 8);
  },

  async 'backup: share opens the system share sheet with the backup file'({ page, url }) {
    await page.addInitScript(() => {
      navigator.canShare = (d) => d.files?.[0]?.name.endsWith('.json');
      navigator.share = async (d) => { window.__shared = { name: d.files[0].name, text: await d.files[0].text() }; };
    });
    await page.goto(url);
    await page.click('#backup-share');
    await page.waitForFunction(() => window.__shared);
    const shared = await page.evaluate(() => window.__shared);
    assert.match(shared.name, /\.json$/);
    assert.equal(JSON.parse(shared.text).app, 'bilingual-reader');
  },

  async 'share button is hidden when the browser cannot share files'({ page, url }) {
    await page.goto(url);
    await page.waitForSelector('#backup-download');
    assert.equal(await page.locator('#backup-share').count(), (await page.evaluate(() => !!navigator.canShare)) ? 1 : 0);
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
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      // Service Worker 経由の通信は page.route で差し替えられないので、オフラインのテスト以外では止める
      serviceWorkers: name.includes('offline') ? 'allow' : 'block',
    });
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

'use strict';

// 記録はすべてこの端末のブラウザ（localStorage）にだけ保存する。サーバーへは何も送らない。
const STORE_KEY = 'bilingual-reader:v1';
const TOKEN_RE = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;

const state = load();
const cache = new Map(); // fetch したテキスト
let selected = null; // 直前にタップした単語の <span>

navigator.storage?.persist?.(); // ブラウザの容量整理で消されにくくする
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// ---------------------------------------------------------------------------
// 保存
// ---------------------------------------------------------------------------

function load() {
  // read: 作品ごとに「今の読み返しで先頭から何語目まで読んだか」
  // finished: 「読了」ボタンを押した記録（同じ作品を何度読んでも 1 回ずつ数える）
  const empty = { read: {}, finished: [], vocab: [], showJa: true };
  try {
    const { progress, ...saved } = JSON.parse(localStorage.getItem(STORE_KEY)) ?? {}; // progress は旧形式
    return { ...empty, ...saved };
  } catch {
    return empty;
  }
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    alert('記録を保存できませんでした（ブラウザの保存領域が使えない状態です）');
  }
}

// ---------------------------------------------------------------------------
// テキスト
// ---------------------------------------------------------------------------

async function getJson(path) {
  if (!cache.has(path)) {
    cache.set(path, fetch(path).then((r) => {
      if (!r.ok) throw new Error(`${path}: ${r.status}`);
      return r.json();
    }));
  }
  return cache.get(path);
}

const getIndex = () => getJson('texts/index.json');
const getCommon = () => getJson('texts/common.json');
const getLemmas = () => getJson('texts/lemmas.json');
const getDict = () => getJson('texts/dict.json'); // 原形ごとの「よく使われる意味」と「イディオム」
const getWork = (id) => getJson(`texts/${encodeURIComponent(id)}.json`);

/** 単語の見出し形。小文字にし、所有格の 's は外す（Giant's → giant） */
function wordKey(word) {
  const k = word.toLowerCase().replace(/’/g, "'");
  return k.endsWith("'s") ? k.slice(0, -2) : k;
}

/** 原形（ran → run、children → child）。lemmas.json に無ければそのまま */
function lemmaOf(word, lemmas) {
  const k = wordKey(word);
  return lemmas[k] ?? k;
}

/** 作品の全単語（段落をまたいだ通し番号順） */
function tokensOf(work) {
  return work.paragraphs.flatMap((p) => p.en.match(TOKEN_RE) ?? []);
}

function meaningOf(word, para, common) {
  const exact = word.toLowerCase().replace(/’/g, "'");
  const base = wordKey(word);
  return para.g?.[exact] ?? para.g?.[base] ?? common[exact] ?? common[base] ?? null;
}

/** text の pos 文字目を含む 1 文と、その文の中での pos の位置を返す */
function sentenceAt(text, pos) {
  const re = /[.!?]+[”"’)]*(?=\s|$)/g;
  let start = 0;
  let end = text.length;
  for (let m; (m = re.exec(text));) {
    const e = m.index + m[0].length;
    if (pos < e) { end = e; break; }
    start = e;
  }
  const raw = text.slice(start, end);
  const lead = raw.length - raw.trimStart().length;
  return { text: raw.trim(), offset: pos - start - lead };
}

// ---------------------------------------------------------------------------
// 統計：全作品を合算する。記録は「読了の履歴」と「今どこまで読んだか」だけで、
// 単語数はそこから毎回計算する
//   総単語数 … 読了した作品の全単語（読み返した回数ぶん）＋ 読みかけの作品の既読部分
//   総語彙数 … それらに出てきた単語の原形の種類（何度出てきても 1 回）
// ---------------------------------------------------------------------------

async function computeStats() {
  const lemmas = await getLemmas();
  const known = new Set((await getIndex()).map((w) => w.id));
  let total = 0;
  const types = new Set();
  const count = async (id, upTo) => {
    if (!known.has(id) || !upTo) return; // 収録から外れた作品は数えない
    for (const w of tokensOf(await getWork(id)).slice(0, upTo)) {
      total++;
      types.add(lemmaOf(w, lemmas));
    }
  };
  for (const f of state.finished) await count(f.id, Infinity);
  for (const [id, read] of Object.entries(state.read)) await count(id, read);
  return { total, unique: types.size };
}

const finishedCount = (id) => state.finished.filter((f) => f.id === id).length;

// ---------------------------------------------------------------------------
// 画面
// ---------------------------------------------------------------------------

const main = document.getElementById('main');

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  el.append(...children.flat().filter((c) => c != null));
  return el;
}

let routeSeq = 0;

/** 画面を組み立てて表示する。読み込み中に別の画面へ移ったら、古い方は表示しない */
async function route() {
  const seq = ++routeSeq;
  closeSheet();
  const [, page, id] = location.hash.split('/');
  let view;
  try {
    if (page === 'read' && id) view = await readerView(decodeURIComponent(id));
    else if (page === 'vocab') view = vocabView();
    else view = await homeView();
  } catch (err) {
    view = { nodes: [h('p', { class: 'error' }, `読み込みに失敗しました：${err.message}`)] };
  }
  if (seq !== routeSeq) return;
  main.className = '';
  main.replaceChildren(...view.nodes);
  window.scrollTo(0, 0);
  view.after?.();
}

/** CEFR のレベルと日本語での目安 */
const LEVELS = {
  A1: '入門', A2: '初級', B1: '中級', B2: '中上級', C1: '上級', C2: '最上級',
};

function levelBadge(level) {
  return level ? h('span', { class: `level level-${level[0]}` }, level) : null;
}

async function homeView() {
  const [works, stats] = await Promise.all([getIndex(), computeStats()]);
  const items = await Promise.all(works.map(async (w) => {
    const total = tokensOf(await getWork(w.id)).length;
    const read = state.read[w.id] ?? 0;
    const done = finishedCount(w.id);
    const status = [
      done ? `読了 ${done} 回` : '',
      read ? `${done ? `${done + 1} 回目 ` : ''}${read.toLocaleString()} / ${total.toLocaleString()} 語` : '',
    ].filter(Boolean).join('・') || '未読';
    return h('li', { 'data-level': w.level ?? '' },
      h('a', { href: `#/read/${encodeURIComponent(w.id)}` },
        h('span', { class: 'title' }, w.title),
        h('span', { class: 'sub' }, `${w.titleJa} ／ ${w.author}`),
        h('span', { class: 'sub status' }, status)));
  }));
  // レベル順（A1 → C2）に見出しを付けて並べる
  const shelf = Object.entries(LEVELS).flatMap(([level, name]) => {
    const group = items.filter((li) => li.dataset.level === level);
    return group.length
      ? [h('h3', { class: 'level-head' }, levelBadge(level), ` ${name}`), h('ul', { class: 'works' }, group)]
      : [];
  });
  const others = items.filter((li) => !(li.dataset.level in LEVELS));
  if (others.length) shelf.push(h('ul', { class: 'works' }, others));
  return {
    nodes: [
      h('section', { class: 'stats' },
        stat('総単語数', stats.total, 'stat-total'),
        stat('総語彙数', stats.unique, 'stat-unique'),
        stat('単語帳', state.vocab.length, 'stat-vocab')),
      h('h2', {}, '本棚'),
      h('p', { class: 'sub' }, 'レベルは CEFR（ヨーロッパ言語共通参照枠）での目安です。'),
      ...shelf,
      backupSection(),
    ],
  };
}

function stat(label, value, id) {
  return h('div', { class: 'stat' }, h('b', { id }, value.toLocaleString()), h('span', {}, label));
}

async function readerView(id) {
  const [work, common, lemmas, dict] = await Promise.all([getWork(id), getCommon(), getLemmas(), getDict()]);
  const jaToggle = h('button', { type: 'button', class: 'toggle' });
  const setJa = () => {
    main.classList.toggle('hide-ja', !state.showJa);
    jaToggle.textContent = state.showJa ? '和訳を隠す' : '和訳を表示';
  };
  jaToggle.addEventListener('click', () => { state.showJa = !state.showJa; save(); setJa(); });

  let n = 0; // 作品全体での単語の通し番号
  const paras = work.paragraphs.map((p, i) => {
    const en = h('p', { class: 'en', lang: 'en' });
    let last = 0;
    for (const m of p.en.matchAll(TOKEN_RE)) {
      en.append(p.en.slice(last, m.index), h('span', { class: 'w', 'data-pos': m.index, 'data-n': n++ }, m[0]));
      last = m.index + m[0].length;
    }
    en.append(p.en.slice(last));
    en.addEventListener('click', (e) => {
      const span = e.target.closest('.w');
      if (span && !longPressed) onWord(span, p, work, common, lemmas, dict);
    });
    return h('section', { class: 'para', 'data-i': i },
      p.head ? h('h2', { class: 'lesson', lang: 'en' }, p.head) : null,
      en,
      h('p', { class: 'ja', lang: 'ja' }, p.ja));
  });
  const container = h('div', { class: 'paras' }, paras);
  const words = [...container.querySelectorAll('.w')];
  enableLongPress(container, (span) => {
    const before = state.read[id] ?? 0;
    setRead(id, words, Number(span.dataset.n) + 1);
    const text = state.read[id] === words.length
      ? '最後まで読みました。いちばん下の「読了」を押すと記録されます'
      : `ここまで読みました：${state.read[id].toLocaleString()}語`;
    showToast(text, () => setRead(id, words, before));
  });

  return {
    nodes: [
      h('div', { class: 'reader-head' },
        h('h1', { lang: 'en' }, levelBadge(work.level), ' ', work.title),
        h('p', { class: 'sub' }, `${work.titleJa} ／ ${work.author}（${work.year}）`),
        h('p', { class: 'sub' }, '単語をタップで意味、長押しで「ここまで読んだ」'),
        jaToggle),
      container,
      h('button', { type: 'button', class: 'finish', onclick: () => finishWork(id, work) }, '読了（最後まで読んだ）'),
      h('p', { class: 'source' }, `出典：${work.source}。和訳と語釈はこのアプリ用に作成したものです。`),
    ],
    after() {
      setJa();
      const read = state.read[id] ?? 0;
      updateRead(words, read);
      // 続きから読めるように、まだ読んでいない最初の単語の段落へ移動する
      if (read > 0 && read < words.length) words[read].closest('.para').scrollIntoView({ block: 'start' });
    },
  };
}

/** 先頭から count 語目までを既読にする（前の単語を長押しすれば戻せる） */
function setRead(id, words, count) {
  state.read[id] = count;
  save();
  updateRead(words, count);
}

/** 読了を記録して本棚へ戻る。次に開くと最初から読み返せる */
function finishWork(id, work) {
  const before = state.read[id] ?? 0;
  state.finished.push({ id, t: Date.now() });
  delete state.read[id];
  save();
  location.hash = '#/';
  showToast(`「${work.title}」の読了を記録しました（${tokensOf(work).length.toLocaleString()}語）`, () => {
    state.finished.pop();
    if (before) state.read[id] = before;
    save();
    route();
  });
}

function updateRead(words, count) {
  words.forEach((w, i) => {
    w.classList.toggle('read', i < count);
    w.classList.toggle('last', i === count - 1);
  });
}

// ---------------------------------------------------------------------------
// 長押し（指を約 0.5 秒離さない）。長押しの指を離したときのタップ扱いは無視する
// ---------------------------------------------------------------------------

const LONG_PRESS_MS = 500;
let longPressed = false; // 直前の操作が長押しだったか

function enableLongPress(container, onLongPress) {
  let timer = 0;
  let startX = 0;
  let startY = 0;
  const cancel = () => clearTimeout(timer);
  container.addEventListener('pointerdown', (e) => {
    const span = e.target.closest('.w');
    if (!span || (e.pointerType === 'mouse' && e.button !== 0)) return;
    longPressed = false;
    startX = e.clientX;
    startY = e.clientY;
    cancel();
    timer = setTimeout(() => {
      longPressed = true;
      navigator.vibrate?.(30);
      onLongPress(span);
    }, LONG_PRESS_MS);
  });
  container.addEventListener('pointermove', (e) => {
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 10) cancel(); // スクロール中は長押しにしない
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) container.addEventListener(type, cancel);
  container.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.w')) e.preventDefault(); // 長押しメニューを出さない
  });
}

// ---------------------------------------------------------------------------
// 画面下のお知らせ（取り消しボタン付き）
// ---------------------------------------------------------------------------

const toast = document.getElementById('toast');
let toastTimer = 0;

function showToast(text, onUndo) {
  closeSheet();
  clearTimeout(toastTimer);
  toast.replaceChildren(h('span', {}, text), h('button', {
    type: 'button',
    onclick: () => { onUndo(); hideToast(); },
  }, '取り消す'));
  toast.hidden = false;
  toastTimer = setTimeout(hideToast, 4000);
}

function hideToast() {
  toast.hidden = true;
}

// ---------------------------------------------------------------------------
// 単語のタップ：1 回目で意味、同じ単語をもう 1 回で単語帳に登録
// ---------------------------------------------------------------------------

const sheet = document.getElementById('sheet');
document.getElementById('sheet-close').addEventListener('click', closeSheet);
// 単語と下のパネル以外をタップしたら閉じる
document.addEventListener('click', (e) => {
  if (!sheet.hidden && !e.target.closest('.w, #sheet')) closeSheet();
});

function onWord(span, para, work, common, lemmas, dict) {
  const word = span.textContent;
  const lemma = lemmaOf(word, lemmas);
  const { text: sentence } = sentenceAt(para.en, Number(span.dataset.pos)); // 単語帳に一緒に保存する
  const meaning = meaningOf(word, para, common);

  if (selected === span) {
    addVocab({ w: wordKey(word), l: lemma, m: meaning ?? '', s: sentence, src: work.title });
    return;
  }
  selected?.classList.remove('sel');
  selected = span;
  span.classList.add('sel');

  document.getElementById('sheet-word').replaceChildren(
    word, lemma !== wordKey(word) ? h('small', {}, `原形 ${lemma}`) : null);
  document.getElementById('sheet-meaning').textContent = meaning ?? '（この単語の訳は未登録です）';
  const entry = dict[lemma] ?? dict[wordKey(word)] ?? {};
  document.getElementById('sheet-more').replaceChildren(
    entry.m?.length
      ? h('section', { id: 'sheet-common' }, h('h4', {}, 'よく使われる意味'),
        h('ul', {}, entry.m.map((m) => h('li', {}, m))))
      : null,
    entry.i?.length
      ? h('section', { id: 'sheet-idioms' }, h('h4', {}, 'イディオム・成句'),
        h('ul', {}, entry.i.map(([en, ja]) => h('li', {}, h('b', { lang: 'en' }, en), ` ${ja}`))))
      : null);
  setStatus(isSaved(wordKey(word), sentence) ? '登録済み' : 'もう一度タップで単語帳に登録');
  sheet.hidden = false;
}

function isSaved(w, s) {
  return state.vocab.some((v) => v.w === w && v.s === s);
}

function addVocab(entry) {
  if (!isSaved(entry.w, entry.s)) {
    state.vocab.push({ ...entry, t: Date.now() });
    save();
  }
  setStatus('✓ 単語帳に登録しました');
}

function setStatus(text) {
  document.getElementById('sheet-status').textContent = text;
}

function closeSheet() {
  sheet.hidden = true;
  selected?.classList.remove('sel');
  selected = null;
}

function vocabView() {
  const items = [...state.vocab].reverse().map((v) =>
    h('li', {},
      h('div', { class: 'vw' },
        h('b', { lang: 'en' }, v.w),
        v.l && v.l !== v.w ? h('small', { lang: 'en' }, `（${v.l}）`) : null,
        h('span', {}, v.m)),
      h('p', { class: 'vs', lang: 'en' }, v.s),
      h('button', {
        type: 'button', class: 'del', 'aria-label': `${v.w} を削除`,
        onclick: () => {
          if (!confirm(`「${v.w}」を単語帳から削除しますか？`)) return;
          state.vocab = state.vocab.filter((x) => x !== v);
          save();
          route();
        },
      }, '削除')));
  return {
    nodes: [
      h('h2', {}, `単語帳（${state.vocab.length}語）`),
      items.length
        ? h('ul', { class: 'vocab' }, items)
        : h('p', { class: 'sub' }, '本文の単語をタップして意味を表示し、もう一度タップすると登録できます。'),
    ],
  };
}

// ---------------------------------------------------------------------------
// バックアップ（書き出し：ファイルに保存／共有して送る、読み込み：ファイルから復元）
// ---------------------------------------------------------------------------

const BACKUP_APP = 'bilingual-reader';

function backupSection() {
  const input = h('input', { type: 'file', accept: '.json,.txt,application/json,text/plain', hidden: '' });
  input.addEventListener('change', () => {
    if (input.files[0]) importBackup(input.files[0]);
    input.value = '';
  });
  return h('section', { class: 'backup' },
    h('h2', {}, 'バックアップ'),
    h('p', { class: 'sub' }, '読書記録と単語帳をファイルに書き出して、機種変更や消えてしまったときに戻せます。'),
    h('div', { class: 'buttons' },
      h('button', { type: 'button', id: 'backup-download', onclick: () => downloadFile(backupFile('json')) },
        'ファイルに保存'),
      shareableBackup()
        ? h('button', { type: 'button', id: 'backup-share', onclick: () => shareFile(shareableBackup()) },
          '共有して送る')
        : null,
      h('button', { type: 'button', id: 'backup-import', onclick: () => input.click() }, '読み込み')),
    input);
}

function backupFile(ext) {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const body = JSON.stringify({ app: BACKUP_APP, version: 1, exportedAt: now.toISOString(), data: state }, null, 1);
  const type = ext === 'json' ? 'application/json' : 'text/plain';
  return new File([body], `bilingual-reader-backup-${local}.${ext}`, { type });
}

/** 共有できる形のバックアップ。端末によっては .json を共有できないので .txt も試す */
function shareableBackup() {
  if (!navigator.canShare) return null;
  return ['json', 'txt'].map(backupFile).find((f) => navigator.canShare({ files: [f] })) ?? null;
}

/** 端末の「ダウンロード」フォルダに保存する */
function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: file.name, hidden: '' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Android の共有画面を開く（Google ドライブ、Gmail など） */
async function shareFile(file) {
  try {
    await navigator.share({ files: [file], title: 'Bilingual Reader のバックアップ' });
  } catch (err) {
    if (err.name !== 'AbortError') alert(`共有できませんでした（${err.message}）`);
  }
}

async function importBackup(file) {
  let data;
  try {
    if (file.size > 5_000_000) throw new Error('ファイルが大きすぎます');
    data = parseBackup(await file.text());
  } catch (err) {
    alert(`読み込めませんでした：${err.message}`);
    return;
  }
  const ok = confirm(`今の記録を、バックアップの内容（単語帳 ${data.vocab.length} 語・読了 ${data.finished.length} 回）で置き換えます。よろしいですか？`);
  if (!ok) return;
  Object.assign(state, data);
  save();
  route();
}

/** バックアップの中身を検査し、必要な項目だけを取り出す（壊れた・別物のファイル対策） */
function parseBackup(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('ファイルの形式が正しくありません');
  }
  if (obj?.app !== BACKUP_APP || typeof obj.data !== 'object' || obj.data === null) {
    throw new Error('このアプリのバックアップファイルではありません');
  }
  const d = obj.data;
  const str = (v, max) => typeof v === 'string' && v.length <= max;
  const list = (v) => (Array.isArray(v) ? v : []);
  const read = {};
  for (const [id, n] of Object.entries(typeof d.read === 'object' && d.read ? d.read : {})) {
    if (str(id, 200) && id !== '__proto__' && Number.isInteger(n) && n > 0) read[id] = n;
  }
  return {
    read,
    finished: list(d.finished)
      .filter((f) => str(f?.id, 200) && Number.isFinite(f.t))
      .map((f) => ({ id: f.id, t: f.t })),
    vocab: list(d.vocab)
      .filter((v) => str(v?.w, 100) && str(v.m, 1000) && str(v.s, 5000))
      .map((v) => ({
        w: v.w,
        l: str(v.l, 100) ? v.l : v.w,
        m: v.m,
        s: v.s,
        src: str(v.src, 200) ? v.src : '',
        t: Number.isFinite(v.t) ? v.t : 0,
      })),
    showJa: d.showJa !== false,
  };
}

window.addEventListener('hashchange', route);
route();

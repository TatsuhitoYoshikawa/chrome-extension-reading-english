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
  // read: 作品ごとに「先頭から何語目まで読んだか」
  const empty = { read: {}, vocab: [], showJa: true };
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
// 統計：記録は「何語目まで読んだか」だけで、単語数はそこから毎回計算する
// ---------------------------------------------------------------------------

async function computeStats() {
  const lemmas = await getLemmas();
  let total = 0;
  const types = new Set();
  for (const { id } of await getIndex()) {
    const read = state.read[id] ?? 0;
    if (!read) continue;
    for (const w of tokensOf(await getWork(id)).slice(0, read)) {
      total++;
      types.add(lemmaOf(w, lemmas));
    }
  }
  return { total, unique: types.size };
}

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
  view.after?.();
}

async function homeView() {
  const [works, stats] = await Promise.all([getIndex(), computeStats()]);
  const list = await Promise.all(works.map(async (w) => {
    const total = tokensOf(await getWork(w.id)).length;
    const read = state.read[w.id] ?? 0;
    return h('li', {},
      h('a', { href: `#/read/${encodeURIComponent(w.id)}` },
        h('span', { class: 'title' }, w.title),
        h('span', { class: 'sub' }, `${w.titleJa} ／ ${w.author}`),
        h('span', { class: 'sub' }, read >= total ? '読了' : read ? `${read.toLocaleString()} / ${total.toLocaleString()} 語` : '未読')));
  }));
  return {
    nodes: [
      h('section', { class: 'stats' },
        stat('読んだ単語数', stats.total, 'stat-total'),
        stat('単語の種類', stats.unique, 'stat-unique'),
        stat('単語帳', state.vocab.length, 'stat-vocab')),
      h('h2', {}, '本棚'),
      h('ul', { class: 'works' }, list),
    ],
  };
}

function stat(label, value, id) {
  return h('div', { class: 'stat' }, h('b', { id }, value.toLocaleString()), h('span', {}, label));
}

async function readerView(id) {
  const [work, common, lemmas] = await Promise.all([getWork(id), getCommon(), getLemmas()]);
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
      if (span && !longPressed) onWord(span, p, work, common, lemmas);
    });
    return h('section', { class: 'para', 'data-i': i }, en, h('p', { class: 'ja', lang: 'ja' }, p.ja));
  });
  const container = h('div', { class: 'paras' }, paras);
  const words = [...container.querySelectorAll('.w')];
  enableLongPress(container, (span) => {
    const before = state.read[id] ?? 0;
    setRead(id, words, Number(span.dataset.n) + 1);
    showToast(`ここまで読みました：${state.read[id].toLocaleString()}語`, () => setRead(id, words, before));
  });

  return {
    nodes: [
      h('div', { class: 'reader-head' },
        h('h1', { lang: 'en' }, work.title),
        h('p', { class: 'sub' }, `${work.titleJa} ／ ${work.author}（${work.year}）`),
        h('p', { class: 'sub' }, '単語をタップで意味、長押しで「ここまで読んだ」'),
        jaToggle),
      container,
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

function onWord(span, para, work, common, lemmas) {
  const word = span.textContent;
  const lemma = lemmaOf(word, lemmas);
  const { text: sentence, offset } = sentenceAt(para.en, Number(span.dataset.pos));
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
  const sentEl = document.getElementById('sheet-sentence');
  sentEl.replaceChildren(
    sentence.slice(0, offset), h('mark', {}, word), sentence.slice(offset + word.length));
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

window.addEventListener('hashchange', route);
route();

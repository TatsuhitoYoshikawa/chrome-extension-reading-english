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
  const empty = { progress: {}, vocab: [], showJa: true };
  try {
    return { ...empty, ...JSON.parse(localStorage.getItem(STORE_KEY)) };
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
const getWork = (id) => getJson(`texts/${encodeURIComponent(id)}.json`);

/** 単語の見出し形。小文字にし、所有格の 's は外す（Giant's → giant） */
function wordKey(word) {
  const k = word.toLowerCase().replace(/’/g, "'");
  return k.endsWith("'s") ? k.slice(0, -2) : k;
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
// 統計：既読の段落から毎回計算する（記録は「どこまで読んだか」だけ）
// ---------------------------------------------------------------------------

async function computeStats() {
  let total = 0;
  const types = new Set();
  for (const { id } of await getIndex()) {
    const read = state.progress[id] ?? 0;
    if (!read) continue;
    const work = await getWork(id);
    for (const p of work.paragraphs.slice(0, read)) {
      for (const w of p.en.match(TOKEN_RE) ?? []) {
        total++;
        types.add(wordKey(w));
      }
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
    const total = (await getWork(w.id)).paragraphs.length;
    const read = state.progress[w.id] ?? 0;
    return h('li', {},
      h('a', { href: `#/read/${encodeURIComponent(w.id)}` },
        h('span', { class: 'title' }, w.title),
        h('span', { class: 'sub' }, `${w.titleJa} ／ ${w.author}`),
        h('span', { class: 'sub' }, read >= total ? '読了' : read ? `${read} / ${total} 段落` : '未読')));
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
  const [work, common] = await Promise.all([getWork(id), getCommon()]);
  const read = state.progress[id] ?? 0;
  const jaToggle = h('button', { type: 'button', class: 'toggle' });
  const setJa = () => {
    main.classList.toggle('hide-ja', !state.showJa);
    jaToggle.textContent = state.showJa ? '和訳を隠す' : '和訳を表示';
  };
  jaToggle.addEventListener('click', () => { state.showJa = !state.showJa; save(); setJa(); });

  const paras = work.paragraphs.map((p, i) => {
    const en = h('p', { class: 'en', lang: 'en' });
    let last = 0;
    for (const m of p.en.matchAll(TOKEN_RE)) {
      en.append(p.en.slice(last, m.index), h('span', { class: 'w', 'data-pos': m.index }, m[0]));
      last = m.index + m[0].length;
    }
    en.append(p.en.slice(last));
    en.addEventListener('click', (e) => {
      const span = e.target.closest('.w');
      if (span) onWord(span, p, work, common);
    });
    return h('section', { class: `para${i < read ? ' read' : ''}`, 'data-i': i },
      en,
      h('p', { class: 'ja', lang: 'ja' }, p.ja),
      h('button', { type: 'button', class: 'mark', onclick: () => onMark(id, i) }, ''));
  });

  return {
    nodes: [
      h('div', { class: 'reader-head' },
        h('h1', { lang: 'en' }, work.title),
        h('p', { class: 'sub' }, `${work.titleJa} ／ ${work.author}（${work.year}）`),
        jaToggle),
      h('div', { class: 'paras' }, paras),
      h('p', { class: 'source' }, `出典：${work.source}。和訳と語釈はこのアプリ用に作成したものです。`),
    ],
    after() {
      setJa();
      updateMarks(id);
      // 続きから読めるように、まだ読んでいない最初の段落へ移動する
      if (read > 0 && read < paras.length) paras[read].scrollIntoView({ block: 'start' });
    },
  };
}

/** その段落まで読んだことにする。最後に読んだ段落をもう一度押すと 1 つ戻す */
function onMark(id, i) {
  const read = state.progress[id] ?? 0;
  state.progress[id] = read === i + 1 ? i : i + 1;
  save();
  updateMarks(id);
}

function updateMarks(id) {
  const read = state.progress[id] ?? 0;
  for (const sec of main.querySelectorAll('.para')) {
    const i = Number(sec.dataset.i);
    sec.classList.toggle('read', i < read);
    sec.querySelector('.mark').textContent =
      i === read - 1 ? '✓ ここまで読んだ（押すと取り消し）' : i < read ? '✓ 既読' : 'ここまで読んだ';
  }
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

function onWord(span, para, work, common) {
  const word = span.textContent;
  const { text: sentence, offset } = sentenceAt(para.en, Number(span.dataset.pos));
  const meaning = meaningOf(word, para, common);

  if (selected === span) {
    addVocab({ w: wordKey(word), m: meaning ?? '', s: sentence, src: work.title });
    return;
  }
  selected?.classList.remove('sel');
  selected = span;
  span.classList.add('sel');

  document.getElementById('sheet-word').textContent = word;
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
      h('div', { class: 'vw' }, h('b', { lang: 'en' }, v.w), h('span', {}, v.m)),
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

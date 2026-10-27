// 表示中ページの日本語ブロックの直下に英訳を挿入する content script。
//
// background.js から chrome.scripting.executeScript で注入される。
// 初回注入でセットアップして英訳を表示し、2 回目以降の注入では表示/非表示を切り替える。
// 戻り値（最後に評価された値）は「英訳を表示中か」で、background.js がバッジ表示に使う。
//
// この content script は chrome.* API を一切使わない（翻訳バックエンドだけ差し替えれば
// 他の環境にも移植しやすくするため）。

(() => {
  'use strict';

  const GLOBAL_KEY = '__readingEnglishJaEn';
  if (globalThis[GLOBAL_KEY]) {
    return globalThis[GLOBAL_KEY].toggle();
  }

  // ---------------------------------------------------------------------------
  // 設定
  // ---------------------------------------------------------------------------

  const SOURCE_LANGUAGE = 'ja';
  const TARGET_LANGUAGE = 'en';

  /** 英訳を入れる要素のタグ名（カスタム要素名にしてページ側 CSS の影響を受けにくくする） */
  const TRANSLATION_TAG = 'rje-translation';
  const BANNER_TAG = 'rje-banner';

  /**
   * 「ブロック」とみなす要素。テキストノードは最も近いブロック祖先に属し、
   * ブロックごとに 1 つの英訳を付ける（入れ子のブロックは内側のものが優先される）。
   */
  const BLOCK_SELECTOR = [
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'li', 'dt', 'dd', 'blockquote', 'figcaption', 'caption', 'summary',
    'td', 'th', 'div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'figure', 'details',
  ].join(',');

  /** この要素の中身は翻訳しない */
  const SKIP_SELECTOR = [
    TRANSLATION_TAG, BANNER_TAG,
    'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed',
    'svg', 'math', 'canvas', 'video', 'audio',
    'textarea', 'input', 'select', 'option', 'button',
    'pre', 'code', 'kbd', 'samp',
    'rt', 'rp', // ルビ（読み仮名）は本文に混ぜない
    'nav', '[role="navigation"]',
    '[contenteditable]:not([contenteditable="false"])',
    '[translate="no"]', '.notranslate',
  ].join(',');

  /** ひらがな・カタカナ・漢字・半角カナ */
  const JAPANESE_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/;
  const JAPANESE_RE_G = new RegExp(JAPANESE_RE.source, 'g');
  /** 日本語文字がこれ未満のブロックは翻訳しない（「ホーム」等のノイズ削減は別途 SKIP で） */
  const MIN_JAPANESE_CHARS = 2;
  /** 1 回の translate() に渡す最大文字数。長い段落は文単位で分割する */
  const MAX_CHUNK_CHARS = 600;
  /** キャッシュする訳文の最大件数（ページ内メモリのみ。ディスクには保存しない） */
  const CACHE_LIMIT = 3000;
  /** DOM 変更をまとめて処理するまでの待ち時間 */
  const MUTATION_DEBOUNCE_MS = 200;
  /** Translator.availability() が応答しない環境（Chromium など）を検出するための待ち時間 */
  const AVAILABILITY_TIMEOUT_MS = 10000;

  // ---------------------------------------------------------------------------
  // 翻訳バックエンド（Chrome 組み込み Translator API）
  // ---------------------------------------------------------------------------

  const backend = {
    translator: null,

    /** @returns {Promise<'unsupported'|'unavailable'|'downloadable'|'downloading'|'available'>} */
    async availability() {
      if (typeof Translator === 'undefined') return 'unsupported';
      let timer = 0;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new DOMException('Translator.availability() did not respond', 'TimeoutError')),
          AVAILABILITY_TIMEOUT_MS);
      });
      try {
        return await Promise.race([
          Translator.availability({ sourceLanguage: SOURCE_LANGUAGE, targetLanguage: TARGET_LANGUAGE }),
          timeout,
        ]);
      } finally {
        clearTimeout(timer);
      }
    },

    /** @param {(ratio: number) => void} onProgress 0〜1 */
    async create(onProgress) {
      this.translator = await Translator.create({
        sourceLanguage: SOURCE_LANGUAGE,
        targetLanguage: TARGET_LANGUAGE,
        monitor(m) {
          m.addEventListener('downloadprogress', (e) => onProgress(e.loaded));
        },
      });
    },

    translate(text) {
      return this.translator.translate(text);
    },
  };

  // ---------------------------------------------------------------------------
  // 状態
  // ---------------------------------------------------------------------------

  let enabled = false;
  let started = false;
  let translatorReady = false;
  /** @type {Promise<boolean> | null} */
  let preparing = null;

  /** ブロック要素 → { source: 原文, node: 英訳要素 } */
  const blockStates = new WeakMap();
  /** 翻訳待ちのブロック（画面内に入ったもの） */
  const queue = new Set();
  let pumping = false;

  // ---------------------------------------------------------------------------
  // 公開インターフェース
  // ---------------------------------------------------------------------------

  function toggle() {
    enabled = !enabled;
    for (const node of document.querySelectorAll(TRANSLATION_TAG)) {
      node.hidden = !enabled;
    }
    if (enabled) {
      start();
    } else {
      banner.hide();
    }
    return enabled;
  }

  globalThis[GLOBAL_KEY] = Object.freeze({ toggle, isEnabled: () => enabled });

  // ---------------------------------------------------------------------------
  // 起動・翻訳モデルの準備
  // ---------------------------------------------------------------------------

  async function start() {
    if (!started) {
      started = true;
      mutationObserver.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
      if (document.body) scan(document.body);
    }
    if (await ensureTranslator()) pump();
  }

  async function ensureTranslator() {
    if (translatorReady) return true;
    if (!preparing) {
      preparing = prepareTranslator().finally(() => { preparing = null; });
    }
    return preparing;
  }

  async function prepareTranslator() {
    let availability;
    try {
      availability = await backend.availability();
    } catch (err) {
      // Permissions-Policy で translator が禁止されているページなど
      banner.show({ kind: 'error', text: `Translator API を使えません（${err.name}: ${err.message}）` });
      return false;
    }

    switch (availability) {
      case 'unsupported':
        banner.show({
          kind: 'error',
          text: 'このブラウザでは Translator API が使えません。デスクトップ版 Chrome 138 以降が必要です。',
        });
        return false;
      case 'unavailable':
        banner.show({ kind: 'error', text: '日本語→英語の翻訳モデルはこの環境では利用できません。' });
        return false;
      case 'available':
        return createTranslator({ showProgress: false });
      default:
        // 'downloadable' / 'downloading'：ダウンロード開始にはページ上でのユーザー操作が必要。
        // （ツールバーボタンのクリックはページのユーザー操作として扱われない）
        if (navigator.userActivation?.isActive) {
          return createTranslator({ showProgress: true });
        }
        banner.show({
          kind: 'info',
          text: '初回のみ、翻訳モデル（日本語→英語）のダウンロードが必要です。',
          action: {
            label: 'ダウンロードして翻訳',
            onClick: async () => {
              if (await createTranslator({ showProgress: true })) pump();
            },
          },
        });
        return false;
    }
  }

  async function createTranslator({ showProgress }) {
    if (showProgress) {
      banner.show({ kind: 'info', text: '翻訳モデルを準備しています…', progress: 0 });
    }
    try {
      await backend.create((ratio) => {
        if (!showProgress) return;
        banner.show(
          ratio >= 1
            ? { kind: 'info', text: '翻訳モデルを読み込んでいます…', progress: 1 }
            : { kind: 'info', text: `翻訳モデルをダウンロード中… ${Math.floor(ratio * 100)}%`, progress: ratio },
        );
      });
    } catch (err) {
      banner.show({ kind: 'error', text: `翻訳モデルの準備に失敗しました（${err.name}: ${err.message}）` });
      return false;
    }
    translatorReady = true;
    if (showProgress) {
      banner.show({ kind: 'done', text: '翻訳の準備ができました', autoHideMs: 2500 });
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // 日本語ブロックの検出
  // ---------------------------------------------------------------------------

  /** 画面内（とその少し先）に入ったブロックだけを翻訳キューに入れる */
  const intersectionObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      intersectionObserver.unobserve(entry.target);
      queue.add(entry.target);
    }
    pump();
  }, { rootMargin: '100% 0px 100% 0px' });

  function isSkipped(element) {
    return element === null || element.closest(SKIP_SELECTOR) !== null;
  }

  function ownerBlockOf(textNode) {
    const parent = textNode.parentElement;
    if (isSkipped(parent)) return null;
    return parent.closest(BLOCK_SELECTOR);
  }

  /** ブロックを（再）評価対象にする。画面内に入ったらキューに入る */
  function watchBlock(block) {
    intersectionObserver.unobserve(block);
    intersectionObserver.observe(block);
  }

  /** node 以下の日本語テキストを探し、それが属するブロックを監視対象にする */
  function scan(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (JAPANESE_RE.test(node.data)) {
        const block = ownerBlockOf(node);
        if (block) watchBlock(block);
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || isSkipped(node)) return;

    const blocks = new Set();
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === Node.ELEMENT_NODE) {
          return n.matches(SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        }
        return JAPANESE_RE.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const block = t.parentElement.closest(BLOCK_SELECTOR);
      if (block) blocks.add(block);
    }
    for (const block of blocks) watchBlock(block);
  }

  /**
   * ブロック「自身」のテキスト（入れ子のブロックやスキップ対象を除く）と、
   * 英訳を差し込む位置（最後のテキストを含む直下の子）を返す。
   */
  function collectOwnText(block) {
    const parts = [];
    let lastTextNode = null;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === Node.ELEMENT_NODE) {
          if (n.matches(SKIP_SELECTOR) || n.matches(BLOCK_SELECTOR)) return NodeFilter.FILTER_REJECT;
          return n.localName === 'br' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        parts.push('\n');
      } else {
        parts.push(n.data);
        if (n.data.trim()) lastTextNode = n;
      }
    }

    const text = normalize(parts.join(''));
    const japaneseChars = text.match(JAPANESE_RE_G)?.length ?? 0;
    if (!lastTextNode || japaneseChars < MIN_JAPANESE_CHARS) return { text: '', anchor: null };

    let anchor = lastTextNode;
    while (anchor.parentNode !== block) anchor = anchor.parentNode;
    return { text, anchor };
  }

  function normalize(text) {
    return text
      .replace(/[ \t\r\f\v 　]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  // ---------------------------------------------------------------------------
  // 動的に追加・変更される要素への対応
  // ---------------------------------------------------------------------------

  const pendingNodes = new Set();
  let mutationTimer = 0;

  function isOurs(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return el !== null && el.closest(`${TRANSLATION_TAG},${BANNER_TAG}`) !== null;
  }

  const mutationObserver = new MutationObserver((records) => {
    for (const r of records) {
      if (isOurs(r.target)) continue;
      if (r.type === 'characterData') {
        pendingNodes.add(r.target);
        continue;
      }
      for (const n of r.addedNodes) {
        if (!isOurs(n)) pendingNodes.add(n);
      }
      // テキストが取り除かれた → そのブロックの訳を更新する
      if ([...r.removedNodes].some((n) => !(n.nodeType === Node.ELEMENT_NODE && n.localName === TRANSLATION_TAG))) {
        const block = r.target.nodeType === Node.ELEMENT_NODE ? r.target.closest(BLOCK_SELECTOR) : null;
        if (block && blockStates.has(block)) pendingNodes.add(block);
      }
    }
    if (pendingNodes.size && !mutationTimer) {
      mutationTimer = setTimeout(flushMutations, MUTATION_DEBOUNCE_MS);
    }
  });

  function flushMutations() {
    mutationTimer = 0;
    const nodes = [...pendingNodes];
    pendingNodes.clear();
    for (const n of nodes) {
      if (!n.isConnected) continue;
      // 既に英訳済みのブロックは、日本語が消えていても訳を外せるよう必ず再評価する
      const owner = (n.nodeType === Node.ELEMENT_NODE ? n : n.parentElement)?.closest(BLOCK_SELECTOR);
      if (owner && blockStates.has(owner)) watchBlock(owner);
      scan(n);
    }
  }

  // ---------------------------------------------------------------------------
  // 翻訳と挿入
  // ---------------------------------------------------------------------------

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (enabled && translatorReady && queue.size) {
        const block = queue.values().next().value;
        queue.delete(block);
        await translateBlock(block);
      }
    } finally {
      pumping = false;
    }
  }

  async function translateBlock(block) {
    if (!block.isConnected) return;
    const state = blockStates.get(block);
    const { text, anchor } = collectOwnText(block);

    if (!text) {
      state?.node.remove();
      blockStates.delete(block);
      return;
    }

    let node = state?.node;
    if (!node || node.parentNode !== block) {
      node = document.createElement(TRANSLATION_TAG);
      node.setAttribute('lang', TARGET_LANGUAGE);
      node.setAttribute('translate', 'no'); // Chrome のページ翻訳で再翻訳されないように
    }
    if (anchor.nextSibling !== node) anchor.after(node);
    node.hidden = !enabled;

    if (state?.source === text && state.node === node) return;
    blockStates.set(block, { source: text, node });

    node.dataset.rjeState = 'pending';
    node.textContent = '…';

    let english;
    try {
      english = await translateText(text);
    } catch (err) {
      console.warn('[reading-english] translate failed:', err);
      english = null;
    }

    // 翻訳中に原文が変わっていたら、この結果は捨てる（新しい方が後でキューに入る）
    if (blockStates.get(block)?.source !== text) return;
    node.dataset.rjeState = english === null ? 'error' : 'done';
    node.textContent = english ?? '（翻訳できませんでした）';
    node.hidden = !enabled;
  }

  /** 行ごと、長い行は文ごとに分割して翻訳する（分割単位でキャッシュが効く） */
  async function translateText(text) {
    const lines = text.split('\n');
    const results = [];
    for (const line of lines) {
      if (!JAPANESE_RE.test(line)) {
        results.push(line);
        continue;
      }
      const chunks = splitIntoChunks(line);
      const translated = [];
      for (const chunk of chunks) translated.push(await translateCached(chunk));
      results.push(translated.join(' '));
    }
    return results.join('\n');
  }

  function splitIntoChunks(line) {
    if (line.length <= MAX_CHUNK_CHARS) return [line];
    const sentences = line.match(/[^。．！？!?]+[。．！？!?」』）)]*|[。．！？!?]+/g) ?? [line];
    const chunks = [];
    let current = '';
    for (const s of sentences) {
      if (current && current.length + s.length > MAX_CHUNK_CHARS) {
        chunks.push(current);
        current = '';
      }
      current += s;
      while (current.length > MAX_CHUNK_CHARS) {
        chunks.push(current.slice(0, MAX_CHUNK_CHARS));
        current = current.slice(MAX_CHUNK_CHARS);
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  // ---------------------------------------------------------------------------
  // キャッシュ（ページ内メモリの LRU。同じ文の同時リクエストも 1 回にまとめる）
  // ---------------------------------------------------------------------------

  const cache = new Map();
  const inflight = new Map();

  function translateCached(source) {
    if (cache.has(source)) {
      const value = cache.get(source);
      cache.delete(source);
      cache.set(source, value);
      return Promise.resolve(value);
    }
    let p = inflight.get(source);
    if (!p) {
      p = backend.translate(source)
        .then((value) => {
          cache.set(source, value);
          if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
          return value;
        })
        .finally(() => inflight.delete(source));
      inflight.set(source, p);
    }
    return p;
  }

  // ---------------------------------------------------------------------------
  // 進捗・エラー表示バナー（閉じた Shadow DOM でページと隔離）
  // ---------------------------------------------------------------------------

  const banner = (() => {
    let host = null;
    let els = null;
    let hideTimer = 0;

    const CSS = `
      .card {
        pointer-events: auto;
        box-sizing: border-box;
        max-width: 480px;
        margin: 0 auto;
        padding: 12px 14px;
        border-radius: 12px;
        background: #1e293b;
        color: #f8fafc;
        font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        box-shadow: 0 6px 24px rgba(0, 0, 0, .3);
      }
      .card.error { background: #7f1d1d; }
      .row { display: flex; align-items: flex-start; gap: 8px; }
      .text { flex: 1; overflow-wrap: anywhere; }
      .close {
        flex: none; width: 32px; height: 32px; margin: -6px -8px 0 0;
        border: 0; border-radius: 8px; background: transparent; color: inherit;
        font-size: 20px; line-height: 1; cursor: pointer;
      }
      .bar { height: 6px; margin-top: 8px; border-radius: 3px; background: rgba(255,255,255,.2); overflow: hidden; }
      .bar > div { height: 100%; width: 0; background: #60a5fa; transition: width .2s; }
      .action {
        display: block; width: 100%; min-height: 44px; margin-top: 10px;
        border: 0; border-radius: 8px; background: #3b82f6; color: #fff;
        font: 600 15px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; cursor: pointer;
      }
      [hidden] { display: none !important; }
    `;

    function ensure() {
      if (host?.isConnected) return;
      host = document.createElement(BANNER_TAG);
      const root = host.attachShadow({ mode: 'closed' });
      // <style> 要素はページの CSP に阻まれることがあるので Constructable Stylesheet を使う
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];

      const card = el('div', 'card');
      card.setAttribute('role', 'status');
      const row = el('div', 'row');
      const text = el('div', 'text');
      const close = el('button', 'close');
      close.type = 'button';
      close.textContent = '×';
      close.setAttribute('aria-label', '閉じる');
      close.addEventListener('click', hide);
      row.append(text, close);
      const bar = el('div', 'bar');
      const fill = el('div');
      bar.append(fill);
      const action = el('button', 'action');
      action.type = 'button';
      card.append(row, bar, action);
      root.append(card);

      els = { card, text, bar, fill, action };
      document.documentElement.append(host);
    }

    function el(tag, className) {
      const e = document.createElement(tag);
      if (className) e.className = className;
      return e;
    }

    /**
     * @param {{kind: 'info'|'error'|'done', text: string, progress?: number,
     *          action?: {label: string, onClick: () => void}, autoHideMs?: number}} opts
     */
    function show({ kind, text, progress, action, autoHideMs }) {
      if (!enabled) return;
      ensure();
      clearTimeout(hideTimer);
      host.hidden = false;
      els.card.className = `card ${kind}`;
      els.text.textContent = text;
      els.bar.hidden = progress === undefined;
      els.fill.style.width = `${Math.round((progress ?? 0) * 100)}%`;
      els.action.hidden = !action;
      els.action.onclick = null;
      if (action) {
        els.action.textContent = action.label;
        els.action.disabled = false;
        els.action.onclick = () => {
          els.action.disabled = true;
          action.onClick();
        };
      }
      if (autoHideMs) hideTimer = setTimeout(hide, autoHideMs);
    }

    function hide() {
      clearTimeout(hideTimer);
      if (host) host.hidden = true;
    }

    return { show, hide };
  })();

  return toggle();
})();

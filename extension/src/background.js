'use strict';

// ツールバーボタン（またはショートカット）が押されたら、そのタブに content script を注入する。
// 2 回目以降の注入では content script 側で「表示 ⇔ 非表示」を切り替える。
// activeTab 権限のみで動かすため、ボタンを押したタブ以外にはアクセスしない。

const CONTENT_SCRIPT = 'src/content.js';
const CONTENT_CSS = 'src/content.css';

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined) return;
  const target = { tabId: tab.id };

  try {
    const [probe] = await chrome.scripting.executeScript({
      target,
      func: () => Boolean(globalThis.__readingEnglishJaEn),
    });
    if (!probe?.result) {
      await chrome.scripting.insertCSS({ target, files: [CONTENT_CSS] });
    }
    const [res] = await chrome.scripting.executeScript({ target, files: [CONTENT_SCRIPT] });
    await setBadge(tab.id, res?.result === true ? 'EN' : '');
  } catch (err) {
    // chrome:// や Chrome ウェブストアなど、拡張機能が触れないページ
    console.warn('[reading-english] cannot run on this page:', err);
    await setBadge(tab.id, '×');
  }
});

// ページ遷移したら content script は消えるのでバッジも消す
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') setBadge(tabId, '');
});

async function setBadge(tabId, text) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: text === '×' ? '#b91c1c' : '#1d4ed8' });
    await chrome.action.setBadgeText({ tabId, text });
  } catch {
    // タブが既に閉じられている場合など
  }
}

# Reading English (ja→en)

日本語のサイトを読みながら英語を学ぶための、自分用の Chrome 拡張機能（Manifest V3）です。
ツールバーのボタンを押すと、表示中のページにある日本語の段落・見出しの直下に英訳を差し込みます。

- 翻訳には **Chrome 組み込みの Translator API（ja→en）** を使います。外部 API やサーバーには一切通信しません。
- もう一度ボタンを押すと英訳を非表示にし、さらに押すと再表示します。
- 初回だけ翻訳モデルのダウンロードが必要です。ダウンロード中は画面下に進捗バーを表示します。
- 日本語を含まない要素、`script` / `style` / 入力欄 / コード / ナビゲーションなどは翻訳しません。
- 無限スクロールなどで後から追加された要素や、書き換えられた文章にも追従します。
- 画面に近づいたブロックから順に翻訳します（長いページでも最初の表示が速い）。
- 同じ文章は 2 回翻訳せず、ページ内のメモリにキャッシュします。

> [!NOTE]
> この拡張機能は旧版です。現在はスマホ向けのウェブアプリ（リポジトリ直下の README を参照）に移行しています。

> [!WARNING]
> **スマホではこのままでは動きません。** 下の「[スマホでの利用について](#スマホでの利用について重要)」を先に読んでください。

---

## スマホでの利用について（重要）

主な用途はスマホとのことですが、2 つの制約があります。

1. **Android 版 Chrome は拡張機能に対応していません。** 2026 年 10 月時点でも、設定やフラグで有効にする方法はありません。iOS 版 Chrome も同じです。
2. **Translator API はデスクトップ版 Chrome 専用です。** Chrome の公式ドキュメントでは、Android・iOS はまだ対象外とされています。仮に拡張機能を動かせるブラウザがあっても、翻訳エンジンがありません。

つまり「Chrome 拡張機能 + Translator API」の構成は **PC の Chrome でのみ** 動きます。
スマホで、外部 API を使わずに同じことをするための代替構成の案は以下のとおりです。

| 案 | 構成 | 翻訳エンジン（端末内） | 手間 | コメント |
|---|---|---|---|---|
| A | このリポジトリをそのまま PC の Chrome で使う | Chrome Translator API | 小 | すぐに使える。スマホでは使えない |
| B | **iPhone：Safari Web Extension** にして、翻訳をネイティブ側に任せる | Apple の Translation フレームワーク | 中〜大 | Mac と Xcode が必要。自分の端末だけで使うなら App Store への公開は不要 |
| C | **Android：自作のブラウザアプリ**（WebView）に `content.js` を注入する | Google ML Kit の端末内翻訳 | 中〜大 | Android Studio が必要。APK を自分の端末に直接インストールする |
| D | Android 版 Edge の拡張機能 | なし（Translator API が使えるか不明） | — | Microsoft が選んだ拡張機能しか入れられず、自作は読み込めない。おすすめしない |

`extension/src/content.js` は chrome.* API を使わず、翻訳部分を `backend` オブジェクト（`availability` / `create` / `translate`）にまとめてあります。B・C 案では、この `backend` をネイティブ側の翻訳を呼ぶ実装に差し替えれば、要素の検出・挿入・キャッシュ・動的追加への対応はそのまま流用できます。

Vivaldi などの Android 向け Chromium 系ブラウザが Chrome ウェブストアの拡張機能に対応したという情報もありますが、確認できていません。対応していても Translator API が無ければこの拡張機能は動かないので（バナーに「Translator API が使えません」と表示されます）、試す場合はその前提でお願いします。

どの端末（iPhone / Android）で使うかを教えてもらえれば、B か C の構成で作り直します。

---

## Translator API を content script から使えるか（調査結果）

**結論：使えます。** この拡張機能は content script から直接 Translator API を呼んでいます。

- Translator API は Chrome 138 からデスクトップ版で正式に使えます（Window に公開された Web API）。
- content script が動く ISOLATED world からも `Translator` が見えることを、実際の Chromium（153）に拡張機能を読み込んで確認しました（`test/extension-smoke.cjs`）。ページ側（MAIN world）から拡張機能の内部状態は見えません。

ただし、次の点に注意が必要です。この拡張機能ではそれぞれに対処しています。

| 注意点 | 対処 |
|---|---|
| モデルの**ダウンロード開始**（`availability()` が `downloadable` / `downloading` のときの `Translator.create()`）には、ページ上での**ユーザー操作**が必要。ツールバーボタンのクリックはページ上の操作として扱われない | 画面下のバナーに「ダウンロードして翻訳」ボタンを出し、そのタップを起点に `create()` する。ダウンロード済み（`available`）なら操作は不要で、すぐに翻訳を始める |
| ダウンロードの進捗は `monitor` の `downloadprogress` イベントで受け取る（`e.loaded` は 0〜1） | バナーに % と進捗バーを表示する。100% になった後は「読み込んでいます…」と表示する |
| ページの `Permissions-Policy` で `translator` が禁止されていると使えない | エラー内容をバナーに表示する |
| Translator API が無い環境では `Translator` 自体が未定義。Chromium（Chrome ブランドでないもの）では `Translator` は定義されているが `availability()` が応答しない | 未定義なら「使えません」と表示する。`availability()` は 10 秒でタイムアウトにする |
| 他のオリジンの iframe 内では既定で使えない | トップレベルのフレームだけに注入する（iframe 内は翻訳しない） |

もし今後の Chrome で content script から使えなくなった場合の代替構成は次の 2 つです。

1. **Offscreen Document** で `Translator` を持ち、content script ⇔ service worker ⇔ offscreen を `chrome.runtime` のメッセージでつなぐ。ダウンロード時のユーザー操作は、拡張機能のポップアップやオプションページで取る（モデルはブラウザ全体で共有される）。
2. **サイドパネル**（`chrome.sidePanel`）で翻訳を実行する。サイドパネル内のボタンでユーザー操作も取れる。

いずれの場合も `content.js` の `backend` をメッセージ送信に置き換えるだけで済みます。

---

## ファイル構成

```
extension/                ← Chrome に読み込むのはこのフォルダだけ
  manifest.json
  src/background.js       ボタンが押されたらタブに CSS と content script を注入し、バッジを更新する
  src/content.js          日本語ブロックの検出、翻訳、英訳の挿入、表示切り替え、進捗バナー
  src/content.css         英訳ブロックとバナー外枠のスタイル
  icons/
test/
  run.cjs                 content script の自動テスト（Translator API はモック）
  extension-smoke.cjs     拡張機能を実際の Chromium に読み込むテスト
  fixture.html            テスト用ページ（手動確認にも使える）
  mock-translator.js      テスト用 Translator API モック
```

---

## 読み込み手順（PC の Chrome）

前提：**デスクトップ版 Chrome 138 以降**（Windows / macOS / Linux / ChromeOS）。

1. このリポジトリをクローンするか、ZIP をダウンロードして展開します。
2. Chrome で `chrome://extensions` を開きます。
3. 右上の **デベロッパーモード** をオンにします。
4. **パッケージ化されていない拡張機能を読み込む** を押し、このリポジトリの **`extension` フォルダ** を選びます（リポジトリのルートではありません）。
5. ツールバーのパズルアイコンから「Reading English (ja→en)」をピン留めすると押しやすくなります。

コードを変更したら、`chrome://extensions` でこの拡張機能の再読み込みボタン（↻）を押し、対象のページも再読み込みしてください。

ショートカット：`Alt+Shift+E`（`chrome://extensions/shortcuts` で変更できます）。

---

## 動作確認方法

### 手動で確認する

1. 日本語のニュース記事やブログを開きます。
2. ツールバーの **EN** ボタンを押します。
3. **初回のみ**：画面下に「翻訳モデル（日本語→英語）のダウンロードが必要です」と表示されます。**「ダウンロードして翻訳」** を押すと、進捗（%）とバーが表示されます。完了すると「翻訳の準備ができました」と表示され、少しして消えます。
4. 段落や見出しの直下に、青い帯の付いた小さめの英訳が表示されることを確認します。ボタンには **EN** のバッジが付きます。
5. もう一度ボタンを押すと英訳が消え、バッジも消えます。さらに押すと再表示されます。
6. 下にスクロールすると、画面に近づいた段落から順に英訳が付くことを確認します。無限スクロールのサイト（SNS やまとめサイトなど）では、新しく読み込まれた投稿にも英訳が付きます。
7. 検索欄やコメント欄などの入力欄、コードブロック、ナビゲーションメニューには英訳が付かないことを確認します。
8. 2 回目以降は（別のサイトでも）ダウンロードの案内は出ず、すぐに翻訳が始まります。

テスト用ページで確認する場合は `chrome://extensions` でこの拡張機能の「詳細」から **ファイルの URL へのアクセスを許可する** をオンにし、`test/fixture.html` を開いてボタンを押してください。

うまく動かないとき：

- バナーに「Translator API が使えません」→ Chrome のバージョンを `chrome://version` で確認してください（138 以降が必要）。Chromium や一部の派生ブラウザでは使えません。
- ボタンを押すとバッジが **×** になる → `chrome://` のページや Chrome ウェブストアなど、拡張機能が動けないページです。
- 詳しいログは、対象ページの DevTools のコンソール（content script のエラー）と、`chrome://extensions` の「Service Worker」リンク（background.js のエラー）で確認できます。

### 自動テスト

Node.js 18 以降で次を実行します。

```sh
npm install
npx playwright install chromium
npm run test:extension   # content script のテスト（モック）と、実際の Chromium に読み込むテスト
```

このテストでは、日本語ブロックへの挿入、スキップ対象、入れ子のブロック、表示切り替え、キャッシュ、動的な追加・書き換え、画面外の遅延翻訳、初回ダウンロード時のボタンと進捗表示、API が無い場合のエラー表示を確認します。
本物の翻訳モデルは Chrome 本体にしか入っていないため、実際の訳文は手動で確認してください。

---

## セキュリティ上の配慮

- **権限は最小限**：`activeTab` と `scripting` だけです。`host_permissions` や `<all_urls>` は要求しないので、ボタンを押したタブにだけ、押したときにだけアクセスします。閲覧履歴やタブの URL は読みません。
- **外部通信なし**：翻訳はブラウザ内の Translator API だけで行います。リモートのスクリプトも読み込みません。拡張機能ページの CSP は `script-src 'self'; object-src 'none'` です。
- **ページの内容を保存しない**：翻訳キャッシュはそのタブのメモリ上だけにあり、ページを閉じれば消えます。`chrome.storage` やディスクには書きません。
- **XSS 対策**：英訳やメッセージは `textContent` で挿入し、`innerHTML` は使いません。
- **ページからの隔離**：content script は ISOLATED world で動くので、ページ側の JavaScript からは内部状態や関数を触れません。バナーは閉じた Shadow DOM の中に作るので、ページ側から中身を操作できません。スタイルは Constructable Stylesheet で当てるので、ページの CSP に左右されません。
- **入力欄に触れない**：`input` / `textarea` / `contenteditable` の中は読みも書きもしないので、入力中の文章が翻訳に渡ることはありません。

---

## 既知の制限と調整ポイント

調整したい値は `extension/src/content.js` の先頭「設定」にまとめてあります。

- `BLOCK_SELECTOR`：英訳を付ける単位。`div` や `section` も含むので、`div` の中に直接書かれた文章にも英訳が付きます。
- `SKIP_SELECTOR`：翻訳しない要素。メニューやボタンの英訳が邪魔なら、ここにセレクタを足してください。
- `MIN_JAPANESE_CHARS`：日本語がこの文字数未満のブロックは翻訳しません（既定は 2）。
- `MAX_CHUNK_CHARS`：長い段落はこの文字数ごとに文単位で分けて翻訳します。
- iframe の中は翻訳しません。
- React などのフレームワークで作られたページでは、英訳を差し込んだことで表示が崩れることがまれにあります。その場合はボタンで非表示にしてください。
- ページを移動するとオフに戻ります（ボタンを押したページでだけ動く設計のため）。

---

## 参考

- [Translation with built-in AI（Chrome for Developers）](https://developer.chrome.com/docs/ai/translator-api)
- [Client-side translation with AI（Chrome for Developers）](https://developer.chrome.com/docs/ai/translate-on-device)
- [Translator and Language Detector APIs（MDN）](https://developer.mozilla.org/en-US/docs/Web/API/Translator_and_Language_Detector_APIs)
- [How to Get Chrome Extensions on Android in 2026](https://www.itechguides.com/how-to-get-chrome-extensions-on-android-what-works-in-2026/)
- [Microsoft Edge for Android の拡張機能対応（9to5Google）](https://9to5google.com/2025/03/14/microsoft-edge-has-an-extension-store/)

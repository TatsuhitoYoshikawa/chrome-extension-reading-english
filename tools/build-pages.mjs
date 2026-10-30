// 検索エンジン・AI 検索向けの静的ページを web/ に書き出す。
//
//   node tools/build-pages.mjs          … 書き出す
//   node tools/build-pages.mjs --check  … 書き出し済みの内容が最新か確認する（テスト用）
//
// 作品データ（web/texts/）やサイト設定（tools/site.json）を変えたら実行してコミットする。
// 書き出すもの：
//   web/works/<作品ID>/index.html  作品ごとの全文（原文と日本語訳）ページ
//   web/index.html の <!-- seo:... --> の間  トップページの説明・メタ情報・構造化データ
//   web/sitemap.xml, web/robots.txt, web/llms.txt

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/site.json'), 'utf8'));
const SITE = site.url.replace(/\/$/, '');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
const TOKEN_RE = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;
const LEVELS = { A1: '入門', A2: '初級', B1: '中級', B2: '中上級', C1: '上級', C2: '最上級' };

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(WEB, rel), 'utf8'));
const index = readJson('texts/index.json');
const works = index.map((w) => readJson(`texts/${w.id}.json`));

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// JSON-LD を <script> に入れても閉じタグ等で壊れないようにする
const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
const wordCount = (work) => work.paragraphs.reduce((n, p) => n + (p.en.match(TOKEN_RE)?.length ?? 0), 0);
const about = (n) => `約${(Math.round(n / 10) * 10).toLocaleString('en-US')}語`;
const workUrl = (id) => `${SITE}/works/${id}/`;
const gutenberg = (work) => {
  const m = work.source.match(/#(\d+)/);
  return m ? `https://www.gutenberg.org/ebooks/${m[1]}` : undefined;
};

function head({ title, description, url, type = 'website' }) {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#1d4ed8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="${type}">
<meta property="og:site_name" content="${esc(site.name)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${SITE}/icon-512.png">
<meta property="og:locale" content="ja_JP">
<meta name="twitter:card" content="summary">`;
}

// ---------------------------------------------------------------------------
// 作品ページ
// ---------------------------------------------------------------------------

function workPage(work) {
  const level = `CEFR ${work.level}（${LEVELS[work.level]}）`;
  const words = wordCount(work);
  const title = `${work.titleJa}（${work.title}）英日対訳・全文｜${level}の英語多読｜${site.name}`;
  const description = `${work.author}「${work.title}」（${work.year}年）の英語原文と日本語訳を段落ごとに並べた全文（${about(words)}）。`
    + `英語レベルの目安は${level}。アプリで読むと、単語をタップしてその文での意味・発音・イディオムを確認できます。無料・登録不要。`;
  const url = workUrl(work.id);
  const others = index.filter((w) => w.id !== work.id);
  const data = [
    {
      '@context': 'https://schema.org',
      '@type': 'LearningResource',
      name: `${work.title}（${work.titleJa}）英日対訳`,
      alternateName: [work.title, work.titleJa],
      description,
      url,
      inLanguage: ['en', 'ja'],
      educationalLevel: `CEFR ${work.level}`,
      learningResourceType: '対訳テキスト（英語原文と日本語訳）',
      teaches: '英語の読解・語彙',
      audience: { '@type': 'EducationalAudience', educationalRole: 'student', audienceType: '英語を学ぶ日本語話者' },
      isAccessibleForFree: true,
      wordCount: words,
      author: { '@type': 'Person', name: work.author },
      isBasedOn: {
        '@type': 'CreativeWork',
        name: work.title,
        author: { '@type': 'Person', name: work.author },
        datePublished: String(work.year),
        url: gutenberg(work),
        license: 'https://creativecommons.org/publicdomain/mark/1.0/',
      },
      isPartOf: { '@type': 'WebSite', name: site.name, url: `${SITE}/` },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: site.name, item: `${SITE}/` },
        { '@type': 'ListItem', position: 2, name: `${work.titleJa}（${work.title}）`, item: url },
      ],
    },
  ];
  const paras = work.paragraphs.map((p) => `<section class="para">
${p.head ? `<h2 class="lesson" lang="en">${esc(p.head)}</h2>\n` : ''}<p class="en" lang="en">${esc(p.en)}</p>
<p class="ja">${esc(p.ja)}</p>
</section>`).join('\n');

  return `<!doctype html>
<html lang="ja">
<head>
${head({ title, description, url, type: 'article' })}
<link rel="icon" href="/icon-192.png">
<link rel="stylesheet" href="/style.css">
${data.map(ld).join('\n')}
</head>
<body class="static">
<header class="bar">
  <a href="/" class="brand">${esc(site.name)}</a>
  <nav><a href="/#/">本棚</a><a href="/#/vocab">単語帳</a></nav>
</header>
<main>
<nav class="crumbs" aria-label="パンくずリスト"><a href="/">${esc(site.name)}</a> › ${esc(work.level)} ${esc(LEVELS[work.level])} › ${esc(work.titleJa)}</nav>
<article>
<h1><span class="level level-${work.level[0]}">${work.level}</span> <span lang="en">${esc(work.title)}</span></h1>
<p class="sub">${esc(work.titleJa)} ／ ${esc(work.author)}（${work.year}年）／ ${about(words)} ／ 英語レベルの目安：${esc(level)}</p>
<p>${esc(work.author)}の「${esc(work.title)}」（${esc(work.titleJa)}）を、英語の原文と日本語訳を段落ごとに並べて全文掲載しています。英語の原文はパブリックドメイン（著作権切れ）のテキストで、日本語訳はこのサイトのために新しく作成したものです。</p>
<p><a class="cta" href="/#/read/${esc(work.id)}">アプリで読む（単語をタップして意味・発音・イディオムを確認、読んだ単語数を記録）</a></p>
<div class="paras">
${paras}
</div>
<p class="source">出典：${esc(work.source)}（パブリックドメイン）。日本語訳はこのサイトのために作成したものです。</p>
</article>
<section>
<h2>ほかのレベルの作品</h2>
<ul class="works">
${others.map((w) => `<li><a href="/works/${esc(w.id)}/"><span class="title"><span class="level level-${w.level[0]}">${w.level}</span> ${esc(w.title)}</span><span class="sub">${esc(w.titleJa)} ／ ${esc(w.author)}</span></a></li>`).join('\n')}
</ul>
</section>
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// トップページ（index.html の目印の間を書き換える。JavaScript が動くとアプリの画面に置き換わる）
// ---------------------------------------------------------------------------

const FAQ = [
  ['無料で使えますか？', 'はい。無料で、会員登録やログインも不要です。ブラウザで開くだけで使えます。'],
  ['どんな文章が読めますか？', `著作権の切れた英語の名作です。CEFR の A1（入門）から C2（最上級）まで、レベル別に${index.length}作品を収録しています。`],
  ['単語の意味はどう調べますか？', '本文の単語をタップすると、その文での意味、ほかによく使われる意味、イディオム、発音記号とカタカナの発音（アクセントの位置つき）が表示されます。'],
  ['読んだ記録はどこに保存されますか？', '読んだ単語数・語彙数・単語帳は、使っている端末のブラウザの中だけに保存されます。サーバーには送信しません。ファイルに書き出してバックアップできます。'],
  ['スマホで使えますか？', 'はい。スマホのブラウザで開き、ホーム画面に追加するとアプリのように使えます。一度開けばオフラインでも読めます。'],
];

function homeHead() {
  const title = `${site.name}｜英語の名作を日英対訳で読む無料の英語多読アプリ（CEFR A1〜C2）`;
  const data = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: site.name,
      url: `${SITE}/`,
      description: site.description,
      applicationCategory: 'EducationalApplication',
      operatingSystem: 'Web ブラウザ（スマホ・PC）',
      inLanguage: 'ja',
      isAccessibleForFree: true,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'JPY' },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: 'CEFR レベル別の英日対訳作品',
      itemListElement: index.map((w, i) => ({
        '@type': 'ListItem', position: i + 1, name: `${w.title}（${w.titleJa}）CEFR ${w.level}`, url: workUrl(w.id),
      })),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
    },
  ];
  return `${head({ title, description: site.description, url: `${SITE}/` })}
${data.map(ld).join('\n')}`;
}

function homeMain() {
  return `<section class="intro">
<h1>英語の名作を、原文と日本語訳で読む</h1>
<p>${esc(site.name)} は、著作権の切れた英語の名作を、英語の原文と日本語訳を段落ごとに並べて読める、無料・登録不要の英語多読アプリです。</p>
<ul>
<li>CEFR の A1（入門）から C2（最上級）まで、レベル別に作品を収録</li>
<li>単語をタップすると、その文での意味・よく使われる意味・イディオム・発音記号とカタカナの発音（アクセントつき）を表示</li>
<li>単語を長押しして「ここまで読んだ」を記録し、読んだ単語数（延べ）と語彙数（異なり語数）を自動で集計</li>
<li>単語帳、読書記録のバックアップ、オフライン表示に対応。記録は端末の中だけに保存</li>
</ul>
<div class="intro-works">
<h2>レベル別の作品（英日対訳の全文）</h2>
<ul class="works">
${index.map((w) => `<li><a href="/works/${esc(w.id)}/"><span class="title"><span class="level level-${w.level[0]}">${w.level}</span> ${esc(w.title)}</span><span class="sub">${esc(w.titleJa)} ／ ${esc(w.author)} ／ ${about(wordCount(works.find((x) => x.id === w.id)))}</span></a></li>`).join('\n')}
</ul>
</div>
<h2>よくある質問</h2>
<dl class="faq">
${FAQ.map(([q, a]) => `<dt>${esc(q)}</dt><dd>${esc(a)}</dd>`).join('\n')}
</dl>
</section>`;
}

function replaceBetween(html, name, content) {
  const re = new RegExp(`(<!-- seo:${name}:start -->)[\\s\\S]*?(<!-- seo:${name}:end -->)`);
  if (!re.test(html)) throw new Error(`marker seo:${name} not found in index.html`);
  return html.replace(re, `$1\n${content}\n$2`);
}

// ---------------------------------------------------------------------------
// sitemap.xml / robots.txt / llms.txt
// ---------------------------------------------------------------------------

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE}/</loc></url>
${index.map((w) => `  <url><loc>${workUrl(w.id)}</loc></url>`).join('\n')}
</urlset>
`;

// AI 検索（ChatGPT・Claude・Perplexity・Gemini など）のクローラーも含め、すべて許可する
const robots = `User-agent: *
Allow: /

Sitemap: ${SITE}/sitemap.xml
`;

// https://llmstxt.org/ の形式。AI がサイトの内容を把握しやすいよう要点とページをまとめる
const llms = `# ${site.name}

> ${site.description}

- 対象：英語を学ぶ日本語話者（初級〜上級）
- 内容：パブリックドメインの英語の名作の全文と、その日本語訳（段落ごとの対訳）
- レベル：CEFR A1〜C2 の目安で分類
- 機能：単語タップで文脈上の意味・よく使われる意味・イディオム・発音（発音記号とカタカナ、アクセント位置）を表示、読んだ単語数と語彙数の記録、単語帳、バックアップ、オフライン対応
- 料金：無料、会員登録不要。読書記録は利用者の端末内にのみ保存

## 作品（英日対訳の全文）

${index.map((w) => {
  const work = works.find((x) => x.id === w.id);
  return `- [${w.title}（${w.titleJa}）](${workUrl(w.id)}): ${w.author}, ${work.year}年。CEFR ${w.level}（${LEVELS[w.level]}）、${about(wordCount(work))}`;
}).join('\n')}

## アプリ

- [Bilingual Reader アプリ](${SITE}/): 作品を選んで読む。単語のタップで意味と発音、長押しで読んだ位置を記録
`;

// ---------------------------------------------------------------------------

const outputs = new Map();
for (const work of works) outputs.set(`works/${work.id}/index.html`, workPage(work));
let indexHtml = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
indexHtml = replaceBetween(indexHtml, 'head', homeHead());
indexHtml = replaceBetween(indexHtml, 'main', homeMain());
outputs.set('index.html', indexHtml);
outputs.set('sitemap.xml', sitemap);
outputs.set('robots.txt', robots);
outputs.set('llms.txt', llms);

const check = process.argv.includes('--check');
const stale = [];
for (const [rel, content] of outputs) {
  const file = path.join(WEB, rel);
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (current === content) continue;
  if (check) stale.push(rel);
  else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    console.log(`wrote web/${rel}`);
  }
}
// 収録から外れた作品のページを消す
const worksDir = path.join(WEB, 'works');
for (const dir of fs.existsSync(worksDir) ? fs.readdirSync(worksDir) : []) {
  if (index.some((w) => w.id === dir)) continue;
  if (check) stale.push(`works/${dir}/ (removed work)`);
  else fs.rmSync(path.join(worksDir, dir), { recursive: true });
}
if (check && stale.length) {
  console.error(`out of date (run: node tools/build-pages.mjs): ${stale.join(', ')}`);
  process.exit(1);
}

#!/usr/bin/env node
// Writes the search and answer-engine block into the <head> of every public page: title, description, canonical,
// Open Graph, Twitter card and JSON-LD (organisation, website, software, FAQ, article, dataset). Questions are read
// from the page itself, so the structured data always matches what a visitor sees. A page may also have parts of its
// body written here (`body`), so crawlers that do not run JavaScript read what a visitor sees.
//   node scripts/seo.mjs          rewrite the pages
//   node scripts/seo.mjs --check  exit 1 if a page is out of date (run by the tests)
import { readFileSync, writeFileSync } from 'node:fs';

const SITE = 'https://onehuman.ai';
await import('../web/permissions-core.js'); // sets globalThis.OneHumanPermissions: the generator's rules and HTML
const PERMS = globalThis.OneHumanPermissions;
const pkg = JSON.parse(readFileSync(new URL('../packages/onehumanai/package.json', import.meta.url), 'utf8'));
const IMAGE = `${SITE}/og.png`;
const SAME_AS = ['https://github.com/OneHumanAI/onehuman', 'https://discord.gg/9QX9jTwBq', 'https://github.com/OneHumanAI', 'https://www.npmjs.com/package/onehumanai'];

const PAGES = [
  {
    file: 'index.html', path: '/',
    title: 'OneHuman · Access control for your customers\' AI agents',
    ogTitle: 'Your customers log in with AI agents. Decide what they may see and do.',
    description: 'Access control for the AI agents your customers log in with, for B2B SaaS, fintech and banks. It hides private fields from them, holds risky actions for the owner\'s passkey, and signs every decision on your own server.',
    faq: '<section class="faq"',
    extra: () => [{
      '@type': 'SoftwareApplication', '@id': `${SITE}/#software`, name: 'OneHuman', url: `${SITE}/`,
      applicationCategory: 'SecurityApplication', applicationSubCategory: 'Customer AI agent access control for web apps',
      operatingSystem: 'Node.js 22.13 or newer', softwareVersion: pkg.version, image: IMAGE,
      description: 'Middleware and browser SDK for Node.js. When a user\'s AI agent logs into your app, it hides private data, holds risky actions for a real person, and keeps signed proof of who approved what.',
      featureList: ['Spots AI browser agents (Claude in Chrome, ChatGPT agent, OpenAI Codex, Perplexity Comet, Playwright, Puppeteer) in a logged-in account', 'A rule for each action: allow it, hide private fields, or ask the person first', 'Hides private data on screen the moment an agent joins',
        'Signed proof of every decision, checkable offline', 'Only the account owner\'s passkey approves an action an agent asked for', 'Runs on your own server; one command: npx onehumanai init'],
      downloadUrl: 'https://www.npmjs.com/package/onehumanai', installUrl: 'https://www.npmjs.com/package/onehumanai',
      license: 'https://github.com/OneHumanAI/onehuman/blob/main/LICENSE',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      publisher: { '@id': `${SITE}/#org` },
      sameAs: SAME_AS,
    }],
  },
  {
    file: 'how-it-works.html', path: '/product',
    title: 'How OneHuman works · what happens when a user\'s AI agent logs into your app',
    description: 'How OneHuman spots an AI agent in a logged-in account, tells a hand from a program, applies your rule for each action and keeps signed proof of who approved what.',
    faq: '<section class="faq" id="more-questions">', type: 'WebPage', crumb: 'Product',
  },
  {
    file: 'compare.html', path: '/compare',
    title: 'How OneHuman compares · AI agent control for web apps',
    description: 'OneHuman next to ten companies working on AI agents, bots and identity, measured on what decides who controls a customer\'s logged-in account. From public documentation, September 2026.',
    type: 'WebPage', crumb: 'Compare',
  },
  {
    file: 'pricing.html', path: '/pricing',
    title: 'Pricing · pay only when AI agents show up · OneHuman',
    description: 'OneHuman runs on your own servers and protects every request on every plan. Free up to 100 agent-active customers a month, then $0.50 each or $299 a month for 1,000. Enterprise by annual contract.',
    faq: '<section class="faq"', type: 'WebPage', crumb: 'Pricing',
  },
  {
    file: 'permissions-generator.html', path: '/ai-agent-permissions-generator',
    title: 'AI Agent Permissions Generator · free, no signup · OneHuman',
    ogTitle: 'Decide what your customers\' AI agents may see and do. Free permissions generator.',
    description: 'Free AI agent permissions generator. Pick what your app holds, get allow, mask, ask-owner or block rules per action and a ready policy file. No signup.',
    faq: '<section class="faq"', type: 'WebPage', crumb: 'AI agent permissions generator',
    // the default result, so the tool is not empty before its script runs
    body: (html) => fill(html, { ...PERMS.render(PERMS.initial()), ...PERMS.statics() }),
    extra: (p) => [{
      '@type': 'WebApplication', '@id': `${SITE}${p.path}#app`, name: 'AI Agent Permissions Generator', url: SITE + p.path,
      applicationCategory: 'SecurityApplication', operatingSystem: 'Any (runs in the browser)', browserRequirements: 'Requires JavaScript', image: IMAGE,
      description: 'Generates permissions for the AI agents your customers bring into your web app: one answer (allow, mask, ask the owner, block) per action and situation, as plain-English rules, a OneHuman policy file and a prompt for a coding agent.',
      featureList: ['Presets for B2B SaaS, banks and fintech, insurance, health, HR and stores', 'Agent-friendly, balanced and lockdown defaults', 'Editable answer per action and situation', 'Plain-English rules, onehuman.policy.json and a coding agent prompt', 'Runs in the browser; nothing is sent'],
      isAccessibleForFree: true, offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      publisher: { '@id': `${SITE}/#org` },
    }, {
      '@type': 'HowTo', '@id': `${SITE}${p.path}#howto`, name: 'Generate AI agent permissions for your app', totalTime: 'PT1M',
      step: [['Pick your product', 'Choose the kind of product, which preselects what a signed-in customer can see or do.'],
        ['Check the resources', 'Tick what your app holds and add your own.'],
        ['Choose how open to agents', 'Agent-friendly, balanced or lockdown, then watch first or protect now.'],
        ['Copy the rules', 'Copy the plain-English rules, the policy JSON or the coding agent prompt.']]
        .map(([name, text], i) => ({ '@type': 'HowToStep', position: i + 1, name, text, url: `${SITE}${p.path}#generator` })),
    }],
  },
  {
    file: 'docs.html', path: '/docs',
    title: 'OneHuman docs · Protect endpoints from AI browser agents in Node.js',
    description: 'Install OneHuman with npx onehumanai init, write a policy per endpoint (allow, mask, step up, block), and verify it. Concepts, API reference and the protocol for AI coding agents.',
    faq: '<section id="faq">', type: 'TechArticle', crumb: 'Docs',
  },
  {
    file: 'scorecard.html', path: '/scorecard',
    title: 'AI agent scorecard · Claude, Codex, Playwright against a protected page · OneHuman',
    description: 'What happens when today\u2019s AI browser agents (Claude in Chrome, Claude desktop, OpenAI Codex, Playwright, Puppeteer, human-like cursor bots) open a signed-in page protected by OneHuman. Every result, including what gets through.',
    type: 'Article', crumb: 'Agent scorecard',
  },
  {
    file: 'measurements.html', path: '/measurements',
    title: 'How we measured · human and AI agent clicks · OneHuman',
    description: 'How every number on onehuman.ai was measured: 397 human clicks from 22 browsers and devices, 824 AI agent clicks, how the data was collected, how it was evaluated and where the method fails.',
    type: 'Article', crumb: 'How we measured',
    extra: (p) => [{
      '@type': 'Dataset', name: 'OneHuman human and AI agent click measurements', url: SITE + p.path,
      description: 'Pointer and click measurements used to evaluate OneHuman: 397 human clicks from 22 browser and device installations and 824 AI agent clicks (224 from real agent products, 600 generated human-like cursor paths), collected in September 2026. Summary statistics only; raw data is not published.',
      creator: { '@id': `${SITE}/#org` }, temporalCoverage: '2026-09',
      measurementTechnique: 'Grouped five-fold cross-validation by device; per-click evaluation plus 15 full sessions replayed through the engine',
      isAccessibleForFree: true,
    }],
  },
  {
    file: 'report.html', path: '/report',
    title: 'Free 30-day AI agent report · see which AI agents use your app · OneHuman',
    ogTitle: 'See which AI agents use your app as your customers. Free for 30 days.',
    description: 'Connect OneHuman in about 10 minutes. It watches your app for 30 days in watch-only mode and blocks nothing, then reports which AI agents logged in as your customers, what they touched and what would have been protected.',
    faq: '<section class="faq"', type: 'WebPage', crumb: 'Free AI agent report',
  },
  {
    file: 'trust.html', path: '/trust',
    title: 'Trust and privacy · what OneHuman stores and never collects',
    description: 'What OneHuman keeps on your server, what leaves it only when you add an API key, and what is never collected. Sub-processors, retention and offline proof verification, written for security and legal reviewers.',
    faq: 'Questions a reviewer asks', type: 'WebPage', crumb: 'Trust and privacy',
  },
  {
    file: 'cookies.html', path: '/cookies',
    title: 'Cookie Policy · OneHuman',
    description: 'The cookies and browser storage onehuman.ai uses, why, and for how long. Essential cookies only by default; embedded videos only with your consent.',
    type: 'WebPage', crumb: 'Cookie Policy',
  },
];

/** Replace what sits between <!-- pg:id --> and <!-- /pg:id --> for every id in `parts`. */
function fill(html, parts) {
  for (const [id, part] of Object.entries(parts)) {
    const re = new RegExp(`(<!-- pg:${id} -->)[\\s\\S]*?(<!-- /pg:${id} -->)`);
    if (!re.test(html)) throw new Error(`marker not found: pg:${id}`);
    html = html.replace(re, (_, a, b) => a + part + b);
  }
  return html;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

/** Question/answer pairs from the section that starts at `marker`: <details><summary>/<p> or <dt>/<dd>. */
function questions(html, marker) {
  const at = html.indexOf(marker); if (at < 0) throw new Error(`FAQ marker not found: ${marker}`);
  const end = html.indexOf('</section>', at) > 0 && marker.startsWith('<section') ? html.indexOf('</section>', at) : html.indexOf('</dl>', at);
  const part = html.slice(at, end);
  const out = [];
  for (const m of part.matchAll(/<summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p>/g)) out.push([m[1], m[2]]);
  for (const m of part.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)) out.push([m[1], m[2]]);
  if (!out.length) throw new Error(`no questions after ${marker}`);
  return out.map(([q, a]) => ({ '@type': 'Question', name: text(q), acceptedAnswer: { '@type': 'Answer', text: text(a) } }));
}

function block(p, html) {
  const url = SITE + p.path;
  const graph = [
    { '@type': 'Organization', '@id': `${SITE}/#org`, name: 'OneHuman', url: `${SITE}/`, logo: `${SITE}/apple-touch-icon.png`, sameAs: SAME_AS, email: 'arif@onehuman.ai' },
    { '@type': 'WebSite', '@id': `${SITE}/#website`, name: 'OneHuman', url: `${SITE}/`, publisher: { '@id': `${SITE}/#org` }, inLanguage: 'en' },
  ];
  if (p.type) graph.push({ '@type': p.type, '@id': `${url}#page`, headline: p.title, name: p.title, description: p.description, url, image: IMAGE, inLanguage: 'en', isPartOf: { '@id': `${SITE}/#website` }, publisher: { '@id': `${SITE}/#org` }, ...(p.type !== 'WebPage' ? { author: { '@id': `${SITE}/#org` } } : {}), about: { '@id': `${SITE}/#software` } });
  if (p.crumb) graph.push({ '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'OneHuman', item: `${SITE}/` }, { '@type': 'ListItem', position: 2, name: p.crumb, item: url }] });
  if (p.extra) graph.push(...p.extra(p));
  if (p.faq) graph.push({ '@type': 'FAQPage', '@id': `${url}#faq`, url, mainEntity: questions(html, p.faq) });
  const og = p.og ?? p.description;
  return [
    '<!-- seo:start (generated by scripts/seo.mjs) -->',
    `<title>${esc(p.title)}</title>`,
    `<meta name="description" content="${esc(p.description)}">`,
    `<link rel="canonical" href="${url}">`,
    '<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">',
    '<meta name="theme-color" content="#0a0a0b">',
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="OneHuman">',
    `<meta property="og:title" content="${esc(p.ogTitle ?? p.title)}">`,
    `<meta property="og:description" content="${esc(og)}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${IMAGE}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta property="og:image:alt" content="OneHuman: prove who approved what.">',
    '<meta property="og:locale" content="en_US">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${esc(p.ogTitle ?? p.title)}">`,
    `<meta name="twitter:description" content="${esc(og)}">`,
    `<meta name="twitter:image" content="${IMAGE}">`,
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    '<link rel="manifest" href="/site.webmanifest">',
    '<link rel="alternate" type="text/plain" title="LLM summary" href="/llms.txt">',
    `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c')}</script>`,
    '<!-- seo:end -->',
  ].join('\n');
}

// Tags the block owns; any copy of them outside the block is removed so a page never has two.
const OWNED = [/<title>[\s\S]*?<\/title>\n?/g, /<meta name="description"[^>]*>\n?/g, /<link rel="canonical"[^>]*>\n?/g, /<meta name="robots"[^>]*>\n?/g, /<meta name="theme-color"[^>]*>\n?/g,
  /<meta property="og:[^"]+"[^>]*>\n?/g, /<meta name="twitter:[^"]+"[^>]*>\n?/g, /<link rel="apple-touch-icon"[^>]*>\n?/g, /<link rel="manifest"[^>]*>\n?/g, /<link rel="alternate" type="text\/plain"[^>]*>\n?/g];

const check = process.argv.includes('--check');
let stale = 0;
for (const p of PAGES) {
  const file = new URL(`../web/${p.file}`, import.meta.url);
  const before = readFileSync(file, 'utf8');
  let html = before.replace(/<!-- seo:start[\s\S]*?<!-- seo:end -->\n?/, '');
  if (p.body) html = p.body(html);
  for (const re of OWNED) html = html.replace(re, '');
  html = html.replace(/(<meta name="viewport"[^>]*>\n)/, `$1${block(p, html)}\n`);
  if (html === before) continue;
  stale++;
  if (check) console.error(`out of date: web/${p.file} (run node scripts/seo.mjs)`);
  else { writeFileSync(file, html); console.log(`updated web/${p.file}`); }
}
if (check && stale) process.exit(1);

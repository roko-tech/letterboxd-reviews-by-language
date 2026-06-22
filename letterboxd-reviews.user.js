// ==UserScript==
// @name         Letterboxd Review Collector
// @namespace    https://github.com/roko-tech/letterboxd-reviews-by-language
// @version      2.8.3
// @description  Adds a button to a film page that collects every review in the language you choose across all pages into one panel — sortable, with right-to-left support for Arabic/Hebrew. Uses Chrome's on-device Language Detector API with a script/stopword fallback.
// @author       roko-tech
// @homepageURL  https://github.com/roko-tech/letterboxd-reviews-by-language
// @supportURL   https://github.com/roko-tech/letterboxd-reviews-by-language/issues
// @downloadURL  https://raw.githubusercontent.com/roko-tech/letterboxd-reviews-by-language/main/letterboxd-reviews.user.js
// @updateURL    https://raw.githubusercontent.com/roko-tech/letterboxd-reviews-by-language/main/letterboxd-reviews.user.js
// @match        https://letterboxd.com/*
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // Built-in AI globals live in the page's MAIN world; under @grant this script
  // runs in an isolated world, so reach them via the manager's unsafeWindow.
  const PageWin = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const MIN_CONFIDENCE = 0.5; // detections below this fall back to script matching
  const MIN_ALPHA = 3;        // fewer real letters than this → can't detect a language

  /* ------------------------------------------------------------------ *
   * Allowed languages
   * ------------------------------------------------------------------ */
  let languages = GM_getValue('languages', ['en']); // BCP-47 base codes; set via the menu
  const normLang = code => String(code || '').trim().toLowerCase().split(/[-_]/)[0];

  const NONLATIN = {
    ar: 'arabic', fa: 'arabic', ur: 'arabic', ps: 'arabic', ckb: 'arabic',
    he: 'hebrew', iw: 'hebrew', yi: 'hebrew',
    ru: 'cyrillic', uk: 'cyrillic', bg: 'cyrillic', sr: 'cyrillic', mk: 'cyrillic', be: 'cyrillic', kk: 'cyrillic',
    el: 'greek', th: 'thai',
    hi: 'devanagari', mr: 'devanagari', ne: 'devanagari',
    ko: 'hangul', zh: 'han', ja: 'japanese'
  };
  const scriptForLang = code => NONLATIN[normLang(code)] || 'latin';

  let allowedSet, allowedScripts;
  function rebuildAllowed() {
    allowedSet = new Set(languages.map(normLang));
    allowedScripts = new Set(languages.map(scriptForLang));
    if (allowedSet.has('ja')) allowedScripts.add('han'); // Japanese mixes kana + Han (kanji)
  }
  rebuildAllowed();

  /* ------------------------------------------------------------------ *
   * Writing-system detection
   * ------------------------------------------------------------------ */
  const SCRIPT_RES = {
    arabic: /\p{Script=Arabic}/gu,
    hebrew: /\p{Script=Hebrew}/gu,
    cyrillic: /\p{Script=Cyrillic}/gu,
    greek: /\p{Script=Greek}/gu,
    thai: /\p{Script=Thai}/gu,
    devanagari: /\p{Script=Devanagari}/gu,
    hangul: /\p{Script=Hangul}/gu,
    han: /\p{Script=Han}/gu,
    latin: /\p{Script=Latin}/gu
  };
  function scriptOf(text) {
    if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text)) return 'japanese';
    let best = 'none', bestN = 0;
    for (const name in SCRIPT_RES) {
      const n = (text.match(SCRIPT_RES[name]) || []).length;
      if (n > bestN) { bestN = n; best = name; }
    }
    return bestN > 0 ? best : 'none';
  }

  /* ------------------------------------------------------------------ *
   * Language detection: Chrome's built-in API, with a fallback
   * ------------------------------------------------------------------ */
  let detector = null, detectorReady = false, detectorPending = null, detectorDeferred = false;

  async function ensureDetector(viaUserGesture) {
    if (detectorReady) return detector;
    if (detectorDeferred && !viaUserGesture) return null;
    if (detectorPending) return detectorPending;

    const LD = PageWin.LanguageDetector;
    if (!LD) { detectorReady = true; return null; }

    detectorPending = (async () => {
      try {
        const status = await LD.availability();
        if (status === 'unavailable') { detectorReady = true; return null; }
        if (status !== 'available' && !viaUserGesture) {
          detectorPending = null;
          detectorDeferred = true;
          if (!ensureDetector._menu) {
            ensureDetector._menu = true;
            GM_registerMenuCommand('⬇️ Download accurate language model', () => ensureDetector(true));
          }
          return null;
        }
        detector = await LD.create();
        detectorReady = true;
        return detector;
      } catch (err) {
        console.warn('[LLC] LanguageDetector unavailable, using fallback:', err);
        detectorReady = true;
        return null;
      }
    })();
    return detectorPending;
  }

  async function detect(text) {
    const det = await ensureDetector(false);
    if (det) {
      try {
        const res = await det.detect(text);
        if (res && res.length) {
          return { lang: normLang(res[0].detectedLanguage), confidence: res[0].confidence };
        }
      } catch (err) {
        console.warn('[LLC] detect() failed, using fallback:', err);
      }
    }
    return fallbackDetect(text);
  }

  // Limit concurrent on-device detect() calls during a crawl.
  const MAX_CONCURRENT = 4;
  let active = 0;
  const queue = [];
  function pump() {
    while (active < MAX_CONCURRENT && queue.length) {
      active++;
      const { text, resolve } = queue.shift();
      detect(text).then(
        r => { active--; resolve(r); pump(); },
        () => { active--; resolve({ lang: 'und', confidence: 0 }); pump(); }
      );
    }
  }
  function detectQueued(text) {
    return new Promise(resolve => { queue.push({ text, resolve }); pump(); });
  }

  const SCRIPT_LANG = {
    japanese: 'ja', hangul: 'ko', han: 'zh', arabic: 'ar',
    hebrew: 'he', cyrillic: 'ru', greek: 'el', thai: 'th', devanagari: 'hi'
  };
  const STOPWORDS = {
    en: ['the','and','that','this','with','have','was','but','you','for','not','are','its','what'],
    es: ['que','los','las','una','con','por','para','como','pero','más','muy','está','este','porque'],
    fr: ['les','des','une','que','pas','dans','est','pour','qui','avec','plus','mais','cette','tout'],
    de: ['und','der','die','das','ist','nicht','ein','eine','auch','aber','sich','mit','wie','sehr'],
    it: ['che','non','per','una','con','sono','come','più','anche','questo','perché','molto','della'],
    pt: ['que','não','uma','com','para','mais','como','mas','muito','isso','este','porque','também'],
    nl: ['het','een','niet','dat','van','met','maar','ook','deze','zijn','heel','omdat','voor']
  };
  function fallbackDetect(text) {
    const script = scriptOf(text);
    if (script !== 'latin' && SCRIPT_LANG[script]) {
      return { lang: SCRIPT_LANG[script], confidence: 0.9 };
    }
    const words = text.toLowerCase().match(/[a-zà-ÿ]+/g) || [];
    if (words.length < 5) return { lang: 'und', confidence: 0 };
    let topLang = 'und', topHits = 0;
    for (const lang in STOPWORDS) {
      const set = new Set(STOPWORDS[lang]);
      let hits = 0;
      for (const w of words) if (set.has(w)) hits++;
      if (hits > topHits) { topHits = hits; topLang = lang; }
    }
    if (topHits === 0) return { lang: 'und', confidence: 0 };
    return { lang: topLang, confidence: Math.min(0.85, 0.45 + topHits / words.length) };
  }

  // Confident detection → match by language; otherwise → match by writing system.
  function isMatch(lang, confidence, script) {
    if (lang && lang !== 'und' && confidence >= MIN_CONFIDENCE) return allowedSet.has(lang);
    return allowedScripts.has(script);
  }

  /* ------------------------------------------------------------------ *
   * Collect matching reviews across all pages → one panel
   * ------------------------------------------------------------------ */
  function filmSlug() {
    const m = location.pathname.match(/\/film\/([^/]+)/);
    return m ? m[1] : null;
  }

  let panel = null;
  function openPanel() {
    if (panel) panel.remove();
    panel = document.createElement('div');
    panel.id = 'llc-panel';
    panel.innerHTML =
      '<div id="llc-panel-bar">' +
        '<span id="llc-panel-title">Reviews</span>' +
        '<select id="llc-sort" title="Sort reviews">' +
          '<option value="default">Letterboxd order</option>' +
          '<option value="date-desc">Most recent</option>' +
          '<option value="date-asc">Oldest first</option>' +
          '<option value="rating-desc">Highest rated</option>' +
          '<option value="rating-asc">Lowest rated</option>' +
          '<option value="len-desc">Longest</option>' +
          '<option value="len-asc">Shortest</option>' +
        '</select>' +
        '<span id="llc-panel-status"></span>' +
        '<button id="llc-panel-stop">Stop</button>' +
        '<button id="llc-panel-close">✕ Close</button>' +
      '</div><div id="llc-panel-list"></div>';
    document.body.appendChild(panel);
    const list = panel.querySelector('#llc-panel-list');
    // RTL reading when collecting an RTL language (Arabic/Hebrew) — scoped to the
    // review text so the header (name/date/rating) stays LTR and dates don't reorder.
    if (allowedScripts.has('arabic') || allowedScripts.has('hebrew')) list.classList.add('llc-rtl');
    return {
      status: panel.querySelector('#llc-panel-status'),
      list,
      stop: panel.querySelector('#llc-panel-stop'),
      close: panel.querySelector('#llc-panel-close'),
      sort: panel.querySelector('#llc-sort')
    };
  }

  let collectBtn = null;
  function updateCollectBtn() {
    if (collectBtn) collectBtn.textContent = '📚 Collect reviews';
  }
  function ensureCollectBtn() {
    if (collectBtn || !filmSlug()) return;
    collectBtn = document.createElement('div');
    collectBtn.id = 'llc-collect';
    collectBtn.title = 'Collect all matching reviews across every page';
    collectBtn.addEventListener('click', collectAllReviews);
    document.body.appendChild(collectBtn);
    updateCollectBtn();
  }

  const FETCH_CONCURRENCY = 5; // review pages fetched per wave
  const HARD_CAP = 1000;       // runaway backstop (~12k reviews)

  async function fetchReviewPage(slug, p) {
    try {
      const url = `/film/${slug}/reviews/by/activity/${p > 1 ? `page/${p}/` : ''}`;
      const res = await fetch(url, { credentials: 'same-origin' });
      if ([403, 429, 503].includes(res.status)) return { ok: false, rateLimited: true }; // told to slow down / blocked
      if (!res.ok) return { ok: false }; // 404 etc. → genuinely past the last page
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      return {
        ok: true,
        articles: [...doc.querySelectorAll('article.production-viewing')],
        hasNext: !!doc.querySelector('.paginate-nextprev .next, a.next')
      };
    } catch (e) { return { ok: false }; }
  }

  // Judge one review. Fast-rejects (no model call) when the writing system
  // can't be an allowed language — the big speedup for non-Latin filters.
  async function judgeArticle(art) {
    const body = art.querySelector('.js-review-body, .js-spoiler-container');
    if (!body) return null;
    const text = (body.textContent || '').replace(/\s+/g, ' ').trim();
    const script = scriptOf(text);
    if (!allowedScripts.has(script)) return null;
    let lang = 'und', confidence = 0;
    if (text.replace(/[^\p{L}]/gu, '').length >= MIN_ALPHA) {
      ({ lang, confidence } = await detectQueued(text));
    }
    if (!isMatch(lang, confidence, script)) return null;
    // Stash sort metadata (carried onto the clone by importNode).
    // Rating is an SVG with aria-label like "★★★★½" (½ = half star) → score 0–10 (stars × 2).
    const rsvg = art.querySelector('.inline-rating [aria-label], .inline-rating svg');
    const label = rsvg ? (rsvg.getAttribute('aria-label') || rsvg.textContent || '')
                       : (art.querySelector('.inline-rating')?.textContent || '');
    const stars = (label.match(/★/g) || []).length;
    art.dataset.llcRating = String(stars * 2 + (/½/.test(label) ? 1 : 0));  // 0 = unrated
    art.dataset.llcLen = String(text.length);
    // Review date from <time datetime="YYYY-MM-DD"> → digits, for chronological sort.
    const t = art.querySelector('time[datetime]');
    art.dataset.llcDate = String(parseInt((t?.getAttribute('datetime') || '').replace(/\D/g, '').slice(0, 14) || '0', 10));
    return art;
  }

  function sortPanel(list, key) {
    const num = (a, k) => parseInt(a.dataset[k] || '0', 10);
    const tie = (a, b) => num(a, 'llcIdx') - num(b, 'llcIdx'); // stable fallback = collection order
    const cmp = {
      'default':     (a, b) => tie(a, b), // Letterboxd's own order (collection order)
      'date-desc':   (a, b) => num(b, 'llcDate') - num(a, 'llcDate') || tie(a, b),
      'date-asc':    (a, b) => num(a, 'llcDate') - num(b, 'llcDate') || tie(a, b),
      'rating-desc': (a, b) => num(b, 'llcRating') - num(a, 'llcRating') || tie(a, b),
      'rating-asc':  (a, b) => num(a, 'llcRating') - num(b, 'llcRating') || tie(a, b),
      'len-desc':    (a, b) => num(b, 'llcLen') - num(a, 'llcLen') || tie(a, b),
      'len-asc':     (a, b) => num(a, 'llcLen') - num(b, 'llcLen') || tie(a, b)
    }[key];
    if (!cmp) return;
    [...list.querySelectorAll('article.production-viewing')].sort(cmp).forEach(a => list.appendChild(a));
  }

  let collecting = false;
  async function collectAllReviews() {
    if (collecting) return;
    const slug = filmSlug();
    if (!slug) { alert('Open a film page on Letterboxd first.'); return; }

    collecting = true;
    if (collectBtn) collectBtn.textContent = '📚 Collecting…';
    const ui = openPanel();
    let stopped = false, found = 0, scanned = 0, rateLimited = false;
    ui.stop.addEventListener('click', () => { stopped = true; });
    ui.close.addEventListener('click', () => { stopped = true; if (panel) { panel.remove(); panel = null; } });
    ui.sort.addEventListener('change', () => sortPanel(ui.list, ui.sort.value));

    try {
      let next = 1, done = false;
      while (!done && !stopped && next <= HARD_CAP) {
        const wave = [];
        for (let i = 0; i < FETCH_CONCURRENCY && next + i <= HARD_CAP; i++) wave.push(next + i);
        const fetched = await Promise.all(wave.map(p => fetchReviewPage(slug, p)));

        for (const pg of fetched) {
          if (stopped) { done = true; break; }
          if (pg.rateLimited) { rateLimited = true; done = true; break; } // back off — Letterboxd asked us to slow down
          if (!pg.ok || !pg.articles.length) { done = true; break; } // past the last page
          scanned++;
          const judged = await Promise.all(pg.articles.map(judgeArticle));
          for (const art of judged) {
            if (!art) continue;
            const clone = document.importNode(art, true);
            clone.dataset.llcIdx = String(found++);
            ui.list.appendChild(clone);
          }
          // No auto-sorting while collecting — reviews stay in Letterboxd order
          // as they stream in, so reading isn't disrupted. Sorting happens only
          // when the user picks an option (the 'change' listener above).
          if (panel) ui.status.textContent = `Scanned ${scanned} page${scanned === 1 ? '' : 's'} … ${found} found`;
          if (!pg.hasNext) { done = true; break; } // last page reached
        }
        next += FETCH_CONCURRENCY;
        if (!done && !stopped) await sleep(120); // brief breather between waves
      }
    } finally {
      collecting = false;
      updateCollectBtn();
    }
    if (panel) {
      ui.stop.style.display = 'none';
      ui.status.textContent = rateLimited
        ? `⚠️ Letterboxd rate-limited the crawl — collected ${found} so far (scanned ${scanned} pages, likely incomplete). Wait a minute and run it again.`
        : `${stopped ? 'Stopped' : 'Done'} — ${found} review${found === 1 ? '' : 's'} (scanned ${scanned} page${scanned === 1 ? '' : 's'}).`;
      if (!found) ui.list.innerHTML = '<p style="color:#9ab;padding:24px">No matching reviews found.</p>';
    }
  }

  /* ------------------------------------------------------------------ *
   * Menu commands
   * ------------------------------------------------------------------ */
  function registerMenu() {
    GM_registerMenuCommand('🌐 Set languages…', () => {
      const input = prompt(
        'Collect ONLY these languages (comma-separated BCP-47 codes).\n' +
        'Examples: en  |  ar  |  ja  |  en, fr',
        languages.join(', ')
      );
      if (input == null) return;
      const langs = input.split(',').map(normLang).filter(Boolean);
      if (!langs.length) return;
      languages = langs;
      GM_setValue('languages', langs);
      rebuildAllowed();
      updateCollectBtn();
    });
    GM_registerMenuCommand('📚 Collect reviews (all pages)', collectAllReviews);
  }

  /* ------------------------------------------------------------------ *
   * Styles
   * ------------------------------------------------------------------ */
  GM_addStyle(`
    #llc-collect {
      position: fixed; bottom: 14px; right: 14px; z-index: 99999;
      font: 600 12px/1 -apple-system, system-ui, sans-serif;
      background: #00ac1c; color: #fff; border: 1px solid #00902a;
      padding: 8px 12px; border-radius: 20px; cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,.4); user-select: none;
    }
    #llc-collect:hover { background: #00c220; }
    #llc-panel {
      position: fixed; inset: 4%; z-index: 100000; display: flex; flex-direction: column;
      background: #14181c; border: 1px solid #2c3440; border-radius: 8px;
      box-shadow: 0 8px 40px rgba(0,0,0,.6);
    }
    #llc-panel-bar {
      display: flex; align-items: center; gap: 12px; padding: 10px 14px;
      border-bottom: 1px solid #2c3440; color: #fff;
      font: 600 14px/1.2 -apple-system, system-ui, sans-serif;
    }
    #llc-panel-status { color: #9ab; font-weight: 400; flex: 1; }
    #llc-panel-bar button {
      background: #2c3440; color: #cdd; border: 0; border-radius: 4px;
      padding: 6px 11px; cursor: pointer; font: inherit;
    }
    #llc-panel-bar button:hover { background: #456; color: #fff; }
    #llc-sort {
      background: #2c3440; color: #cdd; border: 0; border-radius: 4px;
      padding: 5px 8px; cursor: pointer; font: 500 12px/1 -apple-system, system-ui, sans-serif;
    }
    #llc-panel-list { overflow: auto; padding: 0 18px; }
    #llc-panel-list article.production-viewing { border-bottom: 1px solid #2c3440; padding: 16px 0; }
    /* When collecting an RTL language, flip cards so rating/name/avatar sit on the right. */
    #llc-panel-list.llc-rtl article.production-viewing,
    #llc-panel-list.llc-rtl .content-reactions-strip { direction: rtl; }
    #llc-panel-list.llc-rtl .js-review-body,
    #llc-panel-list.llc-rtl .js-spoiler-container { direction: rtl; text-align: right; }
    /* Dates/counts stay LTR islands so they don't scramble inside the RTL header. */
    #llc-panel-list.llc-rtl time,
    #llc-panel-list.llc-rtl .date,
    #llc-panel-list.llc-rtl a.metadata { direction: ltr; unicode-bidi: isolate; }
  `);

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */
  function init() {
    registerMenu();
    ensureCollectBtn();
    ensureDetector(false); // start the model download early if available
  }
  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });
})();

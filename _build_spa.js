// One-shot SPA assembler: merges the 7 tab pages into a single index.html.
// Reads the real files (no transcription), patches the Health hash coupling and
// home deep-links, verifies the result, and only writes if checks pass.
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const read = f => fs.readFileSync(path.join(DIR, f), 'utf8');

const PAGES = ['index', 'tasks', 'goals', 'gym', 'health', 'nutrition', 'finance'];
const NAME_BY_FILE = { index: 'home', tasks: 'tasks', goals: 'goals', gym: 'gym', health: 'health', nutrition: 'nutrition', finance: 'finance' };

const src = {};
PAGES.forEach(p => { src[p] = read(p + '.html'); });

function fail(msg) { console.error('BUILD FAILED: ' + msg); process.exit(1); }

// ── Extract the .tab-page block (between appContainer open and the bottom-nav) ──
function tabPageBlock(file) {
  const text = src[file];
  const name = NAME_BY_FILE[file];
  const openMarker = '<div class="tab-page active" id="page-' + name + '"';
  const start = text.indexOf(openMarker);
  if (start < 0) fail('tab-page open not found in ' + file);
  const navIdx = text.indexOf('<nav class="bottom-nav"', start);
  if (navIdx < 0) fail('bottom-nav not found in ' + file);
  let block = text.slice(start, navIdx).replace(/\s+$/, '');
  if (!block.includes('id="page-' + name + '"')) fail('block sanity fail ' + file);
  return block;
}

// ── Extract a full <div>...</div> by balanced nesting from a start marker ──
function extractBalancedDiv(text, startMarker) {
  const start = text.indexOf(startMarker);
  if (start < 0) return null;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  let depth = 0, m, endIdx = -1;
  while ((m = re.exec(text))) {
    if (m[0] === '</div>') { depth--; if (depth === 0) { endIdx = re.lastIndex; break; } }
    else { depth++; }
  }
  if (endIdx < 0) return null;
  return { block: text.slice(start, endIdx), start, end: endIdx };
}

// ── Extract head <style> blocks that live BEFORE appContainer (goals/health/nutrition) ──
function headStyles(file) {
  const text = src[file];
  const appIdx = text.indexOf('<div id="appContainer">');
  const head = text.slice(0, appIdx);
  const styles = head.match(/<style[\s\S]*?<\/style>/g) || [];
  return styles.join('\n');
}

// ── Extract inline <script> blocks (without src) ──
function inlineScripts(file) {
  const text = src[file];
  const re = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/g;
  return (text.match(re) || []);
}

// ── HOME inline script: rewrite cross-page deep-links to in-app switchTab ──
function patchHomeInline(s) {
  let out = s, n = 0;
  const a1 = "      if (g.indexOf('#') >= 0) window.location.href = g.split('#')[0] + '.html#' + g.split('#')[1];";
  const a2 = "      if (g.indexOf('#') >= 0) { var _p = g.split('#'); switchTab(_p[0], _p[1]); }";
  if (out.includes(a1)) { out = out.replace(a1, a2); n++; } else fail('home patch #1 target missing');
  const b1 = "      const openHydration = () => { window.location.href = 'health.html#body'; };";
  const b2 = "      const openHydration = () => { switchTab('health', 'body'); };";
  if (out.includes(b1)) { out = out.replace(b1, b2); n++; } else fail('home patch #2 target missing');
  if (n !== 2) fail('home patches incomplete');
  return out;
}

// ── HEALTH inline script: decouple section carousel from the global URL hash ──
function patchHealthInline(s) {
  let out = s;
  function rep(target, replacement, label) {
    if (!out.includes(target)) fail('health patch target missing: ' + label);
    out = out.replace(target, replacement);
  }

  // F) inject helpers right after `var cur = -1;`
  rep('  var cur = -1;',
    '  var cur = -1;\n' +
    '  function isHealthActive() { var p = document.getElementById(\'page-health\'); return !!(p && p.classList.contains(\'active\')); }\n' +
    '  function applyNavMode() {\n' +
    '    if (isHealthActive()) {\n' +
    '      if (btn) btn.classList.add(\'is-cycle\');\n' +
    '      var t = TABS[cur < 0 ? DEFAULT_IDX : cur];\n' +
    '      if (navIcon) navIcon.innerHTML = ICONS[t.key] || \'\';\n' +
    '      if (navLabel) navLabel.textContent = t.label;\n' +
    '    } else {\n' +
    '      if (btn) btn.classList.remove(\'is-cycle\');\n' +
    '      if (navIcon) navIcon.innerHTML = ICONS.whoop;\n' +
    '      if (navLabel) navLabel.textContent = \'Health\';\n' +
    '    }\n' +
    '  }', 'helpers');

  // B) centralize nav label updates inside setTab
  rep("    if (navIcon)  navIcon.innerHTML = ICONS[t.key] || '';\n    if (navLabel) navLabel.textContent = t.label;",
    "    applyNavMode();", 'setTab-navlabel');

  // C) stop setTab from clobbering the global hash
  rep("    try { history.replaceState(null, '', '#' + t.key); } catch (e) {}",
    "", 'setTab-hashwrite');

  // G) dual-behavior nav button: first tap navigates to health, subsequent taps cycle
  rep("  if (btn) btn.addEventListener('click', function(e) { e.preventDefault(); cycle(); });",
    "  if (btn) btn.addEventListener('click', function(e) {\n" +
    "    e.preventDefault();\n" +
    "    if (!isHealthActive()) { if (typeof switchTab === 'function') switchTab('health'); }\n" +
    "    else cycle();\n" +
    "  });", 'btn-handler');

  // D) initial section: default to Whoop, let the router supply a sub-section
  rep("  var startIdx = idxForKey((location.hash || '').replace('#', ''));\n  setTab(startIdx >= 0 ? startIdx : DEFAULT_IDX, { animate: false });",
    "  setTab(DEFAULT_IDX, { animate: false });\n  applyNavMode();", 'init');

  // E) react to tab changes instead of hashchange
  rep("  window.addEventListener('hashchange', function() {\n    var i = idxForKey((location.hash || '').replace('#', ''));\n    if (i >= 0 && i !== cur) setTab(i);\n  });",
    "  window.addEventListener('tab-changed', function(e) {\n" +
    "    var d = e.detail || {};\n" +
    "    if (d.tab === 'health' && d.sub) { var i = idxForKey(d.sub); if (i >= 0) setTab(i, { animate: false }); }\n" +
    "    applyNavMode();\n" +
    "  });", 'tabchange');

  return out;
}

// ── Build the shared bottom-nav (health-style cycle button, home active) ──
const NAV = `<nav class="bottom-nav" aria-label="Main navigation">
  <button class="nav-tab active" data-tab="home" aria-label="Home">
    <div class="nav-tab-indicator"></div>
    <div class="nav-tab-icon">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12L12 3l9 9"/><path d="M5 10v9a1 1 0 001 1h4v-5h4v5h4a1 1 0 001-1v-9"/></svg>
    </div>
    <span class="nav-tab-label">Home</span>
  </button>
  <button class="nav-tab" data-tab="tasks" aria-label="Tasks">
    <div class="nav-tab-indicator"></div>
    <div class="nav-tab-icon">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="9,11 12,14 22,4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
    </div>
    <span class="nav-tab-label">Tasks</span>
  </button>
  <button class="nav-tab" data-tab="goals" aria-label="Goals">
    <div class="nav-tab-indicator"></div>
    <div class="nav-tab-icon">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/></svg>
    </div>
    <span class="nav-tab-label">Goals</span>
  </button>
  <button class="nav-tab" data-tab="gym" aria-label="Gym">
    <div class="nav-tab-indicator"></div>
    <div class="nav-tab-icon">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="9" width="2" height="6" rx="0.5"/><rect x="4.5" y="7.5" width="3" height="9" rx="0.5"/><line x1="7.5" y1="12" x2="16.5" y2="12"/><rect x="16.5" y="7.5" width="3" height="9" rx="0.5"/><rect x="20" y="9" width="2" height="6" rx="0.5"/></svg>
    </div>
    <span class="nav-tab-label">Gym</span>
  </button>
  <button class="nav-tab nav-cycle" data-tab="health" data-nav-cycle id="healthCycleBtn" aria-label="Health section — tap to switch">
    <div class="nav-tab-indicator"></div>
    <div class="nav-tab-icon" id="healthNavIcon">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
    </div>
    <div class="nav-cycle-row">
      <span class="nav-cycle-arrow" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></span>
      <span class="nav-tab-label" id="healthNavLabel">Health</span>
      <span class="nav-cycle-arrow nav-cycle-arrow-fwd" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>
    </div>
  </button>
  <button class="nav-tab" data-tab="nutrition" aria-label="Nutrition">
    <div class="nav-tab-indicator"></div>
    <div class="nav-tab-icon">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v6c0 1.1.9 2 2 2a2 2 0 002-2V3"/><line x1="5" y1="9" x2="5" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/><path d="M15 3a4 4 0 014 4v1h-4"/></svg>
    </div>
    <span class="nav-tab-label">Nutrition</span>
  </button>
  <button class="nav-tab" data-tab="finance" aria-label="Finance">
    <div class="nav-tab-indicator"></div>
    <div class="nav-tab-icon">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="14" width="4" height="7"/><rect x="9" y="8" width="4" height="13"/><rect x="16" y="4" width="4" height="17"/><line x1="1" y1="21" x2="23" y2="21"/></svg>
    </div>
    <span class="nav-tab-label">Finance</span>
  </button>
</nav>`;

// ── SPA-specific CSS injected into <head> ──
const SPA_CSS = `<style id="spa-css">
/* SPA tab system */
.tab-page { display: none; }
.tab-page.active { display: block; animation: spaTabFade 0.22s var(--ease-out-expo, ease) both; }
@keyframes spaTabFade { from { opacity: 0; } to { opacity: 1; } }
/* Health nav-cycle: only show the carousel arrows when Health is the active tab */
.nav-tab.nav-cycle:not(.is-cycle) .nav-cycle-arrow { display: none; }
@media (prefers-reduced-motion: reduce) { .tab-page.active { animation: none; } }
</style>`;

// ── Assemble ──
const base = src.index;
const appOpen = '<div id="appContainer">';
const appIdx = base.indexOf(appOpen);
if (appIdx < 0) fail('appContainer not found in index');
let preamble = base.slice(0, appIdx); // <!DOCTYPE> + head + <body> + authOverlay

// Inject extra fonts + page styles + SPA css before </head>
const newsreader = '<link href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&display=swap" rel="stylesheet">';
const injectHead =
  '\n<!-- merged fonts -->\n' + newsreader +
  '\n<!-- merged page styles -->\n' + headStyles('goals') + '\n' + headStyles('health') + '\n' + headStyles('nutrition') +
  '\n' + SPA_CSS + '\n';
if (!preamble.includes('</head>')) fail('no </head> in preamble');
preamble = preamble.replace('</head>', injectHead + '</head>');

// Tab-page blocks: home active, the rest deactivated
const homeBlock = tabPageBlock('index'); // keeps "active"
const blocks = {};
['tasks', 'goals', 'gym', 'health', 'nutrition', 'finance'].forEach(f => {
  blocks[f] = tabPageBlock(f).replace('class="tab-page active"', 'class="tab-page"');
});

// De-dup the progress-photos overlay (present in BOTH gym & health). Pull one copy
// out to app-level so it works from any tab (a display:none tab-page would hide it).
const PHOTOS_MARKER = '<div class="gym-overlay" id="photosOverlay">';
const photos = extractBalancedDiv(blocks.gym, PHOTOS_MARKER);
if (!photos) fail('could not extract photos overlay from gym block');
const photosOverlay = photos.block;
blocks.gym = blocks.gym.slice(0, photos.start) + blocks.gym.slice(photos.end);
const hp = extractBalancedDiv(blocks.health, PHOTOS_MARKER);
if (hp) blocks.health = blocks.health.slice(0, hp.start) + blocks.health.slice(hp.end);
else fail('photos overlay not found in health block (expected duplicate)');

const otherBlocks = ['tasks', 'goals', 'gym', 'health', 'nutrition', 'finance'].map(f => blocks[f]);

// Inline scripts
const homeInline = patchHomeInline(inlineScripts('index')[0] || fail('no home inline'));
const tasksInline = (inlineScripts('tasks')[0] || fail('no tasks inline'));
const healthInline = patchHealthInline(inlineScripts('health')[0] || fail('no health inline'));
const nutritionInline = (inlineScripts('nutrition')[0] || fail('no nutrition inline'));

const scripts = [
  '<script src="muscle-map.js"></script>',
  '<script src="goals-page.js"></script>',
  '<script src="shared.js"></script>',
  homeInline,
  tasksInline,
  healthInline,
  nutritionInline,
].join('\n');

const out =
  preamble +
  appOpen + '\n' +
  homeBlock + '\n' +
  otherBlocks.join('\n') + '\n' +
  '<!-- Shared progress-photos overlay: app-level so it opens from any tab -->\n' +
  photosOverlay + '\n' +
  NAV + '\n' +
  '</div>\n' +
  scripts + '\n' +
  '</body>\n</html>\n';

// ── Verify ──
const errors = [];
function count(re) { return (out.match(re) || []).length; }
if (count(/class="tab-page active"/g) !== 1) errors.push('expected exactly 1 active tab-page, got ' + count(/class="tab-page active"/g));
if (count(/class="tab-page"/g) !== 6) errors.push('expected 6 inactive tab-pages, got ' + count(/class="tab-page"/g));
['home','tasks','goals','gym','health','nutrition','finance'].forEach(n => {
  const c = count(new RegExp('id="page-' + n + '"', 'g'));
  if (c !== 1) errors.push('id="page-' + n + '" appears ' + c + ' times');
});
['id="appContainer"','id="authOverlay"','id="signInBtn"','class="bottom-nav"','src="shared.js"','src="muscle-map.js"','src="goals-page.js"','id="healthCycleBtn"']
  .forEach(s => { const c = (out.split(s).length - 1); if (c !== 1) errors.push(s + ' appears ' + c + ' times (want 1)'); });

// Duplicate-ID scan — on STATIC markup only (strip <script> so JS template
// literals like id="${t.id}" don't register as false duplicates).
const staticOut = out.replace(/<script[\s\S]*?<\/script>/g, '');
const ids = {};
let m, idRe = /\bid="([^"]+)"/g;
while ((m = idRe.exec(staticOut))) { ids[m[1]] = (ids[m[1]] || 0) + 1; }
const dupes = Object.keys(ids).filter(k => ids[k] > 1 && !k.includes('${'));
if (dupes.length) errors.push('DUPLICATE IDS: ' + dupes.map(d => d + '×' + ids[d]).join(', '));

// Tag balance sanity for <div>
const divOpen = count(/<div\b/g), divClose = count(/<\/div>/g);
if (divOpen !== divClose) errors.push('div imbalance: ' + divOpen + ' open vs ' + divClose + ' close');

console.log('--- assembly stats ---');
console.log('output bytes:', out.length);
console.log('tab-pages:', count(/id="page-/g), '| divs:', divOpen, '/', divClose);
console.log('inline scripts merged: home, tasks, health, nutrition');

if (errors.length) {
  console.error('\n--- VERIFICATION ERRORS ---');
  errors.forEach(e => console.error(' • ' + e));
  fs.writeFileSync(path.join(DIR, '_spa_out.html'), out, 'utf8');
  console.error('\nWrote _spa_out.html for inspection but did NOT touch index.html.');
  process.exit(1);
}

fs.writeFileSync(path.join(DIR, '_spa_out.html'), out, 'utf8');
console.log('\nAll checks passed. Wrote _spa_out.html');

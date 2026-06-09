// Renders a slim back-nav topbar into #topbar.
// Call renderTopbar(title, backHref) after DOM ready.
function renderTopbar(title, backHref) {
  var el = document.getElementById('topbar');
  if (!el) return;
  el.innerHTML =
    '<div class="caf-topbar">' +
      '<a href="' + (backHref || 'index.html') + '" class="caf-topbar-back">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>' +
        ' Back' +
      '</a>' +
      '<span class="caf-topbar-title">' + (title || '') + '</span>' +
      '<div class="caf-topbar-right">' +
        '<span class="sync-dot" id="topbarSyncDot" title="Sync status"></span>' +
        '<span class="caf-topbar-email" id="topbarEmail"></span>' +
      '</div>' +
    '</div>';

  window.addEventListener('caf-ready', function (e) {
    var em = document.getElementById('topbarEmail');
    if (em) em.textContent = (e.detail && e.detail.email) || '';
  });
}

function setTopbarSyncing(on, isError) {
  var dot = document.getElementById('topbarSyncDot');
  if (!dot) return;
  dot.className = 'sync-dot' + (isError ? ' error' : on ? ' syncing' : '');
}

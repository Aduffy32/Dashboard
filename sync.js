// Cloud sync helper for standalone pages.
// Uses the same app_state table as shared.js.
// Returns { pull, push } — call pull() on load, push(key) after every write.
function initCloudSync({ appKey, syncedKeys, onApplied }) {
  var timers = {};

  function pull() {
    var db = window.cafDB, user = window.cafUser;
    if (!db || !user) return Promise.resolve();
    return Promise.all(syncedKeys.map(function (lsKey) {
      return db.from('app_state')
        .select('payload')
        .eq('user_id', user.id)
        .eq('app_key', appKey + ':' + lsKey)
        .maybeSingle()
        .then(function (res) {
          var payload = res.data && res.data.payload;
          if (payload != null) {
            localStorage.setItem(lsKey, JSON.stringify(payload));
            if (onApplied) onApplied(lsKey, payload);
          }
        }).catch(function () {});
    }));
  }

  function push(lsKey) {
    clearTimeout(timers[lsKey]);
    timers[lsKey] = setTimeout(function () {
      var db = window.cafDB, user = window.cafUser;
      if (!db || !user) return;
      var val;
      try { val = JSON.parse(localStorage.getItem(lsKey) || 'null'); } catch (e) { val = null; }
      db.from('app_state').upsert(
        { user_id: user.id, app_key: appKey + ':' + lsKey, payload: val, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,app_key' }
      ).catch(function () {});
    }, 500);
  }

  return { pull: pull, push: push };
}

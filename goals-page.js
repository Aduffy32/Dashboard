/* ══════════════════════════════════════════════════════════════════
   Goals page — Calendar + Life-goals UI.
   Relies on globals from shared.js: storeGet/storeSet, calStore/calStoreSave,
   calEntriesFor, calTemplateInstancesFor, calMaterializeDate, calAddException,
   lifeGoalsStore/lifeGoalsSave, calDateStr, calTodayStr, calParse,
   calBlockForTime, calMinutesOf, calDomainVar.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const pad = n => String(n).padStart(2, '0');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const domVar = d => (typeof calDomainVar === 'function') ? calDomainVar(d) : 'var(--accent-work)';

  const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MON_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DOMAINS = [
    { k: 'work', label: 'Work' }, { k: 'money', label: 'Money' }, { k: 'gym', label: 'Gym' },
    { k: 'life', label: 'Life' }, { k: 'home', label: 'Home' }, { k: 'sleep', label: 'Sleep' }
  ];

  const START_HOUR = 6, END_HOUR = 24, HOURPX = 50;

  // ── small date / format helpers ───────────────────────────────────
  function dStr(d) { return (typeof calDateStr === 'function') ? calDateStr(d) : (d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())); }
  function todayStr() { return (typeof calTodayStr === 'function') ? calTodayStr() : dStr(new Date()); }
  function parseDs(ds) { return (typeof calParse === 'function') ? calParse(ds) : (function () { const p = ds.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); })(); }
  function minutesOf(t) { return (typeof calMinutesOf === 'function') ? calMinutesOf(t) : (function () { const p = String(t || '0:0').split(':'); return (+p[0] || 0) * 60 + (+p[1] || 0); })(); }
  function fmtClock(min) { let h = Math.floor(min / 60), m = min % 60; const ap = h >= 12 ? 'pm' : 'am'; let hh = h % 12; if (hh === 0) hh = 12; return hh + (m ? ':' + pad(m) : '') + ap; }
  function labelHour(h) { if (h === 0 || h === 24) return '12a'; if (h === 12) return '12p'; return (h < 12 ? h + 'a' : (h - 12) + 'p'); }
  function fmtDur(min) { min = Math.round(min); const h = Math.floor(min / 60), m = min % 60; if (h && m) return h + 'h ' + m + 'm'; if (h) return h + 'h'; return m + 'm'; }
  function weekStart(d) { const x = new Date(d); const dow = (x.getDay() + 6) % 7; x.setDate(x.getDate() - dow); x.setHours(0, 0, 0, 0); return x; }
  function weekKey(d) { return dStr(weekStart(d)); }
  function rangeLabel(a, b) {
    if (a.getMonth() === b.getMonth()) return MON[a.getMonth()] + ' ' + a.getDate() + ' – ' + b.getDate();
    return MON[a.getMonth()] + ' ' + a.getDate() + ' – ' + MON[b.getMonth()] + ' ' + b.getDate();
  }

  // ── calendar entry classification ─────────────────────────────────
  function evAllDay(e) { return e.kind === 'date' || !e.time; }
  function evMoment(e) { return !!e.time && !evAllDay(e) && (e.kind === 'reminder' || !(e.durationMin > 0)); }
  function entriesFor(ds) { return (typeof calEntriesFor === 'function') ? calEntriesFor(ds) : ((typeof storeGet === 'function' ? storeGet('goals:' + ds) : null) || []); }
  function calGetItems(ds) { return ((typeof storeGet === 'function' ? storeGet('goals:' + ds) : null) || []).slice(); }
  function calSetItems(ds, arr) { if (typeof storeSet === 'function') storeSet('goals:' + ds, arr); }
  function sortKey(e) { return evAllDay(e) ? -1 : minutesOf(e.time); }

  /* ═══════════════════════ SUB-TABS ═══════════════════════ */
  let sub = 'cal';
  function showSub(which) {
    sub = which;
    $('subtabCal').classList.toggle('active', which === 'cal');
    $('subtabGoals').classList.toggle('active', which === 'goals');
    $('subtabCal').setAttribute('aria-selected', which === 'cal');
    $('subtabGoals').setAttribute('aria-selected', which === 'goals');
    $('panelCal').classList.toggle('active', which === 'cal');
    $('panelGoals').classList.toggle('active', which === 'goals');
    $('calFab').style.display = which === 'cal' ? 'flex' : 'none';
    if (which === 'goals') renderGoals(); else renderCal();
  }

  /* ═══════════════════════ CALENDAR ═══════════════════════ */
  let calView = 'week';
  let calCursor = new Date();

  function renderCal() {
    document.querySelectorAll('.cal-viewbtn').forEach(b => b.classList.toggle('active', b.dataset.view === calView));
    if (calView === 'week') renderWeek();
    else if (calView === 'month') renderMonth();
    else renderYear();
  }

  function weekDates() {
    const s = weekStart(calCursor);
    return Array.from({ length: 7 }, (_, i) => { const x = new Date(s); x.setDate(s.getDate() + i); return x; });
  }

  function renderWeek() {
    const days = weekDates();
    $('calPeriod').textContent = rangeLabel(days[0], days[6]);
    const tS = todayStr();
    const perDay = days.map(d => entriesFor(dStr(d)));

    let head = '<div class="cal-wk-gh"></div>';
    days.forEach((d, i) => {
      const isT = dStr(d) === tS;
      head += `<div class="cal-wk-dh${isT ? ' today' : ''}"><div class="cal-wk-dow">${DOW[i]}</div><div class="cal-wk-dnum">${d.getDate()}</div>${isT ? '<div class="cal-wk-todaydot"></div>' : ''}</div>`;
    });

    let ad = '<div class="cal-wk-ad-gh"><span>All-day</span></div>';
    days.forEach((d, i) => {
      const ds = dStr(d);
      let chips = '';
      perDay[i].filter(evAllDay).sort((a, b) => sortKey(a) - sortKey(b)).forEach(e => {
        chips += `<div class="cal-ad-chip ${e.kind === 'date' ? 'date' : ''}" style="--ec:${domVar(e.domain)}" data-ds="${ds}" data-id="${esc(e.id)}">${esc(e.text)}</div>`;
      });
      ad += `<div class="cal-wk-ad-cell" data-ds="${ds}">${chips}</div>`;
    });

    const H = (END_HOUR - START_HOUR) * HOURPX;
    let gutter = `<div class="cal-wk-gutter" style="height:${H}px">`;
    for (let h = START_HOUR; h <= END_HOUR; h++) gutter += `<div class="cal-hr-label" style="top:${(h - START_HOUR) * HOURPX}px">${labelHour(h)}</div>`;
    gutter += '</div>';

    let cols = '';
    days.forEach((d, i) => {
      const ds = dStr(d), isT = ds === tS;
      let lines = '';
      for (let h = START_HOUR; h <= END_HOUR; h++) {
        const top = (h - START_HOUR) * HOURPX;
        lines += `<div class="cal-hrline" style="top:${top}px"></div>`;
        if (h < END_HOUR) lines += `<div class="cal-hrline half" style="top:${top + HOURPX / 2}px"></div>`;
      }
      let nowline = '';
      if (isT) { const nowM = new Date().getHours() * 60 + new Date().getMinutes(); const top = ((nowM - START_HOUR * 60) / 60) * HOURPX; if (top >= 0 && top <= H) nowline = `<div class="cal-nowline" style="top:${top.toFixed(1)}px"></div>`; }
      let evs = '';
      perDay[i].filter(e => !evAllDay(e)).sort((a, b) => sortKey(a) - sortKey(b)).forEach(e => {
        let top = ((minutesOf(e.time) - START_HOUR * 60) / 60) * HOURPX;
        if (evMoment(e)) {
          evs += `<div class="cal-moment" style="top:${top.toFixed(1)}px;--ec:${domVar(e.domain)}" data-ds="${ds}" data-id="${esc(e.id)}"><div class="cal-moment-line"></div><div class="cal-moment-dot"></div></div>`;
        } else {
          let hgt = Math.max(20, (e.durationMin / 60) * HOURPX);
          if (top < 0) { hgt += top; top = 0; }
          if (hgt < 14) hgt = 14;
          const cls = 'cal-ev' + (e.done ? ' done' : '') + (e.protect ? ' protect' : '');
          evs += `<div class="${cls}" style="top:${top.toFixed(1)}px;height:${(hgt - 2).toFixed(1)}px;--ec:${domVar(e.domain)}" data-ds="${ds}" data-id="${esc(e.id)}"><div class="cal-ev-title">${esc(e.text)}</div><div class="cal-ev-time">${fmtClock(minutesOf(e.time))}</div></div>`;
        }
      });
      cols += `<div class="cal-daycol${isT ? ' today' : ''}" data-ds="${ds}" style="height:${H}px">${lines}${nowline}${evs}</div>`;
    });

    $('calBody').innerHTML = `<div class="cal-wk"><div class="cal-wk-head">${head}</div><div class="cal-wk-allday">${ad}</div><div class="cal-wk-scroll" id="calWkScroll"><div class="cal-wk-cols">${gutter}${cols}</div></div></div>`;
    const sc = $('calWkScroll');
    if (sc) { const t = ((new Date().getHours() - START_HOUR - 1) * HOURPX); sc.scrollTop = Math.max(0, t); }
  }

  function shortTitle(e) { return e.text; }
  function renderMonth() {
    const y = calCursor.getFullYear(), m = calCursor.getMonth();
    $('calPeriod').textContent = MON_FULL[m] + ' ' + y;
    const first = new Date(y, m, 1), startPad = (first.getDay() + 6) % 7;
    const gridStart = new Date(y, m, 1 - startPad);
    const tS = todayStr();
    let dows = ''; DOW.forEach(d => dows += `<div class="cal-mo-dow">${d}</div>`);
    let cells = '';
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart); d.setDate(gridStart.getDate() + i);
      const ds = dStr(d), inMonth = d.getMonth() === m, isT = ds === tS;
      const entries = entriesFor(ds).slice().sort((a, b) => sortKey(a) - sortKey(b));
      let chips = '';
      entries.slice(0, 3).forEach(e => { chips += `<div class="cal-mchip ${e.kind === 'date' ? 'date' : ''} ${e.done ? 'done' : ''}" style="--ec:${domVar(e.domain)}">${esc(shortTitle(e))}</div>`; });
      if (entries.length > 3) chips += `<div class="cal-mmore">+${entries.length - 3} more</div>`;
      cells += `<div class="cal-mcell${inMonth ? '' : ' dim'}${isT ? ' today' : ''}" data-ds="${ds}"><div class="cal-mcell-num">${d.getDate()}</div>${chips}</div>`;
    }
    $('calBody').innerHTML = `<div class="cal-mo-dows">${dows}</div><div class="cal-mo-grid">${cells}</div>`;
  }

  function renderYear() {
    const y = calCursor.getFullYear();
    $('calPeriod').textContent = String(y);
    const tS = todayStr();
    const curM = (new Date().getFullYear() === y) ? new Date().getMonth() : -1;
    let html = '';
    for (let m = 0; m < 12; m++) {
      const first = new Date(y, m, 1), startPad = (first.getDay() + 6) % 7, dim = new Date(y, m + 1, 0).getDate();
      let days = '';
      for (let p = 0; p < startPad; p++) days += '<div class="cal-yd pad"></div>';
      for (let dn = 1; dn <= dim; dn++) {
        const ds = dStr(new Date(y, m, dn));
        const entries = entriesFor(ds);
        const has = entries.length > 0;
        const isT = ds === tS;
        days += `<div class="cal-yd${isT ? ' today' : ''}${has ? ' has evt' : ''}"${has ? ` style="--ec:${domVar(entries[0].domain)}"` : ''}>${dn}</div>`;
      }
      html += `<div class="cal-ymonth${m === curM ? ' cur' : ''}" data-month="${m}"><div class="cal-ymonth-name">${MON_FULL[m]}</div><div class="cal-yr-days">${days}</div></div>`;
    }
    $('calBody').innerHTML = `<div class="cal-yr-grid">${html}</div>`;
  }

  function calStep(dir) {
    if (calView === 'week') calCursor.setDate(calCursor.getDate() + 7 * dir);
    else if (calView === 'month') calCursor.setMonth(calCursor.getMonth() + dir);
    else calCursor.setFullYear(calCursor.getFullYear() + dir);
    renderCal();
  }

  /* ── Calendar add / edit sheet ── */
  let calEdit = null;          // { ds, id } when editing
  let calSheetType = 'task';
  let calSheetDomain = 'work';

  function buildDomainPills(container, selected) {
    container.innerHTML = DOMAINS.map(d => `<button type="button" class="go-pill" data-k="${d.k}" style="--pc:${domVar(d.k)}"><span class="dot"></span>${d.label}</button>`).join('');
    setPill(container, selected);
  }
  function setPill(container, k) { container.querySelectorAll('.go-pill').forEach(p => p.classList.toggle('active', p.dataset.k === k)); }
  function setSeg(container, k) { container.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.k === k)); }

  function calTimeFieldVis() { $('calfTimeField').style.display = (calSheetType === 'date') ? 'none' : 'block'; $('calfDur').parentElement.style.display = (calSheetType === 'reminder') ? 'none' : 'block'; }

  function openCalSheet(ds, id, presetTime) {
    ds = ds || todayStr();
    let item = null;
    if (id) item = entriesFor(ds).find(x => x.id === id) || null;
    calEdit = item ? { ds, id } : null;
    calSheetType = item ? (item.kind || 'task') : 'task';
    calSheetDomain = item ? (item.domain || 'work') : 'work';
    $('calSheetTitle').textContent = item ? 'Edit entry' : 'New entry';
    $('calfTitle').value = item ? (item.text || '') : '';
    $('calfDate').value = ds;
    setSeg($('calfType'), calSheetType);
    buildDomainPills($('calfDomain'), calSheetDomain);
    $('calfTime').value = item && item.time ? item.time : (presetTime || '09:00');
    $('calfDur').value = item ? (item.durationMin != null ? item.durationMin : 60) : 60;
    calTimeFieldVis();
    $('calfDelete').style.display = item ? 'block' : 'none';
    openOverlay('calSheetOverlay');
    setTimeout(() => $('calfTitle').focus(), 60);
  }

  function saveCalSheet() {
    const title = $('calfTitle').value.trim();
    if (!title) { $('calfTitle').focus(); return; }
    const ds = $('calfDate').value || todayStr();
    const kind = calSheetType, domain = calSheetDomain;
    const timed = kind !== 'date';
    const editing = calEdit && calEdit.id;
    let id = editing ? calEdit.id : ('g' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
    let done = false, tplId, protect = false;
    if (editing) {
      const src = entriesFor(calEdit.ds).find(x => x.id === calEdit.id);
      if (src) { done = !!src.done; tplId = src.tplId; protect = !!src.protect; }
      calSetItems(calEdit.ds, calGetItems(calEdit.ds).filter(x => x.id !== calEdit.id));
      if (tplId && calEdit.ds !== ds && typeof calAddException === 'function') calAddException(tplId, calEdit.ds);
    }
    const item = { id, text: title, domain, kind, done, cal: true };
    if (tplId) item.tplId = tplId;
    if (protect) item.protect = true;
    if (timed) {
      item.time = $('calfTime').value || '09:00';
      item.durationMin = kind === 'reminder' ? 0 : Math.max(0, parseInt($('calfDur').value, 10) || 0);
      item.block = (typeof calBlockForTime === 'function') ? calBlockForTime(item.time) : 'morning';
    } else { item.allDay = true; }
    const arr = calGetItems(ds).filter(x => x.id !== id); arr.push(item); calSetItems(ds, arr);
    closeOverlay('calSheetOverlay'); renderCal();
  }

  function deleteCalItem() {
    if (!calEdit) return closeOverlay('calSheetOverlay');
    const { ds, id } = calEdit;
    const src = entriesFor(ds).find(x => x.id === id);
    calSetItems(ds, calGetItems(ds).filter(x => x.id !== id));
    if (src && src.tplId && typeof calAddException === 'function') calAddException(src.tplId, ds);
    closeOverlay('calSheetOverlay'); renderCal();
  }

  /* ═══════════════════════ LIFE-GOALS ═══════════════════════ */
  let openGoalId = null;
  let detailTick = null;

  function periodKeyOf(g) {
    if (g.period === 'daily') return todayStr();
    if (g.period === 'monthly') { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
    return weekKey(new Date());
  }
  function periodLabel(g) { return g.period === 'daily' ? 'today' : g.period === 'monthly' ? 'this month' : 'this week'; }
  function timerKey(id) { return 'lifegoal_timer:' + id; }
  function timerStart(id) { try { const v = localStorage.getItem(timerKey(id)); return v ? Number(v) : 0; } catch (_) { return 0; } }
  function isRunning(id) { return timerStart(id) > 0; }
  function elapsedMin(id) { const s = timerStart(id); return s ? (Date.now() - s) / 60000 : 0; }

  function logged(g) { return (g.log && g.log[periodKeyOf(g)]) || 0; }
  function liveVal(g) { let v = logged(g); if (g.type === 'time' && isRunning(g.id)) v += elapsedMin(g.id); return v; }

  function getGoal(id) { return lifeGoalsStore().goals.find(g => g.id === id); }
  function addLog(id, delta) {
    const s = lifeGoalsStore(); const g = s.goals.find(x => x.id === id); if (!g) return;
    if (!g.log) g.log = {}; const k = periodKeyOf(g);
    g.log[k] = Math.max(0, Math.round(((g.log[k] || 0) + delta) * 100) / 100);
    lifeGoalsSave(s); renderGoals(); if (openGoalId === id) renderDetail();
  }
  function resetPeriod(id) {
    const s = lifeGoalsStore(); const g = s.goals.find(x => x.id === id); if (!g) return;
    if (!g.log) g.log = {}; g.log[periodKeyOf(g)] = 0;
    lifeGoalsSave(s); renderGoals(); if (openGoalId === id) renderDetail();
  }

  function startTimer(id) { try { localStorage.setItem(timerKey(id), String(Date.now())); } catch (_) {} ensureTick(); renderGoals(); if (openGoalId === id) renderDetail(); }
  function finishTimer(id) {
    const mins = Math.max(1, Math.round(elapsedMin(id)));
    try { localStorage.removeItem(timerKey(id)); } catch (_) {}
    addLog(id, mins);
    stopTickIfIdle();
  }
  function anyTimerRunning() { return lifeGoalsStore().goals.some(g => isRunning(g.id)); }
  function ensureTick() { if (detailTick) return; detailTick = setInterval(() => { if (sub === 'goals') renderGoals(); if (openGoalId && isRunning(openGoalId)) renderDetail(); if (!anyTimerRunning() && !(openGoalId && isRunning(openGoalId))) stopTickIfIdle(); }, 1000); }
  function stopTickIfIdle() { if (!anyTimerRunning()) { clearInterval(detailTick); detailTick = null; } }

  function valText(g, v) { return g.type === 'time' ? fmtDur(v) : (Math.round(v * 100) / 100); }
  function targetText(g) { return g.type === 'time' ? fmtDur(g.target) : (g.target + ' ' + (g.unit || '')); }

  function renderGoals() {
    const store = lifeGoalsStore();
    const goals = store.goals || [];
    const done = goals.filter(g => liveVal(g) >= (g.target || 1)).length;
    $('lgSummary').innerHTML =
      `<div class="lg-sumcard"><div class="lg-sumlabel">Active goals</div><div class="lg-sumval">${goals.length}</div></div>` +
      `<div class="lg-sumcard"><div class="lg-sumlabel">Hit this period</div><div class="lg-sumval">${done}<small> / ${goals.length}</small></div></div>`;

    let html = '';
    goals.forEach((g, i) => {
      const ac = domVar(g.domain);
      const v = liveVal(g), t = g.target || 1, pct = clamp(Math.round(v / t * 100), 0, 100);
      const complete = v >= t;
      const running = isRunning(g.id);
      html += `<div class="lg-card${complete ? ' complete' : ''}" data-id="${esc(g.id)}" tabindex="0" role="button" style="--ac:${ac};animation-delay:${(i * 0.03).toFixed(2)}s">
        ${running ? '<span class="lg-card-running"><span class="rdot"></span>Live</span>' : ''}
        <div class="lg-card-top"><span class="lg-card-eyebrow">${periodLabel(g)} · ${g.type === 'time' ? 'time' : g.unit || 'count'}</span><span class="lg-card-pct">${pct}%</span></div>
        <div class="lg-card-title">${esc(g.title)}</div>
        <div class="lg-card-val">${valText(g, v)}<small> / ${targetText(g)}</small></div>
        <div class="lg-card-bar"><div class="lg-card-fill" style="width:${pct}%"></div></div>
      </div>`;
    });
    html += `<div class="lg-add" id="lgAddCard" tabindex="0" role="button"><div class="lg-add-plus">+</div><div class="lg-add-label">New goal</div></div>`;
    $('lgGrid').innerHTML = html;
    if (anyTimerRunning()) ensureTick();
  }

  function gaugeTicks() {
    let s = '';
    for (let i = 0; i <= 10; i++) {
      const t = Math.PI * (i / 10), co = Math.cos(t), si = Math.sin(t);
      s += `<line x1="${(120 - 92 * co).toFixed(1)}" y1="${(120 - 92 * si).toFixed(1)}" x2="${(120 - 80 * co).toFixed(1)}" y2="${(120 - 80 * si).toFixed(1)}"/>`;
    }
    return s;
  }

  function renderDetail() {
    const g = getGoal(openGoalId); if (!g) { closeOverlay('lgDetailOverlay'); return; }
    const ac = domVar(g.domain);
    const v = liveVal(g), t = g.target || 1, ratio = clamp(v / t, 0, 1), pct = Math.round(v / t * 100);
    const ang = Math.PI * ratio, nx = (120 - 78 * Math.cos(ang)).toFixed(1), ny = (120 - 78 * Math.sin(ang)).toFixed(1);
    const running = isRunning(g.id);

    let controls = '';
    if (g.type === 'time') {
      controls += `<div class="lgd-quick">
        <button class="lgd-chip" data-act="log" data-v="15">+15m</button>
        <button class="lgd-chip" data-act="log" data-v="30">+30m</button>
        <button class="lgd-chip" data-act="log" data-v="45">+45m</button>
        <button class="lgd-chip" data-act="log" data-v="60">+1h</button>
        <button class="lgd-chip" data-act="logcustom">Log…</button>
      </div>`;
      controls += running
        ? `<button class="lgd-timerbtn running" data-act="timer"><svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>Finish · <span class="lgd-elapsed">${fmtDur(elapsedMin(g.id))}</span></button>`
        : `<button class="lgd-timerbtn" data-act="timer"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>Start timer</button>`;
    } else {
      controls += `<div class="lgd-quick">
        <button class="lgd-chip" data-act="log" data-v="-1">−1</button>
        <button class="lgd-chip" data-act="log" data-v="1">+1</button>
        <button class="lgd-chip" data-act="log" data-v="2">+2</button>
        <button class="lgd-chip" data-act="logcustom">Log…</button>
      </div>`;
    }

    $('lgDetail').style.setProperty('--ac', ac);
    $('lgDetail').innerHTML = `
      <div class="go-sheet-grip"></div>
      <div class="lgd-eyebrow">${periodLabel(g)} · resets ${g.period}</div>
      <div class="lgd-title">${esc(g.title)}</div>
      ${g.note ? `<div class="lgd-note">${esc(g.note)}</div>` : ''}
      <div class="lgd-gauge-wrap">
        <svg class="lgd-gauge" viewBox="0 0 240 140" aria-hidden="true">
          <path d="M28 120 A92 92 0 0 1 212 120" fill="none" stroke="rgba(255,255,255,0.09)" stroke-width="9" stroke-linecap="round"/>
          <path d="M28 120 A92 92 0 0 1 212 120" fill="none" stroke="${ac}" stroke-width="9" stroke-linecap="round" pathLength="100" stroke-dasharray="${(ratio * 100).toFixed(1)} 100" style="transition:stroke-dasharray 0.5s var(--ease-out-expo)"/>
          <g stroke="rgba(255,255,255,0.18)" stroke-width="1.5">${gaugeTicks()}</g>
          <line x1="120" y1="120" x2="${nx}" y2="${ny}" stroke="var(--text-primary)" stroke-width="2.5" stroke-linecap="round" style="transition:all 0.5s var(--ease-out-expo)"/>
          <circle cx="120" cy="120" r="6" fill="#0a0a0c" stroke="${ac}" stroke-width="2.5"/>
        </svg>
        <div class="lgd-overlay">
          <div class="lgd-val">${valText(g, v)}</div>
          <div class="lgd-of">of ${targetText(g)}</div>
          <div class="lgd-pct">${pct}% · ${periodLabel(g)}</div>
        </div>
      </div>
      <div class="lgd-controls">${controls}
        <div class="lgd-secondary">
          <button class="lgd-sbtn" data-act="edit">Edit</button>
          <button class="lgd-sbtn" data-act="reset">Reset ${periodLabel(g)}</button>
          <button class="lgd-sbtn danger" data-act="close">Close</button>
        </div>
      </div>`;
  }

  function openGoalDetail(id) { openGoalId = id; renderDetail(); openOverlay('lgDetailOverlay'); if (isRunning(id)) ensureTick(); }

  /* ── Goal add / edit sheet ── */
  let goalEdit = null;
  let goalDomain = 'work', goalPeriod = 'weekly', goalType = 'time';

  function goalTypeVis() {
    $('lgfTargetLabel').textContent = goalType === 'time' ? 'Target (hours)' : 'Target';
    $('lgfUnitField').style.display = goalType === 'time' ? 'none' : 'block';
    $('lgfTarget').step = goalType === 'time' ? '0.5' : '1';
  }

  function openGoalEdit(id) {
    const g = id ? getGoal(id) : null;
    goalEdit = g ? id : null;
    goalDomain = g ? (g.domain || 'work') : 'work';
    goalPeriod = g ? (g.period || 'weekly') : 'weekly';
    goalType = g ? (g.type || 'time') : 'time';
    $('lgEditTitle').textContent = g ? 'Edit goal' : 'New goal';
    $('lgfTitle').value = g ? (g.title || '') : '';
    buildDomainPills($('lgfDomain'), goalDomain);
    setSeg($('lgfPeriod'), goalPeriod);
    setSeg($('lgfType'), goalType);
    $('lgfTarget').value = g ? (g.type === 'time' ? (g.target / 60) : g.target) : (goalType === 'time' ? 3 : 5);
    $('lgfUnit').value = g ? (g.unit || 'sessions') : 'sessions';
    goalTypeVis();
    $('lgfDelete').style.display = g ? 'block' : 'none';
    openOverlay('lgEditOverlay');
    if (!g) setTimeout(() => $('lgfTitle').focus(), 60);
  }

  function saveGoalEdit() {
    const title = $('lgfTitle').value.trim();
    if (!title) { $('lgfTitle').focus(); return; }
    const targRaw = parseFloat($('lgfTarget').value) || 0;
    const target = goalType === 'time' ? Math.max(5, Math.round(targRaw * 60)) : Math.max(1, Math.round(targRaw));
    const unit = goalType === 'time' ? 'min' : ($('lgfUnit').value.trim() || 'done');
    const s = lifeGoalsStore();
    if (goalEdit) {
      const g = s.goals.find(x => x.id === goalEdit);
      if (g) { g.title = title; g.domain = goalDomain; g.period = goalPeriod; g.type = goalType; g.target = target; g.unit = unit; }
    } else {
      s.goals.push({ id: 'lg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), title, domain: goalDomain, period: goalPeriod, type: goalType, target, unit, log: {} });
    }
    lifeGoalsSave(s);
    closeOverlay('lgEditOverlay'); renderGoals();
  }

  function deleteGoal() {
    if (!goalEdit) return closeOverlay('lgEditOverlay');
    try { localStorage.removeItem(timerKey(goalEdit)); } catch (_) {}
    const s = lifeGoalsStore(); s.goals = s.goals.filter(g => g.id !== goalEdit); lifeGoalsSave(s);
    closeOverlay('lgEditOverlay'); closeOverlay('lgDetailOverlay'); openGoalId = null; renderGoals();
  }

  /* ═══════════════════════ OVERLAY HELPERS ═══════════════════════ */
  function openOverlay(id) { $(id).classList.add('open'); }
  function closeOverlay(id) { $(id).classList.remove('open'); if (id === 'lgDetailOverlay') { openGoalId = null; stopTickIfIdle(); } }
  function closeAllOverlays() { ['calSheetOverlay', 'lgDetailOverlay', 'lgEditOverlay'].forEach(closeOverlay); }

  /* ═══════════════════════ WIRING ═══════════════════════ */
  function init() {
    // Sub-tabs
    $('subtabCal').addEventListener('click', () => showSub('cal'));
    $('subtabGoals').addEventListener('click', () => showSub('goals'));

    // Calendar nav
    $('calPrev').addEventListener('click', () => calStep(-1));
    $('calNext').addEventListener('click', () => calStep(1));
    $('calToday').addEventListener('click', () => { calCursor = new Date(); renderCal(); });
    document.querySelectorAll('.cal-viewbtn').forEach(b => b.addEventListener('click', () => { calView = b.dataset.view; renderCal(); }));
    $('calFab').addEventListener('click', () => openCalSheet(calView === 'week' ? dStr(weekStart(calCursor)) : todayStr(), null));

    // Calendar body delegation
    $('calBody').addEventListener('click', e => {
      const ev = e.target.closest('.cal-ev,.cal-moment,.cal-ad-chip');
      if (ev) { openCalSheet(ev.dataset.ds, ev.dataset.id); return; }
      const mcell = e.target.closest('.cal-mcell');
      if (mcell) { calCursor = parseDs(mcell.dataset.ds); calView = 'week'; renderCal(); return; }
      const ymonth = e.target.closest('.cal-ymonth');
      if (ymonth) { calCursor = new Date(calCursor.getFullYear(), parseInt(ymonth.dataset.month, 10), 1); calView = 'month'; renderCal(); return; }
      const adcell = e.target.closest('.cal-wk-ad-cell');
      if (adcell) { openCalSheet(adcell.dataset.ds, null); return; }
      const col = e.target.closest('.cal-daycol');
      if (col) {
        const rect = col.getBoundingClientRect();
        const y = e.clientY - rect.top;
        let mins = START_HOUR * 60 + Math.round((y / HOURPX) * 60 / 15) * 15;
        mins = clamp(mins, 0, 23 * 60 + 45);
        openCalSheet(col.dataset.ds, null, pad(Math.floor(mins / 60)) + ':' + pad(mins % 60));
      }
    });

    // Calendar sheet
    $('calfType').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; calSheetType = b.dataset.k; setSeg($('calfType'), calSheetType); calTimeFieldVis(); });
    $('calfDomain').addEventListener('click', e => { const p = e.target.closest('.go-pill'); if (!p) return; calSheetDomain = p.dataset.k; setPill($('calfDomain'), calSheetDomain); });
    $('calfSave').addEventListener('click', saveCalSheet);
    $('calfCancel').addEventListener('click', () => closeOverlay('calSheetOverlay'));
    $('calfDelete').addEventListener('click', deleteCalItem);

    // Goals grid delegation
    $('lgGrid').addEventListener('click', e => {
      if (e.target.closest('#lgAddCard')) { openGoalEdit(null); return; }
      const card = e.target.closest('.lg-card'); if (card) openGoalDetail(card.dataset.id);
    });
    $('lgGrid').addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.closest('#lgAddCard')) { e.preventDefault(); openGoalEdit(null); return; }
      const card = e.target.closest('.lg-card'); if (card) { e.preventDefault(); openGoalDetail(card.dataset.id); }
    });

    // Goal detail delegation
    $('lgDetailOverlay').addEventListener('click', e => {
      const btn = e.target.closest('[data-act]'); if (!btn || !openGoalId) return;
      const act = btn.dataset.act, gid = openGoalId;
      if (act === 'log') addLog(gid, parseFloat(btn.dataset.v));
      else if (act === 'logcustom') { const g = getGoal(gid); const what = g.type === 'time' ? 'minutes' : (g.unit || 'count'); const n = parseFloat(prompt('Log how many ' + what + '?', '')); if (!isNaN(n)) addLog(gid, n); }
      else if (act === 'timer') { isRunning(gid) ? finishTimer(gid) : startTimer(gid); }
      else if (act === 'reset') { if (confirm('Reset this goal for ' + periodLabel(getGoal(gid)) + '?')) resetPeriod(gid); }
      else if (act === 'edit') { closeOverlay('lgDetailOverlay'); openGoalEdit(gid); }
      else if (act === 'close') closeOverlay('lgDetailOverlay');
    });

    // Goal edit sheet
    $('lgfPeriod').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; goalPeriod = b.dataset.k; setSeg($('lgfPeriod'), goalPeriod); });
    $('lgfType').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; goalType = b.dataset.k; setSeg($('lgfType'), goalType); goalTypeVis(); });
    $('lgfDomain').addEventListener('click', e => { const p = e.target.closest('.go-pill'); if (!p) return; goalDomain = p.dataset.k; setPill($('lgfDomain'), goalDomain); });
    $('lgfSave').addEventListener('click', saveGoalEdit);
    $('lgfCancel').addEventListener('click', () => closeOverlay('lgEditOverlay'));
    $('lgfDelete').addEventListener('click', deleteGoal);

    // Backdrop + escape
    ['calSheetOverlay', 'lgDetailOverlay', 'lgEditOverlay'].forEach(oid => {
      $(oid).addEventListener('click', e => { if (e.target === $(oid)) closeOverlay(oid); });
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAllOverlays(); });

    // Cross-tab / cross-device updates
    ['goals-changed', 'calendar-changed', 'lifegoals-changed'].forEach(ev => window.addEventListener(ev, () => { if (sub === 'cal') renderCal(); else renderGoals(); }));

    // Deep link
    if (location.hash === '#goals') showSub('goals');
    else showSub('cal');

    renderCal(); renderGoals();
    if (anyTimerRunning()) ensureTick();
    [350, 1200, 2600].forEach(ms => setTimeout(() => { if (sub === 'cal') renderCal(); else renderGoals(); }, ms));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

'use strict';

/*
 * ═══════════════════════════════════════════════════════════
 *  SETUP — fill in your Supabase credentials below.
 *
 *  1. Create a project at https://supabase.com (free tier).
 *
 *  2. In the SQL editor, run:
 *
 *     CREATE TABLE goals (
 *       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 *       user_id uuid REFERENCES auth.users NOT NULL,
 *       date text NOT NULL,
 *       data jsonb NOT NULL DEFAULT '[]'::jsonb,
 *       updated_at timestamptz DEFAULT now(),
 *       UNIQUE(user_id, date)
 *     );
 *     CREATE TABLE streak (
 *       user_id uuid PRIMARY KEY REFERENCES auth.users,
 *       data jsonb NOT NULL DEFAULT '{}'::jsonb
 *     );
 *     ALTER TABLE goals  ENABLE ROW LEVEL SECURITY;
 *     ALTER TABLE streak ENABLE ROW LEVEL SECURITY;
 *     CREATE POLICY "own goals"  ON goals  FOR ALL USING (auth.uid() = user_id);
 *     CREATE POLICY "own streak" ON streak FOR ALL USING (auth.uid() = user_id);
 *     ALTER PUBLICATION supabase_realtime ADD TABLE goals;
 *     ALTER PUBLICATION supabase_realtime ADD TABLE streak;
 *
 *  2b. For the Gym tab (and any future localStorage-synced tab), also run:
 *
 *     CREATE TABLE IF NOT EXISTS public.app_state (
 *       user_id    uuid REFERENCES auth.users NOT NULL,
 *       app_key    text NOT NULL,
 *       payload    jsonb NOT NULL DEFAULT '{}',
 *       updated_at timestamptz DEFAULT now(),
 *       PRIMARY KEY (user_id, app_key)
 *     );
 *     ALTER TABLE public.app_state ENABLE ROW LEVEL SECURITY;
 *     CREATE POLICY "own app state" ON public.app_state FOR ALL USING (auth.uid() = user_id);
 *     ALTER PUBLICATION supabase_realtime ADD TABLE public.app_state;
 *
 *  3. Authentication → Providers → Google → Enable.
 *     Add your Google OAuth client ID + secret.
 *     (Create credentials at console.cloud.google.com)
 *
 *  4. Authentication → URL Configuration:
 *     Site URL = https://your-site.netlify.app
 *     Add that URL to Redirect URLs too.
 *
 *  5. Project Settings → API → copy the values below.
 * ═══════════════════════════════════════════════════════════
 */
const SUPABASE_URL      = 'https://vffdvrfppadopcwhzjug.supabase.co';   // e.g. 'https://abcdefgh.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZmZmR2cmZwcGFkb3Bjd2h6anVnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NzM2NjYsImV4cCI6MjA5NDI0OTY2Nn0.kcq6L07PLnagMevFdh_kXskKD7PjjYMkiXMgEWdcFH8';   // your anon/public key
const ANTHROPIC_API_KEY = '';   // optional — for ✨ Polish

const DUMBBELL_LADDER = [2.5,3.5,4.5,5.5,6.5,8,9,10,11.5,13.5,16,18,20.5,22.5,24];

function dbLadderNext(ladder, currentWeight, steps = 1) {
  const sorted = [...ladder].sort((a,b) => a - b);
  let idx = sorted.findIndex(w => Math.abs(w - currentWeight) < 0.01);
  if (idx === -1) {
    idx = sorted.reduce((best, w, i) => Math.abs(w - currentWeight) < Math.abs(sorted[best] - currentWeight) ? i : best, 0);
  }
  return sorted[Math.min(idx + steps, sorted.length - 1)];
}

function dbLadderPrev(ladder, currentWeight, steps = 1) {
  const sorted = [...ladder].sort((a,b) => a - b);
  let idx = sorted.findIndex(w => Math.abs(w - currentWeight) < 0.01);
  if (idx === -1) {
    idx = sorted.reduce((best, w, i) => Math.abs(w - currentWeight) < Math.abs(sorted[best] - currentWeight) ? i : best, 0);
  }
  return sorted[Math.max(idx - steps, 0)];
}

const WAKE_HOUR  = 8;
const SLEEP_HOUR = 24;

// ── State ──────────────────────────────────────────────────
const cache = {};        // mirrors remote DB, keyed like localStorage
let currentUser   = null;
let db            = null; // Supabase client
let realtimeSub   = null;
const _isLocal    = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'file:';
const useSupabase = !!(SUPABASE_URL && SUPABASE_ANON_KEY) && !_isLocal;

// ── Sync dot ───────────────────────────────────────────────
const syncDot = document.getElementById('syncDot');
function setSyncing(on) { if (syncDot) syncDot.className = 'sync-dot' + (on ? ' syncing' : ''); }
function setSyncError()  { if (syncDot) syncDot.className = 'sync-dot error'; setTimeout(() => setSyncing(false), 3000); }

// ── Storage layer ──────────────────────────────────────────
// storeGet / storeSet are synchronous (operate on cache or localStorage).
// Supabase writes are fire-and-forget async.

function storeGet(key) {
  if (useSupabase) return cache[key] !== undefined ? cache[key] : null;
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

// Misc per-key stores that have no dedicated table/sync of their own (habits,
// daily habit logs, supplement config + daily intake). Without this they would
// live only in the in-memory cache when signed in and silently vanish on every
// reload — which is why habits appeared to "reset" each day. Mirrored into the
// shared app_state table under a `kv:` prefix so they persist + sync per device.
function isGenericSyncKey(key) {
  return key === 'habits'
      || key === 'supp_config'
      || key.indexOf('habit-log:') === 0
      || key.indexOf('supp_taken:') === 0;
}

function storeSet(key, value) {
  if (useSupabase) {
    cache[key] = value;
    if (key.startsWith('goals:'))      syncGoalDay(key.slice(6), value);
    else if (key === 'goal_streak_v1') syncStreak(value);
    else if (key === 'inbox')          syncInbox(value);
    else if (key === 'calendar')       syncAppStateKey('calendar', value);
    else if (key === 'lifegoals')      syncAppStateKey('lifegoals', value);
    else if (isGenericSyncKey(key))    syncAppStateKey('kv:' + key, value);
  } else {
    localStorage.setItem(key, JSON.stringify(value));
  }
  if (key.startsWith('goals:')) window.dispatchEvent(new CustomEvent('goals-changed'));
  if (key === 'inbox')          window.dispatchEvent(new CustomEvent('inbox-changed'));
  if (key === 'calendar')       window.dispatchEvent(new CustomEvent('calendar-changed'));
  if (key === 'lifegoals')      window.dispatchEvent(new CustomEvent('lifegoals-changed'));
}

function storeDelete(key) {
  if (useSupabase) {
    delete cache[key];
    if (key.startsWith('goals:')) deleteGoalDay(key.slice(6));
  } else {
    localStorage.removeItem(key);
  }
}

function storeListKeys(prefix) {
  if (useSupabase) return Object.keys(cache).filter(k => k.startsWith(prefix));
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i); if (k && k.startsWith(prefix)) out.push(k);
  }
  return out;
}

// ── Supabase sync helpers (async, fire-and-forget) ─────────
async function syncGoalDay(date, data) {
  if (!db || !currentUser) return;
  setSyncing(true);
  try {
    await db.from('goals').upsert(
      { user_id: currentUser.id, date, data, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,date' }
    );
  } catch { setSyncError(); } finally { setSyncing(false); }
}
async function deleteGoalDay(date) {
  if (!db || !currentUser) return;
  setSyncing(true);
  try { await db.from('goals').delete().eq('user_id', currentUser.id).eq('date', date); }
  catch { setSyncError(); } finally { setSyncing(false); }
}
async function syncStreak(data) {
  if (!db || !currentUser) return;
  try { await db.from('streak').upsert({ user_id: currentUser.id, data }, { onConflict: 'user_id' }); }
  catch { /* streak sync failure is non-critical */ }
}
async function syncInbox(data) {
  if (!db || !currentUser) return;
  setSyncing(true);
  try {
    await db.from('app_state').upsert(
      { user_id: currentUser.id, app_key: 'inbox', payload: data, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,app_key' }
    );
  } catch { setSyncError(); } finally { setSyncing(false); }
}
// Generic app_state writer for simple JSON stores (calendar templates, life-goals).
async function syncAppStateKey(appKey, data) {
  if (!db || !currentUser) return;
  setSyncing(true);
  try {
    await db.from('app_state').upsert(
      { user_id: currentUser.id, app_key: appKey, payload: data, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,app_key' }
    );
  } catch { setSyncError(); } finally { setSyncing(false); }
}

// ── Load all data from Supabase into cache ─────────────────
// Fetches everything in two parallel queries so bootApp() starts
// with fully-populated localStorage/cache on any device.
async function loadAllFromSupabase() {
  if (!db || !currentUser) return;
  const [goalsRes, streakRes, appStateRes] = await Promise.all([
    db.from('goals').select('date,data').eq('user_id', currentUser.id),
    db.from('streak').select('data').eq('user_id', currentUser.id).maybeSingle(),
    db.from('app_state').select('app_key,payload').eq('user_id', currentUser.id)
  ]);
  if (goalsRes.data)  goalsRes.data.forEach(r => { cache[`goals:${r.date}`] = r.data; });
  if (streakRes.data) cache['goal_streak_v1'] = streakRes.data.data;
  if (appStateRes.data) {
    appStateRes.data.forEach(({ app_key, payload }) => {
      if (!payload) return;
      // Gym state, weight tracker, health metrics, water — read via localStorage directly
      if (app_key === 'gym')            localStorage.setItem('po_coach_v1',      JSON.stringify(payload));
      else if (app_key === 'gym-weights')    localStorage.setItem('po_coach_weights', JSON.stringify(payload));
      else if (app_key === 'health-metrics') localStorage.setItem('health-metrics',   JSON.stringify(payload));
      else if (app_key === 'health-water')   localStorage.setItem('health-water',      JSON.stringify(payload));
      // Nutrition — read via storeGet (cache)
      else if (app_key === 'nutrition-macros') {
        if (payload.goals) cache['nutrition:goals'] = payload.goals;
        Object.keys(payload).filter(k => k.startsWith('macros:')).forEach(k => { cache[k] = payload[k]; });
      }
      // Inbox — read via storeGet (cache)
      else if (app_key === 'inbox') cache['inbox'] = payload;
      // Calendar templates + life-goals — read via storeGet (cache)
      else if (app_key === 'calendar')  cache['calendar']  = payload;
      else if (app_key === 'lifegoals') cache['lifegoals'] = payload;
      // Generic kv: stores (habits, habit logs, supplements) — read via storeGet (cache)
      else if (app_key.indexOf('kv:') === 0) cache[app_key.slice(3)] = payload;
      // Finance extras (FX rate, accounts, txn→account map, wishlist, local subs)
      // — read via localStorage directly by the finance helpers
      else if (app_key === 'finance:fx')           localStorage.setItem('po_finance_fx', String(payload));
      else if (app_key === 'finance:accounts')     localStorage.setItem('po_finance_accounts', JSON.stringify(payload || []));
      else if (app_key === 'finance:txn_accounts') localStorage.setItem('po_finance_txn_accounts', JSON.stringify(payload || {}));
      else if (app_key === 'finance:wishlist')     localStorage.setItem('po_finance_wishlist', JSON.stringify(payload || []));
      else if (app_key === 'finance:subs')         localStorage.setItem('po_finance_subs', JSON.stringify(payload || []));
    });
  }
}

// ── Real-time subscription ─────────────────────────────────
function subscribeRealtime() {
  if (!db || !currentUser) return;
  realtimeSub = db.channel('dashboard-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'goals',
        filter: `user_id=eq.${currentUser.id}` }, payload => {
      if (payload.eventType === 'DELETE') delete cache[`goals:${payload.old.date}`];
      else cache[`goals:${payload.new.date}`] = payload.new.data;
      loadToday(); loadTomorrow();
      window.dispatchEvent(new CustomEvent('goals-changed'));
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'streak',
        filter: `user_id=eq.${currentUser.id}` }, payload => {
      if (payload.new) cache['goal_streak_v1'] = payload.new.data;
      renderStreak();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'app_state',
        filter: `user_id=eq.${currentUser.id}` }, payload => {
      const key = payload.new?.app_key;
      const incoming = payload.new?.payload;
      if (key === GYM_APP_KEY) {
        if (JSON.stringify(incoming) === gymLastPushedJson) return;
        gymLastPushedJson = JSON.stringify(incoming);
        if (gymIsTyping) gymPendingRmt = incoming;
        else applyGymRemote(incoming);
      } else if (key === WT_APP_KEY) {
        if (JSON.stringify(incoming) === wtLastPushedJson) return;
        wtLastPushedJson = JSON.stringify(incoming);
        applyWtRemote(incoming);
        waterGoalRender(); waterWidgetRender();
      } else if (key === HEALTH_METRICS_APP_KEY) {
        if (JSON.stringify(incoming) === healthMetricsLastJson) return;
        healthMetricsLastJson = JSON.stringify(incoming);
        applyHealthMetricsRemote(incoming);
      } else if (key === HEALTH_WATER_APP_KEY) {
        if (JSON.stringify(incoming) === healthWaterLastJson) return;
        healthWaterLastJson = JSON.stringify(incoming);
        applyWaterRemote(incoming);
      } else if (key === NUTRITION_APP_KEY) {
        if (JSON.stringify(incoming) === nutLastPushedJson) return;
        nutLastPushedJson = JSON.stringify(incoming);
        applyNutritionRemote(incoming);
      } else if (key === 'inbox') {
        cache['inbox'] = incoming;
        window.dispatchEvent(new CustomEvent('inbox-changed'));
      } else if (key === 'calendar') {
        cache['calendar'] = incoming;
        window.dispatchEvent(new CustomEvent('calendar-changed'));
      } else if (key === 'lifegoals') {
        cache['lifegoals'] = incoming;
        window.dispatchEvent(new CustomEvent('lifegoals-changed'));
      } else if (key && key.indexOf('kv:') === 0) {
        const lk = key.slice(3);
        cache[lk] = incoming;
        if (lk === 'habits' || lk.indexOf('habit-log:') === 0) {
          if (typeof window.renderTasksHabits === 'function') window.renderTasksHabits();
        } else if (lk === 'supp_config' || lk.indexOf('supp_taken:') === 0) {
          if (typeof window._renderSupplements === 'function') window._renderSupplements();
        }
      } else if (key && key.indexOf('finance:') === 0) {
        if (key === 'finance:fx')                localStorage.setItem('po_finance_fx', String(incoming));
        else if (key === 'finance:accounts')     { localStorage.setItem('po_finance_accounts', JSON.stringify(incoming || [])); finAccounts = incoming || []; }
        else if (key === 'finance:txn_accounts') localStorage.setItem('po_finance_txn_accounts', JSON.stringify(incoming || {}));
        else if (key === 'finance:wishlist')     localStorage.setItem('po_finance_wishlist', JSON.stringify(incoming || []));
        else if (key === 'finance:subs')         { localStorage.setItem('po_finance_subs', JSON.stringify(incoming || [])); if (!finSubsRemote) finSubs = incoming || []; }
        if (typeof renderFinance === 'function')       renderFinance();
        if (typeof renderSubscriptions === 'function') renderSubscriptions();
        if (typeof renderBudgets === 'function')       renderBudgets();
        if (typeof renderNetWorth === 'function')      renderNetWorth();
      }
    })
    .subscribe();
}

// ── Date helpers ───────────────────────────────────────────
function getActiveDateString() {
  const now = new Date();
  if (now.getHours() < 6) { const d = new Date(now); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10); }
  return now.toISOString().slice(0,10);
}
function getTomorrowDateString() {
  const now = new Date();
  if (now.getHours() < 6) return now.toISOString().slice(0,10);
  const d = new Date(now); d.setDate(d.getDate()+1); return d.toISOString().slice(0,10);
}
function formatDate(s) {
  const [y,m,day] = s.split('-').map(Number); const d = new Date(y,m-1,day);
  const wd=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'], mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${wd[d.getDay()]}, ${mo[d.getMonth()]} ${d.getDate()}`;
}

// ── Rollover ───────────────────────────────────────────────
function runRollover() {
  const active = getActiveDateString();
  const today  = storeGet(`goals:${active}`) || [];
  const texts  = new Set(today.map(g => g.text));
  let changed  = false;
  storeListKeys('goals:').forEach(key => {
    const date = key.slice(6);
    if (date === 'tomorrow' || date === 'review') return; // not real day stores
    if (date >= active) return;
    (storeGet(key) || []).forEach(g => {
      if (g.done) return;
      // Recurring calendar/template items re-materialize on their own day —
      // never roll them over or they pile up as duplicates of today's blocks.
      if (g.tplId || g.cal) return;
      if (texts.has(g.text)) return;                       // de-dupe by text
      const carried = Object.assign({}, g, { done: false });
      delete carried.id;                                   // fresh id assigned on next render
      delete carried.doneAt;
      today.push(carried);
      texts.add(g.text); changed = true;
    });
    storeDelete(key);
  });
  if (changed) {
    cache[`goals:${active}`] = today;
    syncGoalDay(active, today);
  }
}

// ── Streak ─────────────────────────────────────────────────
function runStreakCheck() {
  const active = getActiveDateString();
  const data   = storeGet('goal_streak_v1') || { count: 0, lastProcessedDate: null };
  let { count, lastProcessedDate } = data;
  storeListKeys('goals:').map(k => k.slice(6)).filter(d => d < active).sort().forEach(date => {
    if (lastProcessedDate && date <= lastProcessedDate) return;
    const goals = storeGet(`goals:${date}`) || [];
    if (goals.length > 0) { if (goals.every(g => g.done)) count++; else count = 0; }
    lastProcessedDate = date;
  });
  storeSet('goal_streak_v1', { count, lastProcessedDate });
}

// ── Ticker ─────────────────────────────────────────────────
function initTicker() {
  let cycleIdx = 0;
  function getItems() {
    const goals = storeGet(`goals:${getActiveDateString()}`) || [];
    const total = goals.length, done = goals.filter(g=>g.done).length;
    let items;
    if (total===0)         items=[{status:'empty',  text:'No goals set for today — add one to get rolling.'}];
    else if (done===total) items=[{status:'done',   text:'✓ All goals done — solid day.'}];
    else                   items=goals.filter(g=>!g.done).map(g=>({status:'pending',text:g.text}));
    return {items,done,total};
  }
  function glyph(s){return s==='done'?'✓':s==='pending'?'○':'·';}
  function tick(first) {
    const {items,done,total}=getItems();
    const stage=document.getElementById('goalTickerStage'), meta=document.getElementById('goalTickerMeta');
    if (!stage) return;
    meta.textContent=`${done}/${total}`;
    const item=items[cycleIdx%items.length]; cycleIdx=(cycleIdx+1)%items.length;
    const row=document.createElement('div'); row.className='goal-ticker-row';
    const st=document.createElement('span'); st.className='goal-ticker-status'; st.dataset.status=item.status; st.textContent=glyph(item.status);
    const tx=document.createElement('span'); tx.className='goal-ticker-text'; tx.textContent=item.text;
    row.appendChild(st); row.appendChild(tx);
    const all=[...stage.querySelectorAll('.goal-ticker-row')];
    if (first || all.length===0) {
      all.forEach(r=>r.remove()); stage.appendChild(row);
    } else {
      // Remove any extra stale rows, animate out only the last visible one
      all.slice(0,-1).forEach(r=>r.remove());
      const visible=all[all.length-1];
      visible.classList.add('is-leaving'); setTimeout(()=>visible.remove(),460);
      row.classList.add('is-entering'); stage.appendChild(row);
      setTimeout(()=>row.classList.remove('is-entering'),450);
    }
  }
  tick(true); setInterval(tick,5000);
  let tickDebounce=null;
  window.addEventListener('goals-changed',()=>{cycleIdx=0;clearTimeout(tickDebounce);tickDebounce=setTimeout(()=>tick(false),60);});
}

// ── Day Ring ───────────────────────────────────────────────
function initDayRing() {
  const C=2*Math.PI*52;
  const sc=[[255,216,158],[255,205,121],[255,227,143],[255,183,106],[255,149,89],[243,111,79],[226,93,122],[123,91,176],[47,58,102]];
  function lerp(pct){const t=Math.min(pct,100)/12.5,lo=Math.floor(t),hi=Math.min(lo+1,8),f=t-lo,c0=sc[lo],c1=sc[hi];return`rgb(${Math.round(c0[0]+(c1[0]-c0[0])*f)},${Math.round(c0[1]+(c1[1]-c0[1])*f)},${Math.round(c0[2]+(c1[2]-c0[2])*f)})`;}
  function clk(n){let h=n.getHours();const m=String(n.getMinutes()).padStart(2,'0'),ap=h>=12?'PM':'AM';h=h%12||12;return`${h}:${m} ${ap}`;}
  function fmt(m){const h=Math.floor(m/60),r=Math.round(m%60);if(h&&r)return`${h}h ${r}m`;if(h)return`${h}h`;return`${r}m`;}
  const fill=document.getElementById('dayRingFill'),pct=document.getElementById('dayRingPercent'),ph=document.getElementById('dayRingPhase'),cl=document.getElementById('dayRingClock'),st=document.getElementById('dayRingStatus'),re=document.getElementById('dayRingRemaining');
  if(fill){fill.style.strokeDasharray=C;fill.style.strokeDashoffset=C;}
  function upd(){
    const now=new Date(),h=now.getHours()+now.getMinutes()/60+now.getSeconds()/3600;
    if(cl)cl.textContent=clk(now);
    if(h<WAKE_HOUR){if(fill){fill.style.stroke='#4D4B47';fill.style.strokeDashoffset=C;}if(pct)pct.textContent='—';if(ph)ph.textContent='SLEEPING';if(st)st.textContent='😴 Still sleeping';if(re)re.textContent=`${fmt((WAKE_HOUR-h)*60)} until wake-up`;}
    else if(h>=SLEEP_HOUR){if(fill){fill.style.stroke='#E25D7A';fill.style.strokeDashoffset=0;}if(pct)pct.textContent='100%';if(ph)ph.textContent='PAST BEDTIME';if(st)st.textContent='⚠️ Past bedtime';if(re)re.textContent='Sleep!';}
    else{const p=(h-WAKE_HOUR)/(SLEEP_HOUR-WAKE_HOUR)*100;if(fill){fill.style.stroke=lerp(p);fill.style.strokeDashoffset=C*(1-p/100);}if(pct)pct.textContent=`${Math.round(p)}%`;let phase,status;if(p<25){phase='MORNING';status='☀️ Morning — fresh start';}else if(p<50){phase='MIDDAY';status='⚡ Midday — keep moving';}else if(p<75){phase='AFTERNOON';status='🔥 Afternoon — push it';}else if(p<90){phase='EVENING';status='⏳ Evening — wrap up';}else{phase='BEDTIME';status='🌙 Bedtime soon';}if(ph)ph.textContent=phase;if(st)st.textContent=status;if(re)re.textContent=`${fmt((SLEEP_HOUR-h)*60)} awake time left`;}
  }
  upd(); setInterval(upd,60*1000);
}

// ── Render helpers ─────────────────────────────────────────
function renderTodayHeader() {
  const goals=storeGet(`goals:${getActiveDateString()}`)||[],total=goals.length,done=goals.filter(g=>g.done).length;
  const num=document.getElementById('gmProgressNum'),tot=document.getElementById('gmProgressTotal'),lbl=document.getElementById('gmProgressLabel'),bar=document.getElementById('gmBar'),card=document.getElementById('gmCard'),push=document.getElementById('gmPushBtn');
  if(num)num.textContent=done; if(tot)tot.textContent=`/ ${total}`;
  if(lbl)lbl.textContent=total===0?'no goals yet':done===total?'all done — solid day':'complete';
  if(bar){bar.innerHTML='';goals.forEach(g=>{const s=document.createElement('div');s.className='gm-bar-seg'+(g.done?' gm-bar-seg-done':'');bar.appendChild(s);});}
  if(card)card.classList.toggle('gm-all-done',total>0&&done===total);
  if(push)push.style.display=(total>0&&done<total)?'block':'none';
}
function renderStreak(){const{count=0}=storeGet('goal_streak_v1')||{};const el=document.getElementById('gmStreak'),n=document.getElementById('gmStreakNum');if(n)n.textContent=count;if(el)el.classList.toggle('gm-streak-active',count>0);}
function renderTomorrowCount(){const goals=storeGet(`goals:${getTomorrowDateString()}`)||[];const el=document.getElementById('gmTomorrowCount');if(el)el.textContent=goals.length===1?'1 planned':`${goals.length} planned`;}

// ── Inline edit ────────────────────────────────────────────
function makeInlineEdit(textEl,idx,key,reload){
  textEl.addEventListener('click',()=>{
    if(textEl.contentEditable==='true')return;
    const orig=textEl.textContent; textEl.contentEditable='true'; textEl.focus();
    const r=document.createRange();r.selectNodeContents(textEl);r.collapse(false);const s=window.getSelection();s.removeAllRanges();s.addRange(r);
    function commit(){const t=textEl.textContent.trim();textEl.contentEditable='false';if(t&&t!==orig){const goals=storeGet(key)||[];if(goals[idx]){goals[idx].text=t;storeSet(key,goals);reload();}}else if(!t)textEl.textContent=orig;}
    function cancel(){textEl.textContent=orig;textEl.contentEditable='false';}
    textEl.addEventListener('blur',commit,{once:true});
    textEl.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();commit();}if(e.key==='Escape'){e.preventDefault();cancel();textEl.removeEventListener('blur',commit);}});
  });
}

// ── Drag reorder ───────────────────────────────────────────
function wireDragReorder(listEl,key,reload){
  if(!listEl)return;
  let di=null;
  listEl.addEventListener('dragstart',e=>{const it=e.target.closest('[data-idx]');if(!it)return;di=parseInt(it.dataset.idx);e.dataTransfer.effectAllowed='move';});
  listEl.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='move';const it=e.target.closest('[data-idx]');listEl.querySelectorAll('[data-idx]').forEach(el=>el.classList.remove('drag-over'));if(it)it.classList.add('drag-over');});
  listEl.addEventListener('dragleave',e=>{if(!listEl.contains(e.relatedTarget))listEl.querySelectorAll('[data-idx]').forEach(el=>el.classList.remove('drag-over'));});
  listEl.addEventListener('drop',e=>{e.preventDefault();listEl.querySelectorAll('[data-idx]').forEach(el=>el.classList.remove('drag-over'));const it=e.target.closest('[data-idx]');if(!it||di===null)return;const ti=parseInt(it.dataset.idx);if(ti===di){di=null;return;}const goals=storeGet(key)||[];const[mv]=goals.splice(di,1);goals.splice(ti,0,mv);storeSet(key,goals);di=null;reload();});
  listEl.addEventListener('dragend',()=>{di=null;listEl.querySelectorAll('[data-idx]').forEach(el=>el.classList.remove('drag-over'));});
}

// ── Build goal row ─────────────────────────────────────────
function buildGoalRow(goal,idx,key,readOnly,reload){
  const li=document.createElement('li');
  li.className='goal-item'+(goal.done?' goal-done':'')+(goal.queued&&!goal.done?' goal-queued':'');
  li.dataset.idx=idx; li.draggable=!readOnly;
  const handle=document.createElement('span');handle.className='goal-drag-handle';handle.textContent='⋮⋮';if(readOnly)handle.style.visibility='hidden';
  const cbWrap=document.createElement('label');cbWrap.className='goal-checkbox-wrap';
  const cb=document.createElement('input');cb.type='checkbox';cb.checked=goal.done;if(readOnly){cb.disabled=true;cb.title='Activates at 6 AM tomorrow';}
  const cbc=document.createElement('span');cbc.className='goal-checkbox-custom';cbWrap.appendChild(cb);cbWrap.appendChild(cbc);
  cb.addEventListener('change',()=>{const goals=storeGet(key)||[];if(goals[idx]){goals[idx].done=cb.checked;if(cb.checked)goals[idx].doneAt=Date.now();else delete goals[idx].doneAt;storeSet(key,goals);}reload();});
  const tx=document.createElement('span');tx.className='goal-text';tx.textContent=goal.text;if(!readOnly)makeInlineEdit(tx,idx,key,reload);
  const qb=document.createElement('button');qb.className='gm-queue-btn'+(goal.queued?' queue-active':'');qb.textContent='⚡';qb.title='Queue for productivity window';if(readOnly)qb.disabled=true;
  qb.addEventListener('click',()=>{const goals=storeGet(key)||[];if(goals[idx]){goals[idx].queued=!goals[idx].queued;storeSet(key,goals);}li.classList.add('is-queue-flashing');setTimeout(reload,480);});
  const del=document.createElement('button');del.className='goal-delete';del.textContent='×';del.title='Delete';
  del.addEventListener('click',()=>{const goals=storeGet(key)||[];goals.splice(idx,1);storeSet(key,goals);reload();});
  li.appendChild(handle);li.appendChild(cbWrap);li.appendChild(tx);li.appendChild(qb);li.appendChild(del);
  return li;
}

// ── Render list ────────────────────────────────────────────
function renderListInto(goals,listEl,emptyEl,key,readOnly,reload){
  if(!listEl)return;
  listEl.innerHTML='';
  const old=listEl.parentElement.querySelector('.show-more-toggle');if(old)old.remove();
  if(goals.length===0){if(emptyEl)emptyEl.style.display='';if(key===`goals:${getActiveDateString()}`)renderTodayHeader();else renderTomorrowCount();return;}
  if(emptyEl)emptyEl.style.display='none';
  goals.slice(0,5).forEach((g,i)=>listEl.appendChild(buildGoalRow(g,i,key,readOnly,reload)));
  if(goals.length>5){
    let exp=false;const tog=document.createElement('button');tog.className='show-more-toggle';tog.textContent=`Show ${goals.length-5} more ▾`;
    const rows=goals.slice(5).map((g,i)=>buildGoalRow(g,i+5,key,readOnly,reload));
    tog.addEventListener('click',()=>{exp=!exp;if(exp){rows.forEach(r=>listEl.appendChild(r));tog.textContent='Show less ▴';}else{rows.forEach(r=>{if(listEl.contains(r))listEl.removeChild(r);});tog.textContent=`Show ${goals.length-5} more ▾`;}});
    listEl.after(tog);
  }
  if(key===`goals:${getActiveDateString()}`)renderTodayHeader();else renderTomorrowCount();
}

// ── Load ───────────────────────────────────────────────────
const todayKey    = `goals:${getActiveDateString()}`;
const tomorrowKey = `goals:${getTomorrowDateString()}`;
function loadToday(){const g=storeGet(todayKey)||[];renderTodayHeader();if(typeof window.renderTasksSpine==='function'){window.renderTasksSpine();}else{renderListInto(g,document.getElementById('goalList'),document.getElementById('emptyState'),todayKey,false,loadToday);}}
function loadTomorrow(){const g=storeGet(tomorrowKey)||[];renderListInto(g,document.getElementById('tomorrowList'),document.getElementById('tomorrowEmptyState'),tomorrowKey,true,loadTomorrow);}

// ── Add + Polish ───────────────────────────────────────────
function makeAddHandlers(inp,addBtn,polishBtn,key,statusEl,reload){
  if(!inp||!addBtn) return;
  function add(text){text=text.trim();if(!text)return;const goals=storeGet(key)||[];goals.push({text,done:false});storeSet(key,goals);inp.value='';reload();}
  addBtn.addEventListener('click',()=>add(inp.value));
  inp.addEventListener('keydown',e=>{if(e.key==='Enter')add(inp.value);});
  if(!polishBtn) return;
  polishBtn.addEventListener('click',async()=>{
    const text=inp.value.trim();if(!text)return;
    if(!ANTHROPIC_API_KEY){add(text);if(statusEl){statusEl.textContent='Polish needs an Anthropic API key — added as-typed.';statusEl.style.color='';setTimeout(()=>{statusEl.textContent='';},3500);}return;}
    polishBtn.disabled=true;if(statusEl){statusEl.textContent='Polishing…';statusEl.style.color='';}
    try{const res=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},body:JSON.stringify({model:'claude-sonnet-4-5',max_tokens:1000,messages:[{role:'user',content:`Clean up this goal into a clear, concise, actionable task. Return ONLY a one-element JSON array of strings, no preamble, no fences. Goal: "${text}"`}]})});const data=await res.json();const polished=JSON.parse(data.content[0].text.trim())[0];const goals=storeGet(key)||[];goals.push({text:polished,done:false});storeSet(key,goals);inp.value='';reload();if(statusEl)statusEl.textContent='';}
    catch{add(text);if(statusEl){statusEl.textContent='Polish failed — added as-typed.';statusEl.style.color='var(--danger)';setTimeout(()=>{statusEl.textContent='';statusEl.style.color='';},3500);}}
    polishBtn.disabled=false;
  });
}

// ── Push remaining ─────────────────────────────────────────
document.getElementById('gmPushBtn')?.addEventListener('click',()=>{
  if(!confirm('Push all unchecked goals to tomorrow?'))return;
  const tod=storeGet(todayKey)||[],tom=storeGet(tomorrowKey)||[],texts=new Set(tom.map(g=>g.text));
  tod.filter(g=>!g.done).forEach(g=>{if(!texts.has(g.text)){tom.push({text:g.text,done:false});texts.add(g.text);}});
  storeSet(todayKey,tod.filter(g=>g.done));storeSet(tomorrowKey,tom);loadToday();loadTomorrow();
});

// ── Labels ─────────────────────────────────────────────────
function initLabels(){
  const tl=document.getElementById('todayLabel');
  if(tl) tl.textContent=`Today — ${formatDate(getActiveDateString())}`;
  const tml=document.getElementById('tomorrowLabel');
  if(tml) tml.textContent=`Plan tomorrow — ${formatDate(getTomorrowDateString())}`;
}

// ── UI boot (after auth) ───────────────────────────────────
function bootApp(user) {
  currentUser = user;
  const _uel = document.getElementById('userEmailEl'); if (_uel) _uel.textContent = user.email;
  document.getElementById('authOverlay').classList.add('hidden');
  document.getElementById('appContainer').classList.add('visible');
  initLabels();
  runRollover();
  runStreakCheck();
  initTicker();
  initDayRing();
  wireDragReorder(document.getElementById('goalList'),    todayKey,    loadToday);
  wireDragReorder(document.getElementById('tomorrowList'), tomorrowKey, loadTomorrow);
  makeAddHandlers(document.getElementById('goalInput'),     document.getElementById('goalAddBtn'),     document.getElementById('goalPolishBtn'),     todayKey,    document.getElementById('polishStatus'),   loadToday);
  makeAddHandlers(document.getElementById('tomorrowInput'), document.getElementById('tomorrowAddBtn'), document.getElementById('tomorrowPolishBtn'), tomorrowKey, document.getElementById('tomorrowStatus'), loadTomorrow);
  loadToday(); loadTomorrow(); renderStreak();
  initHabits();
  initFinance();
  initGym(); wtInit(); loadGymFromSupabase(); loadWtFromSupabase();
  initNutrition(); initNutritionPage(); loadNutFromSupabase();
  initHealth(); loadHealthMetricsFromSupabase(); loadWaterFromSupabase();
  if (window.initMuscleMap) initMuscleMap(loadGymState(), gymToday, () => loadGymState().workoutDone);
  subscribeRealtime();
  initWhoop();
  try { initGoalsSystem(); } catch (_) {}
}

// ── Auth ───────────────────────────────────────────────────
async function initAuth() {
  try {
  if (!useSupabase) {
    // Fallback: no auth, use localStorage
    document.getElementById('authOverlay').classList.add('hidden');
    document.getElementById('appContainer').classList.add('visible');
    const _uelL = document.getElementById('userEmailEl'); if (_uelL) _uelL.textContent = 'local only';
    const _sob = document.querySelector('.sign-out-btn'); if (_sob) _sob.style.display = 'none';
    const _sd = document.getElementById('syncDot'); if (_sd) _sd.style.display = 'none';
    initLabels(); runRollover(); runStreakCheck(); initTicker(); initDayRing();
    wireDragReorder(document.getElementById('goalList'),     todayKey,    loadToday);
    wireDragReorder(document.getElementById('tomorrowList'), tomorrowKey, loadTomorrow);
    makeAddHandlers(document.getElementById('goalInput'),     document.getElementById('goalAddBtn'),     document.getElementById('goalPolishBtn'),     todayKey,    document.getElementById('polishStatus'),   loadToday);
    makeAddHandlers(document.getElementById('tomorrowInput'), document.getElementById('tomorrowAddBtn'), document.getElementById('tomorrowPolishBtn'), tomorrowKey, document.getElementById('tomorrowStatus'), loadTomorrow);
    loadToday(); loadTomorrow(); renderStreak();
    initHabits();
    initFinance();
    initGym(); wtInit(); initNutrition(); initNutritionPage(); initHealth();
    if (window.initMuscleMap) initMuscleMap(loadGymState(), gymToday, () => loadGymState().workoutDone);
    renderWhoopWidgets();
    try { initGoalsSystem(); } catch (_) {}
    return;
  }

  const { createClient } = supabase;
  db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  document.getElementById('signInBtn').addEventListener('click', async () => {
    document.getElementById('authError').textContent = '';
    try {
      const { error } = await db.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.href }
      });
      if (error) document.getElementById('authError').textContent = error.message;
    } catch (e) { document.getElementById('authError').textContent = String(e); }
  });

  document.getElementById('signOutBtn')?.addEventListener('click', async () => {
    await db.auth.signOut();
  });

  const { data: { session: existingSession } } = await db.auth.getSession();
  if (existingSession?.user) {
    currentUser = existingSession.user;
    setSyncing(true);
    try { await loadAllFromSupabase(); } catch (_) {}
    setSyncing(false);
    bootApp(existingSession.user);
  } else {
    document.getElementById('authOverlay')?.classList.remove('hidden');
  }

  db.auth.onAuthStateChange(async (event, session) => {
    if (event === 'INITIAL_SESSION') return; // already handled by getSession()
    if (session?.user) {
      if (currentUser && currentUser.id === session.user.id) return; // already booted
      currentUser = session.user;
      setSyncing(true);
      try { await loadAllFromSupabase(); } catch (_) {}
      setSyncing(false);
      bootApp(session.user);
    } else if (event === 'SIGNED_OUT') {
      // Signed out — reset
      currentUser = null;
      Object.keys(cache).forEach(k => delete cache[k]);
      if (realtimeSub) { db.removeChannel(realtimeSub); realtimeSub = null; }
      document.getElementById('appContainer').classList.remove('visible');
      document.getElementById('authOverlay').classList.remove('hidden');
    }
  });
  } catch (err) {
    console.error('initAuth failed:', err);
    document.getElementById('authOverlay')?.classList.remove('hidden');
  }
}

// ── Habit Tracker ─────────────────────────────────────────
// Data stored in localStorage (independent of Supabase goals tables).
function habitLS(key, val) {
  if (val === undefined) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
  localStorage.setItem(key, JSON.stringify(val));
}
function getHabits()            { return habitLS('habits:list') || []; }
function getHabitLog(date)      { return habitLS(`habits:log:${date}`) || []; }
function setHabitLog(date, ids) { habitLS(`habits:log:${date}`, ids); }

function habitMonthDays() {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  const total = new Date(y, m + 1, 0).getDate(), pad = n => String(n).padStart(2, '0');
  const out = [];
  for (let d = 1; d <= total; d++) out.push(`${y}-${pad(m+1)}-${pad(d)}`);
  return out;
}

function renderHabits() {
  const container = document.getElementById('habitList');
  if (!container) return;
  const habits   = getHabits();
  const today    = getActiveDateString();
  const todayLog = getHabitLog(today);
  const allDays  = habitMonthDays();
  const pastDays = allDays.filter(d => d <= today);

  const titleEl = document.getElementById('habitSectionTitle');
  if (titleEl) {
    const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const now = new Date();
    titleEl.textContent = `Habits — ${mo[now.getMonth()]} ${now.getFullYear()}`;
  }

  container.innerHTML = '';
  if (habits.length === 0) {
    container.innerHTML = '<div class="empty-state">No habits yet — add one below.</div>';
    return;
  }

  habits.forEach(habit => {
    const doneToday = todayLog.includes(habit.id);
    const doneCount = pastDays.filter(d => getHabitLog(d).includes(habit.id)).length;

    const card = document.createElement('div');
    card.className = 'habit-card' + (doneToday ? ' habit-done' : '');

    // Header row
    const header = document.createElement('div');
    header.className = 'habit-card-header';

    const cbWrap = document.createElement('label'); cbWrap.className = 'habit-checkbox-wrap';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = doneToday;
    const cbc = document.createElement('span'); cbc.className = 'habit-checkbox-custom';
    cbWrap.append(cb, cbc);
    cb.addEventListener('change', () => {
      const log = getHabitLog(today), i = log.indexOf(habit.id);
      if (i === -1) log.push(habit.id); else log.splice(i, 1);
      setHabitLog(today, log); renderHabits();
    });

    const nameEl = document.createElement('span'); nameEl.className = 'habit-name'; nameEl.textContent = habit.name;
    const statsEl = document.createElement('span'); statsEl.className = 'habit-stats'; statsEl.textContent = `${doneCount}/${pastDays.length}`;

    const delBtn = document.createElement('button'); delBtn.className = 'habit-delete'; delBtn.textContent = '×'; delBtn.title = 'Remove habit';
    delBtn.addEventListener('click', () => {
      if (!confirm(`Remove "${habit.name}"?`)) return;
      habitLS('habits:list', getHabits().filter(h => h.id !== habit.id));
      renderHabits();
    });

    header.append(cbWrap, nameEl, statsEl, delBtn);

    // Month dot grid — one dot per day, full width
    const grid = document.createElement('div'); grid.className = 'habit-grid';
    allDays.forEach(d => {
      const dot = document.createElement('span'); dot.className = 'habit-dot';
      if (getHabitLog(d).includes(habit.id)) dot.classList.add('done');
      else if (d < today)                     dot.classList.add('missed');
      if (d === today)                        dot.classList.add('today');
      dot.title = d;
      grid.appendChild(dot);
    });

    card.append(header, grid);
    container.appendChild(card);
  });
}

function initHabits() {
  // The SPA's Tasks tab owns habits (its own `habits` / `habit-log:` stores).
  // This legacy tracker only applies when its original #habitList container is
  // present; otherwise bail so we don't double-bind the shared Add button.
  if (!document.getElementById('habitList')) return;
  const inp = document.getElementById('habitInput'), addBtn = document.getElementById('habitAddBtn');
  if (!inp || !addBtn) return;
  function addHabit() {
    const text = inp.value.trim(); if (!text) return;
    const list = getHabits();
    list.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: text });
    habitLS('habits:list', list); inp.value = ''; renderHabits();
  }
  addBtn.addEventListener('click', addHabit);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') addHabit(); });
  renderHabits();
}

// ── Finance ─────────────────────────────────────────────────
// Per-item currency (EUR/GBP) is converted to a single EUR "home" total.
const FIN_HOME = 'EUR';
const FIN_CATEGORIES = ['Food','Transport','Housing','Health','Entertainment','Shopping','Bills','Other'];
const FIN_CAT_COLOR = {
  Food:'#F08E7A', Transport:'#8AB6E8', Housing:'#B29EE8', Health:'#57E0A1',
  Entertainment:'#C47FE8', Shopping:'#F2C063', Bills:'#9AA8E8', Other:'#8E8C83'
};
const FIN_CAT_ICON = {
  Food:'<path d="M6 3v7a2 2 0 0 0 2 2 2 2 0 0 0 2-2V3"/><path d="M8 12v9"/><path d="M17 3a3 3 0 0 0-3 3v5h3"/><path d="M17 3v18"/>',
  Transport:'<path d="M5 13l1.4-4.2A2 2 0 0 1 8.3 7.5h7.4a2 2 0 0 1 1.9 1.3L19 13"/><path d="M4 17h16v-4H4z"/><circle cx="7.5" cy="17" r="1.4"/><circle cx="16.5" cy="17" r="1.4"/>',
  Housing:'<path d="M3 12L12 3l9 9"/><path d="M5 10v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9"/>',
  Health:'<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  Entertainment:'<circle cx="12" cy="12" r="9"/><polygon points="10 8 16 12 10 16 10 8"/>',
  Shopping:'<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  Bills:'<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1Z"/><path d="M8 7h8M8 11h8M8 15h5"/>',
  Other:'<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/>'
};
function finCatIcon(cat) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${FIN_CAT_ICON[cat] || FIN_CAT_ICON.Other}</svg>`;
}
function finCatColor(cat) { return FIN_CAT_COLOR[cat] || FIN_CAT_COLOR.Other; }
function finEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c])); }

let finTransactions = [];
let finBudgets      = [];
let finSubs         = [];
let finAccounts     = [];
let finSelectedType = 'expense';
// Subscriptions sync to Supabase when the `subscriptions` table exists; if it
// doesn't (migration not run), we fall back to localStorage so saving still works.
let finSubsRemote   = true;
function finSubsLocalLoad() { try { return JSON.parse(localStorage.getItem('po_finance_subs') || '[]'); } catch { return []; } }
function finSubsLocalSave(arr) { localStorage.setItem('po_finance_subs', JSON.stringify(arr)); syncAppStateKey('finance:subs', arr); }
function finSubIsLocalId(id) { return typeof id === 'string' && id.startsWith('loc-'); }
function finSubLocalId() { return 'loc-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ── Currency / FX ──
function finFxRate() {            // GBP per €1 (editable approximation)
  const v = parseFloat(localStorage.getItem('po_finance_fx'));
  return (v && v > 0) ? v : 0.86;
}
function finFxSave(v) { localStorage.setItem('po_finance_fx', String(v)); syncAppStateKey('finance:fx', Number(v)); }
function finCurSym(cur) { return cur === 'GBP' ? '£' : '€'; }
function finToHome(amount, cur) { // convert any item's amount into EUR home
  const n = Number(amount) || 0;
  return cur === 'GBP' ? n / finFxRate() : n;
}
function finFmtHome(n) {           // EUR home total, rounded (no cents)
  const v = Math.round(Number(n) || 0);
  return (v < 0 ? '-' : '') + '€' + Math.abs(v).toLocaleString('en-IE');
}
function finFmtHome2(n) {          // EUR home with cents
  const v = Number(n) || 0;
  return (v < 0 ? '-' : '') + '€' + Math.abs(v).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatMoney(amount, cur) { // per-item amount shown in its own currency
  return finCurSym(cur || FIN_HOME) + Math.abs(Number(amount) || 0).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getMonthRange() {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  const pad = n => String(n).padStart(2,'0');
  const last = new Date(y, m+1, 0).getDate();
  return { start: `${y}-${pad(m+1)}-01`, end: `${y}-${pad(m+1)}-${pad(last)}` };
}

async function loadFinance() {
  finAccounts = finAccLoad();
  if (!db || !currentUser) { finSubs = finSubsLocalLoad(); renderFinance(); renderBudgets(); renderSubscriptions(); renderNetWorth(); return; }
  const { start, end } = getMonthRange();
  const [txnRes, budgetRes, subRes] = await Promise.all([
    db.from('transactions').select('*').eq('user_id', currentUser.id)
      .gte('date', start).lte('date', end)
      .order('date', { ascending: false })
      .order('created_at', { ascending: false }),
    db.from('budgets').select('*').eq('user_id', currentUser.id),
    db.from('subscriptions').select('*').eq('user_id', currentUser.id)
  ]);
  if (txnRes.error)    { console.error('Finance load error:', txnRes.error); return; }
  if (budgetRes.error) { console.error('Budgets load error:', budgetRes.error); }
  finTransactions = txnRes.data    || [];
  finBudgets      = budgetRes.data || [];
  if (subRes && subRes.error) {
    finSubsRemote = false;   // table missing → keep subscriptions in localStorage
    console.warn('Subscriptions table not found — using local storage.', subRes.error.message);
    finSubs = finSubsLocalLoad();
  } else {
    finSubsRemote = true;
    finSubs = (subRes && subRes.data) || [];
  }
  renderFinance();
  renderSubscriptions();
  renderBudgets();
  renderNetWorth();
}

async function loadBudgets() {
  if (!db || !currentUser) { renderBudgets(); return; }
  const { data, error } = await db.from('budgets').select('*').eq('user_id', currentUser.id);
  if (error) { console.error('Budgets load error:', error); return; }
  finBudgets = data || [];
  renderBudgets();
}

// ── Subscriptions — renewal math + render ──────────────────────
function finParseDate(s) { const [y,m,d] = String(s).split('-').map(Number); return new Date(y, (m||1)-1, d||1); }
function finDateKey(dt) { const p = n => String(n).padStart(2,'0'); return `${dt.getFullYear()}-${p(dt.getMonth()+1)}-${p(dt.getDate())}`; }
function finNextRenewal(sub) {
  const today = new Date(); today.setHours(0,0,0,0);
  const d = finParseDate(sub.next_renewal || finDateKey(today));
  let guard = 0;
  while (d < today && guard < 600) {
    if (sub.cycle === 'weekly') d.setDate(d.getDate() + 7);
    else if (sub.cycle === 'yearly') d.setFullYear(d.getFullYear() + 1);
    else d.setMonth(d.getMonth() + 1);
    guard++;
  }
  return d;
}
function finDaysUntil(dt) {
  const today = new Date(); today.setHours(0,0,0,0);
  return Math.round((dt - today) / 86400000);
}
function finSubMonthly(sub) {       // monthly-equivalent cost in EUR home
  const home = finToHome(sub.amount, sub.currency || FIN_HOME);
  if (sub.cycle === 'weekly') return home * 52 / 12;
  if (sub.cycle === 'yearly') return home / 12;
  return home;
}
function finSubsActive() { return finSubs.filter(s => s.active !== false); }

function finSubRowHtml(s) {
  const next = finNextRenewal(s);
  const days = finDaysUntil(next);
  const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dueTxt = days <= 0 ? 'due today' : days === 1 ? 'in 1 day' : days <= 31 ? `in ${days} days` : `${MO[next.getMonth()]} ${next.getDate()}`;
  const dueCls = days <= 1 ? 'today' : days <= 5 ? 'soon' : '';
  const trial = s.is_trial ? '<span class="fin-sub-trial">TRIAL</span>' : '';
  const cycleTxt = s.cycle === 'weekly' ? 'Weekly' : s.cycle === 'yearly' ? 'Yearly' : 'Monthly';
  const col = finCatColor(s.category);
  return `<div class="fin-sub-row" data-sub="${s.id}" role="button" tabindex="0">
    <div class="fin-sub-icon" style="background:${col}1f;color:${col};">${finCatIcon(s.category)}</div>
    <div class="fin-sub-main">
      <div class="fin-sub-name">${finEsc(s.name)}</div>
      <div class="fin-sub-meta">${trial}${cycleTxt} · ${finEsc(s.category || 'Other')}</div>
    </div>
    <div class="fin-sub-right">
      <div class="fin-sub-amount">${formatMoney(s.amount, s.currency)}</div>
      <div class="fin-sub-due ${dueCls}">${dueTxt}</div>
    </div>
  </div>`;
}

function renderSubscriptions() {
  const active = finSubsActive();
  const monthlyTotal = active.reduce((s, x) => s + finSubMonthly(x), 0);
  const elM = document.getElementById('finSubsMonthly'); if (elM) elM.textContent = finFmtHome(monthlyTotal);
  const elY = document.getElementById('finSubsYearly');  if (elY) elY.textContent = finFmtHome(monthlyTotal * 12);
  const elC = document.getElementById('finSubsCount');   if (elC) elC.textContent = String(active.length);

  const list = document.getElementById('finSubsList');
  if (list) {
    const sorted = active.slice().sort((a,b) => finNextRenewal(a) - finNextRenewal(b));
    list.innerHTML = sorted.length ? sorted.map(finSubRowHtml).join('') : '<div class="empty-state">No subscriptions yet — tap Manage to add one.</div>';
    list.querySelectorAll('.fin-sub-row').forEach(r => {
      const open = () => finOpenSubModal(r.dataset.sub);
      r.addEventListener('click', open);
      r.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  }

  const mlist = document.getElementById('finSubsManageList');
  if (mlist) {
    const allSorted = finSubs.slice().sort((a,b) => finNextRenewal(a) - finNextRenewal(b));
    mlist.innerHTML = allSorted.length ? allSorted.map(finSubRowHtml).join('') : '<div class="empty-state">No subscriptions yet — tap + Add.</div>';
    mlist.querySelectorAll('.fin-sub-row').forEach(r => r.addEventListener('click', () => finOpenSubModal(r.dataset.sub)));
  }
}

// ── Accounts / net worth (localStorage, per-account currency) ──
function finAccLoad() { try { return JSON.parse(localStorage.getItem('po_finance_accounts') || '[]'); } catch { return []; } }
function finAccSave(arr) { finAccounts = arr; localStorage.setItem('po_finance_accounts', JSON.stringify(arr)); syncAppStateKey('finance:accounts', arr); }

// Transaction → account linkage (kept local, like the accounts themselves).
function finConvert(amount, fromCur, toCur) {
  const eur = finToHome(amount, fromCur);              // → EUR
  return (toCur === 'GBP') ? eur * finFxRate() : eur;  // EUR → target currency
}
function finAdjustAccount(accountId, type, amount, txnCur, direction) {
  const all = finAccLoad();
  const idx = all.findIndex(a => a.id === accountId);
  if (idx < 0) return;
  const accCur = all[idx].currency || FIN_HOME;
  const delta = finConvert(amount, txnCur, accCur) * (type === 'income' ? 1 : -1) * direction;
  all[idx].balance = Math.round(((Number(all[idx].balance) || 0) + delta) * 100) / 100;
  finAccSave(all);
}
function finTxnAcctMapLoad() { try { return JSON.parse(localStorage.getItem('po_finance_txn_accounts') || '{}'); } catch { return {}; } }
function finTxnAcctSet(txnId, accountId) { const m = finTxnAcctMapLoad(); if (accountId) m[txnId] = accountId; else delete m[txnId]; localStorage.setItem('po_finance_txn_accounts', JSON.stringify(m)); syncAppStateKey('finance:txn_accounts', m); }
function finTxnAcctGet(txnId) { return finTxnAcctMapLoad()[txnId]; }
function finFillAccountSelect() {
  const sel = document.getElementById('finTxnAccount');
  if (!sel) return;
  const prev = sel.value;
  const accounts = finAccLoad();
  sel.innerHTML = '<option value="">— No account —</option>' +
    accounts.map(a => `<option value="${a.id}">${finEsc(a.name)} (${finCurSym(a.currency || FIN_HOME)})</option>`).join('');
  if (prev && accounts.some(a => a.id === prev)) sel.value = prev;
  else if (accounts.length) sel.value = accounts[0].id;
}
function finSyncTxnCurToAccount() {
  const id = document.getElementById('finTxnAccount')?.value;
  const acc = id ? finAccLoad().find(a => a.id === id) : null;
  if (!acc) return;
  finTxnCur = acc.currency || 'EUR';
  document.querySelectorAll('#finTxnCur .fin-seg-btn').forEach(b => b.classList.toggle('active', b.dataset.cur === finTxnCur));
}

function finNetWorthHome() {       // total net worth converted to EUR home
  return finAccLoad().reduce((s, a) => s + finToHome(a.balance, a.currency || FIN_HOME), 0);
}

function renderNetWorth() {
  const accounts = finAccLoad();
  const totalHome = finNetWorthHome();
  const totalEl = document.getElementById('finNwTotal');
  if (totalEl) { totalEl.textContent = finFmtHome(totalHome); totalEl.style.color = totalHome < 0 ? 'var(--danger)' : 'var(--text-primary)'; }

  const byCur = {};
  accounts.forEach(a => { const c = a.currency || FIN_HOME; byCur[c] = (byCur[c] || 0) + (Number(a.balance) || 0); });
  const subEl = document.getElementById('finNwSub');
  if (subEl) {
    const parts = Object.keys(byCur).map(c => finCurSym(c) + Math.round(byCur[c]).toLocaleString('en-IE'));
    subEl.textContent = accounts.length ? `${accounts.length} account${accounts.length > 1 ? 's' : ''} · ${parts.join(' + ')} · €1 = £${finFxRate()}` : '';
  }

  const list = document.getElementById('finNwAccounts');
  if (list) {
    list.innerHTML = accounts.length
      ? accounts.map(a => `<div class="fin-nw-account"><div><div class="fin-nw-acc-name">${finEsc(a.name)}</div><div class="fin-nw-acc-type">${finEsc(a.type)} · ${finCurSym(a.currency || FIN_HOME)}</div></div><div class="fin-nw-acc-balance">${formatMoney(a.balance, a.currency)}</div></div>`).join('')
      : '<div class="empty-state">No accounts yet — tap Edit to add.</div>';
  }
  renderWishlist();   // wishlist affordability is a % of net worth, so refresh it alongside
}

// ── Wishlist (localStorage) ────────────────────────────────────
// An item is "affordable" when its price is a small slice of net worth.
// Thresholds (of total net worth, home €):
//   ≤ WISH_GREEN%  → comfortably affordable ("Go for it")
//   ≤ WISH_AMBER%  → significant, worth a pause ("Worth a think")
//   above          → a major purchase relative to your wealth ("Big purchase")
// Rationale: the personal-finance "1% rule" — a discretionary buy under ~1% of
// net worth is a no-brainer; 1–5% deserves thought; >5% is a real dent.
const WISH_GREEN = 1;
const WISH_AMBER = 5;
const FIN_WISH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8"/><path d="M2 7h20v5H2z"/><path d="M12 22V7"/><path d="M12 7S10.5 3 7.5 3a2.5 2.5 0 0 0 0 5H12z"/><path d="M12 7s1.5-4 4.5-4a2.5 2.5 0 0 1 0 5H12z"/></svg>';

function finWishLoad() { try { return JSON.parse(localStorage.getItem('po_finance_wishlist') || '[]'); } catch { return []; } }
function finWishSave(arr) { localStorage.setItem('po_finance_wishlist', JSON.stringify(arr)); syncAppStateKey('finance:wishlist', arr); }
function finWishId() { return 'wish-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function finWishPctTxt(pct) { return (pct < 0.1 ? '<0.1' : pct.toFixed(pct < 10 ? 1 : 0)) + '%'; }
function finWishTier(pct, hasNetWorth) {
  if (!hasNetWorth)        return { cls: 'none',    label: 'Set net worth' };
  if (pct <= WISH_GREEN)   return { cls: 'safe',    label: 'Go for it' };
  if (pct <= WISH_AMBER)   return { cls: 'warning', label: 'Worth a think' };
  return                          { cls: 'danger',  label: 'Big purchase' };
}

function finWishRowHtml(w, nwHome) {
  const hasNw = nwHome > 0;
  const priceHome = finToHome(w.price, w.currency || FIN_HOME);
  const pct = hasNw ? (priceHome / nwHome * 100) : 0;
  const tier = finWishTier(pct, hasNw);
  const barW = hasNw ? Math.max(2, Math.min(100, pct)) : 0;
  const foot = hasNw ? `${finWishPctTxt(pct)} of net worth` : 'add accounts to gauge';
  return `<div class="fin-wish-card" data-wish="${w.id}" role="button" tabindex="0">
    <div class="fin-wish-top">
      <div class="fin-wish-icon ${tier.cls}">${FIN_WISH_ICON}</div>
      <div class="fin-wish-name">${finEsc(w.name)}</div>
      <div class="fin-wish-price">${formatMoney(w.price, w.currency)}</div>
    </div>
    <div class="fin-wish-bar-wrap"><div class="fin-wish-bar ${tier.cls}" style="width:${barW}%"></div></div>
    <div class="fin-wish-foot">
      <span>${foot}</span>
      <span class="fin-wish-pill ${tier.cls}">${tier.label}</span>
    </div>
  </div>`;
}

function renderWishlist() {
  const list = document.getElementById('finWishList');
  if (!list) return;
  const items = finWishLoad();
  const nwHome = finNetWorthHome();
  if (!items.length) {
    list.innerHTML = '<div class="empty-state">Nothing on your wishlist — tap + Add to track something you want and see what share of your net worth it is.</div>';
    return;
  }
  // Cheapest-as-a-%-of-net-worth first (most affordable on top).
  const sorted = items.slice().sort((a, b) => finToHome(a.price, a.currency) - finToHome(b.price, b.currency));
  list.innerHTML = sorted.map(w => finWishRowHtml(w, nwHome)).join('');
  list.querySelectorAll('.fin-wish-card').forEach(r => {
    const open = () => finOpenWishModal(r.dataset.wish);
    r.addEventListener('click', open);
    r.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
}

let finWishCur = 'EUR', finEditWishId = null;
function finWishUpdateHint() {
  const hintEl = document.getElementById('finWishHint');
  if (!hintEl) return;
  const price = parseFloat(document.getElementById('finWishPrice').value);
  const nw = finNetWorthHome();
  if (!price || price <= 0) { hintEl.textContent = ''; hintEl.className = 'fin-wish-hint'; return; }
  if (nw <= 0) { hintEl.textContent = 'Add your accounts under Net worth to see affordability.'; hintEl.className = 'fin-wish-hint'; return; }
  const pct = finToHome(price, finWishCur) / nw * 100;
  const tier = finWishTier(pct, true);
  hintEl.textContent = `${finWishPctTxt(pct)} of your ${finFmtHome(nw)} net worth · ${tier.label}`;
  hintEl.className = 'fin-wish-hint ' + tier.cls;
}
function finOpenWishModal(id) {
  const w = id ? finWishLoad().find(x => x.id === id) : null;
  finEditWishId = w ? w.id : null;
  document.getElementById('finWishModalTitle').textContent = w ? 'Edit wishlist item' : 'Add to wishlist';
  document.getElementById('finWishName').value = w ? w.name : '';
  document.getElementById('finWishPrice').value = w ? w.price : '';
  finWishCur = w ? (w.currency || 'EUR') : 'EUR';
  document.querySelectorAll('#finWishCur .fin-seg-btn').forEach(b => b.classList.toggle('active', b.dataset.cur === finWishCur));
  document.getElementById('finWishDelete').style.display = w ? 'inline-block' : 'none';
  document.getElementById('finWishStatus').textContent = '';
  finWishUpdateHint();
  finShowModal('finWishModal');
}

function finAccPanelRender() {
  const list = document.getElementById('finAccountsList');
  if (!list) return;
  const accounts = finAccLoad();
  if (!accounts.length) { list.innerHTML = '<div class="empty-state">No accounts yet.</div>'; return; }
  list.innerHTML = accounts.map(a => `<div class="fin-acc-edit-row"><div class="fin-acc-edit-info"><div class="fin-nw-acc-name">${finEsc(a.name)}</div><div class="fin-nw-acc-type">${finEsc(a.type)} · ${finCurSym(a.currency || FIN_HOME)}</div></div><input class="fin-acc-bal-in" type="number" data-id="${a.id}" value="${a.balance}" step="0.01"><button class="fin-acc-del-btn" data-del="${a.id}" aria-label="Delete account">✕</button></div>`).join('');
  list.querySelectorAll('.fin-acc-bal-in').forEach(inp => {
    inp.addEventListener('change', () => {
      const all = finAccLoad(); const idx = all.findIndex(x => x.id === inp.dataset.id);
      if (idx >= 0) { all[idx].balance = parseFloat(inp.value) || 0; finAccSave(all); renderNetWorth(); }
    });
  });
  list.querySelectorAll('.fin-acc-del-btn').forEach(btn => {
    btn.addEventListener('click', () => { finAccSave(finAccLoad().filter(x => x.id !== btn.dataset.del)); finAccPanelRender(); renderNetWorth(); });
  });
}

function renderFinance() {
  const MO_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const now = new Date();
  const eyebrow = document.getElementById('finEyebrow');
  if (eyebrow) eyebrow.textContent = `${MO_FULL[now.getMonth()].toUpperCase()} ${now.getFullYear()}`;
  const titleEl = document.getElementById('finSectionTitle');
  if (titleEl) titleEl.textContent = 'Transactions';

  // Home-currency (EUR) totals
  const income         = finTransactions.filter(t => t.type === 'income').reduce((s,t) => s + finToHome(t.amount, t.currency), 0);
  const expensesActual = finTransactions.filter(t => t.type === 'expense').reduce((s,t) => s + finToHome(t.amount, t.currency), 0);
  const subsMonthly    = finSubsActive().reduce((s,x) => s + finSubMonthly(x), 0);
  const spending       = expensesActual + subsMonthly;     // projected: actual + recurring
  const net            = income - spending;

  const netEl = document.getElementById('finHeroNet');
  if (netEl) {
    netEl.textContent = (net < 0 ? '−' : '+') + finFmtHome(Math.abs(net));
    netEl.className = 'fin-hero-net ' + (net >= 0 ? 'pos' : 'neg');
  }
  const heroSub = document.getElementById('finHeroSub');
  if (heroSub) heroSub.textContent = subsMonthly > 0
    ? `incl ${finFmtHome(subsMonthly)} recurring · all converted to € home`
    : 'income vs spending this month';

  const max = Math.max(income, spending, 1);
  const inFill  = document.getElementById('finFlowIn');     if (inFill)  inFill.style.width  = (income / max * 100) + '%';
  const outFill = document.getElementById('finFlowOut');    if (outFill) outFill.style.width = (spending / max * 100) + '%';
  const inVal   = document.getElementById('finFlowInVal');  if (inVal)   inVal.textContent   = finFmtHome(income);
  const outVal  = document.getElementById('finFlowOutVal'); if (outVal)  outVal.textContent  = finFmtHome(spending);

  renderSpendingChart();

  const listEl = document.getElementById('finList');
  if (!listEl) return;
  listEl.innerHTML = '';

  if (finTransactions.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No transactions this month — tap + Add.</div>';
    return;
  }

  const groups = {};
  finTransactions.forEach(t => { (groups[t.date] = groups[t.date] || []).push(t); });
  const WD = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  Object.keys(groups).sort().reverse().forEach(date => {
    const [y,m,d] = date.split('-').map(Number);
    const dateObj = new Date(y, m-1, d);
    const groupHeader = document.createElement('div');
    groupHeader.className = 'fin-txn-group-header';
    groupHeader.textContent = `${WD[dateObj.getDay()]}, ${MO[m-1]} ${d}`;
    listEl.appendChild(groupHeader);

    groups[date].forEach(txn => {
      const item = document.createElement('div');
      item.className = 'fin-txn-item';
      const col = finCatColor(txn.category);

      const icon = document.createElement('div');
      icon.className = 'fin-txn-icon';
      icon.style.background = col + '1f';
      icon.style.color = col;
      icon.innerHTML = finCatIcon(txn.category);

      const info = document.createElement('div');
      info.className = 'fin-txn-info';
      const noteEl = document.createElement('div');
      noteEl.className = 'fin-txn-note';
      noteEl.textContent = txn.note || txn.category;
      info.appendChild(noteEl);
      const catEl = document.createElement('div');
      catEl.className = 'fin-txn-cat';
      catEl.textContent = (txn.note ? txn.category : (txn.currency === 'GBP' ? 'GBP' : 'EUR'));
      info.appendChild(catEl);

      const amount = document.createElement('span');
      amount.className = 'fin-txn-amount ' + txn.type;
      amount.textContent = (txn.type === 'income' ? '+' : '−') + formatMoney(txn.amount, txn.currency);

      const del = document.createElement('button');
      del.className = 'fin-txn-del';
      del.textContent = '×';
      del.setAttribute('aria-label', 'Delete transaction');
      del.addEventListener('click', async () => {
        if (!db) return;
        const { error } = await db.from('transactions').delete().eq('id', txn.id);
        if (!error) {
          const acctId = finTxnAcctGet(txn.id);
          if (acctId) { finAdjustAccount(acctId, txn.type, txn.amount, txn.currency, -1); finTxnAcctSet(txn.id, null); }
          loadFinance();
        }
      });

      item.append(icon, info, amount, del);
      listEl.appendChild(item);
    });
  });
}

function renderSpendingChart() {
  const svg = document.getElementById('finChartSvg');
  if (!svg) return;

  const NS = 'http://www.w3.org/2000/svg';
  const now = new Date();
  const y = now.getFullYear(), mo = now.getMonth();
  const daysInMonth = new Date(y, mo + 1, 0).getDate();
  const todayDay    = now.getDate();
  const pad = n => String(n).padStart(2, '0');
  const monthPfx    = `${y}-${pad(mo + 1)}-`;
  const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Daily expense totals in EUR home
  const daily = new Array(daysInMonth).fill(0);
  finTransactions
    .filter(t => t.type === 'expense' && String(t.date).startsWith(monthPfx))
    .forEach(t => {
      const d = parseInt(String(t.date).slice(8, 10), 10) - 1;
      if (d >= 0 && d < daysInMonth) daily[d] += finToHome(t.amount, t.currency);
    });

  const monthTotal = daily.reduce((s, v) => s + v, 0);
  const totalEl = document.getElementById('finChartTotal');
  if (totalEl) totalEl.textContent = finFmtHome(monthTotal) + ' this month';

  const VW = 600, VH = 120, padTop = 12, padBot = 20, padX = 4;
  const baseY = VH - padBot;
  const plotH = baseY - padTop;
  const maxVal = Math.max(...daily, 1);
  const xAt = i => padX + (daysInMonth <= 1 ? 0 : (i / (daysInMonth - 1)) * (VW - padX * 2));
  const yAt = v => baseY - (v / maxVal) * plotH;

  svg.innerHTML = '';

  const defs = document.createElementNS(NS, 'defs');
  defs.innerHTML = '<linearGradient id="finAreaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F2C063" stop-opacity="0.28"/><stop offset="1" stop-color="#F2C063" stop-opacity="0"/></linearGradient>';
  svg.appendChild(defs);

  const baseline = document.createElementNS(NS, 'line');
  baseline.setAttribute('x1', 0); baseline.setAttribute('y1', baseY);
  baseline.setAttribute('x2', VW); baseline.setAttribute('y2', baseY);
  baseline.setAttribute('class', 'fin-chart-baseline');
  svg.appendChild(baseline);

  const upto = Math.min(todayDay, daysInMonth);
  const pts = [];
  for (let i = 0; i < upto; i++) pts.push([xAt(i), yAt(daily[i])]);
  if (pts.length) {
    const dLine = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const area = document.createElementNS(NS, 'path');
    area.setAttribute('d', `${dLine} L ${pts[pts.length - 1][0].toFixed(1)} ${baseY} L ${pts[0][0].toFixed(1)} ${baseY} Z`);
    area.setAttribute('fill', 'url(#finAreaGrad)');
    svg.appendChild(area);

    const line = document.createElementNS(NS, 'path');
    line.setAttribute('d', dLine);
    line.setAttribute('class', 'fin-chart-line');
    svg.appendChild(line);

    const last = pts[pts.length - 1];
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', last[0]); dot.setAttribute('cy', last[1]); dot.setAttribute('r', 3.5);
    dot.setAttribute('class', 'fin-chart-dot is-today');
    svg.appendChild(dot);
  }

  const slotW = (VW - padX * 2) / daysInMonth;
  for (let i = 0; i < daysInMonth; i++) {
    const day = i + 1;
    const hit = document.createElementNS(NS, 'rect');
    hit.setAttribute('x', xAt(i) - slotW / 2); hit.setAttribute('y', 0);
    hit.setAttribute('width', slotW); hit.setAttribute('height', baseY);
    hit.setAttribute('class', 'fin-chart-hit');
    hit.dataset.amount = daily[i];
    hit.dataset.label  = `${MO[mo]} ${day}`;
    svg.appendChild(hit);

    if (day === 1 || day % 5 === 0 || day === daysInMonth) {
      const txt = document.createElementNS(NS, 'text');
      txt.setAttribute('x', xAt(i)); txt.setAttribute('y', VH - 5);
      txt.setAttribute('text-anchor', 'middle');
      txt.setAttribute('class', 'fin-chart-label');
      txt.textContent = day;
      svg.appendChild(txt);
    }
  }
}

function renderBudgets() {
  const listEl = document.getElementById('finBudgetList');
  if (!listEl) return;
  listEl.innerHTML = '';

  const titleEl = document.getElementById('finBudgetTitle');
  if (titleEl) titleEl.textContent = 'Budgets';

  if (finBudgets.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No budgets set — tap + Set.</div>';
    return;
  }

  finBudgets.forEach(budget => {
    const actual = finTransactions
      .filter(t => t.type === 'expense' && t.category === budget.category)
      .reduce((s, t) => s + finToHome(t.amount, t.currency), 0);
    const subPart = finSubsActive()
      .filter(x => (x.category || 'Other') === budget.category)
      .reduce((s, x) => s + finSubMonthly(x), 0);
    const spent = actual + subPart;
    const limit = Number(budget.amount);
    const pct   = limit > 0 ? Math.min((spent / limit) * 100, 100) : 0;
    const usedPct = limit > 0 ? Math.round((spent / limit) * 100) : 0;
    const over  = spent > limit;
    const barState = pct >= 100 ? 'danger' : pct >= 75 ? 'warning' : 'safe';
    const col = finCatColor(budget.category);

    const card = document.createElement('div');
    card.className = 'fin-budget-card';
    card.innerHTML =
      `<div class="fin-budget-top">
        <div class="fin-budget-icon" style="background:${col}1f;color:${col};">${finCatIcon(budget.category)}</div>
        <span class="fin-budget-cat">${finEsc(budget.category)}</span>
        <span class="fin-budget-amounts"><span class="fin-budget-spent${over ? ' over' : ''}">${finFmtHome(spent)}</span><span class="fin-budget-limit"> / ${finFmtHome(limit)}</span></span>
        <button class="fin-budget-del" aria-label="Remove budget">×</button>
      </div>
      <div class="fin-budget-bar-wrap"><div class="fin-budget-bar ${barState}" style="width:${pct}%"></div></div>
      <div class="fin-budget-foot"><span>${usedPct}% used</span><span>${subPart > 0 ? `<span class="sub">incl ${finFmtHome(subPart)} subs</span>` : `${finFmtHome(Math.max(limit - spent, 0))} left`}</span></div>`;

    card.querySelector('.fin-budget-del').addEventListener('click', async () => {
      if (!db) return;
      const { error } = await db.from('budgets').delete().eq('id', budget.id);
      if (!error) { finBudgets = finBudgets.filter(b => b.id !== budget.id); renderBudgets(); }
    });
    listEl.appendChild(card);
  });
}

// ── Finance UI helpers (modals / segmented controls) ──────────
function finFillCatSelect(sel) {
  if (!sel) return;
  sel.innerHTML = FIN_CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('');
}
function finSegInit(container, attr, onPick, initial) {
  if (!container) return;
  const btns = container.querySelectorAll('.fin-seg-btn');
  const set = val => btns.forEach(b => b.classList.toggle('active', b.dataset[attr] === String(val)));
  btns.forEach(b => b.addEventListener('click', () => { set(b.dataset[attr]); if (onPick) onPick(b.dataset[attr]); }));
  if (initial !== undefined) set(initial);
}
function finShowModal(id) { const m = document.getElementById(id); if (m) m.classList.remove('hidden'); }
function finHideModal(id) { const m = document.getElementById(id); if (m) m.classList.add('hidden'); }

let finTxnCur = 'EUR', finSubModalCur = 'EUR', finSubTrialFlag = 0, finEditSubId = null;

function finOpenSubModal(id) {
  finEditSubId = id || null;
  const sub = id ? finSubs.find(s => s.id === id) : null;
  document.getElementById('finSubModalTitle').textContent = sub ? 'Edit subscription' : 'Add subscription';
  document.getElementById('finSubName').value = sub ? sub.name : '';
  document.getElementById('finSubAmount').value = sub ? sub.amount : '';
  document.getElementById('finSubCycle').value = sub ? (sub.cycle || 'monthly') : 'monthly';
  document.getElementById('finSubCategory').value = sub ? (sub.category || 'Entertainment') : 'Entertainment';
  document.getElementById('finSubNext').value = sub ? (sub.next_renewal || '') : finDateKey(new Date());
  document.getElementById('finSubTrialEnds').value = (sub && sub.trial_ends) ? sub.trial_ends : '';
  finSubModalCur = sub ? (sub.currency || 'EUR') : 'EUR';
  finSubTrialFlag = (sub && sub.is_trial) ? 1 : 0;
  document.querySelectorAll('#finSubCur .fin-seg-btn').forEach(b => b.classList.toggle('active', b.dataset.cur === finSubModalCur));
  document.querySelectorAll('#finSubTrial .fin-seg-btn').forEach(b => b.classList.toggle('active', b.dataset.trial === String(finSubTrialFlag)));
  document.getElementById('finSubTrialWrap').style.display = finSubTrialFlag ? 'block' : 'none';
  document.getElementById('finSubDelete').style.display = sub ? 'inline-block' : 'none';
  document.getElementById('finSubStatus').textContent = '';
  finShowModal('finSubModal');
}

function initFinance() {
  if (!document.getElementById('finHeroNet')) return;

  finFillCatSelect(document.getElementById('finCategory'));
  finFillCatSelect(document.getElementById('finSubCategory'));
  finFillCatSelect(document.getElementById('finBudgetCategory'));
  const dateEl = document.getElementById('finDate');
  if (dateEl) dateEl.value = new Date().toISOString().slice(0,10);

  // ── Add-transaction modal ──
  finSegInit(document.getElementById('finTxnType'), 'type', v => { finSelectedType = v; }, 'expense');
  finSegInit(document.getElementById('finTxnCur'), 'cur', v => { finTxnCur = v; }, 'EUR');
  const openAdd = () => { finHideModal('finSubModal'); finFillAccountSelect(); finSyncTxnCurToAccount(); document.getElementById('finTxnStatus').textContent = ''; finShowModal('finTxnModal'); };
  document.getElementById('finOpenAddBtn')?.addEventListener('click', openAdd);
  document.getElementById('finOpenAddBtn2')?.addEventListener('click', openAdd);
  document.getElementById('finTxnAccount')?.addEventListener('change', finSyncTxnCurToAccount);
  document.getElementById('finTxnCancel')?.addEventListener('click', () => finHideModal('finTxnModal'));
  document.getElementById('finTxnModalBg')?.addEventListener('click', () => finHideModal('finTxnModal'));
  document.getElementById('finTxnSave')?.addEventListener('click', async () => {
    const amount   = parseFloat(document.getElementById('finAmount').value);
    const category = document.getElementById('finCategory').value;
    const date     = document.getElementById('finDate').value;
    const note     = document.getElementById('finNote').value.trim();
    const accountId = document.getElementById('finTxnAccount').value || null;
    const status   = document.getElementById('finTxnStatus');
    if (!amount || amount <= 0 || !date) { status.textContent = 'Enter an amount and date.'; return; }
    if (!db || !currentUser) { status.textContent = 'Not connected — sign in first.'; return; }
    const btn = document.getElementById('finTxnSave'); btn.disabled = true;
    const { data, error } = await db.from('transactions').insert({
      user_id: currentUser.id, amount, type: finSelectedType, category, date, note: note || null, currency: finTxnCur
    }).select().single();
    btn.disabled = false;
    if (error) { status.textContent = error.message || 'Failed to save.'; return; }
    if (accountId && data) { finAdjustAccount(accountId, finSelectedType, amount, finTxnCur, 1); finTxnAcctSet(data.id, accountId); }
    document.getElementById('finAmount').value = '';
    document.getElementById('finNote').value   = '';
    finHideModal('finTxnModal');
    loadFinance();
  });
  ['finAmount','finNote'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('finTxnSave').click(); });
  });

  // ── Subscription modal ──
  finSegInit(document.getElementById('finSubCur'), 'cur', v => { finSubModalCur = v; }, 'EUR');
  finSegInit(document.getElementById('finSubTrial'), 'trial', v => {
    finSubTrialFlag = Number(v);
    document.getElementById('finSubTrialWrap').style.display = finSubTrialFlag ? 'block' : 'none';
  }, '0');
  document.getElementById('finSubAddBtn')?.addEventListener('click', () => finOpenSubModal(null));
  document.getElementById('finSubCancel')?.addEventListener('click', () => finHideModal('finSubModal'));
  document.getElementById('finSubModalBg')?.addEventListener('click', () => finHideModal('finSubModal'));
  document.getElementById('finSubSave')?.addEventListener('click', async () => {
    const name = document.getElementById('finSubName').value.trim();
    const amount = parseFloat(document.getElementById('finSubAmount').value);
    const cycle = document.getElementById('finSubCycle').value;
    const category = document.getElementById('finSubCategory').value;
    const next_renewal = document.getElementById('finSubNext').value;
    const trial_ends = document.getElementById('finSubTrialEnds').value || null;
    const status = document.getElementById('finSubStatus');
    if (!name) { status.textContent = 'Enter a name.'; return; }
    if (!amount || amount <= 0) { status.textContent = 'Enter an amount.'; return; }
    if (!next_renewal) { status.textContent = 'Pick the next renewal date.'; return; }
    const btn = document.getElementById('finSubSave'); btn.disabled = true;
    const fields = { name, amount, currency: finSubModalCur, cycle, category, next_renewal, is_trial: !!finSubTrialFlag, trial_ends: finSubTrialFlag ? trial_ends : null, active: true };
    // Use Supabase when the table exists and this isn't a local-only row; otherwise localStorage.
    const useRemote = db && currentUser && finSubsRemote && !finSubIsLocalId(finEditSubId);
    let error = null;
    if (useRemote) {
      const row = { user_id: currentUser.id, ...fields };
      if (finEditSubId) ({ error } = await db.from('subscriptions').update(row).eq('id', finEditSubId));
      else ({ error } = await db.from('subscriptions').insert(row));
      if (error) finSubsRemote = false;   // table missing → fall through to localStorage
    }
    if (!useRemote || error) {
      const arr = finSubsLocalLoad();
      if (finEditSubId) {
        const i = arr.findIndex(s => s.id === finEditSubId);
        if (i >= 0) arr[i] = { ...arr[i], ...fields }; else arr.push({ id: finEditSubId, ...fields });
      } else {
        arr.push({ id: finSubLocalId(), ...fields });
      }
      finSubsLocalSave(arr);
    }
    btn.disabled = false;
    finHideModal('finSubModal');
    loadFinance();
  });
  document.getElementById('finSubDelete')?.addEventListener('click', async () => {
    if (!finEditSubId) return;
    if (db && currentUser && finSubsRemote && !finSubIsLocalId(finEditSubId)) {
      const { error } = await db.from('subscriptions').delete().eq('id', finEditSubId);
      if (!error) { finHideModal('finSubModal'); loadFinance(); return; }
      finSubsRemote = false;   // table missing → fall through to localStorage
    }
    finSubsLocalSave(finSubsLocalLoad().filter(s => s.id !== finEditSubId));
    finHideModal('finSubModal');
    loadFinance();
  });

  // ── Wishlist ──
  finSegInit(document.getElementById('finWishCur'), 'cur', v => { finWishCur = v; finWishUpdateHint(); }, 'EUR');
  document.getElementById('finWishAddBtn')?.addEventListener('click', () => finOpenWishModal(null));
  document.getElementById('finWishCancel')?.addEventListener('click', () => finHideModal('finWishModal'));
  document.getElementById('finWishModalBg')?.addEventListener('click', () => finHideModal('finWishModal'));
  document.getElementById('finWishPrice')?.addEventListener('input', finWishUpdateHint);
  document.getElementById('finWishSave')?.addEventListener('click', () => {
    const name  = document.getElementById('finWishName').value.trim();
    const price = parseFloat(document.getElementById('finWishPrice').value);
    const status = document.getElementById('finWishStatus');
    if (!name) { status.textContent = 'Name the item.'; return; }
    if (!price || price <= 0) { status.textContent = 'Enter a price.'; return; }
    const arr = finWishLoad();
    if (finEditWishId) {
      const i = arr.findIndex(w => w.id === finEditWishId);
      if (i >= 0) arr[i] = { ...arr[i], name, price, currency: finWishCur };
    } else {
      arr.push({ id: finWishId(), name, price, currency: finWishCur });
    }
    finWishSave(arr);
    finHideModal('finWishModal');
    renderWishlist();
  });
  document.getElementById('finWishDelete')?.addEventListener('click', () => {
    if (!finEditWishId) return;
    finWishSave(finWishLoad().filter(w => w.id !== finEditWishId));
    finHideModal('finWishModal');
    renderWishlist();
  });
  document.getElementById('finWishName')?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('finWishPrice').focus(); });

  // ── Budget modal ──
  document.getElementById('finBudgetSetBtn')?.addEventListener('click', () => { document.getElementById('finBudgetStatus').textContent = ''; finShowModal('finBudgetModal'); });
  document.getElementById('finBudgetCancel')?.addEventListener('click', () => finHideModal('finBudgetModal'));
  document.getElementById('finBudgetModalBg')?.addEventListener('click', () => finHideModal('finBudgetModal'));
  document.getElementById('finBudgetSave')?.addEventListener('click', async () => {
    const category = document.getElementById('finBudgetCategory').value;
    const limit    = parseFloat(document.getElementById('finBudgetLimit').value);
    const status   = document.getElementById('finBudgetStatus');
    if (!limit || limit <= 0) { status.textContent = 'Enter a limit greater than 0.'; return; }
    if (!db || !currentUser) { status.textContent = 'Not connected — sign in first.'; return; }
    const btn = document.getElementById('finBudgetSave'); btn.disabled = true;
    const existing = finBudgets.find(b => b.category === category);
    let error;
    if (existing) ({ error } = await db.from('budgets').update({ amount: limit }).eq('id', existing.id));
    else ({ error } = await db.from('budgets').insert({ user_id: currentUser.id, category, amount: limit }));
    btn.disabled = false;
    if (error) { status.textContent = error.message || 'Failed to save budget.'; return; }
    document.getElementById('finBudgetLimit').value = '';
    finHideModal('finBudgetModal');
    loadBudgets();
  });
  document.getElementById('finBudgetLimit')?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('finBudgetSave').click(); });

  // ── Manage-subscriptions panel ──
  document.getElementById('finSubsManageBtn')?.addEventListener('click', () => { renderSubscriptions(); document.getElementById('finSubsPanel')?.classList.add('open'); });
  document.getElementById('finSubsBack')?.addEventListener('click', () => document.getElementById('finSubsPanel')?.classList.remove('open'));

  // ── Accounts panel + FX rate ──
  let finAccCurSel = 'EUR';
  finSegInit(document.getElementById('finAccCur'), 'cur', v => { finAccCurSel = v; }, 'EUR');
  const fxInput = document.getElementById('finFxInput');
  if (fxInput) {
    fxInput.value = finFxRate();
    fxInput.addEventListener('change', () => {
      const v = parseFloat(fxInput.value);
      if (v && v > 0) { finFxSave(v); renderNetWorth(); renderSubscriptions(); renderFinance(); renderBudgets(); }
      else fxInput.value = finFxRate();
    });
  }
  document.getElementById('finNwEditBtn')?.addEventListener('click', () => { finAccPanelRender(); document.getElementById('finAccountsPanel')?.classList.add('open'); });
  document.getElementById('finAccountsBack')?.addEventListener('click', () => document.getElementById('finAccountsPanel')?.classList.remove('open'));
  document.getElementById('finAccAddBtn')?.addEventListener('click', () => {
    const name = document.getElementById('finAccName').value.trim();
    const type = document.getElementById('finAccType').value;
    const bal  = parseFloat(document.getElementById('finAccBalance').value) || 0;
    if (!name) return;
    const all = finAccLoad();
    all.push({ id: 'acc_' + Date.now(), name, type, balance: bal, currency: finAccCurSel });
    finAccSave(all);
    document.getElementById('finAccName').value = '';
    document.getElementById('finAccBalance').value = '';
    finAccPanelRender();
    renderNetWorth();
  });

  // ── Spending-chart tooltip ──
  let chartTip = document.querySelector('.fin-chart-tooltip');
  if (!chartTip) { chartTip = document.createElement('div'); chartTip.className = 'fin-chart-tooltip'; document.body.appendChild(chartTip); }
  const chartSvg = document.getElementById('finChartSvg');
  if (chartSvg) {
    chartSvg.addEventListener('mousemove', e => {
      const el = e.target;
      if (el.dataset && el.dataset.label) {
        chartTip.textContent = `${el.dataset.label} — ${finFmtHome2(parseFloat(el.dataset.amount || 0))}`;
        chartTip.classList.add('visible');
        const tx = e.clientX + 14, ty = e.clientY - 36;
        chartTip.style.left = (tx + 150 > window.innerWidth ? e.clientX - 150 : tx) + 'px';
        chartTip.style.top  = (ty < 0 ? e.clientY + 10 : ty) + 'px';
      } else {
        chartTip.classList.remove('visible');
      }
    });
    chartSvg.addEventListener('mouseleave', () => chartTip.classList.remove('visible'));
  }

  loadFinance();
}

// ── Gym Tracker ─────────────────────────────────────────────
const GYM_STATE_KEY = 'po_coach_v1';
const GYM_APP_KEY   = 'gym';

let gymSyncTimer      = null;
let gymLastPushedJson = null;
let gymIsTyping       = false;
let gymPendingRmt     = null;

function gymUID()   { return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
function gymToday() { return new Date().toISOString().slice(0,10); }
function gymFmtDate(s) {
  const [y,m,d] = s.split('-').map(Number), dt = new Date(y,m-1,d);
  const WD=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],MO=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${WD[dt.getDay()]}, ${MO[m-1]} ${d}`;
}

const _GYM_DEF_EXERCISES = [
  { id:'gex1', name:'Bench press',       days:['push'], repMin:5,  repMax:8,  step:2.5,  startWeight:60  },
  { id:'gex2', name:'Overhead press',    days:['push'], repMin:5,  repMax:8,  step:2.5,  startWeight:35  },
  { id:'gex3', name:'Tricep pushdown',   days:['push'], repMin:8,  repMax:12, step:2.5,  startWeight:25  },
  { id:'gex4', name:'Pull-ups',          days:['pull'], repMin:5,  repMax:10, step:1,    startWeight:0,  bw:true },
  { id:'gex5', name:'Barbell row',       days:['pull'], repMin:6,  repMax:10, step:2.5,  startWeight:50  },
  { id:'gex6', name:'Bicep curl',        days:['pull'], repMin:8,  repMax:12, step:1.25, startWeight:15  },
  { id:'gex7', name:'Back squat',        days:['legs'], repMin:5,  repMax:8,  step:5,    startWeight:80  },
  { id:'gex8', name:'Romanian deadlift', days:['legs'], repMin:6,  repMax:10, step:5,    startWeight:60  },
  { id:'gex9', name:'Leg press',         days:['legs'], repMin:8,  repMax:12, step:5,    startWeight:100 },
];
const _GYM_DEFAULTS = {
  units: 'kg',
  days:  [{ id:'push', name:'Push' }, { id:'pull', name:'Pull' }, { id:'legs', name:'Legs' }],
  exercises: _GYM_DEF_EXERCISES,
  logs:  {},
  filterDay: 'push',
  currentEx: null,
  splitRotation: ['Full Body'],
  splitAnchor: null,
  _userPickedDay: false,
  queue: [],
  queueDate: null,
};

function gymDefaultState() {
  const s = JSON.parse(JSON.stringify(_GYM_DEFAULTS));
  s.splitAnchor  = { date: gymToday(), index: 0 };
  s.bodyWeights  = [];
  s.workoutDone  = {};
  return s;
}

function loadGymState() {
  try {
    const raw = localStorage.getItem(GYM_STATE_KEY);
    if (!raw) return gymDefaultState();
    const s = JSON.parse(raw);
    if (!s.days)          s.days          = _GYM_DEFAULTS.days;
    if (!s.exercises)     s.exercises     = JSON.parse(JSON.stringify(_GYM_DEF_EXERCISES));
    s.exercises.forEach(ex => { if (!ex.days) ex.days = ex.day ? [ex.day] : ['rest']; });
    if (!s.logs)          s.logs          = {};
    if (!s.splitRotation) s.splitRotation = _GYM_DEFAULTS.splitRotation;
    if (!s.splitAnchor)   s.splitAnchor   = { date: gymToday(), index: 0 };
    if (s.units       == null) s.units       = 'kg';
    if (s.filterDay   == null) s.filterDay   = 'push';
    if (!s.bodyWeights)        s.bodyWeights = [];
    if (!s.workoutDone)        s.workoutDone = {};
    if (!s.queue)              s.queue       = [];
    if (!s.queueDate)          s.queueDate   = gymToday();
    if (!s.keyLiftOverrides)   s.keyLiftOverrides = {};
    return s;
  } catch { return gymDefaultState(); }
}

function saveGymState(s) {
  localStorage.setItem(GYM_STATE_KEY, JSON.stringify(s));
  pushGymToSupabase(s);
}

function pushGymToSupabase(s) {
  if (!useSupabase) return;
  clearTimeout(gymSyncTimer);
  gymSyncTimer = setTimeout(async () => {
    if (!db || !currentUser) return;
    const payload = s;
    gymLastPushedJson = JSON.stringify(payload);
    setSyncing(true);
    try {
      await db.from('app_state').upsert(
        { user_id: currentUser.id, app_key: GYM_APP_KEY, payload, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,app_key' }
      );
    } catch { setSyncError(); gymLastPushedJson = null; } finally { setSyncing(false); }
  }, 250);
}

async function loadGymFromSupabase() {
  if (!db || !currentUser) return;
  const { data, error } = await db.from('app_state').select('payload')
    .eq('user_id', currentUser.id).eq('app_key', GYM_APP_KEY).maybeSingle();
  if (error) return;
  if (!data || !data.payload) {
    const local = loadGymState();
    if (Object.keys(local.logs || {}).length > 0) pushGymToSupabase(local);
    return;
  }
  localStorage.setItem(GYM_STATE_KEY, JSON.stringify(data.payload));
  renderGym();
}

function applyGymRemote(payload) {
  if (!payload) return;
  localStorage.setItem(GYM_STATE_KEY, JSON.stringify(payload));
  renderGym();
}

function gymAutoDay(state) {
  const { splitRotation, splitAnchor } = state;
  if (!splitAnchor || !splitRotation || !splitRotation.length) return null;
  const anchorMs = new Date(splitAnchor.date + 'T00:00:00').getTime();
  const todayMs  = new Date(gymToday()            + 'T00:00:00').getTime();
  const diff     = Math.round((todayMs - anchorMs) / 86400000);
  const idx      = ((splitAnchor.index + diff) % splitRotation.length + splitRotation.length) % splitRotation.length;
  return splitRotation[idx];
}

function gymSuggestion(state, exId) {
  const ex = state.exercises.find(e => e.id === exId);
  if (!ex) return null;
  const logs = (state.logs[exId] || []).slice().sort((a,b) => a.date < b.date ? -1 : 1);
  const last = logs[logs.length - 1];
  if (!last) return { weight: ex.startWeight, repRange: `${ex.repMin}–${ex.repMax}`, isUpgrade: false, bw: !!ex.bw };
  const isUpgrade = last.reps >= ex.repMax;
  return {
    weight: isUpgrade ? last.weight + ex.step : last.weight,
    repRange: `${ex.repMin}–${ex.repMax}`,
    isUpgrade,
    lastWeight: last.weight, lastReps: last.reps, lastDate: last.date, bw: !!ex.bw,
  };
}

let poDraftWeight = null;
let poDraftReps   = null;
let poDraftRir    = null;

function poCoachState(state, exId) {
  const ex = state.exercises.find(e => e.id === exId);
  if (!ex) return null;
  const logs = (state.logs[exId] || []).slice().sort((a,b) => a.date < b.date ? -1 : 1);
  if (!logs.length) return { mode:'start', weight:ex.startWeight, reps:ex.repMin, ex };
  const last = logs[logs.length - 1];
  const sessGroups = [];
  let cur = null;
  for (const l of logs) {
    if (!cur || cur.date !== l.date) { cur = { date:l.date, entries:[l] }; sessGroups.push(cur); }
    else cur.entries.push(l);
  }
  const recent = sessGroups.slice(-3);
  if (recent.length >= 3 && recent.every(s => s.entries.every(e => e.weight === last.weight && e.reps < ex.repMin))) {
    return { mode:'deload', weight: Math.round(last.weight * 0.9 * 4) / 4, reps:ex.repMax, ex };
  }
  if (last.reps >= ex.repMax) {
    const lastRir = (last.rir != null) ? last.rir : null;
    const rirJump = lastRir != null && lastRir >= 3;
    const steps = rirJump ? 2 : 1;
    let newWeight;
    if (ex.useLadder) {
      const perHand = ex.ladderDouble ? last.weight / 2 : last.weight;
      const nextHand = dbLadderNext(DUMBBELL_LADDER, perHand, steps);
      newWeight = ex.ladderDouble ? nextHand * 2 : nextHand;
    } else {
      newWeight = last.weight + (ex.step * steps);
    }
    return { mode:'add_weight', weight:newWeight, reps:ex.repMin, ex, _weightSteps:steps, _rirJump:rirJump, _lastRir:lastRir };
  }
  return { mode:'add_rep', weight:last.weight, reps:last.reps + 1, ex };
}

// Returns the first exercise in state.queue that still has sets remaining today.
function gymQueueTopEx(state) {
  const today = gymToday();
  for (const exId of (state.queue || [])) {
    const ex = state.exercises.find(e => e.id === exId);
    if (!ex) continue;
    const done = (state.logs[exId]||[]).filter(l => l.date === today).length;
    if (done < (ex.targetSets || 3)) return ex;
  }
  return null;
}

let _coachExId = null; // tracks which exercise the coach card is currently showing

function poTimeAgo(dateStr) {
  const days = Math.round((new Date(gymToday()+'T00:00:00') - new Date(dateStr+'T00:00:00')) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7)  return days + 'd ago';
  if (days < 30) return Math.floor(days/7) + 'w ago';
  return Math.floor(days/30) + 'mo ago';
}

function poCalc1RM(weight, reps) {
  return weight * (1 + reps / 30);
}

// ── Gym redesign helpers ─────────────────────────────────────

function gymRenderHeaderStrip() {
  const dateEl = document.getElementById('gymHeaderDate');
  const pillEl = document.getElementById('gymHeaderSplitPill');
  if (!dateEl || !pillEl) return;
  const t = gymToday();
  const [y,m,d] = t.split('-').map(Number);
  const dt = new Date(y, m-1, d);
  const WD = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
  const MO = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  dateEl.textContent = `${WD[dt.getDay()]} · ${MO[m-1]} ${d}`;
  const state = loadGymState();
  const auto  = gymAutoDay(state);
  pillEl.textContent = auto ? `${auto.toUpperCase()} DAY` : 'REST DAY';
}

const _GYM_MUSCLE_KEYWORDS = [
  ['bench', 'chest'], ['chest', 'chest'], ['fly', 'chest'],
  ['overhead press', 'shoulders'], ['ohp', 'shoulders'], ['shoulder press', 'shoulders'],
  ['back squat', 'quads'], ['squat', 'quads'], ['leg press', 'quads'], ['lunge', 'quads'],
  ['deadlift', 'back'], ['row', 'back'], ['pull up', 'lats'], ['pullup', 'lats'],
  ['lat pulldown', 'lats'], ['pull-up', 'lats'],
  ['curl', 'biceps'],
  ['tricep', 'triceps'], ['dip', 'triceps'],
  ['hip thrust', 'glutes'], ['rdl', 'hamstrings'],
  ['calf', 'calves'],
];

function gymExDays(ex) {
  return ex.days || (ex.day ? [ex.day] : ['rest']);
}

function gymExMuscle(ex) {
  const name = (ex.name || '').toLowerCase();
  for (const [kw, muscle] of _GYM_MUSCLE_KEYWORDS) {
    if (name.includes(kw)) return muscle;
  }
  return null;
}

const MM_MUSCLE_OPTS = [
  { id: 'chest',       label: 'Chest' },
  { id: 'front_delts', label: 'Front Delts' },
  { id: 'side_delts',  label: 'Side Delts' },
  { id: 'rear_delts',  label: 'Rear Delts' },
  { id: 'traps',       label: 'Traps' },
  { id: 'biceps',      label: 'Biceps' },
  { id: 'triceps',     label: 'Triceps' },
  { id: 'forearms',    label: 'Forearms' },
  { id: 'abs',         label: 'Abs' },
  { id: 'obliques',    label: 'Obliques' },
  { id: 'lats',        label: 'Lats' },
  { id: 'mid_back',    label: 'Mid Back' },
  { id: 'lower_back',  label: 'Lower Back' },
  { id: 'glutes',      label: 'Glutes' },
  { id: 'quads',       label: 'Quads' },
  { id: 'hamstrings',  label: 'Hamstrings' },
  { id: 'calves',      label: 'Calves' },
  { id: 'hip_flexors', label: 'Hip Flexors' },
];

const _GYM_MUSCLE_GROUPS = [
  { label: 'Chest',     muscles: ['chest'],                                          muscleIds: ['chest'] },
  { label: 'Back',      muscles: ['back', 'lats'],                                   muscleIds: ['lats', 'mid_back', 'lower_back', 'traps'] },
  { label: 'Shoulders', muscles: ['shoulders'],                                      muscleIds: ['front_delts', 'side_delts', 'rear_delts'] },
  { label: 'Arms',      muscles: ['biceps', 'triceps'],                              muscleIds: ['biceps', 'triceps', 'forearms'] },
  { label: 'Legs',      muscles: ['quads', 'hamstrings', 'glutes', 'calves'],        muscleIds: ['quads', 'hamstrings', 'glutes', 'calves', 'hip_flexors'] },
];

function gymExMatchesGroup(ex, label) {
  const g = _GYM_MUSCLE_GROUPS.find(x => x.label === label);
  if (!g) return false;
  if (ex.muscles && ex.muscles.length) {
    return ex.muscles.some(mid => (g.muscleIds || []).includes(mid));
  }
  const m = gymExMuscle(ex);
  return m != null && g.muscles.includes(m);
}

let _gymActiveMuscle = null;
let _libSearch = '';
let _libMuscle = null;

function gymRenderMuscleFilter() {
  const el = document.getElementById('gymMuscleFilter');
  if (!el) return;
  const state = loadGymState();
  const dayExs = state.exercises.filter(e => gymExDays(e).includes(state.filterDay));
  const visibleGroups = _GYM_MUSCLE_GROUPS.filter(g => dayExs.some(e => gymExMatchesGroup(e, g.label)));
  el.innerHTML = '';
  visibleGroups.forEach(g => {
    const btn = document.createElement('button');
    btn.className = 'gym-muscle-btn' + (_gymActiveMuscle === g.label ? ' active' : '');
    btn.textContent = g.label;
    btn.onclick = () => {
      _gymActiveMuscle = _gymActiveMuscle === g.label ? null : g.label;
      gymRenderMuscleFilter();
      gymRenderQueue();
    };
    el.appendChild(btn);
  });
  if (_gymActiveMuscle) {
    const cl = document.createElement('button');
    cl.className = 'gym-clear-filters';
    cl.textContent = 'Clear';
    cl.onclick = () => { _gymActiveMuscle = null; gymRenderMuscleFilter(); gymRenderQueue(); };
    el.appendChild(cl);
  }
}

function gymRenderSplitTabs() {
  const el = document.getElementById('gymSplitTabs');
  if (!el) return;
  const state = loadGymState();
  const tabs  = [...(state.splitRotation || [])];
  if (!tabs.some(t => t.toLowerCase() === 'rest')) tabs.push('Rest');
  el.innerHTML = '';
  tabs.forEach(name => {
    const btn = document.createElement('button');
    btn.className = 'gym-split-tab';
    btn.textContent = name.toUpperCase();
    btn.dataset.split = name.toLowerCase();
    const matchDay = state.days.find(d => d.name.toLowerCase() === name.toLowerCase());
    const isActive = matchDay
      ? (state.filterDay === matchDay.id)
      : (name.toLowerCase() === 'rest' && state.filterDay === 'rest');
    if (isActive) btn.classList.add('active');
    btn.onclick = () => {
      const s = loadGymState();
      if (name.toLowerCase() === 'rest') {
        s.filterDay = 'rest';
      } else {
        const day = s.days.find(d => d.name.toLowerCase() === name.toLowerCase());
        if (day) s.filterDay = day.id;
      }
      s._userPickedDay = true;
      _gymActiveMuscle = null;
      const exs = s.exercises.filter(e => gymExDays(e).includes(s.filterDay));
      if (!exs.find(e => e.id===s.currentEx)) { s.currentEx = exs[0]?.id||null; poDraftWeight=null; poDraftReps=null; poDraftRir=null; }
      saveGymState(s); renderGym();
    };
    el.appendChild(btn);
  });
}

const _GYM_KEY_LIFTS = [
  { label: 'BENCH',    match: ['bench press', 'bench'],            color: '#F5A623' },
  { label: 'OHP',      match: ['overhead press', 'ohp', 'military press'], color: '#6BE3A4' },
  { label: 'SQUAT',    match: ['back squat', 'squat'],             color: '#5BB8F5' },
  { label: 'DEADLIFT', match: ['deadlift'],                        color: '#B8A0F5' },
];

function gymRender1RMTiles() {
  const el = document.getElementById('gym1RMGrid');
  if (!el) return;
  const state = loadGymState();
  el.innerHTML = '';
  const ns = 'http://www.w3.org/2000/svg';

  _GYM_KEY_LIFTS.forEach(lift => {
    const overrideId = (state.keyLiftOverrides || {})[lift.label];
    const ex = overrideId
      ? state.exercises.find(e => e.id === overrideId)
      : state.exercises.find(e => lift.match.some(m => e.name.toLowerCase().includes(m)));
    const allLogs = ex
      ? (state.logs[ex.id]||[]).slice().sort((a,b) => a.date < b.date ? -1 : 1)
      : [];

    const sessions = {};
    allLogs.forEach(l => { if (!sessions[l.date]) sessions[l.date] = []; sessions[l.date].push(l); });
    const allDates   = Object.keys(sessions).sort();
    const last7dates = allDates.slice(-7);
    const sessionRMs = last7dates.map(date =>
      Math.max(...sessions[date].map(s => poCalc1RM(s.weight, s.reps)))
    );
    const currentRM = sessionRMs.length ? sessionRMs[sessionRMs.length-1] : null;
    const prevRM    = sessionRMs.length >= 2 ? sessionRMs[sessionRMs.length-2] : null;
    const allTimeRM = allDates.length
      ? Math.max(...allDates.map(d => Math.max(...sessions[d].map(s => poCalc1RM(s.weight, s.reps)))))
      : null;

    let deltaClass = 'flat', deltaText = '';
    if (currentRM !== null && prevRM !== null) {
      const diff = currentRM - prevRM;
      if (diff > 0.5)  { deltaClass = 'up';   deltaText = `↗ +${diff.toFixed(1)}`; }
      else if (diff < -0.5) { deltaClass = 'down'; deltaText = `↘ ${diff.toFixed(1)}`; }
      else                  { deltaClass = 'flat'; deltaText = '→'; }
    }
    const isPR = currentRM !== null && allTimeRM !== null
      && currentRM >= allTimeRM && allDates.length >= 2;

    const tile = document.createElement('div');
    tile.className = 'gym-1rm-tile';
    tile.style.borderColor = lift.color + '33';
    tile.addEventListener('click', () => gymOpenKeyLiftModal(lift.label));

    const hint = document.createElement('span'); hint.className = 'gym-1rm-edit-hint'; hint.textContent = '✎';
    tile.appendChild(hint);

    const lbl = document.createElement('div'); lbl.className = 'gym-1rm-label'; lbl.textContent = ex ? ex.name.toUpperCase() : lift.label;
    const valRow = document.createElement('div'); valRow.className = 'gym-1rm-val-row';
    const valEl  = document.createElement('span'); valEl.className = 'gym-1rm-val';
    valEl.style.color = currentRM !== null ? lift.color : 'var(--text-tertiary)';
    valEl.textContent = currentRM !== null ? Math.round(currentRM) : '—';
    const unitEl = document.createElement('span'); unitEl.className = 'gym-1rm-unit';
    unitEl.textContent = currentRM !== null ? state.units : '';
    valRow.append(valEl, unitEl);

    const delta = document.createElement('div');
    delta.className = `gym-1rm-delta ${deltaClass}`;
    delta.textContent = deltaText;

    tile.append(lbl, valRow, delta);

    if (sessionRMs.length >= 2) {
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('class', 'gym-1rm-spark');
      svg.setAttribute('viewBox', '0 0 100 28');
      svg.setAttribute('preserveAspectRatio', 'none');
      const yMin = Math.min(...sessionRMs), yMax = Math.max(...sessionRMs);
      const yR = yMax - yMin || 1;
      const pts = sessionRMs.map((v,i) => {
        const x = (i/(sessionRMs.length-1))*96+2;
        const y = 24 - ((v-yMin)/yR)*20+2;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      const poly = document.createElementNS(ns, 'polyline');
      poly.setAttribute('points', pts);
      poly.setAttribute('fill', 'none');
      poly.setAttribute('stroke', lift.color);
      poly.setAttribute('stroke-width', '1.5');
      poly.setAttribute('stroke-linejoin', 'round');
      poly.setAttribute('stroke-linecap', 'round');
      svg.appendChild(poly);
      tile.appendChild(svg);
    }

    if (isPR) {
      const pr = document.createElement('div'); pr.className = 'gym-1rm-pr'; pr.textContent = 'PR';
      tile.appendChild(pr);
    }

    el.appendChild(tile);
  });
}

let _gymKeyLiftEditing = null;

function gymOpenKeyLiftModal(liftLabel) {
  const state = loadGymState();
  _gymKeyLiftEditing = liftLabel;

  const titleEl = document.getElementById('gymKeyLiftModalTitle');
  if (titleEl) titleEl.textContent = 'Map Key Lift: ' + liftLabel;

  const sel = document.getElementById('gymKeyLiftExSel');
  if (sel) {
    sel.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '— Auto (name match) —';
    sel.appendChild(auto);
    state.exercises.forEach(ex => {
      const opt = document.createElement('option');
      opt.value = ex.id;
      opt.textContent = ex.name;
      sel.appendChild(opt);
    });
    sel.value = (state.keyLiftOverrides || {})[liftLabel] || '';
  }

  const modal = document.getElementById('gymKeyLiftModal');
  if (modal) modal.style.display = 'flex';
}

function gymCloseKeyLiftModal() {
  const modal = document.getElementById('gymKeyLiftModal');
  if (modal) modal.style.display = 'none';
  _gymKeyLiftEditing = null;
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('gymKeyLiftSaveBtn')?.addEventListener('click', () => {
    if (!_gymKeyLiftEditing) return;
    const sel = document.getElementById('gymKeyLiftExSel');
    const state = loadGymState();
    if (!state.keyLiftOverrides) state.keyLiftOverrides = {};
    if (sel.value) {
      state.keyLiftOverrides[_gymKeyLiftEditing] = sel.value;
    } else {
      delete state.keyLiftOverrides[_gymKeyLiftEditing];
    }
    saveGymState(state);
    gymCloseKeyLiftModal();
    gymRender1RMTiles();
  });

  document.getElementById('gymKeyLiftCancelBtn')?.addEventListener('click', gymCloseKeyLiftModal);
  document.getElementById('gymKeyLiftModalBg')?.addEventListener('click', gymCloseKeyLiftModal);
});

let _gymActiveQueueEx = null;
let _gymRestTimer     = null;
let _gymRestRemaining  = 0;
let _gymRestExId       = null;

function gymQueueLogSet(exId, weight, reps) {
  const state = loadGymState();
  const ex    = state.exercises.find(e => e.id === exId);
  if (!ex) return;
  if (!state.logs[exId]) state.logs[exId] = [];
  state.logs[exId].push({ weight, reps, date: gymToday(), unit: state.units });
  state.currentEx = exId;
  const sel = document.getElementById('poExSel'); if (sel) sel.value = exId;
  poDraftWeight = null; poDraftReps = null; poDraftRir = null;
  _coachExId = null; // allow coach card to advance to next queue item on next render
  saveGymState(state);
  const restSecs = ex.restSeconds || 90;
  if (_gymRestTimer) clearInterval(_gymRestTimer);
  _gymRestRemaining = restSecs;
  _gymRestExId = exId;
  _gymRestTimer = setInterval(() => {
    _gymRestRemaining--;
    const timerEl = document.getElementById('gymQInlineTimer');
    if (timerEl && _gymRestExId === exId && _gymRestRemaining > 0) {
      const mm = Math.floor(_gymRestRemaining/60);
      const ss = String(_gymRestRemaining%60).padStart(2,'0');
      timerEl.textContent = `Rest ${mm}:${ss}`;
    }
    if (_gymRestRemaining <= 0) {
      clearInterval(_gymRestTimer); _gymRestTimer = null;
      const timerEl = document.getElementById('gymQInlineTimer');
      if (timerEl) timerEl.textContent = '';
    }
  }, 1000);
  renderGym();
}

function gymRenderQueue() {
  const state  = loadGymState();
  const today  = gymToday();
  const listEl = document.getElementById('gymQueueList');
  const timeEl = document.getElementById('gymQueueTimeLeft');
  const progEl = document.getElementById('gymQueueProgress');
  if (!listEl) return;

  // Auto-reset queue on new day
  if (state.queueDate !== today) {
    state.queue = []; state.queueDate = today;
    saveGymState(state);
    gymShowToast('New day — queue cleared');
  }

  // Wire clear button once
  const clearBtn = document.getElementById('gymQueueClearBtn');
  if (clearBtn && !clearBtn._wired) {
    clearBtn._wired = true;
    clearBtn.onclick = () => {
      if (!(state.queue || []).length) return;
      if (!confirm('Clear the queue?')) return;
      const s = loadGymState(); s.queue = []; s.currentEx = null;
      _gymActiveQueueEx = null; saveGymState(s);
      gymRenderLibrary(); gymRenderQueue(); poRenderCoach();
    };
  }

  const queue = state.queue || [];

  function getTodaySets(exId) { return (state.logs[exId]||[]).filter(l => l.date === today); }
  function getTargetSets(ex)  { return ex.targetSets || 3; }
  function isDone(ex)         { return getTodaySets(ex.id).length >= getTargetSets(ex); }

  let doneCount = 0, pendingSets = 0;
  queue.forEach(exId => {
    const ex = state.exercises.find(e => e.id === exId);
    if (!ex) return;
    if (isDone(ex)) doneCount++;
    else pendingSets += getTargetSets(ex) - getTodaySets(exId).length;
  });

  if (progEl) progEl.textContent = queue.length ? `${doneCount}/${queue.length}` : '';
  if (timeEl) {
    if (!queue.length) timeEl.textContent = '—';
    else if (doneCount >= queue.length) timeEl.textContent = 'DONE ✓';
    else timeEl.textContent = pendingSets > 0 ? `~${pendingSets*3} MIN LEFT` : '—';
  }

  listEl.innerHTML = '';

  if (!queue.length) {
    listEl.innerHTML = '<div class="empty-state" style="font-size:13px;color:var(--text-tertiary);padding:16px 4px;font-family:ui-monospace,monospace;text-align:center;">Open the library above to add exercises</div>';
    return;
  }

  queue.forEach((exId, idx) => {
    const ex = state.exercises.find(e => e.id === exId);
    if (!ex) return;

    const todaySets  = getTodaySets(exId);
    const targetSets = getTargetSets(ex);
    const done       = todaySets.length >= targetSets;
    const isFirst    = idx === 0;
    const isActive   = _gymActiveQueueEx === exId && !done;

    const pastLogs   = (state.logs[exId]||[]).filter(l => l.date < today);
    const pastByDate = {};
    pastLogs.forEach(l => { if (!pastByDate[l.date]) pastByDate[l.date] = []; pastByDate[l.date].push(l); });
    const lastDate   = Object.keys(pastByDate).sort().pop();
    const lastSets   = lastDate ? pastByDate[lastDate] : null;
    let lastText = '';
    if (lastSets?.length) {
      const wStr = ex.bw ? 'BW' : lastSets[0].weight;
      lastText = `last · ${wStr}×${lastSets.map(s=>s.reps).join(',')}`;
    }

    const sugg   = gymSuggestion(state, exId);
    const coach  = poCoachState(state, exId);
    const tgtWt  = coach ? coach.weight : (sugg?.weight ?? ex.startWeight);
    const tgtRep = coach ? coach.reps   : ex.repMin;

    let exIsPR = false;
    if (!ex.bw && todaySets.length > 0) {
      const todayBest = Math.max(...todaySets.map(s => poCalc1RM(s.weight, s.reps)));
      const priorLogs = (state.logs[exId]||[]).filter(l => l.date < today);
      if (priorLogs.length) {
        const allBest = Math.max(...priorLogs.map(s => poCalc1RM(s.weight, s.reps)));
        if (todayBest >= allBest) exIsPR = true;
      }
    }

    const row = document.createElement('div');
    row.id = `gymQRow_${exId}`;
    row.className = 'gym-q-row' + (done ? ' done' : isActive ? ' active' : '');

    const bar  = document.createElement('div'); bar.className = 'gym-q-accent-bar';

    // Reorder buttons
    const reorder = document.createElement('div'); reorder.className = 'gym-q-reorder';
    const upBtn   = document.createElement('button'); upBtn.className = 'gym-q-reorder-btn'; upBtn.textContent = '▲'; upBtn.disabled = idx === 0;
    const dnBtn   = document.createElement('button'); dnBtn.className = 'gym-q-reorder-btn'; dnBtn.textContent = '▼'; dnBtn.disabled = idx === queue.length - 1;
    upBtn.onclick = e => { e.stopPropagation(); const s = loadGymState(); [s.queue[idx-1],s.queue[idx]]=[s.queue[idx],s.queue[idx-1]]; saveGymState(s); gymRenderQueue(); gymRenderLibrary(); };
    dnBtn.onclick = e => { e.stopPropagation(); const s = loadGymState(); [s.queue[idx],s.queue[idx+1]]=[s.queue[idx+1],s.queue[idx]]; saveGymState(s); gymRenderQueue(); gymRenderLibrary(); };
    reorder.append(upBtn, dnBtn);

    const body = document.createElement('div'); body.className = 'gym-q-body';
    const top  = document.createElement('div'); top.className  = 'gym-q-top';
    const nm   = document.createElement('span'); nm.className  = 'gym-q-name'; nm.textContent = ex.name;
    top.appendChild(nm);
    if (isFirst && !done) { const nb = document.createElement('span'); nb.className = 'gym-q-next-badge'; nb.textContent = 'NEXT'; top.appendChild(nb); }
    if (exIsPR)           { const pr = document.createElement('span'); pr.className = 'gym-q-pr'; pr.textContent = 'PR'; top.appendChild(pr); }
    const lastEl = document.createElement('div'); lastEl.className = 'gym-q-last'; lastEl.textContent = lastText;
    body.append(top, lastEl);

    const right  = document.createElement('div'); right.className = 'gym-q-right';
    const wDiv   = document.createElement('div'); wDiv.className  = 'gym-q-weight';
    const wVal   = document.createElement('span'); wVal.textContent = ex.bw ? 'BW' : tgtWt;
    const wUnit  = document.createElement('span'); wUnit.className = 'gym-q-wunit'; wUnit.textContent = ex.bw ? '' : state.units;
    const scheme = document.createElement('div'); scheme.className = 'gym-q-scheme';
    scheme.textContent = `${targetSets}×${ex.repMin}-${ex.repMax}`;
    wDiv.append(wVal, wUnit); right.append(wDiv, scheme);

    // Remove from queue button
    const removeBtn = document.createElement('button');
    removeBtn.className = 'gym-q-remove'; removeBtn.textContent = '×';
    removeBtn.title = `Remove ${ex.name} from queue`;
    removeBtn.onclick = e => {
      e.stopPropagation();
      const s = loadGymState();
      s.queue = s.queue.filter(id => id !== exId);
      if (_gymActiveQueueEx === exId) _gymActiveQueueEx = null;
      saveGymState(s); gymRenderLibrary(); gymRenderQueue();
    };

    // Log circle
    const circle = document.createElement('button');
    circle.className = 'gym-q-circle' + (done ? ' filled' : '');
    circle.textContent = done ? '✓' : '+';
    circle.onclick = e => { e.stopPropagation(); if (!done) gymQueueLogSet(exId, tgtWt, tgtRep); };

    row.append(bar, reorder, body, right, removeBtn, circle);

    if (!done) {
      row.onclick = e => {
        if ([upBtn,dnBtn,removeBtn,circle].some(b => b.contains(e.target))) return;
        const s = loadGymState(); s.currentEx = exId; saveGymState(s);
        const sel = document.getElementById('poExSel'); if (sel) sel.value = exId;
        poDraftWeight = null; poDraftReps = null; poDraftRir = null;
        _gymActiveQueueEx = (_gymActiveQueueEx === exId) ? null : exId;
        gymRenderQueue(); poRenderCoach(); poRenderStats();
      };
    }

    listEl.appendChild(row);

    if (isActive) {
      const inline = document.createElement('div'); inline.className = 'gym-q-inline';
      const hdr = document.createElement('div'); hdr.className = 'gym-q-inline-hdr';
      const colBtn = document.createElement('button'); colBtn.className = 'gym-q-collapse'; colBtn.textContent = '×';
      colBtn.onclick = e => { e.stopPropagation(); _gymActiveQueueEx = null; gymRenderQueue(); };
      hdr.appendChild(colBtn);
      inline.appendChild(hdr);

      const timerEl = document.createElement('div'); timerEl.className = 'gym-q-inline-timer'; timerEl.id = 'gymQInlineTimer';
      if (_gymRestTimer && _gymRestExId === exId && _gymRestRemaining > 0) {
        const mm = Math.floor(_gymRestRemaining/60), ss = String(_gymRestRemaining%60).padStart(2,'0');
        timerEl.textContent = `Rest ${mm}:${ss}`;
      }

      const setsDiv = document.createElement('div'); setsDiv.className = 'gym-q-inline-sets';
      for (let i = 0; i < targetSets; i++) {
        const logged = todaySets[i];
        const sRow = document.createElement('div');
        sRow.className = 'gym-q-inline-set-row' + (logged ? ' logged' : '');
        const setNum = document.createElement('div'); setNum.className = 'gym-q-inline-set-num'; setNum.textContent = `SET ${i+1}`;
        const wtIn = document.createElement('input');
        wtIn.type = 'number'; wtIn.className = 'gym-q-inline-input';
        wtIn.value = logged ? logged.weight : tgtWt; wtIn.min = '0'; wtIn.step = String(ex.step || 2.5);
        if (ex.bw) wtIn.style.display = 'none';
        const wtUnit = document.createElement('span'); wtUnit.className = 'gym-q-inline-unit'; wtUnit.textContent = ex.bw ? '' : state.units;
        const repsIn = document.createElement('input');
        repsIn.type = 'number'; repsIn.className = 'gym-q-inline-input';
        repsIn.value = logged ? logged.reps : tgtRep; repsIn.min = '1'; repsIn.max = '99';
        const repsUnit = document.createElement('span'); repsUnit.className = 'gym-q-inline-unit'; repsUnit.textContent = 'reps';
        sRow.append(setNum, wtIn, wtUnit, repsIn, repsUnit);
        if (!logged) {
          const logBtn = document.createElement('button'); logBtn.className = 'gym-q-inline-log-btn'; logBtn.textContent = 'Log';
          logBtn.onclick = () => gymQueueLogSet(exId, ex.bw ? 0 : (parseFloat(wtIn.value)||0), parseInt(repsIn.value)||ex.repMin);
          sRow.appendChild(logBtn);
        }
        setsDiv.appendChild(sRow);
      }
      inline.append(timerEl, setsDiv);
      listEl.appendChild(inline);
    }
  });
}

function gymRenderLibrary() {
  const el = document.getElementById('gymLibraryList');
  if (!el) return;
  const state = loadGymState();
  const today = gymToday();
  const queue = state.queue || [];

  el.innerHTML = '';

  // Search input
  const controls = document.createElement('div');
  controls.className = 'gym-lib-controls';

  const searchInput = document.createElement('input');
  searchInput.className = 'gym-lib-search';
  searchInput.placeholder = 'Search exercises…';
  searchInput.value = _libSearch;
  searchInput.oninput = e => {
    _libSearch = e.target.value;
    const sel = e.target.selectionStart;
    gymRenderLibrary();
    const inp = document.querySelector('.gym-lib-search');
    if (inp) { inp.focus(); try { inp.setSelectionRange(sel, sel); } catch(_) {} }
  };
  controls.appendChild(searchInput);

  // Muscle group filter pills
  const pillRow = document.createElement('div');
  pillRow.className = 'gym-lib-filter-pills';
  _GYM_MUSCLE_GROUPS.forEach(g => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gym-lib-filter-pill' + (_libMuscle === g.label ? ' active' : '');
    btn.textContent = g.label;
    btn.onclick = () => { _libMuscle = _libMuscle === g.label ? null : g.label; gymRenderLibrary(); };
    pillRow.appendChild(btn);
  });
  controls.appendChild(pillRow);
  el.appendChild(controls);

  // Filter exercises
  const search = _libSearch.trim().toLowerCase();
  const exs = state.exercises.filter(e => {
    if (!gymExDays(e).includes(state.filterDay)) return false;
    if (search && !e.name.toLowerCase().includes(search)) return false;
    if (_libMuscle && !gymExMatchesGroup(e, _libMuscle)) return false;
    return true;
  });

  if (!exs.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:12px;color:var(--text-tertiary);padding:6px 4px;font-family:ui-monospace,monospace;';
    empty.textContent = 'No exercises match.';
    el.appendChild(empty);
    return;
  }

  exs.forEach(ex => {
    const inQueue = queue.includes(ex.id);
    const pastLogs = (state.logs[ex.id]||[]).filter(l => l.date < today).sort((a,b) => a.date < b.date ? 1 : -1);
    const last = pastLogs[0];

    const row = document.createElement('div'); row.className = 'gym-lib-row';
    const info = document.createElement('div'); info.className = 'gym-lib-info';
    const nm   = document.createElement('span'); nm.className = 'gym-lib-name'; nm.textContent = ex.name;
    const sub  = document.createElement('span'); sub.className = 'gym-lib-sub';
    if (last) sub.textContent = ex.bw ? `last: BW×${last.reps}` : `last: ${last.weight}×${last.reps}`;
    else      sub.textContent = `${ex.repMin}–${ex.repMax} reps · ${ex.bw ? 'BW' : ex.startWeight + state.units}`;
    info.append(nm, sub);

    const addBtn = document.createElement('button');
    addBtn.className = 'gym-lib-add-btn' + (inQueue ? ' in-queue' : '');
    addBtn.textContent = inQueue ? 'QUEUED' : '+ ADD';
    addBtn.disabled = inQueue;
    addBtn.onclick = () => {
      const s = loadGymState();
      if ((s.queue||[]).includes(ex.id)) return;
      s.queue = [...(s.queue||[]), ex.id];
      s.queueDate = gymToday();
      if (!s.currentEx) s.currentEx = ex.id;
      saveGymState(s);
      gymRenderLibrary(); gymRenderQueue();
    };

    row.append(info, addBtn);
    el.appendChild(row);
  });
}

function renderGym() {
  gymRenderHeaderStrip();
  poRenderDayPill();
  if (window._mmUpdate) window._mmUpdate();
  gymRenderSplitTabs();
  gymRender1RMTiles();
  gymRenderQueue();
  gymRenderLibrary();
  poRenderFilters();
  poRenderLogger();
  poRenderCoach();
  poRenderStats();
  poRenderSummary();
  poRenderHistory();
  wtRender();
  gymRenderMgmt();
  renderGymPrTicker();
}

function renderGymPrTicker() {
  const el = document.getElementById('gymPrTicker');
  if (!el) return;

  const state = loadGymState();
  const allExIds = new Set();
  (state.splitRotation || []).forEach(dayName => {
    ((state.splits || {})[dayName] || []).forEach(ex => allExIds.add(ex.id));
  });
  Object.keys(state.logs || {}).forEach(id => allExIds.add(id));

  const items = [];
  allExIds.forEach(exId => {
    const logs = (state.logs[exId] || []).slice().sort((a, b) => a.date < b.date ? -1 : 1);
    if (logs.length < 2) return;

    let exName = exId;
    (state.splitRotation || []).forEach(dayName => {
      ((state.splits || {})[dayName] || []).forEach(ex => { if (ex.id === exId) exName = ex.name; });
    });
    (state.exercises || []).forEach(ex => { if (ex.id === exId) exName = ex.name; });

    const todayKey = logs[logs.length - 1].date;
    const allTime1RM = logs.reduce((best, l) => {
      if (l.weight == null || l.reps == null) return best;
      const rm = l.weight * (1 + l.reps / 30);
      return rm > best ? rm : best;
    }, 0);
    const prevLogs = logs.filter(l => l.date < todayKey);
    const prev1RM = prevLogs.reduce((best, l) => {
      if (l.weight == null || l.reps == null) return best;
      const rm = l.weight * (1 + l.reps / 30);
      return rm > best ? rm : best;
    }, 0);

    if (allTime1RM < 1) return;
    const trend = allTime1RM > prev1RM * 1.01 ? 'up' : 'flat';
    const units = state.units || 'kg';
    items.push({ name: exName, val: Math.round(allTime1RM) + units, trend });
  });

  if (items.length < 2) { el.style.display = 'none'; return; }
  el.style.display = '';

  const itemsHtml = items.map(it =>
    `<div class="gym-pr-item">
      <span class="gym-pr-item-name">${it.name}</span>
      <span class="gym-pr-item-val">${it.val}</span>
      <span class="gym-pr-item-arrow ${it.trend}">${it.trend === 'up' ? '↑' : '→'}</span>
    </div>`
  ).join('');

  el.innerHTML = `
    <div class="gym-pr-badge">
      <span class="gym-pr-badge-dot"></span>
      <span class="gym-pr-badge-lbl">PRs</span>
    </div>
    <div class="gym-pr-viewport">
      <div class="gym-pr-track">${itemsHtml}${itemsHtml}</div>
    </div>`;
}

function poRenderDayPill() {
  const state = loadGymState();
  const auto  = gymAutoDay(state);
  const t = gymToday();
  const [y,m,d] = t.split('-').map(Number);
  const dt = new Date(y,m-1,d);
  const WD = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const txt = document.getElementById('poDayPillTxt');
  const dot = document.getElementById('poDayPillDot');
  if (txt) txt.textContent = `${WD[dt.getDay()]} ${MO[m-1]} ${d} · ${auto || '—'}`;
  if (dot) dot.style.background = state.days.find(dd => dd.name === auto) ? '#5BB8F5' : 'var(--text-tertiary)';
}

function poRenderFilters() {
  const state  = loadGymState();
  const daySeg = document.getElementById('poDaySeg');
  if (daySeg) {
    daySeg.innerHTML = '';
    state.days.forEach(dd => {
      const btn = document.createElement('button');
      btn.className = 'po-seg-btn' + (state.filterDay === dd.id ? ' active' : '');
      btn.textContent = dd.name;
      btn.onclick = () => {
        const s = loadGymState(); s.filterDay = dd.id; s._userPickedDay = true;
        const exs = s.exercises.filter(e => gymExDays(e).includes(dd.id));
        if (!exs.find(e => e.id === s.currentEx)) { s.currentEx = exs[0]?.id || null; poDraftWeight = null; poDraftReps = null; poDraftRir = null; }
        saveGymState(s); renderGym();
      };
      daySeg.appendChild(btn);
    });
    const restBtn = document.createElement('button');
    restBtn.className = 'po-seg-btn' + (state.filterDay === 'rest' ? ' active' : '');
    restBtn.textContent = 'Rest';
    restBtn.onclick = () => {
      const s = loadGymState(); s.filterDay = 'rest'; s._userPickedDay = true; saveGymState(s); renderGym();
    };
    daySeg.appendChild(restBtn);
  }
}

function poRenderLogger() {
  const state = loadGymState();
  const exs   = state.exercises.filter(e => gymExDays(e).includes(state.filterDay));
  const sel   = document.getElementById('poExSel');
  if (sel) {
    const prev = sel.value;
    sel.innerHTML = '';
    if (!exs.length) {
      const opt = document.createElement('option'); opt.value = ''; opt.textContent = 'No exercises — add one in Settings'; sel.appendChild(opt);
    } else {
      exs.forEach(ex => { const opt = document.createElement('option'); opt.value = ex.id; opt.textContent = ex.name; sel.appendChild(opt); });
      if (state.currentEx && exs.find(e => e.id === state.currentEx))        sel.value = state.currentEx;
      else if (prev && exs.find(e => e.id === prev))                          sel.value = prev;
      else                                                                     sel.value = exs[0].id;
    }
  }
  poUpdateLoggerForEx();
}

function poUpdateLoggerForEx() {
  const state     = loadGymState();
  const ex        = gymQueueTopEx(state);
  const exId      = ex?.id || null;
  const bwBanner  = document.getElementById('poBwBanner');
  const wtVal     = document.getElementById('poWtVal');
  const repsRow   = document.getElementById('poRepsRow');

  // Reset drafts whenever the queue-top exercise changes
  if (exId !== _coachExId) { poDraftWeight = null; poDraftReps = null; poDraftRir = null; _coachExId = exId; }

  if (!ex) {
    if (bwBanner) bwBanner.style.display = 'none';
    if (wtVal)    wtVal.textContent = '—';
    if (repsRow)  repsRow.innerHTML = '';
    return;
  }
  if (bwBanner) bwBanner.style.display = ex.bw ? '' : 'none';
  const sugg  = gymSuggestion(state, exId);
  const coach = poCoachState(state, exId);
  if (poDraftWeight === null) poDraftWeight = coach ? coach.weight : (sugg?.weight ?? ex.startWeight);
  if (wtVal) {
    if (ex.bw) wtVal.textContent = poDraftWeight === 0 ? 'BW' : `+${poDraftWeight}${state.units}`;
    else       wtVal.textContent = `${poDraftWeight}${state.units}`;
  }
  if (repsRow) {
    repsRow.innerHTML = '';
    if (poDraftReps === null) poDraftReps = coach ? coach.reps : ex.repMin;
    for (let r = ex.repMin; r <= ex.repMax; r++) {
      const pill = document.createElement('button');
      pill.className = 'po-rep-pill' + (poDraftReps === r ? ' active' : '');
      pill.textContent = r;
      pill.onclick = () => { poDraftReps = r; poUpdateLoggerForEx(); };
      repsRow.appendChild(pill);
    }
  }
  const rirPills = document.getElementById('poRirPills');
  if (rirPills) {
    rirPills.innerHTML = '';
    const rirOptions = [{ label:'—', value:null },{ label:'0', value:0 },{ label:'1', value:1 },{ label:'2', value:2 },{ label:'3', value:3 },{ label:'4', value:4 }];
    rirOptions.forEach(opt => {
      const pill = document.createElement('button');
      pill.className = 'po-rep-pill' + (poDraftRir === opt.value ? ' active' : '');
      pill.textContent = opt.label;
      pill.onclick = () => { poDraftRir = opt.value; poUpdateLoggerForEx(); };
      rirPills.appendChild(pill);
    });
  }
}

function poRenderCoach() {
  const state     = loadGymState();
  const ex        = gymQueueTopEx(state);
  const hlEl      = document.getElementById('poCoachHL');
  const tagEl     = document.getElementById('poCoachTag');
  const exNameEl  = document.getElementById('gymCoachEx');
  const explainEl = document.getElementById('poCoachExplain');

  if (!ex) {
    const queueLen = (state.queue || []).length;
    if (hlEl)      hlEl.textContent = '—';
    if (tagEl)     { tagEl.textContent = ''; tagEl.className = 'gym-coach-badge start'; }
    if (exNameEl)  exNameEl.textContent = queueLen ? 'ALL DONE — GREAT WORKOUT!' : 'QUEUE EMPTY';
    if (explainEl) explainEl.textContent = queueLen ? 'All sets logged. Rest up.' : 'Open the exercise library above to build your queue.';
    return;
  }

  const exId  = ex.id;
  const coach = poCoachState(state, exId);
  const sugg  = gymSuggestion(state, exId);
  if (!coach) return;
  if (exNameEl) exNameEl.textContent = ex.name.toUpperCase();
  const wStr = ex.bw ? (coach.weight === 0 ? 'BW' : `BW+${coach.weight}`) : `${coach.weight}${state.units}`;
  if (hlEl) hlEl.textContent = `${wStr} × ${coach.reps}`;
  const modeMap = { start:{ text:'Start here', cls:'start' }, add_rep:{ text:'Add a rep', cls:'up' }, add_weight:{ text:'Add weight', cls:'hold' }, deload:{ text:'Deload', cls:'deload' } };
  const m = modeMap[coach.mode] || { text:'', cls:'' };
  if (tagEl) { tagEl.textContent = m.text; tagEl.className = `gym-coach-badge ${m.cls}`; }
  if (explainEl) {
    const lastWStr = sugg?.lastWeight != null
      ? (ex.bw ? (sugg.lastWeight === 0 ? 'BW' : `BW+${sugg.lastWeight}${state.units}`) : `${sugg.lastWeight}${state.units}`)
      : null;
    const explains = {
      start:      `No history yet — start at ${wStr} and aim for ${ex.repMin}–${ex.repMax} reps.`,
      add_rep:    lastWStr ? `Last session: ${lastWStr} × ${sugg.lastReps}. Hit your target — push for one more rep today.` : 'Hit your target last session — push for one more rep today.',
      add_weight: coach._rirJump
        ? `Topped the rep range with RIR ${coach._lastRir} — jumping 2 weight steps today.`
        : (lastWStr ? `Last session: ${lastWStr} × ${sugg.lastReps}. Topped the rep range — bump weight today.` : `Topped the rep range — bump weight by ${ex.step}${state.units} today.`),
      deload:     lastWStr ? `Stuck for 3 sessions at ${lastWStr}. Drop to 90% today and reset the progression.`            : 'Stuck for 3 sessions — drop to 90% today and reset.',
    };
    explainEl.textContent = explains[coach.mode] || '';
  }
  poUpdateLoggerForEx();
}

function poRenderStats() {
  const state   = loadGymState();
  const ex      = gymQueueTopEx(state);
  const exId    = ex?.id;
  const chipsEl = document.getElementById('poStatsChips');
  const svgEl   = document.getElementById('poRmSpark');
  if (!chipsEl || !svgEl) return;
  chipsEl.innerHTML = '';
  svgEl.innerHTML   = '';
  if (!ex) return;
  if (!ex) return;
  const logs = (state.logs[exId] || []).slice().sort((a,b) => a.date < b.date ? -1 : 1);

  // Stat chips
  let est1RM = '—', bestSet = '—', totalSessions = 0;
  if (logs.length) {
    totalSessions = new Set(logs.map(l => l.date)).size;
    if (ex.bw) {
      const maxReps = Math.max(...logs.map(l => l.reps));
      est1RM  = maxReps + ' reps';
      bestSet = maxReps + '×BW';
    } else {
      let best1RM = 0, bestLog = null;
      logs.forEach(l => { const rm = poCalc1RM(l.weight, l.reps); if (rm > best1RM) { best1RM = rm; bestLog = l; } });
      est1RM  = Math.round(best1RM) + state.units;
      bestSet = bestLog ? `${bestLog.weight}×${bestLog.reps}` : '—';
    }
  }
  [
    { lbl: ex.bw ? 'Best reps' : 'Est. 1RM', val: est1RM     },
    { lbl: 'Best set',                        val: bestSet     },
    { lbl: 'Sessions',                        val: String(totalSessions) },
  ].forEach(c => {
    const chip = document.createElement('div'); chip.className = 'gym-stat-chip';
    const lbl  = document.createElement('div'); lbl.className = 'gym-stat-chip-lbl'; lbl.textContent = c.lbl;
    const val  = document.createElement('div'); val.className = 'gym-stat-chip-val'; val.textContent = c.val;
    chip.append(lbl, val); chipsEl.appendChild(chip);
  });

  // Sparkline — last 10 logs, y = 1RM (or reps for BW)
  const last10 = logs.slice(-10);
  if (last10.length < 2) {
    svgEl.innerHTML = '<text x="150" y="34" fill="var(--text-tertiary)" font-size="11" text-anchor="middle">No data yet</text>';
    return;
  }
  const yVals = ex.bw ? last10.map(l => l.reps) : last10.map(l => poCalc1RM(l.weight, l.reps));
  const yMin = Math.min(...yVals), yMax = Math.max(...yVals), yRange = yMax - yMin || 1;
  const W = 300, H = 60, pad = 6;
  const pts = yVals.map((v, i) => ({
    x: pad + (i / (yVals.length - 1)) * (W - pad * 2),
    y: H - pad - ((v - yMin) / yRange) * (H - pad * 2),
  }));
  const polyPts  = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const fillPts  = `${pts[0].x.toFixed(1)},${H} ${polyPts} ${pts[pts.length-1].x.toFixed(1)},${H}`;
  const uid = 'rmGrad' + exId.replace(/\W/g,'');
  const ns  = 'http://www.w3.org/2000/svg';
  const defs = document.createElementNS(ns,'defs');
  const grad = document.createElementNS(ns,'linearGradient');
  grad.setAttribute('id',uid); grad.setAttribute('x1','0'); grad.setAttribute('x2','0'); grad.setAttribute('y1','0'); grad.setAttribute('y2','1');
  const s0 = document.createElementNS(ns,'stop'); s0.setAttribute('offset','0%');   s0.setAttribute('stop-color','rgba(255,255,255,0.18)');
  const s1 = document.createElementNS(ns,'stop'); s1.setAttribute('offset','100%'); s1.setAttribute('stop-color','rgba(255,255,255,0)');
  grad.append(s0,s1); defs.appendChild(grad); svgEl.appendChild(defs);
  const fill = document.createElementNS(ns,'polygon');
  fill.setAttribute('points',fillPts); fill.setAttribute('fill',`url(#${uid})`); svgEl.appendChild(fill);
  const line = document.createElementNS(ns,'polyline');
  line.setAttribute('points',polyPts); line.setAttribute('fill','none'); line.setAttribute('stroke','rgba(255,255,255,0.85)');
  line.setAttribute('stroke-width','1.5'); line.setAttribute('stroke-linejoin','round'); line.setAttribute('stroke-linecap','round');
  svgEl.appendChild(line);
  const last = pts[pts.length-1];
  const dot = document.createElementNS(ns,'circle');
  dot.setAttribute('cx',last.x.toFixed(1)); dot.setAttribute('cy',last.y.toFixed(1)); dot.setAttribute('r','3'); dot.setAttribute('fill','white');
  svgEl.appendChild(dot);
}

function poRenderSummary() {
  const state   = loadGymState();
  const body    = document.getElementById('poSummaryBody');
  const metaEl  = document.getElementById('poSummaryMeta');
  const doneBtn = document.getElementById('poDoneBtn');
  if (!body) return;
  const today = gymToday();
  const isDone = !!(state.workoutDone && state.workoutDone[today]);
  if (doneBtn) {
    doneBtn.textContent = isDone ? 'COMPLETE ✓' : 'DONE ✓';
    doneBtn.className   = 'gym-today-done-btn' + (isDone ? ' complete' : '');
    doneBtn.onclick = () => {
      const s = loadGymState(); if (!s.workoutDone) s.workoutDone = {};
      s.workoutDone[today] = !s.workoutDone[today]; saveGymState(s); poRenderSummary();
    };
  }
  const todayEx = {}; let totalSets = 0, totalVol = 0;
  Object.entries(state.logs).forEach(([exId, logs]) => {
    const sets = (logs||[]).filter(l => l.date===today);
    if (sets.length) {
      const ex = state.exercises.find(e => e.id===exId);
      if (ex) { todayEx[exId] = { ex, sets }; totalSets += sets.length; if (!ex.bw) sets.forEach(s => { totalVol += s.weight * s.reps; }); }
    }
  });
  if (metaEl) {
    if (totalSets) metaEl.textContent = `${totalSets} SET${totalSets!==1?'S':''} · ${totalVol > 0 ? Math.round(totalVol) + state.units : 'BW'}`;
    else metaEl.textContent = '';
  }
  if (!Object.keys(todayEx).length) { body.innerHTML = '<div class="gym-today-empty">No sets logged today yet</div>'; return; }
  body.innerHTML = '';
  Object.entries(todayEx).forEach(([exId, { ex, sets }]) => {
    const exEl   = document.createElement('div'); exEl.className = 'gym-today-ex';
    const nameEl = document.createElement('div'); nameEl.className = 'gym-today-ex-name'; nameEl.textContent = ex.name.toUpperCase();
    const setsEl = document.createElement('div'); setsEl.className = 'gym-today-sets';
    sets.forEach((set, idx) => {
      const chip = document.createElement('span'); chip.className = 'gym-today-chip';
      const wStr = ex.bw ? 'BW' : `${set.weight}${set.unit||state.units}`;
      chip.textContent = `${set.reps}×${wStr}`;
      const del = document.createElement('button'); del.className = 'gym-today-chip-del'; del.textContent = '×';
      del.onclick = () => {
        const s = loadGymState(); const exLogs = s.logs[exId]||[]; let count=0;
        for (let i=0;i<exLogs.length;i++) { if (exLogs[i].date===today) { if (count===idx){exLogs.splice(i,1);break;} count++; } }
        s.logs[exId]=exLogs; saveGymState(s); renderGym();
      };
      chip.appendChild(del); setsEl.appendChild(chip);
    });
    exEl.append(nameEl, setsEl); body.appendChild(exEl);
  });
}

// ── Weight Tracker ────────────────────────────────────────────
const WT_KEY     = 'po_coach_weights';
const WT_APP_KEY = 'gym-weights';
const PHOTOS_KEY = 'po_coach_photos';

let wtSyncTimer      = null;
let wtLastPushedJson = null;

function wtLoad() {
  try { return JSON.parse(localStorage.getItem(WT_KEY)) || []; } catch { return []; }
}

function wtSave(entries) {
  localStorage.setItem(WT_KEY, JSON.stringify(entries));
  wtPushToSupabase(entries);
}

function wtPushToSupabase(entries) {
  if (!useSupabase) return;
  clearTimeout(wtSyncTimer);
  wtSyncTimer = setTimeout(async () => {
    if (!db || !currentUser) return;
    wtLastPushedJson = JSON.stringify(entries);
    setSyncing(true);
    try {
      await db.from('app_state').upsert(
        { user_id: currentUser.id, app_key: WT_APP_KEY, payload: entries, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,app_key' }
      );
    } catch { setSyncError(); wtLastPushedJson = null; } finally { setSyncing(false); }
  }, 250);
}

async function loadWtFromSupabase() {
  if (!db || !currentUser) return;
  const { data, error } = await db.from('app_state').select('payload')
    .eq('user_id', currentUser.id).eq('app_key', WT_APP_KEY).maybeSingle();
  if (error) return;
  if (!data || !data.payload) {
    const local = wtLoad();
    if (local.length > 0) wtPushToSupabase(local);
    return;
  }
  localStorage.setItem(WT_KEY, JSON.stringify(data.payload));
  wtRender();
}

function applyWtRemote(payload) {
  if (!payload) return;
  localStorage.setItem(WT_KEY, JSON.stringify(payload));
  wtRender();
}

function wtFmtDate(dateKey) {
  const [y,m,d] = dateKey.split('-').map(Number);
  const dt = new Date(y,m-1,d);
  const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${MO[m-1]} ${d}`;
}

function wtRender() {
  const entries = wtLoad().slice().sort((a,b) => a.dateKey < b.dateKey ? -1 : 1);
  const units   = loadGymState().units || 'kg';
  const today   = gymToday();

  const numEl    = document.getElementById('wtNum');
  const unitEl   = document.getElementById('wtUnitSpan');
  const inUnitEl = document.getElementById('wtInUnit');
  const deltaEl  = document.getElementById('wtDelta');
  const formEl   = document.getElementById('wtForm');
  const lockEl   = document.getElementById('wtLocked');
  const lockTxt  = document.getElementById('wtLockedTxt');
  const streakEl = document.getElementById('wtStreak');

  if (unitEl)   unitEl.textContent   = units;
  if (inUnitEl) inUnitEl.textContent = units;

  if (!entries.length) {
    if (numEl)  numEl.textContent = '—';
    if (deltaEl) { deltaEl.textContent = ''; deltaEl.className = 'wt-delta'; }
    if (formEl)  formEl.style.display = '';
    if (lockEl)  lockEl.style.display = 'none';
    if (streakEl) streakEl.style.display = 'none';
    wtRenderChart(entries);
    return;
  }

  const last = entries[entries.length - 1];
  const prev = entries.length >= 2 ? entries[entries.length - 2] : null;

  if (numEl) numEl.textContent = last.weight.toFixed(1);

  if (deltaEl) {
    if (prev) {
      const diff = last.weight - prev.weight;
      const sign = diff > 0 ? '+' : '';
      deltaEl.textContent = `${sign}${diff.toFixed(1)} ${units} vs last`;
      deltaEl.className = 'wt-delta ' + (diff > 0 ? 'up' : diff < 0 ? 'dn' : 'flat');
    } else {
      deltaEl.textContent = ''; deltaEl.className = 'wt-delta';
    }
  }

  // Streak
  if (streakEl) {
    let streak = 0;
    const logged = new Set(entries.map(e => e.dateKey));
    const d = new Date();
    while (true) {
      const dk = d.toISOString().slice(0,10);
      if (!logged.has(dk)) break;
      streak++;
      d.setDate(d.getDate() - 1);
    }
    if (streak > 1) {
      streakEl.textContent = `${streak}d streak`;
      streakEl.style.display = '';
    } else {
      streakEl.style.display = 'none';
    }
  }

  // Form vs locked state
  const todayEntry = entries.find(e => e.dateKey === today);
  if (todayEntry) {
    if (formEl) formEl.style.display = 'none';
    if (lockEl) lockEl.style.display = '';
    if (lockTxt) lockTxt.textContent = `Logged ${todayEntry.weight.toFixed(1)} ${units} today`;
  } else {
    if (formEl) formEl.style.display = '';
    if (lockEl) lockEl.style.display = 'none';
  }

  wtRenderChart(entries);
  // Refresh water goal and widget since weight data drives those calculations
  if (typeof waterGoalRender === 'function') waterGoalRender();
  if (typeof waterWidgetRender === 'function') waterWidgetRender();
}

function wtRenderChart(entries) {
  const svg     = document.getElementById('wtChart');
  const yAxisEl = document.getElementById('wt2YAxis');
  const metaEl  = document.getElementById('wt2ChartMeta');
  const chipEl  = document.getElementById('wt2DeltaChip');

  // 7-day delta chip
  if (chipEl) {
    const units = loadGymState().units || 'kg';
    let chipHtml = '';
    if (entries.length >= 2) {
      const sorted = entries.slice().sort((a,b) => a.dateKey < b.dateKey ? -1 : 1);
      const latest = sorted[sorted.length - 1];
      const cutoff = new Date(latest.dateKey); cutoff.setDate(cutoff.getDate() - 7);
      const inWin  = sorted.filter(e => new Date(e.dateKey) >= cutoff);
      const ref    = inWin.length >= 2 ? inWin[0] : null;
      if (ref) {
        const diff = latest.weight - ref.weight;
        if (Math.abs(diff) > 0.05) {
          const dn = diff < 0;
          chipHtml = `<span class="wt2-delta-chip ${dn ? 'down' : 'up'}">${dn ? '↓' : '↑'} ${Math.abs(diff).toFixed(1)} ${units} <span class="wt2-chip-window">· 7D</span></span>`;
        }
      }
    }
    chipEl.innerHTML = chipHtml;
  }

  if (!svg) return;

  const recent = entries.slice(-30);
  const W = 300, H = 150;

  if (recent.length < 2) {
    svg.innerHTML = recent.length === 1
      ? `<text x="150" y="80" fill="var(--text-tertiary)" font-size="11" text-anchor="middle">Log more to see trend</text>`
      : '';
    if (yAxisEl) yAxisEl.innerHTML = '<span></span><span></span>';
    if (metaEl)  metaEl.textContent = recent.length === 0 ? '' : '1 entry — log more to see trend';
    return;
  }

  const vals  = recent.map(e => e.weight);
  const lo    = Math.min(...vals), hi = Math.max(...vals);
  const range = Math.max(hi - lo, 0.3);
  const pT = 14, pB = 20, cH = H - pT - pB;

  const xOf = i  => ((i / (recent.length - 1)) * W).toFixed(2);
  const yOf = v  => (pT + (1 - (v - lo) / range) * cH).toFixed(2);
  const pts      = recent.map((e, i) => [xOf(i), yOf(e.weight)]);

  function smoothPath(p) {
    let d = `M ${p[0][0]} ${p[0][1]}`;
    for (let i = 1; i < p.length - 1; i++) {
      const mx = ((parseFloat(p[i][0]) + parseFloat(p[i+1][0])) / 2).toFixed(2);
      const my = ((parseFloat(p[i][1]) + parseFloat(p[i+1][1])) / 2).toFixed(2);
      d += ` Q ${p[i][0]} ${p[i][1]} ${mx} ${my}`;
    }
    d += ` T ${p[p.length-1][0]} ${p[p.length-1][1]}`;
    return d;
  }

  const lineD  = smoothPath(pts);
  const areaD  = `${lineD} L ${pts[pts.length-1][0]} ${H} L ${pts[0][0]} ${H} Z`;
  const avgPts = recent.map((_, i) => {
    const win = recent.slice(Math.max(0, i - 6), i + 1);
    const avg = win.reduce((s, e) => s + e.weight, 0) / win.length;
    return [xOf(i), yOf(avg)];
  });

  const showAvg = recent.length >= 4;
  const avgPathEl = showAvg
    ? `<path d="M ${avgPts.slice(2).map(p => p.join(',')).join(' L ')}" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="1.5" stroke-dasharray="4 3" stroke-linecap="round" stroke-linejoin="round"/>`
    : '';

  const lastPt = pts[pts.length - 1];
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.innerHTML = `
    <defs>
      <linearGradient id="pcf" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--success)" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="var(--success)" stop-opacity="0.01"/>
      </linearGradient>
    </defs>
    <path class="wt2-chart-area" fill="url(#pcf)" d="${areaD}"/>
    <path class="wt2-chart-line" d="${lineD}"/>
    ${avgPathEl}
    ${recent.slice(0,-1).map((_,i) => `<circle cx="${pts[i][0]}" cy="${pts[i][1]}" r="3" fill="var(--success)" opacity="0.45"/>`).join('')}
    <circle cx="${lastPt[0]}" cy="${lastPt[1]}" r="5" fill="var(--success)" style="filter:drop-shadow(0 0 4px rgba(107,227,164,0.7))"/>
  `;

  let legendEl = document.getElementById('wtChartLegend');
  if (!legendEl && svg.parentElement) {
    legendEl = document.createElement('div');
    legendEl.id = 'wtChartLegend';
    svg.parentElement.insertBefore(legendEl, svg.nextSibling);
  }
  if (legendEl) {
    legendEl.innerHTML = showAvg ? `<div class="wt-chart-legend"><div class="wt-legend-item"><span class="wt-legend-line wt-legend-line-solid"></span>Weight</div><div class="wt-legend-item"><span class="wt-legend-line wt-legend-line-dashed"></span>7d avg</div></div>` : '';
  }

  if (yAxisEl) yAxisEl.innerHTML = `<span>${hi.toFixed(1)}</span><span>${lo.toFixed(1)}</span>`;
  if (metaEl) {
    const dr = Math.round((new Date(recent[recent.length-1].dateKey) - new Date(recent[0].dateKey)) / 86400000) + 1;
    metaEl.textContent = `${recent.length} entr${recent.length !== 1 ? 'ies' : 'y'} · last ${dr} day${dr !== 1 ? 's' : ''}`;
  }
}

function wtInit() {
  const saveBtn = document.getElementById('wtSaveBtn');
  if (saveBtn) saveBtn.onclick = () => {
    const val = parseFloat(document.getElementById('wtIn')?.value);
    if (isNaN(val) || val <= 0) return;
    const today   = gymToday();
    const entries = wtLoad();
    const i = entries.findIndex(e => e.dateKey === today);
    if (i !== -1) entries[i].weight = val; else entries.push({ dateKey: today, weight: val });
    entries.sort((a,b) => a.dateKey < b.dateKey ? -1 : 1);
    const inEl = document.getElementById('wtIn');
    if (inEl) inEl.value = '';
    wtSave(entries); wtRender();
  };

  const lockEdit = document.getElementById('wtLockedEdit');
  if (lockEdit) lockEdit.onclick = () => {
    const today   = gymToday();
    const entries = wtLoad();
    const entry   = entries.find(e => e.dateKey === today);
    const inEl    = document.getElementById('wtIn');
    if (entry && inEl) inEl.value = entry.weight;
    wtSave(entries.filter(e => e.dateKey !== today));
    wtRender();
    if (inEl) setTimeout(() => inEl.focus(), 50);
  };

  const photosBtn = document.getElementById('wtPhotosBtn');
  if (photosBtn) photosBtn.onclick = photosOpen;

  photosInitHandlers();
  wtRender();
}

// ── Progress Photos ───────────────────────────────────────────
let photosSelectedIdx = null;

function photosLoad() {
  try { return JSON.parse(localStorage.getItem(PHOTOS_KEY)) || []; } catch { return []; }
}

function photosOpen() {
  const overlay = document.getElementById('photosOverlay');
  if (!overlay) return;
  document.querySelector('.tab-page.active')?.classList.add('has-overlay'); // lock background scroll
  overlay.classList.add('open');
  photosRender();
}

function photosClose() {
  const overlay = document.getElementById('photosOverlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  document.querySelectorAll('.tab-page.has-overlay').forEach(p => p.classList.remove('has-overlay'));
  document.getElementById('photoViewer')?.classList.remove('open');
  document.getElementById('photoCompare')?.classList.remove('open');
}

function photosRender() {
  const photos  = photosLoad().slice().sort((a,b) => a.dateKey < b.dateKey ? -1 : 1);
  const grid    = document.getElementById('photosGrid');
  const toolbar = document.getElementById('photosToolbar');
  if (!grid) return;
  if (toolbar) toolbar.style.display = photos.length >= 2 ? '' : 'none';
  if (!photos.length) {
    grid.innerHTML = '<div class="photos-empty">No photos yet.<br>Tap "+ Add" to get started.</div>';
    return;
  }
  const units = loadGymState().units || 'kg';
  grid.innerHTML = '';
  photos.forEach((p, i) => {
    const card = document.createElement('div'); card.className = 'photo-card';
    const img  = document.createElement('img'); img.src = p.dataUrl; img.alt = p.dateKey;
    const over = document.createElement('div'); over.className = 'photo-card-over';
    const date = document.createElement('div'); date.className = 'photo-card-date'; date.textContent = wtFmtDate(p.dateKey);
    const wt   = document.createElement('div'); wt.className = 'photo-card-wt';
    wt.textContent = p.weight ? `${p.weight} ${units}` : '';
    over.append(date, wt); card.append(img, over);
    card.onclick = () => photoViewerOpen(i, photos);
    grid.appendChild(card);
  });
}

function photoViewerOpen(idx, photos) {
  if (!photos) photos = photosLoad().slice().sort((a,b) => a.dateKey < b.dateKey ? -1 : 1);
  if (idx < 0 || idx >= photos.length) return;
  photosSelectedIdx = idx;
  const p = photos[idx];
  const viewer = document.getElementById('photoViewer');
  if (!viewer) return;
  document.getElementById('pvImg').src = p.dataUrl;
  document.getElementById('pvDate').textContent = wtFmtDate(p.dateKey);
  const units = loadGymState().units || 'kg';
  document.getElementById('pvWt').textContent = p.weight ? `${p.weight} ${units}` : '';
  viewer.classList.add('open');
}

function photosInitHandlers() {
  const back = document.getElementById('photosBack');
  if (back) back.onclick = photosClose;

  const fileIn = document.getElementById('photosFileIn');
  if (fileIn) fileIn.onchange = e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const today  = gymToday();
      const entry  = wtLoad().find(e => e.dateKey === today);
      const photos = photosLoad();
      photos.push({ dateKey: today, dataUrl: ev.target.result, weight: entry?.weight || null });
      localStorage.setItem(PHOTOS_KEY, JSON.stringify(photos));
      photosRender();
    };
    reader.readAsDataURL(file);
    fileIn.value = '';
  };

  const compareBtn = document.getElementById('photosCompareBtn');
  if (compareBtn) compareBtn.onclick = () => {
    const photos = photosLoad().slice().sort((a,b) => a.dateKey < b.dateKey ? -1 : 1);
    if (photos.length < 2) return;
    const body  = document.getElementById('pcBody');
    const units = loadGymState().units || 'kg';
    if (body) {
      body.innerHTML = '';
      [photos[0], photos[photos.length - 1]].forEach(p => {
        const side = document.createElement('div'); side.className = 'photo-compare-side';
        const img  = document.createElement('img'); img.src = p.dataUrl; img.alt = p.dateKey;
        const lbl  = document.createElement('div'); lbl.className = 'photo-compare-lbl';
        lbl.textContent = wtFmtDate(p.dateKey) + (p.weight ? ` · ${p.weight}${units}` : '');
        side.append(img, lbl); body.appendChild(side);
      });
    }
    document.getElementById('photoCompare')?.classList.add('open');
  };

  const pvBack = document.getElementById('pvBack');
  if (pvBack) pvBack.onclick = () => document.getElementById('photoViewer')?.classList.remove('open');

  const pvDel = document.getElementById('pvDel');
  if (pvDel) pvDel.onclick = () => {
    const photos = photosLoad().slice().sort((a,b) => a.dateKey < b.dateKey ? -1 : 1);
    if (photosSelectedIdx === null || photosSelectedIdx >= photos.length) return;
    if (!confirm('Delete this photo?')) return;
    const toDelete  = photos[photosSelectedIdx];
    const all       = photosLoad();
    const filtered  = all.filter(p => !(p.dateKey === toDelete.dateKey && p.dataUrl === toDelete.dataUrl));
    localStorage.setItem(PHOTOS_KEY, JSON.stringify(filtered));
    document.getElementById('photoViewer')?.classList.remove('open');
    photosSelectedIdx = null;
    photosRender();
  };

  const pcBack = document.getElementById('pcBack');
  if (pcBack) pcBack.onclick = () => document.getElementById('photoCompare')?.classList.remove('open');
}

function poLogSet() {
  const state = loadGymState();
  const ex    = gymQueueTopEx(state);
  if (!ex) return;
  const exId = ex.id;
  if (poDraftReps === null || poDraftReps < 1) return;
  const weight = ex.bw ? (poDraftWeight||0) : (poDraftWeight??0);
  if (!ex.bw && (isNaN(weight)||weight<0)) return;
  if (!state.logs[exId]) state.logs[exId] = [];
  state.logs[exId].push({ weight, reps:poDraftReps, date:gymToday(), unit:state.units, rir:poDraftRir });
  state.currentEx = exId;
  poDraftWeight = null; poDraftReps = null; poDraftRir = null;
  _coachExId = null; // force draft reset on next render so we pick up the new queue-top
  saveGymState(state);
  renderGym();
}

function poOpenRotModal() {
  const modal  = document.getElementById('poRotModal');
  const listEl = document.getElementById('poRotList');
  if (!modal||!listEl) return;
  modal.style.display = '';
  const render = () => {
    const s      = loadGymState();
    const auto   = gymAutoDay(s);
    listEl.innerHTML = '';
    s.splitRotation.forEach((name, idx) => {
      const item  = document.createElement('div'); item.className = 'po-rot-item';

      const reorder = document.createElement('div'); reorder.className = 'po-rot-reorder';
      const upBtn   = document.createElement('button'); upBtn.className = 'po-rot-up'; upBtn.textContent = '▲'; upBtn.disabled = idx === 0;
      const dnBtn   = document.createElement('button'); dnBtn.className = 'po-rot-dn'; dnBtn.textContent = '▼'; dnBtn.disabled = idx === s.splitRotation.length - 1;
      upBtn.onclick = () => { const ss=loadGymState(); [ss.splitRotation[idx-1],ss.splitRotation[idx]]=[ss.splitRotation[idx],ss.splitRotation[idx-1]]; saveGymState(ss); render(); };
      dnBtn.onclick = () => { const ss=loadGymState(); [ss.splitRotation[idx],ss.splitRotation[idx+1]]=[ss.splitRotation[idx+1],ss.splitRotation[idx]]; saveGymState(ss); render(); };
      reorder.append(upBtn, dnBtn);

      const nEl = document.createElement('span'); nEl.className = 'po-rot-name';
      if (name === auto) {
        const dot = document.createElement('span'); dot.className = 'po-rot-anchor';
        nEl.append(dot);
      }
      nEl.append(document.createTextNode(name));

      const del = document.createElement('button'); del.className = 'po-rot-del'; del.textContent = '×';
      del.onclick = () => { const ss=loadGymState(); ss.splitRotation.splice(idx,1); saveGymState(ss); render(); };

      item.append(reorder, nEl, del); listEl.appendChild(item);
    });
  };
  render();
  const addBtn = document.getElementById('poRotAddBtn');
  const addIn  = document.getElementById('poRotNewIn');
  if (addBtn) addBtn.onclick = () => { const v=addIn?.value.trim(); if(!v) return; const s=loadGymState(); s.splitRotation.push(v); saveGymState(s); if(addIn) addIn.value=''; render(); };
  const close = () => { modal.style.display='none'; };
  const bg    = document.getElementById('poRotModalBg');
  document.getElementById('poRotSaveBtn'  ).onclick = () => { close(); renderGym(); };
  document.getElementById('poRotCancelBtn').onclick = close;
  if (bg) bg.onclick = close;
}

function poOpenExEditModal(exId) {
  const state = loadGymState();
  const ex    = state.exercises.find(e => e.id===exId);
  const modal = document.getElementById('poExEditModal');
  if (!modal||!ex) return;
  modal.style.display = '';
  document.getElementById('poEditName'  ).value   = ex.name;
  document.getElementById('poEditRepMin').value   = ex.repMin;
  document.getElementById('poEditRepMax').value   = ex.repMax;
  document.getElementById('poEditStep'  ).value   = ex.step;
  document.getElementById('poEditStart' ).value   = ex.startWeight;
  document.getElementById('poEditSets'  ).value   = ex.targetSets || 3;
  const bwCheck   = document.getElementById('poEditBw');
  const bwSection = document.getElementById('poModalBwSection');
  if (bwCheck) bwCheck.checked = !!ex.bw;
  const syncBwSection = () => { if (bwSection && bwCheck) bwSection.classList.toggle('bw-hidden', bwCheck.checked); };
  if (bwCheck) bwCheck.onchange = syncBwSection;
  syncBwSection();
  const ladderCheck  = document.getElementById('poEditUseLadder');
  const stepInput    = document.getElementById('poEditStep');
  const ladderHint   = document.getElementById('poEditLadderHint');
  const doubleRow    = document.getElementById('poEditLadderDoubleRow');
  const doubleCheck  = document.getElementById('poEditLadderDouble');
  if (ladderCheck) {
    ladderCheck.checked = !!ex.useLadder;
    if (doubleCheck) doubleCheck.checked = !!ex.ladderDouble;
    const syncLadder = () => {
      if (stepInput) stepInput.disabled = ladderCheck.checked;
      if (ladderHint) ladderHint.style.display = ladderCheck.checked ? '' : 'none';
      if (doubleRow) doubleRow.style.display = ladderCheck.checked ? '' : 'none';
    };
    ladderCheck.onchange = syncLadder;
    syncLadder();
  }
  const dayToggle = document.getElementById('poEditDayToggle');
  if (dayToggle) {
    const exDays = gymExDays(ex);
    dayToggle.innerHTML = '';
    gymAllDays(state).forEach(d => dayToggle.appendChild(gymMakeDayToggleBtn(d, exDays.includes(d.id))));
  }
  gymRenderMuscleToggle(document.getElementById('poEditMuscleToggle'), ex.muscles || []);
  const close = () => { modal.style.display='none'; };
  const bg    = document.getElementById('poExEditModalBg');
  if (bg) bg.onclick = close;
  document.getElementById('poEditCancelBtn').onclick = close;
  document.getElementById('poEditSaveBtn').onclick = () => {
    const s = loadGymState(); const i = s.exercises.findIndex(e => e.id===exId); if (i===-1) { close(); return; }
    s.exercises[i] = { ...s.exercises[i],
      name:       document.getElementById('poEditName'  ).value.trim() || s.exercises[i].name,
      days:       (()=>{ const sel=[...document.querySelectorAll('#poEditDayToggle .gym-day-btn[data-selected="true"]')].map(b=>b.dataset.dayId); return sel.length ? sel : ['rest']; })(),
      repMin:     parseInt(  document.getElementById('poEditRepMin').value ) || s.exercises[i].repMin,
      repMax:     parseInt(  document.getElementById('poEditRepMax').value ) || s.exercises[i].repMax,
      step:       parseFloat(document.getElementById('poEditStep'  ).value ) || s.exercises[i].step,
      startWeight:parseFloat(document.getElementById('poEditStart' ).value ) ?? s.exercises[i].startWeight,
      bw:           bwCheck?.checked || undefined,
      useLadder:    document.getElementById('poEditUseLadder')?.checked || false,
      ladderDouble: document.getElementById('poEditLadderDouble')?.checked || false,
      muscles:    gymReadMuscleToggle(document.getElementById('poEditMuscleToggle')),
      targetSets: parseInt( document.getElementById('poEditSets'  ).value ) || 3,
    };
    saveGymState(s); close(); renderGym();
  };
  document.getElementById('poEditDeleteBtn').onclick = () => {
    if (!confirm(`Remove "${ex.name}"?`)) return;
    const s=loadGymState(); const i=s.exercises.findIndex(e=>e.id===exId);
    if (i!==-1) s.exercises.splice(i,1); delete s.logs[exId]; if (s.currentEx===exId) s.currentEx=null;
    saveGymState(s); close(); poDraftWeight=null; poDraftReps=null; poDraftRir=null; renderGym();
  };
}

function gymRenderHeader() {
  const state = loadGymState();
  const dateEl  = document.getElementById('gymDateStr');
  const badgeEl = document.getElementById('gymSplitBadge');
  if (!dateEl || !badgeEl) return;
  const t = gymToday(); const [y,m,d] = t.split('-').map(Number);
  const dt = new Date(y,m-1,d);
  const WD=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'], MO=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  dateEl.textContent = `${WD[dt.getDay()]}, ${MO[m-1]} ${d}`;
  const autoDay = gymAutoDay(state);
  const isRest  = !state.days.find(dd => dd.name === autoDay);
  badgeEl.textContent = autoDay ? `${autoDay} Day` : '—';
  badgeEl.className = 'gym-split-badge' + (isRest ? ' rest' : '');
}

function gymRenderFilters() {
  const state = loadGymState();
  const dayEl = document.getElementById('gymDayFilter');

  if (dayEl) {
    dayEl.innerHTML = '';
    state.days.forEach(d2 => {
      const btn = document.createElement('button');
      btn.className = 'gym-pill' + (state.filterDay === d2.id ? ' active' : '');
      btn.textContent = d2.name;
      btn.onclick = () => { const s = loadGymState(); s.filterDay = d2.id; s._userPickedDay = true; saveGymState(s); gymRenderFilters(); gymRenderExList(); };
      dayEl.appendChild(btn);
    });
    const restBtn = document.createElement('button');
    restBtn.className = 'gym-pill' + (state.filterDay === 'rest' ? ' active' : '');
    restBtn.textContent = 'Rest';
    restBtn.onclick = () => { const s = loadGymState(); s.filterDay = 'rest'; s._userPickedDay = true; saveGymState(s); gymRenderFilters(); gymRenderExList(); };
    dayEl.appendChild(restBtn);
  }
}

function gymRenderExList() {
  const state = loadGymState();
  const container = document.getElementById('gymExList');
  if (!container) return;
  container.innerHTML = '';
  const today = gymToday();

  if (state.filterDay === 'rest') {
    container.innerHTML = '<div class="gym-empty">Rest day — no exercises scheduled.</div>';
    return;
  }

  const filtered = state.exercises.filter(ex => gymExDays(ex).includes(state.filterDay));

  if (!filtered.length) {
    container.innerHTML = '<div class="gym-empty">No exercises for this day — add one in Exercises below.</div>';
    return;
  }

  filtered.forEach(ex => {
    const sugg = gymSuggestion(state, ex.id);
    const card = document.createElement('div');
    card.className = 'gym-ex-card' + (state.currentEx === ex.id ? ' selected' : '');
    card.onclick = () => {
      const s = loadGymState();
      const same = s.currentEx === ex.id;
      s.currentEx = same ? null : ex.id;
      saveGymState(s);
      gymRenderExList();
      gymRenderLogPanel(!same);
    };

    const top = document.createElement('div'); top.className = 'gym-ex-top';
    const nameEl = document.createElement('div'); nameEl.className = 'gym-ex-name'; nameEl.textContent = ex.name;
    top.appendChild(nameEl);
    if (sugg) {
      const suggEl = document.createElement('div'); suggEl.className = 'gym-ex-sugg';
      suggEl.textContent = ex.bw ? `BW × ${sugg.repRange}` : `${sugg.weight}${state.units} × ${sugg.repRange}`;
      top.appendChild(suggEl);
    }
    card.appendChild(top);

    const lastEl = document.createElement('div'); lastEl.className = 'gym-ex-last';
    if (sugg && sugg.lastDate) {
      const wStr = ex.bw ? 'BW' : `${sugg.lastWeight}${state.units}`;
      lastEl.textContent = `Last: ${sugg.lastReps} reps @ ${wStr} — ${gymFmtDate(sugg.lastDate)}`;
    } else {
      lastEl.textContent = 'No history yet';
    }
    card.appendChild(lastEl);

    if (sugg && sugg.isUpgrade && !ex.bw) {
      const upEl = document.createElement('div'); upEl.className = 'gym-ex-up';
      upEl.textContent = `↑ Hit repMax — ready to increase to ${sugg.weight}${state.units}`;
      card.appendChild(upEl);
    }

    const todaySets = (state.logs[ex.id] || []).filter(l => l.date === today);
    if (todaySets.length) {
      const todayEl = document.createElement('div'); todayEl.className = 'gym-ex-today';
      todayEl.textContent = `Today: ${todaySets.length} set${todaySets.length !== 1 ? 's' : ''} logged`;
      card.appendChild(todayEl);
    }

    container.appendChild(card);
  });
}

function gymRenderLogPanel(freshSelect) {
  const state = loadGymState();
  const panel = document.getElementById('gymLogPanel');
  if (!panel) return;

  if (!state.currentEx) { panel.classList.add('hidden'); return; }
  const ex = state.exercises.find(e => e.id === state.currentEx);
  if (!ex) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  const sugg      = gymSuggestion(state, ex.id);
  const titleEl   = document.getElementById('gymLogTitle');
  const weightIn  = document.getElementById('gymLogWeight');
  const repsIn    = document.getElementById('gymLogReps');
  const unitTogEl = document.getElementById('gymLogUnitTog');
  const sessSetsEl = document.getElementById('gymSessSets');

  if (titleEl) titleEl.textContent = ex.name;

  if (freshSelect || panel.dataset.ex !== state.currentEx) {
    panel.dataset.ex = state.currentEx;
    if (weightIn) weightIn.value = (!ex.bw && sugg) ? sugg.weight : '';
    if (repsIn)   repsIn.value   = '';
  }

  if (weightIn) { weightIn.style.display = ex.bw ? 'none' : ''; }
  const sepEl = panel.querySelector('.gym-log-sep');
  if (sepEl) sepEl.style.display = ex.bw ? 'none' : '';

  if (unitTogEl) {
    unitTogEl.innerHTML = '';
    if (!ex.bw) {
      ['kg','lb'].forEach(u => {
        const b = document.createElement('button');
        b.className = 'gym-unit-btn' + (state.units === u ? ' active' : '');
        b.textContent = u;
        b.onclick = () => { const s = loadGymState(); s.units = u; saveGymState(s); gymRenderLogPanel(); gymRenderExList(); gymRenderMgmt(); };
        unitTogEl.appendChild(b);
      });
    }
  }

  const today = gymToday();
  const todaySets = (state.logs[ex.id] || []).filter(l => l.date === today);
  if (sessSetsEl) {
    sessSetsEl.innerHTML = '';
    todaySets.forEach((set, idx) => {
      const chip = document.createElement('div'); chip.className = 'gym-sess-chip';
      const wStr = ex.bw ? 'BW' : `${set.weight}${set.unit || state.units}`;
      const span = document.createElement('span'); span.textContent = `${idx+1}: ${set.reps} × ${wStr}`;
      const del = document.createElement('button'); del.className = 'gym-sess-del'; del.textContent = '×';
      del.onclick = ev => {
        ev.stopPropagation();
        const s = loadGymState();
        const exLogs = s.logs[state.currentEx] || [];
        let count = 0;
        for (let i = 0; i < exLogs.length; i++) {
          if (exLogs[i].date === today) {
            if (count === idx) { exLogs.splice(i, 1); break; }
            count++;
          }
        }
        s.logs[state.currentEx] = exLogs;
        saveGymState(s);
        gymRenderExList(); gymRenderLogPanel(); gymRenderHistory();
      };
      chip.append(span, del); sessSetsEl.appendChild(chip);
    });
  }

  const submitBtn = document.getElementById('gymLogSubmit');
  const cancelBtn = document.getElementById('gymLogCancel');
  if (submitBtn) submitBtn.onclick = gymLogSet;
  if (cancelBtn) cancelBtn.onclick = () => {
    const s = loadGymState(); s.currentEx = null; saveGymState(s);
    gymRenderExList(); gymRenderLogPanel();
  };
  if (weightIn) weightIn.onkeydown = e => { if (e.key === 'Enter') gymLogSet(); };
  if (repsIn)   repsIn.onkeydown   = e => { if (e.key === 'Enter') gymLogSet(); };
}

function gymLogSet() {
  const s = loadGymState();
  if (!s.currentEx) return;
  const ex = s.exercises.find(e => e.id === s.currentEx);
  if (!ex) return;
  const repsVal   = parseInt(document.getElementById('gymLogReps')?.value);
  const weightVal = ex.bw ? 0 : parseFloat(document.getElementById('gymLogWeight')?.value);
  if (!repsVal || repsVal < 1) return;
  if (!ex.bw && (isNaN(weightVal) || weightVal < 0)) return;
  const unit = document.querySelector('#gymLogUnitTog .gym-unit-btn.active')?.textContent || s.units;
  if (!s.logs[s.currentEx]) s.logs[s.currentEx] = [];
  s.logs[s.currentEx].push({ weight: weightVal, reps: repsVal, date: gymToday(), unit });
  const repsIn = document.getElementById('gymLogReps'); if (repsIn) repsIn.value = '';
  saveGymState(s);
  gymRenderExList(); gymRenderLogPanel(); gymRenderHistory();
}

function poRenderHistory() {
  const state    = loadGymState();
  const toggle   = document.getElementById('poHistToggle');
  const histBody = document.getElementById('poHistBody');
  if (!toggle || !histBody) return;

  const today   = gymToday();
  const cutoff  = new Date(today + 'T00:00:00'); cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const byDate  = {};
  Object.entries(state.logs).forEach(([exId, logs]) => {
    const ex = state.exercises.find(e => e.id === exId); if (!ex) return;
    (logs||[]).forEach(log => {
      if (log.date === today || log.date < cutoffStr) return;
      if (!byDate[log.date]) byDate[log.date] = {};
      if (!byDate[log.date][exId]) byDate[log.date][exId] = { name:ex.name, sets:[], bw:!!ex.bw };
      byDate[log.date][exId].sets.push(log);
    });
  });
  const pastDates = Object.keys(byDate).sort((a,b) => b.localeCompare(a));

  toggle.textContent = `Past Workouts (${pastDates.length})`;
  const isOpen = histBody.style.display !== 'none';
  toggle.className = 'po-hist-toggle' + (isOpen ? ' open' : '');
  if (!toggle._wired) {
    toggle._wired = true;
    toggle.onclick = () => {
      const open = histBody.style.display !== 'none';
      histBody.style.display = open ? 'none' : '';
      toggle.className = 'po-hist-toggle' + (open ? '' : ' open');
    };
  }

  histBody.innerHTML = '';
  if (!pastDates.length) {
    histBody.innerHTML = '<div class="gym-empty" style="padding:8px 0 4px">No past workouts in the last 30 days.</div>';
    return;
  }

  pastDates.forEach(date => {
    const dayData  = byDate[date];
    const exCount  = Object.keys(dayData).length;
    const setCount = Object.values(dayData).reduce((s,v) => s + v.sets.length, 0);
    const card = document.createElement('div'); card.className = 'po-hist-day-card';
    const hdr  = document.createElement('div'); hdr.className  = 'po-hist-day-hdr';
    const dateEl = document.createElement('span'); dateEl.className = 'po-hist-day-date'; dateEl.textContent = gymFmtDate(date);
    const sumEl  = document.createElement('span'); sumEl.className  = 'po-hist-day-sum';
    sumEl.textContent = `${exCount} exercise${exCount!==1?'s':''} · ${setCount} set${setCount!==1?'s':''}`;
    const loadBtn = document.createElement('button'); loadBtn.className = 'po-hist-day-load'; loadBtn.textContent = 'Load'; loadBtn.title = 'Load these exercises into queue';
    loadBtn.onclick = () => {
      const s = loadGymState();
      const exIds = Object.keys(dayData);
      let added = 0;
      exIds.forEach(exId => {
        if (s.exercises.find(e => e.id === exId) && !(s.queue||[]).includes(exId)) {
          s.queue = [...(s.queue||[]), exId];
          added++;
        }
      });
      s.queueDate = gymToday();
      saveGymState(s);
      gymShowToast(added ? `Added ${added} exercise${added !== 1 ? 's' : ''} to queue` : 'All exercises already in queue');
      gymRenderQueue(); gymRenderLibrary();
    };
    const del = document.createElement('button'); del.className = 'po-hist-day-del'; del.textContent = '×'; del.title = 'Delete this day';
    del.onclick = () => {
      if (!confirm(`Delete all logs for ${gymFmtDate(date)}?`)) return;
      const s = loadGymState();
      Object.keys(s.logs).forEach(id => { s.logs[id] = (s.logs[id]||[]).filter(l => l.date !== date); });
      saveGymState(s); renderGym();
    };
    hdr.append(dateEl, sumEl, loadBtn, del);
    const body = document.createElement('div');
    Object.values(dayData).forEach(exData => {
      const exEl = document.createElement('div'); exEl.style.cssText = 'margin-top:8px;';
      const nEl  = document.createElement('div'); nEl.style.cssText  = 'font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;'; nEl.textContent = exData.name;
      const sEl  = document.createElement('div'); sEl.className = 'po-summary-sets';
      exData.sets.forEach(set => {
        const chip = document.createElement('span'); chip.className = 'po-summary-chip';
        chip.textContent = exData.bw ? `${set.reps}×BW` : `${set.reps}×${set.weight}${set.unit||state.units}`;
        sEl.appendChild(chip);
      });
      exEl.append(nEl, sEl); body.appendChild(exEl);
    });
    card.append(hdr, body); histBody.appendChild(card);
  });
}

function gymRenderHistory() { poRenderHistory(); }

function poRenderExHistory() {
  const state  = loadGymState();
  const exId   = document.getElementById('poExSel')?.value;
  const listEl = document.getElementById('poExLogHistory');
  if (!listEl) return;
  listEl.innerHTML = '';
  if (!exId) return;
  const ex = state.exercises.find(e => e.id === exId); if (!ex) return;
  const withIdx = (state.logs[exId]||[]).map((log, origIdx) => ({ ...log, origIdx }));
  const show    = withIdx.slice().sort((a,b) => a.date < b.date ? 1 : -1).slice(0, 12);
  if (!show.length) return;
  show.forEach(log => {
    const row    = document.createElement('div'); row.className = 'po-ex-log-row';
    const dateEl = document.createElement('span'); dateEl.className = 'po-ex-log-date'; dateEl.textContent = poTimeAgo(log.date);
    const valEl  = document.createElement('span'); valEl.className  = 'po-ex-log-val';
    valEl.textContent = (ex.bw ? 'BW' : `${log.weight}${log.unit||state.units}`) + ` × ${log.reps} reps`;
    const del = document.createElement('button'); del.className = 'po-ex-log-del'; del.textContent = '×';
    del.onclick = () => {
      const s = loadGymState();
      s.logs[exId] = (s.logs[exId]||[]).filter((_,i) => i !== log.origIdx);
      saveGymState(s); renderGym();
    };
    row.append(dateEl, valEl, del); listEl.appendChild(row);
  });
}

function gymRenderMgmt() {
  const state = loadGymState();

  const unitTog = document.getElementById('gymUnitTog');
  if (unitTog) {
    unitTog.querySelectorAll('.gym-unit-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.u === state.units);
      btn.onclick = () => { const s = loadGymState(); s.units = btn.dataset.u; saveGymState(s); gymRenderMgmt(); gymRenderExList(); gymRenderLogPanel(); };
    });
  }

  const mgmtEl = document.getElementById('gymExMgmt');
  if (mgmtEl) {
    mgmtEl.innerHTML = '';
    if (state.exercises.length) {
      const list = document.createElement('div'); list.className = 'gym-mgmt-list';
      state.exercises.forEach(ex => {
        const row  = document.createElement('div'); row.className = 'gym-mgmt-row';
        const name = document.createElement('span'); name.className = 'gym-mgmt-name'; name.textContent = ex.name;
        const meta = document.createElement('span'); meta.className = 'gym-mgmt-meta';
        const dName = gymExDays(ex).map(id => state.days.find(d => d.id === id)?.name || id).join(', ');
        meta.textContent = `${dName} · ${ex.bw ? 'BW' : ex.startWeight + state.units}`;
        const del = document.createElement('button'); del.className = 'gym-mgmt-del'; del.textContent = '×';
        del.onclick = e => {
          e.stopPropagation();
          if (!confirm(`Remove "${ex.name}"?`)) return;
          const s = loadGymState();
          const i = s.exercises.findIndex(e2 => e2.id === ex.id);
          if (i !== -1) s.exercises.splice(i, 1);
          delete s.logs[ex.id];
          if (s.currentEx === ex.id) s.currentEx = null;
          saveGymState(s); renderGym();
        };
        row.onclick = () => poOpenExEditModal(ex.id);
        row.append(name, meta, del); list.appendChild(row);
      });
      mgmtEl.appendChild(list);
    }
  }

  const splitInfoEl = document.getElementById('gymSplitInfo');
  if (splitInfoEl) {
    const auto = gymAutoDay(state);
    const rot  = state.splitRotation || [];
    const anch = state.splitAnchor;
    const anchorMs = anch ? new Date(anch.date + 'T00:00:00').getTime() : 0;
    const todayMs  = new Date(gymToday() + 'T00:00:00').getTime();
    const diff = anch ? Math.round((todayMs - anchorMs) / 86400000) : 0;
    const dayNum = rot.length ? ((((anch ? anch.index : 0) + diff) % rot.length) + rot.length) % rot.length + 1 : 1;
    splitInfoEl.textContent = rot.length
      ? `Today is day ${dayNum} of ${rot.length} — ${auto || '?'}`
      : '';
  }

  // Update settings exercise count badge
  const cntEl = document.getElementById('gymSettingsExCount');
  if (cntEl) cntEl.textContent = `· ${state.exercises.length}`;
}

function initGym() {
  // Auto-select today's split day
  let s = loadGymState();
  if (!s._userPickedDay) {
    const auto   = gymAutoDay(s);
    const autoId = s.days.find(d => d.name === auto)?.id;
    const newDay = autoId || (auto && auto.toLowerCase() === 'rest' ? 'rest' : s.filterDay);
    if (newDay !== s.filterDay) { s.filterDay = newDay; saveGymState(s); }
  }

  // Exercise selector (legacy hidden element — keep wired for poRenderLogger/history compat)
  const exSel = document.getElementById('poExSel');
  if (exSel) exSel.onchange = () => {
    const st = loadGymState(); st.currentEx = exSel.value; saveGymState(st);
  };

  // Weight +/−
  const wMinus = document.getElementById('poWtMinus');
  const wPlus  = document.getElementById('poWtPlus');
  if (wMinus) wMinus.onclick = () => {
    const ex = gymQueueTopEx(loadGymState());
    if (!ex) return; if (poDraftWeight===null) poDraftWeight = ex.startWeight;
    if (ex.useLadder) {
      const perHand = ex.ladderDouble ? poDraftWeight / 2 : poDraftWeight;
      poDraftWeight = dbLadderPrev(DUMBBELL_LADDER, perHand) * (ex.ladderDouble ? 2 : 1);
    } else {
      poDraftWeight = Math.max(0, poDraftWeight - ex.step);
    }
    poUpdateLoggerForEx();
  };
  if (wPlus) wPlus.onclick = () => {
    const ex = gymQueueTopEx(loadGymState());
    if (!ex) return; if (poDraftWeight===null) poDraftWeight = ex.startWeight;
    if (ex.useLadder) {
      const perHand = ex.ladderDouble ? poDraftWeight / 2 : poDraftWeight;
      poDraftWeight = dbLadderNext(DUMBBELL_LADDER, perHand) * (ex.ladderDouble ? 2 : 1);
    } else {
      poDraftWeight = poDraftWeight + ex.step;
    }
    poUpdateLoggerForEx();
  };

  // Log button
  const logBtn = document.getElementById('poLogBtn');
  if (logBtn) logBtn.onclick = poLogSet;

  // Day pill → rotation editor
  const dayPill = document.getElementById('poDayPill');
  if (dayPill) dayPill.onclick = poOpenRotModal;

  // Exercise edit/add buttons
  const editBtn = document.getElementById('poExEditBtn');
  if (editBtn) editBtn.onclick = () => { const ex = gymQueueTopEx(loadGymState()); if (ex) poOpenExEditModal(ex.id); };
  const addExBtn = document.getElementById('poExAddBtn');
  if (addExBtn) addExBtn.onclick = () => {
    const det = document.querySelector('.po-settings-details'); if (det) det.open = true;
    document.getElementById('gymNewName')?.focus();
  };



  // Settings: new exercise submit
  const gymNewSubmit = document.getElementById('gymNewSubmit');
  if (gymNewSubmit) gymNewSubmit.onclick = () => {
    const name = document.getElementById('gymNewName')?.value.trim(); if (!name) return;
    const toggled = [...document.querySelectorAll('#gymDayToggle .gym-day-btn[data-selected="true"]')].map(b => b.dataset.dayId);
    const days      = toggled.length ? toggled : ['rest'];
    const repMin    = parseInt(  document.getElementById('gymNewRepMin')?.value) || 5;
    const repMax    = parseInt(  document.getElementById('gymNewRepMax')?.value) || 8;
    const step      = parseFloat(document.getElementById('gymNewStep')?.value  ) || 2.5;
    const startW    = parseFloat(document.getElementById('gymNewStart')?.value ) || 0;
    const bw           = document.getElementById('gymNewBw')?.checked || false;
    const useLadder    = document.getElementById('gymNewUseLadder')?.checked || false;
    const ladderDouble = document.getElementById('gymNewLadderDouble')?.checked || false;
    const muscles      = gymReadMuscleToggle(document.getElementById('gymNewMuscleToggle'));
    const sets         = parseInt(document.getElementById('gymNewSets')?.value) || 3;
    const st = loadGymState();
    st.exercises.push({ id:gymUID(), name, days, repMin, repMax, step, startWeight:startW, bw:bw||undefined, useLadder:useLadder||undefined, ladderDouble:ladderDouble||undefined, muscles, targetSets:sets });
    saveGymState(st); document.getElementById('gymNewName').value = '';
    gymRenderMuscleToggle(document.getElementById('gymNewMuscleToggle'), []);
    renderGym();
  };

  // New exercise: wire ladder checkbox to disable step input
  const gymNewUseLadderCb = document.getElementById('gymNewUseLadder');
  const gymNewStepIn      = document.getElementById('gymNewStep');
  if (gymNewUseLadderCb && gymNewStepIn) {
    gymNewUseLadderCb.onchange = () => {
      gymNewStepIn.disabled = gymNewUseLadderCb.checked;
      const doubleRow = document.getElementById('gymNewLadderDoubleRow');
      if (doubleRow) doubleRow.style.display = gymNewUseLadderCb.checked ? '' : 'none';
    };
  }

  // Settings: split reset
  const gymSplitReset = document.getElementById('gymSplitReset');
  if (gymSplitReset) gymSplitReset.onclick = () => {
    const st = loadGymState(); st.splitAnchor = { date:gymToday(), index:0 }; st._userPickedDay = false; saveGymState(st); renderGym();
  };

  // Settings: populate day toggle
  gymRenderDayToggle();

  // Settings: unit toggle
  const unitTog = document.getElementById('gymUnitTog');
  if (unitTog) unitTog.querySelectorAll('.gym-unit-btn').forEach(btn => {
    btn.onclick = () => { const st=loadGymState(); st.units=btn.dataset.u; saveGymState(st); renderGym(); };
  });

  // Past workouts footer link
  const pastLink = document.getElementById('gymPastLink');
  if (pastLink && !pastLink._wired) {
    pastLink._wired = true;
    pastLink.onclick = () => {
      const histBody = document.getElementById('poHistBody');
      if (!histBody) return;
      const open = histBody.style.display !== 'none';
      histBody.style.display = open ? 'none' : '';
    };
  }

  // Realtime sync safety
  const gymPage = document.getElementById('page-gym');
  if (gymPage) {
    gymPage.addEventListener('focusin',  e => { const tg=e.target.tagName; if(tg==='INPUT'||tg==='TEXTAREA'||tg==='SELECT') gymIsTyping=true; });
    gymPage.addEventListener('focusout', () => { gymIsTyping=false; if(gymPendingRmt){ const r=gymPendingRmt; gymPendingRmt=null; applyGymRemote(r); } });
  }

  renderGym();
}

// ── Supplement Checklist ────────────────────────────────────
(function() {
  if (!storeGet('supp_config')) {
    storeSet('supp_config', {
      supplements: [
        { id: crypto.randomUUID(), name: 'Magnesium',  dose: '1 tablet',  sessions: ['morning'],         lowStock: false },
        { id: crypto.randomUUID(), name: 'Vitamin C',  dose: '1 tablet',  sessions: ['morning'],         lowStock: false },
        { id: crypto.randomUUID(), name: 'Creatine',   dose: '6g',        sessions: ['morning'],         lowStock: false },
        { id: crypto.randomUUID(), name: 'Magnesium',  dose: '2 tablets', sessions: ['night'],           lowStock: false }
      ],
      times: { morning: '08:00', lunch: '13:00', night: '22:00' },
      overdueGraceMins: 30
    });
  }

  function loadSuppConfig() {
    return storeGet('supp_config') || { supplements: [], times: { morning: '08:00', lunch: '13:00', night: '22:00' }, overdueGraceMins: 30 };
  }
  function saveSuppConfig(cfg) { storeSet('supp_config', cfg); }
  function getTodaySuppKey() { return `supp_taken:${getActiveDateString()}`; }
  function loadSuppTaken() { return storeGet(getTodaySuppKey()) || {}; }
  function saveSuppTaken(t) { storeSet(getTodaySuppKey(), t); }

  function isSessionOverdue(sessionTime, graceMins) {
    const now = new Date();
    const [h, m] = sessionTime.split(':').map(Number);
    const cutoffMins = h * 60 + m + graceMins;
    const nowMins = now.getHours() * 60 + now.getMinutes();
    return nowMins > cutoffMins;
  }

  function renderSupplements() {
    const cfg = loadSuppConfig();
    const taken = loadSuppTaken();
    const sessions = ['morning', 'lunch', 'night'];
    let totalCount = 0, takenCount = 0;
    const segments = [];

    sessions.forEach(session => {
      const list = document.getElementById(`suppList-${session}`);
      const timeEl = document.getElementById(`suppTime-${session}`);
      if (!list) return;
      if (timeEl && !timeEl._editing) timeEl.textContent = cfg.times[session];

      const sessionSupps = cfg.supplements.filter(s => s.sessions.includes(session));
      list.innerHTML = '';

      if (sessionSupps.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'supp-empty-state';
        empty.textContent = 'No supplements scheduled for this session.';
        list.appendChild(empty);
        return;
      }

      const overdue = isSessionOverdue(cfg.times[session], cfg.overdueGraceMins);

      sessionSupps.forEach(supp => {
        const key = `${supp.id}:${session}`;
        const isTaken = !!taken[key];
        totalCount++;
        if (isTaken) takenCount++;
        segments.push(isTaken);

        const row = document.createElement('div');
        row.className = 'supp-row' + (!isTaken && overdue ? ' overdue' : '');

        const cbWrap = document.createElement('label');
        cbWrap.className = 'goal-checkbox-wrap';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = isTaken;
        const cbc = document.createElement('span');
        cbc.className = 'goal-checkbox-custom';
        cbWrap.appendChild(cb);
        cbWrap.appendChild(cbc);
        cb.addEventListener('change', () => {
          const t = loadSuppTaken();
          if (cb.checked) t[key] = true; else delete t[key];
          saveSuppTaken(t);
          renderSupplements();
        });

        const info = document.createElement('div');
        info.className = 'supp-info';
        const nameEl = document.createElement('div');
        nameEl.className = 'supp-name';
        nameEl.textContent = supp.name;
        const doseEl = document.createElement('div');
        doseEl.className = 'supp-dose';
        doseEl.textContent = supp.dose;
        info.appendChild(nameEl);
        info.appendChild(doseEl);
        if (supp.lowStock) {
          const badge = document.createElement('div');
          badge.className = 'supp-low-badge';
          badge.textContent = 'Low Stock';
          info.appendChild(badge);
        }

        const lsBtn = document.createElement('button');
        lsBtn.className = 'supp-low-stock-btn' + (supp.lowStock ? ' active' : '');
        lsBtn.title = supp.lowStock ? 'Mark as stocked' : 'Flag low stock';
        lsBtn.textContent = '⚠';
        lsBtn.addEventListener('click', () => {
          const c = loadSuppConfig();
          const s = c.supplements.find(x => x.id === supp.id);
          if (s) { s.lowStock = !s.lowStock; saveSuppConfig(c); renderSupplements(); }
        });

        row.appendChild(cbWrap);
        row.appendChild(info);
        row.appendChild(lsBtn);
        list.appendChild(row);
      });
    });

    const takenEl = document.getElementById('suppTakenCount');
    const totalEl = document.getElementById('suppTotalCount');
    const segBar  = document.getElementById('suppSegBar');
    if (takenEl) takenEl.textContent = takenCount;
    if (totalEl) totalEl.textContent = totalCount;
    if (segBar) {
      segBar.innerHTML = '';
      segments.forEach(done => {
        const seg = document.createElement('div');
        seg.className = 'supp-seg' + (done ? ' done' : '');
        segBar.appendChild(seg);
      });
    }
  }

  function renderSuppSettings() {
    const cfg = loadSuppConfig();
    const list = document.getElementById('suppSettingsList');
    if (!list) return;
    list.innerHTML = '';
    if (cfg.supplements.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'supp-empty-state';
      empty.textContent = 'No supplements added yet.';
      list.appendChild(empty);
      return;
    }
    cfg.supplements.forEach(supp => {
      const row = document.createElement('div');
      row.className = 'supp-settings-row';
      const info = document.createElement('div');
      info.className = 'supp-settings-info';
      const nameEl = document.createElement('div');
      nameEl.className = 'supp-settings-name';
      nameEl.textContent = supp.name;
      const meta = document.createElement('div');
      meta.className = 'supp-settings-meta';
      meta.textContent = supp.dose;
      const pills = document.createElement('div');
      pills.className = 'supp-settings-sessions';
      supp.sessions.forEach(s => {
        const pill = document.createElement('span');
        pill.className = 'supp-settings-pill';
        pill.textContent = s.charAt(0).toUpperCase() + s.slice(1);
        pills.appendChild(pill);
      });
      info.appendChild(nameEl);
      info.appendChild(meta);
      info.appendChild(pills);
      const del = document.createElement('button');
      del.className = 'supp-settings-del';
      del.textContent = '×';
      del.title = 'Delete';
      del.addEventListener('click', () => {
        if (!confirm(`Delete ${supp.name}?`)) return;
        const c = loadSuppConfig();
        c.supplements = c.supplements.filter(x => x.id !== supp.id);
        saveSuppConfig(c);
        renderSuppSettings();
        renderSupplements();
      });
      row.appendChild(info);
      row.appendChild(del);
      list.appendChild(row);
    });
  }

  function openSuppSettings() {
    document.getElementById('suppSettingsOverlay').classList.add('open');
    document.getElementById('page-health').classList.add('has-overlay');
    renderSuppSettings();
  }
  function closeSuppSettings() {
    document.getElementById('suppSettingsOverlay').classList.remove('open');
    document.getElementById('page-health').classList.remove('has-overlay');
  }

  document.getElementById('suppGearBtn')?.addEventListener('click', openSuppSettings);
  document.getElementById('suppSettingsBack')?.addEventListener('click', closeSuppSettings);

  document.getElementById('suppAddBtn')?.addEventListener('click', () => {
    const name = document.getElementById('suppAddName').value.trim();
    const dose = document.getElementById('suppAddDose').value.trim();
    const sessions = [
      document.getElementById('suppChkMorning').checked ? 'morning' : null,
      document.getElementById('suppChkLunch').checked   ? 'lunch'   : null,
      document.getElementById('suppChkNight').checked   ? 'night'   : null
    ].filter(Boolean);
    if (!name || sessions.length === 0) return;
    const cfg = loadSuppConfig();
    cfg.supplements.push({ id: crypto.randomUUID(), name, dose: dose || '–', sessions, lowStock: false });
    saveSuppConfig(cfg);
    document.getElementById('suppAddName').value = '';
    document.getElementById('suppAddDose').value = '';
    document.getElementById('suppChkMorning').checked = false;
    document.getElementById('suppChkLunch').checked   = false;
    document.getElementById('suppChkNight').checked   = false;
    renderSuppSettings();
    renderSupplements();
  });

  ['morning', 'lunch', 'night'].forEach(session => {
    const btn    = document.querySelector(`.supp-time-edit-btn[data-session="${session}"]`);
    const timeEl = document.getElementById(`suppTime-${session}`);
    if (!btn || !timeEl) return;
    btn.addEventListener('click', () => {
      if (timeEl._editing) return;
      timeEl._editing = true;
      const cfg = loadSuppConfig();
      const inp = document.createElement('input');
      inp.type = 'time';
      inp.className = 'supp-time-input';
      inp.value = cfg.times[session];
      timeEl.replaceWith(inp);
      inp.focus();
      function commit() {
        if (!timeEl._editing) return;
        timeEl._editing = false;
        const val = inp.value;
        if (val) { const c = loadSuppConfig(); c.times[session] = val; saveSuppConfig(c); }
        timeEl.textContent = loadSuppConfig().times[session];
        inp.replaceWith(timeEl);
        renderSupplements();
      }
      inp.addEventListener('blur', commit, { once: true });
    });
  });

  setInterval(renderSupplements, 60000);
  window._renderSupplements = renderSupplements;
  renderSupplements();
})();

// ── Nutrition / Macro Tracker ─────────────────────────────────
const NUTRITION_APP_KEY  = 'nutrition-macros';
const NUT_GOALS_KEY      = 'nutrition:goals';
const NUT_GOALS_DEFAULTS = { calories: 2500, protein: 180, carbs: 250, fat: 80 };

let nutSyncTimer      = null;
let nutLastPushedJson = null;

function nutTodayKey()         { return `macros:${getActiveDateString()}`; }
function nutLoadEntries()      { return storeGet(nutTodayKey()) || []; }
function nutSaveEntries(e)     { storeSet(nutTodayKey(), e); nutPushToSupabase(); }
function nutLoadGoals()        { return storeGet(NUT_GOALS_KEY) || { ...NUT_GOALS_DEFAULTS }; }
function nutSaveGoals(g)       { storeSet(NUT_GOALS_KEY, g); nutPushToSupabase(); }

function nutPushToSupabase() {
  if (!useSupabase) return;
  clearTimeout(nutSyncTimer);
  nutSyncTimer = setTimeout(async () => {
    if (!db || !currentUser) return;
    const payload = { goals: nutLoadGoals() };
    storeListKeys('macros:').forEach(k => { payload[k] = storeGet(k); });
    nutLastPushedJson = JSON.stringify(payload);
    setSyncing(true);
    try {
      await db.from('app_state').upsert(
        { user_id: currentUser.id, app_key: NUTRITION_APP_KEY, payload, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,app_key' }
      );
    } catch { setSyncError(); nutLastPushedJson = null; } finally { setSyncing(false); }
  }, 250);
}

async function loadNutFromSupabase() {
  if (!db || !currentUser) return;
  const { data, error } = await db.from('app_state').select('payload')
    .eq('user_id', currentUser.id).eq('app_key', NUTRITION_APP_KEY).maybeSingle();
  if (error || !data?.payload) return;
  applyNutritionRemote(data.payload);
}

function applyNutritionRemote(payload) {
  if (!payload) return;
  if (payload.goals) storeSet(NUT_GOALS_KEY, payload.goals);
  Object.keys(payload).filter(k => k.startsWith('macros:')).forEach(k => storeSet(k, payload[k]));
  window._renderNutrition && window._renderNutrition();
}

function initNutrition() {
  if (!storeGet(NUT_GOALS_KEY)) storeSet(NUT_GOALS_KEY, { ...NUT_GOALS_DEFAULTS });

  function render() {
    const goals   = nutLoadGoals();
    const entries = nutLoadEntries();
    const totals  = entries.reduce((a, e) => ({
      calories: a.calories + (e.calories || 0),
      protein:  a.protein  + (e.protein  || 0),
      carbs:    a.carbs    + (e.carbs    || 0),
      fat:      a.fat      + (e.fat      || 0),
    }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

    // Calories remaining
    const remain      = goals.calories - totals.calories;
    const calRemainEl = document.getElementById('nutCalRemain');
    const calSubEl    = document.getElementById('nutCalSub');
    if (calRemainEl) {
      calRemainEl.textContent = Math.abs(remain);
      calRemainEl.className   = 'nut-cal-big' + (remain < 0 ? ' over' : '');
    }
    if (calSubEl) {
      calSubEl.textContent = remain < 0
        ? `${totals.calories} / ${goals.calories} kcal — ${Math.abs(remain)} over goal`
        : `${totals.calories} / ${goals.calories} kcal consumed`;
    }

    // Segment bar (proportional calorie contribution vs goal)
    const segBar = document.getElementById('nutSegBar');
    if (segBar) {
      const base  = goals.calories || 1;
      const pPct  = Math.min(totals.protein * 4 / base * 100, 100);
      const cPct  = Math.min(totals.carbs   * 4 / base * 100, 100);
      const fPct  = Math.min(totals.fat     * 9 / base * 100, 100);
      const ePct  = Math.max(0, 100 - pPct - cPct - fPct);
      segBar.innerHTML = '';
      if (pPct > 0) { const s = document.createElement('div'); s.className = 'nut-seg-protein'; s.style.flex = pPct; segBar.appendChild(s); }
      if (cPct > 0) { const s = document.createElement('div'); s.className = 'nut-seg-carbs';   s.style.flex = cPct; segBar.appendChild(s); }
      if (fPct > 0) { const s = document.createElement('div'); s.className = 'nut-seg-fat';     s.style.flex = fPct; segBar.appendChild(s); }
      if (ePct > 0) { const s = document.createElement('div'); s.className = 'nut-seg-empty';   s.style.flex = ePct; segBar.appendChild(s); }
    }

    // Macro mini bars + stats
    const pct = (v, g) => `${Math.min(100, g > 0 ? (v / g) * 100 : 0).toFixed(1)}%`;
    const elPBar = document.getElementById('nutBarProtein'); if (elPBar) elPBar.style.width = pct(totals.protein, goals.protein);
    const elCBar = document.getElementById('nutBarCarbs');   if (elCBar) elCBar.style.width = pct(totals.carbs,   goals.carbs);
    const elFBar = document.getElementById('nutBarFat');     if (elFBar) elFBar.style.width = pct(totals.fat,     goals.fat);
    const elPSt = document.getElementById('nutStatProtein'); if (elPSt) elPSt.textContent = `${totals.protein}g / ${goals.protein}g`;
    const elCSt = document.getElementById('nutStatCarbs');   if (elCSt) elCSt.textContent = `${totals.carbs}g / ${goals.carbs}g`;
    const elFSt = document.getElementById('nutStatFat');     if (elFSt) elFSt.textContent = `${totals.fat}g / ${goals.fat}g`;

    // Log list (newest first)
    const logEl = document.getElementById('nutLog');
    if (logEl) {
      logEl.innerHTML = '';
      if (!entries.length) {
        logEl.innerHTML = '<div class="nut-empty">No entries yet — add your first meal above.</div>';
      } else {
        [...entries].reverse().forEach((entry, ri) => {
          const idx = entries.length - 1 - ri;
          const row = document.createElement('div');
          row.className = 'nut-entry';
          row.innerHTML = `
            <div class="nut-entry-info">
              <div class="nut-entry-name"></div>
              <div class="nut-entry-chips">
                <span class="nut-chip cal">${entry.calories} kcal</span>
                <span class="nut-chip pro">${entry.protein}g P</span>
                <span class="nut-chip crb">${entry.carbs}g C</span>
                <span class="nut-chip fat">${entry.fat}g F</span>
              </div>
            </div>
            <span class="nut-entry-time">${entry.time}</span>
            <button class="nut-entry-del" aria-label="Delete" data-idx="${idx}">&#215;</button>`;
          row.querySelector('.nut-entry-name').textContent = entry.name || 'Unnamed';
          row.querySelector('.nut-entry-del').addEventListener('click', () => {
            const es = nutLoadEntries(); es.splice(idx, 1); nutSaveEntries(es); render();
          });
          logEl.appendChild(row);
        });
      }
    }
  }

  window._renderNutrition = render;

  // Quick-add
  const addBtn = document.getElementById('nutAddBtn');
  if (addBtn) {
    function doAdd() {
      const name     = document.getElementById('nutAddName').value.trim();
      const calories = parseFloat(document.getElementById('nutAddCal').value) || 0;
      const protein  = parseFloat(document.getElementById('nutAddPro').value) || 0;
      const carbs    = parseFloat(document.getElementById('nutAddCrb').value) || 0;
      const fat      = parseFloat(document.getElementById('nutAddFat').value) || 0;
      if (!name) { document.getElementById('nutAddName').focus(); return; }
      const now  = new Date();
      const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const es   = nutLoadEntries();
      es.push({ id: crypto.randomUUID(), name, calories, protein, carbs, fat, time });
      nutSaveEntries(es);
      ['nutAddName','nutAddCal','nutAddPro','nutAddCrb','nutAddFat'].forEach(id => {
        document.getElementById(id).value = '';
      });
      render();
    }
    addBtn.addEventListener('click', doAdd);
    document.getElementById('nutAddName').addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });
  }

  // Settings overlay
  const overlay = document.getElementById('nutSettingsOverlay');
  const nutPage = document.getElementById('page-nutrition');
  function openNutSettings() {
    const g = nutLoadGoals();
    document.getElementById('nutSetCal').value = g.calories;
    document.getElementById('nutSetPro').value = g.protein;
    document.getElementById('nutSetCrb').value = g.carbs;
    document.getElementById('nutSetFat').value = g.fat;
    nutPage?.classList.add('has-overlay');
    overlay?.classList.add('open');
  }
  function closeNutSettings() {
    nutPage?.classList.remove('has-overlay');
    overlay?.classList.remove('open');
  }
  document.getElementById('nutGearBtn')?.addEventListener('click', openNutSettings);
  document.getElementById('nutSettingsBack')?.addEventListener('click', closeNutSettings);
  document.getElementById('nutSetSaveBtn')?.addEventListener('click', () => {
    nutSaveGoals({
      calories: parseFloat(document.getElementById('nutSetCal').value) || NUT_GOALS_DEFAULTS.calories,
      protein:  parseFloat(document.getElementById('nutSetPro').value) || NUT_GOALS_DEFAULTS.protein,
      carbs:    parseFloat(document.getElementById('nutSetCrb').value) || NUT_GOALS_DEFAULTS.carbs,
      fat:      parseFloat(document.getElementById('nutSetFat').value) || NUT_GOALS_DEFAULTS.fat,
    });
    closeNutSettings();
    render();
  });

  render();
}

// ── Health – Body Metrics & Water ──────────────────────────
const HEALTH_METRICS_KEY     = 'health-metrics';
const HEALTH_METRICS_APP_KEY = 'health-metrics';
const HEALTH_WATER_KEY       = 'health-water';
const HEALTH_WATER_APP_KEY   = 'health-water';

let healthMetricsSyncTimer = null;
let healthMetricsLastJson  = null;
let healthWaterSyncTimer   = null;
let healthWaterLastJson    = null;

// ── Health Metrics (height) load/save ──────────────────────
function healthMetricsLoad() {
  try { return JSON.parse(localStorage.getItem(HEALTH_METRICS_KEY)) || {}; } catch { return {}; }
}
function healthMetricsSave(data) {
  localStorage.setItem(HEALTH_METRICS_KEY, JSON.stringify(data));
  _healthMetricsPush(data);
}
function _healthMetricsPush(data) {
  if (!useSupabase) return;
  clearTimeout(healthMetricsSyncTimer);
  healthMetricsSyncTimer = setTimeout(async () => {
    if (!db || !currentUser) return;
    healthMetricsLastJson = JSON.stringify(data);
    setSyncing(true);
    try {
      await db.from('app_state').upsert(
        { user_id: currentUser.id, app_key: HEALTH_METRICS_APP_KEY, payload: data, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,app_key' }
      );
    } catch { setSyncError(); healthMetricsLastJson = null; } finally { setSyncing(false); }
  }, 250);
}
async function loadHealthMetricsFromSupabase() {
  if (!db || !currentUser) return;
  const { data, error } = await db.from('app_state').select('payload')
    .eq('user_id', currentUser.id).eq('app_key', HEALTH_METRICS_APP_KEY).maybeSingle();
  if (error || !data?.payload) return;
  applyHealthMetricsRemote(data.payload);
}
function applyHealthMetricsRemote(payload) {
  if (!payload) return;
  localStorage.setItem(HEALTH_METRICS_KEY, JSON.stringify(payload));
  healthMetricsRender();
  waterGoalRender();
  waterWidgetRender();
}

// ── Water Goal Calculation ─────────────────────────────────
function calcWaterGoal(factors) {
  const base = Math.round((factors.weightKg || 0) * 35);
  const adjustments = [{ label: 'Base (weight × 35ml)', amount: base }];

  const strain = factors.whoopStrain;
  if (strain !== null && strain !== undefined) {
    if      (strain >= 18) adjustments.push({ label: 'High strain (Whoop 18+)',       amount: 750 });
    else if (strain >= 15) adjustments.push({ label: 'Moderate-high strain (Whoop 15+)', amount: 500 });
    else if (strain >= 10) adjustments.push({ label: 'Moderate strain (Whoop 10+)',    amount: 300 });
    // 0-10: no adjustment
  } else if (factors.trainedToday) {
    adjustments.push({ label: 'Training boost', amount: 500 });
  }

  const total = adjustments.reduce((s, a) => s + a.amount, 0);
  return { total, adjustments };
}

// ── Health Metrics Render ──────────────────────────────────
function healthMetricsRender() {
  const data = healthMetricsLoad();
  const height = data.height || null;

  const promptEl  = document.getElementById('hlthHeightPrompt');
  const displayEl = document.getElementById('hlthHeightDisplay');
  const formEl    = document.getElementById('hlthHeightForm');
  const valEl     = document.getElementById('hlthHeightVal');

  if (height) {
    if (promptEl)  promptEl.style.display  = 'none';
    if (displayEl) displayEl.style.display = '';
    if (formEl)    formEl.style.display    = 'none';
    if (valEl)     valEl.textContent        = height.toFixed(1);
  } else {
    if (promptEl)  promptEl.style.display  = '';
    if (displayEl) displayEl.style.display = 'none';
    if (formEl)    formEl.style.display    = '';
    if (valEl)     valEl.textContent        = '—';
  }
}

function initHealthMetrics() {
  const editBtn  = document.getElementById('hlthHeightEditBtn');
  const saveBtn  = document.getElementById('hlthHeightSaveBtn');
  const inEl     = document.getElementById('hlthHeightIn');
  const displayEl = document.getElementById('hlthHeightDisplay');
  const formEl   = document.getElementById('hlthHeightForm');
  const promptEl = document.getElementById('hlthHeightPrompt');

  if (editBtn) editBtn.onclick = () => {
    const data = healthMetricsLoad();
    if (inEl) inEl.value = data.height || '';
    if (displayEl) displayEl.style.display = 'none';
    if (formEl) formEl.style.display = '';
    if (promptEl) promptEl.style.display = 'none';
    if (inEl) setTimeout(() => inEl.focus(), 40);
  };

  if (saveBtn) saveBtn.onclick = () => {
    const val = parseFloat(inEl?.value);
    if (isNaN(val) || val < 50 || val > 300) return;
    const data = healthMetricsLoad();
    data.height = val;
    healthMetricsSave(data);
    healthMetricsRender();
    waterGoalRender();
    waterWidgetRender();
  };

  if (inEl) inEl.addEventListener('keydown', e => { if (e.key === 'Enter') saveBtn?.click(); });

  healthMetricsRender();
}

// ── Water Goal Render ──────────────────────────────────────
function waterGoalRender() {
  const body = document.getElementById('hlthWaterGoalBody');
  if (!body) return;

  const metrics = healthMetricsLoad();
  const entries = wtLoad();
  const latestWt = entries.length ? entries[entries.length - 1].weight : null;

  if (!latestWt) {
    body.innerHTML = '<div class="hlth-water-no-weight">Log your weight first to calculate your daily water goal.</div>';
    return;
  }

  const trainedToday  = !!((() => {
    try { const s = loadGymState(); return s.workoutDone && s.workoutDone[getActiveDateString()]; } catch { return false; }
  })());
  const whoopStrain = (typeof whoopConnected !== 'undefined' && whoopConnected)
    ? (whoopCache?.cycle?.score?.strain ?? null) : null;

  const { total, adjustments } = calcWaterGoal({ weightKg: latestWt, trainedToday, whoopStrain });

  body.innerHTML = '';
  const totRow = document.createElement('div');
  totRow.className = 'hlth-water-goal-total-row';
  totRow.innerHTML = `<span class="hlth-water-goal-big">${total}</span><span class="hlth-water-goal-unit">ml</span>`;
  body.appendChild(totRow);

  const adjList = document.createElement('div');
  adjList.className = 'hlth-water-adj-list';
  adjustments.forEach(a => {
    const row = document.createElement('div');
    row.className = 'hlth-water-adj-row';
    row.innerHTML = `<span class="hlth-water-adj-lbl">${a.label}</span><span class="hlth-water-adj-val">${a.amount}ml</span>`;
    adjList.appendChild(row);
  });
  body.appendChild(adjList);
}

// ── Water Intake load/save ─────────────────────────────────
function waterLoad() {
  const today = getActiveDateString();
  try {
    const raw = JSON.parse(localStorage.getItem(HEALTH_WATER_KEY));
    if (raw && raw.date === today) return raw;
  } catch {}
  return { date: today, entries: [] };
}
function waterSave(data) {
  localStorage.setItem(HEALTH_WATER_KEY, JSON.stringify(data));
  _waterPush(data);
}
function _waterPush(data) {
  if (!useSupabase) return;
  clearTimeout(healthWaterSyncTimer);
  healthWaterSyncTimer = setTimeout(async () => {
    if (!db || !currentUser) return;
    healthWaterLastJson = JSON.stringify(data);
    setSyncing(true);
    try {
      await db.from('app_state').upsert(
        { user_id: currentUser.id, app_key: HEALTH_WATER_APP_KEY, payload: data, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,app_key' }
      );
    } catch { setSyncError(); healthWaterLastJson = null; } finally { setSyncing(false); }
  }, 250);
}
async function loadWaterFromSupabase() {
  if (!db || !currentUser) return;
  const { data, error } = await db.from('app_state').select('payload')
    .eq('user_id', currentUser.id).eq('app_key', HEALTH_WATER_APP_KEY).maybeSingle();
  if (error || !data?.payload) return;
  applyWaterRemote(data.payload);
}
function applyWaterRemote(payload) {
  if (!payload) return;
  const today = getActiveDateString();
  if (payload.date === today) {
    localStorage.setItem(HEALTH_WATER_KEY, JSON.stringify(payload));
    waterRender();
    waterWidgetRender();
  }
}

function waterGetGoal() {
  const entries = wtLoad();
  const latestWt = entries.length ? entries[entries.length - 1].weight : null;
  if (!latestWt) return null;
  const trainedToday = !!((() => {
    try { const s = loadGymState(); return s.workoutDone && s.workoutDone[getActiveDateString()]; } catch { return false; }
  })());
  const whoopStrain = (typeof whoopConnected !== 'undefined' && whoopConnected)
    ? (whoopCache?.cycle?.score?.strain ?? null) : null;
  return calcWaterGoal({ weightKg: latestWt, trainedToday, whoopStrain }).total;
}

// ── Water Intake Render ────────────────────────────────────
function waterRender() {
  const data   = waterLoad();
  const total  = data.entries.reduce((s, e) => s + e.amount, 0);
  const goal   = waterGetGoal();

  const curEl  = document.getElementById('hlthWaterCur');
  const goalEl = document.getElementById('hlthWaterGoalNum');
  const barEl  = document.getElementById('hlthWaterBar');
  const listEl = document.getElementById('hlthWaterEntries');

  if (curEl)  curEl.textContent  = total;
  if (goalEl) goalEl.textContent = goal !== null ? goal : '—';

  if (barEl) {
    const pct = goal ? Math.min((total / goal) * 100, 100) : 0;
    barEl.style.width = pct + '%';
    barEl.className = 'hlth-water-bar ' + (pct >= 90 ? 'good' : pct >= 50 ? 'mid' : 'low');
  }

  if (listEl) {
    listEl.innerHTML = '';
    if (!data.entries.length) {
      listEl.innerHTML = '<div class="hlth-water-empty">No entries yet — log your first drink above.</div>';
    } else {
      [...data.entries].reverse().forEach((entry, ri) => {
        const idx = data.entries.length - 1 - ri;
        const row = document.createElement('div');
        row.className = 'hlth-water-entry';
        row.innerHTML = `
          <span class="hlth-water-entry-time">${entry.time}</span>
          <span class="hlth-water-entry-amt">${entry.amount}ml</span>
          <button class="hlth-water-entry-del" title="Delete">&#215;</button>`;
        row.querySelector('.hlth-water-entry-del').addEventListener('click', () => {
          const d = waterLoad();
          d.entries.splice(idx, 1);
          waterSave(d); waterRender(); waterWidgetRender();
        });
        listEl.appendChild(row);
      });
    }
  }

  // Live-update bottle in Whoop health section without full re-render
  const bottleGoal = goal || 2500;
  const bottleFill = document.getElementById('hlthBottleFillRect');
  if (bottleFill) {
    const newFillH = Math.max(Math.round(Math.min(total / bottleGoal, 1) * 42), 0);
    bottleFill.setAttribute('y', String(60 - newFillH));
    bottleFill.setAttribute('height', String(newFillH));
  }
  const bottleText = document.getElementById('hlthBottleAmountText');
  if (bottleText) {
    bottleText.textContent = `${(total / 1000).toFixed(1)} / ${(bottleGoal / 1000).toFixed(1)} L`;
  }

  waterGoalRender();

  document.querySelectorAll('.hlth-water-undo-btn').forEach(b => { b.disabled = !data.entries.length; });

  waterHistoryRender();
}

function waterHistoryRender() {
  const el = document.getElementById('hlthWaterHistory');
  if (!el) return;

  const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const now = new Date();
  if (now.getHours() < 6) now.setDate(now.getDate() - 1);

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    days.push({ label: DAY_LABELS[d.getDay()], dateKey, total: 0, hit: false });
  }

  const data = waterLoad();
  for (const day of days) {
    if (data.date === day.dateKey) {
      day.total = data.entries.reduce((s, e) => s + e.amount, 0);
    }
  }

  const goal = waterGetGoal() || 2500;
  for (const day of days) {
    day.hit = day.total >= goal;
  }

  if (days.every(d => d.total === 0)) {
    el.innerHTML = '';
    return;
  }

  const BAR_W = 30, GAP = 4, START_X = 5, MAX_H = 38, BASE_Y = 38;
  const lineEnd = START_X + 7 * (BAR_W + GAP) - GAP;

  let svgContent = `<line class="hlth-water-spark-target" x1="${START_X}" y1="0" x2="${lineEnd}" y2="0"/>`;

  days.forEach((day, i) => {
    const x = START_X + i * (BAR_W + GAP);
    const cx = x + BAR_W / 2;
    const isToday = i === 6;
    const opacity = isToday ? 1.0 : 0.7;

    if (day.total > 0) {
      const h = Math.max(2, Math.round((day.total / goal) * MAX_H));
      const y = BASE_Y - h;
      const cls = day.hit ? 'hlth-water-spark-bar-hit' : 'hlth-water-spark-bar-miss';
      svgContent += `<rect class="${cls}" x="${x}" y="${y}" width="${BAR_W}" height="${h}" rx="3" opacity="${opacity}"/>`;
    }

    svgContent += `<text class="hlth-water-spark-day" x="${cx}" y="52" text-anchor="middle">${day.label}</text>`;
  });

  el.innerHTML =
    '<div class="hlth-water-history-label">7-DAY HYDRATION</div>' +
    `<svg class="hlth-water-spark-svg" viewBox="0 0 280 56">${svgContent}</svg>`;
}

function waterAddAmount(ml) {
  ml = Math.round(ml);
  if (!ml || ml <= 0) return;
  const now  = new Date();
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const data = waterLoad();
  data.entries.push({ time, amount: ml });
  waterSave(data); waterRender(); waterWidgetRender();
}

function initWater() {
  document.querySelectorAll('.hlth-water-preset').forEach(btn => {
    btn.addEventListener('click', () => waterAddAmount(parseInt(btn.dataset.ml, 10)));
  });

  const customIn = document.getElementById('hlthWaterCustomIn');
  const addBtn   = document.getElementById('hlthWaterAddBtn');
  if (addBtn) addBtn.addEventListener('click', () => {
    const val = parseFloat(customIn?.value);
    if (!isNaN(val) && val > 0) { waterAddAmount(val); if (customIn) customIn.value = ''; }
  });
  if (customIn) customIn.addEventListener('keydown', e => { if (e.key === 'Enter') addBtn?.click(); });

  waterRender();
}

function waterUndo() {
  const data = waterLoad();
  if (!data.entries.length) return;
  data.entries.pop();
  waterSave(data);
  waterRender();
  waterWidgetRender();
}

// ── Home tab water widget render ───────────────────────────
function waterWidgetRender() {
  const widget = document.getElementById('waterWidget');
  if (!widget) return;

  const entries = wtLoad();
  const latestWt = entries.length ? entries[entries.length - 1].weight : null;

  if (!latestWt) {
    widget.innerHTML = `
      <div class="hlth-water-widget-hdr">
        <span class="hlth-water-widget-title">Hydration</span>
      </div>
      <div class="hlth-water-widget-prompt">Set up body metrics in the Health tab to track hydration.</div>`;
    return;
  }

  const data  = waterLoad();
  const total = data.entries.reduce((s, e) => s + e.amount, 0);
  const goal  = waterGetGoal();
  const pct   = goal ? Math.min(Math.round((total / goal) * 100), 100) : 0;
  const barCls = pct >= 90 ? 'good' : pct >= 50 ? 'mid' : 'low';

  widget.innerHTML = `
    <div class="hlth-water-widget-hdr">
      <span class="hlth-water-widget-title">Hydration</span>
      <span class="hlth-water-widget-pct">${pct}%</span>
    </div>
    <div class="hlth-water-widget-nums">
      <span class="hlth-water-widget-cur">${total}</span>
      <span class="hlth-water-widget-sep">/</span>
      <span class="hlth-water-widget-goal">${goal}</span>
      <span class="hlth-water-widget-unit">ml</span>
    </div>
    <div class="hlth-water-bar-wrap"><div class="hlth-water-bar ${barCls}" style="width:${pct}%"></div></div>`;
}

// ── Body metrics modal ─────────────────────────────────────
function hlthBodyModalOpen() {
  const modal = document.getElementById('hlthBodyModal');
  if (!modal) return;

  const metrics = healthMetricsLoad();
  const curHEl = document.getElementById('hlthModalHeightCur');
  if (curHEl) {
    if (metrics.height) {
      curHEl.innerHTML = `${metrics.height.toFixed(1)}<span class="hlth-body-modal-cur-unit">cm</span>`;
    } else {
      curHEl.textContent = '—';
    }
  }

  const entries = wtLoad().slice().sort((a,b) => a.dateKey < b.dateKey ? -1 : 1);
  const latestWt = entries.length ? entries[entries.length - 1] : null;
  const units = loadGymState().units || 'kg';
  const curWEl = document.getElementById('hlthModalWeightCur');
  if (curWEl) {
    if (latestWt) {
      curWEl.innerHTML = `${latestWt.weight.toFixed(1)}<span class="hlth-body-modal-cur-unit">${units}</span>`;
    } else {
      curWEl.textContent = '—';
    }
  }
  const unitEl = document.getElementById('hlthModalWeightUnit');
  if (unitEl) unitEl.textContent = units;

  modal.style.display = 'flex';
  requestAnimationFrame(() => requestAnimationFrame(() => modal.classList.add('open')));
}

function hlthBodyModalClose() {
  const modal = document.getElementById('hlthBodyModal');
  if (!modal) return;
  modal.classList.remove('open');
  setTimeout(() => { modal.style.display = 'none'; }, 300);
}

// ── initHealth (called from bootApp / initAuth) ─────────────
function initHealth() {
  initHealthMetrics();
  initWater();
  waterWidgetRender();
  renderHydrationPanel();
  if (typeof window.cafHealthInit === 'function') window.cafHealthInit();

  // Body metrics modal buttons
  const heightSaveBtn = document.getElementById('hlthModalHeightSave');
  if (heightSaveBtn) heightSaveBtn.onclick = () => {
    const val = parseFloat(document.getElementById('hlthModalHeightIn')?.value);
    if (isNaN(val) || val < 50 || val > 300) return;
    const data = healthMetricsLoad();
    data.height = val;
    healthMetricsSave(data);
    waterGoalRender();
    waterWidgetRender();
    const curHEl = document.getElementById('hlthModalHeightCur');
    if (curHEl) curHEl.innerHTML = `${val.toFixed(1)}<span class="hlth-body-modal-cur-unit">cm</span>`;
    const inEl = document.getElementById('hlthModalHeightIn');
    if (inEl) inEl.value = '';
  };

  const weightSaveBtn = document.getElementById('hlthModalWeightSave');
  if (weightSaveBtn) weightSaveBtn.onclick = () => {
    const val = parseFloat(document.getElementById('hlthModalWeightIn')?.value);
    if (isNaN(val) || val <= 0) return;
    const today = gymToday();
    const entries = wtLoad();
    const i = entries.findIndex(e => e.dateKey === today);
    if (i !== -1) entries[i].weight = val; else entries.push({ dateKey: today, weight: val });
    entries.sort((a,b) => a.dateKey < b.dateKey ? -1 : 1);
    wtSave(entries);
    const units = loadGymState().units || 'kg';
    const curWEl = document.getElementById('hlthModalWeightCur');
    if (curWEl) curWEl.innerHTML = `${val.toFixed(1)}<span class="hlth-body-modal-cur-unit">${units}</span>`;
    const inEl = document.getElementById('hlthModalWeightIn');
    if (inEl) inEl.value = '';
    renderHydrationPanel();
    waterGoalRender();
    waterWidgetRender();
  };

  const heightInEl = document.getElementById('hlthModalHeightIn');
  if (heightInEl) heightInEl.addEventListener('keydown', e => { if (e.key === 'Enter') heightSaveBtn?.click(); });
  const weightInEl = document.getElementById('hlthModalWeightIn');
  if (weightInEl) weightInEl.addEventListener('keydown', e => { if (e.key === 'Enter') weightSaveBtn?.click(); });
}

// ── Whoop Integration ──────────────────────────────────────

let whoopCache = { cycle: null, recovery: null, recoveryPrev: null, recoveryHistory: [], cycleHistory: [], sleep: [], workout: [], vo2max: null, reauth: false, connectError: false };
let whoopConnected  = false;
let whoopLastSync   = null;

function getWhoopData() { return whoopCache; }

function recoveryColor(score) {
  if (score >= 67) return 'var(--success)';
  if (score >= 34) return 'var(--warning)';
  return 'var(--danger)';
}

function whoopSportName(id) {
  const s = { 0:'Activity',1:'Running',2:'Cycling',16:'Baseball',17:'Basketball',18:'Rowing',
    19:'Fencing',20:'Field Hockey',21:'Football',22:'Golf',24:'Ice Hockey',25:'Lacrosse',
    27:'Rugby',28:'Skiing',29:'Soccer',30:'Softball',31:'Squash',32:'Swimming',33:'Tennis',
    34:'Track & Field',35:'Volleyball',36:'Water Polo',37:'Wrestling',38:'Boxing',39:'Dance',
    40:'Pilates',41:'Yoga',42:'Weightlifting',43:'Cross Country Skiing',44:'Functional Fitness',
    45:'Duathlon',46:'Gymnastics',47:'Hiking',48:'Horseback Riding',49:'Kayaking',51:'Meditation',
    52:'Mountain Biking',53:'Paddleboarding',55:'Rock Climbing',56:'Rowing',57:'Skateboarding',
    59:'Snowboarding',63:'Stair Climber',64:'Surfing',65:'Swimming',67:'Triathlon',68:'Walking',
    70:'Wheelchair Pushing',73:'HIIT',74:'Spin',75:'Jiu Jitsu',76:'Manual Labor',
    77:'Cricket',78:'Pickleball',79:'Inline Skating',80:'Box Fitness' };
  return s[id] || 'Workout';
}

async function whoopApiFetch(endpoint, overrideUserId) {
  const userId = overrideUserId ?? currentUser?.id;
  if (!userId || !useSupabase) return null;
  try {
    const res = await fetch('/api/whoop-fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, endpoint }),
    });
    return await res.json();
  } catch (err) {
    console.error('whoopApiFetch error:', err);
    return null;
  }
}

async function loadWhoopData(overrideUserId) {
  const userId = overrideUserId ?? currentUser?.id;
  if (!userId || !useSupabase) return;

  const [cycleData, recoveryData, sleepData, workoutData] = await Promise.all([
    whoopApiFetch('cycle?limit=7',     userId),
    whoopApiFetch('recovery?limit=14', userId),
    whoopApiFetch('sleep?limit=7',     userId),
    whoopApiFetch('workout?limit=5',   userId),
  ]);

  const firstErr = (cycleData || recoveryData || {}).error;
  if (firstErr === 'not_connected') {
    whoopConnected = false;
    renderWhoopWidgets();
    return;
  }
  if (firstErr === 'reauth_required') {
    whoopConnected = false;
    whoopCache.reauth = true;
    renderWhoopWidgets();
    return;
  }

  const allCycles          = cycleData?.records    ?? [];
  const allRecRecs         = recoveryData?.records ?? [];
  whoopConnected           = !cycleData?.error;
  whoopCache.cycle         = allCycles[0]          ?? null;
  whoopCache.cycleHistory  = allCycles;
  whoopCache.recovery      = allRecRecs.find(r => r.score_state === 'SCORED' || (r.score && r.score.resting_heart_rate != null)) ?? allRecRecs[0] ?? null;
  whoopCache.recoveryPrev  = allRecRecs.find(r => r !== whoopCache.recovery && r.score?.resting_heart_rate != null) ?? null;
  whoopCache.recoveryHistory = allRecRecs;
  whoopCache.sleep         = sleepData?.records    ?? [];
  whoopCache.workout       = workoutData?.records  ?? [];
  whoopCache.reauth        = false;
  whoopCache.connectError  = false;
  whoopLastSync            = new Date();

  renderWhoopWidgets();
}

function renderWhoopWidgets() {
  renderWhoopHomeWidget();
  renderWhoopHealthSection();
  renderWhoopGymBanner();
  renderWhoopGymHistory();
  waterGoalRender();
  waterWidgetRender();
  if (typeof window.renderEnergyBanner === 'function') window.renderEnergyBanner();
  if (typeof window.renderTasksSpine === 'function') window.renderTasksSpine();
  if (typeof window.cafSyncFromShared === 'function') window.cafSyncFromShared();
  writeHealthBridge();
}

function writeHealthBridge() {
  try {
    const rec    = whoopCache.recovery;
    const sleep0 = whoopCache.sleep?.[0];
    const cycle  = whoopCache.cycle;

    const recoveryScore = rec?.score?.recovery_score ?? null;
    const hrv           = rec?.score?.hrv_rmssd_milli != null ? Math.round(rec.score.hrv_rmssd_milli) : null;
    const rhr           = rec?.score?.resting_heart_rate != null ? Math.round(rec.score.resting_heart_rate) : null;
    const sleepPerf     = rec?.score?.sleep_performance_percentage ?? null;
    // Actual time asleep = light + SWS + REM (excludes awake time in bed), matching
    // Whoop's headline "hours of sleep". Falls back to time-in-bed (start→end) only
    // when the stage breakdown is unavailable.
    const sleepHours    = (() => {
      if (!sleep0) return null;
      const g = sleep0.score?.stage_summary;
      const asleepMs = g
        ? (g.total_light_sleep_time_milli || 0) + (g.total_slow_wave_sleep_time_milli || 0) + (g.total_rem_sleep_time_milli || 0)
        : 0;
      if (asleepMs > 0) return asleepMs / 3600000;
      try { return (new Date(sleep0.end) - new Date(sleep0.start)) / 3600000; } catch { return null; }
    })();
    const strain        = cycle?.score?.strain ?? null;

    const bridge = {
      connected:    !!whoopConnected,
      recovery:     recoveryScore,
      hrv:          hrv,
      rhr:          rhr,
      sleepPerf:    sleepPerf,
      sleepHours:   sleepHours != null ? Math.round(sleepHours * 100) / 100 : null,
      strain:       strain,
      updatedAt:    Date.now(),
    };
    localStorage.setItem('patron_health_v1', JSON.stringify(bridge));
    window.dispatchEvent(new CustomEvent('whoop-health-updated'));
  } catch (e) { /* non-fatal */ }
}

// ── Home tab Whoop widget ───────────────────────────────────
function renderWhoopHomeWidget() {
  const el = document.getElementById('whoopWidget');
  if (!el) return;

  if (!whoopConnected) {
    const note = whoopCache.reauth
      ? '<div style="font-size:12px;color:var(--warning);margin-bottom:10px;">Reconnection required — session expired.</div>'
      : whoopCache.connectError
        ? '<div style="font-size:12px;color:var(--danger);margin-bottom:10px;">Connection failed. Please try again.</div>'
        : '<div style="font-size:13px;color:var(--text-tertiary);margin-bottom:10px;">Connect Whoop to see recovery &amp; strain data.</div>';
    el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
        <div>
          <div class="wt-ey" style="margin-bottom:6px;">Whoop</div>
          ${note}
        </div>
        <button class="whoop-connect-btn" onclick="whoopStartAuth()">Connect Whoop</button>
      </div>`;
    return;
  }

  const rec      = whoopCache.recovery;
  const cycle    = whoopCache.cycle;
  const sleep0   = whoopCache.sleep?.[0];
  const score    = rec?.score?.recovery_score      ?? null;
  const hrv      = rec?.score?.hrv_rmssd_milli     ?? null;
  const rhr      = rec?.score?.resting_heart_rate  ?? null;
  const strain   = cycle?.score?.strain            ?? null;
  const sleepPerf= sleep0?.score?.sleep_performance_percentage ?? null;
  const stageSum = sleep0?.score?.stage_summary;
  // Actual time asleep = light + SWS + REM (excludes awake time in bed).
  const sleepMs  = stageSum
    ? (stageSum.total_rem_sleep_time_milli||0)+(stageSum.total_slow_wave_sleep_time_milli||0)
      +(stageSum.total_light_sleep_time_milli||0)
    : 0;
  const sleepDurH = sleepMs ? (sleepMs/3600000).toFixed(1) : null;
  const scoreColor = score !== null ? recoveryColor(score) : 'var(--text-secondary)';

  el.innerHTML = `
    <div class="wt-ey" style="margin-bottom:12px;">Whoop</div>
    <div class="whoop-home-grid">
      <div style="text-align:center;">
        <div class="whoop-score" style="color:${scoreColor}">${score !== null ? Math.round(score) : '—'}</div>
        <div class="whoop-score-label">Recovery</div>
      </div>
      <div class="whoop-home-stats">
        <div class="whoop-stat-item"><div class="whoop-stat-val">${hrv !== null ? Math.round(hrv) : '—'}</div><div class="whoop-stat-lbl">HRV ms</div></div>
        <div class="whoop-stat-item"><div class="whoop-stat-val">${rhr !== null ? Math.round(rhr) : '—'}</div><div class="whoop-stat-lbl">RHR bpm</div></div>
        <div class="whoop-stat-item"><div class="whoop-stat-val">${sleepPerf !== null ? Math.round(sleepPerf)+'%' : '—'}</div><div class="whoop-stat-lbl">Sleep</div></div>
        <div class="whoop-stat-item"><div class="whoop-stat-val">${sleepDurH !== null ? sleepDurH+'h' : '—'}</div><div class="whoop-stat-lbl">Duration</div></div>
        <div class="whoop-stat-item"><div class="whoop-stat-val">${strain !== null ? strain.toFixed(1) : '—'}</div><div class="whoop-stat-lbl">Strain</div></div>
      </div>
    </div>
    <div style="text-align:right;margin-top:10px;">
      <button class="whoop-reconnect-btn" onclick="whoopStartAuth()">Reconnect</button>
    </div>`;
}

// ── Supplement taken toggle (called from Whoop health section matrix) ──
window.hlthSuppToggle = function(suppId, session) {
  const dateKey = `supp_taken:${getActiveDateString()}`;
  const taken = storeGet(dateKey) || {};
  const key = `${suppId}:${session}`;
  if (taken[key]) delete taken[key]; else taken[key] = true;
  storeSet(dateKey, taken);
  renderHydrationPanel();
};

// ── Health tab Whoop section ────────────────────────────────
function renderWhoopHealthSection() {
  const el = document.getElementById('whoopHealthSection');
  if (!el) return;

  // ── Data extraction ──────────────────────────────────────
  const rec      = whoopCache.recovery;
  const cycle    = whoopCache.cycle;
  const sleep0   = whoopCache.sleep?.[0];

  const score    = rec?.score?.recovery_score     ?? null;
  const hrv      = rec?.score?.hrv_rmssd_milli    ?? null;
  const rhr      = rec?.score?.resting_heart_rate ?? null;
  const rr       = rec?.score?.respiratory_rate ?? sleep0?.score?.respiratory_rate ?? null;
  const skinTemp = rec?.score?.skin_temp_celsius  ?? null;

  const recPrev  = whoopCache.recoveryPrev;
  const prevHrv  = recPrev?.score?.hrv_rmssd_milli    ?? null;
  const prevRhr  = recPrev?.score?.resting_heart_rate ?? null;
  const prevRr   = recPrev?.score?.respiratory_rate   ?? null;
  const prevSkin = recPrev?.score?.skin_temp_celsius  ?? null;

  const scoreColor   = score !== null ? recoveryColor(score) : 'var(--text-secondary)';
  const scoreHex     = score !== null ? (score >= 67 ? '#6BE3A4' : score >= 34 ? '#F2C063' : '#FF6B6B') : '#888';
  const scoreTagline = score !== null
    ? (score >= 67 ? 'primed · go hard' : score >= 34 ? 'rebuild · easy day' : 'restore · rest up')
    : '—';
  const syncTime = whoopLastSync
    ? whoopLastSync.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—';

  // ── Sleep ────────────────────────────────────────────────
  const stageSum = sleep0?.score?.stage_summary ?? {};
  const remMs    = stageSum.total_rem_sleep_time_milli       ?? 0;
  const deepMs   = stageSum.total_slow_wave_sleep_time_milli ?? 0;
  const lightMs  = stageSum.total_light_sleep_time_milli     ?? 0;
  const awakeMs  = stageSum.total_awake_time_milli           ?? 0;
  const totalMs  = remMs + deepMs + lightMs + awakeMs;
  const toHM = ms => {
    const h = Math.floor(ms / 3600000), m = Math.round((ms % 3600000) / 60000);
    return h ? `${h}h ${m}m` : `${m}m`;
  };
  const pct        = v => totalMs ? Math.round((v / totalMs) * 100) : 0;
  const sleepPerf  = sleep0?.score?.sleep_performance_percentage ?? null;
  const sleepPerfColor = sleepPerf !== null ? (sleepPerf >= 85 ? '#6BE3A4' : sleepPerf >= 70 ? '#F2C063' : '#FF6B6B') : 'var(--text-secondary)';
  const sleepDurH  = totalMs ? totalMs / 3600000 : null;
  const durStr     = sleepDurH
    ? `${Math.floor(sleepDurH)}H ${Math.round((sleepDurH % 1) * 60)}M` : '—';
  const sleepStart = sleep0?.start
    ? new Date(sleep0.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
  const sleepEnd   = sleep0?.end
    ? new Date(sleep0.end).toLocaleTimeString([],   { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';

  // ── Water ────────────────────────────────────────────────
  const waterData    = waterLoad();
  const waterTotal   = waterData.entries.reduce((s, e) => s + e.amount, 0);
  const waterGoal    = waterGetGoal() || 2500;
  const waterIntakeL = (waterTotal / 1000).toFixed(1);
  const waterGoalL   = (waterGoal  / 1000).toFixed(1);
  const waterFillPct = Math.min(waterTotal / waterGoal, 1);
  let strainLabel = '';
  const whoopStrainVal = cycle?.score?.strain ?? null;
  if (whoopStrainVal !== null) {
    strainLabel = `+${Math.round(whoopStrainVal * 35)}ml strain`;
  } else {
    try {
      const gs = loadGymState();
      if (gs.workoutDone && gs.workoutDone[getActiveDateString()]) strainLabel = '+500ml training';
    } catch {}
  }

  // ── Body weight ──────────────────────────────────────────
  const wtEntries  = wtLoad();
  const last14     = wtEntries.slice(-14);
  const currentWt  = last14.length ? last14[last14.length - 1].weight : null;
  const earliestWt = last14.length >= 2 ? last14[0].weight : null;
  const wtDelta    = (currentWt !== null && earliestWt !== null) ? (currentWt - earliestWt) : null;
  const wtDeltaStr = wtDelta !== null
    ? (wtDelta <= 0 ? `↘ ${Math.abs(wtDelta).toFixed(1)}` : `↗ +${wtDelta.toFixed(1)}`)
    : null;
  const wtDeltaColor = wtDelta !== null ? (wtDelta <= 0 ? '#6BE3A4' : '#FF6B6B') : 'var(--text-tertiary)';

  // ── Supplements ──────────────────────────────────────────
  const suppCfg   = storeGet('supp_config') || { supplements: [], times: { morning: '08:00', lunch: '13:00', night: '22:00' }, overdueGraceMins: 30 };
  const suppTaken = storeGet(`supp_taken:${getActiveDateString()}`) || {};
  let suppTakenCount = 0, suppTotalCount = 0;
  suppCfg.supplements.forEach(s => {
    ['morning', 'lunch', 'night'].forEach(sess => {
      if (s.sessions.includes(sess)) {
        suppTotalCount++;
        if (suppTaken[`${s.id}:${sess}`]) suppTakenCount++;
      }
    });
  });
  const _nowDate  = new Date();
  const _nowMins  = _nowDate.getHours() * 60 + _nowDate.getMinutes();
  let nextSessTime = null;
  for (const sess of ['morning', 'lunch', 'night']) {
    const [h, m] = (suppCfg.times[sess] || '08:00').split(':').map(Number);
    if (h * 60 + m > _nowMins) { nextSessTime = suppCfg.times[sess]; break; }
  }
  if (!nextSessTime) nextSessTime = suppCfg.times.morning;

  // ── SVG helpers ──────────────────────────────────────────
  const W = 280, H = 140, cx = 140, cy = 130, R = 105;
  const toRad = d => d * Math.PI / 180;
  const arcPt = (deg, r) => [cx + Math.cos(toRad(deg)) * r, cy + Math.sin(toRad(deg)) * r];

  const DANGER_HEX  = '#FF6B6B';
  const WARNING_HEX = '#F2C063';
  const SUCCESS_HEX = '#6BE3A4';

  // Background arc (full semicircle)
  const bgArc = `<path d="M ${cx - R} ${cy} A ${R} ${R} 0 0 1 ${cx + R} ${cy}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1.5"/>`;

  // Zone arcs: 180°→240° danger · 240°→300° warning · 300°→360° success
  const zoneArcs = [[180, 240, DANGER_HEX], [240, 300, WARNING_HEX], [300, 360, SUCCESS_HEX]].map(([a1, a2, col]) => {
    const [x1, y1] = arcPt(a1, R);
    const [x2, y2] = arcPt(a2, R);
    return `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${R} ${R} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${col}" stroke-width="3" stroke-linecap="round" opacity="0.9"/>`;
  }).join('');

  // 11 tick marks every 18°
  const ticksSvg = Array.from({ length: 11 }).map((_, i) => {
    const a = 180 + (i / 10) * 180;
    const [x1, y1] = arcPt(a, R - 6);
    const [x2, y2] = arcPt(a, R + 2);
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="rgba(255,255,255,0.4)" stroke-width="1" opacity="${i % 5 === 0 ? 1 : 0.35}"/>`;
  }).join('');

  // Needle: score 0→180° (left), score 100→360° (right)
  const needleAngle = 180 + ((score ?? 0) / 100) * 180;
  const [nx, ny] = arcPt(needleAngle, R - 10);
  const needleSvg = score !== null
    ? `<line x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="${scoreHex}" stroke-width="2" stroke-linecap="round"/>
       <circle cx="${cx}" cy="${cy}" r="6" fill="#050506" stroke="${scoreHex}" stroke-width="1.6"/>
       <circle cx="${cx}" cy="${cy}" r="2" fill="${scoreHex}"/>`
    : `<circle cx="${cx}" cy="${cy}" r="6" fill="#050506" stroke="rgba(255,255,255,0.2)" stroke-width="1.6"/>`;

  const speedoSvg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax meet" style="position:absolute;inset:0;width:100%;height:100%;">${bgArc}${zoneArcs}${ticksSvg}${needleSvg}</svg>`;

  // ── Metric row helper (stacked right-side layout) ────────
  const trendTile = (label, displayVal, unit, rawCurr, rawPrev, goodWhen, leftHex, metricKey) => {
    let arrowHtml = '';
    if (rawCurr !== null && rawPrev !== null) {
      const diff = rawCurr - rawPrev;
      if (Math.abs(diff) > 0.05) {
        const isUp   = diff > 0;
        const isGood = goodWhen === 'up' ? isUp : !isUp;
        const arrowColor = isGood ? '#6BE3A4' : '#FF6B6B';
        arrowHtml = `<span style="font-size:11px;font-weight:700;color:${arrowColor};line-height:1;">${isUp ? '↑' : '↓'}</span>`;
      }
    }
    return `<div style="flex:1;display:flex;align-items:center;justify-content:space-between;padding:0 10px;border:1px solid rgba(255,255,255,0.07);border-left:3px solid ${leftHex};border-radius:4px;background:rgba(255,255,255,0.02);cursor:pointer;" onclick="hlthShowMetricInfo('${metricKey}')">
      <span style="font-family:ui-monospace,monospace;font-size:9px;text-transform:uppercase;letter-spacing:0.12em;color:var(--text-tertiary);">${label}</span>
      <div style="display:flex;align-items:center;gap:4px;">
        <div style="display:flex;align-items:baseline;gap:2px;">
          <span style="font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1;">${displayVal}</span>
          <span style="font-family:ui-monospace,monospace;font-size:9px;color:var(--text-tertiary);">${unit}</span>
        </div>
        ${arrowHtml}
      </div>
    </div>`;
  };

  // ── Sleep stage strip ────────────────────────────────────
  const sleepBarContent = totalMs > 0
    ? `<div style="flex:${pct(remMs)};background:#5BB8F5;border-right:1px solid #050506;" title="REM ${toHM(remMs)}"></div>
       <div style="flex:${pct(deepMs)};background:#6BE3A4;border-right:1px solid #050506;" title="Deep ${toHM(deepMs)}"></div>
       <div style="flex:${pct(lightMs)};background:rgba(255,255,255,0.18);border-right:1px solid #050506;" title="Light ${toHM(lightMs)}"></div>
       <div style="flex:${pct(awakeMs)};background:rgba(255,255,255,0.06);" title="Awake ${toHM(awakeMs)}"></div>`
    : `<div style="flex:1;background:rgba(255,255,255,0.06);"></div>`;

  const sleepChips = totalMs > 0 ? `
    <div style="display:flex;gap:5px;margin-top:6px;flex-wrap:wrap;">
      <span class="hlth-sleep-chip" style="color:#5BB8F5;border-color:#5BB8F5;">REM ${toHM(remMs)}</span>
      <span class="hlth-sleep-chip" style="color:#6BE3A4;border-color:#6BE3A4;">Deep ${toHM(deepMs)}</span>
      <span class="hlth-sleep-chip" style="color:rgba(255,255,255,0.3);border-color:rgba(255,255,255,0.2);">Light ${toHM(lightMs)}</span>
      <span class="hlth-sleep-chip" style="color:rgba(255,255,255,0.15);border-color:rgba(255,255,255,0.12);">Awake ${toHM(awakeMs)}</span>
    </div>` : '';

  // ── Sleep insight ─────────────────────────────────────────
  let sleepInsight = null;
  if (totalMs > 0 || sleepPerf !== null) {
    const remPct   = totalMs ? Math.round((remMs   / totalMs) * 100) : 0;
    const deepPct  = totalMs ? Math.round((deepMs  / totalMs) * 100) : 0;
    const awakePct = totalMs ? Math.round((awakeMs / totalMs) * 100) : 0;
    if (sleepPerf !== null && sleepPerf >= 85) {
      sleepInsight = deepPct >= 15
        ? `Great recovery night — deep sleep hit ${deepPct}%, solid slow-wave restoration.`
        : `High performance sleep. Boosting deep sleep (currently ${deepPct}%) could push scores further.`;
    } else if (sleepDurH !== null && sleepDurH < 7) {
      sleepInsight = `Short night at ${durStr} — aim for 7–9h for full recovery.`;
    } else if (awakePct > 10) {
      sleepInsight = `Notable wake time (${toHM(awakeMs)}) disrupted recovery — check sleep environment.`;
    } else if (deepPct < 12 && totalMs > 0) {
      sleepInsight = `Deep sleep at ${deepPct}% is below ideal — try a cooler room or avoiding late meals.`;
    } else if (remPct < 15 && totalMs > 0) {
      sleepInsight = `REM at ${remPct}% is light — a consistent sleep schedule helps maximise REM cycles.`;
    } else if (sleepPerf !== null) {
      sleepInsight = `Score ${Math.round(sleepPerf)}% · REM ${remPct}% · Deep ${deepPct}% — well-balanced stages.`;
    } else if (totalMs > 0) {
      sleepInsight = `REM ${remPct}% · Deep ${deepPct}% · Light ${100 - remPct - deepPct - awakePct}% — well distributed.`;
    }
  }

  // ── Water bottle SVG ─────────────────────────────────────
  const bottleBodyH = 42;
  const fillH = Math.max(Math.round(waterFillPct * bottleBodyH), 0);
  const bottleSvg = `<svg viewBox="0 0 50 64" style="width:38px;height:58px;">
    <path d="M16 4 L34 4 L34 12 L40 18 L40 60 L10 60 L10 18 L16 12 Z" fill="none" stroke="#5BB8F5" stroke-width="1.5"/>
    <rect id="hlthBottleFillRect" x="11" y="${60 - fillH}" width="28" height="${fillH}" fill="#5BB8F5" opacity="0.32"/>
    ${[22, 30, 38, 46, 54].map(y => `<line x1="38" y1="${y}" x2="40" y2="${y}" stroke="#5BB8F5" stroke-width="0.8"/>`).join('')}
  </svg>`;

  // ── Body weight 14-day chart ──────────────────────────────
  let bodyChartSvg = '<div style="height:36px;"></div>';
  if (last14.length >= 2) {
    const weights = last14.map(e => e.weight);
    const minW = Math.min(...weights), maxW = Math.max(...weights);
    const range = Math.max(maxW - minW, 0.5);
    const yOf = w => 28 - Math.max(((w - minW) / range) * 22 + 4, 2);
    const bars = last14.map((e, i) => {
      const h = Math.max(((e.weight - minW) / range) * 22 + 4, 2);
      return `<rect x="${i * 10 + 1}" y="${28 - h}" width="7" height="${h}" fill="${WARNING_HEX}" opacity="${i === last14.length - 1 ? 1 : 0.5}" rx="1"/>`;
    }).join('');
    let lineD = `M 4.5 ${yOf(last14[0].weight)}`;
    last14.forEach((e, i) => { if (i > 0) lineD += ` L ${i * 10 + 4.5} ${yOf(e.weight)}`; });
    const lastX = (last14.length - 1) * 10 + 4.5;
    const lastY = yOf(last14[last14.length - 1].weight);
    bodyChartSvg = `<svg viewBox="0 0 140 32" preserveAspectRatio="none" style="width:100%;height:36px;display:block;">
      <line x1="0" y1="28" x2="140" y2="28" stroke="rgba(255,255,255,0.1)" stroke-width="0.5" stroke-dasharray="2 2"/>
      ${bars}
      <path d="${lineD}" stroke="${SUCCESS_HEX}" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${lastX}" cy="${lastY}" r="1.6" fill="${SUCCESS_HEX}"/>
    </svg>`;
  }

  // ── Supplement matrix cell helper ─────────────────────────
  const cellDot = (suppId, session, suppSessions) => {
    if (!suppSessions.includes(session)) {
      return `<span style="display:block;text-align:center;font-size:13px;line-height:1;color:rgba(255,255,255,0.15);">·</span>`;
    }
    const key = `${suppId}:${session}`;
    const isTaken = !!suppTaken[key];
    return `<button onclick="hlthSuppToggle('${suppId}','${session}')" style="display:block;width:100%;text-align:center;background:none;border:none;cursor:pointer;padding:5px 0;font-size:18px;line-height:1;color:${isTaken ? SUCCESS_HEX : 'var(--text-tertiary)'};">${isTaken ? '●' : '○'}</button>`;
  };

  const suppRowsHtml = suppCfg.supplements.map((s, i) => {
    const isLast = i === suppCfg.supplements.length - 1;
    return `<div class="hlth-supp-matrix-grid" style="padding:7px 2px;${isLast ? '' : 'border-bottom:1px dashed rgba(255,255,255,0.08);'}">
      <span style="font-size:13px;color:var(--text-primary);">${s.name}</span>
      ${cellDot(s.id, 'morning', s.sessions)}
      ${cellDot(s.id, 'lunch',   s.sessions)}
      ${cellDot(s.id, 'night',   s.sessions)}
    </div>`;
  }).join('');

  // ── Render ───────────────────────────────────────────────
  el.innerHTML = `
  <!-- A. Recovery hero card -->
  <div class="gm-card" style="padding:12px 14px 14px;margin-bottom:10px;border:1px solid ${scoreHex}4d;">
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
      <span style="font-family:ui-monospace,monospace;font-size:9px;letter-spacing:0.15em;text-transform:uppercase;color:${scoreColor};">RECOVERY · WHOOP</span>
      <span style="font-family:ui-monospace,monospace;font-size:9px;color:var(--text-tertiary);">⟳ ${syncTime}</span>
    </div>
    <div style="display:flex;gap:10px;align-items:stretch;">
      <!-- Left: speedometer -->
      <div style="flex:0 0 auto;width:46%;position:relative;">
        <div class="hlth-speedo-wrap" style="height:148px;">
          ${speedoSvg}
          <div class="hlth-speedo-overlay">
            <div style="font-size:48px;font-weight:800;font-variant-numeric:tabular-nums;color:${scoreColor};line-height:0.9;letter-spacing:-0.04em;">${score !== null ? Math.round(score) : '—'}</div>
            <div style="font-size:10px;color:var(--text-tertiary);margin-top:3px;">${scoreTagline}</div>
          </div>
        </div>
      </div>
      <!-- Right: stacked metric rows -->
      <div style="flex:1;display:flex;flex-direction:column;gap:6px;">
        ${trendTile('HRV',  hrv      !== null ? Math.round(hrv)     : '—', 'ms',  hrv,      prevHrv,  'up',   SUCCESS_HEX, 'HRV')}
        ${trendTile('RHR',  rhr      !== null ? Math.round(rhr)     : '—', 'bpm', rhr,      prevRhr,  'down', DANGER_HEX,  'RHR')}
        ${trendTile('RR',   rr       !== null ? rr.toFixed(1)       : '—', '/m',  rr,       prevRr,   'down', '#5BB8F5',   'RR')}
        ${trendTile('SKIN', skinTemp !== null ? skinTemp.toFixed(1) : '—', '°C',  skinTemp, prevSkin, 'down', WARNING_HEX, 'SKIN')}
      </div>
    </div>
    <div style="display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:10px;">
      ${whoopConnected
        ? `<button class="whoop-reconnect-btn" onclick="whoopStartAuth()">Reconnect</button>
           <button class="whoop-reconnect-btn" style="color:var(--danger);border-color:rgba(255,107,107,0.2);" onclick="whoopDisconnect()">Disconnect</button>`
        : `${whoopCache.reauth ? '<span style="font-size:10px;color:var(--warning);margin-right:auto;">Session expired</span>' : whoopCache.connectError ? '<span style="font-size:10px;color:var(--warning);margin-right:auto;">Connection failed</span>' : ''}
           <button class="whoop-connect-btn" onclick="whoopStartAuth()">${whoopCache.reauth ? 'Reconnect Whoop' : 'Connect Whoop'}</button>`
      }
    </div>
  </div>

  <!-- B. Sleep card -->
  <div class="gm-card" style="padding:12px 14px 14px;margin-bottom:10px;border:1px solid rgba(91,184,245,0.25);">
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;">
      <span style="font-family:ui-monospace,monospace;font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:#5BB8F5;">SLEEP</span>
      <span style="font-family:ui-monospace,monospace;font-size:9px;color:var(--text-tertiary);">${sleepStart} → ${sleepEnd}</span>
    </div>
    <div style="display:flex;align-items:flex-end;gap:20px;margin-bottom:12px;">
      <div>
        <div style="font-size:36px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1;color:var(--text-primary);">${durStr}</div>
        <div style="font-family:ui-monospace,monospace;font-size:9px;color:var(--text-tertiary);margin-top:4px;letter-spacing:0.1em;">DURATION</div>
      </div>
      ${sleepPerf !== null ? `<div style="padding-bottom:2px;">
        <div style="font-size:28px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1;color:${sleepPerfColor};">${Math.round(sleepPerf)}%</div>
        <div style="font-family:ui-monospace,monospace;font-size:9px;color:var(--text-tertiary);margin-top:4px;letter-spacing:0.1em;">PERFORMANCE</div>
      </div>` : ''}
    </div>
    <div class="hlth-sleep-stage-strip" style="height:20px;">${sleepBarContent}</div>
    ${sleepChips}
    ${sleepInsight ? `<div style="margin-top:10px;padding:8px 10px;background:rgba(91,184,245,0.07);border-radius:5px;border-left:2px solid rgba(91,184,245,0.4);">
      <span style="font-size:11px;color:var(--text-secondary);line-height:1.4;">${sleepInsight}</span>
    </div>` : ''}
  </div>

  <!-- C. Hydration + Body weight row -->
  <div class="hlth-body-row" style="margin-bottom:10px;">
    <div class="gm-card" style="padding:10px;margin-bottom:0;border:1px solid rgba(91,184,245,0.2);">
      <span style="font-family:ui-monospace,monospace;font-size:8px;letter-spacing:0.15em;text-transform:uppercase;color:#5BB8F5;display:block;margin-bottom:6px;">HYDRATION</span>
      <div style="display:flex;flex-direction:column;align-items:center;gap:4px;">
        ${bottleSvg}
        <div style="text-align:center;">
          <div id="hlthBottleAmountText" style="font-size:16px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;">${waterIntakeL} / ${waterGoalL} L</div>
          ${strainLabel ? `<div style="font-family:ui-monospace,monospace;font-size:8px;color:var(--text-tertiary);margin-top:2px;">${strainLabel}</div>` : ''}
        </div>
      </div>
    </div>
    <div class="gm-card" style="padding:10px;margin-bottom:0;border:1px solid rgba(242,192,99,0.2);cursor:pointer;" onclick="hlthBodyModalOpen()">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;">
        <span style="font-family:ui-monospace,monospace;font-size:8px;letter-spacing:0.15em;text-transform:uppercase;color:${WARNING_HEX};">BODY · 14D</span>
        ${wtDeltaStr ? `<span style="font-family:ui-monospace,monospace;font-size:9px;color:${wtDeltaColor};">${wtDeltaStr}</span>` : ''}
      </div>
      <div style="display:flex;align-items:baseline;gap:4px;margin-bottom:4px;">
        <span style="font-size:26px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;">${currentWt !== null ? currentWt.toFixed(1) : '—'}</span>
        <span style="font-family:ui-monospace,monospace;font-size:9px;color:var(--text-tertiary);">kg</span>
      </div>
      ${bodyChartSvg}
    </div>
  </div>

  <!-- D. Hydration logging strip -->
  <div class="gm-card hlth-water-quick" style="padding:10px 14px;margin-bottom:10px;border:1px solid rgba(91,184,245,0.2);"><span style="font-family:ui-monospace,monospace;font-size:10px;text-transform:uppercase;letter-spacing:0.12em;color:#5BB8F5;white-space:nowrap;">+ WATER</span>${[150, 250, 330, 500, 750].map(v => `<button class="hlth-water-quick-chip" style="border:1px dashed #5BB8F5;color:#5BB8F5;" onclick="waterAddAmount(${v})">${v}ml</button>`).join('')}<button class="hlth-water-undo-btn" onclick="waterUndo()" title="Undo last drink">↩</button></div>

  <!-- E. Supplement matrix -->
  <div class="gm-card" style="padding:12px 14px 14px;margin-bottom:10px;border:1px solid rgba(107,227,164,0.2);">
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;">
      <span style="font-family:ui-monospace,monospace;font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:${SUCCESS_HEX};">SUPPLEMENT MATRIX · ${suppTakenCount}/${suppTotalCount}</span>
      <span style="font-family:ui-monospace,monospace;font-size:9px;color:var(--text-tertiary);">NEXT ${nextSessTime}</span>
    </div>
    <div class="hlth-supp-matrix-grid" style="padding:0 2px 6px;border-bottom:1px dashed rgba(255,255,255,0.08);margin-bottom:2px;">
      <span></span>
      <span style="font-family:ui-monospace,monospace;font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-tertiary);display:block;text-align:center;">AM</span>
      <span style="font-family:ui-monospace,monospace;font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-tertiary);display:block;text-align:center;">LUNCH</span>
      <span style="font-family:ui-monospace,monospace;font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-tertiary);display:block;text-align:center;">PM</span>
    </div>
    ${suppCfg.supplements.length > 0 ? suppRowsHtml : '<div style="font-size:13px;color:var(--text-tertiary);padding:10px 0;">No supplements configured — add some via ⚙️</div>'}
  </div>`;
}

// ── Whoop Health Section v2 ─────────────────────────────────
function renderWhoopHealthSection() {
  const el = document.getElementById('whoopHealthSection');
  if (!el) return;

  const S = '#6BE3A4', W = '#F2C063', D = '#FF6B6B', B = '#5BB8F5';

  const rec    = whoopCache.recovery;
  const cycle  = whoopCache.cycle;
  const sleep0 = whoopCache.sleep?.[0];

  const score    = rec?.score?.recovery_score     ?? null;
  const hrv      = rec?.score?.hrv_rmssd_milli    ?? null;
  const rhr      = rec?.score?.resting_heart_rate ?? null;
  const rr       = rec?.score?.respiratory_rate   ?? sleep0?.score?.respiratory_rate ?? null;
  const skinTemp = rec?.score?.skin_temp_celsius  ?? null;
  const strain   = cycle?.score?.strain           ?? null;
  const avgHr    = cycle?.score?.average_heart_rate ?? null;

  const recPrev = whoopCache.recoveryPrev;
  const prevHrv = recPrev?.score?.hrv_rmssd_milli    ?? null;
  const prevRhr = recPrev?.score?.resting_heart_rate ?? null;

  const scoreHex = score !== null ? (score >= 67 ? S : score >= 34 ? W : D) : '#555';
  const tagline  = score !== null ? (score >= 67 ? 'Primed' : score >= 34 ? 'Moderate' : 'Drained') : '—';
  const syncTime = whoopLastSync
    ? whoopLastSync.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—';

  // Sleep
  const stg  = sleep0?.score?.stage_summary ?? {};
  const remMs  = stg.total_rem_sleep_time_milli        ?? 0;
  const deepMs = stg.total_slow_wave_sleep_time_milli  ?? 0;
  const ltMs   = stg.total_light_sleep_time_milli      ?? 0;
  const totSlp = remMs + deepMs + ltMs;
  const sleepPerf = sleep0?.score?.sleep_performance_percentage ?? null;
  const slpH   = totSlp ? Math.floor(totSlp / 3600000) : null;
  const slpM   = totSlp ? Math.round((totSlp % 3600000) / 60000) : null;
  const slpCmp = totSlp ? `${slpH}h${String(slpM).padStart(2,'0')}` : '—';

  const sl1 = whoopCache.sleep?.[1];
  const ps  = sl1 ? (() => { const g = sl1.score?.stage_summary ?? {}; return (g.total_rem_sleep_time_milli??0)+(g.total_slow_wave_sleep_time_milli??0)+(g.total_light_sleep_time_milli??0); })() : null;
  const sdH = (totSlp && ps) ? ((totSlp - ps) / 3600000) : null;
  const sdC = sdH !== null ? (sdH >= 0 ? S : D) : 'var(--text-tertiary)';
  const sdS = sdH !== null ? `${sdH >= 0 ? '+' : ''}${sdH.toFixed(1)}h` : '';

  // Sleep debt
  const TGT = 8 * 3600000;
  const DLBL = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
  const debtData = (whoopCache.sleep || []).slice(0, 7).map(s => {
    const g = s.score?.stage_summary ?? {};
    const d = (g.total_rem_sleep_time_milli??0)+(g.total_slow_wave_sleep_time_milli??0)+(g.total_light_sleep_time_milli??0);
    return { debt: Math.max(0, TGT - d), label: DLBL[(s.start ? new Date(s.start) : new Date()).getDay()] };
  }).reverse();
  const totDebt  = debtData.reduce((a, b) => a + b.debt, 0);
  const debtH    = Math.floor(totDebt / 3600000);
  const debtMin  = Math.round((totDebt % 3600000) / 60000);
  const debtStr  = totDebt > 0 ? `-${debtH}h ${debtMin}m` : '0h';
  const debtTkr  = (totDebt / 3600000).toFixed(1);
  const maxDebt  = Math.max(...debtData.map(d => d.debt), 1);

  // Strain history
  const cyHist  = whoopCache.cycleHistory || (cycle ? [cycle] : []);
  const strVals = cyHist.map(c => c.score?.strain ?? null).filter(x => x !== null);
  const strAvg  = strVals.length > 1 ? (strVals.reduce((a,b)=>a+b,0)/strVals.length).toFixed(1) : null;
  const strPrev = cyHist[1]?.score?.strain ?? null;
  const strDlt  = (strain !== null && strPrev !== null) ? strain - strPrev : null;
  const strDS   = strDlt !== null ? `${strDlt>=0?'+':''}${strDlt.toFixed(1)}` : '';
  const strDC   = strDlt !== null ? (strDlt >= 0 ? S : D) : 'var(--text-tertiary)';

  // 14-day trend
  const recHist = (whoopCache.recoveryHistory || [])
    .filter(r => r.score?.recovery_score != null).slice(0, 14).reverse();
  const trendChg = recHist.length >= 2
    ? Math.round(recHist[recHist.length-1].score.recovery_score - recHist[0].score.recovery_score) : null;
  const trendArr = trendChg !== null ? (trendChg >= 0 ? '↑' : '↓') : '';
  const trendCol = W; // delta chip is always amber per design
  let trendSvg = `<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:11px;color:var(--text-tertiary);">Trend builds over time</div>`;
  if (recHist.length >= 2) {
    const sc = recHist.map(r => r.score.recovery_score);
    const mn = Math.min(...sc), mx = Math.max(...sc), rng = Math.max(mx - mn, 5);
    const TW = 160, TH = 80, xSt = TW / (sc.length - 1);
    const yF = v => TH - 6 - ((v - mn) / rng) * (TH - 16);
    let pd = `M 0 ${yF(sc[0]).toFixed(1)}`;
    sc.forEach((v, i) => { if (i > 0) pd += ` L ${(i*xSt).toFixed(1)} ${yF(v).toFixed(1)}`; });
    const lx = ((sc.length-1)*xSt).toFixed(1), ly = yF(sc[sc.length-1]).toFixed(1);
    const lc = S; // trend line always mint green regardless of direction
    trendSvg = `<svg viewBox="0 0 ${TW} ${TH}" preserveAspectRatio="none" style="width:100%;height:100%;"><defs><linearGradient id="tg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${lc}" stop-opacity="0.18"/><stop offset="100%" stop-color="${lc}" stop-opacity="0"/></linearGradient></defs><path d="${pd} L ${lx} ${TH} L 0 ${TH} Z" fill="url(#tg)"/><path d="${pd}" fill="none" stroke="${lc}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${lx}" cy="${ly}" r="3.5" fill="${lc}"/></svg>`;
  }

  // Recovery ring — 170px wrapper, thin 6px stroke
  const RR2 = 76, CX2 = 90, CY2 = 90;
  const CIRC2 = +(2 * Math.PI * RR2).toFixed(2);
  const filled = score !== null ? +(CIRC2 * score / 100).toFixed(2) : 0;
  const ringSvg = `<svg viewBox="0 0 180 180" style="width:100%;height:100%;"><circle cx="${CX2}" cy="${CY2}" r="${RR2}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="6"/><circle cx="${CX2}" cy="${CY2}" r="${RR2}" fill="none" stroke="${scoreHex}" stroke-width="6" stroke-dasharray="${CIRC2}" stroke-dashoffset="${(CIRC2-filled).toFixed(2)}" stroke-linecap="round" transform="rotate(-90 ${CX2} ${CY2})"/></svg>`;

  // Sparkline helper
  function spk(vals, color) {
    const v = vals.filter(x => x != null);
    if (v.length < 2) return '';
    const mn2 = Math.min(...v), mx2 = Math.max(...v), r2 = Math.max(mx2-mn2, 0.01);
    const SW = 36, SH = 12;
    const pts = v.map((val,i) => `${(i/(v.length-1)*SW).toFixed(1)},${(SH-(val-mn2)/r2*SH).toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 ${SW} ${SH}" style="width:36px;height:12px;display:inline-block;vertical-align:middle;" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  const slpSpk = spk((whoopCache.sleep||[]).slice(0,7).map(s=>{ const g=s.score?.stage_summary??{}; return ((g.total_rem_sleep_time_milli??0)+(g.total_slow_wave_sleep_time_milli??0)+(g.total_light_sleep_time_milli??0))/3600000; }).reverse(), sdC||S);
  const strSpk = spk(strVals.slice(0,7).reverse(), strDC||W);

  const bpm = avgHr !== null ? Math.round(avgHr) : (rhr !== null ? Math.round(rhr) : null);

  // Tips
  const tips = [];
  if (score !== null) {
    if      (score < 34) tips.push(`Recovery ${Math.round(score)}%. Your ceiling is lower today — save intensity for when you're recovered.`);
    else if (score < 67) tips.push(`Recovery ${Math.round(score)}% — moderate day. Balance focused work with adequate rest.`);
    else                 tips.push(`Recovery ${Math.round(score)}% — you're primed. Front-load your hardest training or deep work.`);
  }
  if (slpH !== null && slpH < 7)                     tips.push(`Only ${slpH}h ${slpM}m last night — aim for 7–9h. Try an earlier bedtime tonight.`);
  if (hrv !== null && hrv < 40)                       tips.push(`HRV at ${Math.round(hrv)}ms is low — try 5 min of box breathing (4s in · 4s hold · 4s out) before bed.`);
  if (hrv !== null && prevHrv !== null && hrv < prevHrv * 0.85) tips.push(`HRV dropped ${Math.round(prevHrv - hrv)}ms vs yesterday — signs of under-recovery or stress.`);
  if (rhr !== null && rhr > 65)                       tips.push(`RHR of ${Math.round(rhr)}bpm is elevated — lighter activity, extra hydration, and earlier sleep recommended.`);
  if (totDebt > 10 * 3600000)                         tips.push(`${debtStr} sleep debt over 7 nights — adding 30 min per night via earlier bedtime will help.`);
  if (rr !== null && rr > 18)                         tips.push(`Resp rate ${rr.toFixed(1)}/min is elevated — monitor for illness signs over the next 48h.`);
  if (tips.length === 0) tips.push('All metrics look good — keep your current sleep and recovery routines.');

  const connected = whoopConnected;
  // Build ticker items once, then double inside .wh-ticker-scroll for seamless marquee loop
  const _tkGap = `<span style="display:inline-block;width:48px;flex-shrink:0;"></span>`;
  const _tkItems =
    (bpm !== null ? `<div class="wh-tk-item"><span class="wh-tk-val" style="color:${bpm>80?W:S}">${bpm}</span><span class="wh-tk-unit">bpm</span></div><span class="wh-ticker-sep">|</span>` : '') +
    `<div class="wh-tk-item"><span class="wh-tk-lbl">SLP</span>&nbsp;<span class="wh-tk-val">${slpCmp}</span>${slpSpk}${sdS?`<span class="wh-tk-delta" style="color:${sdC}">${sdS}</span>`:''}</div>` +
    `<span class="wh-ticker-sep">|</span>` +
    `<div class="wh-tk-item"><span class="wh-tk-lbl">STR</span>&nbsp;<span class="wh-tk-val">${strain!==null?strain.toFixed(1):'—'}</span>${strSpk}${strDS?`<span class="wh-tk-delta" style="color:${strDC}">${strDS}</span>`:''}</div>` +
    `<span class="wh-ticker-sep">|</span>` +
    `<div class="wh-tk-item"><span class="wh-tk-lbl">DBT</span>&nbsp;<span class="wh-tk-val" style="color:${totDebt>0?D:S}">${totDebt>0?`-${debtTkr}`:'0'}</span><span class="wh-tk-unit">h</span></div>` +
    _tkGap;
  const heroHtml = connected ? `
  <div class="wh-ticker">
    <div class="wh-ticker-pulse"></div>
    <span class="wh-ticker-brand">LIVE</span>
    <span class="wh-ticker-sep">|</span>
    <div class="wh-ticker-items"><div class="wh-ticker-scroll">${_tkItems}${_tkItems}</div></div>
    <span class="wh-ticker-sync">⟳ ${syncTime}</span>
  </div>
  <div class="wh-hero-card">
    <div class="wh-ring-wrap">${ringSvg}<div class="wh-ring-center"><div class="wh-ring-num" style="color:${scoreHex}">${score!==null?Math.round(score):'—'}</div>${score!==null?'<div class="wh-ring-pct">%</div>':''}<div class="wh-ring-label">RECOVERY</div><div class="wh-ring-tagline" style="color:${scoreHex}">${tagline}</div></div></div>
    <div class="wh-trend-area"><div class="wh-trend-hdr"><span class="wh-trend-title">14-day trend</span>${trendChg!==null?`<span style="font-size:12px;font-weight:700;color:${trendCol}">${trendArr} ${Math.abs(trendChg)}</span>`:''}</div><div style="flex:1;min-height:80px;">${trendSvg}</div></div>
  </div>
  <div class="wh-stats-grid">
    <div class="wh-stat-card"><span class="wh-stat-lbl">SLEEP</span><div class="wh-stat-val">${slpH!==null?`${slpH}<span class="wh-stat-unit">h</span>&nbsp;${slpM}<span class="wh-stat-unit">m</span>`:'<span style="color:var(--text-tertiary)">—</span>'}</div><div class="wh-stat-sub">${sleepPerf!==null?Math.round(sleepPerf)+'% efficiency':'—'}</div></div>
    <div class="wh-stat-card"><span class="wh-stat-lbl">STRAIN</span><div class="wh-stat-val">${strain!==null?strain.toFixed(1):'<span style="color:var(--text-tertiary)">—</span>'}</div><div class="wh-stat-sub">today</div>${strAvg!==null?`<span class="wh-stat-chip">wk avg ${strAvg}</span>`:''}</div>
    <div class="wh-stat-card" onclick="hlthShowMetricInfo('HRV')" style="cursor:pointer;"><span class="wh-stat-lbl">HRV</span><div class="wh-stat-val">${hrv!==null?`${Math.round(hrv)}<span class="wh-stat-unit">ms</span>`:'<span style="color:var(--text-tertiary)">—</span>'}</div><div class="wh-stat-sub">rmssd</div></div>
    <div class="wh-stat-card" onclick="hlthShowMetricInfo('RHR')" style="cursor:pointer;"><span class="wh-stat-lbl">RHR</span><div class="wh-stat-val">${rhr!==null?`${Math.round(rhr)}<span class="wh-stat-unit">bpm</span>`:'<span style="color:var(--text-tertiary)">—</span>'}</div><div class="wh-stat-sub">resting</div></div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
    <div class="wh-stat-card" onclick="hlthShowMetricInfo('RR')" style="cursor:pointer;padding:10px 12px;"><span class="wh-stat-lbl">RESP RATE</span><div style="font-family:var(--font-display-serif);font-size:28px;font-weight:500;line-height:1.2;font-variant-numeric:tabular-nums;">${rr!==null?`${rr.toFixed(1)}<span style="font-size:11px;color:var(--text-tertiary);font-weight:400;font-family:ui-sans-serif,system-ui,sans-serif;">/min</span>`:'<span style="color:var(--text-tertiary)">—</span>'}</div><div class="wh-stat-sub">during sleep</div></div>
    <div class="wh-stat-card" onclick="hlthShowMetricInfo('SKIN')" style="cursor:pointer;padding:10px 12px;"><span class="wh-stat-lbl">SKIN TEMP</span><div style="font-family:var(--font-display-serif);font-size:28px;font-weight:500;line-height:1.2;font-variant-numeric:tabular-nums;">${skinTemp!==null?`${skinTemp.toFixed(1)}<span style="font-size:11px;color:var(--text-tertiary);font-weight:400;font-family:ui-sans-serif,system-ui,sans-serif;">°C</span>`:'<span style="color:var(--text-tertiary)">—</span>'}</div><div class="wh-stat-sub">wrist surface</div></div>
  </div>
  <div class="wh-debt-card">
    <div class="wh-debt-hdr"><span class="wh-debt-title">Sleep debt</span><span><span class="wh-debt-total">${debtStr}</span><span class="wh-debt-sub"> last 7 nights</span></span></div>
    <div class="wh-debt-bars">${debtData.map(d => { const bH=Math.round((d.debt/maxDebt)*64)+6; const bc=d.debt>2*3600000?D:d.debt>0?W:S; return `<div class="wh-debt-bar-wrap"><div class="wh-debt-bar-inner"><div class="wh-debt-bar" style="height:${bH}px;background:linear-gradient(180deg,${bc} 0%,${bc}8C 100%);opacity:${d.debt>0?0.9:0.2};"></div></div><span class="wh-debt-day">${d.label}</span></div>`; }).join('')}</div>
  </div>
  <div class="wh-tips-card"><div class="wh-tips-title">How to improve today</div>${tips.map(t=>`<div class="wh-tip-row"><span class="wh-tip-dot">✦</span><span class="wh-tip-text">${t}</span></div>`).join('')}</div>
  ` : `
  <div class="wh-connect-card">
    <div class="wh-connect-title">Connect Whoop</div>
    <div class="wh-connect-sub">${whoopCache.reauth?'Session expired — reconnect to resume.':whoopCache.connectError?'Connection failed. Please try again.':'Link your Whoop to see recovery, sleep &amp; strain data.'}</div>
    <button class="whoop-connect-btn" onclick="whoopStartAuth()">${whoopCache.reauth?'Reconnect Whoop':'Connect Whoop'}</button>
  </div>
  `;

  el.innerHTML = heroHtml + (connected ? `<div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:16px;"><button class="whoop-reconnect-btn" onclick="whoopStartAuth()">Reconnect</button><button class="whoop-reconnect-btn" style="color:var(--danger);border-color:rgba(255,107,107,0.2);" onclick="whoopDisconnect()">Disconnect</button></div>` : '');
  renderHydrationPanel();
  renderRecoveryTips();
}

function renderRecoveryTips() {
  const el = document.getElementById('recoveryTipsCard');
  if (!el) return;

  try {
    const bridge = JSON.parse(localStorage.getItem('patron_health_v1') || 'null');
    if (!bridge || !bridge.connected) { el.style.display = 'none'; return; }

    const rec    = bridge.recovery;
    const hrv    = bridge.hrv;
    const rhr    = bridge.rhr;
    const sleep  = bridge.sleepHours;
    const sleepP = bridge.sleepPerf;

    const tips = [];

    if (rec != null) {
      if (rec < 34)      tips.push({ icon: '🔴', text: '<b>Full rest day recommended.</b> Your body is in active recovery. Avoid high-intensity training.' });
      else if (rec < 50) tips.push({ icon: '🟡', text: '<b>Light activity only.</b> Zone 2 cardio or mobility work — nothing that spikes heart rate significantly.' });
      else if (rec < 67) tips.push({ icon: '🟡', text: '<b>Moderate training okay.</b> Stick to your planned session but cap intensity — leave 2 reps in the tank on every set.' });
      else               tips.push({ icon: '🟢', text: '<b>Primed for performance.</b> Good day for a max effort session or new PR attempt.' });
    }

    if (hrv != null) {
      if (hrv < 35)      tips.push({ icon: '⚡', text: 'HRV is very low (' + hrv + 'ms). Cut caffeine by midday and consider an early bedtime tonight.' });
      else if (hrv < 55) tips.push({ icon: '⚡', text: 'HRV is below your baseline (' + hrv + 'ms). Avoid late caffeine and prioritise sleep.' });
    }

    if (rhr != null) {
      if (rhr > 65)      tips.push({ icon: '❤️', text: 'Resting HR is elevated at ' + rhr + ' bpm — could indicate fatigue, illness, or dehydration. Drink extra water today.' });
    }

    if (sleepP != null && sleepP < 60) {
      tips.push({ icon: '😴', text: 'Sleep performance was only ' + Math.round(sleepP) + '%. Front-load demanding cognitive work before 2pm today.' });
    } else if (sleep != null && sleep < 6) {
      tips.push({ icon: '😴', text: 'Only ' + sleep.toFixed(1) + ' hours of sleep. Avoid making major decisions this afternoon — reaction time and focus are impaired.' });
    }

    if (!tips.length) { el.style.display = 'none'; return; }

    el.style.display = '';
    el.innerHTML = '<div class="rec-tips-title">Today\'s Readiness Notes</div>'
      + tips.map(t => '<div class="rec-tip-row"><span class="rec-tip-icon">' + t.icon + '</span><span class="rec-tip-text">' + t.text + '</span></div>').join('');
  } catch (e) { el.style.display = 'none'; }
}

// ── Hydration + Supplement panel ────────────────────────────
function renderHydrationPanel() {
  const el = document.getElementById('hydrationPanel');
  if (!el) return;
  const S = '#6BE3A4', W = '#F2C063', D = '#FF6B6B', B = '#5BB8F5';

  const wd    = waterLoad();
  const wTot  = wd.entries.reduce((a,e) => a + e.amount, 0);
  const wGoal = waterGetGoal() || 2500;
  const wIL   = (wTot/1000).toFixed(1), wGL = (wGoal/1000).toFixed(1);
  const wPct  = Math.min(wTot/wGoal, 1);

  const strain = whoopCache.cycle?.score?.strain ?? null;
  let wStrain = '';
  if (strain !== null) { wStrain = `+${Math.round(strain*35)}ml strain`; }
  else { try { const gs = loadGymState(); if (gs.workoutDone && gs.workoutDone[getActiveDateString()]) wStrain = '+500ml training'; } catch {} }

  const wte        = wtLoad().slice().sort((a,b) => a.dateKey < b.dateKey ? -1 : 1);
  const wtUnits    = loadGymState().units || 'kg';
  const wtToday    = gymToday();
  const wtTodayEnt = wte.find(e => e.dateKey === wtToday);
  const curWt      = wte.length ? wte[wte.length-1].weight : null;

  const fH = Math.max(Math.round(wPct*42), 0);
  const btl = `<svg viewBox="0 0 50 64" style="width:38px;height:58px;"><path d="M16 4 L34 4 L34 12 L40 18 L40 60 L10 60 L10 18 L16 12 Z" fill="none" stroke="${B}" stroke-width="1.5"/><rect id="hlthBottleFillRect" x="11" y="${60-fH}" width="28" height="${fH}" fill="${B}" opacity="0.32"/>${[22,30,38,46,54].map(y=>`<line x1="38" y1="${y}" x2="40" y2="${y}" stroke="${B}" stroke-width="0.8"/>`).join('')}</svg>`;

  const sCfg = storeGet('supp_config') || { supplements: [], times: { morning: '08:00', lunch: '13:00', night: '22:00' } };
  const sTkn = storeGet(`supp_taken:${getActiveDateString()}`) || {};
  let sTkC = 0, sTtC = 0;
  sCfg.supplements.forEach(s => { ['morning','lunch','night'].forEach(sess => { if (s.sessions.includes(sess)) { sTtC++; if (sTkn[`${s.id}:${sess}`]) sTkC++; } }); });
  const nM  = new Date().getHours()*60 + new Date().getMinutes();
  let nxS = null;
  for (const sess of ['morning','lunch','night']) { const [h,m]=(sCfg.times[sess]||'08:00').split(':').map(Number); if(h*60+m>nM){nxS=sCfg.times[sess];break;} }
  if (!nxS) nxS = sCfg.times.morning;
  const cdot = (sid, sess, sessions) => {
    if (!sessions.includes(sess)) return `<span style="display:block;text-align:center;font-size:13px;line-height:1;color:rgba(255,255,255,0.15);">·</span>`;
    const it = !!sTkn[`${sid}:${sess}`];
    return `<button onclick="hlthSuppToggle('${sid}','${sess}')" style="display:block;width:100%;text-align:center;background:none;border:none;cursor:pointer;padding:5px 0;font-size:18px;line-height:1;color:${it?S:'var(--text-tertiary)'};">${it?'●':'○'}</button>`;
  };
  const sRows = sCfg.supplements.map((s,i) => `<div class="hlth-supp-matrix-grid" style="padding:7px 2px;${i<sCfg.supplements.length-1?'border-bottom:1px dashed rgba(255,255,255,0.08);':''}"><span style="font-size:13px;color:var(--text-primary);">${s.name}</span>${cdot(s.id,'morning',s.sessions)}${cdot(s.id,'lunch',s.sessions)}${cdot(s.id,'night',s.sessions)}</div>`).join('');

  el.innerHTML = `
  <div class="gm-card" style="padding:10px;margin-bottom:10px;border:1px solid rgba(91,184,245,0.2);">
    <span style="font-family:ui-monospace,monospace;font-size:8px;letter-spacing:0.15em;text-transform:uppercase;color:${B};display:block;margin-bottom:6px;">HYDRATION</span>
    <div style="display:flex;flex-direction:column;align-items:center;gap:4px;">${btl}<div style="text-align:center;"><div id="hlthBottleAmountText" style="font-size:16px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;">${wIL} / ${wGL} L</div>${wStrain?`<div style="font-family:ui-monospace,monospace;font-size:8px;color:var(--text-tertiary);margin-top:2px;">${wStrain}</div>`:''}</div></div>
    <div class="hlth-water-quick" style="padding-top:12px;border-top:1px dashed rgba(255,255,255,0.08);"><span style="font-family:ui-monospace,monospace;font-size:10px;text-transform:uppercase;letter-spacing:0.12em;color:${B};white-space:nowrap;">+ WATER</span>${[150,250,330,500,750].map(v=>`<button class="hlth-water-quick-chip" style="border:1px dashed ${B};color:${B};" onclick="waterAddAmount(${v})">${v}ml</button>`).join('')}<button class="hlth-water-undo-btn" onclick="waterUndo()" title="Undo last drink">↩</button></div>
    <div class="hlth-water-history" id="hlthWaterHistory"></div>
  </div>
  <div class="gm-card wt-card" style="margin-bottom:10px;">
    <span style="font-family:ui-monospace,monospace;font-size:9px;letter-spacing:0.15em;text-transform:uppercase;color:${W};display:block;margin-bottom:14px;">BODY WEIGHT</span>
    <div class="wt2-hero-num-row">
      <span class="wt2-hero-num" id="wtNum">${curWt !== null ? curWt.toFixed(1) : '—'}</span>
      <span class="wt2-hero-unit" id="wtUnitSpan">${wtUnits}</span>
    </div>
    <div class="wt2-chip-row">
      <span id="wt2DeltaChip"></span>
      <span class="wt-streak" id="wtStreak" style="display:none;"></span>
    </div>
    <div class="wt2-chart-wrap">
      <div class="wt2-y-axis" id="wt2YAxis"><span></span><span></span></div>
      <svg class="wt2-chart" id="wtChart" viewBox="0 0 300 150" preserveAspectRatio="none"></svg>
    </div>
    <div class="wt2-chart-meta" id="wt2ChartMeta"></div>
    <div class="wt2-chart-legend">
      <span class="wt2-legend-item"><span class="wt2-legend-line"></span>DAILY</span>
      <span class="wt2-legend-item"><span class="wt2-legend-avg"></span>7-DAY AVG</span>
    </div>
    <div id="wtForm" class="wt-form" ${wtTodayEnt ? 'style="display:none;"' : ''}>
      <input id="wtIn" class="wt-in" type="number" min="0" step="0.1" placeholder="0.0">
      <span class="wt-unit-lbl" id="wtInUnit">${wtUnits}</span>
      <button id="wtSaveBtn" class="wt-save-btn">Save</button>
    </div>
    <div id="wtLocked" class="wt2-locked" ${wtTodayEnt ? '' : 'style="display:none;"'}>
      <div class="wt2-locked-left">
        <div class="wt2-locked-check">✓</div>
        <div>
          <div class="wt2-locked-lbl">LOGGED TODAY</div>
          <div class="wt2-locked-val" id="wtLockedTxt">${wtTodayEnt ? wtTodayEnt.weight.toFixed(1) + ' ' + wtUnits : '—'}</div>
        </div>
      </div>
      <button id="wtLockedEdit" class="wt2-edit-btn">Edit</button>
    </div>
    <span id="wtDelta" class="wt-delta" style="display:none;"></span>
    <button class="wt-photos-btn" id="wtPhotosBtn" style="margin-top:12px;">
      📷 <span>Progress Photos</span><span class="wt-photos-arr">›</span>
    </button>
  </div>
  <div id="suppRecoveryBanner" style="padding:10px 14px;margin-bottom:10px;border-radius:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);display:none;"></div>
  <div class="gm-card" style="padding:12px 14px 14px;margin-bottom:10px;border:1px solid rgba(107,227,164,0.2);">
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;"><span style="font-family:ui-monospace,monospace;font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:${S};">SUPPLEMENT MATRIX · ${sTkC}/${sTtC}</span><span style="font-family:ui-monospace,monospace;font-size:9px;color:var(--text-tertiary);">NEXT ${nxS}</span></div>
    <div class="hlth-supp-matrix-grid" style="padding:0 2px 6px;border-bottom:1px dashed rgba(255,255,255,0.08);margin-bottom:2px;"><span></span><span style="font-family:ui-monospace,monospace;font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-tertiary);display:block;text-align:center;">AM</span><span style="font-family:ui-monospace,monospace;font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-tertiary);display:block;text-align:center;">LUNCH</span><span style="font-family:ui-monospace,monospace;font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-tertiary);display:block;text-align:center;">PM</span></div>
    ${sCfg.supplements.length > 0 ? sRows : '<div style="font-size:13px;color:var(--text-tertiary);padding:10px 0;">No supplements configured — add some via ⚙️</div>'}
  </div>
  `;
  wtInit();
  suppRecoveryBanner();
}

function suppRecoveryBanner() {
  const el = document.getElementById('suppRecoveryBanner');
  if (!el) return;
  try {
    const bridge = JSON.parse(localStorage.getItem('patron_health_v1') || 'null');
    if (!bridge || !bridge.connected) { el.style.display = 'none'; return; }

    const rec = bridge.recovery;
    const hrv = bridge.hrv;

    let msg = null;
    let color = '#6BE3A4';

    if (rec != null && rec < 34) {
      msg = '⚠️ Low recovery today (' + Math.round(rec) + '%) — prioritise magnesium glycinate and ashwagandha tonight.';
      color = '#FF6B6B';
    } else if (rec != null && rec < 67) {
      msg = '⚡ Moderate recovery (' + Math.round(rec) + '%) — consider L-theanine with caffeine and omega-3 with dinner.';
      color = '#F2C063';
    } else if (rec != null && rec >= 67) {
      msg = '✅ Good recovery (' + Math.round(rec) + '%) — all systems go. Stay on your usual stack.';
      color = '#6BE3A4';
    }

    if (hrv != null && hrv < 40 && rec != null && rec >= 34) {
      msg = (msg || '') + ' HRV is low (' + hrv + 'ms) — avoid stimulants after 2pm.';
    }

    if (!msg) { el.style.display = 'none'; return; }

    el.style.display = '';
    el.innerHTML = '<span style="font-size:12px;color:' + color + ';line-height:1.5;">' + msg + '</span>';
  } catch (e) { el.style.display = 'none'; }
}

// ── Metric info modal ───────────────────────────────────────
const HLTH_METRIC_INFO = {
  HRV: {
    name: 'Heart Rate Variability',
    color: '#6BE3A4',
    what: 'The variation in time between consecutive heartbeats, measured in milliseconds during sleep.',
    determines: 'Readiness to train and autonomic nervous system balance. Higher HRV means your body is well-recovered and adapting positively to training stress.',
    good: 'Highly individual — your trend matters more than the number. Typical healthy range: 50–100 ms. Athletes often see 80 ms+. A rising trend over weeks is the goal.',
    improve: 'Consistent sleep schedule · Build aerobic base · Breathing / meditation practice · Limit alcohol · Stay hydrated · Avoid overtraining',
  },
  RHR: {
    name: 'Resting Heart Rate',
    color: '#FF6B6B',
    what: 'Your heart rate at rest, measured during sleep. Reflects how efficiently your heart pumps blood.',
    determines: 'Cardiovascular fitness and recovery status. An elevated RHR can signal fatigue, illness, dehydration, or under-recovery.',
    good: '40–60 bpm for athletes; 60–80 bpm for most healthy adults. Lower is generally better — it means your heart works less per day at rest.',
    improve: 'Regular cardio exercise · Healthy body weight · Quality sleep · Stress reduction · Limit caffeine & alcohol · Stay hydrated',
  },
  RR: {
    name: 'Respiratory Rate',
    color: '#5BB8F5',
    what: 'Breaths per minute during sleep — one of the most sensitive early-warning health metrics available.',
    determines: 'Illness onset (infections raise RR before other symptoms), sleep quality, and inflammatory load. Watch for consecutive nights of elevated readings.',
    good: '14–18 breaths/min during sleep. Below 12 or sustained above 20 warrants attention. A spike of 2+ above your baseline can flag incoming illness.',
    improve: 'Diaphragmatic breathing practice · Nasal breathing · Maintain healthy weight · Avoid alcohol near bedtime · Treat sleep apnoea if relevant',
  },
  SKIN: {
    name: 'Skin Temperature',
    color: '#F2C063',
    what: 'Surface skin temperature at the wrist measured during sleep. Best read as a deviation from your personal baseline.',
    determines: 'Illness early detection (fever appears as a sustained rise), hormonal cycle phases, and environmental sleep conditions. Not directly improved but used as a signal.',
    good: 'Varies by person — typically 33–36 °C at the wrist. Deviations of +0.5 °C above your personal baseline over multiple nights may signal illness or systemic stress.',
    improve: 'Cool sleep environment (16–19 °C) · Avoid alcohol before bed (raises skin temp) · Manage stress · Investigate if RR also rises simultaneously',
  },
};

function hlthShowMetricInfo(key) {
  const info = HLTH_METRIC_INFO[key];
  if (!info) return;
  const overlay = document.getElementById('hlthMetricInfoOverlay');
  if (!overlay) return;
  overlay.querySelector('#hlthMetricInfoName').textContent  = info.name;
  overlay.querySelector('#hlthMetricInfoName').style.color  = info.color;
  overlay.querySelector('#hlthMetricInfoWhat').textContent  = info.what;
  overlay.querySelector('#hlthMetricInfoDet').textContent   = info.determines;
  overlay.querySelector('#hlthMetricInfoGood').textContent  = info.good;
  overlay.querySelector('#hlthMetricInfoImp').textContent   = info.improve;
  overlay.style.display = 'flex';
  requestAnimationFrame(() => overlay.classList.add('open'));
}

function hlthHideMetricInfo() {
  const overlay = document.getElementById('hlthMetricInfoOverlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  overlay.addEventListener('transitionend', () => { overlay.style.display = 'none'; }, { once: true });
}

// ── Gym tab Whoop banner ────────────────────────────────────
function renderWhoopGymBanner() {
  const el = document.getElementById('whoopGymBanner');
  if (!el) return;
  if (!whoopConnected) {
    el.innerHTML = `<div class="gm-card whoop-gym-banner-v2" onclick="whoopStartAuth()" style="justify-content:center;text-align:center;">
      <div><div style="font-size:13px;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">Connect Whoop</div>
      <div style="font-size:11px;color:var(--text-tertiary);">Recovery data &amp; strain tracking</div></div>
    </div>`;
    return;
  }

  const score  = whoopCache.recovery?.score?.recovery_score ?? null;
  const strain = whoopCache.cycle?.score?.strain            ?? null;
  const hrv    = whoopCache.recovery?.score?.hrv_rmssd_milli ?? null;

  let statusText = '—', statusColor = 'var(--text-secondary)', arrow = '→';
  if (score !== null) {
    if (score >= 67)      { statusText = 'PRIMED · GO HARD';       statusColor = 'var(--success)'; arrow = '↗'; }
    else if (score >= 34) { statusText = 'MODERATE · TRAIN SMART'; statusColor = 'var(--warning)'; arrow = '→'; }
    else                  { statusText = 'RESTORE · TAKE IT EASY'; statusColor = 'var(--danger)';  arrow = '↘'; }
  }
  const scoreColor = score !== null ? recoveryColor(score) : 'var(--text-secondary)';
  const CIRC = 2 * Math.PI * 20;
  const dash  = score !== null ? (CIRC * score / 100).toFixed(2) : '0';

  const subParts = [];
  if (strain !== null) subParts.push(`strain target ${strain.toFixed(1)}`);
  subParts.push(`HRV ${arrow}`);

  el.innerHTML = `
    <div class="gm-card whoop-gym-banner-v2" onclick="switchTab('health')">
      <div class="wgb-left">
        <svg class="wgb-score-ring" viewBox="0 0 48 48">
          <circle cx="24" cy="24" r="20" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="4"/>
          <circle cx="24" cy="24" r="20" fill="none" stroke="${scoreColor}" stroke-width="4"
            stroke-dasharray="${dash} ${CIRC.toFixed(2)}" stroke-linecap="round"
            transform="rotate(-90 24 24)"/>
          <text x="24" y="29" text-anchor="middle" font-size="14" font-weight="800" fill="${scoreColor}">${score !== null ? Math.round(score) : '—'}</text>
        </svg>
      </div>
      <div class="wgb-mid">
        <div class="wgb-status" style="color:${statusColor}">${statusText}</div>
        <div class="wgb-sub">${subParts.join(' · ')}</div>
      </div>
      <div class="wgb-arrow" style="color:${statusColor}">${arrow}</div>
    </div>`;
}

// ── Gym tab Whoop workout history ───────────────────────────
function renderWhoopGymHistory() {
  const el = document.getElementById('whoopGymHistory');
  if (!el) return;
  el.innerHTML = '';
  if (!whoopConnected || !whoopCache.workout?.length) return;

  const toggle = document.createElement('button');
  toggle.className = 'po-hist-toggle';
  toggle.textContent = 'Via Whoop';
  const body = document.createElement('div');
  body.style.display = 'none';
  toggle.addEventListener('click', () => {
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    toggle.classList.toggle('open', !open);
  });

  whoopCache.workout.forEach(w => {
    const sport  = whoopSportName(w.sport_id);
    const dur    = (w.end && w.start) ? Math.round((new Date(w.end)-new Date(w.start))/60000) : null;
    const ws     = w.score?.strain ?? null;
    const wHr    = w.score?.average_heart_rate ?? null;
    const wCal   = w.score?.kilojoule ? Math.round(w.score.kilojoule*0.239) : null;
    const dateStr= w.start ? new Date(w.start).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}) : '';

    const card = document.createElement('div');
    card.className = 'po-hist-day-card whoop-hist-card';
    card.innerHTML = `
      <div class="po-hist-day-hdr">
        <span class="po-hist-day-date">${sport}</span>
        <span style="font-family:ui-monospace,monospace;font-size:10px;background:rgba(107,227,164,0.10);color:#6BE3A4;border-radius:5px;padding:2px 7px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Via Whoop</span>
        <span class="po-hist-day-sum" style="flex:1;text-align:right;">${dateStr}</span>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
        ${dur  !== null ? `<div class="po-stat-chip"><span class="po-stat-lbl">Duration</span><span class="po-stat-val">${dur}m</span></div>` : ''}
        ${ws   !== null ? `<div class="po-stat-chip"><span class="po-stat-lbl">Strain</span><span class="po-stat-val">${ws.toFixed(1)}</span></div>` : ''}
        ${wHr  !== null ? `<div class="po-stat-chip"><span class="po-stat-lbl">Avg HR</span><span class="po-stat-val">${Math.round(wHr)}</span></div>` : ''}
        ${wCal !== null ? `<div class="po-stat-chip"><span class="po-stat-lbl">Cal</span><span class="po-stat-val">${wCal}</span></div>` : ''}
      </div>`;
    body.appendChild(card);
  });

  el.appendChild(toggle);
  el.appendChild(body);
}

// ── Whoop auth / connect / disconnect ──────────────────────
function whoopStartAuth() {
  if (!currentUser) return;
  window.location.href = `/api/whoop-auth?userId=${encodeURIComponent(currentUser.id)}`;
}

async function whoopDisconnect() {
  if (!currentUser || !db) return;
  if (!confirm('Disconnect Whoop? Your token will be removed.')) return;
  const { error } = await db.from('whoop_tokens').delete().eq('user_id', currentUser.id);
  if (!error) {
    whoopConnected  = false;
    whoopCache = { cycle: null, recovery: null, sleep: [], workout: [], vo2max: null, reauth: false, connectError: false };
    renderWhoopWidgets();
  }
}

// ── Whoop init (called from bootApp) ───────────────────────
async function initWhoop() {
  const urlParams = new URLSearchParams(location.search);
  const urlError  = urlParams.get('error');

  // Read pending Whoop code from localStorage (survives any intermediate auth redirects).
  // Reject entries older than 5 minutes — Whoop codes expire quickly.
  let code, state;
  try {
    const _p = JSON.parse(localStorage.getItem('_whoop_pending') || 'null');
    if (_p && _p.ts && Date.now() - _p.ts < 300_000) { code = _p.code; state = _p.userId; }
  } catch { /* ignore */ }
  localStorage.removeItem('_whoop_pending');

  if (code && state) {
    history.replaceState(null, '', location.pathname);
    switchTab('health');
    try {
      const res  = await fetch('/api/whoop-callback', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ code, userId: state }),
      });
      const data = await res.json();
      if (!data.success) {
        whoopCache.connectError = true;
        if (data.error === 'code_expired') {
          whoopCache.connectError = true;
          renderWhoopWidgets();
          return;
        }
      }
    } catch {
      whoopCache.connectError = true;
    }
    await loadWhoopData(state);
    renderWhoopHealthSection();
    return;
  }

  if (urlError) {
    whoopCache.connectError = true;
    history.replaceState(null, '', location.pathname);
  }

  // Initial route from the URL hash — deep links / reload, e.g. #health or #health/body
  const hashStr    = location.hash.slice(1);
  const qIdx       = hashStr.indexOf('?');
  const hashPath   = qIdx >= 0 ? hashStr.slice(0, qIdx) : hashStr;
  const hashParams = new URLSearchParams(qIdx >= 0 ? hashStr.slice(qIdx + 1) : '');
  if (hashParams.get('whoop_error') === 'true') whoopCache.connectError = true;
  const seg = hashPath.split('/');
  if (seg[0] && document.getElementById('page-' + seg[0])) {
    applyTab(seg[0], seg[1] || null);
    // Normalise to a clean tab hash (drops any ?whoop_error=true query)
    try { history.replaceState(null, '', '#' + seg[0] + (seg[1] ? '/' + seg[1] : '')); } catch (e) {}
  } else if (location.hash) {
    history.replaceState(null, '', location.pathname);
  }

  loadWhoopData();
}

// ── Nutrition Page (Health tab) ─────────────────────────────
const NUTR_DATA_KEY = 'nutritionData';

const NUTR_ALL_MICROS = [
  // Vitamins
  { key:'vitA',        sym:'vA',  name:'Vit A',         unit:'µg',    dailyValue:900,   category:'vitamins',   color:'#C47FE8' },
  { key:'vitC',        sym:'vC',  name:'Vit C',         unit:'mg',    dailyValue:90,    category:'vitamins',   color:'#F08E7A' },
  { key:'vitD',        sym:'vD',  name:'Vit D',         unit:'µg',    dailyValue:20,    category:'vitamins',   color:'#F2C063' },
  { key:'vitE',        sym:'vE',  name:'Vit E',         unit:'mg',    dailyValue:15,    category:'vitamins',   color:'#F2A063' },
  { key:'vitK',        sym:'vK',  name:'Vit K',         unit:'µg',    dailyValue:120,   category:'vitamins',   color:'#76E8A0' },
  { key:'vitB1',       sym:'B1',  name:'Thiamine',      unit:'mg',    dailyValue:1.2,   category:'vitamins',   color:'#9AA8E8' },
  { key:'vitB2',       sym:'B2',  name:'Riboflavin',    unit:'mg',    dailyValue:1.3,   category:'vitamins',   color:'#9AA8E8' },
  { key:'vitB3',       sym:'B3',  name:'Niacin',        unit:'mg',    dailyValue:16,    category:'vitamins',   color:'#9AA8E8' },
  { key:'vitB6',       sym:'B6',  name:'Vit B6',        unit:'mg',    dailyValue:1.7,   category:'vitamins',   color:'#6BE3A4' },
  { key:'folate',      sym:'B9',  name:'Folate',        unit:'µg',    dailyValue:400,   category:'vitamins',   color:'#8AB6E8' },
  { key:'vitB12',      sym:'B12', name:'Vit B12',       unit:'µg',    dailyValue:2.4,   category:'vitamins',   color:'#9AA8E8' },
  // Minerals
  { key:'calcium',     sym:'Ca',  name:'Calcium',       unit:'mg',    dailyValue:1000,  category:'minerals',   color:'#9AA8E8' },
  { key:'iron',        sym:'Fe',  name:'Iron',          unit:'mg',    dailyValue:18,    category:'minerals',   color:'#FF6B6B' },
  { key:'magnesium',   sym:'Mg',  name:'Magnesium',     unit:'mg',    dailyValue:420,   category:'minerals',   color:'#6BE3A4' },
  { key:'potassium',   sym:'K',   name:'Potassium',     unit:'mg',    dailyValue:3500,  category:'minerals',   color:'#F2C063' },
  { key:'zinc',        sym:'Zn',  name:'Zinc',          unit:'mg',    dailyValue:11,    category:'minerals',   color:'#6BE3A4' },
  { key:'sodium',      sym:'Na',  name:'Sodium',        unit:'mg',    dailyValue:2300,  category:'minerals',   color:'#F08E7A' },
  { key:'iodine',      sym:'I',   name:'Iodine',        unit:'µg',    dailyValue:150,   category:'minerals',   color:'#F2C063' },
  { key:'selenium',    sym:'Se',  name:'Selenium',      unit:'µg',    dailyValue:55,    category:'minerals',   color:'#B29EE8' },
  { key:'copper',      sym:'Cu',  name:'Copper',        unit:'mg',    dailyValue:0.9,   category:'minerals',   color:'#F2A063' },
  // Fibre
  { key:'fibreTotal',  sym:'Fb',  name:'Total Fibre',   unit:'g',     dailyValue:28,    category:'fibre',      color:'#76E8A0' },
  { key:'fibreSol',    sym:'sFb', name:'Soluble Fibre', unit:'g',     dailyValue:10,    category:'fibre',      color:'#6BE3A4' },
  { key:'fibreInsol',  sym:'iFb', name:'Insol. Fibre',  unit:'g',     dailyValue:18,    category:'fibre',      color:'#6BE3A4' },
  // Omega & other
  { key:'omega3',      sym:'ω3',  name:'Omega-3',       unit:'g',     dailyValue:1.6,   category:'other',      color:'#B29EE8' },
  // Probiotics
  { key:'probiotics',  sym:'Pro', name:'Probiotics',    unit:'B CFU', dailyValue:10,    category:'probiotics', color:'#F08E7A' },
];
let nutrGapsWindow = 14;

// Returns the % of daily goal reached for a specific micro on a specific date.
// Returns null if the day has no meals logged with micro data for this key.
function nutrGapsDayPct(data, key, dateStr) {
  const micro = NUTR_ALL_MICROS.find(m => m.key === key);
  if (!micro) return null;
  const dayMeals = (data.meals[dateStr] || []).filter(m => !m.planned);
  const hasMicroData = dayMeals.some(m => m.micros && m.micros[key] != null);
  if (!hasMicroData) return null;
  const total = dayMeals.reduce((sum, m) => sum + ((m.micros && m.micros[key]) || 0), 0);
  return micro.dailyValue > 0 ? Math.min(200, Math.round((total / micro.dailyValue) * 100)) : 0;
}

// Builds an array of {dateStr, pct} for the past windowDays days (oldest first).
function nutrGapsBuildHistory(data, key, windowDays) {
  const today = getActiveDateString();
  const [ty, tm, td] = today.split('-').map(Number);
  const base = new Date(ty, tm - 1, td);
  const days = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    const y  = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dy = String(d.getDate()).padStart(2, '0');
    days.push({ dateStr: `${y}-${mo}-${dy}`, pct: nutrGapsDayPct(data, key, `${y}-${mo}-${dy}`) });
  }
  return days;
}

// Returns an inline style string for a spark block based on % achieved.
// null = no data (grey). <40 = red. 40–79 = orange. ≥80 = green.
function nutrSparkBlockStyle(pct) {
  if (pct === null) return 'background:rgba(255,255,255,0.1)';
  if (pct < 40)    return `background:#FF6B6B;opacity:${(0.65 + (pct / 40) * 0.35).toFixed(2)}`;
  if (pct < 80)    return `background:#F2A063;opacity:${(0.55 + ((pct - 40) / 40) * 0.45).toFixed(2)}`;
  return               `background:#6BE3A4;opacity:${(0.5 + (Math.min(pct, 100) - 80) / 20 * 0.5).toFixed(2)}`;
}

const NUTR_MEAL_COLORS = {
  Breakfast: '#9AA8E8',
  Lunch:     '#FF6B6B',
  Snack:     '#6BE3A4',
  Dinner:    '#76746E',
};

function loadNutritionData() {
  const defaultTracked = ['iron','vitD','vitB12','magnesium','omega3','fibreTotal','calcium','potassium'];
  const defaultGaps    = ['iron','vitD','omega3','fibreTotal'];
  try {
    const raw = localStorage.getItem(NUTR_DATA_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      d.targets       = d.targets       || { calories: 2400, protein: 180, carbs: 260, fat: 75 };
      d.meals         = d.meals         || {};
      d.microHistory  = d.microHistory  || {};
      d.trackedMicros = d.trackedMicros || defaultTracked;
      d.gapsMicros    = d.gapsMicros    || defaultGaps;
      return d;
    }
  } catch {}
  return { targets: { calories: 2400, protein: 180, carbs: 260, fat: 75 }, meals: {}, microHistory: {}, trackedMicros: defaultTracked, gapsMicros: defaultGaps };
}

function saveNutritionData(data) {
  localStorage.setItem(NUTR_DATA_KEY, JSON.stringify(data));
}

function nutritionTodayKey() { return getActiveDateString(); }

function nutritionTodayTotals(data) {
  const meals = (data.meals[nutritionTodayKey()] || []).filter(m => !m.planned);
  return meals.reduce((a, m) => {
    const micros = { ...a.micros };
    if (m.micros) {
      NUTR_ALL_MICROS.forEach(micro => {
        if (m.micros[micro.key]) micros[micro.key] = (micros[micro.key] || 0) + m.micros[micro.key];
      });
    }
    return {
      calories: a.calories + (m.calories || 0),
      protein:  a.protein  + (m.protein  || 0),
      carbs:    a.carbs    + (m.carbs    || 0),
      fat:      a.fat      + (m.fat      || 0),
      micros,
    };
  }, { calories: 0, protein: 0, carbs: 0, fat: 0, micros: {} });
}


function nutritionMicroCoverage(data) {
  const totals   = nutritionTodayTotals(data);
  const tracked  = NUTR_ALL_MICROS.filter(m => (data.trackedMicros || []).includes(m.key));
  const tiles    = tracked.map(t => {
    const amount = totals.micros[t.key] || 0;
    const pct    = t.dailyValue > 0 ? Math.min(200, Math.round((amount / t.dailyValue) * 100)) : 0;
    return { ...t, pct, amount };
  });
  const onTrack  = tiles.filter(t => t.pct >= 60).length;
  const lowCount = tiles.filter(t => t.pct < 60).length;
  const total    = tiles.length;
  const pct      = total > 0 ? Math.round(onTrack / total * 100) : 0;
  return { tiles, onTrack, total, lowCount, pct };
}

// ── Nutrition redesign helpers ──────────────────────────────
function nutrEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

const NUTR_MEAL_CATS = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];

// Resolve a meal into one of the four meal-type buckets.
function nutrMealCategory(meal) {
  if (meal && meal.category && NUTR_MEAL_CATS.includes(meal.category)) return meal.category;
  const n = ((meal && meal.name) || '').toLowerCase();
  if (/break|brekkie|oat|cereal|porridge/.test(n)) return 'Breakfast';
  if (/lunch/.test(n)) return 'Lunch';
  if (/dinner|supper/.test(n)) return 'Dinner';
  if (/snack/.test(n)) return 'Snack';
  const h = parseInt(((meal && meal.time) || '12:00').split(':')[0], 10);
  if (isNaN(h) || h < 11) return isNaN(h) ? 'Snack' : 'Breakfast';
  if (h < 15) return 'Lunch';
  if (h < 18) return 'Snack';
  return 'Dinner';
}

function nutrDefaultCatByTime() {
  const h = new Date().getHours();
  if (h < 11) return 'Breakfast';
  if (h < 15) return 'Lunch';
  if (h < 18) return 'Snack';
  return 'Dinner';
}

// A day "counts" toward the streak if protein hit ≥90% of target.
function nutrDayHit(data, dateStr) {
  const meals = (data.meals[dateStr] || []).filter(m => !m.planned);
  if (!meals.length) return false;
  const tp = (data.targets && data.targets.protein) || 0;
  if (tp <= 0) return false;
  const pro = meals.reduce((s, m) => s + (m.protein || 0), 0);
  return pro >= tp * 0.9;
}

function nutrComputeStreak(data) {
  const [ty, tm, td] = getActiveDateString().split('-').map(Number);
  const base = new Date(ty, tm - 1, td);
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // Don't break the streak just because today isn't finished yet.
  let streak = 0;
  const start = nutrDayHit(data, fmt(base)) ? 0 : 1;
  for (let i = start; i < 400; i++) {
    const d = new Date(base); d.setDate(d.getDate() - i);
    if (nutrDayHit(data, fmt(d))) streak++; else break;
  }
  return streak;
}

// Update one macro mini-ring + its value/target labels.
function nutrSetMacroArc(arcId, pctId, valId, tgtId, value, target, unit) {
  const v = Math.round(value || 0), t = Math.round(target || 0);
  const ratio = t > 0 ? value / t : 0;
  const arc = document.getElementById(arcId);
  if (arc) { const C = 125.66; arc.style.strokeDashoffset = (C * (1 - Math.min(1, ratio))).toFixed(2); }
  const p = document.getElementById(pctId); if (p) p.textContent = Math.round(ratio * 100) + '%';
  const valEl = document.getElementById(valId); if (valEl) valEl.textContent = v;
  const tgtEl = document.getElementById(tgtId); if (tgtEl) tgtEl.textContent = '/' + t + unit;
}

// Build the quick-add list from saved templates + recently logged foods.
function nutrQuickAddItems(data) {
  const items = [], seen = new Set();
  let tpls = [];
  try { tpls = JSON.parse(localStorage.getItem('nutr_templates') || '[]'); } catch {}
  tpls.slice().sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0)).forEach(t => {
    const key = (t.name || '').trim().toLowerCase();
    if (!t.name || seen.has(key)) return; seen.add(key);
    items.push({ name: t.name, cal: t.cal || 0, pro: t.pro || 0, carb: t.carb || 0, fat: t.fat || 0, desc: t.desc || '' });
  });
  const dates = Object.keys(data.meals || {}).sort().reverse();
  for (const d of dates) {
    const ms = (data.meals[d] || []).slice().reverse();
    for (const m of ms) {
      const key = (m.name || '').trim().toLowerCase();
      if (!m.name || seen.has(key)) continue; seen.add(key);
      items.push({ name: m.name, cal: m.calories || 0, pro: m.protein || 0, carb: m.carbs || 0, fat: m.fat || 0, desc: m.description || '', micros: m.micros });
      if (items.length >= 12) break;
    }
    if (items.length >= 12) break;
  }
  return items.slice(0, 12);
}

function nutrQuickLog(item) {
  const data = loadNutritionData(), today = nutritionTodayKey();
  if (!data.meals[today]) data.meals[today] = [];
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  data.meals[today].push({
    id: crypto.randomUUID(), name: item.name, description: item.desc || '', time,
    calories: item.cal || 0, protein: item.pro || 0, carbs: item.carb || 0, fat: item.fat || 0,
    planned: false, category: nutrDefaultCatByTime(), micros: item.micros || {}
  });
  data.meals[today].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  saveNutritionData(data);
  renderNutrition();
}

function nutrRenderQuickAdd(data) {
  const row = document.getElementById('nutrQaRow');
  if (!row) return;
  const items = nutrQuickAddItems(data);
  row.innerHTML = '';
  if (!items.length) {
    row.innerHTML = '<div class="nutr-qa-empty">No recent foods yet — log a meal or save a template to quick-add it next time.</div>';
    return;
  }
  items.forEach(it => {
    const chip = document.createElement('button');
    chip.className = 'nutr-qa-chip'; chip.type = 'button';
    chip.title = 'Tap to log ' + it.name;
    chip.innerHTML = `<span class="nutr-qa-name">${nutrEsc(it.name)}</span><span class="nutr-qa-cal"><b>+ ${Math.round(it.cal)}</b> kcal</span>`;
    chip.addEventListener('click', () => nutrQuickLog(it));
    row.appendChild(chip);
  });
}

function nutrWeightSpark(recent) {
  if (recent.length < 2) return '<div class="nutr-wt-spark"></div>';
  const W = 160, H = 42, p = 5;
  const vals = recent.map(e => e.weight);
  const lo = Math.min(...vals), hi = Math.max(...vals), range = Math.max(hi - lo, 0.3);
  const pts = recent.map((e, i) => {
    const x = p + (i / (recent.length - 1)) * (W - 2 * p);
    const y = p + (1 - (e.weight - lo) / range) * (H - 2 * p);
    return [x, y];
  });
  const line = pts.map((pt, i) => (i ? 'L' : 'M') + pt[0].toFixed(1) + ' ' + pt[1].toFixed(1)).join(' ');
  const area = line + ` L ${pts[pts.length - 1][0].toFixed(1)} ${H - p} L ${pts[0][0].toFixed(1)} ${H - p} Z`;
  const last = pts[pts.length - 1];
  return `<svg class="nutr-wt-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="nutrWtG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(87,224,161,0.28)"/><stop offset="1" stop-color="rgba(87,224,161,0)"/></linearGradient></defs>
    <path d="${area}" fill="url(#nutrWtG)"/>
    <path d="${line}" fill="none" stroke="var(--success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.6" fill="var(--success)"/>
  </svg>`;
}

function nutrRenderWeightCard() {
  const card = document.getElementById('nutrWeightCard');
  if (!card) return;
  let entries = [];
  try { entries = (typeof wtLoad === 'function' ? (wtLoad() || []) : []).slice().sort((a, b) => a.dateKey < b.dateKey ? -1 : 1); } catch {}
  if (entries.length < 1) { card.style.display = 'none'; return; }
  card.style.display = '';
  const units = (typeof loadGymState === 'function' ? (loadGymState().units || 'kg') : 'kg');
  const latest = entries[entries.length - 1];
  let deltaHtml = '';
  if (entries.length >= 2) {
    const cutoff = new Date(latest.dateKey); cutoff.setDate(cutoff.getDate() - 7);
    const inWin = entries.filter(e => new Date(e.dateKey) >= cutoff);
    const ref = inWin.length >= 2 ? inWin[0] : entries[entries.length - 2];
    const diff = latest.weight - ref.weight;
    if (Math.abs(diff) > 0.05) {
      const dn = diff < 0;
      deltaHtml = `<span class="nutr-wt-delta ${dn ? 'down' : 'up'}">${dn ? '↓' : '↑'}${Math.abs(diff).toFixed(1)}</span>`;
    } else {
      deltaHtml = '<span class="nutr-wt-delta flat">±0</span>';
    }
  }
  card.innerHTML = `
    <div class="nutr-wt-l">
      <span class="nutr-wt-lbl">Weight</span>
      <span><span class="nutr-wt-val">${latest.weight.toFixed(1)}</span><span class="nutr-wt-unit">${units}</span></span>
    </div>
    ${nutrWeightSpark(entries.slice(-30))}
    ${deltaHtml}`;
}

function nutrRenderMicroCard(data) {
  const cov = nutritionMicroCoverage(data);
  const pctEl = document.getElementById('nutrMcPct'); if (pctEl) pctEl.textContent = cov.pct + '%';
  const subEl = document.getElementById('nutrMcSub');
  if (subEl) subEl.innerHTML = `${cov.onTrack}/${cov.total} on track${cov.lowCount ? ` · <span class="nutr-mc-low">${cov.lowCount} low</span>` : ''}`;
  const barEl = document.getElementById('nutrMcBar');
  if (barEl) {
    barEl.innerHTML = '';
    if (!cov.tiles.length) { barEl.innerHTML = '<div class="nutr-mc-seg"></div>'; return; }
    cov.tiles.forEach(t => {
      const seg = document.createElement('div'); seg.className = 'nutr-mc-seg';
      const c = t.pct >= 80 ? 'var(--success)' : t.pct >= 60 ? '#F2C063' : t.pct >= 40 ? '#F2A063' : 'var(--danger)';
      seg.style.background = t.amount > 0 ? c : 'rgba(255,255,255,.08)';
      seg.title = `${t.name}: ${t.pct}%`;
      barEl.appendChild(seg);
    });
  }
}

// Render the chronic-gaps heatmap into a container (used by the micro hub).
function nutrRenderGapsInto(gapsEl, data) {
  if (!gapsEl) return;
  gapsEl.innerHTML = '';
  const gapsMicros = data.gapsMicros || [];
  if (!gapsMicros.length) {
    gapsEl.innerHTML = '<div class="nutr-empty" style="padding:6px 0">No nutrients selected — tap Edit to choose.</div>';
    return;
  }
  const legend = document.createElement('div');
  legend.className = 'nutr-gaps-legend';
  legend.innerHTML = `
    <div class="nutr-gaps-leg-item"><div class="nutr-gaps-leg-dot" style="background:#FF6B6B"></div>&lt;40%</div>
    <div class="nutr-gaps-leg-item"><div class="nutr-gaps-leg-dot" style="background:#F2A063"></div>40–79%</div>
    <div class="nutr-gaps-leg-item"><div class="nutr-gaps-leg-dot" style="background:#6BE3A4"></div>≥80%</div>
    <div class="nutr-gaps-leg-item"><div class="nutr-gaps-leg-dot" style="background:rgba(255,255,255,0.15)"></div>no data</div>`;
  gapsEl.appendChild(legend);
  gapsMicros.forEach(key => {
    const micro = NUTR_ALL_MICROS.find(m => m.key === key);
    if (!micro) return;
    const days = nutrGapsBuildHistory(data, key, nutrGapsWindow);
    const dataDays = days.filter(d => d.pct !== null);
    const avg = dataDays.length > 0 ? Math.round(dataDays.reduce((a, d) => a + d.pct, 0) / dataDays.length) : null;
    const isLow = avg !== null && avg < 80;
    const row = document.createElement('div'); row.className = 'nutr-spark-row';
    const blocks = days.map(d => `<div class="nutr-spark-block" style="${nutrSparkBlockStyle(d.pct)}" title="${d.dateStr}: ${d.pct !== null ? d.pct + '%' : 'no data'}"></div>`).join('');
    const avgText = avg !== null ? avg + '%' : '—';
    row.innerHTML = `
      <span class="nutr-spark-name ${isLow ? 'low' : avg === null ? 'none' : 'ok'}">${micro.name}</span>
      <div class="nutr-spark-blocks${nutrGapsWindow === 30 ? ' w30' : ''}">${blocks}</div>
      <span class="nutr-spark-avg ${isLow ? 'low' : avg === null ? 'none' : 'ok'}">${avgText}</span>`;
    gapsEl.appendChild(row);
  });
}

// Meal diary grouped into Breakfast / Lunch / Dinner / Snack.
function nutrRenderMealGroups(data, todayMeals) {
  const wrap = document.getElementById('nutrMealGroups');
  if (!wrap) return;
  const lcEl = document.getElementById('nutrLoggedCount');
  const pcEl = document.getElementById('nutrPlannedCount');
  if (lcEl) lcEl.textContent = todayMeals.filter(m => !m.planned).length;
  if (pcEl) pcEl.textContent = todayMeals.filter(m => m.planned).length;

  const GROUPS = [
    { cat: 'Breakfast', color: '#9AA8E8' },
    { cat: 'Lunch',     color: '#F2818A' },
    { cat: 'Dinner',    color: '#C47FE8' },
    { cat: 'Snack',     color: '#57E0A1' },
  ];
  const byCat = { Breakfast: [], Lunch: [], Dinner: [], Snack: [] };
  todayMeals.forEach(m => { (byCat[nutrMealCategory(m)] || byCat.Snack).push(m); });

  wrap.innerHTML = '';
  GROUPS.forEach(g => {
    const meals = byCat[g.cat].slice().sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    const subtotal = meals.filter(m => !m.planned).reduce((s, m) => s + (m.calories || 0), 0);
    const group = document.createElement('div');
    group.className = 'nutr-mg' + (meals.length ? '' : ' empty');

    const hdr = document.createElement('div');
    hdr.className = 'nutr-mg-hdr';
    hdr.innerHTML = `<span class="nutr-mg-dot" style="background:${g.color}"></span><span class="nutr-mg-name">${g.cat}</span><span class="nutr-mg-cal">${subtotal ? Math.round(subtotal).toLocaleString() + ' kcal' : '—'}</span>`;
    const addBtn = document.createElement('button');
    addBtn.className = 'nutr-mg-add'; addBtn.type = 'button';
    addBtn.setAttribute('aria-label', 'Add to ' + g.cat); addBtn.textContent = '+';
    addBtn.addEventListener('click', e => { e.stopPropagation(); openAddMealModal(g.cat); });
    hdr.appendChild(addBtn);
    group.appendChild(hdr);

    if (meals.length) {
      const list = document.createElement('div'); list.className = 'nutr-mg-list';
      meals.forEach(meal => {
        const row = document.createElement('div');
        row.className = 'nutr-meal-row' + (meal.planned ? ' planned' : '');
        row.setAttribute('role', 'button'); row.tabIndex = 0;
        const macros = [];
        if (meal.protein) macros.push('P' + Math.round(meal.protein));
        if (meal.carbs)   macros.push('C' + Math.round(meal.carbs));
        if (meal.fat)     macros.push('F' + Math.round(meal.fat));
        const title = meal.name || meal.description || g.cat;
        const showDesc = meal.description && meal.description !== title;
        row.innerHTML = `
          <div class="nutr-meal-main">
            <div class="nutr-meal-name${meal.planned ? ' planned' : ''}">${nutrEsc(title)}</div>
            <div class="nutr-meal-sub">${meal.time ? `<span>${meal.time}</span>` : ''}${macros.length ? `<span class="nutr-meal-macros">${macros.join(' · ')}</span>` : ''}${showDesc ? `<span>${nutrEsc(meal.description)}</span>` : ''}</div>
          </div>
          <div class="nutr-meal-cal"><span class="nutr-meal-cal-num">${meal.planned ? '~' : ''}${Math.round(meal.calories || 0)}</span><span class="nutr-meal-cal-unit">kcal</span></div>`;
        const open = () => openEditMealModal(meal.id);
        row.addEventListener('click', open);
        row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
        list.appendChild(row);
      });
      group.appendChild(list);
    } else {
      const empty = document.createElement('div');
      empty.className = 'nutr-mg-empty'; empty.textContent = 'Nothing logged yet';
      group.appendChild(empty);
    }
    wrap.appendChild(group);
  });
}

function renderNutrition() {
  const data    = loadNutritionData();
  const targets = data.targets;
  const totals  = nutritionTodayTotals(data);
  const today   = nutritionTodayKey();
  const todayMeals = data.meals[today] || [];

  // Eyebrow date
  const ebEl = document.getElementById('nutrEyebrow');
  if (ebEl) {
    const [dy, dm, dd] = getActiveDateString().split('-').map(Number);
    const d = new Date(dy, dm - 1, dd);
    const DAYS = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
    const MONS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    ebEl.textContent = `${DAYS[d.getDay()]} · ${MONS[d.getMonth()]} ${d.getDate()}`;
  }

  // Calorie ring hero
  const eaten = Math.round(totals.calories);
  const goal  = targets.calories || 0;
  const left  = goal - eaten;
  const over  = left < 0;
  const calPct = goal > 0 ? Math.min(100, (eaten / goal) * 100) : 0;
  const arc = document.getElementById('nutrRingArc');
  if (arc) {
    const C = 527.79;
    arc.style.strokeDashoffset = (C * (1 - calPct / 100)).toFixed(2);
    arc.classList.toggle('over', over);
  }
  const leftEl = document.getElementById('nutrCalLeft');
  if (leftEl) { leftEl.textContent = Math.abs(left).toLocaleString(); leftEl.classList.toggle('over', over); }
  const leftLblEl = document.getElementById('nutrCalLeftLbl');
  if (leftLblEl) leftLblEl.textContent = over ? 'kcal over' : 'kcal left';
  const eatenEl = document.getElementById('nutrCalEaten'); if (eatenEl) eatenEl.textContent = eaten.toLocaleString();
  const goalEl  = document.getElementById('nutrCalGoal');  if (goalEl)  goalEl.textContent  = goal.toLocaleString();

  // Macro mini-rings
  nutrSetMacroArc('nutrProArc',  'nutrProPct',  'nutrProVal',  'nutrProTgt',  totals.protein, targets.protein, 'g');
  nutrSetMacroArc('nutrCarbArc', 'nutrCarbPct', 'nutrCarbVal', 'nutrCarbTgt', totals.carbs,   targets.carbs,   'g');
  nutrSetMacroArc('nutrFatArc',  'nutrFatPct',  'nutrFatVal',  'nutrFatTgt',  totals.fat,     targets.fat,     'g');

  // Streak chip
  const streak = nutrComputeStreak(data);
  const streakNum = document.getElementById('nutrStreakNum');
  const streakChip = document.getElementById('nutrStreakChip');
  if (streakNum) streakNum.textContent = streak;
  if (streakChip) streakChip.classList.toggle('dim', streak === 0);

  nutrRenderQuickAdd(data);
  nutrRenderWeightCard();
  nutrRenderMicroCard(data);
  nutrRenderMealGroups(data, todayMeals);
}

function nutrSetActiveCat(cat) {
  document.querySelectorAll('#nutrMCatTog .nutr-cat-btn').forEach(b => b.classList.toggle('active', b.dataset.cat === cat));
}

function openAddMealModal(presetCat) {
  const modal = document.getElementById('nutrMealModal');
  if (!modal) return;
  document.getElementById('nutrMModalTitle').textContent = 'Log Meal';
  nutrSetActiveCat(NUTR_MEAL_CATS.includes(presetCat) ? presetCat : nutrDefaultCatByTime());
  document.getElementById('nutrMName').value  = '';
  document.getElementById('nutrMDesc').value  = '';
  document.getElementById('nutrMCal').value   = '';
  document.getElementById('nutrMPro').value   = '';
  document.getElementById('nutrMCarb').value  = '';
  document.getElementById('nutrMFat').value   = '';
  const now = new Date();
  document.getElementById('nutrMTime').value  = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  document.querySelectorAll('.nutr-planned-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.nutr-planned-btn[data-planned="false"]')?.classList.add('active');
  const delBtn = document.getElementById('nutrMDel');
  if (delBtn) delBtn.style.display = 'none';
  // Reset all micro inputs and collapse the advanced panel
  NUTR_ALL_MICROS.forEach(m => {
    const el = document.getElementById('nutrMicro_' + m.key);
    if (el) el.value = '';
  });
  const advPanel = document.getElementById('nutrAdvPanel');
  const advArrow = document.querySelector('.nutr-adv-arrow');
  if (advPanel) advPanel.style.display = 'none';
  if (advArrow) advArrow.textContent = '▼';
  modal._editId = null;
  document.body.style.overflow = 'hidden';
  modal.classList.remove('hidden');
}

function openEditMealModal(id) {
  const data  = loadNutritionData();
  const meals = data.meals[nutritionTodayKey()] || [];
  const meal  = meals.find(m => m.id === id);
  if (!meal) return;
  const modal = document.getElementById('nutrMealModal');
  if (!modal) return;
  document.getElementById('nutrMModalTitle').textContent = 'Edit Meal';
  nutrSetActiveCat(nutrMealCategory(meal));
  document.getElementById('nutrMName').value  = meal.name        || '';
  document.getElementById('nutrMDesc').value  = meal.description || '';
  document.getElementById('nutrMTime').value  = meal.time        || '';
  document.getElementById('nutrMCal').value   = meal.calories    || '';
  document.getElementById('nutrMPro').value   = meal.protein     || '';
  document.getElementById('nutrMCarb').value  = meal.carbs       || '';
  document.getElementById('nutrMFat').value   = meal.fat         || '';
  document.querySelectorAll('.nutr-planned-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.nutr-planned-btn[data-planned="${meal.planned ? 'true' : 'false'}"]`)?.classList.add('active');
  // Populate micro inputs
  NUTR_ALL_MICROS.forEach(m => {
    const el = document.getElementById('nutrMicro_' + m.key);
    if (el) el.value = (meal.micros && meal.micros[m.key]) ? meal.micros[m.key] : '';
  });
  // Auto-expand the advanced panel if meal has any micros logged
  const advPanel = document.getElementById('nutrAdvPanel');
  const advArrow = document.querySelector('.nutr-adv-arrow');
  const hasMicros = meal.micros && Object.values(meal.micros).some(v => v > 0);
  if (advPanel) advPanel.style.display = hasMicros ? '' : 'none';
  if (advArrow) advArrow.textContent = hasMicros ? '▲' : '▼';
  const delBtn = document.getElementById('nutrMDel');
  if (delBtn) delBtn.style.display = '';
  modal._editId = id;
  document.body.style.overflow = 'hidden';
  modal.classList.remove('hidden');
}

function closeAddMealModal() {
  document.body.style.overflow = '';
  document.getElementById('nutrMealModal')?.classList.add('hidden');
}

function submitMeal() {
  const name    = document.getElementById('nutrMName').value.trim();
  const desc    = document.getElementById('nutrMDesc').value.trim();
  const time    = document.getElementById('nutrMTime').value;
  const cal     = parseFloat(document.getElementById('nutrMCal').value)  || 0;
  const pro     = parseFloat(document.getElementById('nutrMPro').value)  || 0;
  const carb    = parseFloat(document.getElementById('nutrMCarb').value) || 0;
  const fat     = parseFloat(document.getElementById('nutrMFat').value)  || 0;
  const planned = document.querySelector('.nutr-planned-btn.active')?.dataset.planned === 'true';
  const category = document.querySelector('#nutrMCatTog .nutr-cat-btn.active')?.dataset.cat || nutrDefaultCatByTime();
  // Collect micro inputs
  const micros = {};
  NUTR_ALL_MICROS.forEach(m => {
    const el  = document.getElementById('nutrMicro_' + m.key);
    if (el) {
      const val = parseFloat(el.value);
      if (!isNaN(val) && val > 0) micros[m.key] = val;
    }
  });
  if (!name) { document.getElementById('nutrMName').focus(); return; }
  const data  = loadNutritionData();
  const today = nutritionTodayKey();
  if (!data.meals[today]) data.meals[today] = [];
  const modal  = document.getElementById('nutrMealModal');
  const editId = modal?._editId;
  if (editId) {
    const idx = data.meals[today].findIndex(m => m.id === editId);
    if (idx !== -1) data.meals[today][idx] = { ...data.meals[today][idx], name, description: desc, time, calories: cal, protein: pro, carbs: carb, fat, planned, category, micros };
  } else {
    data.meals[today].push({ id: crypto.randomUUID(), name, description: desc, time, calories: cal, protein: pro, carbs: carb, fat, planned, category, micros });
  }
  data.meals[today].sort((a, b) => a.time.localeCompare(b.time));
  saveNutritionData(data);
  closeAddMealModal();
  renderNutrition();
}

function deleteMeal(id) {
  const data  = loadNutritionData();
  const today = nutritionTodayKey();
  if (data.meals[today]) data.meals[today] = data.meals[today].filter(m => m.id !== id);
  saveNutritionData(data);
  closeAddMealModal();
  renderNutrition();
}

function renderNutrMicroSettings() {
  const data   = loadNutritionData();
  const listEl = document.getElementById('nutrMicroSettingsList');
  if (!listEl) return;
  listEl.innerHTML = '';
  const CATS = [
    { key: 'vitamins',   label: 'Vitamins' },
    { key: 'minerals',   label: 'Minerals' },
    { key: 'fibre',      label: 'Fibre' },
    { key: 'other',      label: 'Other' },
    { key: 'probiotics', label: 'Probiotics' },
  ];
  CATS.forEach(cat => {
    const micros = NUTR_ALL_MICROS.filter(m => m.category === cat.key);
    if (!micros.length) return;
    const catHdr = document.createElement('div');
    catHdr.className = 'nutr-micro-settings-cat-hdr';
    catHdr.textContent = cat.label.toUpperCase();
    listEl.appendChild(catHdr);
    micros.forEach(m => {
      const isOn = data.trackedMicros.includes(m.key);
      const item = document.createElement('div');
      item.className = 'nutr-micro-item';
      item.innerHTML = `
        <div class="nutr-micro-item-left">
          <span class="nutr-micro-item-sym" style="color:${m.color}">${m.sym}</span>
          <div>
            <span class="nutr-micro-item-name">${m.name}</span>
            <span class="nutr-micro-item-dv">${m.dailyValue}${m.unit}/day</span>
          </div>
        </div>
        <button class="nutr-micro-tog${isOn ? ' on' : ''}" aria-label="Toggle ${m.name}"></button>`;
      item.querySelector('.nutr-micro-tog').addEventListener('click', () => {
        const d = loadNutritionData();
        const idx = d.trackedMicros.indexOf(m.key);
        if (idx === -1) d.trackedMicros.push(m.key);
        else d.trackedMicros.splice(idx, 1);
        saveNutritionData(d);
        renderNutrMicroSettings();
        renderNutrition();
      });
      listEl.appendChild(item);
    });
  });
}

function renderNutrAllMicros() {
  const data   = loadNutritionData();
  const totals = nutritionTodayTotals(data);
  const cov    = nutritionMicroCoverage(data);
  const listEl = document.getElementById('nutrAllMicrosList');
  if (!listEl) return;
  const _r = 26, _C = 2 * Math.PI * _r, _off = _C * (1 - Math.min(100, cov.pct) / 100);
  listEl.innerHTML = `
    <div class="nutr-hub-summary">
      <div class="nutr-hub-ring">
        <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
          <circle cx="32" cy="32" r="${_r}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="6"/>
          <circle cx="32" cy="32" r="${_r}" fill="none" stroke="var(--success)" stroke-width="6" stroke-linecap="round" stroke-dasharray="${_C.toFixed(1)}" stroke-dashoffset="${_off.toFixed(1)}"/>
        </svg>
        <div class="nutr-hub-ring-pct">${cov.pct}%</div>
      </div>
      <div class="nutr-hub-summary-txt">
        <div class="nutr-hub-summary-h">${cov.onTrack} of ${cov.total} on track</div>
        <div class="nutr-hub-summary-s">${cov.total ? cov.lowCount + " below 60% of today's target" : 'Tap Edit tracked to pick nutrients to follow'}</div>
      </div>
    </div>
    <div class="nutr-hub-sect-hdr"><span class="nutr-hub-sect-title">Today &middot; all nutrients</span></div>
    <div id="nutrHubToday"></div>
    <div class="nutr-hub-sect-hdr">
      <span class="nutr-hub-sect-title" id="nutrGapsHdrLbl">Chronic gaps &middot; ${nutrGapsWindow}d</span>
      <span style="display:flex;gap:14px;align-items:center">
        <button class="nutr-hub-link" id="nutrGapsToggleBtn" type="button">${nutrGapsWindow === 14 ? '30d' : '14d'}</button>
        <button class="nutr-hub-link" id="nutrGapsEditBtn" type="button">Edit</button>
      </span>
    </div>
    <div class="nutr-gaps-card" id="nutrGapsCard"></div>`;
  const todayEl = document.getElementById('nutrHubToday');
  const CATS = [
    { key: 'vitamins',   label: 'Vitamins' },
    { key: 'minerals',   label: 'Minerals' },
    { key: 'fibre',      label: 'Fibre' },
    { key: 'other',      label: 'Other' },
    { key: 'probiotics', label: 'Probiotics' },
  ];
  CATS.forEach(cat => {
    const micros = NUTR_ALL_MICROS.filter(m => m.category === cat.key);
    if (!micros.length) return;
    const catHdr = document.createElement('div');
    catHdr.className = 'nutr-all-cat-hdr';
    catHdr.textContent = cat.label.toUpperCase();
    todayEl.appendChild(catHdr);
    micros
      .map(m => {
        const amount = totals.micros[m.key] || 0;
        const pct    = m.dailyValue > 0 ? Math.min(200, Math.round((amount / m.dailyValue) * 100)) : 0;
        return { ...m, pct, amount };
      })
      .sort((a, b) => a.pct - b.pct)
      .forEach(m => {
        const isLow  = m.pct < 60;
        const isOver = m.pct > 100;
        const amtStr = m.amount > 0
          ? m.amount.toFixed(m.unit === 'mg' || m.unit === 'g' ? 1 : 0) + ' ' + m.unit
          : '—';
        const row = document.createElement('div');
        row.className = 'nutr-all-row';
        row.innerHTML = `
          <span class="nutr-all-sym" style="color:${m.color}">${m.sym}</span>
          <div class="nutr-all-info">
            <div class="nutr-all-name">${m.name}</div>
            <div class="nutr-all-amount">${amtStr} / ${m.dailyValue} ${m.unit}</div>
            <div class="nutr-all-bar-wrap">
              <div class="nutr-all-bar" style="width:${Math.min(100,m.pct)}%;background:${isLow ? '#FF6B6B' : m.color}"></div>
            </div>
          </div>
          <span class="nutr-all-pct" style="color:${isLow ? 'var(--danger)' : isOver ? 'var(--success)' : 'var(--text-secondary)'}">${m.pct}%</span>`;
        todayEl.appendChild(row);
      });
  });

  // Chronic gaps heatmap (window toggle + edit live in the hub)
  nutrRenderGapsInto(document.getElementById('nutrGapsCard'), data);
  document.getElementById('nutrGapsToggleBtn')?.addEventListener('click', () => {
    nutrGapsWindow = nutrGapsWindow === 14 ? 30 : 14;
    renderNutrAllMicros();
  });
  document.getElementById('nutrGapsEditBtn')?.addEventListener('click', () => {
    renderNutrGapsSettings();
    document.getElementById('nutrGapsSettingsPanel')?.classList.add('open');
  });
}

function renderNutrGapsSettings() {
  const data   = loadNutritionData();
  const listEl = document.getElementById('nutrGapsSettingsList');
  if (!listEl) return;
  listEl.innerHTML = '';
  const CATS = [
    { key: 'vitamins',   label: 'Vitamins' },
    { key: 'minerals',   label: 'Minerals' },
    { key: 'fibre',      label: 'Fibre' },
    { key: 'other',      label: 'Other' },
    { key: 'probiotics', label: 'Probiotics' },
  ];
  // Info banner
  const info = document.createElement('div');
  info.className = 'nutr-gaps-settings-info';
  info.innerHTML = `
    <div class="nutr-gaps-settings-legend">
      <div class="nutr-gaps-leg-item"><div class="nutr-gaps-leg-dot" style="background:#FF6B6B"></div>Dangerously low &lt;40%</div>
      <div class="nutr-gaps-leg-item"><div class="nutr-gaps-leg-dot" style="background:#F2A063"></div>Slightly low 40–79%</div>
      <div class="nutr-gaps-leg-item"><div class="nutr-gaps-leg-dot" style="background:#6BE3A4"></div>On track ≥80%</div>
      <div class="nutr-gaps-leg-item"><div class="nutr-gaps-leg-dot" style="background:rgba(255,255,255,0.15)"></div>No data logged</div>
    </div>`;
  listEl.appendChild(info);
  CATS.forEach(cat => {
    const micros = NUTR_ALL_MICROS.filter(m => m.category === cat.key);
    if (!micros.length) return;
    const catHdr = document.createElement('div');
    catHdr.className = 'nutr-micro-settings-cat-hdr';
    catHdr.textContent = cat.label.toUpperCase();
    listEl.appendChild(catHdr);
    micros.forEach(m => {
      const isOn = (data.gapsMicros || []).includes(m.key);
      const item = document.createElement('div');
      item.className = 'nutr-micro-item';
      item.innerHTML = `
        <div class="nutr-micro-item-left">
          <span class="nutr-micro-item-sym" style="color:${m.color}">${m.sym}</span>
          <div>
            <span class="nutr-micro-item-name">${m.name}</span>
            <span class="nutr-micro-item-dv">${m.dailyValue} ${m.unit}/day</span>
          </div>
        </div>
        <button class="nutr-micro-tog${isOn ? ' on' : ''}" aria-label="Toggle ${m.name} in gaps"></button>`;
      item.querySelector('.nutr-micro-tog').addEventListener('click', () => {
        const d   = loadNutritionData();
        const arr = d.gapsMicros || [];
        const idx = arr.indexOf(m.key);
        if (idx === -1) arr.push(m.key); else arr.splice(idx, 1);
        d.gapsMicros = arr;
        saveNutritionData(d);
        renderNutrGapsSettings();
        renderNutrition();
      });
      listEl.appendChild(item);
    });
  });
}

function buildMicroAdvancedSection() {
  const container = document.getElementById('nutrAdvancedSection');
  if (!container) return;
  const CATS = [
    { key: 'vitamins',   label: '💊 Vitamins' },
    { key: 'minerals',   label: '⚗️ Minerals' },
    { key: 'fibre',      label: '🌾 Fibre' },
    { key: 'other',      label: '🐟 Omega-3' },
    { key: 'probiotics', label: '🦠 Probiotics' },
  ];
  container.innerHTML = `
    <button class="nutr-adv-toggle" id="nutrAdvToggle" type="button">
      <span>Micronutrients</span>
      <span class="nutr-adv-arrow">▼</span>
    </button>
    <div class="nutr-adv-panel" id="nutrAdvPanel" style="display:none">
      ${CATS.map(cat => {
        const micros = NUTR_ALL_MICROS.filter(m => m.category === cat.key);
        if (!micros.length) return '';
        return `
          <div class="nutr-adv-cat">
            <div class="nutr-adv-cat-hdr" data-cat="${cat.key}">
              <span>${cat.label}</span>
              <span class="nutr-adv-cat-chev">▼</span>
            </div>
            <div class="nutr-adv-cat-body" id="nutrAdvCat_${cat.key}">
              <div class="nutr-adv-cat-grid">
                ${micros.map(m => `
                  <div class="nutr-adv-in-wrap">
                    <label class="nutr-adv-lbl" for="nutrMicro_${m.key}">${m.name}<span class="nutr-adv-unit"> ${m.unit}</span><span class="nutr-adv-dv"> /${m.dailyValue}</span></label>
                    <input class="nutr-adv-in" type="number" min="0" step="any" placeholder="0" id="nutrMicro_${m.key}">
                  </div>
                `).join('')}
              </div>
            </div>
          </div>`;
      }).join('')}
    </div>`;
  // Toggle advanced panel
  container.querySelector('#nutrAdvToggle').addEventListener('click', () => {
    const panel = container.querySelector('#nutrAdvPanel');
    const arrow = container.querySelector('.nutr-adv-arrow');
    const hidden = panel.style.display === 'none';
    panel.style.display = hidden ? '' : 'none';
    if (arrow) arrow.textContent = hidden ? '▲' : '▼';
  });
  // Toggle individual category sub-sections
  container.querySelectorAll('.nutr-adv-cat-hdr').forEach(hdr => {
    hdr.addEventListener('click', () => {
      const body = document.getElementById('nutrAdvCat_' + hdr.dataset.cat);
      const chev = hdr.querySelector('.nutr-adv-cat-chev');
      if (!body) return;
      const hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      if (chev) chev.textContent = hidden ? '▼' : '▶';
    });
  });
}

// ── Daily calorie + macro goals ─────────────────────────────
function openGoalsPanel() {
  const t = loadNutritionData().targets || {};
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = (v != null ? v : ''); };
  set('nutrGoalCal',  t.calories);
  set('nutrGoalPro',  t.protein);
  set('nutrGoalCarb', t.carbs);
  set('nutrGoalFat',  t.fat);
  nutrUpdateGoalsHint();
  document.getElementById('nutrGoalsPanel')?.classList.add('open');
}

function nutrUpdateGoalsHint() {
  const hint = document.getElementById('nutrGoalsHint');
  if (!hint) return;
  const num = id => Math.max(0, parseFloat(document.getElementById(id)?.value) || 0);
  const cal = num('nutrGoalCal'), pro = num('nutrGoalPro'), carb = num('nutrGoalCarb'), fat = num('nutrGoalFat');
  const macroCal = Math.round(pro * 4 + carb * 4 + fat * 9);
  const diff = macroCal - cal;
  let tail = '';
  if (cal) {
    if (Math.abs(diff) <= 20)   tail = ' — matches your calorie goal';
    else if (diff > 0)          tail = ` — <span class="over">${diff.toLocaleString()} over</span> your ${cal.toLocaleString()} kcal goal`;
    else                        tail = ` — ${Math.abs(diff).toLocaleString()} under your ${cal.toLocaleString()} kcal goal`;
  }
  hint.innerHTML = `Macros add up to <b>${macroCal.toLocaleString()} kcal</b>${tail}`;
}

function saveGoals() {
  const data = loadNutritionData();
  const t = data.targets || {};
  const num = (id, fallback) => { const v = parseFloat(document.getElementById(id)?.value); return (isNaN(v) || v < 0) ? fallback : Math.round(v); };
  data.targets = {
    calories: num('nutrGoalCal',  t.calories || 2400),
    protein:  num('nutrGoalPro',  t.protein  || 180),
    carbs:    num('nutrGoalCarb', t.carbs    || 260),
    fat:      num('nutrGoalFat',  t.fat      || 75),
  };
  saveNutritionData(data);
  document.getElementById('nutrGoalsPanel')?.classList.remove('open');
  renderNutrition();
}

function resetGoals() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('nutrGoalCal', 2400); set('nutrGoalPro', 180); set('nutrGoalCarb', 260); set('nutrGoalFat', 75);
  nutrUpdateGoalsHint();
}

function initNutritionPage() {
  buildMicroAdvancedSection();
  // Daily goals editor
  document.getElementById('nutrGoalsBtn')?.addEventListener('click', openGoalsPanel);
  document.getElementById('nutrGoalsBack')?.addEventListener('click', () => document.getElementById('nutrGoalsPanel')?.classList.remove('open'));
  document.getElementById('nutrGoalsSave')?.addEventListener('click', saveGoals);
  document.getElementById('nutrGoalsReset')?.addEventListener('click', resetGoals);
  ['nutrGoalCal', 'nutrGoalPro', 'nutrGoalCarb', 'nutrGoalFat'].forEach(id =>
    document.getElementById(id)?.addEventListener('input', nutrUpdateGoalsHint));
  document.getElementById('nutrLogBtn')?.addEventListener('click', () => openAddMealModal());
  document.getElementById('nutrMModalCancel')?.addEventListener('click', closeAddMealModal);
  document.getElementById('nutrMealModal')?.querySelector('.nutr-modal-bg')?.addEventListener('click', closeAddMealModal);
  document.getElementById('nutrMModalSave')?.addEventListener('click', submitMeal);
  document.getElementById('nutrMDel')?.addEventListener('click', () => {
    const modal = document.getElementById('nutrMealModal');
    if (modal?._editId && confirm('Delete this meal?')) deleteMeal(modal._editId);
  });
  // Meal-type segmented control
  document.querySelectorAll('#nutrMCatTog .nutr-cat-btn').forEach(btn => {
    btn.addEventListener('click', () => nutrSetActiveCat(btn.dataset.cat));
  });
  // Logged / Planned toggle
  document.querySelectorAll('.nutr-planned-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nutr-planned-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  // Micronutrient hub (opened from the summary card)
  const openMicroHub = () => {
    renderNutrAllMicros();
    document.getElementById('nutrAllMicrosPanel')?.classList.add('open');
  };
  const microCard = document.getElementById('nutrMicroCard');
  microCard?.addEventListener('click', openMicroHub);
  microCard?.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMicroHub(); } });
  document.getElementById('nutrMicroCardLink')?.addEventListener('click', openMicroHub);
  document.getElementById('nutrAllMicrosBack')?.addEventListener('click', () => {
    document.getElementById('nutrAllMicrosPanel')?.classList.remove('open');
  });
  // Tracked-micros settings (gear in the hub header)
  document.getElementById('nutrMicroSettingsOpen')?.addEventListener('click', () => {
    renderNutrMicroSettings();
    document.getElementById('nutrMicroSettingsPanel')?.classList.add('open');
  });
  document.getElementById('nutrMicroSettingsBack')?.addEventListener('click', () => {
    document.getElementById('nutrMicroSettingsPanel')?.classList.remove('open');
  });
  // Gaps settings panel (opened from the hub's Edit link)
  document.getElementById('nutrGapsSettingsBack')?.addEventListener('click', () => {
    document.getElementById('nutrGapsSettingsPanel')?.classList.remove('open');
  });
  // Weight card → Health tab (where weight is logged)
  const wcard = document.getElementById('nutrWeightCard');
  if (wcard) {
    const goWt = () => { if (typeof switchTab === 'function') switchTab('health'); };
    wcard.addEventListener('click', goWt);
    wcard.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goWt(); } });
  }
  renderNutrition();
}

// ── Tab navigation (single-page app) ───────────────────────
// All tabs live in one document as .tab-page sections. applyTab() swaps the
// visible section + nav state; switchTab() additionally records a history entry
// so the browser back/forward buttons move between tabs. A sub-section (e.g.
// 'body' on the Health tab) is broadcast via the 'tab-changed' event.
function applyTab(id, sub) {
  let page = document.getElementById('page-' + id);
  if (!page) { id = 'home'; sub = null; page = document.getElementById('page-home'); }
  if (!page) return;
  document.querySelectorAll('.tab-page').forEach(p => p.classList.remove('active'));
  page.classList.add('active');
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
  window.scrollTo(0, 0);
  window.dispatchEvent(new CustomEvent('tab-changed', { detail: { tab: id, sub: sub || null } }));
}
function switchTab(id, sub) {
  id = id || 'home';
  if (!document.getElementById('page-' + id)) { id = 'home'; sub = null; }
  const hash = '#' + id + (sub ? '/' + sub : '');
  if (location.hash !== hash) { try { history.pushState(null, '', hash); } catch (e) { location.hash = hash; } }
  applyTab(id, sub);
}
function routeFromHash() {
  const path = location.hash.slice(1).split('?')[0];
  const seg  = path.split('/');
  applyTab(seg[0] || 'home', seg[1] || null);
}
window.addEventListener('hashchange', routeFromHash); // back/forward + manual hash edits
document.querySelectorAll('.nav-tab').forEach(btn => {
  if (btn.hasAttribute('data-nav-cycle')) return; // health cycle btn is handled locally
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ── Gym redesign v3 additions ─────────────────────────────────────

// Past workouts <details> bridge: keep existing JS show/hide in sync
;(function() {
  const pastDet = document.querySelector('.gym-past-details');
  if (!pastDet) return;
  pastDet.addEventListener('toggle', () => {
    const h = document.getElementById('poHistBody');
    if (h) h.style.display = pastDet.open ? '' : 'none';
  });
  // Prevent the gymPastLink onclick (set in initGym) from fighting <details>
  // by overriding it to be a no-op (the toggle event above handles display)
  const lnk = document.getElementById('gymPastLink');
  if (lnk) { lnk._wired = true; lnk.onclick = null; }
})();

// Open settings drawer by default on desktop
;(function() {
  if (window.innerWidth >= 1024) {
    const det = document.querySelector('.gym-settings-details');
    if (det) det.setAttribute('open', '');
  }
})();

// Split current-pills display
function gymRenderSplitCurrentPills() {
  const el = document.getElementById('gymSplitCurrentPills');
  if (!el) return;
  const s    = loadGymState();
  const auto = gymAutoDay(s);
  el.innerHTML = '';
  (s.splitRotation || []).forEach(name => {
    const pill = document.createElement('span');
    pill.className = 'gym-split-current-pill' + (name === auto ? ' active' : '');
    pill.textContent = name.toUpperCase();
    el.appendChild(pill);
  });
}

// Split mode toggle (segmented control)
const _GYM_SPLIT_MODES = [
  { label: 'FB',      days: ['Full Body'] },
  { label: 'PPL',     days: ['Push','Pull','Legs'] },
  { label: 'UL',      days: ['Upper','Lower'] },
  { label: 'PPL/UL',  days: ['Push','Pull','Legs','Upper','Lower'] },
];

function gymDetectSplitMode(rotation) {
  const rot = (rotation || []).map(r => r.toLowerCase()).filter(r => r !== 'rest');
  const has = (...names) => names.every(n => rot.includes(n.toLowerCase()));
  if (rot.length === 1 && rot[0] === 'full body') return 'FB';
  if (rot.length === 3 && has('Push','Pull','Legs')) return 'PPL';
  if (rot.length === 2 && has('Upper','Lower')) return 'UL';
  if (has('Push','Pull','Legs','Upper','Lower')) return 'PPL/UL';
  return null;
}

function gymRenderSplitModeToggle() {
  const el = document.getElementById('gymSplitModeToggle');
  if (!el) return;
  const state = loadGymState();
  const active = gymDetectSplitMode(state.splitRotation);
  el.innerHTML = '';
  _GYM_SPLIT_MODES.forEach(m => {
    const btn = document.createElement('button');
    btn.className = 'gym-split-mode-btn' + (m.label === active ? ' active' : '');
    btn.textContent = m.label;
    btn.onclick = () => gymApplyPreset(m.days);
    el.appendChild(btn);
  });
}

let _gymSplitNoticeTimer = null;

function gymApplyPreset(preset) {
  const s = loadGymState();
  function slugify(n) { return n.toLowerCase().replace(/[\s/]+/g, '-'); }
  const newDays    = preset.filter(n => n.toLowerCase() !== 'rest').map(n => ({ id: slugify(n), name: n }));
  s.splitRotation  = preset;
  s.splitAnchor    = { date: gymToday(), index: 0 };
  s.days           = newDays;
  s._userPickedDay = false;
  const autoName = gymAutoDay(s);
  const autoObj  = s.days.find(d => d.name === autoName);
  if (autoObj)                                             s.filterDay = autoObj.id;
  else if (autoName && autoName.toLowerCase() === 'rest') s.filterDay = 'rest';
  saveGymState(s);
  renderGym();
  gymRebuildAddFormSelects();
  gymShowToast(`Split updated — today is now ${autoName || '?'}`);
}

function gymAllDays(state) {
  function slugify(n) { return n.toLowerCase().replace(/[\s/]+/g, '-'); }
  const activeDayIds = new Set(state.days.map(d => d.id));
  const seen = new Set();
  const result = [];

  // Fixed canonical order covering all built-in splits
  ['Upper', 'Lower', 'Push', 'Pull', 'Legs', 'Full Body'].forEach(name => {
    const id = slugify(name);
    seen.add(id);
    result.push({ id, name, _phantom: !activeDayIds.has(id) });
  });

  // Any active days not in the canonical list (custom split days)
  state.days.forEach(d => {
    if (!seen.has(d.id)) {
      seen.add(d.id);
      result.push({ id: d.id, name: d.name, _phantom: false });
    }
  });

  // Any rotation entries not yet covered (future custom days)
  (state.splitRotation || []).forEach(name => {
    if (name.toLowerCase() === 'rest') return;
    const id = slugify(name);
    if (!seen.has(id)) {
      seen.add(id);
      result.push({ id, name, _phantom: true });
    }
  });

  return result;
}

function gymMakeDayToggleBtn(d, selected) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'gym-day-btn' + (d._phantom ? ' other-split' : '');
  btn.textContent = d.name;
  btn.dataset.dayId = d.id;
  btn.dataset.selected = selected ? 'true' : 'false';
  if (selected) btn.classList.add('active');
  btn.onclick = () => {
    const on = btn.dataset.selected === 'true';
    btn.dataset.selected = on ? 'false' : 'true';
    btn.classList.toggle('active', !on);
  };
  return btn;
}

function gymRenderDayToggle() {
  const el = document.getElementById('gymDayToggle');
  if (!el) return;
  const st = loadGymState();
  el.innerHTML = '';
  gymAllDays(st).forEach(d => el.appendChild(gymMakeDayToggleBtn(d, false)));
}

function gymRenderMuscleToggle(container, selected) {
  if (!container) return;
  container.innerHTML = '';
  MM_MUSCLE_OPTS.forEach(opt => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gym-day-btn' + ((selected || []).includes(opt.id) ? ' active' : '');
    btn.textContent = opt.label;
    btn.dataset.muscleId = opt.id;
    btn.dataset.selected = (selected || []).includes(opt.id) ? 'true' : 'false';
    btn.onclick = () => {
      const on = btn.dataset.selected === 'true';
      btn.dataset.selected = on ? 'false' : 'true';
      btn.classList.toggle('active', !on);
    };
    container.appendChild(btn);
  });
}

function gymReadMuscleToggle(container) {
  if (!container) return [];
  return [...container.querySelectorAll('[data-muscle-id][data-selected="true"]')].map(b => b.dataset.muscleId);
}

function gymRebuildAddFormSelects() {
  gymRenderDayToggle();
  gymRenderMuscleToggle(document.getElementById('gymNewMuscleToggle'), []);
}

// Toast helper
let _gymToastTimer = null;
function gymShowToast(msg) {
  let toast = document.getElementById('gymToast');
  if (!toast) {
    toast = document.createElement('div'); toast.id = 'gymToast'; toast.className = 'gym-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('visible');
  clearTimeout(_gymToastTimer);
  _gymToastTimer = setTimeout(() => toast.classList.remove('visible'), 2500);
}

// Wire edit-rotation button
;(function() {
  const btn = document.getElementById('gymSplitEditBtn');
  if (btn) btn.onclick = () => poOpenRotModal();
})();

// Wire up "+ Add Split" button
;(function() {
  const btn = document.getElementById('gymSplitCustomBtn');
  if (btn) btn.onclick = () => poOpenRotModal();
})();

// Extend renderGym to also update new v3 surfaces
const _origRenderGymV3 = renderGym;
renderGym = function() {
  _origRenderGymV3();
  gymRenderSplitCurrentPills();
  gymRenderSplitModeToggle();
};

// Keyboard shortcuts (gym tab, desktop)
;(function() {
  let kbdOverlay = null;
  function getOverlay() {
    if (!kbdOverlay) {
      kbdOverlay = document.createElement('div');
      kbdOverlay.id = 'gymKbdOverlay'; kbdOverlay.className = 'gym-kbd-overlay';
      kbdOverlay.innerHTML = [
        '<div style="font-family:ui-monospace,monospace;font-size:9px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase;color:var(--text-tertiary);margin-bottom:8px;">SHORTCUTS</div>',
        '<div class="gym-kbd-row"><span>Log set</span><span class="gym-kbd-key">Space</span></div>',
        '<div class="gym-kbd-row"><span>Weight +/−</span><span class="gym-kbd-key">↑ / ↓</span></div>',
        '<div class="gym-kbd-row"><span>Prev / next ex</span><span class="gym-kbd-key">J / K</span></div>',
        '<div class="gym-kbd-row"><span>Toggle done</span><span class="gym-kbd-key">D</span></div>',
        '<div class="gym-kbd-row"><span>Focus picker</span><span class="gym-kbd-key">/</span></div>',
        '<div class="gym-kbd-row"><span>Close</span><span class="gym-kbd-key">Esc</span></div>',
      ].join('');
      document.body.appendChild(kbdOverlay);
    }
    return kbdOverlay;
  }
  document.addEventListener('keydown', e => {
    const tg = e.target.tagName;
    if (tg === 'INPUT' || tg === 'TEXTAREA' || tg === 'SELECT') return;
    const page = document.getElementById('page-gym');
    if (!page || !page.classList.contains('active')) return;
    if (e.key === '?') { e.preventDefault(); getOverlay().classList.toggle('visible'); return; }
    if (e.key === 'Escape') { getOverlay().classList.remove('visible'); return; }
    if (e.key === ' ')          { e.preventDefault(); document.getElementById('poLogBtn')?.click(); return; }
    if (e.key === 'ArrowUp')    { e.preventDefault(); document.getElementById('poWtPlus')?.click(); return; }
    if (e.key === 'ArrowDown')  { e.preventDefault(); document.getElementById('poWtMinus')?.click(); return; }
    if (e.key === 'd' || e.key === 'D') { document.getElementById('poDoneBtn')?.click(); return; }
    if (e.key === '/') {
      e.preventDefault();
      document.getElementById('gymCoachCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (e.key === 'j' || e.key === 'J') {
      const s = loadGymState(); const exs = s.exercises.filter(ex => gymExDays(ex).includes(s.filterDay));
      const idx = exs.findIndex(ex => ex.id === s.currentEx);
      if (idx > 0) _gymKbdSelectEx(exs[idx - 1].id); return;
    }
    if (e.key === 'k' || e.key === 'K') {
      const s = loadGymState(); const exs = s.exercises.filter(ex => gymExDays(ex).includes(s.filterDay));
      const idx = exs.findIndex(ex => ex.id === s.currentEx);
      if (idx !== -1 && idx < exs.length - 1) _gymKbdSelectEx(exs[idx + 1].id); return;
    }
  });
  function _gymKbdSelectEx(exId) {
    const s = loadGymState(); s.currentEx = exId; saveGymState(s);
    const sel = document.getElementById('poExSel'); if (sel) sel.value = exId;
    poDraftWeight = null; poDraftReps = null; poDraftRir = null;
    _gymActiveQueueEx = exId;
    gymRenderQueue(); poRenderCoach(); poRenderStats();
  }
})();

function initMountainsBg() {
  const mountains = document.createElement('div');
  mountains.className = 'bg-mountains';
  mountains.setAttribute('aria-hidden', 'true');
  mountains.innerHTML = `<svg viewBox="0 0 1600 420" preserveAspectRatio="none">
    <defs>
      <linearGradient id="bg-mt-far" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#0d1a17" stop-opacity="0"/>
        <stop offset="55%" stop-color="#0d1a17" stop-opacity=".55"/>
        <stop offset="100%" stop-color="#0d1a17" stop-opacity=".95"/>
      </linearGradient>
      <linearGradient id="bg-mt-near" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#050a09" stop-opacity=".4"/>
        <stop offset="60%" stop-color="#050a09" stop-opacity=".95"/>
        <stop offset="100%" stop-color="#050a09" stop-opacity="1"/>
      </linearGradient>
    </defs>
    <path d="M0,300 L120,230 L210,260 L320,180 L430,220 L560,150 L680,210 L820,170 L960,220 L1100,180 L1240,240 L1380,200 L1500,250 L1600,220 L1600,420 L0,420 Z" fill="url(#bg-mt-far)"/>
    <path d="M0,360 L100,320 L220,340 L340,290 L460,330 L590,300 L720,340 L860,310 L1000,350 L1140,310 L1280,355 L1420,320 L1540,360 L1600,340 L1600,420 L0,420 Z" fill="url(#bg-mt-near)"/>
  </svg>`;

  const mist = document.createElement('div');
  mist.className = 'bg-mist';
  mist.setAttribute('aria-hidden', 'true');

  const particles = document.createElement('div');
  particles.className = 'bg-particles';
  particles.setAttribute('aria-hidden', 'true');
  const N = window.innerWidth < 640 ? 10 : 18;
  for (let i = 0; i < N; i++) {
    const s = document.createElement('span');
    const dur = 18 + Math.random() * 22;
    s.style.left = (Math.random() * 100) + '%';
    s.style.top = (60 + Math.random() * 40) + 'vh';
    const size = 1 + Math.random() * 1.2;
    s.style.width = s.style.height = size + 'px';
    s.style.animationDuration = dur + 's';
    s.style.animationDelay = (-Math.random() * dur) + 's';
    s.style.setProperty('--dx', (Math.random() * 30 - 15) + 'px');
    s.style.setProperty('--dy', (-(60 + Math.random() * 50)) + 'vh');
    particles.appendChild(s);
  }

  document.body.insertBefore(particles, document.body.firstChild);
  document.body.insertBefore(mist, document.body.firstChild);
  document.body.insertBefore(mountains, document.body.firstChild);
}

// ══════════════════════════════════════════════════════════════════
//  GOALS SYSTEM  (Calendar + Life-goals)
//  Calendar entries live in the shared `goals:YYYY-MM-DD` store so they
//  auto-sync and auto-appear in the Tasks tab. Recurring weekly schedule
//  templates + life-goals live in their own synced `calendar`/`lifegoals`
//  app_state stores. Today's recurring blocks are materialized into the
//  goals store on boot so they show up everywhere without opening Goals.
// ══════════════════════════════════════════════════════════════════
const GOALS_SEED_VERSION = 'summer-2026-v1';
const CAL_SUMMER_UNTIL   = '2026-09-16';   // end of summer / start of college
const CAL_DOMAIN_VAR = { work:'--accent-work', gym:'--accent-gym', life:'--accent-life', home:'--accent-home', money:'--accent-money', habit:'--accent-habit', sleep:'--accent-sleep' };

// Weekday recurring schedule. `days` uses JS getDay(): 0=Sun … 6=Sat.
const CAL_TEMPLATES_DEFAULT = [
  { id:'tpl-deepwork', title:'Quant prep / Coding', domain:'work',  days:[1,2,3,4,5], time:'06:15', durationMin:60,  kind:'task',     protect:true,  until:CAL_SUMMER_UNTIL },
  { id:'tpl-work',     title:'Work',                domain:'work',  days:[1,2,3,4,5], time:'09:00', durationMin:480, kind:'plan',                    until:CAL_SUMMER_UNTIL },
  { id:'tpl-ber',      title:'BER work',            domain:'money', days:[1,2,3,4,5], time:'17:30', durationMin:75,  kind:'task',                    until:CAL_SUMMER_UNTIL },
  { id:'tpl-train',    title:'Training (FB / sprint-pitch)', domain:'gym', days:[1,2,3,4,5], time:'18:30', durationMin:90, kind:'task',              until:CAL_SUMMER_UNTIL },
  { id:'tpl-rest',     title:'Dinner · downtime · rest', domain:'home', days:[1,2,3,4,5], time:'20:00', durationMin:120, kind:'plan',               until:CAL_SUMMER_UNTIL },
  { id:'tpl-winddown', title:'Wind down for sleep', domain:'sleep', days:[0,1,2,3,4,5,6], time:'22:45', durationMin:0, kind:'reminder',            until:CAL_SUMMER_UNTIL },
  { id:'tpl-sql',      title:'SQL block',           domain:'work',  days:[6],         time:'14:00', durationMin:210, kind:'task',                    until:CAL_SUMMER_UNTIL },
];

// Weekly / daily life-goals seeded from the summer targets.
const LIFEGOALS_DEFAULT = [
  { id:'lg-quant',  title:'Quant prep',     domain:'work',  period:'weekly', type:'count', target:5,   unit:'sessions', note:'5–6 mornings/week, 45min min' },
  { id:'lg-coding', title:'Coding project', domain:'life',  period:'weekly', type:'count', target:2,   unit:'sessions', note:'2–3 mornings/week' },
  { id:'lg-sql',    title:'SQL',            domain:'work',  period:'weekly', type:'time',  target:200, unit:'min',      note:'one weekend block, 3–4h' },
  { id:'lg-fb',     title:'FB workouts',    domain:'gym',   period:'weekly', type:'count', target:2,   unit:'workouts', note:'2–3x/week' },
  { id:'lg-sprint', title:'Sprint / pitch', domain:'gym',   period:'weekly', type:'count', target:1,   unit:'sessions', note:'1–2x/week' },
  { id:'lg-sleep',  title:'Sleep',          domain:'sleep', period:'daily',  type:'time',  target:450, unit:'min',      note:'7–8h, non-negotiable' },
];

function calDomainVar(d){ return 'var(' + (CAL_DOMAIN_VAR[d] || '--accent-work') + ')'; }
function calPad(n){ return String(n).padStart(2,'0'); }
function calDateStr(d){ return d.getFullYear()+'-'+calPad(d.getMonth()+1)+'-'+calPad(d.getDate()); }
function calTodayStr(){ return calDateStr(new Date()); }
function calParse(ds){ const p=String(ds).split('-').map(Number); return new Date(p[0], p[1]-1, p[2]); }   // local midnight
function calGoalsKey(ds){ return 'goals:'+ds; }
function calBlockForTime(t){ const h=parseInt(String(t||'09:00').slice(0,2),10)||9; return h<12?'morning':(h<17?'midday':'evening'); }
function calMinutesOf(t){ const p=String(t||'00:00').split(':'); return (parseInt(p[0],10)||0)*60 + (parseInt(p[1],10)||0); }

// ── Calendar template store (synced via app_state 'calendar') ──────
function calStore(){
  const s = (typeof storeGet==='function' ? storeGet('calendar') : null) || {};
  if (!Array.isArray(s.templates)) s.templates = [];
  if (!s.exceptions || typeof s.exceptions!=='object') s.exceptions = {};
  return s;
}
function calStoreSave(s){ if (typeof storeSet==='function') storeSet('calendar', s); }
function calExceptionKey(tplId, ds){ return tplId + '@' + ds; }
function calAddException(tplId, ds){ const s=calStore(); s.exceptions[calExceptionKey(tplId,ds)] = 1; calStoreSave(s); }

// ── Life-goals store (synced via app_state 'lifegoals') ────────────
function lifeGoalsStore(){
  const s = (typeof storeGet==='function' ? storeGet('lifegoals') : null) || {};
  if (!Array.isArray(s.goals)) s.goals = [];
  return s;
}
function lifeGoalsSave(s){ if (typeof storeSet==='function') storeSet('lifegoals', s); }

// ── Recurrence expansion ───────────────────────────────────────────
// Virtual instances of weekly templates that apply to a given date and
// have NOT been overridden by a concrete entry or skipped via exception.
function calTemplateInstancesFor(ds){
  const s = calStore();
  const dow = calParse(ds).getDay();
  const out = [];
  s.templates.forEach(tpl => {
    if (!tpl || !Array.isArray(tpl.days) || tpl.days.indexOf(dow) < 0) return;
    if (tpl.until && ds > tpl.until) return;
    if (s.exceptions[calExceptionKey(tpl.id, ds)]) return;
    out.push({
      id: 'tpl_' + tpl.id + '_' + ds,
      tplId: tpl.id,
      text: tpl.title,
      domain: tpl.domain,
      time: tpl.time,
      durationMin: tpl.durationMin || 0,
      kind: tpl.kind || 'task',
      protect: !!tpl.protect,
      cal: true,
      tpl: true,           // virtual marker (not yet written to goals store)
      block: calBlockForTime(tpl.time),
      done: false
    });
  });
  return out;
}

// Merged view for a date: concrete goals-store entries + un-materialized
// virtual template instances (deduped by tplId).
function calEntriesFor(ds){
  const concrete = (typeof storeGet==='function' ? storeGet(calGoalsKey(ds)) : null) || [];
  const haveTpl = new Set(concrete.filter(e=>e&&e.tplId).map(e=>e.tplId));
  const virtual = calTemplateInstancesFor(ds).filter(v => !haveTpl.has(v.tplId));
  return concrete.concat(virtual);
}

// Write today's (or any date's) recurring template instances into the
// goals store once, so they surface in the Tasks tab. Idempotent: guarded
// per-date and deduped by tplId, so user edits/deletions are respected.
function calMaterializeDate(ds){
  try {
    const flag = 'cal_mat:' + ds;
    if (localStorage.getItem(flag)) return;
    const arr = ((typeof storeGet==='function' ? storeGet(calGoalsKey(ds)) : null) || []).slice();
    const have = new Set(arr.filter(e=>e&&e.tplId).map(e=>e.tplId));
    let added = 0;
    calTemplateInstancesFor(ds).forEach(v => {
      if (have.has(v.tplId)) return;
      const copy = Object.assign({}, v); delete copy.tpl;     // becomes concrete
      arr.push(copy); added++;
    });
    if (added && typeof storeSet==='function') storeSet(calGoalsKey(ds), arr);
    localStorage.setItem(flag, '1');
  } catch (_) {}
}

// ── One-time seeding of the summer schedule + life-goals ───────────
function calSeedDefaultsOnce(){
  // Templates
  const cal = calStore();
  if (cal.seeded !== GOALS_SEED_VERSION) {
    const have = new Set(cal.templates.map(t=>t.id));
    CAL_TEMPLATES_DEFAULT.forEach(t => { if (!have.has(t.id)) cal.templates.push(Object.assign({}, t)); });
    cal.seeded = GOALS_SEED_VERSION;
    calStoreSave(cal);
  }
  // Life-goals
  const lg = lifeGoalsStore();
  if (lg.seeded !== GOALS_SEED_VERSION) {
    const have = new Set(lg.goals.map(g=>g.id));
    LIFEGOALS_DEFAULT.forEach(g => { if (!have.has(g.id)) lg.goals.push(Object.assign({ log:{} }, g)); });
    lg.seeded = GOALS_SEED_VERSION;
    lifeGoalsSave(lg);
  }
}

// Remove plain (non-calendar) entries whose text duplicates a calendar/template
// entry already present that day. Heals the old rollover bug where recurring
// blocks were carried forward as bare {text,done} copies alongside the real
// materialized ones. Surgical + idempotent: only drops a plain entry when an
// equivalent calendar entry covers it, so genuine ad-hoc tasks are untouched.
function calDedupeDuplicates(ds){
  try {
    const key = calGoalsKey(ds);
    const arr = (typeof storeGet==='function' ? storeGet(key) : null) || [];
    const calTexts = new Set(arr.filter(g => g && (g.tplId || g.cal)).map(g => g.text));
    const out = arr.filter(g => !(g && !g.tplId && !g.cal && calTexts.has(g.text)));
    if (out.length !== arr.length && typeof storeSet==='function') storeSet(key, out);
  } catch (_) {}
}

function initGoalsSystem(){
  calSeedDefaultsOnce();
  calMaterializeDate(calTodayStr());
  calDedupeDuplicates(calTodayStr());
}

initMountainsBg();
// NB: do NOT force-show the auth overlay here. initAuth() reveals it only when
// getSession() confirms there is no session — showing it eagerly caused the
// Google-login screen to flash on every load before auth resolved.
initAuth();
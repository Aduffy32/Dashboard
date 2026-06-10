(function () {
  'use strict';

  /* ── CSS ────────────────────────────────────────────────────────── */
  const style = document.createElement('style');
  style.textContent = `
.po-muscle-card{padding:16px 18px 14px;position:relative;}
.mm-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}
.mm-ey{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.18em;color:var(--text-tertiary);}
.mm-tog{display:flex;border-radius:10px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.03);overflow:hidden;}
.mm-tog-btn{padding:5px 14px;border:none;background:none;color:var(--text-tertiary);font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;cursor:pointer;font-family:inherit;transition:background 0.2s,color 0.2s;}
.mm-tog-btn.active{background:rgba(255,255,255,0.09);color:var(--text-primary);}
.mm-wrap{display:flex;justify-content:center;}
.mm-body-svg{max-width:220px;width:100%;display:block;}
.ms-muscle{fill:rgba(255,255,255,0.06);stroke:rgba(255,255,255,0.22);stroke-width:0.5;cursor:pointer;transition:fill 0.25s,stroke 0.25s,filter 0.25s;}
.ms-muscle:hover{fill:rgba(255,255,255,0.14);stroke:rgba(255,255,255,0.4);}
.ms-active{fill:rgba(91,184,245,0.3)!important;stroke:#5BB8F5!important;stroke-width:1.5!important;}
.ms-active:hover{fill:rgba(91,184,245,0.42)!important;}
.ms-done{fill:rgba(91,184,245,0.6)!important;stroke:#5BB8F5!important;stroke-width:1.5!important;filter:drop-shadow(0 0 8px rgba(91,184,245,0.55))!important;}
.ms-tip{position:absolute;z-index:50;pointer-events:none;background:rgba(14,14,16,0.96);border:1px solid rgba(255,255,255,0.11);border-radius:8px;padding:7px 10px;font-family:inherit;min-width:110px;max-width:185px;box-shadow:0 4px 20px rgba(0,0,0,0.5);opacity:0;transition:opacity 0.1s;top:0;left:0;}
.ms-tip.visible{opacity:1;}
.ms-tip-name{font-size:12px;font-weight:700;color:var(--text-primary);margin-bottom:4px;}
.ms-tip-ex{font-size:11px;color:var(--text-secondary);line-height:1.55;white-space:pre-line;}
`;
  document.head.appendChild(style);

  /* ── Fallback exercise map (used when user has no explicit muscle mapping) ── */
  const MUSCLE_EXERCISES = {
    chest:       ['Bench press','Push-ups','Chest fly'],
    front_delts: ['Overhead press','Front raise','Arnold press'],
    side_delts:  ['Lateral raise','Upright row','Overhead press'],
    rear_delts:  ['Reverse fly','Face pull'],
    traps:       ['Shrug','Upright row','Face pull'],
    biceps:      ['Bicep curl','Hammer curl','Pull-ups'],
    triceps:     ['Tricep pushdown','Skull crusher','Dips','Close-grip bench'],
    forearms:    ['Wrist curl','Hammer curl','Reverse curl'],
    abs:         ['Crunches','Plank','Leg raise'],
    obliques:    ['Russian twist','Side plank','Cable woodchop'],
    lats:        ['Pull-ups','Barbell row','Lat pulldown'],
    mid_back:    ['Barbell row','Cable row','T-bar row'],
    lower_back:  ['Romanian deadlift','Hyperextension','Good morning'],
    glutes:      ['Back squat','Hip thrust','Romanian deadlift'],
    quads:       ['Back squat','Leg press','Lunge','Leg extension'],
    hamstrings:  ['Romanian deadlift','Leg curl','Stiff-leg deadlift'],
    calves:      ['Calf raise','Seated calf raise'],
    hip_flexors: ['Lunge','Hip flexor stretch','Step-up'],
  };

  /* ── Muscle polygon definitions ──────────────────────────────────── */
  // Data from react-body-highlighter (giavinh79); viewBox 0 0 100 200
  // side_delts and lats are approximated (not in the library)
  const MUSCLE_DEFS = [
    // ── FRONT VIEW ──────────────────────────────────────────────────
    { id:'chest', label:'Chest', view:'front', polygons:[
      '51.8367347 41.6326531 51.0204082 55.1020408 57.9591837 57.9591837 67.755102 55.5102041 70.6122449 47.3469388 62.0408163 41.6326531',
      '29.7959184 46.5306122 31.4285714 55.5102041 40.8163265 57.9591837 48.1632653 55.1020408 47.755102 42.0408163 37.5510204 42.0408163',
    ]},
    { id:'front_delts', label:'Front Delts', view:'front', polygons:[
      '78.3673469 53.0612245 79.5918367 47.755102 79.1836735 41.2244898 75.9183673 37.9591837 71.0204082 36.3265306 72.244898 42.8571429 71.4285714 47.3469388',
      '28.1632653 47.3469388 21.2244898 53.0612245 20 47.755102 20.4081633 40.8163265 24.4897959 37.1428571 28.5714286 37.1428571 26.9387755 43.2653061',
    ]},
    { id:'side_delts', label:'Side Delts', view:'front', polygons:[
      '82 38 85 44 85 52 80 55 76 50 78 39',
      '18 38 15 44 15 52 20 55 24 50 22 39',
    ]},
    { id:'biceps', label:'Biceps', view:'front', polygons:[
      '16.7346939 68.1632653 17.9591837 71.4285714 22.8571429 66.122449 28.9795918 53.877551 27.755102 49.3877551 20.4081633 55.9183673',
      '71.4285714 49.3877551 70.2040816 54.6938776 76.3265306 66.122449 81.6326531 71.8367347 82.8571429 68.9795918 78.7755102 55.5102041',
    ]},
    { id:'triceps', label:'Triceps', view:'front', polygons:[
      '69.3877551 55.5102041 69.3877551 61.6326531 75.9183673 72.6530612 77.5510204 70.2040816 75.5102041 67.3469388',
      '22.4489796 69.3877551 29.7959184 55.5102041 29.7959184 60.8163265 22.8571429 73.0612245',
    ]},
    { id:'forearms', label:'Forearms', view:'front', polygons:[
      '6.12244898 88.5714286 10.2040816 75.1020408 14.6938776 70.2040816 16.3265306 74.2857143 19.1836735 73.4693878 4.48979592 97.5510204 0 100',
      '84.4897959 69.7959184 83.2653061 73.4693878 80 73.0612245 95.1020408 98.3673469 100 100.408163 93.4693878 89.3877551 89.7959184 76.3265306',
      '77.5510204 72.244898 77.5510204 77.5510204 80.4081633 84.0816327 85.3061224 89.7959184 92.244898 101.22449 94.6938776 99.5918367',
      '6.93877551 101.22449 13.4693878 90.6122449 18.7755102 84.0816327 21.6326531 77.1428571 21.2244898 71.8367347 4.89795918 98.7755102',
    ]},
    { id:'abs', label:'Abs', view:'front', polygons:[
      '56.3265306 59.1836735 57.9591837 64.0816327 58.3673469 77.9591837 58.3673469 92.6530612 56.3265306 98.3673469 55.1020408 104.081633 51.4285714 107.755102 51.0204082 84.4897959 50.6122449 67.3469388 51.0204082 57.1428571',
      '43.6734694 58.7755102 48.5714286 57.1428571 48.9795918 67.3469388 48.5714286 84.4897959 48.1632653 107.346939 44.4897959 103.673469 40.8163265 91.4285714 40.8163265 78.3673469 41.2244898 64.4897959',
    ]},
    { id:'obliques', label:'Obliques', view:'front', polygons:[
      '68.5714286 63.2653061 67.3469388 57.1428571 58.7755102 59.5918367 60 64.0816327 60.4081633 83.2653061 65.7142857 78.7755102 66.5306122 69.7959184',
      '33.877551 78.3673469 33.0612245 71.8367347 31.0204082 63.2653061 32.244898 57.1428571 40.8163265 59.1836735 39.1836735 63.2653061 39.1836735 83.6734694',
    ]},
    { id:'hip_flexors', label:'Hip Flexors', view:'front', polygons:[
      '52.6530612 110.204082 54.2857143 124.897959 60 110.204082 62.0408163 100 64.8979592 94.2857143 60 92.6530612 56.7346939 104.489796',
      '47.755102 110.612245 44.8979592 125.306122 42.0408163 115.918367 40.4081633 113.061224 39.5918367 107.346939 37.9591837 102.44898 34.6938776 93.877551 39.5918367 92.244898 41.6326531 99.1836735 43.6734694 105.306122',
    ]},
    { id:'quads', label:'Quads', view:'front', polygons:[
      '34.6938776 98.7755102 37.1428571 108.163265 37.1428571 127.755102 34.2857143 137.142857 31.0204082 132.653061 29.3877551 120 28.1632653 111.428571 29.3877551 100.816327 32.244898 94.6938776',
      '63.2653061 105.714286 64.4897959 100 66.9387755 94.6938776 70.2040816 101.22449 71.0204082 111.836735 68.1632653 133.061224 65.3061224 137.55102 62.4489796 128.571429 62.0408163 111.428571',
      '38.7755102 129.387755 38.3673469 112.244898 41.2244898 118.367347 44.4897959 129.387755 42.8571429 135.102041 40 146.122449 36.3265306 146.530612 35.5102041 140',
      '59.5918367 145.714286 55.5102041 128.979592 60.8163265 113.877551 61.2244898 130.204082 64.0816327 139.591837 62.8571429 146.530612',
      '32.6530612 138.367347 26.5306122 145.714286 25.7142857 136.734694 25.7142857 127.346939 26.9387755 114.285714 29.3877551 133.469388',
      '71.8367347 113.061224 73.877551 124.081633 73.877551 140.408163 72.6530612 145.714286 66.5306122 138.367347 70.2040816 133.469388',
    ]},
    { id:'calves', label:'Calves', view:'front', polygons:[
      '71.4285714 160.408163 73.4693878 153.469388 76.7346939 161.22449 79.5918367 167.755102 78.3673469 187.755102 79.5918367 195.510204 74.6938776 195.510204',
      '24.8979592 194.693878 27.755102 164.897959 28.1632653 160.408163 26.122449 154.285714 24.8979592 157.55102 22.4489796 161.632653 20.8163265 167.755102 22.0408163 188.163265 20.8163265 195.510204',
      '72.6530612 195.102041 69.7959184 159.183673 65.3061224 158.367347 64.0816327 162.44898 64.0816327 165.306122 65.7142857 177.142857',
      '35.5102041 158.367347 35.9183673 162.44898 35.9183673 166.938776 35.1020408 172.244898 35.1020408 176.734694 32.244898 182.040816 30.6122449 187.346939 26.9387755 194.693878 27.3469388 187.755102 28.1632653 180.408163 28.5714286 175.510204 28.9795918 169.795918 29.7959184 164.081633 30.2040816 158.77551',
    ]},

    // ── BACK VIEW ───────────────────────────────────────────────────
    { id:'traps', label:'Traps', view:'back', polygons:[
      '44.6808511 21.7021277 47.6595745 21.7021277 47.2340426 38.2978723 47.6595745 64.6808511 38.2978723 53.1914894 35.3191489 40.8510638 31.0638298 36.5957447 39.1489362 33.1914894 43.8297872 27.2340426',
      '52.3404255 21.7021277 55.7446809 21.7021277 56.5957447 27.2340426 60.8510638 32.7659574 68.9361702 36.5957447 64.6808511 40.4255319 61.7021277 53.1914894 52.3404255 64.6808511 53.1914894 38.2978723',
    ]},
    { id:'rear_delts', label:'Rear Delts', view:'back', polygons:[
      '29.3617021 37.0212766 22.9787234 39.1489362 17.4468085 44.2553191 18.2978723 53.6170213 24.2553191 49.3617021 27.2340426 46.3829787',
      '71.0638298 37.0212766 78.2978723 39.5744681 82.5531915 44.6808511 81.7021277 53.6170213 74.893617 48.9361702 72.3404255 45.106383',
    ]},
    { id:'side_delts', label:'Side Delts', view:'back', polygons:[
      '82 38 85 44 85 52 80 55 76 50 78 39',
      '18 38 15 44 15 52 20 55 24 50 22 39',
    ]},
    { id:'triceps', label:'Triceps', view:'back', polygons:[
      '26.8085106 49.787234 17.8723404 55.7446809 14.4680851 72.3404255 16.5957447 81.7021277 21.7021277 63.8297872 26.8085106 55.7446809',
      '73.6170213 50.212766 82.1276596 55.7446809 85.9574468 73.1914894 83.4042553 82.1276596 77.8723404 62.9787234 73.1914894 55.7446809',
      '26.8085106 58.2978723 26.8085106 68.5106383 22.9787234 75.3191489 19.1489362 77.4468085 22.5531915 65.5319149',
      '72.7659574 58.2978723 77.0212766 64.6808511 80.4255319 77.4468085 76.5957447 75.3191489 72.7659574 68.9361702',
    ]},
    { id:'forearms', label:'Forearms', view:'back', polygons:[
      '86.3829787 75.7446809 91.0638298 83.4042553 93.1914894 94.0425532 100 106.382979 96.1702128 104.255319 88.0851064 89.3617021 84.2553191 83.8297872',
      '13.6170213 75.7446809 8.93617021 83.8297872 6.80851064 93.6170213 0 106.382979 3.82978723 104.255319 12.3404255 88.5106383 15.7446809 82.9787234',
      '81.2765957 79.5744681 77.4468085 77.8723404 79.1489362 84.6808511 91.0638298 103.829787 93.1914894 108.93617 94.4680851 104.680851',
      '18.7234043 79.5744681 22.1276596 77.8723404 20.8510638 84.2553191 9.36170213 102.978723 6.80851064 108.510638 5.10638298 104.680851',
    ]},
    { id:'lats', label:'Lats', view:'back', polygons:[
      '28 57 25 70 26 90 32 95 38 85 36 60',
      '72 57 75 70 74 90 68 95 62 85 64 60',
    ]},
    { id:'mid_back', label:'Mid Back', view:'back', polygons:[
      '31.0638298 38.7234043 28.0851064 48.9361702 28.5106383 55.3191489 34.0425532 75.3191489 47.2340426 71.0638298 47.2340426 66.3829787 36.5957447 54.0425532 33.6170213 41.2765957',
      '68.9361702 38.7234043 71.9148936 49.3617021 71.4893617 56.1702128 65.9574468 75.3191489 52.7659574 71.0638298 52.7659574 66.3829787 63.4042553 54.4680851 66.3829787 41.7021277',
    ]},
    { id:'lower_back', label:'Lower Back', view:'back', polygons:[
      '47.6595745 72.7659574 34.4680851 77.0212766 35.3191489 83.4042553 49.3617021 102.12766 46.8085106 82.9787234',
      '52.3404255 72.7659574 65.5319149 77.0212766 64.6808511 83.4042553 50.6382979 102.12766 53.1914894 83.8297872',
    ]},
    { id:'glutes', label:'Glutes', view:'back', polygons:[
      '44.6808511 99.5744681 30.212766 108.510638 29.787234 118.723404 31.4893617 125.957447 47.2340426 121.276596 49.3617021 114.893617',
      '55.3191489 99.1489362 51.0638298 114.468085 52.3404255 120.851064 68.0851064 125.957447 69.787234 119.148936 69.3617021 108.510638',
    ]},
    { id:'hamstrings', label:'Hamstrings', view:'back', polygons:[
      '28.9361702 122.12766 31.0638298 129.361702 36.5957447 125.957447 35.3191489 135.319149 34.4680851 150.212766 29.3617021 158.297872 28.9361702 146.808511 27.6595745 141.276596 27.2340426 131.489362',
      '71.4893617 121.702128 69.3617021 128.93617 63.8297872 125.957447 65.5319149 136.595745 66.3829787 150.212766 71.0638298 158.297872 71.4893617 147.659574 72.7659574 142.12766 73.6170213 131.914894',
      '38.7234043 125.531915 44.2553191 145.957447 40.4255319 166.808511 36.1702128 152.765957 37.0212766 135.319149',
      '61.7021277 125.531915 63.4042553 136.170213 64.2553191 153.191489 60 166.808511 56.1702128 146.382979',
    ]},
    { id:'calves', label:'Calves', view:'back', polygons:[
      '29.3617021 160.425532 28.5106383 167.234043 24.6808511 179.574468 23.8297872 192.765957 25.5319149 197.021277 28.5106383 193.191489 29.787234 180 31.9148936 171.06383 31.9148936 166.808511',
      '37.4468085 165.106383 35.3191489 167.659574 33.1914894 171.914894 31.0638298 180.425532 30.212766 191.914894 34.0425532 200 38.7234043 190.638298 39.1489362 168.93617',
      '62.9787234 165.106383 61.2765957 168.510638 61.7021277 190.638298 66.3829787 199.574468 70.6382979 191.914894 68.9361702 179.574468 66.8085106 170.212766',
      '70.6382979 160.425532 72.3404255 168.510638 75.7446809 179.148936 76.5957447 192.765957 74.4680851 196.595745 72.3404255 193.617021 70.6382979 179.574468 68.0851064 168.085106',
    ]},
    { id:'hip_flexors', label:'Hip Flexors', view:'back', polygons:[
      '48.0851064 122.978723 44.6808511 122.978723 41.2765957 125.531915 45.106383 144.255319 48.5106383 135.744681 48.9361702 129.361702',
      '51.9148936 122.553191 55.7446809 123.404255 59.1489362 125.957447 54.893617 144.255319 51.9148936 136.170213 51.0638298 129.361702',
    ]},
  ];

  /* ── Internal state ───────────────────────────────────────────────── */
  let _getTodayKey = null;
  let _getWorkoutDone = null;
  let _currentView = 'front';
  let _initialized = false;

  /* ── Build card DOM ───────────────────────────────────────────────── */
  function buildCard() {
    const root = document.getElementById('mmCardRoot');
    if (!root) return;

    // Header
    const hdr = document.createElement('div');
    hdr.className = 'mm-hdr';
    hdr.innerHTML = `
      <span class="mm-ey">Muscle Map</span>
      <div class="mm-tog" id="mmTog">
        <button class="mm-tog-btn active" data-view="front">Front</button>
        <button class="mm-tog-btn" data-view="back">Back</button>
      </div>`;
    root.appendChild(hdr);

    // SVG wrap
    const wrap = document.createElement('div');
    wrap.className = 'mm-wrap';
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 200');
    svg.setAttribute('xmlns', NS);
    svg.classList.add('mm-body-svg');
    svg.id = 'mmSvg';

    MUSCLE_DEFS.forEach(def => {
      def.polygons.forEach(pts => {
        const poly = document.createElementNS(NS, 'polygon');
        poly.setAttribute('points', pts);
        poly.setAttribute('data-muscle-id', def.id);
        poly.setAttribute('data-view', def.view);
        poly.classList.add('ms-muscle');
        if (def.view !== 'front') poly.style.display = 'none';
        svg.appendChild(poly);
      });
    });

    wrap.appendChild(svg);
    root.appendChild(wrap);

    // Tooltip (absolute inside the card)
    const tip = document.createElement('div');
    tip.className = 'ms-tip';
    tip.id = 'msTip';
    tip.innerHTML = '<div class="ms-tip-name"></div><div class="ms-tip-ex"></div>';
    root.appendChild(tip);

    setupInteractions(root, svg, tip);
  }

  /* ── Wire up toggle + tooltip ─────────────────────────────────────── */
  function setupInteractions(card, svg, tip) {
    const cardRect = () => card.getBoundingClientRect();

    const showTip = (clientX, clientY, def) => {
      const r = cardRect();
      tip.querySelector('.ms-tip-name').textContent = def.label;

      const st = window.loadGymState ? window.loadGymState() : null;
      const allExs = st && st.exercises ? st.exercises : [];
      const explicit = allExs.filter(e => e.muscles && e.muscles.includes(def.id)).map(e => e.name);
      const fallbackKws = MUSCLE_EXERCISES[def.id] || [];
      const fromKeyword = allExs
        .filter(e => !e.muscles || !e.muscles.length)
        .filter(e => fallbackKws.some(kw => e.name.toLowerCase().includes(kw.toLowerCase())))
        .map(e => e.name);
      const names = [...new Set([...explicit, ...fromKeyword])].slice(0, 6);
      tip.querySelector('.ms-tip-ex').textContent = (names.length ? names : fallbackKws.slice(0, 4)).join('\n');

      const tx = clientX - r.left + 10;
      const ty = clientY - r.top - 36;
      tip.style.left = Math.min(tx, r.width - 195) + 'px';
      tip.style.top  = Math.max(ty, 4) + 'px';
      tip.classList.add('visible');
    };
    const hideTip = () => tip.classList.remove('visible');

    // Build a map from muscle-id+view → def for tooltip lookups
    const defMap = {};
    MUSCLE_DEFS.forEach(d => { defMap[d.id + '_' + d.view] = d; });

    svg.querySelectorAll('.ms-muscle').forEach(poly => {
      const mid  = poly.dataset.muscleId;
      const view = poly.dataset.view;
      const def  = defMap[mid + '_' + view];
      if (!def) return;
      poly.addEventListener('mouseenter', e => showTip(e.clientX, e.clientY, def));
      poly.addEventListener('mousemove',  e => showTip(e.clientX, e.clientY, def));
      poly.addEventListener('mouseleave', hideTip);
      poly.addEventListener('touchstart', e => {
        e.preventDefault();
        const t = e.touches[0];
        showTip(t.clientX, t.clientY, def);
      }, { passive: false });
      poly.addEventListener('touchend', hideTip);
    });

    // Toggle front / back
    const tog = document.getElementById('mmTog');
    if (tog) {
      tog.querySelectorAll('.mm-tog-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const v = btn.dataset.view;
          _currentView = v;
          tog.querySelectorAll('.mm-tog-btn').forEach(b => b.classList.toggle('active', b === btn));
          svg.querySelectorAll('.ms-muscle').forEach(el => {
            el.style.display = el.dataset.view === v ? '' : 'none';
          });
          hideTip();
        });
      });
    }
  }

  /* ── Update colours based on workout log ─────────────────────────── */
  function updateMuscleMap() {
    const svg = document.getElementById('mmSvg');
    if (!svg) return;

    const loadState = window.loadGymState || (() => ({ logs: {}, exercises: [], workoutDone: {} }));
    const state     = loadState();
    const today     = _getTodayKey ? _getTodayKey() : (window.gymToday ? window.gymToday() : new Date().toISOString().slice(0, 10));
    const workoutDone = _getWorkoutDone ? _getWorkoutDone() : (state.workoutDone || {});
    const isDone    = !!(workoutDone[today]);

    // Map exercises logged today → active muscle IDs
    const active = new Set();
    Object.entries(state.logs || {}).forEach(([exId, logs]) => {
      if (!logs.some(l => l.date === today)) return;
      const ex = (state.exercises || []).find(e => e.id === exId);
      if (!ex) return;
      if (ex.muscles && ex.muscles.length) {
        ex.muscles.forEach(mid => active.add(mid));
      } else {
        // Fallback keyword matching for exercises without explicit muscle mapping
        const name = ex.name.toLowerCase();
        Object.entries(MUSCLE_EXERCISES).forEach(([mid, kws]) => {
          if (kws.some(kw => name.includes(kw.toLowerCase()))) active.add(mid);
        });
      }
    });

    svg.querySelectorAll('.ms-muscle').forEach(el => {
      const mid = el.dataset.muscleId;
      el.classList.remove('ms-active', 'ms-done');
      if (active.has(mid)) el.classList.add(isDone ? 'ms-done' : 'ms-active');
    });
  }

  /* ── Public API ───────────────────────────────────────────────────── */
  window.initMuscleMap = function (state, getTodayKey, getWorkoutDone) {
    _getTodayKey    = getTodayKey    || null;
    _getWorkoutDone = getWorkoutDone || null;
    if (!_initialized) {
      _initialized = true;
      requestAnimationFrame(() => {
        buildCard();
        updateMuscleMap();
      });
    } else {
      updateMuscleMap();
    }
  };

  // Called from switchTab when gym tab is activated
  window._mmUpdate = updateMuscleMap;
})();

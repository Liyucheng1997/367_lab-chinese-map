(function () {
  'use strict';

  if (!window.L) {
    document.getElementById('map').innerHTML =
      '<p style="padding:24px;line-height:1.8">地图库 Leaflet 加载失败，请检查网络连接后刷新页面。</p>';
    return;
  }

  const { periods, categories } = window.HISTORY;
  const GEO = window.GEO;
  const $ = (id) => document.getElementById(id);

  // ---------- 工具 ----------
  const toLL = (ring) => ring.map(([x, y]) => [y, x]);
  const fmtYear = (y, approx) => {
    const s = y < 0 ? '公元前' + (-y) + '年' : (y < 1000 ? '公元' + y + '年' : y + '年');
    return (approx ? '约' : '') + s;
  };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const KIND_ORDER = { culture: 0, neighbor: 1, lost: 2, protectorate: 3, main: 4 };
  const KIND_TAG = { main: '', neighbor: '', protectorate: '羁縻/都护', lost: '被割占', culture: '文化区' };

  function polityStyle(p) {
    const base = { color: p.color, fillColor: p.color, className: 'polity is-hidden kind-' + p.kind, lineJoin: 'round' };
    switch (p.kind) {
      case 'main': return Object.assign(base, { weight: 2.2, opacity: 0.95, fillOpacity: 0.34 });
      case 'protectorate': return Object.assign(base, { weight: 1.6, opacity: 0.9, fillOpacity: 0.15, dashArray: '7 5' });
      case 'lost': return Object.assign(base, { weight: 1.6, opacity: 0.9, fillOpacity: 0.26, dashArray: '4 4' });
      case 'culture': return Object.assign(base, { weight: 1.5, opacity: 0.85, fillOpacity: 0.22, dashArray: '2 5' });
      default: return Object.assign(base, { weight: 1.2, opacity: 0.8, fillOpacity: 0.22 });
    }
  }

  // ---------- 地图 ----------
  const map = L.map('map', {
    zoomControl: false,
    minZoom: 3,
    maxZoom: 9,
    zoomSnap: 0.25,
    worldCopyJump: false,
    attributionControl: true
  }).setView([36, 105], 4);
  L.control.zoom({ position: 'topleft', zoomInTitle: '放大', zoomOutTitle: '缩小' }).addTo(map);
  L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);

  const BASEMAPS = {
    physical: () => L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Physical_Map/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 8, maxZoom: 9, attribution: 'Tiles &copy; Esri &mdash; US National Park Service'
    }),
    relief: () => L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 13, maxZoom: 9, attribution: 'Tiles &copy; Esri &mdash; Esri, USGS'
    }),
    amap: () => L.tileLayer('https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}', {
      subdomains: '1234', maxZoom: 9, attribution: '&copy; 高德地图'
    }),
    none: () => null
  };
  let baseLayer = null;
  function setBase(key) {
    if (baseLayer) map.removeLayer(baseLayer);
    baseLayer = (BASEMAPS[key] || BASEMAPS.physical)();
    if (baseLayer) baseLayer.addTo(map);
    try { localStorage.setItem('cnmap.base', key); } catch (e) { /* 忽略 */ }
  }

  // 现代国界参照
  const modernLayer = L.layerGroup([GEO.PRC_MAIN, GEO.TAIWAN, GEO.HAINAN].map((r) =>
    L.polygon(toLL(r), { color: '#333', weight: 1, opacity: 0.55, dashArray: '3 4', fill: false, interactive: false })
  ));

  // ---------- 状态 ----------
  let current = -1;
  let group = null;            // 当前时期的图层组
  let eventMarkers = [];       // 与 period.events 下标对应
  let activeEvent = -1;
  let playTimer = null;
  const catOff = new Set();

  const optModern = $('optModern'), optEvents = $('optEvents'), optFit = $('optFit'), optBase = $('optBase');

  // ---------- 时间轴 ----------
  const chips = $('chips'), ribbon = $('ribbon');
  const total = periods.reduce((s, p) => s + Math.max(p.end - p.start, 1), 0);
  periods.forEach((p, i) => {
    const b = document.createElement('button');
    b.innerHTML = `${p.name}<small>${p.range}</small>`;
    b.style.setProperty('--chip-c', p.color);
    b.title = `${p.name}（${p.range}）`;
    b.addEventListener('click', () => { stop(); show(i); });
    chips.appendChild(b);

    const s = document.createElement('span');
    s.style.width = (Math.max(p.end - p.start, 1) / total * 100) + '%';
    s.style.background = p.color;
    s.title = `${p.name} ${p.range}`;
    s.addEventListener('click', () => { stop(); show(i); });
    ribbon.appendChild(s);
  });

  // 事件类别筛选
  const catFilter = $('catFilter');
  Object.entries(categories).forEach(([k, v]) => {
    const b = document.createElement('button');
    b.innerHTML = `<i style="background:${v.color}"></i>${v.name}`;
    b.addEventListener('click', () => {
      if (catOff.has(k)) catOff.delete(k); else catOff.add(k);
      b.classList.toggle('off', catOff.has(k));
      applyEventFilter();
    });
    catFilter.appendChild(b);
  });

  // ---------- 渲染一个时期 ----------
  function show(i, opts = {}) {
    if (i < 0 || i >= periods.length) return;
    const first = current === -1;
    current = i;
    const p = periods[i];
    activeEvent = -1;

    // 淡出旧图层
    if (group) {
      const old = group;
      old.eachLayer((l) => { const el = l.getElement && l.getElement(); if (el) el.classList.add('is-hidden'); });
      setTimeout(() => map.removeLayer(old), 650);
    }

    group = L.layerGroup().addTo(map);
    const newEls = [];
    const fitTargets = [];

    // 政权多边形（底层在前）
    const polities = p.polities.slice().sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
    polities.forEach((pol) => {
      const style = polityStyle(pol);
      const layer = L.polygon(pol.rings.map((r) => [toLL(r)]), style);
      layer.bindTooltip(`${pol.name}${KIND_TAG[pol.kind] ? '<br><small>' + KIND_TAG[pol.kind] + '</small>' : ''}`, { sticky: true, direction: 'top', opacity: 0.9 });
      layer.on('mouseover', () => layer.setStyle({ fillOpacity: style.fillOpacity + 0.15, weight: style.weight + 1 }));
      layer.on('mouseout', () => layer.setStyle({ fillOpacity: style.fillOpacity, weight: style.weight }));
      layer.on('click', () => flyToPolity(layer));
      layer.addTo(group);
      pol._layer = layer;
      newEls.push(layer);
      if (pol.kind === 'main' || pol.kind === 'protectorate' || pol.kind === 'lost' || pol.kind === 'culture') fitTargets.push(layer.getBounds());
    });

    // 名称标签
    polities.forEach((pol) => {
      const at = pol.label || centroid(pol.rings[0]);
      const m = L.marker([at[1], at[0]], {
        icon: L.divIcon({ className: `polity-label is-hidden ${pol.kind}`, html: `<span style="--c:${pol.color}">${escapeHtml(pol.name)}</span>`, iconSize: [0, 0] }),
        interactive: false, keyboard: false
      }).addTo(group);
      newEls.push(m);
    });

    // 南海诸岛等
    if (p.islands) {
      GEO.ISLANDS.forEach((is) => {
        const ll = [is.at[1], is.at[0]];
        newEls.push(L.circleMarker(ll, { radius: 3, color: p.color, weight: 1, fillOpacity: 0.8, className: 'polity is-hidden', interactive: false }).addTo(group));
        newEls.push(L.marker([ll[0] - 0.45, ll[1]], {
          icon: L.divIcon({ className: 'polity-label island is-hidden', html: `<span>${is.name}</span>`, iconSize: [0, 0] }),
          interactive: false, keyboard: false
        }).addTo(group));
      });
    }

    // 都城
    if (p.capital) {
      const cm = L.marker([p.capital.at[1], p.capital.at[0]], {
        icon: L.divIcon({ className: 'capital-marker polity-label is-hidden', html: '<div>★</div>', iconSize: [0, 0] }),
        keyboard: false
      }).bindTooltip('都城：' + p.capital.name, { direction: 'right', offset: [8, 0] }).addTo(group);
      newEls.push(cm);
    }

    // 事件标记
    eventMarkers = [];
    const used = [];
    p.events.forEach((ev, k) => {
      const cat = categories[ev.c] || { color: '#666' };
      let [x, y] = ev.at;
      // 同一位置的事件稍作错开，避免完全重叠
      let n = used.filter(([ux, uy]) => Math.abs(ux - x) < 0.15 && Math.abs(uy - y) < 0.15).length;
      used.push([x, y]);
      if (n) { const a = n * 2.1; x += Math.cos(a) * 0.22 * Math.ceil(n / 3); y += Math.sin(a) * 0.18 * Math.ceil(n / 3); }
      const m = L.marker([y, x], {
        icon: L.divIcon({ className: 'ev-marker', html: `<div style="background:${cat.color}">${ev.c}</div>`, iconSize: [0, 0] }),
        title: ev.t, riseOnHover: true
      });
      m.bindPopup(popupHtml(ev), { maxWidth: 280, autoPanPadding: [40, 40] });
      m.on('click', () => selectEvent(k, { fromMap: true }));
      m.on('popupclose', () => { if (activeEvent === k) setActiveEvent(-1); });
      eventMarkers.push(m);
    });
    applyEventFilter();

    // 淡入（用定时器而非 requestAnimationFrame，后台标签页中也能正常显示）
    setTimeout(() => {
      newEls.forEach((l) => { const el = l.getElement && l.getElement(); if (el) el.classList.remove('is-hidden'); });
    }, 40);

    // 视野
    if (optFit.checked || first) {
      let bounds = p.view ? L.latLngBounds([p.view[0][1], p.view[0][0]], [p.view[1][1], p.view[1][0]]) : null;
      if (!bounds) fitTargets.forEach((b) => { bounds = bounds ? bounds.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast()); });
      if (!bounds && p.events.length) bounds = L.latLngBounds(p.events.map((e) => [e.at[1], e.at[0]]));
      if (bounds) {
        const fitOpts = { padding: [30, 30], maxZoom: 6 };
        const size = map.getSize();
        if (first || opts.instant || !size.x || !size.y) map.fitBounds(bounds, fitOpts);
        else {
          try { map.flyToBounds(bounds, Object.assign({ duration: 1.1 }, fitOpts)); }
          catch (e) { map.fitBounds(bounds, fitOpts); }
        }
      }
    }

    renderPanel(p);
    updateTimeline();
    if (location.hash.slice(1) !== p.id) history.replaceState(null, '', '#' + p.id);
    document.title = `${p.name} · 中华上下五千年疆域变迁`;
  }

  function centroid(ring) {
    let x = 0, y = 0;
    ring.forEach((pt) => { x += pt[0]; y += pt[1]; });
    return [x / ring.length, y / ring.length];
  }

  function flyToPolity(layer) {
    map.flyToBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 7, duration: 0.8 });
  }

  function popupHtml(ev) {
    const cat = categories[ev.c];
    return `<div class="pop-year">${fmtYear(ev.y, ev.approx)} · <span style="color:${cat.color}">${cat.name}</span></div>
      <div class="pop-title">${escapeHtml(ev.t)}</div>
      <p class="pop-desc">${escapeHtml(ev.d)}</p>`;
  }

  // ---------- 面板 ----------
  function renderPanel(p) {
    document.documentElement.style.setProperty('--period-color', p.color);
    $('pName').textContent = p.name;
    $('pSub').textContent = p.sub || '';
    $('pRange').textContent = p.range;
    $('pSnapshot').textContent = p.snapshot || '—';
    $('pCapital').textContent = p.capital ? p.capital.name : '—';
    $('pArea').textContent = p.area || '—';
    $('pSummary').textContent = p.summary;

    const legend = $('pLegend');
    legend.innerHTML = '';
    p.polities.slice().sort((a, b) => KIND_ORDER[b.kind] - KIND_ORDER[a.kind]).forEach((pol) => {
      const li = document.createElement('li');
      const cls = pol.kind === 'protectorate' || pol.kind === 'culture' ? 'sw dashed' : (pol.kind === 'lost' ? 'sw lost' : 'sw');
      li.innerHTML = `<span class="${cls}" style="background:${pol.color};border-color:${pol.color}"></span>${escapeHtml(pol.name)}${KIND_TAG[pol.kind] ? `<span class="tag">${KIND_TAG[pol.kind]}</span>` : ''}`;
      li.title = '点击定位';
      li.addEventListener('click', () => pol._layer && flyToPolity(pol._layer));
      legend.appendChild(li);
    });

    const list = $('pEvents');
    list.innerHTML = '';
    const sorted = p.events.map((e, k) => [e, k]).sort((a, b) => a[0].y - b[0].y);
    sorted.forEach(([ev, k]) => {
      const cat = categories[ev.c];
      const li = document.createElement('li');
      li.dataset.k = k;
      li.dataset.c = ev.c;
      li.style.setProperty('--dot', cat.color);
      li.innerHTML = `<span class="ev-year">${fmtYear(ev.y, ev.approx)}</span><span class="ev-title">${escapeHtml(ev.t)}</span><span class="ev-cat" style="background:${cat.color}">${ev.c}</span><div class="ev-desc">${escapeHtml(ev.d)}</div>`;
      li.addEventListener('click', () => selectEvent(k));
      list.appendChild(li);
    });
    $('pCount').textContent = `（${p.events.length}）`;
    applyEventFilter();
    $('panel').querySelector('.panel-inner').scrollTop = 0;
  }

  function applyEventFilter() {
    const showMarkers = optEvents.checked;
    eventMarkers.forEach((m, k) => {
      const ev = periods[current].events[k];
      const visible = showMarkers && !catOff.has(ev.c);
      if (visible && !group.hasLayer(m)) group.addLayer(m);
      if (!visible && group.hasLayer(m)) group.removeLayer(m);
    });
    document.querySelectorAll('#pEvents li').forEach((li) => {
      li.style.display = catOff.has(li.dataset.c) ? 'none' : '';
    });
  }

  function setActiveEvent(k) {
    activeEvent = k;
    document.querySelectorAll('#pEvents li').forEach((li) => li.classList.toggle('active', Number(li.dataset.k) === k));
    eventMarkers.forEach((m, j) => { const el = m.getElement(); if (el) el.classList.toggle('active', j === k); });
  }

  function selectEvent(k, opts = {}) {
    stop();
    setActiveEvent(k);
    const li = document.querySelector(`#pEvents li[data-k="${k}"]`);
    if (li) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (opts.fromMap) return;
    const m = eventMarkers[k];
    const ll = m.getLatLng();
    map.flyTo(ll, Math.max(map.getZoom(), 5), { duration: 0.8 });
    map.once('moveend', () => {
      if (group.hasLayer(m)) m.openPopup();
      else L.popup({ maxWidth: 280 }).setLatLng(ll).setContent(popupHtml(periods[current].events[k])).openOn(map);
    });
  }

  function updateTimeline() {
    [...chips.children].forEach((b, i) => b.classList.toggle('active', i === current));
    [...ribbon.children].forEach((s, i) => s.classList.toggle('active', i === current));
    const b = chips.children[current];
    if (b) chips.scrollTo({ left: b.offsetLeft - chips.offsetLeft - (chips.clientWidth - b.offsetWidth) / 2, behavior: 'smooth' });
  }

  // ---------- 播放 ----------
  const btnPlay = $('btnPlay');
  function play() {
    if (current >= periods.length - 1) show(0);
    btnPlay.textContent = '❚❚';
    btnPlay.classList.add('playing');
    btnPlay.title = '暂停（空格）';
    playTimer = setInterval(() => {
      if (current >= periods.length - 1) { stop(); return; }
      show(current + 1);
    }, 4500);
  }
  function stop() {
    if (!playTimer) return;
    clearInterval(playTimer);
    playTimer = null;
    btnPlay.textContent = '▶';
    btnPlay.classList.remove('playing');
    btnPlay.title = '自动播放（空格）';
  }
  btnPlay.addEventListener('click', () => (playTimer ? stop() : play()));
  $('btnPrev').addEventListener('click', () => { stop(); show(current - 1); });
  $('btnNext').addEventListener('click', () => { stop(); show(current + 1); });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === 'ArrowLeft') { stop(); show(current - 1); }
    else if (e.key === 'ArrowRight') { stop(); show(current + 1); }
    else if (e.key === ' ') { e.preventDefault(); playTimer ? stop() : play(); }
  });

  // ---------- 选项 ----------
  optModern.addEventListener('change', () => { optModern.checked ? modernLayer.addTo(map) : map.removeLayer(modernLayer); });
  optEvents.addEventListener('change', applyEventFilter);
  optBase.addEventListener('change', () => setBase(optBase.value));

  const panel = $('panel');
  $('panelToggle').addEventListener('click', () => {
    panel.classList.toggle('collapsed');
    $('panelToggle').textContent = panel.classList.contains('collapsed') ? '⟨' : '⟩';
    setTimeout(() => map.invalidateSize(), 320);
  });

  window.addEventListener('hashchange', () => {
    const i = periods.findIndex((p) => p.id === location.hash.slice(1));
    if (i >= 0 && i !== current) { stop(); show(i); }
  });

  // ---------- 启动 ----------
  let savedBase = 'physical';
  try { savedBase = localStorage.getItem('cnmap.base') || 'physical'; } catch (e) { /* 忽略 */ }
  optBase.value = BASEMAPS[savedBase] ? savedBase : 'physical';
  setBase(optBase.value);
  modernLayer.addTo(map);

  const startIdx = Math.max(0, periods.findIndex((p) => p.id === location.hash.slice(1)));
  show(startIdx, { instant: true });
})();

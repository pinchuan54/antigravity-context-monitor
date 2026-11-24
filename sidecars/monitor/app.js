(() => {
  const POLL_MS = 1500;
  const $ = (id) => document.getElementById(id);

  const params = new URLSearchParams(location.search);
  const currentConv = () => window.sidecar?.conversationId || params.get('conversationId') || '';

  const state = {
    etag: '',
    snap: null,
    timer: null,
    inflight: false,
  };

  // ---------- Theme sync (matches host light/dark CSS variables) ----------
  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f8fa)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
  }
  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // ---------- Formatters ----------
  function fmtTokens(n) {
    const v = Number(n) || 0;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 10_000) return `${(v / 1_000).toFixed(1)}K`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(2)}K`;
    return String(Math.round(v));
  }

  function fmtPct(p) {
    const v = Number(p) || 0;
    if (v >= 100) return `${v.toFixed(0)}%`;
    return `${v.toFixed(1)}%`;
  }

  function parseHumanTokens(str) {
    const s = String(str || '').trim().toLowerCase().replace(/,/g, '');
    const m = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(s);
    if (!m) return null;
    let val = parseFloat(m[1]);
    if (m[2] === 'k') val *= 1000;
    else if (m[2] === 'm') val *= 1_000_000;
    return Math.round(val);
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  // ---------- Network ----------
  async function apiGet(path) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { method: 'GET' });
    if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
    return res.json();
  }

  async function apiPost(path, payload) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let msg = `POST ${path}: ${res.status}`;
      try {
        const err = await res.json();
        if (err?.error) msg = err.error;
      } catch {
        // ignore
      }
      throw new Error(msg);
    }
    return res.json();
  }

  // ---------- Sparkline ----------
  function renderSparkline(history, thresholdVal) {
    const svg = $('sparkline');
    if (!history || history.length === 0) {
      svg.innerHTML = '';
      return;
    }

    const W = 320;
    const H = 84;
    const padT = 8;
    const padB = 8;
    const maxData = Math.max(...history.map((h) => h.totalInput), 1);
    const maxY = Math.max(maxData * 1.15, thresholdVal * 1.08);
    const plotH = H - padT - padB;

    const toY = (v) => padT + plotH * (1 - Math.min(v, maxY) / maxY);
    const toX = (i) =>
      history.length === 1 ? W * 0.5 : (i / (history.length - 1)) * (W - 12) + 6;

    const pts = history.map((h, i) => [toX(i), toY(h.totalInput)]);
    const lineD = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const areaD = `${lineD} L${pts[pts.length - 1][0].toFixed(1)},${(H - padB).toFixed(1)} L${pts[0][0].toFixed(1)},${(H - padB).toFixed(1)} Z`;

    const thY = toY(thresholdVal);
    const lastPt = pts[pts.length - 1];

    svg.innerHTML = `
      <defs>
        <linearGradient id="cmAreaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--cm-accent)" stop-opacity="0.28" />
          <stop offset="100%" stop-color="var(--cm-accent)" stop-opacity="0.02" />
        </linearGradient>
      </defs>
      <line x1="0" y1="${thY.toFixed(1)}" x2="${W}" y2="${thY.toFixed(1)}"
            stroke="var(--cm-warn)" stroke-width="1.2" stroke-dasharray="4 4" opacity="0.85" />
      <text x="${W - 4}" y="${Math.max(11, thY - 4).toFixed(1)}"
            text-anchor="end" fill="var(--cm-warn)" font-size="9.5" font-weight="600">
        Threshold ${fmtTokens(thresholdVal)}
      </text>
      ${history.length > 1 ? `<path d="${areaD}" fill="url(#cmAreaGrad)" />` : ''}
      ${history.length > 1 ? `<path d="${lineD}" fill="none" stroke="var(--cm-accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />` : ''}
      <circle cx="${lastPt[0].toFixed(1)}" cy="${lastPt[1].toFixed(1)}" r="3.5" fill="var(--cm-accent)" />
    `;
  }

  // ---------- Render ----------
  function render(snap) {
    state.snap = snap;

    const conv = snap.conversationId || currentConv();
    $('footer-conv').textContent = conv ? `Session ${conv.slice(0, 8)}` : 'No active session';

    if (snap.status !== 'ready') {
      $('state-ready').classList.add('hidden');
      $('state-empty').classList.remove('hidden');
      $('model-badge').textContent = snap.modelLabel || 'Idle';
      if (snap.status === 'no_conversation') {
        $('empty-title').textContent = 'No active conversation';
        $('empty-desc').textContent = 'Open Context Monitor from the auxiliary side pane inside an Antigravity conversation.';
      } else {
        $('empty-title').textContent = 'Waiting for first model turn';
        $('empty-desc').textContent = 'Token usage and compaction threshold progress will appear automatically once the conversation starts.';
      }
      return;
    }

    $('state-empty').classList.add('hidden');
    $('state-ready').classList.remove('hidden');

    const { usage, threshold, contextWindow, health } = snap;
    $('model-badge').textContent = snap.modelLabel || snap.model || 'Model';
    $('model-badge').title = snap.model || '';

    // Hero section
    const heroCard = $('hero-card');
    heroCard.classList.remove('health-normal', 'health-warning', 'health-danger');
    heroCard.classList.add(`health-${health}`);

    $('threshold-pct').textContent = fmtPct(usage.thresholdPercent);
    $('current-tokens').textContent = fmtTokens(usage.currentContextTokens);
    $('threshold-tokens').textContent = fmtTokens(threshold.value);

    const cappedTotalPct = Math.min(100, usage.thresholdPercent);
    const cachedRatio =
      usage.currentContextTokens > 0
        ? usage.cacheReadTokens / usage.currentContextTokens
        : 0;
    const cachedPct = cappedTotalPct * cachedRatio;
    const uncachedPct = Math.max(0, cappedTotalPct - cachedPct);

    $('bar-cached').style.width = `${cachedPct.toFixed(2)}%`;
    $('bar-uncached').style.width = `${uncachedPct.toFixed(2)}%`;
    $('threshold-bar-wrap').setAttribute('aria-valuenow', String(Math.round(cappedTotalPct)));

    $('legend-cached').textContent = fmtTokens(usage.cacheReadTokens);
    $('legend-uncached').textContent = fmtTokens(usage.uncachedInputTokens);

    const banner = $('status-banner');
    banner.className = `status-banner ${health}`;
    if (usage.thresholdPercent >= 100) {
      $('status-text').textContent = 'At or above threshold — automatic compaction may trigger on the next turn';
    } else if (health === 'danger') {
      $('status-text').textContent = `Compaction imminent · ~${fmtTokens(usage.remainingToThreshold)} tokens left — consider /compact`;
    } else if (health === 'warning') {
      $('status-text').textContent = `Approaching threshold · ~${fmtTokens(usage.remainingToThreshold)} tokens remaining`;
    } else {
      $('status-text').textContent = `Healthy · ${fmtTokens(usage.remainingToThreshold)} tokens remaining before compaction`;
    }

    // Native window bar
    $('window-summary').textContent = `${fmtTokens(usage.currentContextTokens)} / ${fmtTokens(contextWindow)} (${fmtPct(usage.windowPercent)})`;
    $('window-fill').style.width = `${Math.min(100, usage.windowPercent).toFixed(2)}%`;
    const markerPos = Math.min(98, Math.max(4, (threshold.value / contextWindow) * 100));
    $('window-marker').style.left = `${markerPos.toFixed(2)}%`;
    $('marker-tag').textContent = `Compact ${fmtTokens(threshold.value)}`;

    // Metrics grid
    $('metric-cache').textContent = fmtPct(usage.cacheHitRate * 100);
    $('metric-cache-sub').textContent = `${fmtTokens(usage.cacheReadTokens)} cached`;
    $('metric-output').textContent = fmtTokens(usage.outputTokens);
    $('metric-next').textContent = `Next ~${fmtTokens(usage.projectedNextInput)}`;
    $('metric-turns').textContent = String(snap.plannerTurns);
    $('metric-steps').textContent = `${snap.totalSteps} steps`;

    // Sparkline
    $('chart-meta').textContent = `Last ${snap.history.length} calls`;
    renderSparkline(snap.history, threshold.value);

    // Compaction notice
    if (snap.compactions && snap.compactions.length > 0 && snap.observedCompactionPeak) {
      $('compaction-notice').classList.remove('hidden');
      const last = snap.compactions[snap.compactions.length - 1];
      const count = snap.compactions.length;
      $('compaction-title').textContent = `${count} compaction${count > 1 ? 's' : ''} detected in this session`;
      $('compaction-desc').textContent = `Latest drop: ~${fmtTokens(last.beforeTokens)} → ${fmtTokens(last.afterTokens)}`;
    } else {
      $('compaction-notice').classList.add('hidden');
    }

    // Threshold settings
    $('threshold-source').textContent = threshold.sourceLabel || 'Reference';
    document.querySelectorAll('#presets .chip').forEach((btn) => {
      const val = Number(btn.dataset.val);
      btn.classList.toggle('active', Math.abs(val - threshold.value) < 1000);
    });

    const input = $('threshold-input');
    if (document.activeElement !== input) {
      input.placeholder = `Current ${fmtTokens(threshold.value)} (e.g. 256K / 512K)`;
    }

    $('footer-time').textContent = usage.lastUpdatedAt
      ? `Updated ${fmtTime(usage.lastUpdatedAt)}`
      : '';
  }

  // ---------- Polling ----------
  async function refresh(force = false) {
    if (state.inflight) return;
    state.inflight = true;
    try {
      const conv = currentConv();
      const qs = new URLSearchParams();
      if (conv) qs.set('conversationId', conv);
      if (!force && state.etag) qs.set('etag', state.etag);

      const data = await apiGet(`/api/context?${qs.toString()}`);
      $('live-pill').classList.remove('offline');
      $('live-text').textContent = 'Live';

      if (data.unchanged) return;
      state.etag = data.etag || '';
      render(data);
    } catch (err) {
      $('live-pill').classList.add('offline');
      $('live-text').textContent = 'Disconnected';
      console.error('[context-monitor]', err);
    } finally {
      state.inflight = false;
    }
  }

  function startPolling() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => {
      if (!document.hidden) refresh(false);
    }, POLL_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh(false);
  });

  // ---------- Threshold actions ----------
  async function applyThreshold(val) {
    try {
      await apiPost('/api/threshold', {
        action: 'set',
        threshold: val,
        scope: 'global',
      });
      state.etag = '';
      await refresh(true);
    } catch (err) {
      alert(`Failed to save threshold: ${err.message}`);
    }
  }

  $('presets').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    const val = Number(btn.dataset.val);
    if (val > 0) applyThreshold(val);
  });

  $('threshold-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('threshold-input');
    const parsed = parseHumanTokens(input.value);
    if (!parsed) {
      input.focus();
      return;
    }
    input.value = '';
    await applyThreshold(parsed);
  });

  $('btn-reset').addEventListener('click', async () => {
    try {
      await apiPost('/api/threshold', { action: 'reset', scope: 'global' });
      state.etag = '';
      await refresh(true);
    } catch (err) {
      alert(`Failed to reset threshold: ${err.message}`);
    }
  });

  $('btn-calibrate').addEventListener('click', async () => {
    const peak = state.snap?.observedCompactionPeak;
    if (peak) {
      await applyThreshold(Math.round(peak / 1000) * 1000);
    }
  });

  // Boot
  refresh(true);
  startPolling();
})();

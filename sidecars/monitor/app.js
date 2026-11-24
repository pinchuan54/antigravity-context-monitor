(() => {
  const POLL_MS = 1500;
  const $ = (id) => document.getElementById(id);

  const params = new URLSearchParams(location.search);
  const currentConv = () => window.sidecar?.conversationId || params.get('conversationId') || '';

  const I18N = {
    en: {
      title: 'Context Monitor',
      live: 'Live',
      disconnected: 'Disconnected',
      liveTitle: 'Auto-refreshes every 1.5s (zero token overhead)',
      langSwitch: '中',
      langTitle: '切换到简体中文',
      idle: 'Idle',
      noConvTitle: 'No active conversation',
      noConvDesc: 'Open Context Monitor from the auxiliary side pane inside an Antigravity conversation.',
      waitTitle: 'Waiting for first model turn',
      waitDesc: 'Token usage and compaction threshold progress will appear automatically once the conversation starts.',
      heroLabel: 'Context Usage / Compaction Threshold',
      cached: 'Cached',
      uncached: 'Uncached',
      windowLabel: 'Native Model Window',
      compactTag: (v) => `Compact ${v}`,
      cacheLabel: 'Cache Hit',
      cacheSub: (v) => `${v} cached`,
      outputLabel: 'Last Output',
      nextBaseline: (v) => `Next ~${v}`,
      callsLabel: 'Model Calls',
      callsVal: (n) => String(n),
      stepsSub: (n) => `${n} steps`,
      growthLabel: 'Context Growth',
      recentCalls: (n) => `Last ${n} calls`,
      thresholdLine: (v) => `Threshold ${v}`,
      compactionTitle: (n) => `${n} compaction${n > 1 ? 's' : ''} detected in this session`,
      compactionDesc: (b, a) => `Latest drop: ~${b} → ${a}`,
      calibrate: 'Calibrate',
      settingsLabel: 'Compaction Threshold',
      apply: 'Apply',
      reset: 'Reset',
      placeholder: (v) => `Current ${v} (e.g. 256K / 512K)`,
      hint: 'Antigravity does not expose its internal compaction ceiling in transcripts. Defaults to 256K and can be adjusted anytime.',
      statusOver: 'At or above threshold — automatic compaction may trigger on the next turn',
      statusDanger: (r) => `Compaction imminent · ~${r} tokens left — consider /compact`,
      statusWarning: (r) => `Approaching threshold · ~${r} tokens remaining`,
      statusNormal: (r) => `Healthy · ${r} tokens remaining before compaction`,
      sourceLabels: {
        custom_model: 'Model custom',
        custom: 'Custom',
        env: 'Env override',
        default: 'Default (256K)',
      },
      session: (id) => (id ? `Session ${id.slice(0, 8)}` : 'No active session'),
      updated: (t) => (t ? `Updated ${t}` : ''),
      errSave: (m) => `Failed to save threshold: ${m}`,
      errReset: (m) => `Failed to reset threshold: ${m}`,
    },
    zh: {
      title: '上下文监控',
      live: '实时',
      disconnected: '连接断开',
      liveTitle: '每 1.5 秒自动刷新（零 Token 消耗）',
      langSwitch: 'EN',
      langTitle: 'Switch to English',
      idle: '待机',
      noConvTitle: '未检测到当前会话',
      noConvDesc: '请在 Antigravity 对话右侧辅助面板中打开 Context Monitor。',
      waitTitle: '等待首次模型调用',
      waitDesc: '本对话开始后将自动读取真实 Token 用量并展示压缩阈值进度。',
      heroLabel: '当前上下文 / 压缩阈值',
      cached: '缓存命中',
      uncached: '新增输入',
      windowLabel: '模型原生窗口对照',
      compactTag: (v) => `压缩线 ${v}`,
      cacheLabel: '缓存命中率',
      cacheSub: (v) => `命中 ${v}`,
      outputLabel: '本轮输出',
      nextBaseline: (v) => `下轮基线 ~${v}`,
      callsLabel: '模型调用',
      callsVal: (n) => `${n} 次`,
      stepsSub: (n) => `共 ${n} 步`,
      growthLabel: '上下文增长趋势',
      recentCalls: (n) => `最近 ${n} 次调用`,
      thresholdLine: (v) => `压缩阈值 ${v}`,
      compactionTitle: (n) => `本会话已检测到 ${n} 次上下文压缩`,
      compactionDesc: (b, a) => `最近一次压缩前约 ${b} → 压缩后 ${a}`,
      calibrate: '一键校准',
      settingsLabel: '压缩阈值设置',
      apply: '应用',
      reset: '重置',
      placeholder: (v) => `当前 ${v}（如 256K / 512K）`,
      hint: 'Antigravity 未公开内部自动压缩阈值；默认按 256K 估算，可按你的实测随时调整。',
      statusOver: '已达到或超过设定压缩阈值，随时可能触发自动压缩',
      statusDanger: (r) => `即将触发压缩 · 仅剩约 ${r} tokens，建议适时 /compact`,
      statusWarning: (r) => `接近压缩阈值 · 剩余约 ${r} tokens`,
      statusNormal: (r) => `状态充裕 · 距离压缩阈值还剩 ${r} tokens`,
      sourceLabels: {
        custom_model: '模型自定义',
        custom: '自定义',
        env: '环境变量覆盖',
        default: '默认参考值 (256K)',
      },
      session: (id) => (id ? `会话 ${id.slice(0, 8)}` : '未绑定会话'),
      updated: (t) => (t ? `更新于 ${t}` : ''),
      errSave: (m) => `保存阈值失败: ${m}`,
      errReset: (m) => `重置失败: ${m}`,
    },
  };

  function detectInitialLang() {
    const qp = params.get('lang');
    if (qp === 'zh' || qp === 'en') return qp;
    return /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en';
  }

  const state = {
    etag: '',
    snap: null,
    timer: null,
    inflight: false,
    lang: detectInitialLang(),
    langLockedByParam: params.get('lang') === 'zh' || params.get('lang') === 'en',
    connected: true,
  };

  const t = () => I18N[state.lang] || I18N.en;

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

  function applyStaticLabels() {
    const L = t();
    document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en';
    $('app-title').textContent = L.title;
    $('btn-lang').textContent = L.langSwitch;
    $('btn-lang').title = L.langTitle;
    $('live-pill').title = L.liveTitle;
    $('live-text').textContent = state.connected ? L.live : L.disconnected;
    $('lbl-hero').textContent = L.heroLabel;
    $('lbl-cached').textContent = L.cached;
    $('lbl-uncached').textContent = L.uncached;
    $('lbl-window').textContent = L.windowLabel;
    $('lbl-cache').textContent = L.cacheLabel;
    $('lbl-output').textContent = L.outputLabel;
    $('lbl-calls').textContent = L.callsLabel;
    $('lbl-growth').textContent = L.growthLabel;
    $('btn-calibrate').textContent = L.calibrate;
    $('lbl-settings').textContent = L.settingsLabel;
    $('btn-apply').textContent = L.apply;
    $('btn-reset').textContent = L.reset;
    $('lbl-hint').textContent = L.hint;
  }

  // ---------- Sparkline ----------
  function renderSparkline(history, thresholdVal) {
    const svg = $('sparkline');
    if (!history || history.length === 0) {
      svg.innerHTML = '';
      return;
    }

    const L = t();
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
        ${L.thresholdLine(fmtTokens(thresholdVal))}
      </text>
      ${history.length > 1 ? `<path d="${areaD}" fill="url(#cmAreaGrad)" />` : ''}
      ${history.length > 1 ? `<path d="${lineD}" fill="none" stroke="var(--cm-accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />` : ''}
      <circle cx="${lastPt[0].toFixed(1)}" cy="${lastPt[1].toFixed(1)}" r="3.5" fill="var(--cm-accent)" />
    `;
  }

  // ---------- Render ----------
  function render(snap) {
    state.snap = snap;
    if (!state.langLockedByParam && (snap.lang === 'en' || snap.lang === 'zh')) {
      state.lang = snap.lang;
    }

    applyStaticLabels();
    const L = t();

    const conv = snap.conversationId || currentConv();
    $('footer-conv').textContent = L.session(conv);

    if (snap.status !== 'ready') {
      $('state-ready').classList.add('hidden');
      $('state-empty').classList.remove('hidden');
      $('model-badge').textContent = snap.modelLabel || L.idle;
      if (snap.status === 'no_conversation') {
        $('empty-title').textContent = L.noConvTitle;
        $('empty-desc').textContent = L.noConvDesc;
      } else {
        $('empty-title').textContent = L.waitTitle;
        $('empty-desc').textContent = L.waitDesc;
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
    const rem = fmtTokens(usage.remainingToThreshold);
    if (usage.thresholdPercent >= 100) {
      $('status-text').textContent = L.statusOver;
    } else if (health === 'danger') {
      $('status-text').textContent = L.statusDanger(rem);
    } else if (health === 'warning') {
      $('status-text').textContent = L.statusWarning(rem);
    } else {
      $('status-text').textContent = L.statusNormal(rem);
    }

    // Native window bar
    $('window-summary').textContent = `${fmtTokens(usage.currentContextTokens)} / ${fmtTokens(contextWindow)} (${fmtPct(usage.windowPercent)})`;
    $('window-fill').style.width = `${Math.min(100, usage.windowPercent).toFixed(2)}%`;
    const markerPos = Math.min(98, Math.max(4, (threshold.value / contextWindow) * 100));
    $('window-marker').style.left = `${markerPos.toFixed(2)}%`;
    $('marker-tag').textContent = L.compactTag(fmtTokens(threshold.value));

    // Metrics grid
    $('metric-cache').textContent = fmtPct(usage.cacheHitRate * 100);
    $('metric-cache-sub').textContent = L.cacheSub(fmtTokens(usage.cacheReadTokens));
    $('metric-output').textContent = fmtTokens(usage.outputTokens);
    $('metric-next').textContent = L.nextBaseline(fmtTokens(usage.projectedNextInput));
    $('metric-turns').textContent = L.callsVal(snap.plannerTurns);
    $('metric-steps').textContent = L.stepsSub(snap.totalSteps);

    // Sparkline
    $('chart-meta').textContent = L.recentCalls(snap.history.length);
    renderSparkline(snap.history, threshold.value);

    // Compaction notice
    if (snap.compactions && snap.compactions.length > 0 && snap.observedCompactionPeak) {
      $('compaction-notice').classList.remove('hidden');
      const last = snap.compactions[snap.compactions.length - 1];
      $('compaction-title').textContent = L.compactionTitle(snap.compactions.length);
      $('compaction-desc').textContent = L.compactionDesc(
        fmtTokens(last.beforeTokens),
        fmtTokens(last.afterTokens)
      );
    } else {
      $('compaction-notice').classList.add('hidden');
    }

    // Threshold settings
    $('threshold-source').textContent =
      L.sourceLabels[threshold.source] || L.sourceLabels.default;
    document.querySelectorAll('#presets .chip').forEach((btn) => {
      const val = Number(btn.dataset.val);
      btn.classList.toggle('active', Math.abs(val - threshold.value) < 1000);
    });

    const input = $('threshold-input');
    if (document.activeElement !== input) {
      input.placeholder = L.placeholder(fmtTokens(threshold.value));
    }

    $('footer-time').textContent = L.updated(fmtTime(usage.lastUpdatedAt));
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
      state.connected = true;
      $('live-pill').classList.remove('offline');
      $('live-text').textContent = t().live;

      if (data.unchanged) return;
      state.etag = data.etag || '';
      render(data);
    } catch (err) {
      state.connected = false;
      $('live-pill').classList.add('offline');
      $('live-text').textContent = t().disconnected;
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

  // ---------- User actions ----------
  $('btn-lang').addEventListener('click', async () => {
    const next = state.lang === 'zh' ? 'en' : 'zh';
    state.lang = next;
    state.langLockedByParam = false;
    if (state.snap) render({ ...state.snap, lang: next });
    else applyStaticLabels();
    try {
      await apiPost('/api/threshold', { action: 'set_lang', lang: next });
      state.etag = '';
    } catch {
      // UI already switched locally even if persistence fails.
    }
  });

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
      alert(t().errSave(err.message));
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
      alert(t().errReset(err.message));
    }
  });

  $('btn-calibrate').addEventListener('click', async () => {
    const peak = state.snap?.observedCompactionPeak;
    if (peak) {
      await applyThreshold(Math.round(peak / 1000) * 1000);
    }
  });

  // Boot
  applyStaticLabels();
  refresh(true);
  startPolling();
})();

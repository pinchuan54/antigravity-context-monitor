/**
 * Context Monitor Sidecar Backend
 *
 * Reads the current conversation's on-disk transcript (read-only):
 *   <appData>/brain/<conversationId>/.system_generated/logs/transcript.jsonl
 *
 * Computes real-time context window usage, prompt cache hit rate, compaction
 * threshold progress, and detected compaction events with zero token overhead.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9a-f-]{8,}$/i;
const DEFAULT_COMPACT_THRESHOLD = 256_000;
const MIN_THRESHOLD = 8_000;
const MAX_THRESHOLD = 2_097_152;
const HISTORY_LIMIT = 28;

// ---------------------------------------------------------------------------
// App data & persistent settings paths
// ---------------------------------------------------------------------------

function findAppDataDirs() {
  const dirs = [];
  const seen = new Set();
  const add = (dir) => {
    if (!dir || seen.has(dir)) return;
    if (existsSync(join(dir, 'brain'))) {
      seen.add(dir);
      dirs.push(dir);
    }
  };

  const execDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (execDataDir) {
    for (let d = execDataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        add(dirname(d));
        break;
      }
    }
  }

  const geminiRoot = join(homedir(), '.gemini');
  add(join(geminiRoot, 'antigravity'));
  add(join(geminiRoot, 'antigravity-ide'));
  add(join(geminiRoot, 'antigravity-cli'));
  return dirs;
}

function getSettingsPath() {
  const base =
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
    process.env.PLUGIN_DATA ||
    __dirname;
  return join(base, 'context-monitor-settings.json');
}

function loadSettings() {
  const path = getSettingsPath();
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      return {
        customDefaultThreshold:
          typeof raw.customDefaultThreshold === 'number' &&
          Number.isFinite(raw.customDefaultThreshold)
            ? raw.customDefaultThreshold
            : null,
        modelThresholds:
          raw.modelThresholds && typeof raw.modelThresholds === 'object'
            ? raw.modelThresholds
            : {},
      };
    }
  } catch {
    // Ignore malformed settings and fall back to defaults.
  }
  return { customDefaultThreshold: null, modelThresholds: {} };
}

function saveSettings(settings) {
  const path = getSettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2), 'utf-8');
}

let settingsVersion = 1;

// ---------------------------------------------------------------------------
// Model metadata & threshold resolution
// ---------------------------------------------------------------------------

function inferContextWindow(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return 1_048_576;
  if (m.includes('gemini')) return 1_048_576;
  if (m.includes('claude')) {
    return m.includes('1m') ? 1_000_000 : 200_000;
  }
  if (m.includes('gpt-5') || m.includes('gpt-4.1')) return 1_000_000;
  if (m.includes('gpt-4') || m.includes('o1') || m.includes('o3') || m.includes('o4')) {
    return 200_000;
  }
  return 1_048_576;
}

function formatModelLabel(model) {
  if (!model) return '未检测到模型';
  return String(model)
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => {
      if (/^\d+(\.\d+)?$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

function parseOverrideValue(raw, contextWindow) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;

  const pctMatch = /^(\d+(?:\.\d+)?)\s*%$/.exec(s);
  if (pctMatch) {
    const pct = parseFloat(pctMatch[1]);
    if (pct > 0 && pct <= 100) {
      return Math.round((contextWindow * pct) / 100);
    }
    return null;
  }

  const unitMatch = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(s);
  if (unitMatch) {
    let val = parseFloat(unitMatch[1]);
    if (unitMatch[2] === 'k') val *= 1000;
    else if (unitMatch[2] === 'm') val *= 1_000_000;
    val = Math.round(val);
    if (val >= MIN_THRESHOLD && val <= MAX_THRESHOLD) return val;
  }
  return null;
}

function resolveThreshold(model, contextWindow, settings) {
  if (model && typeof settings.modelThresholds[model] === 'number') {
    return {
      value: settings.modelThresholds[model],
      source: 'custom_model',
      sourceLabel: '当前模型自定义',
    };
  }

  if (typeof settings.customDefaultThreshold === 'number') {
    return {
      value: settings.customDefaultThreshold,
      source: 'custom',
      sourceLabel: '全局自定义',
    };
  }

  const envRaw = process.env.AGY_CLI_AUTO_COMPACT_OVERRIDE;
  const envVal = parseOverrideValue(envRaw, contextWindow);
  if (envVal) {
    return {
      value: envVal,
      source: 'env',
      sourceLabel: '环境变量覆盖',
    };
  }

  const fallback =
    contextWindow < DEFAULT_COMPACT_THRESHOLD
      ? Math.round(contextWindow * 0.8)
      : DEFAULT_COMPACT_THRESHOLD;

  return {
    value: fallback,
    source: 'default',
    sourceLabel: '默认参考值 (256K)',
  };
}

// ---------------------------------------------------------------------------
// Transcript lookup & cached parsing
// ---------------------------------------------------------------------------

const transcriptCache = new Map(); // path -> { mtimeMs, size, parsed }

function findTranscriptPath(conversationId) {
  const dirs = findAppDataDirs();
  for (const appData of dirs) {
    const candidate = join(
      appData,
      'brain',
      conversationId,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    );
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function parseTranscript(filePath) {
  const st = statSync(filePath);
  const cached = transcriptCache.get(filePath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.parsed;
  }

  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split(/\r?\n/);

  let totalSteps = 0;
  let latestModel = '';
  let latestStep = null;
  let totalUncachedInput = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;
  let plannerTurns = 0;

  const history = [];
  const compactions = [];
  let prevTotalInput = 0;
  let explicitCheckpointPending = false;
  let explicitCheckpointStep = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      // Partial line currently being appended; skip safely.
      continue;
    }

    totalSteps += 1;

    const stepType = String(obj.type || '').toUpperCase();
    if (stepType.includes('CHECKPOINT') || stepType.includes('COMPACT')) {
      explicitCheckpointPending = true;
      explicitCheckpointStep = {
        stepIndex: typeof obj.step_index === 'number' ? obj.step_index : totalSteps - 1,
        createdAt: obj.created_at || null,
      };
    }

    if (typeof obj.model === 'string' && obj.model) {
      latestModel = obj.model;
    }

    const hasTokens =
      typeof obj.input_tokens === 'number' ||
      typeof obj.cache_read_tokens === 'number' ||
      typeof obj.output_tokens === 'number';

    if (!hasTokens) continue;

    const uncachedInput = Number(obj.input_tokens) || 0;
    const cacheRead = Number(obj.cache_read_tokens) || 0;
    const output = Number(obj.output_tokens) || 0;
    const totalInput = uncachedInput + cacheRead;

    if (totalInput <= 0 && output <= 0) continue;

    plannerTurns += 1;
    totalUncachedInput += uncachedInput;
    totalCacheRead += cacheRead;
    totalOutput += output;

    const stepIndex = typeof obj.step_index === 'number' ? obj.step_index : totalSteps - 1;
    const createdAt = obj.created_at || null;

    if (explicitCheckpointPending && prevTotalInput > 0 && totalInput < prevTotalInput) {
      compactions.push({
        stepIndex: explicitCheckpointStep?.stepIndex ?? stepIndex,
        createdAt: explicitCheckpointStep?.createdAt ?? createdAt,
        beforeTokens: prevTotalInput,
        afterTokens: totalInput,
        kind: 'checkpoint',
      });
      explicitCheckpointPending = false;
      explicitCheckpointStep = null;
    } else if (
      prevTotalInput >= 60_000 &&
      totalInput > 0 &&
      prevTotalInput - totalInput >= 30_000 &&
      totalInput <= prevTotalInput * 0.65
    ) {
      compactions.push({
        stepIndex,
        createdAt,
        beforeTokens: prevTotalInput,
        afterTokens: totalInput,
        kind: 'detected_drop',
      });
    }

    const point = {
      stepIndex,
      createdAt,
      model: obj.model || latestModel,
      inputTokens: uncachedInput,
      cacheReadTokens: cacheRead,
      outputTokens: output,
      totalInput,
    };

    latestStep = point;
    history.push(point);
    prevTotalInput = totalInput;
  }

  const parsed = {
    mtimeMs: st.mtimeMs,
    size: st.size,
    totalSteps,
    plannerTurns,
    model: latestModel,
    latestStep,
    cumulative: {
      inputTokens: totalUncachedInput,
      cacheReadTokens: totalCacheRead,
      outputTokens: totalOutput,
      totalTokens: totalUncachedInput + totalCacheRead + totalOutput,
    },
    history: history.slice(-HISTORY_LIMIT),
    compactions,
  };

  // Keep cache bounded to avoid memory growth across many conversations.
  if (transcriptCache.size > 32) {
    const oldestKey = transcriptCache.keys().next().value;
    transcriptCache.delete(oldestKey);
  }
  transcriptCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, parsed });
  return parsed;
}

function buildSnapshot(conversationId, clientEtag) {
  const settings = loadSettings();

  if (!conversationId || !ID_RE.test(conversationId)) {
    return {
      status: 'no_conversation',
      conversationId: conversationId || null,
      etag: `none|${settingsVersion}`,
    };
  }

  const filePath = findTranscriptPath(conversationId);
  if (!filePath) {
    const fallbackWindow = 1_048_576;
    const threshold = resolveThreshold('', fallbackWindow, settings);
    return {
      status: 'waiting',
      conversationId,
      model: '',
      modelLabel: '等待对话开始',
      contextWindow: fallbackWindow,
      threshold,
      etag: `waiting|${conversationId}|${settingsVersion}`,
    };
  }

  const parsed = parseTranscript(filePath);
  const etag = `${conversationId}|${parsed.mtimeMs}|${parsed.size}|${settingsVersion}`;
  if (clientEtag && clientEtag === etag) {
    return { unchanged: true, etag };
  }

  const contextWindow = inferContextWindow(parsed.model);
  const threshold = resolveThreshold(parsed.model, contextWindow, settings);

  if (!parsed.latestStep) {
    return {
      status: 'waiting',
      conversationId,
      model: parsed.model,
      modelLabel: formatModelLabel(parsed.model),
      contextWindow,
      threshold,
      totalSteps: parsed.totalSteps,
      etag,
    };
  }

  const latest = parsed.latestStep;
  const currentContextTokens = latest.totalInput;
  const projectedNextInput = currentContextTokens + latest.outputTokens;
  const cacheHitRate =
    currentContextTokens > 0 ? latest.cacheReadTokens / currentContextTokens : 0;
  const thresholdPercent =
    threshold.value > 0 ? (currentContextTokens / threshold.value) * 100 : 0;
  const windowPercent =
    contextWindow > 0 ? (currentContextTokens / contextWindow) * 100 : 0;
  const remainingToThreshold = Math.max(0, threshold.value - currentContextTokens);

  let health = 'normal';
  if (thresholdPercent >= 90) health = 'danger';
  else if (thresholdPercent >= 75) health = 'warning';

  const latestCompaction =
    parsed.compactions.length > 0
      ? parsed.compactions[parsed.compactions.length - 1]
      : null;

  return {
    status: 'ready',
    conversationId,
    etag,
    model: parsed.model,
    modelLabel: formatModelLabel(parsed.model),
    contextWindow,
    threshold,
    health,
    usage: {
      currentContextTokens,
      uncachedInputTokens: latest.inputTokens,
      cacheReadTokens: latest.cacheReadTokens,
      outputTokens: latest.outputTokens,
      projectedNextInput,
      cacheHitRate,
      thresholdPercent,
      windowPercent,
      remainingToThreshold,
      lastUpdatedAt: latest.createdAt,
      stepIndex: latest.stepIndex,
    },
    cumulative: parsed.cumulative,
    plannerTurns: parsed.plannerTurns,
    totalSteps: parsed.totalSteps,
    history: parsed.history,
    compactions: parsed.compactions,
    observedCompactionPeak: latestCompaction ? latestCompaction.beforeTokens : null,
    settings,
  };
}

// ---------------------------------------------------------------------------
// Static file serving & SidecarApp routes
// ---------------------------------------------------------------------------

const app = new SidecarApp();

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

for (const [route, [filename, contentType]] of Object.entries(STATIC_FILES)) {
  app.page(route, () => {
    const content = readFileSync(join(__dirname, filename), 'utf-8');
    return new Response(content, {
      contentType,
      headers: { 'Cache-Control': 'no-cache' },
    });
  });
}

app.api('/api/health', () => ({ ok: true, name: 'context-monitor' }), 'GET');

app.api(
  '/api/context',
  (data) => {
    const conv = data.conversationId || app.config.conversationId || '';
    return buildSnapshot(conv, data.etag || '');
  },
  'GET'
);

app.api(
  '/api/threshold',
  (data) => {
    const settings = loadSettings();
    const action = data.action || 'set';
    const scope = data.scope === 'model' ? 'model' : 'global';
    const model = typeof data.model === 'string' ? data.model.trim() : '';

    if (action === 'reset') {
      if (scope === 'model' && model) {
        delete settings.modelThresholds[model];
      } else {
        settings.customDefaultThreshold = null;
      }
      saveSettings(settings);
      settingsVersion += 1;
      return { ok: true, settings };
    }

    const rawValue = Number(data.threshold);
    if (!Number.isFinite(rawValue)) {
      return new Response(JSON.stringify({ error: '无效的阈值数值' }), {
        status: 400,
        contentType: 'application/json',
      });
    }

    const clamped = Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, Math.round(rawValue)));
    if (scope === 'model' && model) {
      settings.modelThresholds[model] = clamped;
    } else {
      settings.customDefaultThreshold = clamped;
    }

    saveSettings(settings);
    settingsVersion += 1;
    return { ok: true, threshold: clamped, settings };
  },
  'POST'
);

app.run();

const fs = require('fs');
const path = require('path');

const METRICS_DIR = path.join(process.cwd(), '.claude-flow', 'metrics');
const USAGE_FILE = path.join(METRICS_DIR, 'provider-usage.json');

const DEFAULT_PROVIDERS = ['opus', 'sonnet', 'haiku'];

function ensureDir() {
  if (!fs.existsSync(METRICS_DIR)) {
    fs.mkdirSync(METRICS_DIR, { recursive: true });
  }
}

function getUsage() {
  try {
    if (!fs.existsSync(USAGE_FILE)) return createInitial();
    const data = fs.readFileSync(USAGE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return createInitial();
  }
}

function createInitial(sessionId = 'default') {
  const data = {
    sessionId,
    startedAt: new Date().toISOString(),
    providers: {}
  };
  
  DEFAULT_PROVIDERS.forEach(p => {
    data.providers[p] = { calls: 0, tokens: 0, ttfb_avg_ms: 0, last_used: null };
  });
  
  return data;
}

function saveUsage(data) {
  ensureDir();
  fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function track(provider, opts = {}) {
  const { tokens = 0, ttfb_ms = 0 } = opts;
  const data = getUsage();
  const name = provider.toLowerCase();
  
  if (!data.providers[name]) {
    data.providers[name] = { calls: 0, tokens: 0, ttfb_avg_ms: 0, last_used: null };
  }
  
  const p = data.providers[name];
  const oldCalls = p.calls;
  p.calls += 1;
  p.tokens += tokens;
  p.last_used = new Date().toISOString();
  
  if (ttfb_ms > 0) {
    p.ttfb_avg_ms = Math.round(((p.ttfb_avg_ms * oldCalls) + ttfb_ms) / p.calls);
  }
  
  saveUsage(data);
  return data;
}

function resetSession(sessionId) {
  const data = createInitial(sessionId);
  saveUsage(data);
  return data;
}

module.exports = {
  track,
  getUsage,
  resetSession
};

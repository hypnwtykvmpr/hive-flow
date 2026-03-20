#!/usr/bin/env node
/**
 * Delegation rate monitor — reads enforcer-activity.jsonl (default 1h),
 * warns / escalates global enforcement when queen direct-work dominates.
 *
 * Usage: node enforcer-monitor.cjs [hoursWindow]
 */
const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const ACTIVITY = path.join(PROJECT_DIR, '.hive-flow', 'enforcement', 'enforcer-activity.jsonl');
const REPORTS = path.join(PROJECT_DIR, '.hive-flow', 'enforcement', 'enforcer-reports.jsonl');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseArgsHours() {
  const a = process.argv[2];
  const h = a ? parseFloat(a, 10) : 1;
  return Number.isFinite(h) && h > 0 ? h : 1;
}

function loadRecentLines(filePath, cutoffMs) {
  if (!fs.existsSync(filePath)) return [];
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = o.timestamp || o.ts;
    if (!ts) continue;
    const t = new Date(ts).getTime();
    if (t >= cutoffMs) out.push(o);
  }
  return out;
}

function main() {
  // Allow stdin JSON override for window hours (optional hook use)
  let hours = parseArgsHours();
  try {
    const j = JSON.parse(readStdin() || '{}');
    if (typeof j.hours === 'number' && j.hours > 0) hours = j.hours;
  } catch { /* ignore */ }

  const cutoff = Date.now() - hours * 3600000;
  const rows = loadRecentLines(ACTIVITY, cutoff);
  const MIN_SAMPLES = 3;
  const byQueen = {};
  for (const r of rows) {
    const id = r.agentId;
    if (!id) continue;
    if (!byQueen[id]) byQueen[id] = { delegation: 0, direct: 0, coordination: 0 };
    if (r.event === 'delegation') byQueen[id].delegation++;
    else if (r.event === 'direct-work') byQueen[id].direct++;
    else if (r.event === 'coordination') byQueen[id].coordination++;
  }

  /** delegation / (delegation + direct); thresholds: >=0.7 PASS, 0.5–0.7 WARNING, <0.5 ESCALATE */
  function queenVerdict(c) {
    const denom = c.delegation + c.direct;
    if (denom < MIN_SAMPLES) {
      return { delegationRate: denom === 0 ? null : c.delegation / denom, verdict: 'INSUFFICIENT_DATA' };
    }
    const rate = c.delegation / denom;
    if (rate >= 0.7) return { delegationRate: rate, verdict: 'PASS' };
    if (rate >= 0.5) return { delegationRate: rate, verdict: 'WARNING' };
    return { delegationRate: rate, verdict: 'ESCALATE' };
  }

  const summary = [];
  let verdict = 'PASS';
  let severity = null;
  let worstRate = null;
  let worstId = null;

  for (const [qid, c] of Object.entries(byQueen)) {
    const { delegationRate, verdict: qv } = queenVerdict(c);
    summary.push({ queenId: qid, ...c, delegationRate, queenVerdict: qv });
    if (qv === 'ESCALATE') {
      verdict = 'ESCALATE';
      severity = 'critical';
      if (delegationRate !== null && (worstRate === null || delegationRate < worstRate)) {
        worstRate = delegationRate;
        worstId = qid;
      }
    } else if (qv === 'WARNING' && verdict !== 'ESCALATE') {
      verdict = 'WARNING';
      severity = 'normal';
      if (delegationRate !== null && (worstRate === null || delegationRate < worstRate)) {
        worstRate = delegationRate;
        worstId = qid;
      }
    }
  }

  const report = {
    ts: new Date().toISOString(),
    hoursWindow: hours,
    verdict,
    worstQueenId: worstId,
    worstDelegationRate: worstRate,
    perQueen: summary,
  };

  try {
    fs.mkdirSync(path.dirname(REPORTS), { recursive: true });
    fs.appendFileSync(REPORTS, JSON.stringify(report) + '\n', 'utf8');
  } catch { /* ignore */ }

  if (verdict === 'ESCALATE' || verdict === 'WARNING') {
    try {
      const enf = require('./enforcement.cjs');
      const state = enf.getState();
      const reason = `[ENFORCER MONITOR] Queen ${worstId} delegationRate=${worstRate.toFixed(2)} (${verdict})`;
      enf.escalate(state, reason, severity);
      enf.saveState(state);
    } catch { /* ignore */ }
  }

  process.stdout.write(JSON.stringify(report));
}

main();

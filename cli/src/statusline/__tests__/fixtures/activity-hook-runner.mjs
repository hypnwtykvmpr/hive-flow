#!/usr/bin/env node
// Spawned by the f16a A15/A25 regressions to drive the tracker from a REAL
// separate process. In-process calls cannot prove create-once behaviour across
// processes, which is exactly what the claim protocol has to guarantee.
//
// HF_BARRIER: when set, spin until that file exists before touching any state.
// The test spawns every child ASYNCHRONOUSLY, waits for all of them to reach
// the barrier, then releases them so they genuinely contend. (spawnSync would
// serialise them and prove nothing about concurrency.)
//
// HF_READY: when set, the child creates this file once it is parked on the
// barrier, so the test can wait for real readiness instead of sleeping.
//
// Imports the COMPILED tracker (`HF_TRACKER_MODULE`), so `npm run build` must
// have run first. A missing module fails loudly rather than skipping silently.
import { existsSync, writeFileSync } from 'node:fs';

const [, , event, payloadJson] = process.argv;

if (process.env.HF_READY) {
  try {
    writeFileSync(process.env.HF_READY, '1');
  } catch {
    /* readiness is best effort */
  }
}

if (process.env.HF_BARRIER) {
  const deadline = Date.now() + 30_000;
  while (!existsSync(process.env.HF_BARRIER)) {
    if (Date.now() > deadline) {
      console.error('barrier timeout');
      process.exit(2);
    }
    // Tight spin: the window we are trying to hit is sub-millisecond.
  }
}

const { recordHookEvent } = await import(process.env.HF_TRACKER_MODULE);
recordHookEvent(event, JSON.parse(payloadJson ?? '{}'));
process.exit(0);

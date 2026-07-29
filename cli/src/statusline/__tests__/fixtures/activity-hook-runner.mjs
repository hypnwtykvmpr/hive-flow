#!/usr/bin/env node
// Spawned by the f16a A15/A25 regressions to drive the tracker from a REAL
// separate process. In-process calls cannot prove create-once behaviour across
// processes, which is exactly what the claim protocol has to guarantee.
//
// Imports the COMPILED tracker (`HF_TRACKER_MODULE`), so `npm run build` must
// have run first. A missing module fails loudly rather than skipping silently.
const [, , event, payloadJson] = process.argv;
const { recordHookEvent } = await import(process.env.HF_TRACKER_MODULE);
recordHookEvent(event, JSON.parse(payloadJson ?? '{}'));
process.exit(0);

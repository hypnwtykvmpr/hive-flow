#!/usr/bin/env node
/**
 * Smoke tests for enforcement.cjs edge cases and error paths
 */
const path = require('path');
const crypto = require('crypto');

const e = require(path.resolve(__dirname, '..', '.claude', 'helpers', 'enforcement.cjs'));

console.log('=== ENFORCEMENT EDGE CASE TESTS ===\n');

// Helper to generate a valid pipeline-stage-complete token (mimics hook-handler.cjs logic)
function generateValidStageToken(stageName) {
  const key = e.getOrCreateHmacKey();
  const tokenTs = Date.now();
  const payload = 'pipeline-stage-complete:' + stageName + ':' + tokenTs;
  const sig = crypto.createHmac('sha256', key).update(payload).digest('hex');
  return tokenTs + '.' + sig;
}

var allPass = true;
function assert(name, condition) {
  console.log('  ' + name + ': ' + (condition ? 'PASS' : 'FAIL'));
  if (!condition) allPass = false;
}

// TEST 1: completePipelineStage with no caller token
console.log('TEST 1: completePipelineStage("t","s") -- no caller token');
var r1 = e.completePipelineStage('t', 's');
console.log('  Result: ' + JSON.stringify(r1));
assert('rejects no token', !r1.success && r1.reason.toLowerCase().indexOf('no caller token') >= 0);

// TEST 2: completePipelineStage with expired/malformed token
console.log('\nTEST 2: completePipelineStage("t","s","expired.bad") -- malformed token');
var r2 = e.completePipelineStage('t', 's', 'expired.bad');
console.log('  Result: ' + JSON.stringify(r2));
assert('rejects malformed', !r2.success && r2.reason.toLowerCase().indexOf('expired or malformed') >= 0);

// TEST 3: overridePipeline with no caller token
console.log('\nTEST 3: overridePipeline("reason") -- no caller token');
var r3 = e.overridePipeline('reason');
console.log('  Result: ' + JSON.stringify(r3));
assert('rejects no token', !r3.success && r3.reason.indexOf('Caller authentication required') >= 0);

// TEST 4: resetEnforcement
console.log('\nTEST 4: resetEnforcement() -- level 0, violations 0');
var r4 = e.resetEnforcement();
console.log('  Result: ' + JSON.stringify(r4));
assert('level is 0', r4.level === 0);
assert('violations is 0', r4.violations === 0);

// TEST 5: Valid token, no active pipeline
console.log('\nTEST 5: completePipelineStage with valid token, no active pipeline');
e.resetPipeline();
var validToken = generateValidStageToken('some-stage');
var r5 = e.completePipelineStage('t', 'some-stage', validToken);
console.log('  Generated token prefix: ' + validToken.substring(0, 30) + '...');
console.log('  Result: ' + JSON.stringify(r5));
assert('auth passes, no pipeline', !r5.success && r5.reason === 'No active pipeline');

// BONUS TEST 6: Valid format but bad HMAC signature
console.log('\nBONUS TEST 6: completePipelineStage with valid format but bad HMAC');
var badToken = Date.now() + '.' + 'a'.repeat(64);
var r6 = e.completePipelineStage('t', 'some-stage', badToken);
console.log('  Result: ' + JSON.stringify(r6));
assert('rejects bad signature', !r6.success && r6.reason.indexOf('signature invalid') >= 0);

// BONUS TEST 7: Expired timestamp (>30s old)
console.log('\nBONUS TEST 7: completePipelineStage with expired timestamp (>30s old)');
var key = e.getOrCreateHmacKey();
var oldTs = Date.now() - 60000;
var payload7 = 'pipeline-stage-complete:some-stage:' + oldTs;
var sig7 = crypto.createHmac('sha256', key).update(payload7).digest('hex');
var expiredToken = oldTs + '.' + sig7;
var r7 = e.completePipelineStage('t', 'some-stage', expiredToken);
console.log('  Result: ' + JSON.stringify(r7));
assert('rejects expired token', !r7.success && r7.reason.indexOf('expired or malformed') >= 0);

console.log('\n=== ALL TESTS COMPLETE ===');
console.log('Overall: ' + (allPass ? 'ALL PASS' : 'SOME FAILURES'));
process.exit(allPass ? 0 : 1);

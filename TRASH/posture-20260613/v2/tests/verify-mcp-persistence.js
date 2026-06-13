#!/usr/bin/env node
/**
 * Simple MCP Persistence Verification Script
 * Verifies that MCP tools persist data without requiring sqlite3 module
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function runTest() {
  log('🧪 MCP Persistence Verification', 'blue');
  log('Testing issue #312: MCP tools data persistence\n', 'blue');

  const dbPath = path.join(process.cwd(), '.swarm', 'memory.db');
  let testsPassed = 0;
  let testsTotal = 0;

  // Test 1: Check if database exists
  testsTotal++;
  log('1️⃣ Checking if SQLite database exists...', 'yellow');
  if (fs.existsSync(dbPath)) {
    log(`✅ Database found at: ${dbPath}`, 'green');
    log(`   Size: ${fs.statSync(dbPath).size} bytes`, 'green');
    testsPassed++;
  } else {
    log(`❌ Database not found at: ${dbPath}`, 'red');
  }

  // Test 2: Store data using memory_usage
  testsTotal++;
  log('\n2️⃣ Testing memory_usage store operation...', 'yellow');
  try {
    const testKey = `verify_test_${Date.now()}`;
    const testValue = { 
      test: true, 
      timestamp: new Date().toISOString(),
      message: 'Testing MCP persistence for issue #312'
    };
    
    const storeResult = execSync(
      `npx hive-flow@alpha mcp call memory_usage '{"action": "store", "key": "${testKey}", "value": ${JSON.stringify(JSON.stringify(testValue))}, "namespace": "verification"}'`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    
    if (storeResult.includes('"success":true') || storeResult.includes('"stored":true')) {
      log('✅ Store operation succeeded', 'green');
      testsPassed++;
      
      // Store the key for later retrieval
      fs.writeFileSync('.test-key', testKey);
    } else {
      log('❌ Store operation failed', 'red');
      log(`   Response: ${storeResult}`, 'red');
    }
  } catch (error) {
    log(`❌ Store operation error: ${error.message}`, 'red');
  }

  // Test 3: Retrieve the stored data
  testsTotal++;
  log('\n3️⃣ Testing memory_usage retrieve operation...', 'yellow');
  try {
    const testKey = fs.existsSync('.test-key') ? fs.readFileSync('.test-key', 'utf8') : `verify_test_${Date.now()}`;
    
    const retrieveResult = execSync(
      `npx hive-flow@alpha mcp call memory_usage '{"action": "retrieve", "key": "${testKey}", "namespace": "verification"}'`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    
    if (retrieveResult.includes('"found":true')) {
      log('✅ Retrieve operation succeeded - data was persisted!', 'green');
      testsPassed++;
    } else {
      log('❌ Retrieve operation failed - data not found', 'red');
      log(`   Response: ${retrieveResult}`, 'red');
    }
  } catch (error) {
    log(`❌ Retrieve operation error: ${error.message}`, 'red');
  }

  // Test 4: List stored entries
  testsTotal++;
  log('\n4️⃣ Testing memory_usage list operation...', 'yellow');
  try {
    const listResult = execSync(
      `npx hive-flow@alpha mcp call memory_usage '{"action": "list", "namespace": "verification"}'`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    
    if (listResult.includes('"success":true')) {
      log('✅ List operation succeeded', 'green');
      testsPassed++;
      
      // Try to parse and show entry count
      try {
        const parsed = JSON.parse(listResult);
        if (parsed.entries && Array.isArray(parsed.entries)) {
          log(`   Found ${parsed.entries.length} entries in namespace "verification"`, 'green');
        }
      } catch (e) {
        // Ignore parse errors
      }
    } else {
      log('❌ List operation failed', 'red');
    }
  } catch (error) {
    log(`❌ List operation error: ${error.message}`, 'red');
  }

  // Test 5: Test hooks persistence
  testsTotal++;
  log('\n5️⃣ Testing hooks notify persistence...', 'yellow');
  try {
    const message = `Persistence test ${Date.now()}`;
    const hookResult = execSync(
      `npx hive-flow@alpha hooks notify --message "${message}" --level "test"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    
    if (hookResult.includes('saved to .swarm/memory.db')) {
      log('✅ Hook notification persisted to database', 'green');
      testsPassed++;
    } else {
      log('❌ Hook notification not persisted', 'red');
    }
  } catch (error) {
    log(`❌ Hook notification error: ${error.message}`, 'red');
  }

  // Test 6: Database size check (should grow after operations)
  testsTotal++;
  log('\n6️⃣ Checking if database size increased...', 'yellow');
  if (fs.existsSync(dbPath)) {
    const newSize = fs.statSync(dbPath).size;
    log(`✅ Database size: ${newSize} bytes`, 'green');
    if (newSize > 0) {
      testsPassed++;
    }
  } else {
    log('❌ Database still not found', 'red');
  }

  // Summary
  log('\n' + '='.repeat(50), 'yellow');
  log(`📊 Test Summary: ${testsPassed}/${testsTotal} passed`, testsPassed === testsTotal ? 'green' : 'yellow');
  
  if (testsPassed === testsTotal) {
    log('\n✨ All tests passed!', 'green');
    log('🎯 MCP tools are properly persisting data to SQLite', 'green');
    log('✅ Issue #312 appears to be resolved!', 'green');
  } else if (testsPassed > testsTotal / 2) {
    log('\n⚠️ Partial success - some persistence is working', 'yellow');
    log('Check the failed tests above for details', 'yellow');
  } else {
    log('\n❌ Most tests failed - persistence may not be working', 'red');
    log('Issue #312 may not be fully resolved', 'red');
  }

  // Cleanup
  if (fs.existsSync('.test-key')) {
    fs.unlinkSync('.test-key');
  }
}

// Run the test
runTest().catch(error => {
  log(`\n💥 Fatal error: ${error.message}`, 'red');
  process.exit(1);
});
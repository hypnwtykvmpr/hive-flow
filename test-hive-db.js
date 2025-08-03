#!/usr/bin/env node

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

try {
  const dbPath = path.join(process.cwd(), '.hive-mind', 'hive.db');
  console.log('Opening database at:', dbPath);
  
  const db = new Database(dbPath);
  
  // Check consensus_decisions table
  console.log('\n=== Consensus Decisions ===');
  const consensusCount = db.prepare('SELECT COUNT(*) as count FROM consensus_decisions').get();
  console.log('Total consensus decisions:', consensusCount.count);
  
  if (consensusCount.count > 0) {
    const decisions = db.prepare('SELECT * FROM consensus_decisions LIMIT 5').all();
    console.log('Sample decisions:', decisions);
  }
  
  // Check collective_memory table
  console.log('\n=== Collective Memory ===');
  const memoryCount = db.prepare('SELECT COUNT(*) as count FROM collective_memory').get();
  console.log('Total collective memories:', memoryCount.count);
  
  if (memoryCount.count > 0) {
    const memories = db.prepare('SELECT * FROM collective_memory LIMIT 5').all();
    console.log('Sample memories:', memories);
  }
  
  // Check if there's also a memory.db
  console.log('\n=== Checking memory.db ===');
  const memoryDbPath = path.join(process.cwd(), '.hive-mind', 'memory.db');
  try {
    const memDb = new Database(memoryDbPath);
    const memCount = memDb.prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='memories'").get();
    if (memCount.count > 0) {
      const memoryCount2 = memDb.prepare('SELECT COUNT(*) as count FROM memories').get();
      console.log('Total memories in memory.db:', memoryCount2.count);
      
      if (memoryCount2.count > 0) {
        const memories2 = memDb.prepare('SELECT * FROM memories LIMIT 5').all();
        console.log('Sample memories from memory.db:', memories2);
      }
    }
    memDb.close();
  } catch (e) {
    console.log('No memory.db found or error reading it:', e.message);
  }
  
  db.close();
} catch (error) {
  console.error('Error:', error.message);
}
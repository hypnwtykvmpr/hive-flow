#!/usr/bin/env node
/**
 * Migration Examples and Usage Scenarios
 * Demonstrates different migration scenarios and best practices
 */

import * as chalk from 'chalk';
import * as path from 'path';
import { MigrationRunner } from '../src/migration/migration-runner';
import { MigrationAnalyzer } from '../src/migration/migration-analyzer';
import { RollbackManager } from '../src/migration/rollback-manager';

// Example 1: Basic Project Migration
async function basicMigration() {
  console.log(chalk.bold('\n🔄 Example 1: Basic Project Migration'));
  console.log(chalk.gray('─'.repeat(50)));
  
  const projectPath = path.join(__dirname, '../examples/basic-project');
  
  // Step 1: Analyze the project
  console.log('\n1. Analyzing project...');
  const analyzer = new MigrationAnalyzer();
  const analysis = await analyzer.analyze(projectPath);
  
  if (analysis.hasClaudeFolder) {
    console.log(chalk.green('   ✓ Found existing .claude folder'));
  } else {
    console.log(chalk.yellow('   ! No .claude folder found - fresh installation'));
  }
  
  // Step 2: Run migration
  console.log('\n2. Running migration...');
  const runner = new MigrationRunner({
    projectPath,
    strategy: 'selective',
    preserveCustom: true,
    dryRun: true // Safe mode for example
  });
  
  const result = await runner.run();
  
  if (result.success) {
    console.log(chalk.green('   ✓ Migration completed successfully'));
  } else {
    console.log(chalk.red('   ✗ Migration failed'));
    result.errors.forEach(error => console.log(`     ${error.error}`));
  }
}

// Example 2: Complex Project with Custom Commands
async function complexProjectMigration() {
  console.log(chalk.bold('\n🔧 Example 2: Complex Project Migration'));
  console.log(chalk.gray('─'.repeat(50)));
  
  const projectPath = path.join(__dirname, '../examples/complex-project');
  
  console.log('\n1. Analyzing complex project...');
  const analyzer = new MigrationAnalyzer();
  const analysis = await analyzer.analyze(projectPath);
  
  console.log(`   Custom commands found: ${analysis.customCommands.length}`);
  console.log(`   Conflicting files: ${analysis.conflictingFiles.length}`);
  
  // Show recommended strategy
  const strategy = analysis.customCommands.length > 0 ? 'merge' : 'selective';
  console.log(`   Recommended strategy: ${chalk.cyan(strategy)}`);
  
  console.log('\n2. Creating backup...');
  const rollbackManager = new RollbackManager(projectPath);
  const backup = await rollbackManager.createBackup({
    type: 'pre-migration',
    scenario: 'complex-project-example'
  });
  
  console.log(`   ✓ Backup created: ${backup.metadata.backupId}`);
  
  console.log('\n3. Running merge migration...');
  const runner = new MigrationRunner({
    projectPath,
    strategy: 'merge',
    preserveCustom: true,
    dryRun: true
  });
  
  await runner.run();
}

// Example 3: Rollback Scenario
async function rollbackExample() {
  console.log(chalk.bold('\n↩️  Example 3: Rollback Scenario'));
  console.log(chalk.gray('─'.repeat(50)));
  
  const projectPath = path.join(__dirname, '../examples/rollback-test');
  const rollbackManager = new RollbackManager(projectPath);
  
  console.log('\n1. Listing available backups...');
  const backups = await rollbackManager.listBackups();
  rollbackManager.printBackupSummary(backups);
  
  if (backups.length > 0) {
    console.log('\n2. Rolling back to latest backup...');
    const latestBackup = backups[0];
    
    // In a real scenario, this would prompt for confirmation
    console.log(`   Would rollback to: ${latestBackup.timestamp.toLocaleString()}`);
    console.log(`   Files to restore: ${latestBackup.files.length}`);
  } else {
    console.log(chalk.yellow('   No backups available for rollback'));
  }
}

// Example 4: Migration Validation
async function validationExample() {
  console.log(chalk.bold('\n✅ Example 4: Migration Validation'));
  console.log(chalk.gray('─'.repeat(50)));
  
  const projectPath = path.join(__dirname, '../examples/validation-test');
  
  console.log('\n1. Running post-migration validation...');
  const runner = new MigrationRunner({
    projectPath,
    strategy: 'selective'
  });
  
  const isValid = await runner.validate(true);
  
  if (isValid) {
    console.log(chalk.green('   ✓ All validation checks passed'));
  } else {
    console.log(chalk.red('   ✗ Validation failed'));
  }
}

// Example 5: Batch Migration for Multiple Projects
async function batchMigrationExample() {
  console.log(chalk.bold('\n📦 Example 5: Batch Migration'));
  console.log(chalk.gray('─'.repeat(50)));
  
  const projects = [
    path.join(__dirname, '../examples/project-1'),
    path.join(__dirname, '../examples/project-2'),
    path.join(__dirname, '../examples/project-3')
  ];
  
  console.log(`\n1. Migrating ${projects.length} projects...`);
  
  for (const [index, projectPath] of projects.entries()) {
    console.log(`\n   Project ${index + 1}: ${path.basename(projectPath)}`);
    
    try {
      // Analyze first
      const analyzer = new MigrationAnalyzer();
      const analysis = await analyzer.analyze(projectPath);
      
      // Choose strategy based on analysis
      const strategy = analysis.customCommands.length > 0 ? 'merge' : 'selective';
      
      // Run migration
      const runner = new MigrationRunner({
        projectPath,
        strategy,
        preserveCustom: true,
        force: true, // Non-interactive for batch
        dryRun: true
      });
      
      const result = await runner.run();
      
      if (result.success) {
        console.log(chalk.green(`     ✓ Migration successful`));
      } else {
        console.log(chalk.red(`     ✗ Migration failed`));
      }
      
    } catch (error) {
      console.log(chalk.red(`     ✗ Error: ${error.message}`));
    }
  }
}

// Example 6: Migration Conflict Resolution
async function conflictResolutionExample() {
  console.log(chalk.bold('\n⚠️  Example 6: Conflict Resolution'));
  console.log(chalk.gray('─'.repeat(50)));
  
  const projectPath = path.join(__dirname, '../examples/conflict-project');
  
  console.log('\n1. Analyzing project for conflicts...');
  const analyzer = new MigrationAnalyzer();
  const analysis = await analyzer.analyze(projectPath);
  
  if (analysis.conflictingFiles.length > 0) {
    console.log(chalk.yellow(`   Found ${analysis.conflictingFiles.length} conflicting files:`));
    analysis.conflictingFiles.forEach(file => {
      console.log(`     • ${file}`);
    });
    
    console.log('\n2. Resolution strategies:');
    console.log('     a) Merge strategy - Preserves custom content');
    console.log('     b) Selective strategy - Skip conflicting files');
    console.log('     c) Full strategy - Replace all files (with backup)');
    
    console.log('\n3. Recommended approach:');
    console.log(chalk.cyan('     Use merge strategy with manual review'));
    
  } else {
    console.log(chalk.green('   ✓ No conflicts detected'));
  }
}

// Usage scenarios documentation
function printUsageScenarios() {
  console.log(chalk.bold('\n📚 Migration Usage Scenarios'));
  console.log(chalk.gray('═'.repeat(70)));
  
  const scenarios = [
    {
      title: 'New Project Setup',
      command: 'hive-flow migrate --strategy full',
      description: 'Clean installation of optimized prompts'
    },
    {
      title: 'Existing Project with Custom Commands',
      command: 'hive-flow migrate --strategy merge --preserve-custom',
      description: 'Preserve customizations while upgrading'
    },
    {
      title: 'Safe Migration with Preview',
      command: 'hive-flow migrate --dry-run --verbose',
      description: 'See what would change before migrating'
    },
    {
      title: 'Analysis Only',
      command: 'hive-flow migrate analyze --detailed',
      description: 'Understand project state before migration'
    },
    {
      title: 'Rollback After Issues',
      command: 'hive-flow migrate rollback',
      description: 'Restore previous configuration'
    },
    {
      title: 'Batch Operation',
      command: 'find . -name ".claude" -exec hive-flow migrate {} \\;',
      description: 'Migrate multiple projects at once'
    }
  ];
  
  scenarios.forEach((scenario, index) => {
    console.log(`\n${chalk.bold(`${index + 1}. ${scenario.title}`)}`);
    console.log(`   ${chalk.cyan(scenario.command)}`);
    console.log(`   ${chalk.gray(scenario.description)}`);
  });
  
  console.log(chalk.gray('\n' + '═'.repeat(70)));
}

// Best practices guide
function printBestPractices() {
  console.log(chalk.bold('\n💡 Migration Best Practices'));
  console.log(chalk.gray('═'.repeat(70)));
  
  const practices = [
    'Always analyze projects before migration',
    'Use --dry-run flag to preview changes',
    'Create backups before major migrations',
    'Use selective or merge strategies for projects with customizations',
    'Validate migrations after completion',
    'Keep backups for rollback scenarios',
    'Test functionality after migration',
    'Document custom modifications for future reference'
  ];
  
  practices.forEach((practice, index) => {
    console.log(`${chalk.green(`${index + 1}.`)} ${practice}`);
  });
  
  console.log(chalk.gray('\n' + '═'.repeat(70)));
}

// Main execution
async function main() {
  console.log(chalk.bold.blue('\n🚀 Hive-Flow Migration Examples\n'));
  
  try {
    // Run examples (in dry-run mode for safety)
    await basicMigration();
    await complexProjectMigration();
    await rollbackExample();
    await validationExample();
    await batchMigrationExample();
    await conflictResolutionExample();
    
    // Print documentation
    printUsageScenarios();
    printBestPractices();
    
    console.log(chalk.bold.green('\n✅ All examples completed successfully!\n'));
    
  } catch (error) {
    console.error(chalk.red(`\n❌ Example failed: ${error.message}\n`));
    process.exit(1);
  }
}

// Run examples if called directly
if (require.main === module) {
  main();
}

export {
  basicMigration,
  complexProjectMigration,
  rollbackExample,
  validationExample,
  batchMigrationExample,
  conflictResolutionExample
};
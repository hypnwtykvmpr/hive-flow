#!/usr/bin/env node
/**
 * @claude-flow/codex - CLI
 *
 * Command-line interface for Codex integration
 * Part of the coflow rebranding initiative
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { CodexInitializer } from './initializer.js';
import { validateAgentsMd, validateSkillMd, validateConfigToml } from './validators/index.js';
import { migrateFromClaudeCode, analyzeClaudeMd, generateMigrationReport } from './migrations/index.js';
import { listTemplates, BUILT_IN_SKILLS } from './templates/index.js';
import { generateSkillMd } from './generators/skill-md.js';
import { VERSION, PACKAGE_INFO } from './index.js';
import fs from 'fs-extra';
import path from 'path';

const program = new Command();

program
  .name('claude-flow-codex')
  .description('OpenAI Codex integration for Claude Flow - Part of the coflow ecosystem')
  .version(VERSION);

// Init command
program
  .command('init')
  .description('Initialize a new Codex project with AGENTS.md and skills')
  .option('-t, --template <template>', 'Template to use (minimal, default, full, enterprise)', 'default')
  .option('-s, --skills <skills>', 'Comma-separated list of skills to include')
  .option('-f, --force', 'Overwrite existing files', false)
  .option('--dual', 'Generate both Codex and Claude Code configurations', false)
  .option('-p, --path <path>', 'Project path', process.cwd())
  .action(async (options) => {
    console.log(chalk.blue('Initializing Codex project...'));
    console.log(chalk.gray(`Template: ${options.template}`));

    const initializer = new CodexInitializer();
    const skills = options.skills?.split(',').map((s: string) => s.trim());

    const result = await initializer.initialize({
      projectPath: options.path,
      template: options.template,
      skills,
      force: options.force,
      dual: options.dual,
    });

    if (result.success) {
      console.log(chalk.green('\n✓ Project initialized successfully!'));
      console.log(chalk.gray('\nFiles created:'));
      for (const file of result.filesCreated) {
        console.log(chalk.gray(`  - ${file}`));
      }

      if (result.skillsGenerated.length > 0) {
        console.log(chalk.gray('\nSkills generated:'));
        for (const skill of result.skillsGenerated) {
          console.log(chalk.gray(`  - $${skill}`));
        }
      }

      if (result.warnings && result.warnings.length > 0) {
        console.log(chalk.yellow('\nWarnings:'));
        for (const warning of result.warnings) {
          console.log(chalk.yellow(`  ⚠ ${warning}`));
        }
      }

      console.log(chalk.blue('\nNext steps:'));
      console.log(chalk.gray('  1. Review AGENTS.md and customize for your project'));
      console.log(chalk.gray('  2. Review .agents/config.toml settings'));
      console.log(chalk.gray('  3. Start using skills with $skill-name syntax'));
    } else {
      console.log(chalk.red('\n✗ Initialization failed'));
      if (result.errors) {
        for (const error of result.errors) {
          console.log(chalk.red(`  - ${error}`));
        }
      }
    }
  });

// Generate skill command
program
  .command('generate-skill')
  .description('Generate a new SKILL.md file')
  .requiredOption('-n, --name <name>', 'Skill name (kebab-case)')
  .option('-d, --description <description>', 'Skill description')
  .option('-t, --triggers <triggers>', 'Comma-separated trigger conditions')
  .option('-s, --skip <skip>', 'Comma-separated skip conditions')
  .option('-p, --path <path>', 'Output path', process.cwd())
  .action(async (options) => {
    console.log(chalk.blue(`Generating skill: ${options.name}...`));

    const skillMd = await generateSkillMd({
      name: options.name,
      description: options.description ?? `Custom skill: ${options.name}`,
      triggers: options.triggers?.split(',').map((s: string) => s.trim()),
      skipWhen: options.skip?.split(',').map((s: string) => s.trim()),
    });

    const skillDir = path.join(options.path, '.agents', 'skills', options.name);
    await fs.ensureDir(skillDir);
    const skillPath = path.join(skillDir, 'SKILL.md');
    await fs.writeFile(skillPath, skillMd);

    console.log(chalk.green(`✓ Skill created at ${skillPath}`));
    console.log(chalk.gray(`  Use with: $${options.name}`));
  });

// Validate command
program
  .command('validate')
  .description('Validate AGENTS.md, SKILL.md, or config.toml files')
  .option('-f, --file <file>', 'File to validate')
  .option('-p, --path <path>', 'Project path to validate all files', process.cwd())
  .action(async (options) => {
    const filesToValidate: Array<{ path: string; type: 'agents' | 'skill' | 'config' }> = [];

    if (options.file) {
      const fileName = path.basename(options.file).toLowerCase();
      if (fileName === 'agents.md') {
        filesToValidate.push({ path: options.file, type: 'agents' });
      } else if (fileName === 'skill.md') {
        filesToValidate.push({ path: options.file, type: 'skill' });
      } else if (fileName === 'config.toml') {
        filesToValidate.push({ path: options.file, type: 'config' });
      }
    } else {
      // Validate all files in project
      const agentsMd = path.join(options.path, 'AGENTS.md');
      const configToml = path.join(options.path, '.agents', 'config.toml');

      if (await fs.pathExists(agentsMd)) {
        filesToValidate.push({ path: agentsMd, type: 'agents' });
      }
      if (await fs.pathExists(configToml)) {
        filesToValidate.push({ path: configToml, type: 'config' });
      }

      // Find skill files
      const skillsDir = path.join(options.path, '.agents', 'skills');
      if (await fs.pathExists(skillsDir)) {
        const skills = await fs.readdir(skillsDir);
        for (const skill of skills) {
          const skillMd = path.join(skillsDir, skill, 'SKILL.md');
          if (await fs.pathExists(skillMd)) {
            filesToValidate.push({ path: skillMd, type: 'skill' });
          }
        }
      }
    }

    if (filesToValidate.length === 0) {
      console.log(chalk.yellow('No files found to validate'));
      return;
    }

    console.log(chalk.blue(`Validating ${filesToValidate.length} file(s)...`));

    let hasErrors = false;

    for (const file of filesToValidate) {
      const content = await fs.readFile(file.path, 'utf-8');
      let result;

      switch (file.type) {
        case 'agents':
          result = await validateAgentsMd(content);
          break;
        case 'skill':
          result = await validateSkillMd(content);
          break;
        case 'config':
          result = await validateConfigToml(content);
          break;
      }

      const relativePath = path.relative(options.path, file.path);

      if (result.valid) {
        console.log(chalk.green(`✓ ${relativePath}`));
      } else {
        console.log(chalk.red(`✗ ${relativePath}`));
        hasErrors = true;
      }

      for (const error of result.errors) {
        console.log(chalk.red(`    Error: ${error.message}${error.line ? ` (line ${error.line})` : ''}`));
      }

      for (const warning of result.warnings) {
        console.log(chalk.yellow(`    Warning: ${warning.message}`));
        if (warning.suggestion) {
          console.log(chalk.gray(`             ${warning.suggestion}`));
        }
      }
    }

    if (hasErrors) {
      process.exit(1);
    }
  });

// Migrate command
program
  .command('migrate')
  .description('Migrate from Claude Code (CLAUDE.md) to Codex (AGENTS.md)')
  .option('-f, --from <file>', 'Source CLAUDE.md file', 'CLAUDE.md')
  .option('-o, --output <path>', 'Output directory', process.cwd())
  .option('--analyze-only', 'Only analyze, do not generate files', false)
  .option('--generate-skills', 'Generate skill files from detected patterns', true)
  .action(async (options) => {
    const sourcePath = path.resolve(options.from);

    if (!await fs.pathExists(sourcePath)) {
      console.log(chalk.red(`Source file not found: ${sourcePath}`));
      process.exit(1);
    }

    const content = await fs.readFile(sourcePath, 'utf-8');

    if (options.analyzeOnly) {
      console.log(chalk.blue('Analyzing CLAUDE.md...'));
      const analysis = await analyzeClaudeMd(content);

      console.log(chalk.gray('\nSections found:'));
      for (const section of analysis.sections) {
        console.log(chalk.gray(`  - ${section}`));
      }

      console.log(chalk.gray('\nSkills detected:'));
      for (const skill of analysis.skills) {
        console.log(chalk.gray(`  - /${skill} → $${skill}`));
      }

      console.log(chalk.gray('\nHooks used:'));
      for (const hook of analysis.hooks) {
        console.log(chalk.gray(`  - ${hook}`));
      }

      if (analysis.warnings.length > 0) {
        console.log(chalk.yellow('\nMigration warnings:'));
        for (const warning of analysis.warnings) {
          console.log(chalk.yellow(`  ⚠ ${warning}`));
        }
      }
    } else {
      console.log(chalk.blue('Migrating to Codex...'));

      const result = await migrateFromClaudeCode({
        sourcePath,
        targetPath: options.output,
        generateSkills: options.generateSkills,
      });

      const report = generateMigrationReport(result);
      console.log(report);

      if (result.success) {
        console.log(chalk.green('\n✓ Migration completed successfully!'));
      } else {
        console.log(chalk.red('\n✗ Migration failed'));
        process.exit(1);
      }
    }
  });

// Templates command
program
  .command('templates')
  .description('List available templates')
  .action(() => {
    console.log(chalk.blue('Available templates:\n'));

    const templates = listTemplates();
    for (const template of templates) {
      console.log(chalk.white(`  ${template.name}`));
      console.log(chalk.gray(`    ${template.description}`));
      console.log(chalk.gray(`    Skills: ${template.skillCount}`));
      console.log();
    }
  });

// Skills command
program
  .command('skills')
  .description('List available built-in skills')
  .action(() => {
    console.log(chalk.blue('Built-in skills:\n'));

    for (const [name, info] of Object.entries(BUILT_IN_SKILLS)) {
      console.log(chalk.white(`  $${name}`));
      console.log(chalk.gray(`    ${info.description}`));
      console.log(chalk.gray(`    Category: ${info.category}`));
      console.log();
    }
  });

// Info command
program
  .command('info')
  .description('Show package information')
  .action(() => {
    console.log(chalk.blue('\n@claude-flow/codex'));
    console.log(chalk.gray('━'.repeat(40)));
    console.log(chalk.white(`  Version:     ${PACKAGE_INFO.version}`));
    console.log(chalk.white(`  Description: ${PACKAGE_INFO.description}`));
    console.log(chalk.white(`  Future:      ${PACKAGE_INFO.futureUmbrella} (umbrella package)`));
    console.log(chalk.white(`  Repository:  ${PACKAGE_INFO.repository}`));
    console.log(chalk.gray('━'.repeat(40)));
    console.log(chalk.gray('\nPart of the coflow rebranding initiative'));
  });

program.parse();

import { describe, it, expect } from 'vitest';
import { deepInspect } from '../deep-inspect.js';
import { evaluate } from '../gate.js';
import { evaluateInlineJury } from '../jury-evaluator.js';
import { mergeWithDefaults } from '../default-config.js';
import type { JuryContext } from '../types.js';

function bashCtx(command: string): JuryContext {
  return { toolName: 'Bash', toolInput: { command }, cwd: '/project' };
}

describe('False Positive Prevention', () => {
  const legitimateCommands = [
    // Git operations
    'git status', 'git log --oneline', 'git diff HEAD~1', 'git branch -a',
    'git add src/index.ts', 'git commit -m "feat: add feature"',
    'git push origin feature-branch', 'git pull origin main',
    'git stash', 'git stash pop', 'git cherry-pick abc123',
    'git fetch --all', 'git rebase main',
    // npm/node
    'npm run build', 'npm test', 'npm run lint', 'npm install express',
    'npm audit', 'npm outdated', 'npm list --depth=0',
    'npx tsc --noEmit', 'npx vitest run', 'npx eslint src/',
    'node src/index.js', 'node --version',
    // File operations
    'cat package.json', 'head -20 src/index.ts', 'tail -f logs/app.log',
    'ls -la src/', 'find . -name "*.ts" -type f', 'wc -l src/**/*.ts',
    // Search
    'grep -r "TODO" src/', 'rg "function" --type ts',
    // Build tools
    'make build', 'cmake ..', 'cargo build --release', 'cargo test',
    'go build ./...', 'go test ./...', 'go mod tidy',
    // Python
    'python3 -m pytest', 'python3 setup.py install', 'pip install requests',
    // Docker (safe)
    'docker ps', 'docker images', 'docker logs myapp',
    'docker build -t myapp .', 'docker run -p 3000:3000 myapp',
    // System info
    'pwd', 'whoami', 'date', 'env', 'uname -a', 'df -h', 'du -sh .',
    // Misc dev
    'curl https://api.example.com/health', 'jq .name package.json',
    'mkdir -p src/components', 'touch src/new-file.ts',
    'cp src/old.ts src/new.ts', 'mv src/temp.ts src/final.ts',
    'diff src/old.ts src/new.ts', 'tree src/',
  ];

  describe('deepInspect allows legitimate commands', () => {
    for (const cmd of legitimateCommands) {
      it(`allows: ${cmd}`, () => {
        expect(deepInspect(cmd).blocked).toBe(false);
      });
    }
  });

  describe('inline interpreter execution redirects to explicit file/script workflows', () => {
    it('blocks node literal writes to normal project files with guidance', () => {
      const result = deepInspect('node --eval "fs.writeFileSync(\'src/generated.ts\', \'ok\')"');
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain('use Read, Write, or Edit');
    });

    it('blocks python literal writes to normal project files with guidance', () => {
      const result = deepInspect('python3 -c "open(\'src/generated.ts\', \'w\').write(\'ok\')"');
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain('use Read, Write, or Edit');
    });

    it('keeps dynamic node writes fail-closed via the same inline-eval policy', () => {
      const result = deepInspect('node --eval "fs.writeFileSync(target, data)"');
      expect(result.blocked).toBe(true);
      expect(result.technique).toBe('inline-eval');
    });

    it('keeps dynamic python writes fail-closed via the same inline-eval policy', () => {
      const result = deepInspect('python3 -c "open(target, \'w\').write(data)"');
      expect(result.blocked).toBe(true);
      expect(result.technique).toBe('inline-eval');
    });

    it('denies a normal literal node write through the full gate with guidance', async () => {
      const result = await evaluate(
        {
          tool_name: 'Bash',
          tool_input: { command: 'node --eval "fs.writeFileSync(\'src/generated.ts\', \'ok\')"' },
          cwd: '/project',
        },
        mergeWithDefaults({
          always_allow_bash_patterns: ['.*'],
          always_deny_bash_patterns: [],
          jury_escalation_bash_patterns: [],
        }),
      );
      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('Inline code execution is blocked');
    });

    it('denies a dynamic node write through the full gate', async () => {
      const result = await evaluate(
        {
          tool_name: 'Bash',
          tool_input: { command: 'node --eval "fs.writeFileSync(target, data)"' },
          cwd: '/project',
        },
        mergeWithDefaults({
          always_allow_bash_patterns: ['.*'],
          always_deny_bash_patterns: [],
          jury_escalation_bash_patterns: [],
        }),
      );
      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('Inline code execution is blocked');
    });
  });

  describe('inline jury approves legitimate commands', () => {
    for (const cmd of legitimateCommands) {
      it(`approves: ${cmd}`, () => {
        const result = evaluateInlineJury(bashCtx(cmd));
        expect(result.verdict).toBe('APPROVED');
      });
    }
  });

  describe('Write/Edit tools approved for dev files', () => {
    const devFiles = [
      'src/index.ts', 'src/components/Button.tsx', 'tests/app.test.ts',
      'package.json', 'tsconfig.json', '.eslintrc.js', 'README.md',
    ];
    for (const f of devFiles) {
      it(`approves Write to: ${f}`, () => {
        const ctx: JuryContext = {
          toolName: 'Write', toolInput: { file_path: f }, cwd: '/project', filePath: f
        };
        expect(evaluateInlineJury(ctx).verdict).toBe('APPROVED');
      });
    }
  });
});

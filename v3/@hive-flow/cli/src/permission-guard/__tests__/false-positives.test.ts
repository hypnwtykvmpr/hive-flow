import { describe, it, expect } from 'vitest';
import { deepInspect } from '../deep-inspect.js';
import { evaluateInlineJury } from '../jury-evaluator.js';
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
    'node src/index.js', 'node --version', 'node -e "console.log(1+1)"',
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

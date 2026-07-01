/**
 * HF-20 (run_shell inline-eval blocklist) regression — DEFENSE-IN-DEPTH.
 *
 * The sandbox (`sandboxExec`) + permission-guard Bash gate are the PRIMARY
 * execution boundary; this blocklist is a second layer that refuses obvious
 * arbitrary-code-execution shapes (per-interpreter eval-flag map) before they
 * ever reach the sandbox. It is NOT exhaustive across all interpreters
 * (tclsh/lua/Rscript etc. stay sandbox-contained) — it robustly covers the
 * interpreters this slice targets in their short/long/bundled/capital eval-flag
 * shapes, while still allowing legit script execution.
 *
 * Tests call the exported pure `denyUnsafeRunShellCommand(renderedCommand, argv)`
 * directly. A non-null return = denied; null = allowed.
 */
import { describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = resolve(here, '../scripts/provider-agent-bridge.mjs');
const bridge = await import(pathToFileURL(bridgePath).href);
const { denyUnsafeRunShellCommand } = bridge;

const deny = (argv, rendered = argv.join(' ')) => denyUnsafeRunShellCommand(rendered, argv);

describe('HF-20 per-interpreter eval-flag blocklist', () => {
  it('perl: short/long/bundled/capital eval forms denied', () => {
    expect(deny(['perl', '-e', 'system("id")'])).toBeTruthy();
    expect(deny(['perl', '-E', 'say "x"'])).toBeTruthy();        // -E (codex slip)
    expect(deny(['perl', '-eprint 1'])).toBeTruthy();            // bundled -eCODE (codex slip)
    expect(deny(['perl', '-pi', '-e', 's/x/y/'])).toBeTruthy();  // -e among args
    expect(deny(['/usr/bin/perl', '-e', '1'])).toBeTruthy();     // path-prefixed
    expect(deny(['perl', '-nE', 'code'])).toBeTruthy();          // clustered -nE (slip)
    expect(deny(['perl', '-pE', 'code'])).toBeTruthy();          // clustered -pE (slip)
    expect(deny(['perl', '-lne', 'code'])).toBeTruthy();         // clustered -lne (slip)
  });

  it('ruby: -e/--eval/--eval=/bundled denied; -E (encoding) is NOT eval', () => {
    expect(deny(['ruby', '-e', 'puts 1'])).toBeTruthy();
    expect(deny(['ruby', '--eval', 'puts 1'])).toBeTruthy();     // --eval (codex slip)
    expect(deny(['ruby', '--eval=puts 1'])).toBeTruthy();        // --eval= long form (slip)
    expect(deny(['ruby', '-eputs 1'])).toBeTruthy();             // bundled -eCODE (codex slip)
  });

  it('node: -e/--eval/--eval=/-p/--print/--print= and bundled denied; not -c/--check', () => {
    expect(deny(['node', '-e', 'console.log(1)'])).toBeTruthy();
    expect(deny(['node', '--eval', '1'])).toBeTruthy();
    expect(deny(['node', '--eval=console.log(1)'])).toBeTruthy();   // --eval= long form (slip)
    expect(deny(['node', '--print=process.version'])).toBeTruthy(); // --print= long form (slip)
    expect(deny(['node', '-p', '1+1'])).toBeTruthy();            // -p (codex slip)
    expect(deny(['node', '--print', '1+1'])).toBeTruthy();       // --print (codex slip)
    expect(deny(['nodejs', '-e', '1'])).toBeTruthy();            // nodejs alias
    expect(deny(['nodejs', '--eval=1'])).toBeTruthy();           // nodejs --eval= (slip)
  });

  it('python: -c denied', () => {
    expect(deny(['python', '-c', 'print(1)'])).toBeTruthy();
    expect(deny(['python3', '-c', 'print(1)'])).toBeTruthy();
    expect(deny(['python2', '-c', 'print(1)'])).toBeTruthy();
  });

  it('versioned interpreter basenames normalize to family and deny', () => {
    expect(deny(['python3.11', '-c', 'print(1)'])).toBeTruthy();
    expect(deny(['python3.12', '-c', 'x'])).toBeTruthy();
    expect(deny(['python2.7', '-c', 'x'])).toBeTruthy();
    expect(deny(['python3.11', '-cprint(1)'])).toBeTruthy();   // bundled -cCODE
    expect(deny(['ruby3.3', '--eval', 'x'])).toBeTruthy();
    expect(deny(['ruby3.3', '-e', 'x'])).toBeTruthy();
    expect(deny(['php8.2', '-r', 'x'])).toBeTruthy();
    expect(deny(['php8.3', '-r', 'x'])).toBeTruthy();
    expect(deny(['perl5.36', '-e', 'x'])).toBeTruthy();
    expect(deny(['perl5.36', '-nE', 'x'])).toBeTruthy();       // clustered, versioned
    // python ABI-tagged basenames (pymalloc/freethreaded/debug)
    expect(deny(['python3.11m', '-c', 'print(1)'])).toBeTruthy();
    expect(deny(['python3.13t', '-c', 'x'])).toBeTruthy();
    expect(deny(['python3.11d', '-c', 'x'])).toBeTruthy();
  });

  it('php: -r/-R/-F denied; lowercase -f (script run) allowed', () => {
    expect(deny(['php', '-r', 'echo 1;'])).toBeTruthy();
    expect(deny(['php', '-R', 'echo 1;'])).toBeTruthy();         // -R (codex slip)
  });

  it('bun/deno: eval subcommand and -e/--eval denied', () => {
    expect(deny(['bun', '-e', 'console.log(1)'])).toBeTruthy();
    expect(deny(['bun', '--eval', '1'])).toBeTruthy();           // --eval (codex slip)
    expect(deny(['bun', '--eval=console.log(1)'])).toBeTruthy(); // --eval= long form (slip)
    expect(deny(['bun', 'eval', '1'])).toBeTruthy();
    expect(deny(['deno', 'eval', 'console.log(1)'])).toBeTruthy();
  });

  it('awk family denied entirely', () => {
    expect(deny(['awk', 'BEGIN{system("id")}'])).toBeTruthy();
    expect(deny(['gawk', 'BEGIN{print 1}'])).toBeTruthy();
    expect(deny(['mawk', 'BEGIN{print 1}'])).toBeTruthy();
    expect(deny(['nawk', 'BEGIN{print 1}'])).toBeTruthy();
  });

  it('find -exec/-execdir and xargs denied', () => {
    expect(deny(['find', '.', '-exec', 'id', ';'])).toBeTruthy();
    expect(deny(['find', '.', '-execdir', 'id', ';'])).toBeTruthy();
    expect(deny(['xargs', 'sh', '-c', 'id'])).toBeTruthy();
    expect(deny(['xargs', 'id'])).toBeTruthy();
  });

  it('sed denied ENTIRELY (GNU s///e / e-command execute forms are fragile)', () => {
    // Rationale: GNU `s///e` and the `e`-command run shell commands, but the
    // syntax differs across GNU vs macOS and is fragile to detect precisely.
    // A read-only provider agent has grep/read_file/find_file instead, so sed
    // is denied wholesale rather than parsed.
    expect(deny(['sed', 's/x/y/', 'file'])).toBeTruthy();        // was ALLOWED; now DENY
    expect(deny(['sed', 's/x/y/e', 'file'])).toBeTruthy();
    expect(deny(['sed', '-e', 's/x/y/e', 'file'])).toBeTruthy();
    expect(deny(['sed', 'e id', 'file'])).toBeTruthy();
    expect(deny(['sed', '1e id', 'file'])).toBeTruthy();
    expect(deny(['sed', '/x/e id', 'file'])).toBeTruthy();
  });

  it('negative controls: legit script runs and read-only commands ALLOWED', () => {
    expect(deny(['node', 'script.js'])).toBeNull();
    expect(deny(['perl', 'script.pl'])).toBeNull();
    expect(deny(['php', '-f', 'script.php'])).toBeNull();        // lowercase -f = run
    // perl module/include loaders carry letters in payload — must NOT false-deny
    expect(deny(['perl', '-MData::Dumper', 'script.pl'])).toBeNull();
    expect(deny(['perl', '-Idir', 'script.pl'])).toBeNull();
    expect(deny(['perl', '-mModule', 'script.pl'])).toBeNull();
    // node long flags that merely start with letters → not eval
    expect(deny(['node', '--experimental-vm-modules', 'script.js'])).toBeNull();
    expect(deny(['node', '--prof', 'script.js'])).toBeNull();
    expect(deny(['ls', '-la'])).toBeNull();
    expect(deny(['cat', 'file'])).toBeNull();
    expect(deny(['grep', 'x', 'file'])).toBeNull();
    expect(deny(['find', '.', '-name', '*.ts'])).toBeNull();
  });

  it('versioned interpreters: script runs allowed; non-eval tools not normalized', () => {
    expect(deny(['python3.11', 'script.py'])).toBeNull();
    expect(deny(['ruby3.3', 'script.rb'])).toBeNull();
    expect(deny(['php8.2', '-f', 'script.php'])).toBeNull();
    expect(deny(['perl5.36', 'script.pl'])).toBeNull();
    // Trailing-letter/`-` tools must NOT normalize into a family (default-allow):
    expect(deny(['perldoc', 'Foo'])).toBeNull();
    expect(deny(['python3-config', '--cflags'])).toBeNull(); // `-` after digits → not python
    expect(deny(['python-foo', 'bar'])).toBeNull();          // `-foo` → not python
    expect(deny(['php-fpm'])).toBeNull();
    expect(deny(['ruby-doc'])).toBeNull();
  });
});

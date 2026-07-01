import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEBRAND_ASSERT_ZERO_PROHIBITED } from './debrand-prohibited-patterns.js';
import { isScannedTextFile, REPO_ROOT, trackedFilesForShippedSurfaces } from './debrand-static-scope.js';

const CLASSIFIED_STATIC_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  [
    'scripts/install.sh:content:npm install guidance',
    'Installer performs the package-manager install operation; user-facing URL/install guidance is otherwise removed.',
  ],
  [
    'cli/docker/browser/Dockerfile:content:npm install guidance',
    'Browser fixture Docker build layer installs package dependencies; this is build logic, not docs guidance.',
  ],
  [
    'cli/docker/Dockerfile:content:npm install guidance',
    'Docker build layer installs the published CLI; this is build logic, not docs guidance.',
  ],
  [
    'cli/docker/Dockerfile.full:content:npm install guidance',
    'Docker build layer installs the published CLI; this is build logic, not docs guidance.',
  ],
  [
    'cli/src/commands/doctor.ts:content:npm install guidance',
    'Doctor --install performs the requested Claude Code install action; ordinary guidance was rewritten.',
  ],
]);

describe('DB-5 static prohibited debrand sweep', () => {
  it('has zero prohibited debrand strings in widened tracked shipped surfaces', () => {
    const findings = collectStaticFindings();
    const hits = findings
      .filter(({ key }) => !CLASSIFIED_STATIC_EXCEPTIONS.has(key))
      .map(({ message }) => message);

    expect(hits, '[DB-5 grep-zero] prohibited debrand strings in widened shipped surfaces').toEqual([]);
  });

  it('keeps static exception list synchronized with real classified hits', () => {
    const findingKeys = new Set(collectStaticFindings().map(({ key }) => key));
    const stale = [...CLASSIFIED_STATIC_EXCEPTIONS.keys()].filter((key) => !findingKeys.has(key));

    expect(stale, '[DB-5 grep-zero] remove stale static debrand exception entries').toEqual([]);
  });

  it('does not ship dead relative markdown documentation links in scanned surfaces', () => {
    const deadLinks = collectDeadMarkdownLinks();

    expect(deadLinks, '[DB-5 docs] remove or repair dead relative documentation links').toEqual([]);
  });

  it('does not ship malformed single-slash URL tokens in scanned surfaces', () => {
    const malformedUrls = collectMalformedUrlFindings();

    expect(malformedUrls, '[DB-5 docs] repair or remove malformed single-slash URLs').toEqual([]);
  });

  it('does not ship neural docs with DELETE_ names or empty tmp json placeholders', () => {
    const forbidden = trackedFilesForShippedSurfaces()
      .filter((file) => existsSync(resolve(REPO_ROOT, file)))
      .filter((file) =>
        /^cli\/docs\/neural\/(?:DELETE_README\.md|DELETE_.*\.md|tmp\.json)$/.test(file),
      );
    const missingRenames = [
      'cli/docs/neural/README.md',
      'cli/docs/neural/SONA_INTEGRATION.md',
      'cli/docs/neural/SONA_QUICKSTART.md',
    ].filter((file) => !existsSync(resolve(REPO_ROOT, file)));

    expect(forbidden).toEqual([]);
    expect(missingRenames).toEqual([]);
  });

  it('ships valid JSON for generated Claude settings templates', () => {
    const parseFailures = collectGeneratedSettingsJsonParseFailures();

    expect(parseFailures, '[DB-5 docs] generated Claude settings templates must parse as JSON').toEqual([]);
  });
});

function collectStaticFindings(): Array<{ key: string; message: string }> {
  return trackedFilesForShippedSurfaces()
    .filter(isScannedTextFile)
    .flatMap((relativePath) => {
      const absolutePath = resolve(REPO_ROOT, relativePath);
      const content = readFileSync(absolutePath, 'utf8');
      const normalizedPath = relativePath.split(sep).join('/');
      return DEBRAND_ASSERT_ZERO_PROHIBITED.flatMap(({ label, pattern }) => {
        const findings: Array<{ key: string; message: string }> = [];
        if (pattern.test(normalizedPath)) {
          findings.push({
            key: `${normalizedPath}:path:${label}`,
            message: `${normalizedPath}: path: ${label}: ${pattern}`,
          });
        }
        if (label === 'cosmetic URL') {
          findings.push(...collectCosmeticUrlFindings(normalizedPath, content));
          return findings;
        }
        if (label === 'GitHub URL') {
          findings.push(...collectGitHubUrlFindings(normalizedPath, content));
          return findings;
        }
        if (pattern.test(content)) {
          findings.push({
            key: `${normalizedPath}:content:${label}`,
            message: `${normalizedPath}: content: ${label}: ${pattern}`,
          });
        }
        return findings;
      });
    });
}

function collectCosmeticUrlFindings(relativePath: string, content: string): Array<{ key: string; message: string }> {
  return collectUrlLiterals(content)
    .filter(({ url }) => !isAllowedRuntimeUrl(url))
    .map(({ lineNumber, url }) => ({
      key: `${relativePath}:line:${lineNumber}:cosmetic URL:${url}`,
      message: `${relativePath}:${lineNumber}: cosmetic URL: ${url}`,
    }));
}

function collectGitHubUrlFindings(relativePath: string, content: string): Array<{ key: string; message: string }> {
  return collectUrlLiterals(content)
    .filter(({ url }) => /^https?:\/\/github\.com\//i.test(url))
    .filter(({ url }) => !url.includes('$'))
    .filter(({ url }) => !/^https?:\/\/github\.com\/login\/oauth\//i.test(url))
    .filter(({ url }) => !isAllowedProjectGitHubUrl(url))
    .map(({ lineNumber, url }) => ({
      key: `${relativePath}:line:${lineNumber}:GitHub URL:${url}`,
      message: `${relativePath}:${lineNumber}: GitHub URL: ${url}`,
    }));
}

function collectUrlLiterals(content: string): Array<{ lineNumber: number; url: string }> {
  const urlPattern = /https?:\/\/[^\s)"'<>]+/gi;
  return content.split('\n').flatMap((line, index) => {
    return [...line.matchAll(urlPattern)].map((match) => ({
      lineNumber: index + 1,
      url: match[0],
    }));
  });
}

function collectMalformedUrlFindings(): string[] {
  const malformedUrlPattern = /https?:\/(?:$|[^/])/gi;
  return trackedFilesForShippedSurfaces()
    .filter(isScannedTextFile)
    .flatMap((relativePath) => {
      const absolutePath = resolve(REPO_ROOT, relativePath);
      const content = readFileSync(absolutePath, 'utf8');
      return content.split('\n').flatMap((line, index) => {
        return [...line.matchAll(malformedUrlPattern)].map(
          (match) => `${relativePath}:${index + 1}: malformed URL token: ${match[0]}`,
        );
      });
    });
}

function collectGeneratedSettingsJsonParseFailures(): string[] {
  return trackedFilesForShippedSurfaces()
    .filter((relativePath) => relativePath.endsWith('/.claude/settings.json'))
    .filter(isScannedTextFile)
    .flatMap((relativePath) => {
      const absolutePath = resolve(REPO_ROOT, relativePath);
      try {
        JSON.parse(readFileSync(absolutePath, 'utf8'));
        return [];
      } catch (error) {
        return [`${relativePath}: ${error instanceof Error ? error.message : String(error)}`];
      }
    });
}

function isAllowedRuntimeUrl(rawUrl: string): boolean {
  if (rawUrl.includes('${') || rawUrl.includes('$')) return true;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === 'your_node' ||
    host === 'test-server' ||
    host === 'example.com' ||
    host === 'example.org' ||
    host === 'example.net' ||
    host.endsWith('.example.com') ||
    host.endsWith('.example.org') ||
    host.endsWith('.example.net') ||
    host === 'registry.npmjs.org' ||
    host === 'gateway.pinata.cloud' ||
    host === 'api.pinata.cloud' ||
    host === 'api.web3.storage' ||
    host === 'web3.storage' ||
    host === 'w3s.link' ||
    host === 'dweb.link' ||
    host === 'ipfs.io' ||
    host === 'cloudflare-ipfs.com' ||
    host === 'storage.googleapis.com' ||
    host === 'api.openai.com' ||
    host === 'api.anthropic.com' ||
    host === 'api.cohere.ai' ||
    host === 'html.duckduckgo.com' ||
    host === 'generativelanguage.googleapis.com' ||
    host === 'api.deepseek.com' ||
    host === 'openrouter.ai' ||
    host === 'dashscope-intl.aliyuncs.com' ||
    host === 'api.mistral.ai' ||
    host === 'dist.ipfs.tech' ||
    host === 'us-central1-hive-flow.cloudfunctions.net' ||
    host === 'accounts.google.com' ||
    host === 'oauth2.googleapis.com' ||
    host === 'dotnet.microsoft.com' ||
    host === 'code.claude.com' ||
    // Third-party provider-install hints (load-bearing, DO-NOT-REVERT in source):
    // Antigravity CLI (`agy`) install URL — replaces the dead @google/gemini-cli;
    // Cursor headless CLI install URL. Functional install guidance, not the
    // dropped project brand — same class as the dotnet.microsoft.com entry above.
    host === 'antigravity.google' ||
    host === 'cursor.com' ||
    isAllowedProjectGitHubUrl(rawUrl) ||
    (host === 'github.com' && parsed.pathname.startsWith('/login/oauth/'))
  );
}

function isAllowedProjectGitHubUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.hostname.toLowerCase() !== 'github.com') return false;
  return parsed.pathname === '/hypnwtk' || parsed.pathname === '/hypnwtk/hive-flow';
}

function collectDeadMarkdownLinks(): string[] {
  const linkPattern = /!?\[[^\]]*]\(([^)]+)\)/g;
  return trackedFilesForShippedSurfaces()
    .filter((relativePath) => isScannedTextFile(relativePath) && relativePath.endsWith('.md'))
    .flatMap((relativePath) => {
      const absolutePath = resolve(REPO_ROOT, relativePath);
      const content = readFileSync(absolutePath, 'utf8');
      let inFence = false;
      return content.split('\n').flatMap((line, index) => {
        if (/^\s*```/.test(line)) {
          inFence = !inFence;
          return [];
        }
        if (inFence) return [];
        return [...line.matchAll(linkPattern)]
          .map((match) => markdownTargetFrom(match[1]))
          .filter((target): target is string => Boolean(target))
          .filter((target) => isRelativeDocTarget(target))
          .filter((target) => {
            const targetPath = target.split('#')[0].split('?')[0];
            const resolved = resolve(REPO_ROOT, dirname(relativePath), targetPath);
            return !existsSync(resolved);
          })
          .map((target) => `${relativePath}:${index + 1}: ${target}`);
      });
    });
}

function markdownTargetFrom(rawTarget: string): string | null {
  const target = rawTarget.trim().replace(/^<|>$/g, '').split(/\s+/)[0];
  if (!target || target.startsWith('#')) return null;
  if (target.startsWith('/') || target.includes('$')) return null;
  if (/^(?:[a-z]+:)?\/\//i.test(target)) return null;
  if (/^(?:mailto|tel):/i.test(target)) return null;
  return target;
}

function isRelativeDocTarget(target: string): boolean {
  const withoutAnchor = target.split('#')[0].split('?')[0];
  return (
    withoutAnchor.endsWith('.md') ||
    withoutAnchor.startsWith('docs/') ||
    withoutAnchor.startsWith('./docs/') ||
    withoutAnchor.startsWith('../docs/')
  );
}

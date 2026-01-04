/**
 * NPM Publisher
 * Handles npm package publishing with tag support
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { PublishOptions, PublishResult, PackageInfo } from './types.js';

export class Publisher {
  private cwd: string;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
  }

  /**
   * Publish package to npm
   */
  async publishToNpm(options: PublishOptions = {}): Promise<PublishResult> {
    const {
      tag = 'latest',
      access,
      dryRun = false,
      registry,
      otp,
      skipBuild = false,
      buildCommand = 'npm run build'
    } = options;

    const result: PublishResult = {
      packageName: '',
      version: '',
      tag,
      success: false
    };

    try {
      // Read package.json
      const pkgPath = join(this.cwd, 'package.json');
      if (!existsSync(pkgPath)) {
        throw new Error('package.json not found');
      }

      const pkg: PackageInfo = JSON.parse(readFileSync(pkgPath, 'utf-8'));

      if (pkg.private) {
        throw new Error('Cannot publish private package');
      }

      result.packageName = pkg.name;
      result.version = pkg.version;

      // Run build if not skipped
      if (!skipBuild) {
        console.log('Building package...');
        this.execCommand(buildCommand);
      }

      // Construct npm publish command
      const publishArgs: string[] = ['npm', 'publish'];

      if (tag) {
        publishArgs.push('--tag', tag);
      }

      if (access) {
        publishArgs.push('--access', access);
      }

      if (registry) {
        publishArgs.push('--registry', registry);
      }

      if (otp) {
        publishArgs.push('--otp', otp);
      }

      if (dryRun) {
        publishArgs.push('--dry-run');
      }

      // Execute publish
      console.log(`Publishing ${result.packageName}@${result.version} with tag '${tag}'...`);

      if (dryRun) {
        console.log('Dry run mode - no actual publish');
        console.log('Command:', publishArgs.join(' '));
      }

      const output = this.execCommand(publishArgs.join(' '), true);

      // Parse output for tarball URL
      const tarballMatch = output.match(/https:\/\/[^\s]+\.tgz/);
      if (tarballMatch) {
        result.tarball = tarballMatch[0];
      }

      result.publishedAt = new Date();
      result.success = true;

      console.log(`Successfully published ${result.packageName}@${result.version}`);

      return result;

    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      console.error('Publish failed:', result.error);
      return result;
    }
  }

  /**
   * Check if package version already exists on npm
   */
  async checkVersionExists(packageName: string, version: string): Promise<boolean> {
    try {
      const output = this.execCommand(`npm view ${packageName}@${version} version`, true);
      return output.trim() === version;
    } catch {
      return false;
    }
  }

  /**
   * Get latest published version
   */
  async getLatestVersion(packageName: string, tag = 'latest'): Promise<string | null> {
    try {
      const output = this.execCommand(`npm view ${packageName}@${tag} version`, true);
      return output.trim();
    } catch {
      return null;
    }
  }

  /**
   * Get package info from npm registry
   */
  async getPackageInfo(packageName: string): Promise<PackageInfo | null> {
    try {
      const output = this.execCommand(`npm view ${packageName} --json`, true);
      return JSON.parse(output);
    } catch {
      return null;
    }
  }

  /**
   * Verify npm authentication
   */
  async verifyAuth(): Promise<boolean> {
    try {
      const output = this.execCommand('npm whoami', true);
      return output.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Get npm registry URL
   */
  async getRegistry(): Promise<string> {
    try {
      const output = this.execCommand('npm config get registry', true);
      return output.trim();
    } catch {
      return 'https://registry.npmjs.org/';
    }
  }

  /**
   * Pack package to tarball
   */
  async pack(outputDir?: string): Promise<string> {
    try {
      const cmd = outputDir
        ? `npm pack --pack-destination ${outputDir}`
        : 'npm pack';

      const output = this.execCommand(cmd, true);
      const tarballName = output.trim().split('\n').pop() || '';

      return outputDir ? join(outputDir, tarballName) : tarballName;
    } catch (error) {
      throw new Error(`Failed to pack: ${error}`);
    }
  }

  /**
   * Execute command
   */
  private execCommand(cmd: string, returnOutput = false): string {
    try {
      const output = execSync(cmd, {
        cwd: this.cwd,
        encoding: 'utf-8',
        stdio: returnOutput ? 'pipe' : 'inherit'
      });
      return returnOutput ? output : '';
    } catch (error) {
      if (returnOutput && error instanceof Error) {
        throw error;
      }
      throw error;
    }
  }
}

/**
 * Convenience function to publish to npm
 */
export async function publishToNpm(
  options: PublishOptions = {}
): Promise<PublishResult> {
  const publisher = new Publisher();
  return publisher.publishToNpm(options);
}

/**
 * Convenience function to check version exists
 */
export async function checkVersionExists(
  packageName: string,
  version: string
): Promise<boolean> {
  const publisher = new Publisher();
  return publisher.checkVersionExists(packageName, version);
}

/**
 * Convenience function to get latest version
 */
export async function getLatestVersion(
  packageName: string,
  tag?: string
): Promise<string | null> {
  const publisher = new Publisher();
  return publisher.getLatestVersion(packageName, tag);
}

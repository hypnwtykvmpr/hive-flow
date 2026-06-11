import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { installRelocatedEnforcement } from '../install/enforcement-installer.js';
import {
  buildAndInstallNativeHelpers,
  ensureHelperBinOnPath,
} from '../install/native-helper-installer.js';
import { initializeCredentialVault } from '../credential-store/holder-runtime.js';

export const installCommand: Command = {
  name: 'install',
  description: 'Install user-level Hive Flow enforcement hooks',
  options: [
    { name: 'global', description: 'Install the user-level global enforcement engine', type: 'boolean', default: false },
    { name: 'yes', short: 'y', description: 'Approve non-interactive install prompts', type: 'boolean', default: false },
    { name: 'engine-only', description: 'Copy only the relocated enforcement engine', type: 'boolean', default: false },
    { name: 'hooks-only', description: 'Write only Claude Code user hook settings', type: 'boolean', default: false },
    { name: 'keypair-only', description: 'Enroll only the Permission Guard override keypair', type: 'boolean', default: false },
    { name: 'credentials', description: 'Create the per-machine KEK and empty credential vault', type: 'boolean', default: false },
    { name: 'degraded', description: 'Allow degraded credential backend setup for explicit test/CI lanes', type: 'boolean', default: false },
    { name: 'project-root', description: 'Project root containing enforcement sources', type: 'string' },
    { name: 'home', description: 'Override target home directory', type: 'string' },
    { name: 'user-settings', description: 'Override Claude Code user settings path', type: 'string' },
    { name: 'bin', description: 'Override relocated enforcement bin directory', type: 'string' },
  ],
  examples: [
    { command: 'hive-flow install --global --yes --engine-only', description: 'Copy the relocated enforcement engine non-interactively' },
    { command: 'hive-flow install --global --yes --hooks-only', description: 'Write user-level hook settings non-interactively' },
    { command: 'hive-flow install --global --keypair-only', description: 'Enroll the Permission Guard override keypair interactively' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    if (ctx.flags.global !== true) {
      output.printError('Only --global enforcement install is supported by this command.');
      return { success: false, exitCode: 1 };
    }

    try {
      const keypairOnly = ctx.flags['keypair-only'] as boolean;
      const result = await installRelocatedEnforcement({
        projectRoot: ctx.flags['project-root'] as string | undefined,
        homeDir: ctx.flags.home as string | undefined,
        userSettingsPath: ctx.flags['user-settings'] as string | undefined,
        binDir: ctx.flags.bin as string | undefined,
        yes: ctx.flags.yes as boolean,
        engineOnly: keypairOnly || (ctx.flags['engine-only'] as boolean),
        hooksOnly: keypairOnly || (ctx.flags['hooks-only'] as boolean),
        setupKeypair: keypairOnly,
      });

      output.printSuccess(`Installed enforcement engine: ${result.binDir}`);
      output.printSuccess(`Updated user trigger: ${result.userSettingsPath}`);
      for (const message of result.messages) output.printInfo(message);
      let credentialSetup: Awaited<ReturnType<typeof initializeCredentialVault>> | undefined;
      let nativeHelpers: Awaited<ReturnType<typeof buildAndInstallNativeHelpers>> | undefined;
      let helperPath: ReturnType<typeof ensureHelperBinOnPath> | undefined;
      if (ctx.flags.credentials === true) {
        nativeHelpers = await buildAndInstallNativeHelpers({
          projectRoot: (ctx.flags['project-root'] as string | undefined) ?? ctx.cwd,
        });
        helperPath = ensureHelperBinOnPath({
          homeDir: ctx.flags.home as string | undefined,
        });
        for (const helper of nativeHelpers) {
          output.printInfo(`helper ${helper.helper}: ${helper.status}${helper.remediation ? ` — ${helper.remediation}` : ''}`);
        }
        output.printInfo(`helper ${helperPath.helper}: ${helperPath.status}${helperPath.reason ? ` — ${helperPath.reason}` : ''}`);
        credentialSetup = await initializeCredentialVault({
          allowDegraded: Boolean(ctx.flags.degraded),
        });
        output.printSuccess(credentialSetup.createdVault ? 'Created credential vault' : 'Credential vault already ready');
      }
      return {
        success: true,
        data: {
          ...result,
          credentialSetup: credentialSetup
            ? {
              vaultPath: credentialSetup.vaultPath,
              createdVault: credentialSetup.createdVault,
              decrypts: credentialSetup.decrypts,
              backend: {
                available: credentialSetup.backend.available,
                degraded: credentialSetup.backend.degraded,
                reason: credentialSetup.backend.reason,
              },
            }
            : undefined,
          nativeHelpers,
          helperPath,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.printError(message);
      return { success: false, message, exitCode: 1 };
    }
  },
};

export default installCommand;

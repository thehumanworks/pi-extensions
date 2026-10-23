import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Smoke-only loadout: do not use --tools to filter out the callable namespace. */
export default function smokeLoadout(pi: ExtensionAPI): void {
  pi.on('session_start', () => {
    // Activate two declarations; the extension's codemode tools stay callable on demand.
    // Direct built-ins remain inactive. Mutations are also denied by configuration.
    pi.setActiveTools(['atlassian_discover', 'codemode']);
  });
}

#!/usr/bin/env node
/**
 * Install dsh-session-mail into a DSH profile.
 *
 * Two things make a plugin load in a profile:
 *
 *   dependencies            → the package is resolvable from the profile
 *   dsh.profile.bundles     → the loader composes it at boot, or on a profile change
 *
 * and the node_modules link has to exist for the loader to find the package.
 *
 * Measured 2026-10-29: the live host did not revert the profile edit, and the
 * newly installed plugin was in the tool table on the next turn — the host
 * re-composes the profile tree when it changes. So a running DeepSeek Harness
 * is only a warning here, not a refusal. If the tool does not show up, quit
 * the app and run this again.
 *
 * Usage:
 *   node scripts/install.mjs --profile C:/Users/<you>/.dsh/profiles/desktop
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'dsh-session-mail';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[token.slice(2)] = true; continue; }
    args[token.slice(2)] = next;
    i += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profileDir = resolve(
  typeof args.profile === 'string' && args.profile !== ''
    ? args.profile
    : join(homedir(), '.dsh', 'profiles', 'desktop'),
);

if (!existsSync(join(pluginDir, 'package.json'))) {
  console.error(`refusing: ${pluginDir} has no package.json`);
  process.exit(1);
}

/** PIDs of running DSH hosts; a live host owns the profile files. */
function hostPids() {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name LIKE 'DeepSeek Harness%'\" | " +
        "Where-Object { $_.CommandLine -like '*dsh*' } | Select-Object -ExpandProperty ProcessId",
    ], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    return out.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+$/.test(line));
  } catch {
    return [];
  }
}

const pids = hostPids();
if (pids.length > 0) {
  // Measured 2026-10-29 (desktop profile): the live host did NOT revert the
  // profile edit, and the newly installed plugin was in the tool table on the
  // next turn — the host re-composes the profile tree when it changes. So this
  // is a warning, not a refusal. If the tool does not show up, quit DSH and
  // run this again.
  console.warn(
    `warn  DSH is running (pid ${pids.join(', ')}).\n` +
    '      The profile edit usually sticks and the plugin loads on the next turn.\n' +
    '      If the tool does not appear, quit DeepSeek Harness and run this again.',
  );
}

const manifestPath = join(profileDir, 'package.json');
const raw = readFileSync(manifestPath, 'utf8');
const profile = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
const bundles = profile?.dsh?.profile?.bundles;
if (!Array.isArray(bundles)) {
  console.error('refusing: profile package.json has no dsh.profile.bundles array');
  process.exit(1);
}
profile.dependencies = profile.dependencies ?? {};
profile.dependencies[PACKAGE_NAME] = `link:${pluginDir.split('\\').join('/')}`;
if (!bundles.includes(PACKAGE_NAME)) bundles.push(PACKAGE_NAME);

const indentMatch = raw.match(/\n([ \t]+)"/);
const indent = indentMatch ? indentMatch[1] : '  ';
let text = JSON.stringify(profile, null, indent);
text = raw.includes('\r\n') ? `${text.replace(/\n/g, '\r\n')}\r\n` : `${text}\n`;
JSON.parse(text);
writeFileSync(`${manifestPath}.bak-install-${PACKAGE_NAME}`, raw, { encoding: 'utf8' });
writeFileSync(manifestPath, text, { encoding: 'utf8' });

const modules = join(profileDir, 'node_modules');
mkdirSync(modules, { recursive: true });
const linkPath = join(modules, PACKAGE_NAME);
if (existsSync(linkPath)) {
  const stats = lstatSync(linkPath);
  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    console.error(`refusing to replace ${linkPath}: it is a real directory, not a link`);
    process.exit(1);
  }
  rmSync(linkPath, { recursive: true, force: true });
}
symlinkSync(pluginDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

console.log(`ok    dependencies.${PACKAGE_NAME} → ${pluginDir}`);
console.log(`ok    bundles now: ${bundles.join(', ')}`);
console.log(`ok    node_modules/${PACKAGE_NAME} linked`);
console.log('\nnext: the tool is available on the next turn — no restart needed.');
console.log('      (editing an already loaded plugin\'s code still needs a restart.)');

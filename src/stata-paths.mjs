/**
 * Where is Stata on this machine?
 *
 * Two paths matter and they are not the same thing:
 *
 *   stataHome  the folder that holds the shared library the embedded engine
 *              loads (`mp-64.dll`, `se-64.dll`, `be-64.dll`). pystata needs
 *              this one.
 *   stataExe   the executable (`StataMP-64.exe`, `StataSE-64.exe`, ...).
 *              Background jobs and batch runs need this one, because they
 *              start a separate process instead of loading the library.
 *
 * Both are discoverable, and both can be set explicitly:
 *
 *   --stata-home <dir>   / STATA_COPILOT_STATA_HOME
 *   --stata-exe  <path>  / STATA_COPILOT_STATA_EXE
 *
 * The search order for each is: explicit setting, environment, the *other*
 * setting (the exe's folder is a home; a home usually contains an exe), then
 * the Windows registry (Stata registers `Stata<NN>Do\shell\open\command` when
 * it installs), then the usual install folders.
 */

import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';

export const EDITIONS = ['mp', 'se', 'be'];

/** Shared libraries, one per Stata edition. */
export const DLL_NAMES = EDITIONS.map((edition) => `${edition}-64.dll`);

/** Executables, MP first because parallel is the edition most people buy. */
export const EXE_NAMES = ['StataMP-64.exe', 'StataSE-64.exe', 'StataBE-64.exe', 'Stata-64.exe'];

const WINDOWS = process.platform === 'win32';

/** Strip trailing separators so `D:/` and `D:\` become `D:`. */
export function normalizeRoot(root) {
  if (!root) return null;
  return String(root).replace(/[\\/]+$/, '') || null;
}

export function toSlashes(value) {
  return String(value).replace(/\\/g, '/');
}

/** Which edition a shared library belongs to. */
export function editionFromDll(name) {
  const match = /^(mp|se|be)-64\.dll$/i.exec(String(name));
  return match ? match[1].toLowerCase() : null;
}

/** Which edition an executable belongs to. */
export function editionFromExe(exe) {
  if (!exe) return null;
  const base = String(exe).split(/[\\/]/).pop() ?? '';
  const match = /^Stata(MP|SE|BE)-64\.exe$/i.exec(base);
  if (match) return match[1].toLowerCase();
  if (/^Stata-64\.exe$/i.test(base)) return null; // intercooled, single edition
  return null;
}

/** The home implied by an exe: the folder that should contain the DLLs. */
export function homeFromExe(exe) {
  const root = normalizeRoot(exe ? dirname(String(exe)) : null);
  return root;
}

/**
 * The executable that belongs to a home. Stata sometimes nests it one folder
 * down (`<home>/Stata18/StataMP-64.exe`), so both layouts are tried.
 */
export function exeInHome(home) {
  const root = normalizeRoot(home);
  if (!root) return null;
  for (const name of EXE_NAMES) {
    const direct = `${root}/${name}`;
    if (existsSync(direct)) return toSlashes(direct);
  }
  for (const child of versionedSubdirs(root)) {
    for (const name of EXE_NAMES) {
      const nested = `${root}/${child}/${name}`;
      if (existsSync(nested)) return toSlashes(nested);
    }
  }
  return null;
}

/** Subfolders whose name looks like a Stata version (`Stata18`, `Stata 17`). */
function versionedSubdirs(root) {
  const here = toSlashes(root);
  // A drive root only holds a handful of folders; anything else is a real
  // directory we can list. Failures (permissions, a missing drive) mean "none".
  try {
    return readdirSync(here, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^Stata\s?\d{2}$/i.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Folders that hold a Stata installation, most likely first. */
function homeCandidates() {
  const programFiles = process.env.ProgramFiles ?? 'C:/Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA ?? null;
  const candidates = [];

  // Stata installs into a version-named folder; a few releases ahead is cheap.
  for (let version = 20; version >= 14; version -= 1) {
    candidates.push(`${programFiles}/Stata${version}`);
    candidates.push(`${programFilesX86}/Stata${version}`);
    candidates.push(`C:/Stata${version}`);
  }
  if (localAppData) candidates.push(`${localAppData}/Programs/Stata18`, `${localAppData}/Programs/Stata17`);

  // A drive root is a legitimate layout: Stata may be installed as D:\mp-64.dll.
  for (const drive of ['C:', 'D:', 'E:', 'F:']) {
    candidates.push(`${drive}/`);
    for (let version = 20; version >= 14; version -= 1) candidates.push(`${drive}/Stata${version}`);
  }
  return candidates;
}

/**
 * Ask Windows where Stata is. Stata registers one shell verb per version
 * (`Stata18Do`, `Stata17Do`, ...) whose default command is
 * `"D:\StataMP-64.exe" "%1"`, so the newest registered version wins.
 */
export function registryStataExe({ versions = 22, spawn = spawnSync } = {}) {
  if (!WINDOWS) return null;
  for (let version = versions; version >= 14; version -= 1) {
    const key = `HKLM\\SOFTWARE\\Classes\\Stata${version}Do\\shell\\open\\command`;
    let probe;
    try {
      probe = spawn('reg', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
    } catch {
      return null;
    }
    if (probe.status !== 0 || !probe.stdout) continue;
    const match = /"([^"]+\.exe)"/i.exec(probe.stdout) ?? /(\S+\.exe)/i.exec(probe.stdout);
    if (match && existsSync(match[1])) return toSlashes(match[1]);
  }
  return null;
}

/**
 * The folder holding the shared libraries.
 *
 * @param {{stataHome?: string|null, stataExe?: string|null, registry?: boolean, search?: boolean}} [options]
 */
export function findStataHome({ stataHome = null, stataExe = null, registry = true, search = true } = {}) {
  const explicit = normalizeRoot(stataHome ?? process.env.STATA_COPILOT_STATA_HOME);
  if (explicit && DLL_NAMES.some((dll) => existsSync(`${explicit}/${dll}`))) return explicit;

  const exe = stataExe ?? process.env.STATA_COPILOT_STATA_EXE;
  const fromExe = homeFromExe(exe);
  if (fromExe && DLL_NAMES.some((dll) => existsSync(`${fromExe}/${dll}`))) return fromExe;

  if (search) {
    for (const candidate of homeCandidates()) {
      const root = normalizeRoot(candidate);
      if (root && DLL_NAMES.some((dll) => existsSync(`${root}/${dll}`))) return root;
    }
  }

  if (registry) {
    const registered = registryStataExe();
    const home = homeFromExe(registered);
    if (home && DLL_NAMES.some((dll) => existsSync(`${home}/${dll}`))) return home;
  }
  return null;
}

/**
 * The executable used for batch runs and background jobs.
 *
 * @param {{stataExe?: string|null, stataHome?: string|null, registry?: boolean, search?: boolean}} [options]
 */
export function findStataExe({ stataExe = null, stataHome = null, registry = true, search = true } = {}) {
  const explicit = stataExe ?? process.env.STATA_COPILOT_STATA_EXE;
  if (explicit && existsSync(explicit)) return toSlashes(explicit);

  // A home almost always contains the exe, and this is the setting people are
  // told to fill in for the embedded engine.
  const home = stataHome ?? process.env.STATA_COPILOT_STATA_HOME;
  if (home) {
    const fromHome = exeInHome(home);
    if (fromHome) return fromHome;
  }

  const resolvedHome = findStataHome({ stataHome, stataExe: explicit, registry, search });
  if (resolvedHome) {
    const fromHome = exeInHome(resolvedHome);
    if (fromHome) return fromHome;
  }

  if (registry) return registryStataExe();

  if (search) {
    for (const candidate of homeCandidates()) {
      const root = normalizeRoot(candidate);
      const found = root ? exeInHome(root) : null;
      if (found) return found;
    }
  }
  return null;
}

/** Which edition the DLLs in a home belong to (`mp` when unsure). */
export function editionFromHome(home) {
  const root = normalizeRoot(home);
  if (!root) return 'mp';
  for (const edition of EDITIONS) {
    if (existsSync(`${root}/${edition}-64.dll`)) return edition;
  }
  return 'mp';
}

/**
 * Everything the callers need, with the source of each answer, so `--doctor`
 * can explain itself instead of printing a bare null.
 */
export function describeStata({ stataHome = null, stataExe = null, registry = true, search = true } = {}) {
  const home = findStataHome({ stataHome, stataExe, registry, search });
  const exe = findStataExe({ stataExe, stataHome: home ?? stataHome, registry, search });
  const edition = home ? editionFromHome(home) : editionFromExe(exe) ?? 'mp';
  const source = stataHome && home === normalizeRoot(stataHome)
    ? 'stataHome'
    : stataExe && exe && homeFromExe(stataExe) === home
      ? 'stataExe'
      : home
        ? 'search'
        : null;
  return {
    home,
    exe,
    edition,
    source,
    hint:
      home && exe
        ? null
        : 'Set --stata-home to the folder that contains mp-64.dll (for example "D:/") and --stata-exe to StataMP-64.exe; the environment variables STATA_COPILOT_STATA_HOME and STATA_COPILOT_STATA_EXE do the same.',
  };
}

/**
 * Package identity — single source of truth.
 *
 * The version printed by `--version`, reported in `initialize.serverInfo` and
 * written into the ledger must never disagree, so it is read from
 * package.json instead of being repeated in three files.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

export const PACKAGE_NAME = pkg.name;
export const VERSION = pkg.version;
export const SERVER_INFO = Object.freeze({ name: PACKAGE_NAME, version: VERSION });

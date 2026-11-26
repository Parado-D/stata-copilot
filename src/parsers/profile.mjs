/**
 * `stata_profile_data` transcript → dataset header and per-variable rows.
 *
 * Variable rows are `PROFILE|name|type|format|nmiss|label`; the header comes
 * from `describe`, whose layout differs slightly between `describe` and
 * `describe, short`, so each fact is matched independently.
 */

import { toNumber } from './text.mjs';

export function parseProfileRows(source) {
  const variables = [];
  for (const line of String(source ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s*PROFILE\|([^|]*)\|([^|]*)\|([^|]*)\|\s*(\S*)\|\s*(.*)$/);
    if (!m) continue;
    variables.push({
      name: m[1],
      type: m[2],
      format: m[3],
      missing: toNumber(m[4]) ?? null,
      label: m[5].trim(),
    });
  }
  return variables;
}

export function parseDatasetHeader(source) {
  const t = String(source ?? '');
  return {
    source: t.match(/Contains data from\s+(.+?)\s*$/m)?.[1]?.trim() ?? null,
    observations: toNumber(t.match(/Observations:\s+([\d,]+)/)?.[1]?.replace(/,/g, '') ?? ''),
    variables: toNumber(t.match(/Variables:\s+(\d+)/)?.[1] ?? ''),
    size: t.match(/Size:\s+([\d,.]+[KM]?)/)?.[1] ?? null,
    label: t.match(/^\s*Label:\s*(.+?)\s*$/m)?.[1]?.trim() ?? null,
  };
}

/**
 * Read a Stata error out of a transcript or a batch log.
 *
 * A batch (`StataMP-64.exe /e /q do x.do`) exits 0 even when the do-file
 * aborts, so the log is the only source of truth. The shape Stata writes is
 *
 *   . regress price mpg //
 *   >   weight
 *   weight:  factor variables may not contain negative values
 *   r(111);
 *
 * i.e. the command (echoed with `. ` and `> ` continuation prefixes) comes
 * first, the message second, the `r(NNN);` code last. We report the *first*
 * error: later ones are usually Stata re-reporting after `end of do-file`.
 */

const CODE = /^r\((\d+)\);\s*$/;

/**
 * @param {string} output
 * @returns {{code: string, command: string|null, message: string|null}|null}
 */
export function parseFirstError(output) {
  const text = String(output ?? '');
  if (!text) return null;
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const match = CODE.exec(lines[i].trim());
    if (!match) continue;

    const continuation = [];
    let command = null;
    let message = null;

    for (let j = i - 1; j >= 0 && j > i - 60; j--) {
      const line = lines[j];
      if (/^>\s?/.test(line)) {
        continuation.unshift(line.replace(/^>\s?/, ''));
        continue;
      }
      if (/^\.\s?/.test(line)) {
        command = [line.replace(/^\.\s?/, ''), ...continuation].join(' ').replace(/\s+/g, ' ').trim();
        break;
      }
      if (!line.trim()) {
        if (continuation.length) break;
        continue;
      }
      // The first plain line above the code is the message when we have not
      // reached the echoed command yet.
      message = line.trim();
      if (continuation.length) break;
    }

    return { code: `r(${match[1]});`, command, message };
  }

  return null;
}

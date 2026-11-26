# Extending stata-copilot

Three seams are designed to be extended without touching the protocol: **tools**, **engines**, and
**policy rules**. Each recipe below is the whole change, in the order you would actually do it.
`npm run test:contracts` checks that you did not break a seam's invariant.

---

## 1. Add a tool

A tool is one module exporting `{name, title, description, inputSchema, handler}`. The registry
validates that shape at startup, so a typo fails immediately instead of at the first agent call.

### Step 1 — write the module

`src/tools/xtset_check.mjs`:

```js
import { text } from '../lib/content.mjs';

/** Panel data needs xtset before lag operators mean anything. */
export default {
  name: 'stata_xtset_check',
  title: 'Check panel is xtset',
  description:
    'Report whether the current dataset is declared as panel data (xtset), and with which panel and ' +
    'time variables. Call before any L. / F. / xtreg work — Stata silently treats an unset panel as time series.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async handler(ctx) {
    const result = await ctx.session.run({ tool: 'stata_xtset_check', code: 'xtset' });
    const declared = /panel variable:/i.test(result.output);
    return { content: [text({ declared, transcript: result.output, success: result.success })] };
  },
};
```

What the handler gets and must return:

- `ctx.session` — the shared `Session`: `run()`, `gate()`, `resolveMode()`, the ledger and last graphs.
  Every run goes through `run()` so policy and the reproducibility trail apply automatically.
- `ctx.engine` — the raw adapter, if you need a call the session does not wrap (rare).
- `ctx.config` / `ctx.log` — resolved configuration and the stderr logger.
- Return `{ content: [ {type:'text', text: JSON.stringify(payload)} ] }` or, for images,
  `image(buffer, 'image/png')`. Throw `EngineError` for an operational failure: the server turns it
  into an `isError` result the agent can read and correct.

### Step 2 — register it

In `src/tools/index.mjs`, import the module and add it to `TOOL_MODULES`. Order is the order the
agent sees in `tools/list`; put discovery tools first, destructive tools last.

```js
import xtsetCheck from './xtset_check.mjs';

export const TOOL_MODULES = [status, run, runDo, results, profile, model, graphs, breakTool, history, xtsetCheck];
```

### Step 3 — prove it

```bash
npm test               # the definition, schema and registry checks run automatically
npm run test:stata     # add one assertion against the live session
```

Rules the registry enforces for you: `name` matches `^[a-z][a-z0-9_]{2,40}$` and is unique;
`description` is at least 40 characters (it is the routing signal — write it for the agent, say when
to call and when not to); `inputSchema.type` is `object`; only the schema keywords in
`src/lib/schema.mjs` are allowed, so an unsupported keyword is a startup error rather than a silently
ignored constraint.

**Do not** call `ctx.engine.execute` directly from a new tool. You would skip the policy gate, the
truncation limit and the ledger — the three things that make runs comparable across sessions.

---

## 2. Add an engine

An engine is any object with `status()`, `execute()`, `break()`. The `http` driver talks to the local
`stata-ai-skill` service; a `spawn` driver would own the Stata process itself; a `remote` driver
would proxy a lab machine. Tools never learn which one is in use.

### Step 1 — implement the contract

`src/engines/spawn.mjs`:

```js
export class SpawnEngine {
  constructor({ stataPath = 'stata-mp', endpoint = null } = {}) { /* ... */ }

  /** @returns {Promise<object>} at least {status, busy, sessionActive, config:{stataPath}} */
  async status() { /* spawn `stata -e` once, cache the build string */ }

  /** @returns {Promise<{success, returnCode, output, error, graphs}>} */
  async execute({ code, cwd, timeout }) { /* write a temp .do, run it, read the .smcl/log */ }

  async break() { /* send the interrupt your platform supports */ }
}
```

The three rules:

1. **`execute` never throws for something Stata itself did.** A failed regression returns
   `{success:false, returnCode: ..., error: ...}`. Throw only for transport problems, and use the
   codes in `src/errors.mjs` (`OFFLINE`, `TIMEOUT`, `BAD_RESPONSE`, …).
2. **Never retry `execute`.** A rerun of `save` is not idempotent. Retry `status` — it is a read.
3. **Return graphs as `{name, png, svg, format}`** so `stata_graphs` can attach them.

### Step 2 — register it

In `src/engines/index.mjs`, add it to `ENGINES` (the map key is the `--driver` value) and export it
from the module. `createEngine()` already checks that the three methods exist, so a half-built
adapter fails at startup.

### Step 3 — prove it

```bash
node bin/stata-copilot.mjs --driver spawn --doctor   # reachability + the build it found
npm run test:stata                                   # the same smoke suite, new backend
```

The smoke suite is engine-agnostic on purpose: if it passes, the tool contract holds for that
backend.

---

## 3. Add a policy rule

Policy is data. A rule is `{id, modes, match(statement), why(statement)}` in `RULES`
(`src/policy.mjs`); warnings are `{id, match, message}` in `WARNINGS`.

```js
{
  id: 'network-fetch',
  modes: ['guarded', 'readonly'],
  match: (s) => s.word === 'net' || (s.word === 'copy' && /^https?:/i.test(s.text)),
  why: (s) => `\`${s.text.split(/\s+/)[0]}\` reaches the network — download the file yourself first.`,
}
```

`statements(code)` has already stripped `capture`/`quietly`/`noisily` prefixes and dropped comment
lines, so `match` sees the command word in `s.word` and the rest of the line in `s.text`. One
statement reports at most one refusal — the first rule listed wins, so put the most specific rule
first.

Then add both cases to `test/offline.mjs`:

```js
check('net blocked', !checkPolicy('net from https://example.org/x', { mode: 'guarded' }).allowed);
check('a local copy still works', checkPolicy('copy local.dta scratch.dta', { mode: 'guarded' }).allowed);
```

Read `SECURITY.md` before widening the model: this layer refuses *commands*, it is not an OS
sandbox, and a rule that only catches the spelling you thought of is worse than a documented
limitation.

---

## 4. Adding a parser

Parsers turn one recorded transcript shape into numbers (`src/parsers/*.mjs`, re-exported from
`src/parsers/index.mjs`). Keep them pure: string in, plain object out, no engine, no I/O. That is why
`test/offline.mjs` can check the arithmetic of a p-value with no Stata installed. When a transcript
shape changes in a new Stata release, the fix is one file plus one recorded transcript in the test —
not a change to any tool.

If you add a parser, export it from the barrel; tools import from the barrel, never from a single
file, so a later swap stays a one-line change.

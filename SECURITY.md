# Security model

`stata-copilot` lets an AI agent run commands in a real Stata session. That is powerful, and the
honest description of the protection is: **a command-level policy, not an OS sandbox.**

## What the policy does

Before code reaches Stata, `src/policy.mjs` splits it into statements and checks the first word of
each one. In the default `guarded` mode it refuses:

| Rule | Refuses | Why |
|---|---|---|
| `shell-escape` | any statement starting with `!` | runs an OS command |
| `shell` | `shell`, `winexec`, `xshell`, `dos`, `unixcmd` | same, spelled differently |
| `filesystem-destructive` | `erase`, `rmdir` | deletes data or directories |

`readonly` additionally refuses disk writes: `save`, `saveold`, `export`, `outsheet`, `outfile`,
`putexcel`, `putdocx`, `putpdf`, `esttab`, `estout`, `outreg2`, `estimates`, `file`, `log`, `mkdir`,
`copy`, `type`.

Refusals happen before Stata sees the code, carry a stable rule id, and are returned as an error
result with the offending command — so the agent can correct itself instead of retrying blindly.
`clear all` is a warning, not a refusal, because it is sometimes intended.

When `--root` is configured, a run whose `cwd` falls outside the allow-list is refused
(`CWD_BLOCKED`). Without roots there is no working-directory restriction, and `stata_status` says so.

## What it does not do

Be explicit with users about these:

1. **It is not an OS sandbox.** The server and Stata run with the user's full privileges. A command
   the rules do not recognise can still do anything that user can do.
2. **`do` / `run` files are only checked at the call site.** `stata_run_do` reads the file and checks
   every statement, but a `.do` file that itself calls an unchecked path, or a macro that expands to
   a shell escape, is beyond regex inspection. Treat a `.do` file from an untrusted source as code.
3. **Macros and indirection.** `local cmd "erase x"` followed by `` `cmd' `` defeats a text check.
   The rules are a guardrail against an agent that types a dangerous command, not against an
   adversary who can write Stata.
4. **`open` mode is an escape hatch.** It exists for users who know what they are doing. The active
   mode is printed in every result so the choice stays visible.
5. **The HTTP service is trusted.** The engine talks to `stata-ai-skill` on localhost with no
   authentication. Anyone who can reach that port can run Stata. Do not expose it on a network
   interface.
6. **No secrets are stored by this project.** The ledger records commands, cwd and timings, not the
   contents of your data. It is written into the project directory, so commit it only if you mean to.

## Reporting a problem

If you find a command that escapes the intent of a rule, open an issue with:

- the exact `code` string,
- the mode, and
- what happened (rather than what you expected).

Please do not include proprietary data or `.dta` files. If the issue is exploitable in a way that
needs privacy, say so and we will move the conversation off the tracker.

## Operating advice

- Default to `guarded` with `--root` set to the paper's folder.
- Use `readonly` for review or reporting sessions where the agent must not touch results.
- Keep analysis `.do` files in version control; the ledger supplements them, it does not replace them.
- Run the service on localhost only, and stop it when you are done.

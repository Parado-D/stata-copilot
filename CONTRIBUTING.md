# Contributing

Thanks for looking. This project has no build step and no dependencies, so contributing is mostly
`git clone`, edit, `npm test`.

## Setup

```bash
git clone https://github.com/<you>/stata-copilot.git
cd stata-copilot
npm test              # contracts + offline: no Stata needed
```

To run the live suite you also need Stata and the `stata-ai-skill` service:

```bash
node bin/stata-copilot.mjs --doctor   # says whether the service is reachable
npm run test:stata                    # drives the real session
```

## The rules that matter

1. **No runtime dependencies.** The value proposition is `git clone` and run: no `npm install`, no
   supply chain to audit. Use `node:` built-ins. A pull request that adds a dependency needs a very
   good reason and will usually be declined.
2. **Tools return structure, not transcripts.** A new tool's payload is JSON an agent can branch on.
   Transcripts stay in the payload for debugging, but the contract is the fields.
3. **Every run goes through `Session.run()`.** That is where the policy gate, truncation and ledger
   live. Calling the engine directly from a tool is a bug even when it appears to work.
4. **Errors carry a code.** Use `EngineError` with a code from `src/errors.mjs` and a message the
   agent can act on ("start the service", "fix the arguments"), not a stack-trace fragment.
5. **Policy is data.** Add a rule to `RULES`, not an `if` to a handler, and read `SECURITY.md` first.

## Before you open a pull request

```bash
npm run check           # syntax + contracts
npm test                # contracts (36) + offline (35)
npm run test:stata      # if you touched tools, engines or parsers
```

All three must pass. If your change alters a tool's output shape, update `README.md`, the skill in
`skills/stata-analysis/SKILL.md`, and the corresponding assertion in `test/smoke.mjs` in the same
commit — a drifted contract is the failure mode this project exists to prevent.

## Commit messages

Conventional prefixes (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`), imperative mood, and a body
that says *why*. If a change is a judgement call, say what you rejected and why; that sentence is
what a future maintainer needs.

## Adding tests

- `test/contracts.mjs` — structural invariants (module graph, tool definitions, config table,
  engine registry). Add a case when you add a seam.
- `test/offline.mjs` — behaviour against recorded transcripts and a stub engine. Add a case for
  every parser or policy change; no Stata required.
- `test/smoke.mjs` — the live contract. Add a case for every new tool and every output-shape change.

## Where to start

- `docs/EXTENDING.md` — add a tool, an engine, a policy rule, a parser.
- `docs/DESIGN.md` — why the architecture looks like this (in Chinese), including the comparison
  with the projects this one sits next to.
- Issues labelled `good first issue` are scoped to one file and one test.

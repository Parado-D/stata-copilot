import { text } from '../lib/content.mjs';

/**
 * `datasignature` as a tool: the fingerprint an agent can quote in a report
 * ("same data before and after", "N observations changed") instead of asserting
 * that a script was harmless.
 */
export default {
  name: 'stata_signature',
  title: 'Fingerprint the loaded data',
  description:
    'Read the `datasignature` fingerprint of the dataset currently in memory: observations, variables, two data hashes, and the sort order. Compare two fingerprints to prove whether a command or do-file changed the data. Optionally load a .dta first.',
  inputSchema: {
    type: 'object',
    properties: {
      dataset: { type: 'string', description: 'Optional .dta path to load before fingerprinting.' },
      cwd: { type: 'string', description: 'Working directory for the load.' },
      timeout: { type: 'number', minimum: 1, maximum: 600, description: 'Seconds for the load (default 120).' },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    if (args.dataset) {
      const result = await ctx.session.run({
        tool: 'stata_signature',
        code: `use "${String(args.dataset).replace(/"/g, '')}", clear`,
        cwd: args.cwd,
        timeout: args.timeout ?? 120,
      });
      if (!result.success) return { content: [text({ dataset: args.dataset, ...result })], isError: true };
    }
    const signature = await ctx.session.signature({ cwd: args.cwd });
    return { content: [text(signature)] };
  },
};

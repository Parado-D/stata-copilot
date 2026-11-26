import { text } from '../lib/content.mjs';

export default {
  name: 'stata_history',
  title: 'Read the run ledger',
  description:
    'List commands executed through this server (newest last), with success, return code, duration and cwd. The same rows are appended to `<cwd>/.stata-copilot/runs.jsonl` — a reproducibility trail for the paper.',
  inputSchema: {
    type: 'object',
    properties: { limit: { type: 'number', minimum: 1, maximum: 200, description: 'How many entries (default 20).' } },
    additionalProperties: false,
  },
  async handler(ctx, { limit = 20 } = {}) {
    const n = Math.max(1, Math.min(Number(limit) || 20, 200));
    return {
      content: [text({ total: ctx.session.ledger.entries.length, entries: ctx.session.ledger.tail(n) })],
    };
  },
};

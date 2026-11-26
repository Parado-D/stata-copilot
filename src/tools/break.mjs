import { text } from '../lib/content.mjs';

export default {
  name: 'stata_break',
  title: 'Interrupt the running command',
  description:
    'Send a break signal to Stata. Use after a timeout or runaway loop; then verify with stata_status that `busy` is false before running anything else.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(ctx) {
    const stopped = await ctx.engine.break();
    let status = null;
    try {
      const st = await ctx.engine.status();
      status = { status: st.status ?? null, busy: Boolean(st.busy), sessionActive: Boolean(st.sessionActive) };
    } catch {
      // A status read may fail while Stata unwinds; the break still happened.
    }
    return { content: [text({ interrupted: true, engine: stopped, status })] };
  },
};

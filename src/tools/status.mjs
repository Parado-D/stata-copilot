import { text } from '../lib/content.mjs';

export default {
  name: 'stata_status',
  title: 'Stata session status',
  description:
    'Report the Stata session state: service reachability, Stata path/version/edition, licence, whether a command is running, and the active policy mode. Call this first when a Stata tool fails.',
  inputSchema: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        enum: ['json', 'stata'],
        description: "`stata` returns the service's raw Stata-side report.",
      },
    },
    additionalProperties: false,
  },
  async handler(ctx, { format } = {}) {
    const st = await ctx.engine.status({ format });
    const body = {
      reachable: true,
      endpoint: ctx.engine.endpoint,
      status: st.status ?? null,
      sessionActive: Boolean(st.sessionActive),
      busy: Boolean(st.busy),
      skillVersion: st.skillVersion ?? null,
      stata: {
        path: st.config?.stataPath ?? null,
        version: st.recommendedCandidate?.version ?? null,
        edition: st.recommendedCandidate?.edition ?? null,
      },
      licenseFound: Boolean(st.licenseFound),
      setup: st.setup ?? null,
      capabilities: st.capabilities ?? null,
      policy: { mode: ctx.session.mode, roots: ctx.session.roots },
      raw: format === 'stata' ? st : undefined,
    };
    return { content: [text(body)] };
  },
};

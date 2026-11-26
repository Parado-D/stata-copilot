import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { image, text } from '../lib/content.mjs';

const MAX_ATTACHMENTS = 5;

export default {
  name: 'stata_graphs',
  title: 'Fetch graph images',
  description:
    'Return Stata graphs as images the agent can actually look at. Defaults to the graphs produced by the most recent run; pass explicit file paths to fetch older ones. PNG/JPEG are returned as image content; SVG-only output is reported by path.',
  inputSchema: {
    type: 'object',
    properties: {
      files: { type: 'array', items: { type: 'string' }, maxItems: 20, description: "Absolute paths to .png/.jpg files. Omit to use the last run's graphs." },
      max: { type: 'number', minimum: 1, maximum: MAX_ATTACHMENTS, description: `Maximum number of images to attach (1-${MAX_ATTACHMENTS}, default 2).` },
    },
    additionalProperties: false,
  },
  async handler(ctx, { files, max = 2 } = {}) {
    const limit = Math.max(1, Math.min(Number(max) || 2, MAX_ATTACHMENTS));
    const candidates = files?.length
      ? files.map((f) => ({ png: f, svg: null, name: path.basename(f) }))
      : ctx.session.state.lastGraphs;
    if (candidates.length === 0) {
      return {
        content: [
          text({
            images: 0,
            note: 'No graphs captured yet. Add `graph export output/foo.png, replace width(1200)` to the code, then call stata_graphs.',
          }),
        ],
      };
    }
    const content = [];
    const reported = [];
    let attached = 0;
    for (const graph of candidates.slice(0, limit)) {
      const file = graph.png ?? graph.file ?? null;
      const attachable = file && /\.(png|jpe?g)$/i.test(file) && existsSync(file) && attached < limit;
      if (attachable) {
        const buffer = await readFile(file);
        content.push(image(buffer, /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'image/png'));
        reported.push({ name: graph.name ?? null, path: file, bytes: buffer.length });
        attached += 1;
      } else {
        reported.push({
          name: graph.name ?? null,
          path: file ?? graph.svg ?? null,
          note: 'not attached (SVG or missing file)',
        });
      }
    }
    content.unshift(text({ images: attached, files: reported }));
    return { content };
  },
};

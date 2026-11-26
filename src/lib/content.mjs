/**
 * MCP content helpers.
 *
 * Tool results are built here so every tool returns the same shapes: text for
 * everything the agent reads, image for graphs it must look at. stdout belongs
 * to the protocol, so nothing in this module may write to it.
 */

/** A text content block; objects are pretty-printed so the agent can scan them. */
export const text = (value) => ({
  type: 'text',
  text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
});

/** An image content block from raw bytes. */
export const image = (buffer, mimeType = 'image/png') => ({
  type: 'image',
  data: Buffer.from(buffer).toString('base64'),
  mimeType,
});

/**
 * Keep the head and the tail of a long transcript: Stata puts the command echo
 * at the top and the error/result at the bottom, which is exactly what an agent
 * needs when a run is too long to pass through.
 */
export function truncate(value, max) {
  const s = String(value ?? '');
  if (s.length <= max) return { value: s, truncated: false };
  const head = Math.floor(max * 0.35);
  const tail = max - head;
  return {
    value: `${s.slice(0, head)}\n... [${s.length - max} characters omitted] ...\n${s.slice(s.length - tail)}`,
    truncated: true,
  };
}

// Server-Sent Events helpers: parse an upstream SSE stream and write SSE frames.

// Async generator yielding { event, data, id } from a fetch Response body stream.
export async function* parseSSE(stream) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buf = '';
  let event = 'message';
  let data = [];
  let id = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (line === '') {
        if (data.length) yield { event, data: data.join('\n'), id };
        event = 'message';
        data = [];
        id = '';
        continue;
      }
      if (line.startsWith(':')) continue; // comment / heartbeat

      const c = line.indexOf(':');
      const field = c === -1 ? line : line.slice(0, c);
      let val = c === -1 ? '' : line.slice(c + 1);
      if (val.startsWith(' ')) val = val.slice(1);

      if (field === 'event') event = val;
      else if (field === 'data') data.push(val);
      else if (field === 'id') id = val;
    }
  }
  if (data.length) yield { event, data: data.join('\n'), id };
}

// Write one SSE frame to a Node http.ServerResponse.
export function sseWrite(res, obj, opts = {}) {
  let chunk = '';
  if (opts.event) chunk += `event: ${opts.event}\n`;
  if (opts.id) chunk += `id: ${opts.id}\n`;
  chunk += `data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`;
  res.write(chunk);
}

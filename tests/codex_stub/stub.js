// Loopback stub of the Responses API for #13732: scripted turns. Turn 1 answers with a shell call (foreground), turn 2 with a second (background job), then a final message.
const http = require('http');
const PORT = Number(process.env.STUB_PORT || 0);
const calls = JSON.parse(process.env.STUB_CALLS || '["echo hello"]'); // shell command lines, one per turn (Codex 0.166 tool exec_command {cmd})
let turn = 0; const log = [];
const sse = (res, evs) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const e of evs) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); res.end(); };
const srv = http.createServer((req, res) => {
  let body = ''; req.on('data', d => body += d); req.on('end', () => {
    if (turn === 0) require('fs').writeFileSync('first-request.json', body);
    log.push(req.method + ' ' + req.url); console.error('REQ', req.method, req.url, body.length);
    if (req.method === 'POST' && /\/responses$/.test(req.url)) {
      const id = 'resp_' + (++turn);
      // the next scripted call is chosen by how many tool outputs the request already carries, so extra requests (a title, a retry) cannot use one up
      let done = 0; try { done = (JSON.parse(body).input || []).filter(i => i && i.type === 'function_call_output').length; } catch (e) {}
      const call = calls[done];
      if (call) {
        const item = { type: 'function_call', id: 'fc_' + turn, call_id: 'call_' + turn, name: 'exec_command', arguments: JSON.stringify({ cmd: call, yield_time_ms: Number(process.env.STUB_YIELD || 1500) }) };
        sse(res, [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } }]);
      } else {
        const item = { type: 'message', role: 'assistant', id: 'm_' + turn, content: [{ type: 'output_text', text: 'done' }] };
        sse(res, [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } }]);
      }
    } else { res.writeHead(404); res.end('{}'); }
  });
});
srv.listen(PORT, '127.0.0.1', () => console.log('PORT', srv.address().port));

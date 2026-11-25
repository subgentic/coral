// Private review routes for document fixtures. Published comments stay separate.
const draftReviewStub = hex => `(() => {
 const real = window.fetch, hex = ${JSON.stringify(hex)};
 window.__drafts = []; window.__draftWrites = []; let revision = 0, next = 1000;
 const json = (value, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }));
 window.fetch = (url, options = {}) => {
  const u = new URL(String(url), location.href), method = options.method || 'GET', root = '/api/artifacts/' + hex + '/review-drafts';
  if (!u.pathname.includes(root)) return real(url, options);
  const writable = (window.__role === undefined || window.__role === 'owner') && !window.__viewOnly && !window.__locked;
  if (method === 'GET') return json({ drafts_supported: true, drafts: window.__drafts, count: window.__drafts.length, revision, can_write: writable, can_send: true, targets: ['Writer'] });
  const body = options.body ? JSON.parse(options.body) : {};
  if (method === 'POST' && u.pathname.endsWith(root + '/send')) return (async () => {
   for (const draft of window.__drafts) {
    const response = await real(u.pathname.replace('/review-drafts/send', '/comments'), { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...draft, images:(draft.images || []).map(i=>i.hex)}) });
    if (!response.ok) return response;
   }
   window.__drafts = []; revision++; return json({status:'sent', request_id:body.request_id, count:0, revision});
  })();
  window.__draftWrites.push({ method, url: String(url), body });
  if (!writable) return json({ code: 'comments_forbidden' }, 403);
  if (method === 'POST' && u.pathname.endsWith(root)) {
   const draft = { ...body, id: next++, images: (body.images || []).map(hex => ({ hex, name: 'marked.png' })) };
   window.__drafts.push(draft); revision++; return json(draft, 201);
  }
  return json({ code: 'not_found' }, 404);
 };
 return true;
})()`;
// Tests explicitly press Send comments after verifying that Save draft did not publish.
async function sendSavedDrafts(ev, waitFor, root = '') {
 const barRoot = root === '#preview-main' ? '#preview-pane' : root;
 await waitFor(`window.__drafts.length > 0 && !!document.querySelector('${barRoot} .ac-draft-bar button:not(:disabled)')`, 'private draft is ready for explicit batch send', 5000);
 await ev(`document.querySelector('${barRoot} .ac-draft-bar button').click(); true`);
 await waitFor(`window.__drafts.length === 0`, 'explicit batch send completes', 5000);
}
module.exports = { draftReviewStub, sendSavedDrafts };

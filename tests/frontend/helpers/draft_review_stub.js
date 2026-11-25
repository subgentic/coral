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
module.exports = { draftReviewStub };

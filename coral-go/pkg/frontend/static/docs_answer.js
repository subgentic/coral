/* The answer a link into Docs wants shown (#10765): Settings' Learn more beside Default permission mode opens the How do I answer "What the permission modes allow", not a box behind Settings. The link
   names the heading; the Docs page scrolls to it once the topic is drawn. Taken once: the next topic opened by hand starts at its top. */

let wanted = '';

/** Remember the heading of the answer the next Docs page should open at. */
export function wantDocsAnswer(heading) { wanted = String(heading || ''); }

/** The heading wanted, once ('' when none): asking clears it. */
export function takeDocsAnswer() { const h = wanted; wanted = ''; return h; }

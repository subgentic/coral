/* #22094: seeing a question is not answering it. Browser-local, bounded marks,
 * qualified by computer/team/item and the exact request version. */
import { browserLocal } from './safe_storage.js';
import { sessionServer } from './server_base.js';
const KEY = 'coral-needs-question-read';
const hash = text => { let n = 2166136261; for (const c of String(text || '')) n = Math.imul(n ^ c.charCodeAt(0), 16777619); return (n >>> 0).toString(36); };
const key = s => JSON.stringify([sessionServer(s), s.operatorAsk?.board || s.board_project || '', s.operatorAsk?.id || s.session_id, s.operatorAsk?.at || s.waiting_since || '', hash(s.operatorAsk?.text || s.waiting_summary)]);
export const isQuestionItem = s => !!s.operatorAsk || ['ask', 'question', 'permission'].includes(s.waiting_kind);
let keptRaw = null, marks = [];
const read = () => { const raw = browserLocal.get(KEY) || '[]'; if (raw === keptRaw) return marks; keptRaw = raw; try { const value = JSON.parse(raw); marks = Array.isArray(value) ? value.filter(x => typeof x === 'string').slice(-500) : []; } catch { marks = []; } return marks; };
export const questionWasRead = s => isQuestionItem(s) && read().includes(key(s));
export function markQuestionRead(s, on = true) { if (!isQuestionItem(s) || questionWasRead(s) === on) return; const next = read().filter(k => k !== key(s)); if (on) next.push(key(s)); browserLocal.set(KEY, JSON.stringify(next.slice(-500))); document.dispatchEvent(new CustomEvent('coral:question-read')); }

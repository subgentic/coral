/* The usage-limit summary's dismiss (#21676): remembers, per browser, the summary the person closed (usage_limit.js shows it again when the limited agents or a reset time change). Lazy: loaded with the first limited agent. */
import { browserLocal } from './safe_storage.js';
import { registerActions } from './actions.js';
import { redrawLiveList } from './list_hooks.js';

const DISMISSED = 'coral-usage-limit-dismissed'; // the key usage_limit.js reads

registerActions({ 'usage-limit-dismiss': el => { try { browserLocal.set(DISMISSED, String(el.dataset.key || '')); } catch { /* per-viewer only */ } redrawLiveList(); } });

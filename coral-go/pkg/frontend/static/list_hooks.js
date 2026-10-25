/* The hook other modules call to redraw the sidebar's agent list (#3835). render.js owns the redraw (renderLiveSessions) and many
 * sections around it ask for one; if they imported it back from render.js they could not live in their own modules (an import
 * cycle). render.js registers its renderer here once; everyone else imports this small module, which imports nothing of render.js. */
import { state } from './state.js';

let _render = null;
let _again = null;

/** render.js registers the function that draws the agent list from a sessions array. */
export function registerLiveListRenderer(fn) { _render = fn; }

/** render.js registers a function that draws the list again from the sessions it drew last (a section that changes only its own part of the list asks for it: the sessions are the ones on screen, not state.liveSessions). */
export function registerLastRedraw(fn) { _again = fn; }
export function redrawLast() { if (_again) _again(); }

/** Redraw the agent list from the current sessions (nothing happens before render.js has registered). */
export function redrawLiveList() {
    if (_render) _render(state.liveSessions || []);
}

/** The agent list's element: #live-sessions-list in the sidebar, or the same element as #mobile-session-list while it sits in the phone's page (#4497). */
export function liveListEl() {
    return document.getElementById('live-sessions-list') || document.getElementById('mobile-session-list');
}

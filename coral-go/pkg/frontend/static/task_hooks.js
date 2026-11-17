/* The subagent list asks the Tasks view to redraw through this small hook (#3837), without importing tasks.js. Dialog closing belongs to each view (#19056). */

let _view = null;

/** tasks.js registers the function the subagent list calls back. */
export function registerTaskView(view) { _view = view; }

/** Redraw the board task list (nothing happens before tasks.js has registered). */
export function redrawBoardTaskList() { if (_view) _view.renderBoardTaskList(); }

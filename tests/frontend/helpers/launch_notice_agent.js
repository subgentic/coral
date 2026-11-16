// A notice geometry test needs a local agent after #16595. Register it with the harness
// so its list stub marks the response served and install() restores it after an early real feed update.
exports.PRELOAD = `window.__m.add('Notice fixture', '', 0, { session_id: 'notice-fixture', sleeping: false });`;

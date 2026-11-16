// Walk 65 pins (#17345): items 1, 2, 4 and 7, read from the modules' source (the browser proof for 6 is in team_goals_default_filter_browser, for 3 in team_health_all_clear_line).
import fs from 'node:fs';
import assert from 'node:assert/strict';
const S = n => fs.readFileSync(new URL('../../coral-go/pkg/frontend/static/' + n, import.meta.url), 'utf8');
// 1. a theme's accent moves the dim and the rgb that switches, primary buttons and progress bars read
const acc = S('theme_accent.js');
const withAccent = new Function(acc.slice(acc.indexOf('export function withAccent'), acc.length).replace('export function', 'function') + '; return withAccent;')();
const o = withAccent({ '--accent': '#ff8800' });
assert.equal(o['--accent-rgb'], '255, 136, 0'); assert.match(o['--accent-dim'], /color-mix\(in srgb, #ff8800/);
assert.equal(withAccent({ '--accent': '#ff8800', '--accent-dim': '#111111' })['--accent-dim'], '#111111', 'a dim the theme sets stays');
assert.match(S('theme_config.js'), /followAccent\(cssVar, value\)/, 'the editor moves the dim with the accent');
// 2. the bundled themes cannot be deleted from the theme dialog
assert.match(S('theme_config.js'), /\['Dark', 'GhostV3', 'Obsidian'\]\.includes\(name\)/, 'the bundled themes refuse Delete');
// 4. the team's name, never its internal id, in Jump to and the zip name
assert.match(S('jump_to.js'), /\$\{keyLabel\(s\.board_project\)\}/, 'Jump to names the team');
assert.match(S('artifact_team_files.js'), /`\$\{keyLabel\(project\)\}-files`/, 'the zip is named for the team');
// 7. Check's last answer is kept and shown when Settings opens
const f = S('settings_fields.js');
assert.match(f, /coral-accounts-last-check/); assert.match(f, /last checked/);
console.log('PASS walk65_batch_pins: accent derives dim and rgb, bundled themes refuse Delete, team name in Jump to and the zip, accounts keep their last check');

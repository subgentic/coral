// #16371 (Operator #15819: Sleep is the first item of a sidebar row's menu): the awake menu and the ended or terminal-gone menu both open with Sleep, before Open agent tab. Read from the source's menu templates.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../../coral-go/pkg/frontend/static/session_rows.js', import.meta.url), 'utf8');
const awake = src.slice(src.indexOf('const _awakeMenu = `'), src.indexOf('Restart, same settings', src.indexOf('const _awakeMenu = `')));
assert.ok(awake.indexOf('data-mode="sleep"') > 0 && awake.indexOf('data-mode="sleep"') < awake.indexOf('Open agent tab'), 'the awake menu starts with Sleep, before Open agent tab');
const asleep = src.slice(src.indexOf('const _sleepingMenu = `'), src.indexOf('const _awakeMenu = `'));
const endedSleep = asleep.indexOf('data-mode="sleep"');
assert.ok(endedSleep > 0 && endedSleep < asleep.indexOf('Open agent tab'), 'the ended and terminal-gone menu starts with Sleep (after its note), before Open agent tab');
console.log('PASS sidebar_menu_sleep_first: Sleep is the first item of the row menus');

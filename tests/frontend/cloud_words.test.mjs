// cloud_words.js: the closed permissions summary (permissive switches named, a protective one off marked), the Operator sentence and the spelled code.
import assert from 'node:assert/strict';
import { morePermsWords, operatorLine, spellCode, describe, enrolledRetrying, rekeyText, autoAcceptChangedText, severalAccountsText, codeExpired, codeUncollected, UNCOLLECTED_TEXT, OFF_TEXT, EXPIRED_TEXT, HUB_ACCESS_URL, LEVEL_NOW } from '../../coral-go/pkg/frontend/static/cloud_words.js';

assert.deepEqual(morePermsWords({}, null), { text: 'More Coral Hub permissions: may change cross-team settings', warn: '' }, 'cross-team is on unless turned off');
assert.equal(morePermsWords({ hub_cross_team_settings: false }, false).text, 'More Coral Hub permissions: none on');
assert.equal(morePermsWords({ hub_cross_team_settings: true }, true).text, 'More Coral Hub permissions: may change cross-team settings and act as the Operator');
assert.equal(morePermsWords({ hub_cross_team_settings: true, hub_relaunch_updates: true }, true).text, 'More Coral Hub permissions: may change cross-team settings, act as the Operator and relaunch Coral to install updates');
assert.equal(morePermsWords({ hub_cross_team_settings: false, hub_relaunch_updates: true }, false).text, 'More Coral Hub permissions: may relaunch Coral to install updates');
assert.equal(morePermsWords({ hub_relaunch_updates: false, hub_cross_team_settings: false }, null).text, 'More Coral Hub permissions: none on', 'an Operator this page cannot tell about is not claimed');
assert.equal(morePermsWords({ redact_tokens: true }, null).warn, '', 'tokens hidden: the safe state, no mark');
assert.equal(morePermsWords({}, null).warn, '', 'unset is the default, on');
assert.equal(morePermsWords({ redact_tokens: false }, null).warn, 'Tokens are visible to view-only hub users');
assert.equal(operatorLine(true), 'Coral Hub may act as the Operator.');
assert.equal(operatorLine(false), 'Coral Hub may not act as the Operator.');
assert.equal(operatorLine(null), '');
assert.equal(spellCode('WXYZ-1234'), 'W X Y Z, 1 2 3 4');
assert.equal(spellCode('H2XR-HS16'), 'H 2 X R, H S 1 6');
assert.equal(spellCode(''), '');
assert.equal(spellCode(undefined), '');
console.log('cloud_words: ok');

// The status sentences of the connect panel (moved here from cloud_connect.js, #8386).

assert.equal(describe({ state: 'off' }), OFF_TEXT);
assert.ok(OFF_TEXT.includes('cloud-url https://app.coralhub.dev') && OFF_TEXT.endsWith('coral cloud connect'), 'the off sentence names the address to start with and the command to connect');
assert.equal(describe({ state: 'idle', hub_url: 'https://h.example' }), 'Ready to connect to https://h.example. Nothing is sent until you connect.');
assert.equal(describe({ state: 'idle', last_error_code: 'hub_unreachable' }), 'Coral could not reach Coral Hub. Check your connection and try again.');
assert.equal(describe({ state: 'idle', last_error_code: 'rate_limited' }), 'Coral Hub is busy. Try again in a moment.');
assert.equal(describe({ state: 'idle', last_error_code: 'code_expired' }), EXPIRED_TEXT + HUB_ACCESS_URL);
assert.equal(describe({ state: 'idle', last_error: 'it broke' }), 'it broke');
assert.equal(describe({ state: 'enrolling' }), 'Waiting for you to approve…');
assert.equal(describe({ state: 'connecting', label: 'mac' }), 'Connecting as "mac"…');
assert.equal(describe({ state: 'connecting' }), 'Connecting…');
assert.equal(describe({ state: 'connected', label: 'mac' }), 'Connected to Coral Hub as mac.');
assert.equal(describe({ state: 'connected' }), 'Connected to Coral Hub.');
assert.match(describe({ state: 'retrying', label: 'mac' }), /^Connected to Coral Hub as mac \(reconnecting…\)\. Coral keeps working locally meanwhile\.$/, 'enrolled and retrying reads as connected');
assert.equal(describe({ state: 'retrying', last_error: 'timeout' }), 'Not connected right now (timeout). Coral keeps working locally and will reconnect on its own.');
assert.equal(describe({ state: 'retrying' }), 'Not connected right now (retrying). Coral keeps working locally and will reconnect on its own.');
assert.equal(describe({ state: 'revoked' }), 'The hub revoked this computer, so Coral stopped retrying. Connect again to re-enroll.');
assert.equal(describe({ state: 'key_unreadable', last_error: 'no key' }), 'no key');
assert.equal(describe({ state: 'upgrade_required', last_error: 'update Coral' }), 'update Coral');
assert.equal(describe({ state: 'something_new' }), 'something_new', 'an unknown state is said as it is');

assert.equal(enrolledRetrying({ state: 'retrying', server_id: 's1' }), true);
assert.equal(enrolledRetrying({ state: 'retrying', label: 'mac' }), true);
assert.equal(enrolledRetrying({ state: 'retrying' }), false, 'retrying with no enrollment is not connected');
assert.equal(enrolledRetrying({ state: 'connected', server_id: 's1' }), false);
assert.equal(enrolledRetrying(null), false);
assert.equal(codeExpired({ state: 'idle', last_error_code: 'code_expired' }), true);
assert.equal(codeExpired({ state: 'enrolling', last_error_code: 'code_expired' }), false);
// #11463 F2: a code that ran out uncollected is not "never approved", and sends nobody to request access
assert.equal(describe({ state: 'idle', last_error_code: 'code_uncollected' }), UNCOLLECTED_TEXT);
assert.match(UNCOLLECTED_TEXT, /connect again/);
assert.doesNotMatch(UNCOLLECTED_TEXT, /closed beta|request access/);
assert.equal(codeUncollected({ state: 'idle', last_error_code: 'code_uncollected' }), true);
assert.equal(codeUncollected({ state: 'enrolling', last_error_code: 'code_uncollected' }), false);
assert.equal(codeExpired({ state: 'idle', last_error_code: 'code_uncollected' }), false, 'the access link is for the never-approved text only');

assert.match(rekeyText({ hub_url: 'https://h.example', remote_server_keys: 2, exposed: true }), /^Other accounts on this computer could read the secret key file.*discards the Coral Hub connection to https:\/\/h\.example .* and 2 remote computers' API keys/s);
assert.match(rekeyText({ remote_server_keys: 1, message: 'bad file' }), /^Coral can't use its secret key file \(bad file\)\..*1 remote computer's API key/s);
assert.match(rekeyText({}), /discards nothing stored yet\.$/);

assert.equal(autoAcceptChangedText(null), '');
assert.equal(autoAcceptChangedText({ allow_hub_auto_accept_changed: { by: 'robot' } }), '', 'only the hub or this computer is named');
assert.equal(autoAcceptChangedText({ allow_hub_auto_accept_changed: { by: 'local' }, allow_hub_auto_accept: false }), 'Turned off on this computer');
assert.equal(autoAcceptChangedText({ allow_hub_auto_accept_changed: { by: 'hub', user: 'ann' } }), 'Turned on from Coral Hub by ann');
assert.equal(autoAcceptChangedText({ allow_hub_auto_accept_changed: { by: 'hub', user: '\u202eevil\u200b' } }), 'Turned on from Coral Hub by evil', 'control and bidi characters never reach the screen');
assert.equal(autoAcceptChangedText({ allow_hub_auto_accept_changed: { by: 'hub', user: ' ' } }), 'Turned on from Coral Hub by a Coral Hub user');
assert.match(autoAcceptChangedText({ allow_hub_auto_accept_changed: { by: 'local', at: '2026-10-20T10:00:00Z' } }), /^Turned on on this computer, .+/);
assert.equal(autoAcceptChangedText({ allow_hub_auto_accept_changed: { by: 'local', at: 'not a date' } }), 'Turned on on this computer');

assert.equal(severalAccountsText(undefined), 'More than one Coral Hub account tried this; check who has access, then try again.');
assert.equal(severalAccountsText(0), 'More than one Coral Hub account tried this; check who has access, then try again.');
assert.match(severalAccountsText(90), /^More than one Coral Hub account tried this; check who has access, then try again after .+\.$/);
assert.deepEqual(LEVEL_NOW, { view: 'look only', interact: 'send and answer', launch: 'start agents' });

// The Activity record knows an explicit click from an automatic write by the page's X-Coral-Click header (#13609): the Mark read and Mark unread buttons say "read", the tag editor says "tags", and opening a file
// (which marks it read by itself) and the automatic settle of earlier versions say nothing. A source check: the server side is pinned by TestTheReadButtonsAndTheTagEditorAreRowsAndAnOpenIsNot.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../coral-go/pkg/frontend/static');
const read = f => fs.readFileSync(path.join(dir, f), 'utf8');
const reviews = read('inbox_reviews.js'), sidebar = read('inbox_sidebar.js'), tags = read('artifact_tags.js'), settle = read('artifact_review.js');

assert.match(reviews, /click = false/, 'setReviewRead takes click, false by default');
assert.match(reviews, /\.\.\.\(click \? \{ 'X-Coral-Click': 'read' \} : \{\}\)/, 'the header is sent only for a click');
assert.match(reviews, /await setReviewRead\(row, true, \{ fresh: !!own \}\)/, 'the open marks read with no click');
assert.doesNotMatch(reviews, /\{ fresh: !!own, click/, 'the open never claims to be a click');
assert.match(sidebar, /setReviewRead\(s\.review, read, \{ click: true \}\)/, 'the row and bulk Mark read and Mark unread are clicks');
assert.match(sidebar, /setReviewRead\(row, false, \{ click: true \}\)/, 'the menu Mark unread is a click');
assert.match(tags, /'X-Coral-Click': 'tags'/, 'the tag editor says so');
assert.doesNotMatch(settle, /X-Coral-Click/, 'the automatic settle of earlier versions is not a click');
console.log('activity_click_header: ok');

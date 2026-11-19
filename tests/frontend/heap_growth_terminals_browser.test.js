// The terminals and History part of heap_growth_browser (#19766): a round opens one of three real terminals in turn (an xterm and a /ws/terminal socket) and goes back to the chat, and pages History; same rounds and bounds, see that file.
process.env.HEAP_PARTS = process.env.HEAP_PARTS || 'terminal,history';
require('./heap_growth_browser.test.js');

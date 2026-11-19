// The window size and team Board tab part of heap_growth_browser (#19766): a round resizes the window, opens the Board tab and posts to it; same rounds and bounds, see that file.
process.env.HEAP_PARTS = process.env.HEAP_PARTS || 'resize,board';
require('./heap_growth_browser.test.js');

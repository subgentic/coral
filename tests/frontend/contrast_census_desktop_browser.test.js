// cdp-timeout: 300 (a scene-walking census: 65 to 115 s alone, past the runner's 120 s on a loaded machine, #9968)
// The text-contrast census on a desktop, part 1 of 2 (#6171, #6695): the agent screens, history, board, workflows and jobs at 1280 px, in the light and the dark theme. See helpers/contrast_census.js for what is checked.
require('./helpers/contrast_census')('a');

// #13501: the same one-click count with the Hub serving the Inbox itself (the self-hosted shape: inbox: native).
process.env.HUB_NATIVE = '1';
require('./hub_open_one_team_browser.test.js');

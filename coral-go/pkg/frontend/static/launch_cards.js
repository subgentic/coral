/* The cards that start something, in one table (#9998): the phone's empty Agents page draws them from here, and the desktop's welcome page (templates/index.html) and the New dialog's chooser
 * (templates/includes/modals.html) carry the same icons, words and order as markup: tests/frontend/launch_cards_census.test.mjs reads all three against this table. The dialog adds Terminal after them, the one extra (written in the census test, which is its only reader). */
export const LAUNCH_CARDS = [
    { key: 'agent', icon: 'smart_toy', label: 'New agent', desc: 'One agent in a folder you choose.' },
    { key: 'team', icon: 'groups', label: 'New team', desc: 'Agents that split the work and talk to each other.' },
    { key: 'folder', icon: 'create_new_folder', label: 'Open folder', desc: 'Add a folder now and start an agent in it later.' },
];

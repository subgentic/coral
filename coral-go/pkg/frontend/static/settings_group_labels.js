// Section grouping is needed only while Settings is open, never on the start path.
export function buildSettingsGroupLabels(modal) {
    const tabs = modal.querySelector('#settings-tabs');
    if (!tabs || modal._refreshGroupLabels) return;
    let group;
    for (const pane of modal.querySelectorAll('.settings-pane')) {
        if (group === pane.dataset.navGroup) continue;
        group = pane.dataset.navGroup;
        const tab = document.getElementById(`settings-tab-${pane.dataset.group}`);
        if (!tab) continue;
        const label = document.createElement('p');
        label.className = 'settings-nav-label'; label.textContent = group;
        tabs.insertBefore(label, tab);
    }
    modal._refreshGroupLabels = () => {
        for (const label of tabs.querySelectorAll('.settings-nav-label')) {
            let tab = label.nextElementSibling, any = false;
            while (tab?.matches('.settings-tab')) { any ||= !tab.hidden; tab = tab.nextElementSibling; }
            label.hidden = !any;
        }
    };
    modal._refreshGroupLabels();
}

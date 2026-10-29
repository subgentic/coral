/* The folder field's Browse button sits at the input's right, in the one row Open folder draws (.dir-input-row), in New agent, New team and Open folder alike (#9489). The wizards' fields are drawn by
 * settings_view with Browse as a "live" part under the row; this moves it beside the input once the row exists. Nothing else about the field changes: the id, the description and the folder list under it stay. */

/** What every Folder field says under it (New agent, New project, New job): the folder is on the computer running Coral, not on the one the page is open on (#10961 7b). One string, so they cannot drift. */
export const FOLDER_ON_THIS_COMPUTER = 'A folder on the computer running Coral.';

export function joinBrowse(inputId, buttonId) {
    const input = document.getElementById(inputId), button = document.getElementById(buttonId);
    if (!input || !button || !input.parentNode || input.parentNode.classList.contains('dir-input-row')) return;
    const row = document.createElement('div');
    row.className = 'dir-input-row';
    input.parentNode.insertBefore(row, input);
    row.append(input, button);
    button.classList.remove('sv-live-wide');
}

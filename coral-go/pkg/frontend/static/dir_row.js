/* The folder field's Browse button sits at the input's right, in the one row Open folder draws (.dir-input-row), in New agent, New team and Open folder alike (#9489). The wizards' fields are drawn by
 * settings_view with Browse as a "live" part under the row; this moves it beside the input once the row exists. Nothing else about the field changes: the id, the description and the folder list under it stay. */

export function joinBrowse(inputId, buttonId) {
    const input = document.getElementById(inputId), button = document.getElementById(buttonId);
    if (!input || !button || !input.parentNode || input.parentNode.classList.contains('dir-input-row')) return;
    const row = document.createElement('div');
    row.className = 'dir-input-row';
    input.parentNode.insertBefore(row, input);
    row.append(input, button);
    button.classList.remove('sv-live-wide');
}

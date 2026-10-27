/* Where Tab goes next inside a dialog (modal_chrome.js), as a function of what has the focus: the control to move to, or null to let the browser move it (#9538).
 * `stops` are the controls the Tab key reaches (in order), `all` also the roving-tabindex ones (a tab clicked or focused by script is not a stop but wraps too); `box` is the dialog's own box
 * (.modal-content): a dialog is often opened with the focus on the box itself, and from there Shift+Tab would leave the dialog for whatever is before it in the page, so the box is a stop of its own:
 * Shift+Tab from it goes to the last control, Tab to the first. Focus outside the dialog (left on the control that opened it) comes in the same way. */
export function trapTarget({ modal, box, all, stops, active, shift }) {
    if (!stops.length) return null;
    const first = stops[0], last = stops[stops.length - 1];
    const outside = !modal.contains(active);
    const onBox = active === modal || (!!box && active === box);
    if (shift && (outside || onBox || active === first || active === all[0])) return last;
    if (!shift && (outside || onBox || active === last || active === all[all.length - 1])) return first;
    return null;
}

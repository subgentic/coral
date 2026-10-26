/* The Settings dialog's open-time snapshots: what the dialog opened with (Save sends only the fields that differ from it, settings_diff.js), the form as it finished opening and the same as an object
 * (the unsaved note and the Save toast compare with them). One place for the three, behind accessors, so the parts of the dialog that read and write them can live in their own files (#8383). */
let _settingsAtOpen = null;
let _formAtOpen = null;
let _payloadAtOpen = null;
export const settingsAtOpen = () => _settingsAtOpen;
export const setSettingsAtOpen = v => { _settingsAtOpen = v; };
export const formAtOpen = () => _formAtOpen;
export const setFormAtOpen = v => { _formAtOpen = v; };
export const payloadAtOpen = () => _payloadAtOpen;
export const setPayloadAtOpen = v => { _payloadAtOpen = v; };

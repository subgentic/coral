/* Baselines for settings diffs and the legacy combined-save probes. Row autosave updates the saved settings baseline after each successful request. */
let _settingsAtOpen = null;
let _payloadAtOpen = null;
export const settingsAtOpen = () => _settingsAtOpen;
export const setSettingsAtOpen = v => { _settingsAtOpen = v; };
export const payloadAtOpen = () => _payloadAtOpen;
export const setPayloadAtOpen = v => { _payloadAtOpen = v; };

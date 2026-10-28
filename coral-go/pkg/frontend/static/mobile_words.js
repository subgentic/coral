/* The words of the "Use on your phone" dialog (#10149, Desktop tester #10148): what Enable does before it is pressed, where the phone types the setup code, the same-network line. Plain strings for textContent. */

export const ENABLE_LABEL = 'Enable';
export const USE_HUB_LABEL = 'Use Coral Hub instead';
/** What the dialog says while mobile access is off: what Enable does (it opens Coral to the network), and the Hub way that needs no network access. */
export const DISABLED_WORDS = 'Scan a QR code to open Coral on your phone. Mobile access is off: turning it on lets devices on your network reach Coral; they need your password or a setup code. Or use Coral Hub, which needs no network access.';

/** The one panel's lines: the address, where a phone types the setup code, and the network it must be on. */
export const OPEN_ON_PHONE = "Open this address on your phone's browser, then tap Add to Home Screen for an app-like experience.";
export const SAME_NETWORK = 'Your phone must be on the same network as this computer.';
export const SETUP_CODE_WHERE = "Your phone asks for the setup code on the sign-in page the first time, when it creates your password. This computer's own browser never asks for it.";
export const NO_SETUP_CODE = 'No setup code is open: your phone signs in with your password.';
/** When the code could not be read (a dashboard opened through Coral Hub or from another computer, or a network error): where it can be shown, not that there is none. */
export const CODE_ONLY_HERE = 'The setup code can only be shown on this computer.';

export const SHOW_CODE = 'Show setup code';
export const HIDE_CODE = 'Hide setup code';
/** How long a shown code stays on the screen (the dialog is the screen people share in a call). */
export const CODE_SHOW_MS = 60000;

const minutes = s => Math.max(1, Math.round(Number(s) / 60));
/** The line under a shown code: once, and for how long. */
export function setupCodeHint(expiresIn) {
    const m = minutes(expiresIn);
    return `It works once and is valid for about ${m} more minute${m === 1 ? '' : 's'}. It hides itself in a minute.`;
}

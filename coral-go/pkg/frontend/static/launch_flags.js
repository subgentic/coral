/* The three choices the operator has not made yet about the New Agent and Restart dialogs (#7391, UI/UX's v4 section 4), each one switch here so the answer is one line: the build defaults are UI/UX's leans.
 *   modeCards          the Permission Mode as a row of text cards, Bypass beside Default and said in words (true), or the dropdown with its description line (false)
 *   restartProvider    Restart lets the person change the Provider, with the warning shown only when it differs (true), or shows it read-only with "Change provider: launch a new agent" (false)
 *   launchFromAnyStep  Launch is in the footer of every step once a folder is set (true), or only on step 3 (false) */
export const launchFlags = { modeCards: true, restartProvider: true, launchFromAnyStep: true };

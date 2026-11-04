/* What Settings says under the Coral Hub relaunch switch (#6292, the wording agreed with Security on #6290): with it on, the Hub's owner can update this computer without anyone here saying yes. No imports: the connector pane and the Updates pane both read it. */
export const HUB_RELAUNCH_ON = 'On: the owner of this Coral at Coral Hub can install the downloaded update on this computer without anyone here saying yes. Agents restart when it does.';
export const HUB_RELAUNCH_AT_LAUNCH = 'On (set at launch)' + HUB_RELAUNCH_ON.slice(2); // the switch was set by --allow-hub-update / CORAL_ALLOW_HUB_UPDATE when this Coral started (#13258): the same sentence, with where it came from
export const HUB_RELAUNCH_OFF = 'Off: updates install only when someone at this computer chooses to.';
export const HUB_RELAUNCH_WINDOWS = 'Not on Windows: installing an update needs someone at this computer to approve it, so Coral Hub cannot do it. Use Install update here.';

# Decision: a browser paired through the connect link starts at Launch (beta)

- **Decided:** 2026-11-18. Source: coral-hub's plan, Part G item 6, and their Operator's ruling that the beta has no visible pairing step. coral-hub Security confirmed it with five conditions (below).
- **What:** a browser paired through the `#p=` link of `coral cloud connect` is added to this computer's device list at **Launch** (it can start sessions on this computer). Other devices (bootstrap, no proof) are not affected: they stay at View until a person here raises them.
- **Beta default, not a permanent one.** First review: **the start of the closed beta's second week**, or sooner if a device signs something unexpected. (No calendar date is set yet: the date is written here when the closed beta starts.)
- **Where it lives:** the setting `device_web_mode` (`store.DeviceWebModeSetting`, default `launch`). It is read at the moment of each pairing. Only a person at this computer changes it: `coral cloud devices web-mode <view|interact|launch>` and the dashboard on this computer. Never a paired browser, never Coral Hub, never the tunnel at any mode, and not through the generic settings route.

## coral-hub Security's conditions, and where each is held

| | Condition | Held by |
|---|---|---|
| (a) | The link is single use and lives at most 10 minutes | `devicekey.SecretHold` (first success, third failed check, 10 minutes); `TestAnOldOrUsedSecretPairsNothing`, `TestSecretHoldDiesOnTheThirdFailureTheFirstSuccessOrTenMinutes` |
| (b) | Before the person confirms, the computer says in plain words what the device may do | `pairingPrompt` in `cmd/coral/cloud_devices.go`; `TestConnectPromptSaysWhatThePairedBrowserCanDoBeforeTheLink` |
| (c) | The mode comes from this computer's own setting at pairing time, never the request or the Hub | `Options.PairedDeviceMode` reads `DeviceWebMode`; `TestThePairedModeIsReadFromTheComputersSettingAtPairingTime` |
| (d) | Each pairing and each removal is audited with the kid and the mode | `cloud: device paired` and `cloud: device removed` log lines (`devicekey.AuditLine` for a signed removal; the local routes for a removal here); `TestAPairingIsAuditedWithTheKidAndTheMode`, `TestAuditLineNamesTheKidsAndTheMode` |
| (e) | The person can lower the default, and any one device, at the computer | `coral cloud devices web-mode`, `mode`, `remove`; the routes in `internal/server/routes/cloud_devices.go`, local only; `TestDeviceListIsLocalOnlyAndTheOwnerCanLowerAndRemove` |

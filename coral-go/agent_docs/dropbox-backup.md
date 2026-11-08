# Dropbox backup: signing in

**Settings > Storage and cleanup > Dropbox backup** connects this Coral to your Dropbox account. This page is about signing in, switching accounts and disconnecting. Only you can do it, from this computer's own dashboard: an agent cannot do it, and it is not offered through Coral Hub. Through Coral Hub the block says *Dropbox backup is set up on the computer itself, not through Coral Hub.* and has no buttons.

A build of Coral that has no Dropbox app key shows *Dropbox backup isn't available in this build.* and nothing else.

## Connect

1. Open Coral at `http://127.0.0.1:<port>` (for example `http://127.0.0.1:8420`), not at `localhost` or the computer's name. The sign-in comes back to `127.0.0.1` only. If you press **Connect Dropbox…** anywhere else, Coral says *Open Coral at http://127.0.0.1:<port> to connect Dropbox:* with a link to that address.
2. Press **Connect Dropbox…**. Dropbox's own page opens in a new tab. If the tab does not open, Coral says *If the Dropbox tab didn't open, open it here:* and shows an **Open Dropbox to sign in** link.
3. Coral says *Waiting for you to click Allow in Dropbox…* and reads its own status every two seconds. Click **Allow** in Dropbox, in the same browser. The Dropbox tab says *Connected. You can close this tab.* and Settings says *Connected to Dropbox (<your account id>).* It shows the account's id, not its email address.

Coral waits five minutes. If you do not click Allow in that time, or you cancel, Settings says *The Dropbox sign-in timed out or was cancelled. Connect again to try once more.* and offers **Connect Dropbox…** again. A second sign-in started while one is waiting is refused with *Another Dropbox sign-in is already waiting. Finish it, or wait five minutes and try again.* If the browser tab says *Dropbox sign-in didn't finish. Go back to Coral and try again.*, nothing was saved: try again, in the browser you pressed Connect in.

Coral keeps the sign-in sealed with the same master key as its other secrets and never shows it. Coral saves a new sign-in to the same account in place of the old one, and tries to end the replaced one at Dropbox.

## A different account

If you sign in with another Dropbox account than the one this Coral used last, Coral does not switch by itself. The tab says *This is a different Dropbox account from before. Go back to Coral to confirm the switch.* and Settings says *This is a different Dropbox account (<new>) from the one before (<old>). Switch to it, or connect again with the old one.* **Switch to the new account** makes the new one this Coral's; **Connect Dropbox…** starts again so you can sign in with the old one. Coral holds the switch for five minutes. If you press **Switch to the new account** after that, Coral says *The switch is no longer waiting. Connect again.*

## When Coral looks like a copy

If this data folder was copied or restored onto another computer or into another folder, it still holds the old sign-in. Coral notices and pauses: *This Coral looks like a copy of one that backs up to Dropbox (a copied or restored data folder), so the backup is paused here.* If this is now the computer you use, press **Take over**: Coral records this computer as the one that backs up. If the original is still in use, leave it paused.

## Reconnect

*Coral lost access to your Dropbox. Your files are safe on this computer.* means Coral no longer holds a usable sign-in: Coral discards it when its secrets are re-keyed (the data folder keeps its place in Dropbox). Press **Reconnect** and sign in again.

## Disconnect

**Disconnect** tries to end Coral's sign-in at Dropbox first, then forgets it on this computer whatever Dropbox answers. If Coral could not end it at Dropbox, Settings says *Disconnected here, but Coral could not end its sign-in at Dropbox. To finish, remove Coral under Connected apps in your Dropbox settings.* If Coral could not disconnect at all: *Couldn't disconnect. Try again.*

## If it does not work

- *Couldn't reach Coral. Try again.*, *Dropbox sign-in didn't start. Try again.* and *Couldn't take over. Try again.* mean the step did not happen; press the button again.
- *Couldn't read the Dropbox connection.* means Settings could not read the status; reopen Settings.
- A program on this computer that already uses port 53682 on `127.0.0.1` also shows as *Another Dropbox sign-in is already waiting.* Close it, or wait and try again.

<!-- Maintainers: not for merge until Dropbox ships (#14684). Written against dropbox-14609-signin 77923d71b (the sign-in at 1d482cbb9, the Hub census fix 2ed958673 and the per-code wording); re-check each quoted sentence against the revision that ships. The "If the Dropbox tab didn't open" sentence is from dropbox-14703-retention da8d7419b (#14736); that branch also has controls this page does not cover yet (Check again, counts, filters, retention). -->

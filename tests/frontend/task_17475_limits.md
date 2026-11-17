# Dismissed-item boundaries

Settings > Inbox > Dismissed from Needs you restores known Getting started items only. Unknown ids are not given a made-up title or Restore control. Restoring a known item preserves any unknown ids already in the list.

A dismissed id is classified as a restore only when the write removes an existing id and adds no newly named welcome item. Adding or retaining an unknown id is not a restore. This follows approved #19125 (`266e4d649c`); the earlier QA note described an older classification.

Activity's welcome-item name lookup covers Getting started items only. A generic settings-change row may still record an update or restore; it is not another named welcome dismissal.

Goals an agent closed use browser-local dismissal, keyed by team, goal and close time. They offer Undo and do not appear in Settings' restoration list. Another browser has its own list.

Review files and goals that look done use their existing decision/done-state routes and Undo. They also do not join the welcome restoration list. This task adds coverage and documents these limits; it does not expand the list.

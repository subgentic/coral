# Video comment fields (#13174, Goal #216)

Release-diff / Coral Hub notice: existing artifact comment routes gain optional
`at_s` and `end_s` numeric fields in POST bodies and comment responses. Zero is
preserved. Omitted means untimed. Only top-level video comments accept times.
`at_s` must be finite, 0 through 604800 seconds; `end_s` requires `at_s`, must
be finite, greater than it and at most 604800. A text selection cannot accompany
a time. Replies use their thread's time. Existing permission and lock checks apply.
Guide requests retain their existing strict field allowlist.

Video MIME types are accepted; video filename extensions are used only when the
MIME type is missing or application/octet-stream. Times are not validated against
the video duration: no server media decoder is required. New nullable REAL columns
are added idempotently to existing databases.

Reads order timed threads by time (stable for equal times), followed by untimed
threads. With series=1 earlier comments retain the original artifact id and time;
a time on another video version is marked found, without a text reanchor scan.
Consumers use state=open to show unresolved threads. Resolve/reopen remain on the
original comment and preserve its times. Times are references for review, not proof
that a shot in a new edit remains at that time.

Agent notifications label a timed comment as mm:ss or mm:ss–mm:ss. The panel slice
sends the open list in time order through the existing per-comment send endpoint;
each keeps its own reply command, ask, redaction and recipient checks. No new route
or tunnel table entry is introduced.

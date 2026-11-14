#!/usr/bin/env python3
"""tools/devops/windows-suite-durations.py LOG [LOG ...] > tests/frontend/suite_durations.windows.json (#14722)

Builds the Windows durations file the CDP runner splits its six windows-tests parts by (tests/frontend/suite_order.mjs durationsFile): each suite's
MEDIAN passing time over the cdp jobs of the given windows-tests runs. A LOG is `gh run view RUN --repo subgentic/coral --log > LOG` of a full run.
Read-only: it prints the JSON on stdout. Refresh it from 3 or 4 recent runs when the split drifts (a part's suites more than 2 min apart).
"""
import json
import re
import statistics
import sys
from collections import defaultdict

PASS = re.compile(r"^cdp \(windows-latest, part \d+/\d+\)\t[^\t]*\t\S+ PASS\s+(\S+\.test\.js)\s+\(([\d.]+)s\)")


def main(paths):
    if not paths:
        sys.exit(__doc__)
    per = defaultdict(list)
    for p in paths:
        with open(p, encoding="utf-8", errors="replace") as f:
            for line in f:
                m = PASS.match(line)
                if m:
                    per[m.group(1)].append(float(m.group(2)))
    if not per:
        sys.exit("windows-suite-durations: no passing cdp suite lines in the logs")
    med = {k: round(statistics.median(v), 1) for k, v in per.items()}
    print(json.dumps(dict(sorted(med.items(), key=lambda kv: (-kv[1], kv[0]))), indent=1))


if __name__ == "__main__":
    main(sys.argv[1:])

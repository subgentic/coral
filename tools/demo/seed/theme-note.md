# Skyline: theme note

Skyline shows five days of weather for one city. This note proposes how it looks in the dark and in the light, and what it costs to build.

## Open question
Should Skyline open in a dark theme or a light one?

## Why it matters
People check the weather in three places: on the way out the door in the morning, at a desk during the day, and in bed at night. The night case is the one where a bright screen hurts.

## Proposal
Dark by default, because people check the weather at night, with a light switch in the corner.

| Surface | Dark | Light |
|---|---|---|
| Page background | #0e1116 | #ffffff |
| Forecast card | #12161d | #f4f6fa |
| Text | #e7ebf2 | #141820 |
| Accent (today) | #4f8cff | #1f5fd6 |
| Rain bar | #5aa7e8 | #2a78c4 |

Contrast on every pair is at least 4.5 to 1 in both themes.

## How it works
The theme is read once, before the first paint, so there is no flash of the wrong one:

```js
const saved = localStorage.getItem("theme");
const dark = matchMedia("(prefers-color-scheme: dark)").matches;
document.documentElement.dataset.theme = saved || (dark ? "dark" : "light");
```

The switch writes the choice back to `localStorage`, and the page follows the system setting until a person picks one.

## Build checklist
- [x] Colour tokens for both themes
- [x] Switch in the page header
- [ ] Forecast cards read the tokens
- [ ] Rain chart reads the tokens
- [ ] Screenshots of both themes in the release notes

## Risks
1. The rain chart uses a fixed blue that reads poorly on the dark card.
2. A person who picks light, then changes the system theme, sees no change; that is the intended behaviour, and the settings page should say so.

## Estimate
Two days for Frontend, half a day for Reviewer.

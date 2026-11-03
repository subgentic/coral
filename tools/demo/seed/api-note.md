# Slug: API note

`Slug(s string) string` returns the slug of s.

## Rules
- Lowercase the input.
- Keep letters and digits; turn every other run of characters into one dash.
- Trim dashes from both ends.

## Question
Decision: accented letters are kept (the reviewer asked for it).

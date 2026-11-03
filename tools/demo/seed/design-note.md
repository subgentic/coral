# Slug package: design note

Slug lowercases its input and joins words with dashes.

## Open question
Should Slug drop punctuation, or turn it into dashes?

## Proposal
Drop punctuation, keep letters and digits, collapse repeated dashes, trim the ends.

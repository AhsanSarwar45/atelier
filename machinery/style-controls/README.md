# Calibration texts

A Biber score on its own means nothing. These two sit beside every run so the
scale is always visible.

- `CONTROL-real-conversation.txt` — real recorded telephone conversation between
  two strangers, from the Switchboard corpus as distributed with NLTK. Biber's
  published figure for this register is about +35; it scores about +30 here.
- `CONTROL-academic-prose.txt` — academic writing, from the `learned` category of
  the Brown corpus as distributed with NLTK. Biber's published figure is about
  -15 to -20; it scores about -12 here at this length.

Both are 2500 words, longer than any set of replies they will be compared
against. The scorer cuts every text in a run down to the shortest one, so the
controls never decide the length and never throw away replies.

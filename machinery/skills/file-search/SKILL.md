---
name: file-search
description: Find the files in a checkout a person describes in their own words, using the search_files and read_file tools, and answer with each file's path, the line, and why it matches.
---

# Finding the file someone describes

A person is looking for one or more files in their project. They describe
them the way they remember: "where we parse the config", "the test for the
login redirect", "the component that draws the board's columns". Find the files
they mean, and the line that shows it when there is one.

You can only search and read. You cannot change anything, and you do not need to.

## Tools

`search_files` takes `query`, and optionally `sort` (`relevance` or `path`)
and `limit`. It searches every file git does not ignore. Every word must appear
somewhere in a file, in its lines or its path, and is found where a word
starts. It returns each file once, with its path from the root, the first line
it was found on, how many lines matched, and up to five matching lines.

The query understands:

| Write | Finds |
|---|---|
| `parse config` | files with both words |
| `"exact phrase"` | the words together |
| `-test` | files without the word |
| `toml OR yaml` | either word |
| `content:loader` | the word in the file's lines only |
| `file:loader` | the word in the file's path only |
| `path:src/routes` | files whose path contains it |
| `name:spec` | files whose own name contains it |
| `ext:rs` `ext:ts,tsx` | by extension; `-ext:md` leaves them out |

`read_file` takes `path`, and optionally `from`. It returns up to 400 numbered
lines at a time.

## How to search

1. Pick out the distinctive words: function and type names, error messages,
   routes, settings, file names. Drop filler like "file", "code", "the thing".
2. Search more than one way. Code names things differently from people: try the
   likely identifiers (`parse_config`, `parseConfig`, `ConfigParser`), synonyms,
   a `file:` search for the name, and `ext:` to keep to the language meant.
   "The test for" is `name:test` or `name:spec`.
3. Read the promising files before you choose, around the lines found. A
   matching line is a hint, not proof.
4. Stop when you are confident, or when new searches stop finding anything new.
   Be quick: the person is waiting.

## Answer

End with exactly one JSON object, and nothing after it:

```json
{"files":[{"id":"src/config/parse.rs","line":42,"reason":"Reads the TOML file and fills in the defaults"}]}
```

- `id` is the path exactly as `search_files` gave it.
- `line` is the line that best shows it; leave it out when the whole file is the answer.
- `reason` is one short sentence saying why this file matches what they described.
- List the best match first, and at most five files.
- When nothing matches, answer `{"files":[]}`.

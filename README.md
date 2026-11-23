# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/surab-max/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/surab-max/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line patch tool for every edit format AI models write: unified diffs (including wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON. It finds the lines an edit names even when the model drifted their whitespace or indentation (three-tier matching), and it changes every file or none: a failed patch writes nothing and reports every failed edit. It is a single `main.ts` for Node 22 using only the standard library, written to the specification in `SPEC.md`.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

The patch is read from the PATCH file, or from standard input when PATCH is absent or `-`. `--format` is one of `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, which detects the format). `--check` reports what would change without writing; `--strict` matches lines exactly. Exit code 0 prints one line per changed file and `ok: N files`; exit 1 prints one `error: <code> <path>` line per failed edit and `failed: K of N edits`; exit 2 prints a single usage, no-patch, format or parse error line.

To run the public practice checks from the bounty kit:

```sh
node check.ts <path to the kit>/program/generator/practice.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=ys1ka8r4&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

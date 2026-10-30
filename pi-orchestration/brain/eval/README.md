# Agent-experience evaluation inputs

These are the inputs of round three of the evaluation (`../axeval3.md`), which reused the files from rounds one and two. Each scenario gives a fresh agent a task through only the CLI or only the Pi tool and counts its wrong turns. The method, the prompts and the results are in the reports: `../axeval.md`, `../axeval2.md`, `../axeval3.md`.

| Directory | Scenario |
| --- | --- |
| `s1` | CLI, from nothing to a 2-agent parallel result (`pair.ts`, `nap.ts`) |
| `s2` | Deliberately broken workflows: load, export, args, TypeBox import, determinism lint (`w/`, `w2/`) |
| `s3` | A workflow waiting on `ctx.signal`, driven from the CLI (`gate.ts`) |
| `s4` | Pi extension, headless sessions A–D and probes E–H and R: `w/` holds the workflows, `H/` and `HC/` the authoring probes, `bin/` the session runners and log readers |

The `s4/exp-*.diff` files are the measured experiments, all reverted afterwards. The one in `exp-signal-ask.diff` shipped later as the caution on the tool's signal hint.

The scripts hard-code the paths of the run they came from: `/tmp/axcN` for the scenario directories and the removed `brain-axeval3` worktree for the CLI and extension. Before reusing them:

1. Copy a scenario to a short directory under `/tmp`, because the worker socket path is limited.
2. Point the scripts at the checkout under test.
3. Run `npm run build` there.
4. Stop every worker the run starts.

`s4/bin/session*.sh` start `pi -p --mode json` with all extensions off except the one under test, and use a small model. `calls.py`, `cost.py` and `times.py` summarise the NDJSON logs.

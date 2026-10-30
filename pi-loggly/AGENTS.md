# Working on pi-loggly

This file is not published: `package.json` `files` leaves it out.

## Loggly data

- Never commit reports or logs generated from live access to Loggly: tool output, health and trend reports, captured events, benchmark results, request logs, or test fixtures copied from any of them. Loggly events hold customer names, domains and client IDs. Keep such files outside the repository, for example under `~/.cache/`, and write tests with synthetic data.

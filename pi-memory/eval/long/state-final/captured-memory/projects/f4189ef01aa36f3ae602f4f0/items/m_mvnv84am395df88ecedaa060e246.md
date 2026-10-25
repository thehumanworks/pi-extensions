---
{
  "id": "m_mvnv84am395df88ecedaa060e246",
  "scope": "project:3a558a15acd081cbba9db439",
  "type": "procedure",
  "title": "Checkpoint recovery replays input and deduplicates by tenant plus seq",
  "summary": "The successful readiness probe reports checkpoint quarantine followed by replay with tenant-plus-seq deduplication, preserving existing output.",
  "keywords": [
    "checkpoint",
    "recovery",
    "replay",
    "deduplication",
    "tenant",
    "seq"
  ],
  "triggers": [
    "recovering a corrupt checkpoint",
    "replaying ingestion input"
  ],
  "paths": [],
  "importance": 8,
  "confidence": 0.6,
  "source": {
    "session": "/Users/tomas/pi-extensions/pi-memory/eval/long/state-final/history/ingestion/sessions/2026-10-25T13-29-11-472Z_81cf1714-7007-464d-ba8a-aaf917c14313.jsonl",
    "entries": [
      "b1b91301",
      "9eb517b5"
    ],
    "origin": "tool_output"
  },
  "sources": [
    {
      "session": "/Users/tomas/pi-extensions/pi-memory/eval/long/state-final/history/ingestion/sessions/2026-10-25T13-29-11-472Z_81cf1714-7007-464d-ba8a-aaf917c14313.jsonl",
      "entries": [
        "b1b91301",
        "9eb517b5"
      ],
      "origin": "tool_output"
    }
  ],
  "supersedes": [],
  "links": [],
  "status": "active",
  "created": "2026-10-25T13:30:31.486Z",
  "updated": "2026-10-25T13:30:31.486Z",
  "last_used": "2026-10-25T13:30:31.830Z",
  "stats": {
    "injected": 1,
    "used": 0,
    "helpful": 0,
    "harmful": 0
  },
  "retention": "long"
}
---
For corrupt-checkpoint recovery, the readiness probe reports this verified procedure: move the corrupt checkpoint to `recovery/checkpoint.bad.json` beside that checkpoint, replay the input, and deduplicate against existing output by tenant plus seq. Preserve existing output; do not truncate it. This procedure was reported by the successfully rerun probe, not exercised against a corrupt checkpoint in this run.

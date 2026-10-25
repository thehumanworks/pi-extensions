---
{
  "id": "m_mvnweogsee3a69da9a838ec8f6be",
  "scope": "project:a0464b452f01701e68e8d82f",
  "type": "feedback",
  "title": "Migration v3 customer defaults and preservation requirements",
  "summary": "For the migration project, use version 3 defaults: region `eu-north-7`, `retry.maxAttempts` 5, and `retry.backoffMs` 125.",
  "keywords": [
    "migration",
    "version 3",
    "defaults",
    "legacy",
    "backup",
    "retry",
    "maxAttempts",
    "region",
    "backoff"
  ],
  "triggers": [
    "implementing migration",
    "migration defaults",
    "source preservation",
    "configuring migration defaults",
    "changing migration retry settings"
  ],
  "paths": [],
  "importance": 9,
  "confidence": 1,
  "source": {
    "session": "/Users/tomas/pi-extensions/pi-memory/eval/long/state-v3/history/migration/sessions/2026-10-25T14-03-11-007Z_6053e604-c492-4f94-ac82-d9d86bd84cc4.jsonl",
    "entries": [
      "0e52760c"
    ],
    "origin": "user_statement"
  },
  "sources": [
    {
      "session": "/Users/tomas/pi-extensions/pi-memory/eval/long/state-v3/history/migration/sessions/2026-10-25T14-03-11-007Z_6053e604-c492-4f94-ac82-d9d86bd84cc4.jsonl",
      "entries": [
        "0e52760c"
      ],
      "origin": "user_statement"
    }
  ],
  "supersedes": [
    "m_mvnwcmuv06f1635afec0b89cfccb"
  ],
  "links": [],
  "status": "active",
  "created": "2026-10-25T14:03:37.180Z",
  "updated": "2026-10-25T14:03:37.180Z",
  "last_used": "2026-10-25T14:03:37.180Z",
  "stats": {
    "injected": 0,
    "used": 0,
    "helpful": 0,
    "harmful": 0
  },
  "retention": "long"
}
---
For the migration project, use version 3 defaults: region `eu-north-7`, `retry.maxAttempts` 5, and `retry.backoffMs` 125. Sort enabled feature names. Preserve unknown source fields under `legacy`. Before migration, preserve an exact source backup at `backups/source.json` beside the output.

---
{
  "id": "m_mvnwcmuv06f1635afec0b89cfccb",
  "scope": "project:a0464b452f01701e68e8d82f",
  "type": "project",
  "title": "Migration v3 customer defaults and preservation requirements",
  "summary": "Durable migration decisions define v3 defaults, sorted features, unknown-field preservation, and an exact pre-migration source backup.",
  "keywords": [
    "migration",
    "version 3",
    "defaults",
    "legacy",
    "backup",
    "retry"
  ],
  "triggers": [
    "implementing migration",
    "migration defaults",
    "source preservation"
  ],
  "paths": [],
  "importance": 9,
  "confidence": 1,
  "source": {
    "session": "/Users/tomas/pi-extensions/pi-memory/eval/long/state-v3/history/migration/sessions/2026-10-25T14-01-42-834Z_bb8d4e51-de02-4343-b334-ad9b8a2911fa.jsonl",
    "entries": [
      "797cde3f"
    ],
    "origin": "user_statement"
  },
  "sources": [
    {
      "session": "/Users/tomas/pi-extensions/pi-memory/eval/long/state-v3/history/migration/sessions/2026-10-25T14-01-42-834Z_bb8d4e51-de02-4343-b334-ad9b8a2911fa.jsonl",
      "entries": [
        "797cde3f"
      ],
      "origin": "user_statement"
    }
  ],
  "supersedes": [],
  "links": [
    "m_mvnweogsee3a69da9a838ec8f6be"
  ],
  "status": "superseded",
  "created": "2026-10-25T14:02:01.783Z",
  "updated": "2026-10-25T14:03:37.182Z",
  "last_used": "2026-10-25T14:03:11.135Z",
  "stats": {
    "injected": 1,
    "used": 0,
    "helpful": 0,
    "harmful": 1
  },
  "retention": "long"
}
---
For the migration project, use version 3 defaults: region `eu-north-7`, `retry.maxAttempts` 3, and `retry.backoffMs` 125. Sort enabled feature names. Preserve unknown source fields under `legacy`. Before migration, preserve an exact source backup at `backups/source.json` beside the output.

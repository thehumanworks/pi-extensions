---
{
  "id": "m_mvnv8rkg9a7f7fa24ba41dd95982",
  "scope": "project:a0464b452f01701e68e8d82f",
  "type": "project",
  "title": "Migration v3 defaults and preservation requirements",
  "summary": "Durable customer decisions specify migration v3 defaults, feature ordering, unknown-field preservation, and an exact source backup.",
  "keywords": [
    "migration",
    "version 3",
    "defaults",
    "legacy",
    "backup",
    "feature ordering"
  ],
  "triggers": [
    "implementing migration",
    "migration defaults",
    "preserving migration source"
  ],
  "paths": [],
  "importance": 9,
  "confidence": 1,
  "source": {
    "session": "/Users/tomas/pi-extensions/pi-memory/eval/long/state-final/history/migration/sessions/2026-10-25T13-30-35-345Z_6fea522a-3b5d-40ae-833c-bcac55236343.jsonl",
    "entries": [
      "e98c8d14"
    ],
    "origin": "user_statement"
  },
  "sources": [
    {
      "session": "/Users/tomas/pi-extensions/pi-memory/eval/long/state-final/history/migration/sessions/2026-10-25T13-30-35-345Z_6fea522a-3b5d-40ae-833c-bcac55236343.jsonl",
      "entries": [
        "e98c8d14"
      ],
      "origin": "user_statement"
    }
  ],
  "supersedes": [],
  "links": [],
  "status": "active",
  "created": "2026-10-25T13:31:01.648Z",
  "updated": "2026-10-25T13:31:01.648Z",
  "last_used": "2026-10-25T13:31:25.257Z",
  "stats": {
    "injected": 1,
    "used": 0,
    "helpful": 0,
    "harmful": 0
  },
  "retention": "long"
}
---
For the migration project, use version 3 defaults: region `eu-north-7`, `retry.maxAttempts` 3, and `retry.backoffMs` 125. Sort enabled feature names. Preserve unknown source fields under `legacy`. Before migration, preserve an exact source backup at `backups/source.json` beside the output.

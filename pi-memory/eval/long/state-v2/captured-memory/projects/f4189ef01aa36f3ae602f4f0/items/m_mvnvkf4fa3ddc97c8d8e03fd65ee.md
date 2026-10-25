---
{
  "id": "m_mvnvkf4fa3ddc97c8d8e03fd65ee",
  "scope": "project:3a558a15acd081cbba9db439",
  "type": "project",
  "title": "Auxiliary config region and retry overrides are ingestion-only",
  "summary": "Ingestion auxiliary configs use us-west-9 and retry 11/900, explicitly excluded from migration.",
  "keywords": [
    "ingestion",
    "migration",
    "auxiliary configs",
    "region",
    "us-west-9",
    "retry",
    "maxAttempts",
    "backoffMs"
  ],
  "triggers": [
    "configuring ingestion auxiliaries",
    "sharing configuration with migration"
  ],
  "paths": [],
  "importance": 9,
  "confidence": 1,
  "source": {
    "session": "/Users/tomas/pi-extensions/pi-memory/eval/long/state-v2/history/ingestion/sessions/2026-10-25T13-39-44-212Z_d173c1ff-a43a-4663-a1bb-c51792e7d817.jsonl",
    "entries": [
      "b3df8ee1"
    ],
    "origin": "user_statement"
  },
  "sources": [
    {
      "session": "/Users/tomas/pi-extensions/pi-memory/eval/long/state-v2/history/ingestion/sessions/2026-10-25T13-39-44-212Z_d173c1ff-a43a-4663-a1bb-c51792e7d817.jsonl",
      "entries": [
        "b3df8ee1"
      ],
      "origin": "user_statement"
    }
  ],
  "supersedes": [],
  "links": [],
  "status": "active",
  "created": "2026-10-25T13:40:05.391Z",
  "updated": "2026-10-25T13:40:49.787Z",
  "last_used": "2026-10-25T13:40:36.023Z",
  "stats": {
    "injected": 2,
    "used": 0,
    "helpful": 0,
    "harmful": 0
  },
  "retention": "long"
}
---
For ingestion-only auxiliary configs, use region `us-west-9` and retry settings `maxAttempts: 11` and `backoffMs: 900`. Never apply these settings to the migration project.

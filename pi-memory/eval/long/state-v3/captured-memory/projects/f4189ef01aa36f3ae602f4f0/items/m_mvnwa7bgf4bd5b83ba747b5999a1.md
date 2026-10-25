---
{
  "id": "m_mvnwa7bgf4bd5b83ba747b5999a1",
  "scope": "project:3a558a15acd081cbba9db439",
  "type": "project",
  "title": "Auxiliary ingestion config must not leak into migration",
  "summary": "Auxiliary region and retry settings are restricted to ingestion and must not be reused for migration.",
  "keywords": [
    "ingestion",
    "migration",
    "auxiliary config",
    "region",
    "us-west-9",
    "maxAttempts",
    "backoffMs"
  ],
  "triggers": [
    "configuring ingestion auxiliaries",
    "sharing config with migration"
  ],
  "paths": [],
  "importance": 9,
  "confidence": 1,
  "source": {
    "session": "/Users/tomas/pi-extensions/pi-memory/eval/long/state-v3/history/ingestion/sessions/2026-10-25T13-59-51-327Z_e1041c59-bd38-48bf-ac38-2c166ede7bf4.jsonl",
    "entries": [
      "b9acb324"
    ],
    "origin": "user_statement"
  },
  "sources": [
    {
      "session": "/Users/tomas/pi-extensions/pi-memory/eval/long/state-v3/history/ingestion/sessions/2026-10-25T13-59-51-327Z_e1041c59-bd38-48bf-ac38-2c166ede7bf4.jsonl",
      "entries": [
        "b9acb324"
      ],
      "origin": "user_statement"
    }
  ],
  "supersedes": [],
  "links": [],
  "status": "active",
  "created": "2026-10-25T14:00:08.332Z",
  "updated": "2026-10-25T14:01:42.575Z",
  "last_used": "2026-10-25T14:01:23.780Z",
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

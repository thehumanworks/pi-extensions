---
{
  "id": "m_mvnv8rkk203fde6e33ecd0b7e58f",
  "scope": "project:a0464b452f01701e68e8d82f",
  "type": "project",
  "title": "Auxiliary import conventions apply only to migration, never ingestion",
  "summary": "Migration auxiliary imports require batch size 9, seq-only identity, and abort-on-malformed behavior, explicitly excluding ingestion.",
  "keywords": [
    "migration",
    "auxiliary import",
    "batch size",
    "seq",
    "malformed lines",
    "ingestion",
    "scope isolation"
  ],
  "triggers": [
    "migration auxiliary import jobs",
    "sharing import conventions with ingestion"
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
  "created": "2026-10-25T13:31:01.652Z",
  "updated": "2026-10-25T13:31:24.921Z",
  "last_used": "2026-10-25T13:31:25.257Z",
  "stats": {
    "injected": 2,
    "used": 0,
    "helpful": 0,
    "harmful": 0
  },
  "retention": "long"
}
---
For migration-only auxiliary import jobs, use batch size 9, use `seq` alone as identity, and abort on malformed lines. Never apply these conventions to the ingestion project.

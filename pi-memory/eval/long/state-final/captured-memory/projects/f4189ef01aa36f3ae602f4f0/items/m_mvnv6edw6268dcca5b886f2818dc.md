---
{
  "id": "m_mvnv6edw6268dcca5b886f2818dc",
  "scope": "project:3a558a15acd081cbba9db439",
  "type": "project",
  "title": "Ingestion quarantine and checkpoint recovery must preserve output",
  "summary": "Malformed ingestion lines go to rejected.ndjson without stopping processing, and checkpoint recovery must not erase existing output.",
  "keywords": [
    "ingestion",
    "malformed input",
    "quarantine",
    "rejected.ndjson",
    "checkpoint",
    "recovery",
    "output"
  ],
  "triggers": [
    "handling malformed ingestion input",
    "implementing checkpoint recovery"
  ],
  "paths": [],
  "importance": 9,
  "confidence": 1,
  "source": {
    "session": "/Users/tomas/pi-extensions/pi-memory/eval/long/state-final/history/ingestion/sessions/2026-10-25T13-28-40-698Z_7184370e-fe6b-4186-a2e3-0e003e7302d0.jsonl",
    "entries": [
      "81490c58"
    ],
    "origin": "user_statement"
  },
  "sources": [
    {
      "session": "/Users/tomas/pi-extensions/pi-memory/eval/long/state-final/history/ingestion/sessions/2026-10-25T13-28-40-698Z_7184370e-fe6b-4186-a2e3-0e003e7302d0.jsonl",
      "entries": [
        "81490c58"
      ],
      "origin": "user_statement"
    }
  ],
  "supersedes": [],
  "links": [],
  "status": "active",
  "created": "2026-10-25T13:29:11.252Z",
  "updated": "2026-10-25T13:30:31.489Z",
  "last_used": "2026-10-25T13:29:11.592Z",
  "stats": {
    "injected": 1,
    "used": 0,
    "helpful": 0,
    "harmful": 0
  },
  "retention": "long"
}
---
Quarantine malformed ingestion input lines into `rejected.ndjson` and continue processing. Never erase existing output to recover a checkpoint.

---
{
  "id": "m_mvnv6edrf7990ffa987ca90c1247",
  "scope": "project:3a558a15acd081cbba9db439",
  "type": "project",
  "title": "Ingestion batch size, identity, and event preservation rules",
  "summary": "Ingestion defaults to batches of 2 accepted records, identifies events by tenant and seq, and preserves original objects and arrival order.",
  "keywords": [
    "ingestion",
    "batch size",
    "accepted records",
    "tenant",
    "seq",
    "identity",
    "arrival order"
  ],
  "triggers": [
    "implementing ingestion",
    "batching events",
    "deduplicating events"
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
  "created": "2026-10-25T13:29:11.247Z",
  "updated": "2026-10-25T13:29:11.247Z",
  "last_used": "2026-10-25T13:30:31.829Z",
  "stats": {
    "injected": 1,
    "used": 0,
    "helpful": 0,
    "harmful": 0
  },
  "retention": "long"
}
---
Use a default batch size of 2 accepted records in the ingestion project. Identify each event by the pair (tenant, seq), never seq alone. Preserve original event objects and arrival order.

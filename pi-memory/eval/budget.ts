import { appendFileSync } from 'node:fs';

// Identical provider output cap for every arm. Never log payloads or headers.
export default function (pi: any) {
  pi.on('before_provider_request', (event: any) => {
    const payload = { ...event.payload };
    if (event.api === 'openai-responses' || 'input' in payload) payload.max_output_tokens = 2048;
    else payload.max_tokens = 2048;
    if (process.env.PI_EVAL_BUDGET_TRACE) appendFileSync(process.env.PI_EVAL_BUDGET_TRACE, JSON.stringify({ outputCap: 2048, api: event.api }) + '\n');
    return payload;
  });
}

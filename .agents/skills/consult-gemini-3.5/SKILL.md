---
name: consult-gemini-3.5
description: Query Gemini 3.5-flash for architectural reviews, code audits, and Gemini Live 3.5 behavior analysis of HolaHola. Use when you specifically need the 3.5 generation's perspective — e.g. testing GL 3.5 context handling, tool injection behavior, or comparing 3.1 vs 3.5 mechanics. Run from the workspace directory — uses process.env.GEMINI_API_KEY directly.
---

# Consult Gemini 3.5 (Architectural Review / GL 3.5 Analysis)

Use this skill when you need the **3.5 generation's perspective** specifically. The key distinction from `consult-gemini`:

- `consult-gemini` → uses `gemini-3-flash-preview` (same family as Daniela's current GL 3.1 model)
- `consult-gemini-3.5` → uses `gemini-3.5-flash` (3.5 generation — use when evaluating GL 3.5 behavior, context handling, or tool injection differences)

**When to prefer this skill over `consult-gemini`:**
- You're testing whether GL 3.5 handles long system prompts / context attention better than 3.1
- You want a 3.5-generation model to self-report on its own tool dispatch mechanics
- You're comparing 3.1 vs 3.5 behavior (ask both skills the same question and compare)
- David says "ask 3.5 about this" or "see what 3.5 thinks"

---

## How to ask

Every rule in `consult-gemini`'s "Ask the real question, and don't lead the witness" section applies here unchanged:
- two stages: first the goal, problem, cases and constraints with no code; then our approach and the code, asking for holes and alternatives;
- no trust or authority cue, and no desired-answer framing;
- verdicts per question: BLOCKING / CONCERN / NO ISSUE FOUND / INSUFFICIENT EVIDENCE;
- no re-asking without a real change;
- the exact prompt saved alongside the response.

When comparing 3.1 and 3.5, send both the identical prompt.

---

## Model

Always use `gemini-3.5-flash`.

**IMPORTANT naming facts:**
- `gemini-3.5-flash` → ✓ works (200)
- `gemini-3.5-flash-preview` → ✗ 404
- `gemini-3-5-flash-preview` → ✗ 404
- `gemini-3.5-flash-live-preview` → the GL streaming variant (not for REST generateContent)

---

## How it works

Calls the Gemini REST API directly from bash using `process.env.GEMINI_API_KEY`. Output written to `/tmp/gemini-3.5-audit.txt` and printed to stdout.

---

## Step-by-step

### 1. Craft the query

Same structure as `consult-gemini`:
1. **Context** — what HolaHola is, the specific subsystem, relevant constraints
2. **The proposal** — architecture or behavior you want reviewed
3. **Specific questions** — numbered, direct, answerable
4. **Tone** — "Be direct. Be honest about tradeoffs. This is production."

### 2. Run the query

```bash
cd /home/runner/workspace && timeout 90 node --input-type=module << 'EOF'
import https from 'https';
import fs from 'fs';

const LOG = '/tmp/gemini-3.5-audit.txt';
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY not set'); process.exit(1); }

const prompt = `YOUR PROMPT HERE`;

const body = JSON.stringify({
  contents: [{ role: 'user', parts: [{ text: prompt }] }],
  generationConfig: { temperature: 0.3, maxOutputTokens: 4000 }
});

const result = await new Promise((resolve, reject) => {
  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: '/v1beta/models/gemini-3.5-flash:generateContent?key=' + apiKey,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  };
  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch(e) { reject(new Error('Parse error: ' + e.message + ' | Raw: ' + data.slice(0, 300))); }
    });
  });
  req.on('error', reject);
  req.write(body);
  req.end();
});

const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
if (!text) {
  const errMsg = 'No text in response: ' + JSON.stringify(result).slice(0, 500);
  console.error(errMsg);
  fs.writeFileSync(LOG, errMsg);
  process.exit(1);
}

fs.writeFileSync(LOG, `=== Gemini 3.5 Audit ${new Date().toISOString()} ===\n\n${text}`);
console.log(text);
EOF

cat /tmp/gemini-3.5-audit.txt
```

### 3. For multi-turn follow-ups

```bash
cd /home/runner/workspace && timeout 90 node --input-type=module << 'EOF'
import https from 'https';
import fs from 'fs';

const apiKey = process.env.GEMINI_API_KEY;
const previousResponse = fs.readFileSync('/tmp/gemini-3.5-audit.txt', 'utf8');

const body = JSON.stringify({
  contents: [
    { role: 'user', parts: [{ text: 'YOUR ORIGINAL PROMPT' }] },
    { role: 'model', parts: [{ text: previousResponse }] },
    { role: 'user', parts: [{ text: 'YOUR FOLLOW-UP QUESTION' }] }
  ],
  generationConfig: { temperature: 0.3, maxOutputTokens: 2000 }
});

// ... same https request pattern as above, path: '/v1beta/models/gemini-3.5-flash:generateContent?key=' + apiKey ...
EOF
```

---

## Standard HolaHola context block

Include this at the top of any query about HolaHola-specific architecture:

```
HolaHola is an AI-powered language tutoring app. Stack: React frontend, Express backend, PostgreSQL (Drizzle ORM), Gemini Live for real-time voice sessions.

Key architectural facts:
- Daniela is the AI tutor. Her identity lives in the data layer (DB tables, memory embeddings, conversation_memories) — not fine-tuned into the model
- Daniela currently runs on gemini-3.1-flash-live-preview (GL streaming). We are evaluating whether gemini-3.5-flash-live-preview offers better context handling.
- 139 tools in the function registry. GL hard limit: 64 tool declarations per session. We use a dispatcher pattern (59 native + 4 dispatcher tools) to route all 139.
- GL system prompt is assembled at session start (~34K chars): base persona + classroom environment (14K) + rich sections (memories, hive, express lane, student profile)
- Single Neon PostgreSQL database shared between dev and production
```

---

## GL 3.5 context/attention query template

Use this when specifically investigating whether 3.5 handles long system prompts or classroom context better than 3.1:

```
[HOLAHOLA CONTEXT BLOCK]

## Problem we're investigating

In GL 3.1 (gemini-3.1-flash-live-preview), Daniela fails to read content from her own system prompt when directly asked about it. Specifically:

- System prompt is ~34K chars, assembled as: [base persona 8K] + [classroom environment 14K] + [rich sections 12K]
- The classroom block includes a <note_from_david> tag at its top with a personal note
- When David asks "can you read me the note from David?" or "what do you see out your window?", Daniela either calls a search tool or says she has no record of it
- We have added an explicit rule in the system prompt: "CLASSROOM ENVIRONMENT — direct knowledge, no tool needed: The === DANIELA'S CLASSROOM === section is your CURRENT CONTEXT..."

Questions:
1. Does gemini-3.5-flash-live-preview have meaningfully better long-context attention than 3.1 for system instructions?
2. Is 34K chars problematic for 3.1's system instruction handling? What's the practical attention cutoff?
3. Is there a documented recommended approach for ensuring a model reads a specific section of a long system prompt in GL?
4. Would the "hidden first user message" approach (injecting classroom as turn 1 in conversation history) be more reliable than system prompt injection for context that must be immediately accessible?

Be direct. Be honest about model limitations. This is production voice tutoring.
```

---

## After the review

- Write findings to `docs/gemini-3.5-audit-YYYY-MM-DD.md` for significant reviews
- If 3.5 is recommended for GL, document the model swap in handoff and update `server/services/gemini-live-session.ts`
- Note: the consult model (`gemini-3.5-flash`) and the GL streaming model (`gemini-3.5-flash-live-preview`) are different endpoints — confirm the live model string works before switching Daniela

---

## Notes

- Temperature 0.3 for architectural analysis
- `maxOutputTokens: 4000` usually sufficient; increase to 6000 for complex reviews
- Output written to `/tmp/gemini-3.5-audit.txt` (separate from `consult-gemini`'s `/tmp/gemini-audit.txt` — you can run both and compare)
- If response cuts off mid-sentence, run a follow-up turn with conversation history

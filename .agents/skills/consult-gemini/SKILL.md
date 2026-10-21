---
name: consult-gemini
description: Query Gemini 3-flash-preview for architectural reviews, code audits, and technical analysis of HolaHola. Always use gemini-3-flash-preview — it is the same model family as Daniela (gemini-3.1-flash-live-preview) and has first-hand knowledge of how its own function-calling and tool dispatch mechanics work. Run from the workspace directory — uses process.env.GEMINI_API_KEY directly.
---

# Consult Gemini (Architectural Review / Code Audit)

Use this skill to query Gemini for independent architectural analysis of HolaHola. This is the "second pair of eyes" skill — use it before committing to a major build, after a significant architecture change, or when you want an expert critique of a technical decision.

The parallel to `consult-daniela`: just as that skill surfaces Daniela's perspective from the inside, this skill brings in Gemini's perspective from the outside — as both a peer model and the authoritative source on what the Gemini APIs actually support.

**Key model note:** Daniela runs on `gemini-3.1-flash-live-preview` (Gemini Live streaming). For REST `generateContent` queries, always use `gemini-3-flash-preview` (the 3.x text equivalent, same model family). This is the model that understands HolaHola's architecture from the inside — the same family that actually runs as Daniela. Do NOT use `gemini-2.5-pro` or any 2.x model.

---

## CRITICAL: Ask the real question, and don't lead the witness

A consultation is not just a code review. David (2026-10-21): explain what we are trying to accomplish and how we propose doing it, so the reviewer can suggest a different idea or angle. "Even proposing code is leading them in a direction, unless we specifically ask for alternate suggestions or for them to poke holes in our logic."

A reviewer shown only code judges whether the code does what it says. Code can be internally correct and still cause the problem we care about, so a code-only consult invites "that works fine". A consult whose questions carry the answer gets that answer back, and it then looks like independent agreement. Both failures have happened here.

**Two stages, so our approach doesn't anchor the answer:**

1. **Stage 1, problem only (no code, no proposed mechanism):**
   - the goal: what we are trying to accomplish;
   - the problem: what could go wrong for Daniela, David or the record, and why we are asking now;
   - the concrete cases, with evidence: real rows, real call paths, real failure examples, each marked as observed or hypothetical;
   - the genuine constraints, kept separate from our chosen mechanism. "Must be append-only" is a constraint; "we use an advisory lock" is our mechanism and does not belong here.

   Ask Gemini how it would approach this, which risks it sees, and what we may be assuming wrongly. Save its answer verbatim before going on.

2. **Stage 2, our approach and the actual code:** what we propose and why, then the code as in the next section. Ask explicitly for:
   - a comparison with Gemini's stage-1 approach;
   - holes in our logic and challenges to our premises;
   - alternatives, including replacing our approach entirely.

   Only after that, ask the per-risk questions below.

Keep stage 1's reasoning in the record. If stage 2 contradicts it, ask why rather than letting the code win by default. For a narrow follow-up, such as an API quirk or a single-line check, stage 1 may be one paragraph, but the goal and the problem still come before the code.

**Neutral questions:**
- No trust or authority cue: no "someone you know and trust", no "David set this up", no "this was built carefully". Such framing sets a mindset before the question is asked.
- Ask what Gemini sees, not whether it agrees. Say "Can a turn be attributed to the wrong hat on this path? Show where", not "We prevent mis-attribution with X; is that sufficient?"
- Don't propose a mechanism, fix or preferred answer inside the question. If you have a candidate fix, ask about the risk first, and present the fix separately, labelled as ours.
- Don't describe the code as safe, reviewed or approved, and don't mention who has already approved it.
- Don't tell Gemini what outcome we hope for or what is blocking on its answer.

**Allowed outcomes.** For each question, ask for one of:
- **BLOCKING**, citing the code;
- **CONCERN**, not blocking;
- **NO ISSUE FOUND**, with what was checked;
- **INSUFFICIENT EVIDENCE**, naming what is missing.

These are all genuine results. INSUFFICIENT EVIDENCE means supply the missing code or evidence, never assume it is safe.

**Never re-ask to get a different answer.** A new round must change something real: the code, the evidence, or a factual correction to the packet. Rewording the same request after a BLOCKING or INSUFFICIENT EVIDENCE verdict is not a new consult.

**Record the framing.** Save the exact prompt sent next to the verbatim response. An answer is only as independent as the question that produced it.

---

## CRITICAL: Always include actual code, not descriptions

**The "broom closet" problem:** When you describe the architecture in prose, Gemini reasons from your description. It will recommend things you already built, flag gaps that are already covered, and give generic advice instead of precise surgical guidance.

**The rule:** Before running any consult, read the 3-6 files most relevant to the question and paste the actual code verbatim into the prompt. Not summaries — the actual lines. Gemini has a ~1M token context window. Use it.

**What changes with actual code:**
- Gemini says "on line 533 you're doing Y which conflicts with X — here's the exact fix" instead of "make sure you handle Y"
- It won't recommend splitting something you already split
- It gives you concrete insertion points instead of abstract patterns
- It catches semantic flaws in your actual naming and grouping

**Before every consult:**
1. Identify the 3-6 files that matter for the question
2. Read the relevant sections (you don't need whole files — grep for the key functions/blocks)
3. Include them as labeled, fenced code blocks in the prompt
4. Explicitly tell Gemini what is NOT in the code context if that gap is relevant

---

## Build Protocol — use this for any non-trivial implementation

This is the two-surgeons-one-brain workflow. The pre-flight is a **blocker**, not a courtesy — no code is written until Gemini clears the design. The post-review is mandatory before commit.

### Step 0 — Write the design doc (2-3 min, before reading any code)

Answer these five questions in plain prose. This is the brief Gemini needs to catch risks before they become code:

```
WHAT I'M BUILDING
[1-2 sentences — the design intention]

SYSTEM CONTEXT IT TOUCHES
[Which services, DB tables, lifecycle events, in-memory state, tool descriptions, GL session behavior]

INVARIANTS I'M ASSUMING
[What do I think is true about the system that this build depends on being true?
e.g., "ws.on('close') always fires after CLOSE_SESSION tool call", "PedagogicalSupervisor only nudges, never forces"]

WHAT COULD BREAK
[My own best guess at failure modes, even if I think I've solved them]

WHAT I WON'T BE TOUCHING
[Adjacent systems that are explicitly out of scope]
```

### Step 1 — Pre-flight blocker (before writing code)

First run stage 1 (see "Ask the real question" above): the goal, the problem, cases and constraints from the design doc, with no code and no mechanism, asking how Gemini would approach it. Then load the 3-6 most relevant files and send the design doc + actual code with:

> "Here is what I'm about to build and the full system context. Compare it with the approach you described. Before I write a line: what risks do you see? What should stop me? What am I assuming that might be wrong? Would you do this differently?"

**Do not proceed until Gemini has no blocking objections.** A nudge or "watch out for X" is not a blocker. "This will cause Y because of Z in the code at line N" is a blocker — fix the design first.

### Step 2 — Implement

Write the code. For features that touch >3 files or have complex lifecycle interactions, implement one logical chunk at a time (e.g., the handler first, then the trigger, then the fallback — not all three at once).

### Step 3 — Chunk check (optional, for complex features)

After each major chunk, if you've made a decision that diverges from the pre-flight design, fire a targeted single-question consult before proceeding to the next chunk:

> "I implemented X. I made a decision to [do Y instead of Z] because [reason]. Does this introduce any risk before I wire the next piece?"

Short questions get fast answers. Don't re-paste all the context — paste only the chunk just written.

### Step 4 — Post-review iteration loop (run until unconditional all-clear)

Send the actual new code to Gemini. Look specifically for:
- Correctness risks not visible in the pre-flight
- Anything the pre-flight flagged that the implementation might not have fully addressed
- Whether the approach held up across edge cases

**"APPROVED with these changes" is not a terminal state.** Apply every required change, then re-send the *actual updated text* — not a description of what changed. Repeat until Gemini issues an unconditional response with no remaining watch-out items, no pending fixes, and no "once you update X" language. Each round is driven by a real change, per "Never re-ask to get a different answer" above: if nothing changed, there is no new round, and the BLOCKING or INSUFFICIENT EVIDENCE verdict stands and goes to David.

**"APPROVED with suggestions" is also not a terminal state.** It is not an unconditional sign-off, but a suggestion is not automatically a requirement either. For each suggestion, ask why: what problem does it solve, and does that problem actually exist for HolaHola?
- **If it fits:** implement it.
- **If it doesn't fit:** don't implement it. Record why next to the suggestion. Then return to Gemini with the actual updated implementation, saying which suggestions were applied and which were declined and why. Ask: "Does this match your intent? Is anything still a condition of your sign-off?"

A declined suggestion that Gemini still holds as a condition is a disagreement, and it goes to David with both positions. It is not something to re-word away. Do not close the loop administratively (batch doc, memory, commit) until the re-consult gives an unconditional sign-off. If new suggestions arise during a re-consult, the cycle repeats.

The same test applies to any reviewer's or agent's follow-up suggestions, not just Gemini's. Suggestions that don't make a real difference for HolaHola are not work to do.

**When re-consulting on suggestions you previously made:** prioritize verifying those specific points were addressed correctly before looking for new issues, unless a critical flaw was introduced by the changes. Raising entirely new concerns on a re-consult that was specifically about implementing your prior suggestions is not helpful unless the change created a new problem.

The only valid exit condition: Gemini sees the final implementation and says APPROVED with nothing left to add. That unconditional sign-off ("APPROVED — Ship it" with no open threads, the same bar as the rephrase rule in replit.md) is the reviewer's conclusion once every question is clear. Get there by changing the code, never by wording the questions to invite it. An "APPROVED, but you might want to check X" is not a sign-off.

If Gemini flags a risk you're accepting rather than fixing: document the tradeoff explicitly in the code (a comment at the relevant line) and note it in the batch doc. That is the only acceptable substitute for fixing it — not ignoring it.

### Step 5 — Save significant audits

For any consult that produced a meaningful finding (a design change, a tradeoff accepted, a risk caught), save to `conversation_memories` so Daniela and Alden have the architectural reasoning:

```javascript
await fetch('http://localhost:5000/api/conversation-memories', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    title: 'Gemini — [feature name] audit — [date]',
    summary: '[1 sentence — what was caught or confirmed]',
    content: transcriptText,
    participants: 'Agent + Gemini',
    tags: ['gemini-audit', 'feature-name'],
    importance: 7,
    arcName: 'daniela-emergence',
  })
});
```

---

## When to use

- **Before a major build** — pre-flight blocker (see Build Protocol above)
- When a proposed solution has a known risk or tradeoff you want stress-tested
- After hitting a Gemini API constraint or quirk — ask what the intended pattern is
- When the solution space has 2-3 valid paths and you need independent ranking
- When David asks "run this by Gemini" or "what does Gemini think about..."
- Proactively after implementing any system that touches Gemini Live, tool declarations, or context injection

---

## Model

Always use `gemini-3-flash-preview` — the 3.x text model, same family as Daniela.

**IMPORTANT:** `gemini-3.1-flash-preview` does NOT work for REST `generateContent` (returns 404). `gemini-3.1-flash-live-preview` is Live streaming only. The working 3.x text model is `gemini-3-flash-preview`. Never use any 2.x model (2.5-pro, 2.5-flash, etc.) — Gemini 3.x is the same generation as Daniela and is therefore always preferred for HolaHola architectural review.

---

## How it works

Calls the Gemini REST API directly from bash using `process.env.GEMINI_API_KEY`. Single-turn for most queries (the full context fits in one prompt). Multi-turn available if you need a follow-up.

Output is written to `/tmp/gemini-audit.txt` and printed to stdout.

---

## Step-by-step

### 1. Gather the actual code first

Before writing the prompt, grep/read the key files:

```bash
# Find the relevant function
grep -n "buildClassroomEnvironment\|isGL" server/services/classroom-environment.ts | head -20

# Read the specific lines
# (read lines 492-535 of classroom-environment.ts, etc.)
```

Include 3-6 file sections as fenced code blocks labeled `## FILE N: filename — description`.

### 2. Craft the query

Run it in two turns (see "Ask the real question" above). Use the multi-turn pattern in step 4 below, so stage 1's answer stays in the conversation.

**Stage 1 prompt (no code):**
1. **The goal** — what we are trying to accomplish
2. **The problem** — in plain terms: what could go wrong and for whom
3. **Cases and evidence** — concrete examples, marked as observed or hypothetical
4. **Genuine constraints** — kept separate from our mechanism
5. **System context** — what HolaHola is, key constraints (34K cap, 64-tool limit, etc.)
6. **Questions** — "How would you approach this? What risks do you see? What might we be assuming wrongly?"

**Stage 2 prompt (our approach and the code):**
1. **Our proposed approach** — and why, labelled as ours
2. **Actual code blocks** — labeled FILE 1, FILE 2, etc. with the real production code
3. **What is NOT visible** — explicitly call out things that exist elsewhere but aren't in the paste, if relevant
4. **Questions** — compare with your stage-1 approach; poke holes in our logic and premises; suggest alternatives, including replacing the approach; then the per-risk questions, numbered, neutral, one risk each, each asking for BLOCKING / CONCERN / NO ISSUE FOUND / INSUFFICIENT EVIDENCE
5. **Tone instruction** — "Be direct. Reason from the actual code. This is production. If the code shown is not enough to answer, say INSUFFICIENT EVIDENCE and name what is missing."

### 3. Run the query

```bash
cd /home/runner/workspace && timeout 120 node --input-type=module << 'EOF'
import https from 'https';
import fs from 'fs';

const LOG = '/tmp/gemini-audit.txt';
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY not set'); process.exit(1); }

const prompt = `YOUR PROMPT HERE — with actual code blocks`;

const body = JSON.stringify({
  contents: [{ role: 'user', parts: [{ text: prompt }] }],
  generationConfig: { temperature: 0.3, maxOutputTokens: 6000 }
});

const result = await new Promise((resolve, reject) => {
  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: '/v1beta/models/gemini-3-flash-preview:generateContent?key=' + apiKey,
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

fs.writeFileSync(LOG, `=== Gemini Audit ${new Date().toISOString()} ===\n\n${text}`);
console.log(text);
EOF

# Always read the file after — bash stdout may be truncated but the file is complete
cat /tmp/gemini-audit.txt
```

### 4. For multi-turn follow-ups

If the first response raises a new question or got cut off, run a follow-up with conversation history:

```bash
cd /home/runner/workspace && timeout 120 node --input-type=module << 'EOF'
import https from 'https';
import fs from 'fs';

const apiKey = process.env.GEMINI_API_KEY;
const previousResponse = fs.readFileSync('/tmp/gemini-audit.txt', 'utf8');

const body = JSON.stringify({
  contents: [
    { role: 'user', parts: [{ text: 'YOUR ORIGINAL PROMPT (with code blocks)' }] },
    { role: 'model', parts: [{ text: previousResponse }] },
    { role: 'user', parts: [{ text: 'YOUR FOLLOW-UP QUESTION' }] }
  ],
  generationConfig: { temperature: 0.3, maxOutputTokens: 3000 }
});

// ... same https request pattern as above ...
EOF
```

---

## Standard HolaHola context block

Include this at the top of any query about HolaHola-specific architecture:

```
HolaHola is an AI-powered language tutoring app. Stack: React frontend, Express backend, PostgreSQL (Drizzle ORM), Gemini Live for real-time voice sessions.

Key architectural facts:
- Daniela is the AI tutor. Her identity lives in the data layer (DB tables, memory embeddings, conversation_memories) — not fine-tuned into the model
- Gemini Live (GL) handles all voice sessions. Students have a full visual classroom: avatar, whiteboard, interactive widgets, textbook, scenarios
- 139 tools in the function registry. GL hard limit: 64 tool declarations per session
- Widget dispatchers already split: 6 widget sub-dispatchers (widget_time/state/body/scene/board/media, 3-6 values each) + 3 exercise sub-dispatchers
- Neural net: OpenAI text-embedding-3-small (768-dim) over tool_knowledge table. Injected into GL system prompt via semantic search at session start
- Single Neon PostgreSQL database shared between dev and production
- GL system prompt has a 34K hard cap. GL compact classroom block must stay ~1.5K chars.
```

---

## Prompt templates

Each template below is the **stage-2** prompt. Send the stage-1 prompt first (goal, problem, cases, constraints, "how would you approach this?", and no code). Keep its answer in the conversation, and add to the stage-2 questions: "Compare this with your earlier approach. Where is our logic weak, and what would you do instead?"

### Pre-build design consult (use this before writing any code)

```
## The problem
[plain terms: what could go wrong, for whom, and why we are asking now]

## Cases and evidence
- [concrete case — observed (with the row/log/path) or hypothetical (say so)]

## What I am about to build
[1-2 sentences — the design intention, stated as ours, not as settled]

## Questions (answer each: BLOCKING / CONCERN / NO ISSUE FOUND / INSUFFICIENT EVIDENCE, citing the code)
1. [neutral question about one risk — "can X happen here? show where"]
2. [neutral question about one risk]
3. Are there better alternatives given these constraints: [list constraints]

[HOLAHOLA CONTEXT BLOCK]

## FILE 1: [filename] — [what this file does / why it's relevant]
\`\`\`typescript
[paste actual relevant code section]
\`\`\`

## FILE 2: [filename] — [what this file does / why it's relevant]
\`\`\`typescript
[paste actual relevant code section]
\`\`\`

## What is NOT in the above code (but exists elsewhere):
- [thing that exists in the system but isn't pasted here, if relevant to the question]

Be direct. Reason from the actual code above, not from general principles. This is production. If the code shown is not enough to answer a question, say INSUFFICIENT EVIDENCE and name what is missing.
```

### Post-build architectural review

```
## The problem
[plain terms: what this code must not do — e.g. lose or duplicate words, attribute a turn to the wrong speaker, let a summary stand in for the verbatim record]

## Cases and evidence
- [concrete case — observed or hypothetical (say which)]

## What was built
[1-2 sentences]

## Questions (answer each: BLOCKING / CONCERN / NO ISSUE FOUND / INSUFFICIENT EVIDENCE, citing the code)
1. [one specific risk from "The problem" — "can it happen on this path? show where"]
2. Any other correctness risks visible in this code?
3. What degrades first under load or edge cases?
4. What would you change, and where exactly in the code below?

[HOLAHOLA CONTEXT BLOCK]

## FILE 1: [filename — the thing just built]
\`\`\`typescript
[paste actual new code]
\`\`\`

## FILE 2: [filename — the caller / injection point]
\`\`\`typescript
[paste actual integration code]
\`\`\`

## What is NOT in the above code (but exists elsewhere):
- [downstream readers/consumers not pasted, if relevant]

Be direct. Point to specific lines. This is production. If the code shown is not enough to answer a question, say INSUFFICIENT EVIDENCE and name what is missing.
```

### API constraint / behavior question

```
[HOLAHOLA CONTEXT BLOCK]

## FILE 1: [the relevant GL session code]
\`\`\`typescript
[paste actual code showing the constraint]
\`\`\`

## Gemini API question

We're hitting [specific constraint or behavior]. Our current workaround is visible in the code above at [line/function].

Specific questions:
1. Is this the intended pattern, or are we working against the API?
2. What does Google recommend for this case?
3. What are the failure modes of our current approach as written above?

Please be specific about which model/API version this applies to.
```

---

## After the review

- Write findings to `docs/gemini-audit-YYYY-MM-DD.md` if this was a significant architectural review, with the exact prompt sent alongside the verbatim response
- Report the per-question verdicts as given. A BLOCKING or INSUFFICIENT EVIDENCE verdict goes to David as is, never paraphrased into a pass
- If the review changes the implementation plan, note the key conclusions in the handoff (`docs/alden-agent-handoff.md`)
- If Gemini flags a risk you're accepting anyway, document the tradeoff explicitly in the relevant source file
- For major findings, post to the Hive or leave an agent note so Alden is aware

---

## Notes

- Temperature 0.3 for architectural analysis (lower = more precise, less wandering)
- `maxOutputTokens: 6000` for complex multi-topic reviews; 4000 for focused single-topic
- Response may be truncated in bash stdout — always read `/tmp/gemini-audit.txt` for the full text
- If the response cuts off mid-sentence, run a follow-up turn with the conversation history
- `gemini-3-flash-preview` is the same model family as Daniela — it has first-hand knowledge of Gemini Live mechanics, function-calling behaviour, and tool dispatch patterns
- The bash `node --input-type=module` pattern works because `process.env.GEMINI_API_KEY` is available in the server environment (unlike the code_execution sandbox)
- Gemini context window is ~1M tokens. A full file read of classroom-environment.ts (~725 lines) is ~5K tokens. You have room for 5-8 full files per consult before hitting practical limits.

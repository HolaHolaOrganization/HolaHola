---
name: Agent voice turn endpoint
description: How Agent runs real voice sessions with Daniela and observes visual tool calls without a browser.
---

# Agent voice turn endpoint

`POST /api/admin/agent-voice-turn` — headless GL session with Daniela's full function registry.

**Why:** text mode fires zero tools; visual layer (open_scene, show_vocab_grid, etc.) only appears in GL voice mode. Agent needed a way to observe those tools without a browser.

**How to apply:**
- Body: `{ audio: base64PCM16@16kHz, sessionId: string, languageCode: "es-ES", voiceId: "Aoede", studentText?: string }`
- Returns: `{ audioWav: base64WAV, visualEvents: [], toolCallsSummary: [], audioDurationS, transcript, sessionId, turnNumber }`
- Uses all `DANIELA_FUNCTION_DECLARATIONS` (no slice — slicing to 20 cuts off `show_image` at index ~26)
- In-memory session store keyed by `sessionId` — multi-turn conversation state persists across calls
- `studentText` = transcript fallback; pass it so GL fires tools even if transcription lags
- **With `ATTRIBUTION_WRITERS_V1=1`** (default off): every episode-capture turn (no `noEpisode: true`) needs a stable caller `sessionId` and `turnId` (8-80 chars of `[A-Za-z0-9._-]`, the turnId unique within the session) plus `studentText`; otherwise the route returns 400 before Daniela runs. Each turn is saved as a durable receipt in the session's own `conversation_memories` row before the episode append. Re-sending the same `turnId` with the same text returns the stored reply (`replayed: true`, no audio) without rerunning Daniela. A different text under the same `turnId` gets 409. Audio-only turns must use `noEpisode: true`. Code: `server/services/chat-bench-receipt.ts`.

## Exact audio generation pipeline (copy-paste ready)

```javascript
// Step 1: Call /api/tts/pronunciation — returns { audioUrl: "data:audio/mpeg;base64,...", audioDurationMs, cacheHit }
// NOT raw audio. NOT audioContent. The field is audioUrl, a data URI.
const resp = execSync(`curl -s -X POST http://localhost:5000/api/tts/pronunciation \
  -H "Content-Type: application/json" \
  -H "Cookie: ${SC}" \
  -d '${JSON.stringify({text, language:"es", gender:"female"})}'`).toString();
const parsed = JSON.parse(resp);
const b64mp3 = parsed.audioUrl.split(',')[1];   // strip "data:audio/mpeg;base64,"

// Step 2: Write MP3, convert to PCM16 @ 16kHz mono with ffmpeg
fs.writeFileSync('/tmp/_tmp.mp3', Buffer.from(b64mp3, 'base64'));
execSync('ffmpeg -i /tmp/_tmp.mp3 -ar 16000 -ac 1 -f s16le /tmp/_tmp.raw -y 2>/dev/null');

// Step 3: Re-encode as base64 — this is what agent-voice-turn expects
const audio = fs.readFileSync('/tmp/_tmp.raw').toString('base64');
```

**Critical detail:** GOOGLE_TTS_API_KEY is NOT set in the env. The only working TTS path is `/api/tts/pronunciation` via session cookie. The response shape is `{ audioUrl, audioDurationMs, cacheHit }` — not `audioContent`, not raw bytes.

## Sending a turn

```javascript
// Use -d @- (stdin) to avoid shell escaping issues with large base64 payloads
const body = JSON.stringify({ audio, sessionId: SESSION_ID, languageCode: 'es-ES', voiceId: 'Aoede', studentText });
execSync(`curl -s -X POST http://localhost:5000/api/admin/agent-voice-turn \
  -H "Content-Type: application/json" \
  -H "Cookie: ${SC}" \
  --max-time 90 \
  -d @-`, { input: body, maxBuffer: 50*1024*1024, timeout: 95000 })
```

**CRITICAL — run each turn in its own bash call:** Do NOT put multiple sequential turns in one bash heredoc/script with a combined timeout. The bash tool timeout kills the entire process mid-turn. Run each turn as an independent node --input-type=module call.

**Session ID must be hardcoded inside each node call** — `process.env.SESS` works only if passed as `SESS=value node`, but hardcoding the string is safer across heredoc boundaries.

## Cross-turn context carry-forward (Lesson Arc)

The `agentVoiceSessions` Map now stores `lessonContext: { phase, scene, vocab[], phaseObjective }`. This lets the arc persist across turns in the same session:

- After each tool call fires, the endpoint parses `params_json` and updates `agentSession.lessonContext`
- At turn start, if `lessonContext` has state, a `[Lesson context — carry forward from previous turns]` block is appended to the system prompt
- This mirrors what `pendingGlContext`/`pushLessonStatusContext` does in real WS sessions

## GL cold-start problem (confirmed Jul 6, 2026)

The **first GL session after any server restart** almost always times out (~90s). This is a GL runner warmup issue on Google's server side — NOT a rate limit, NOT quota.

**Evidence:** Turn 2 with a fresh isolated session ID succeeded in 5.1s *immediately* after Turn 1's 90s timeout. A true RPM limit would have blocked Turn 2 just as hard. Across multiple restarts the pattern held: first session hangs, all subsequent sessions respond in 5-7s.

**Workaround:** After a server restart, expect the first call to time out. Just retry — the second call will work immediately. No wait needed between the timeout and the retry.

**What "cold-start" looks like in logs:** `GL onopen fired ✓` and `GL connect resolved ✓` appear (the WebSocket connects), then silence until the 90s timer fires. GL accepts the connection but the model runner on Google's side isn't ready to generate responses yet.

## Validated arc (Session 004 — Jul 3, 2026)

Clean 3-turn test on session `arc-clean-1783040995`:
- Turn 1 (restaurant vocab request):
  - `teaching_content(update_lesson_context)` → scene: restaurant_table
  - `open_scene` → restaurant_table
- Turn 2 (vocab grid request):
  - `teaching_content(show_vocab_grid)` → 4 words: el café, el agua, el cruasán, la tostada
- Turn 3 ("practiquemos construyendo frases"):
  - `teaching_content(show_sentence_builder)` → **"Objeto" column: [el café, el agua, el cruasán, la tostada]** ← inherited from T2
  - `teaching_content(update_lesson_context)` → phase: immersion, scene: cafe_exterior (advanced autonomously)
  - `update_session_pedagogy` → fluency: comfortable

**Arc inheritance confirmed.** The sentence builder's "Objeto" column contained the exact 4 words from T2's vocab grid. Scene advanced without prompting. Phase was declared automatically.

## Visual tool dispatcher pattern

Daniela routes through dispatchers — the actual GL tool names are wrappers:
- `widget_media` → routes show_daily_plan, show_vocab_grid, open_scene, etc.
- `teaching_content` → routes show_vocab_grid, show_sentence_builder, update_lesson_context, vocab_card, etc.
- Direct native names also fire: `open_scene`, `add_to_scene`, `show_vocab_grid`

Both dispatcher and native patterns appear in `toolCallsSummary`. Check `t.name` AND `t.args.type`/`t.args.widget` for full picture.

## What each turn typically fires

Voice mode = 3-5 tools per turn including:
- Scene construction (open_scene or update_lesson_context)
- Vocabulary rendering (show_vocab_grid, vocab_card)
- Continuous pedagogy calibration (update_session_pedagogy, update_session_phase)
- Heartbeat tools (admin_session)

The visual layer IS the pedagogy, not decoration.

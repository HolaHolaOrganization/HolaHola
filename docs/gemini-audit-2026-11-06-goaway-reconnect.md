# Gemini audit, 2026-11-06: deliberate reconnects use the retry path; act on goAway

Change: a close we ask for (ACTFL recalibration, goAway) now takes the retry path with no delay, so it gets the same resets and the existing context bridge. On goAway we wait for a moment between turns and make such a close. Live test 2, finding G8 (note 151e6349). LA's review of the first version found the thinner path's missing resets and bridge.

Result: **"APPROVED — Ship it."**

Note on the response: Gemini describes her as having a "Spanish-only" persona and treats the 20:56 confusion as caused by the thin reconnect. The session was English, and that cause is unproven. It doesn't change the verdict on the mechanism. Live test 3 should check it.

## Prompt (the diff followed)
A review of a change to how Daniela's Gemini Live connection reconnects. It changes what context she gets on some reconnects, so it needs your review.

## Goal
When the connection is replaced mid-session, she carries on as herself, knowing what was just said, and the student doesn't notice.

## The two ways we reconnect today
1. **Unexpected close** (retry path): resets per-connection state, then starts the new connection with her system prompt plus a context bridge, which is text built from recent exchanges ("[MID-SESSION RECONNECT — CONTEXT BRIDGE] ..."). A resumption handle is also used if we have one.
2. **Deliberate close** (only used for ACTFL level recalibration): closes and immediately starts with the system prompt alone, with no context bridge and without those resets. The comment says the resumption handle preserves context.

## Evidence, labelled
Observed in a live session on 2026-11-06:
- 20:52:59: Gemini closed with 1008 because we received goAway and didn't close. Retry path. Session re-established in 536 ms.
- 20:55:59: ACTFL recalibration, deliberate path. The student had just asked for some Spanish at 20:55:50. At 20:56:09 he asked in German whether they could also speak German. She said "my main goal here is to practice Spanish with you", and her thought said the session's objectives were centered on Spanish. The session language was English.
- After 20:55:59 we did not log `gl_session_established`, because `isSetupComplete` stays true on the deliberate path, so the setupComplete block doesn't run. (Our record may be missing it for other reasons; it matches the code.)

Inferred, not proven: that her confusion came from the thin reconnect. She'd just been asked for Spanish, so it may be unrelated.

Read from code: on the deliberate path, `transcriptClosed` can remain true, which would treat the new connection's first output transcription as ghost text.

## What we propose
1. A deliberate close takes the retry path with no delay: same resets, same existing bridge text. The bridge text doesn't change; she just gets it on these reconnects too.
2. On goAway, wait for a moment between turns (not speaking or generating, no tool running, no pending student transcript) and make a deliberate close, rather than be aborted (1008) at a moment Gemini chooses. If no such moment comes before 2 s from the deadline, do nothing, and the abort takes the retry path as now.

So her context on ACTFL and goAway reconnects changes: from system prompt plus resumption, to system prompt plus bridge plus resumption.

## Known remaining gaps
Speech in the first moments before any transcription exists can't be seen, so a reconnect can still land there, and audio sent while the new connection comes up isn't buffered.

## Questions
1. Could the bridge plus resumption together cause harm on these reconnects, such as repeating herself or treating the bridge as a new turn? The retry path already does this.
2. Is there a better moment or signal for acting on goAway? Is there anything we misunderstand about goAway and session resumption on gemini-3.1-flash-live-preview?
3. Do you see any other hole?
4. Clear verdict: "APPROVED — Ship it." or what you require.

## The diff
```diff
```

## Response
This is a solid improvement to the session lifecycle. You are essentially unifying the "recovery" logic so that deliberate reconnections are as context-aware as accidental ones, while also making the `goAway` (server-side session limit) transition proactive rather than reactive.

### Analysis of Questions

**1. Could the bridge plus resumption together cause harm?**
Unlikely to cause "harm," but there is a slight risk of **repetition or "hallucinated" turn-taking**.
*   **The Risk:** If the resumption handle is 100% successful, Gemini already has the history. If you then provide a Context Bridge, Gemini might see the bridge as a *new* set of instructions or a summary of what it already knows, potentially leading it to say, "As we were discussing..." or re-summarizing the state.
*   **The Reality:** In practice, with `gemini-1.5-flash` and `3.1-flash`, the models are quite good at deduplicating context. Since your "retry path" already uses this combination and hasn't caused loops or double-responses, applying it to the deliberate path is safe. It acts as a vital "insurance policy" for when the resumption handle is partially stale.

**2. Is there a better moment or signal for acting on goAway?**
Your proposed "quiet moment" logic (no speaking, no generation, no pending tools, no pending transcript) is the **gold standard** for a seamless swap.
*   **The Signal:** `goAway` is the correct and only signal the server provides for an impending graceful shutdown.
*   **The Timing:** Waiting for the turn boundary is exactly what a human-like interface should do. If the student is mid-sentence and the 2s deadline approaches, falling back to the 1008 abort (current behavior) is the correct "fail-safe."

**3. Do you see any other hole?**
*   **The "Ghost Text" fix:** Your proposal fixes the inferred bug where `transcriptClosed` remained true. By routing deliberate closes through the retry path, you ensure `isSetupComplete` is reset, which triggers the proper initialization flow and clears out stale transcription state.
*   **The `isProactiveReconnecting` flag:** You've correctly used this to bypass the exponential backoff. This ensures the "deliberate" swap is near-instant (0ms delay), which is critical for the student not noticing.
*   **Race Condition:** There is a tiny window where `closeForReconnect` is called, but a student starts speaking *exactly* as the socket closes. Since you aren't buffering audio yet (as noted in gaps), that audio is lost. However, this is no worse than the current behavior.

### Verdict

The evidence from 2026-11-06 strongly suggests that the "thin" reconnect (System Prompt only) was insufficient for Daniela to maintain her "Spanish-only" persona when the student pivoted to German. Adding the Context Bridge to that path provides the "short-term memory" she needs to stay in character.

**APPROVED — Ship it.**

### Minor Implementation Note
In `handleGoAway`, you check `if (this.stopGoAwayWatch) return;`. Ensure that if a second `goAway` message is received (unlikely, but possible in some proxy setups), the original watcher is either updated or allowed to finish. Your current code correctly prevents multiple watchers from stacking up.

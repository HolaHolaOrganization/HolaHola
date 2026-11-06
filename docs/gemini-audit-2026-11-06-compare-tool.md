# Gemini audit, 2026-11-06: compare tool and dispatcher input check

Change: the `compare` selector now shows the working comparison card, its guidance gives its parameters, and a dispatcher call missing required inputs returns an error rather than "done". Live test 2, finding G6 (note 151e6349).

Result: **"APPROVED — Ship it."** in stage 2.

Stage 3: LA's code review showed the general check would reject calls that follow her own guidance, so it now applies only to selectors verified against guidance and handler, which today means `compare`. Gemini: "APPROVED — Ship it." The drift test from stage 2 is gone with the general check. Gemini's note that the list is a promise that declaration and handler agree stands. Its future suggestion, renaming to `word_a`/`word_b`, applies only if she still struggles, so it isn't built.

Correction recorded in stage 2: stage 1 wrongly said `visual_compare` was available to her in voice. It is excluded.

## Stage 1 prompt
We want your view on a problem in how Daniela (a voice language tutor on gemini-3.1-flash-live-preview) uses her tools. This is stage 1: the problem and evidence only, with no proposed fix.

## Goal
When Daniela says something is on the student's screen, it should be true. When a tool did nothing, she should know that, in time to respond honestly and recover.

## The problem
She reaches many tools through dispatcher tools, for example `exercise_language`, which take a selector `type` and a free-form JSON string `params_json`. So the live API's schema doesn't check the inner parameters. If she guesses wrong parameter names, the handler may do nothing, and she can still be told the call succeeded.

## Observed case (live session 2026-11-06, English session, founder testing)
1. The founder asked her to try the comparator, ser versus estar.
2. She called `exercise_language {type:"compare", params_json:"{\"word1\":\"ser\",\"word2\":\"estar\"}"}`.
3. The handler reads `item1` and `item2`, so it silently did nothing.
4. The tool result was `{"status":"done","exercise":"compare"}`.
5. She told him: "I've put them up on the board for you to compare. Can you see that? It shows some of the key differences between them."
6. He said it hadn't appeared. She apologised, said she'd sent a report to the team, called the tool again the same way, got `done` again, and asked "Any luck this time?"

Her tool guidance for this selector reads only: `type: "compare" → word comparison.` Other selectors in the same list give an example of their parameters. For instance: `type: "phonetic" → phonetic alphabet. params_json: {"word":"hola","language":"Spanish"}`. So her guess was reasonable.

Also observed: a different dispatcher got `{type:"vocab_card"}`, which was the wrong selector value. That one does return an error today, of the form `{"status":"error","code":"INVALID_SUBTOOL","message":...,"details":{"correction_example":...},"action":"RETRY_WITH_CORRECTED_PARAMETERS"}`. She said aloud "My apologies, it seems I used the wrong command there. Let's try this again with the right tool", and it then worked.

A separate top-level tool, `visual_compare`, also exists. It takes concept_a, concept_b and optional meanings and examples, and it does render a comparison card. In the same session she never chose it. The dispatcher `compare` selector's handler, even with correct names, sends an item type the whiteboard probably doesn't render (read from code, not run).

## Constraints
- Tool descriptions, tool-result text and anything else she reads are part of her context, so they need to follow our prompt style: plain language, nothing that reads as being handed instructions, and no pressure that distorts how she talks.
- The live API has a hard limit on declared tools (64), which is why dispatchers exist.
- Failures must not create a self-correction loop mid-conversation, or make her narrate tool mechanics to a student more than is natural.
- A declared parameter list could be out of step with what a handler actually reads. We found other tools where they may disagree, not yet verified, so a check based on declarations could wrongly reject a call that works today.

## Questions
1. How would you approach this, as a whole? What should she be told, when, and in what form, so her next sentence is honest?
2. Should she have two ways to compare (a `compare` selector and `visual_compare`), or one? What does having both do to her choice?
3. What risks do you see in returning errors for missing parameters during a live voice turn, given that she starts speaking quickly and tool results may arrive while she's already talking?
4. What are we assuming wrongly?


## Stage 1 response
This is a classic "silent failure" pattern in LLM tool-use. The model is acting in good faith based on a "Success" signal from the system, while the system is failing to enforce the contract it implicitly expects the model to follow.

Here is an analysis of the problem and responses to your questions.

### 1. How would you approach this as a whole?
The core issue is a **Contract Mismatch**. Daniela believes `params_json` is a flexible bag of properties, while the handler treats it as a strict schema. To fix this, the "Source of Truth" must move from the model's "guess" to the handler's "requirement."

**The Approach:**
*   **Fail Loudly and Specifically:** The handler for `exercise_language` must never return `{"status":"done"}` if it didn't actually perform an action. If the keys `item1` and `item2` are missing, it should return an error similar to the one you observed for `vocab_card`.
*   **The "Just-in-Time" Schema:** Since you use a dispatcher to save tool slots, the tool description for `params_json` should explicitly state: *"The structure of params_json depends on the type. If you are unsure of the parameters for a type, call the tool with an empty object {} to receive the required schema."*
*   **Honesty through Feedback:** If she receives an error, she should be prompted (via the tool result text) to acknowledge the delay.
    *   *Example Tool Result:* `{"status":"error", "message":"Missing 'item1' and 'item2'. Please try again with these keys.", "recovery_hint": "Tell the student you're just getting the board ready."}`

### 2. Should she have two ways to compare, or one?
**She should have one.** 

Having both `visual_compare` (top-level) and `exercise_language {type: "compare"}` (dispatcher) creates **Cross-Pollination Interference**. 
*   **The Problem:** When she sees two tools that do the same thing, her internal weights for their parameters get "smudged." She likely used `word1` and `word2` because she was subconsciously blending the requirements of a different tool or a generic programming pattern.
*   **The Recommendation:** Consolidate. If the dispatcher `compare` is intended to be the primary way to show things on the board, delete the top-level `visual_compare`. If `visual_compare` is more robust, remove the `compare` selector from the dispatcher. 
*   **Why?** Reducing the "surface area" of choices reduces the probability of parameter hallucination.

### 3. What risks do you see in returning errors for missing parameters during a live voice turn?
The primary risk is **Conversational Whiplash**. 

*   **The "Commitment" Problem:** Because the Live API is optimized for low latency, Daniela often starts her sentence ("I've put those on the board...") before the tool result has even been processed by her "brain." 
*   **The Correction Loop:** If she says "Here they are!" and *then* sees an error, she has to backtrack. If the error message is too technical, she might say, "I'm sorry, I have a JSON schema error," which breaks immersion.
*   **The "Double-Talk" Risk:** If she tries to fix it immediately, she might interrupt herself or enter a loop where she calls the tool, fails, apologizes, calls it again, and fails again (as seen in your evidence).
*   **The Latency Gap:** There is a window of ~500ms-1s where she is "blind" to the tool's failure but already "committed" to the success of the action in her speech.

### 4. What are we assuming wrongly?
*   **Assumption: "Done" means "Visible to Student."** You are assuming that the model understands "Done" as a functional confirmation. To an LLM, "Done" is just a token that satisfies a completion. If the handler didn't actually render anything, "Done" is a lie. You should change the success message to be more descriptive: `{"status":"success", "ui_rendered": "Comparison table for ser/estar is now visible to the student"}`. This gives her the "evidence" she needs to speak confidently.
*   **Assumption: The model reads the documentation every time.** While the documentation is in the context, the model relies heavily on **positional bias** and **naming conventions**. If a parameter is named `params_json`, the model assumes it is a "black box" where it can be creative. 
*   **Assumption: The 64-tool limit is the only constraint.** While it's a hard limit, the "cognitive load" of a single tool with 20 sub-types (the dispatcher) is actually higher for the model than 20 distinct tools. The dispatcher pattern requires the model to perform a "nested lookup" in its own context, which is where the parameter names (`item1` vs `word1`) get lost.
*   **Assumption: Silent failure is safer than an error.** In a voice interface, a silent failure is the worst possible outcome because it forces the user to correct the AI, which undermines the AI's authority as a teacher. An immediate, polite "Wait, let me try that again, the board didn't update" is much better than "Can you see it now?" when nothing is there.

## Stage 2 prompt (the diff followed)
Stage 2: our approach and the actual code. First, a correction to what I told you in stage 1.

## Correction
I said `visual_compare` was a separate tool she could have chosen. That was wrong. In voice sessions it is in GL_EXCLUDED_TOOLS and has no dispatcher selector, so she cannot reach it. The `compare` selector is her only way to compare in voice. So your "she should have one" is already true for her. Your reasoning about smudged parameters doesn't apply to this case. Her guess of word1/word2 is explained by the guidance giving no parameters at all.

## What we propose
1. `compare` keeps its selector and shows the working comparison card, by routing to the same handler as `visual_compare`. It gains optional meanings and examples.
2. Her guidance for that selector gives the parameters with an example, in the same form as neighbouring selectors.
3. A general check in the dispatcher: if a selector's declared required inputs are missing, it does not run, and she gets the existing error shape instead of "done". Spoken `text` is exempt, because many tools declare it required while every handler treats it as optional. We checked that every other required input of the 97 selectors with handlers is read by its handler, though some might have defaults, so a call that works today could now get one error and a corrected retry. This reuses the existing failure counter: a second consecutive failure returns the existing abort result ("Internal tool error. Apologize to the student and continue without this tool."), so she can't loop.

## What the observed call now gets
```json
{"status":"error","code":"INVALID_SUBTOOL","message":"Nothing was shown. \"compare\" needs item1 and item2 in params_json, and received word1, word2.","details":{"correction_example":"{\"item1\":\"...\",\"item2\":\"...\"}"},"action":"RETRY_WITH_CORRECTED_PARAMETERS"}
```

## Two of your suggestions we are not proposing yet, and why. Tell us if we're wrong.
- **`recovery_hint: "Tell the student you're just getting the board ready."`** Scripting her words in a tool result works against how we write for her: she decides what to say, and "getting the board ready" isn't obviously true. "Nothing was shown" gives her the fact.
- **A success message saying the table "is now visible to the student".** The server knows it sent a message, not that the student's screen rendered it. Writing "visible" would be a new unverified claim of the kind that caused this. We could say "sent to the whiteboard", which is true but no stronger than "done" in a useful way.
- **Calling with {} to get the schema.** The error already lists what's needed, so she gets this without a new instruction.

## Questions
1. Compare this with your stage 1 approach. What holes do you see?
2. Is the error text right for her? Anything that would make her narrate mechanics to a student, or sound wrong in speech?
3. Is the guidance line right, and the parameter names and descriptions?
4. Your commitment problem: she may already be saying "here it is" when the error arrives. Is there anything we should change here, or is that a separate issue?
5. Is `compare` needing `item1`/`item2` while the card's fields are concept_a/concept_b a problem she'd ever see?
6. Give a clear verdict at the end: either "APPROVED — Ship it." or the specific changes you require.

## The diff
```diff

```

## Stage 2 response
This approach is a significant improvement over the "silent failure" state. It moves the system toward a **Contract-First** architecture where the dispatcher enforces the schema that the handlers require.

Here are the answers to your questions and the final verdict.

### 1. Compare this with your stage 1 approach. What holes do you see?
This is more robust than my Stage 1 suggestion. Specifically:
*   **The "Empty Object" vs. "Immediate Error":** My suggestion to have her call `{}` to learn the schema was a "pull" model. Your proposal is a "push" model (giving her the schema in the error). The "push" model is better for voice because it saves a conversational turn.
*   **The Mapping Layer:** Routing `compare` to the `visual_compare` handler is the correct move. It ensures that the "best" UI is used regardless of the entry point.
*   **The "Text" Exception:** Smart move to exempt `text`. LLMs often treat "text" as a default dumping ground for descriptions; enforcing it strictly would cause unnecessary friction.

**Potential Hole:** The `missingRequiredParams` check relies on `registry.find`. Ensure that the `registry` is always up-to-date with the actual handler logic. If a developer changes a handler to require a new field but forgets to update the `daniela-function-registry.ts` declaration, you will return to a silent failure state.

### 2. Is the error text right for her?
**"Nothing was shown."** is the perfect anchor. 
*   It is a "sensory" fact. If she just said "I've put that on the board," and the tool result says "Nothing was shown," it creates an immediate cognitive dissonance that forces a correction.
*   The technical part ("needs item1... received word1") is fine. She won't read that out loud because she is trained to translate technical tool results into natural speech. She will likely say, "Oh, hold on, let me try that again—the board didn't update."

### 3. Is the guidance line right?
Yes. The addition of `params_json: {"item1":"ser", ...}` provides the "few-shot" pattern she needs to avoid guessing. LLMs are pattern-matchers; seeing the keys in the guidance is 90% of the fix.

### 4. The commitment problem
This remains the biggest risk in voice. If she is 2 seconds into "I've put those on the board for you, can you see them?" and the tool result comes back as an error, she has two choices:
1.  **The Pivot:** "I've put those on the—actually, wait, it looks like I had a glitch. Let me try that again."
2.  **The Gaslight:** She finishes her sentence, then sees the error, then tries to fix it in the *next* turn.

Your proposal doesn't "fix" the timing (that's an API/latency issue), but it **enables the pivot.** Without this error, she has no way to know she's gaslighting the student. With it, she has the data to be honest.

### 5. Is `item1/item2` vs `concept_a/concept_b` a problem?
**No.** The model only sees the "public" interface (`item1/item2`). The mapping to `concept_a/concept_b` happens "under the hood" in your server code. As long as the model's "World View" (the registry) is consistent with the "Input" it provides, the internal variable names in the handler don't matter.

### 6. Verdict

**APPROVED — Ship it.**

The combination of **explicit guidance examples**, **strict dispatcher-level validation**, and **handler consolidation** addresses the root cause while respecting the constraints of the Live API. 

**One minor suggestion for the future:** If you find she still struggles with `item1/item2`, consider renaming them in the registry to `word_a/word_b` to match her natural intuition, but the current fix is more than sufficient to solve the observed failure.

## Stage 3 prompt (the diff followed)
Stage 3, a follow-up on the change you approved. A peer reviewer found that the general check is wrong, so we are narrowing it. Please tell us if the narrower version loses something you relied on.

## What the review found (read from the code)
- Her guidance for `tone` teaches `{"word":"ma","tones":[1,2,3,4]}`, but the declaration requires `syllable` and `toneNumber`. Following her own guidance would be rejected.
- `flag_for_agent`: guidance teaches `subject` and `body`, the declaration requires `topic`, `description` and `urgency`, and the handler defaults `urgency`.
- `set_right_pane`: guidance teaches `content`, the declaration requires `mode`, and the handler defaults `mode`.
- `move_in_scene`, `read_my_story`, `show_menu`, `summary`, `spotlight_element` and `set_learning_goal` each declare a required input their handler defaults. `reading` and `show_sentence_table` accept aliases the check would reject.

So a check built on declarations would turn calls that work today into errors, and would contradict what she is taught.

## What we now propose
Same error text, same abort, same guidance line for `compare`, same routing to the comparison card. The only change: the check runs only for selectors on a short list that have been verified against both guidance and handler. Today that is `compare` alone. Removing the rule for spoken text follows, since `compare` doesn't declare it.

The other mismatches stay as a separate finding. Some are the same bug as the one we started with: `tone` following its guidance probably does nothing while reporting done. Fixing those means changing her guidance selector by selector, each with this review.

## Questions
1. Is narrowing right, or would you rather fix the declarations first and keep the general check?
2. Anything in the unchanged parts you'd now reconsider?
3. Clear verdict: "APPROVED — Ship it." or what you require.

## Diff against what you approved
```diff
```

## Stage 3 response
The peer review was insightful and caught a significant risk. In a complex system like Daniela’s, "correct" code that breaks "working" legacy behavior is a regression.

### 1. Is narrowing right, or should you fix all declarations first?
**Narrowing is the right move.** 

If you tried to fix all declarations and guidance at once to enable a global check, you would be opening a massive front of testing across 97+ selectors. You would likely introduce "hallucination debt" where Daniela, confused by new parameter names for tools she’s used to, starts failing in new, unpredictable ways.

By using `INPUT_CHECKED_SELECTORS`, you are creating a **"Validated Path."** This allows you to migrate tools to a high-reliability state one by one. It solves the immediate "founder-observed" failure without risking the stability of the rest of the session.

### 2. Anything in the unchanged parts to reconsider?
Only one minor detail regarding the `missingRequiredParams` function:
By removing the `.filter(key => key !== 'text' && key !== 'spoken_text')` line, you are assuming that for any selector added to the `INPUT_CHECKED_SELECTORS` list, the declaration will be perfectly accurate. 

If you later add a tool to that list that *does* declare `text` as required (but the handler still treats it as optional), you will re-introduce the bug you just avoided. However, since you are manually verifying each selector before adding it to the list, this is a manageable risk. Just keep in mind that **the list is a promise that the declaration and handler are in perfect sync.**

### 3. Verdict

**APPROVED — Ship it.**

This is a pragmatic, surgical fix. It solves the "silent failure" for the comparison tool—which was the source of the conversational breakdown—while protecting the system from a cascade of "false positive" errors in other tools. It also provides a clear pattern for how to harden the rest of her tools over time.

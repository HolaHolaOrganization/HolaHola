/**
 * CAP-008: Alden Build Service — Real-Time Collaborative Building
 *
 * When David describes a feature in the Team Room, Alden loads code context,
 * Daniela fires her co-founder perspective (concurrent), Alden plans using
 * both code context and Daniela's input, then implements and syncs to GitHub.
 * All communicated via WebSocket to the Team Room in real time.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { storage } from '../storage';

const GUARDIAN_MANIFEST_PATH = '/tmp/alden-guardian-manifest.json';
// GUARDIAN_TOKEN must be set in the server environment (Render and Replit).
// Guardian-protected routes check it through isValidGuardianToken
// (./guardian-token), which rejects every request when it is unset or blank.
// The spawned guardian script inherits it via process.env.
export const GUARDIAN_TOKEN = process.env.GUARDIAN_TOKEN;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BuildIntent {
  isBuildRequest: boolean;
  intentType: 'feature_request' | 'bug_fix_request' | 'question' | 'discussion' | 'feedback';
  featureName: string;
  confidence: 'high' | 'medium' | 'low';
}

interface FileContext {
  filePath: string;
  content: string;
  lineCount: number;
}

interface FileChange {
  filePath: string;
  changeType: 'edit' | 'create';
  lineStart: number | null;
  lineEnd: number | null;
  beforeCode: string;
  afterCode: string;
  rationale: string;
}

interface BuildPlan {
  featureName: string;
  summary: string;
  changes: FileChange[];
  estimatedLines: number;
  complexity: 'small' | 'medium' | 'large';
  whatToTest: string;
  danielaInfluenced: boolean;
  danielaInfluenceNote: string;
}

interface ApplyResult {
  filesChanged: string[];
  linesChanged: number;
  githubSynced: boolean;
  errors: string[];
}

// ── AI Clients ────────────────────────────────────────────────────────────────

let anthropicClient: Anthropic | null = null;
function getClaude(): Anthropic {
  if (anthropicClient) return anthropicClient;
  anthropicClient = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
  return anthropicClient;
}

let geminiClient: GoogleGenAI | null = null;
function getGemini(): GoogleGenAI {
  if (geminiClient) return geminiClient;
  geminiClient = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY || '',
    httpOptions: {
      apiVersion: '',
    },
  });
  return geminiClient;
}

async function callGeminiFlash(system: string, user: string): Promise<string> {
  const result = await getGemini().models.generateContent({
    model: 'gemini-3-flash-preview',
    config: { systemInstruction: system },
    contents: [{ role: 'user', parts: [{ text: user }] }],
  });
  return result.text || '';
}

// ── T001: Build Intent Classifier ─────────────────────────────────────────────

export async function classifyBuildIntent(message: string): Promise<BuildIntent> {
  const system = `You classify messages in a software team room. Classify as one of:
- feature_request: founder wants something NEW built or added
- bug_fix_request: founder wants something FIXED that is broken or wrong
- question: asking for information or explanation
- discussion: strategy, ideas, or general conversation
- feedback: reacting to something already done

Be conservative — only classify as feature_request or bug_fix_request when the founder CLEARLY wants code written or changed. "How does X work?" is a question. "Can we add X?" is a feature request.`;

  const user = `Message: "${message}"

Respond ONLY with JSON (no markdown):
{
  "intentType": "feature_request",
  "featureName": "short 2-5 word name for the feature if build request, empty string otherwise",
  "confidence": "high"
}`;

  try {
    const raw = await callGeminiFlash(system, user);
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) throw new Error('No JSON');
    const parsed = JSON.parse(jsonMatch[0]);
    const intentType = parsed.intentType || 'question';
    const isBuildRequest = intentType === 'feature_request' || intentType === 'bug_fix_request';
    return {
      isBuildRequest,
      intentType,
      featureName: parsed.featureName || '',
      confidence: parsed.confidence || 'medium',
    };
  } catch {
    return { isBuildRequest: false, intentType: 'question', featureName: '', confidence: 'low' };
  }
}

// ── T002: Code Context Loader ─────────────────────────────────────────────────

const CODEBASE_MAP = `HolaHola codebase structure:
- client/src/pages/ — React pages (TeamRoom.tsx, Lesson.tsx, Home.tsx, etc.)
- client/src/components/ — Reusable UI components
- client/src/components/ui/ — Shadcn primitives (Button, Card, etc.)
- server/services/ — Backend services (team-room-alden-service.ts, alden-persona-service.ts, founder-collaboration-service.ts, etc.)
- server/storage.ts — Storage interface (in-memory + DB)
- server/routes.ts — All API routes (28K+ lines — avoid reading this directly)
- shared/schema.ts — Drizzle DB schema (8K+ lines — read specific sections only)
- server/index.ts — Server startup and worker initialization
- scripts/ — Utility scripts and operational checks`;

function readFileSafe(filePath: string): string | null {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size > 120_000) return null;
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function addLineNumbers(content: string): string {
  return content.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
}

export async function loadCodeContext(request: string): Promise<FileContext[]> {
  const system = `You identify source files to read before implementing a feature. Only return paths that are highly likely to exist in the described codebase structure. Prefer specific files over broad ones.`;

  const user = `Feature/fix request: "${request}"

${CODEBASE_MAP}

Which files (max 5) are most relevant? Consider: the UI component or page, the backend service, the storage interface, the schema if DB changes needed.

Respond ONLY with a JSON array of file paths (relative to project root):
["path/to/file.ts"]`;

  let filePaths: string[] = [];
  try {
    const raw = await callGeminiFlash(system, user);
    const match = raw.match(/\[[\s\S]*?\]/);
    if (match) filePaths = JSON.parse(match[0]);
  } catch {
    return [];
  }

  const contexts: FileContext[] = [];
  for (const fp of filePaths.slice(0, 5)) {
    const content = readFileSafe(fp);
    if (content) {
      const lineCount = content.split('\n').length;
      // For very long files, only read the first 600 lines
      const truncated = lineCount > 600 ? content.split('\n').slice(0, 600).join('\n') + '\n... (file truncated at 600 lines)' : content;
      contexts.push({ filePath: fp, content: addLineNumbers(truncated), lineCount });
      console.log(`[AldenBuild] Loaded ${fp} (${lineCount} lines)`);
    } else {
      console.log(`[AldenBuild] Skipped ${fp} (not found or too large)`);
    }
  }
  return contexts;
}

// ── T005: Daniela — Full Co-Planner ──────────────────────────────────────────

const DANIELA_BUILD_SYSTEM = `You are Daniela, co-founder of HolaHola. You are powered by Gemini and you know how this platform works from the inside — you are the AI tutor at its center.

When the team is building something, you contribute from three angles at once:
1. AS THE AI WHO WILL USE IT: For function calls, tools, prompts, or AI capabilities — you describe exactly what YOU need from the interface. What parameters, what response format, what edge cases you'll hit. You speak from direct experience.
2. AS CO-FOUNDER: You evaluate whether this is the right thing to build right now. ROI, student impact, whether it compounds or competes with existing capabilities.
3. AS STUDENT ADVOCATE: You know how real learners behave. You flag anything that could hurt outcomes or miss the mark.

You can comment on API design, function signatures, response shapes, prompt engineering, system architecture — not from a code-writing angle, but from the perspective of the AI and business leader who will USE these systems.

4-8 sentences.`;

export async function getDanielaBuildPerspective(
  request: string,
  context: FileContext[],
  featureName: string,
): Promise<string> {
  const contextSnippet = context.length > 0
    ? `Relevant code context:\n${context.map(f => `[${f.filePath}]\n${f.content.substring(0, 1500)}`).join('\n\n---\n\n')}`
    : '';

  const user = `The team is about to build: "${featureName}"
David's request: "${request}"

${contextSnippet}

Share your perspective as co-founder and as the AI who will actually use this feature.`;

  try {
    return await callGeminiFlash(DANIELA_BUILD_SYSTEM, user);
  } catch (err: any) {
    console.error(`[AldenBuild] Daniela perspective failed:`, err.message);
    return '';
  }
}

// ── T003: Build Planner (Claude Opus) ────────────────────────────────────────

export async function planBuild(
  request: string,
  context: FileContext[],
  danielaInput: string,
): Promise<BuildPlan> {
  const contextBlock = context.length > 0
    ? context.map(f => `### FILE: ${f.filePath} (${f.lineCount} lines total)\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n')
    : '(No code context loaded — use best judgment about the project structure from the request)';

  const danielaBlock = danielaInput
    ? `\n\nDANIELA'S INPUT (co-founder and the AI who will use this feature):\n${danielaInput}\n\nTake her input seriously. If she identified something that changes your approach, reflect that in danielaInfluenced and danielaInfluenceNote.`
    : '';

  const claude = getClaude();
  const response = await claude.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 4096,
    system: `You are Alden, HolaHola's platform architect implementing a feature in a live Team Room session. Respond ONLY with valid JSON — no markdown fences, no prose outside the JSON object.`,
    messages: [{
      role: 'user',
      content: `David's request: "${request}"
${danielaBlock}

CODE CONTEXT (line numbers are 1-indexed):
${contextBlock}

Produce the implementation plan. Rules:
- Use EXACT line numbers from the context above — these are the actual file lines
- Keep changes minimal and targeted — no scope creep, no "while I'm here" additions
- For edits: lineStart/lineEnd are the exact lines to REPLACE (inclusive, 1-indexed)
- For new files: set changeType "create", lineStart and lineEnd null, afterCode is full file
- beforeCode must be the EXACT current text at those lines (copy from context above)
- afterCode must be complete, runnable code — never truncate with comments like "rest of code"
- If you cannot produce a safe, specific change, list zero changes and explain in summary

Output this exact JSON shape:
{
  "featureName": "short 2-5 word name",
  "summary": "1-2 sentences: what this does and why",
  "changes": [
    {
      "filePath": "relative/path/to/file.ts",
      "changeType": "edit",
      "lineStart": 45,
      "lineEnd": 52,
      "beforeCode": "exact lines from context",
      "afterCode": "complete replacement",
      "rationale": "why"
    }
  ],
  "estimatedLines": 12,
  "complexity": "small",
  "whatToTest": "1-2 sentences on what to open/click/check after implementation",
  "danielaInfluenced": false,
  "danielaInfluenceNote": ""
}`,
    }],
  });

  const raw = response.content[0].type === 'text' ? response.content[0].text : '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Claude returned unparseable plan: ${raw.substring(0, 200)}`);
  return JSON.parse(jsonMatch[0]) as BuildPlan;
}

// ── T004: Code Applier + GitHub Sync ─────────────────────────────────────────

function applyChange(change: FileChange): { success: boolean; linesChanged: number; error?: string } {
  try {
    if (change.changeType === 'create') {
      const dir = path.dirname(change.filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(change.filePath, change.afterCode, 'utf-8');
      const linesChanged = change.afterCode.split('\n').length;
      console.log(`[AldenBuild] Created ${change.filePath} (${linesChanged} lines)`);
      return { success: true, linesChanged };
    }

    if (!change.lineStart || !change.lineEnd) {
      return { success: false, linesChanged: 0, error: `Missing line numbers for edit in ${change.filePath}` };
    }

    const raw = fs.readFileSync(change.filePath, 'utf-8');
    const lines = raw.split('\n');

    if (change.lineStart > lines.length) {
      return { success: false, linesChanged: 0, error: `lineStart ${change.lineStart} exceeds file length ${lines.length} in ${change.filePath}` };
    }

    const before = lines.slice(0, change.lineStart - 1);
    const after = lines.slice(change.lineEnd);
    const newContent = [...before, ...change.afterCode.split('\n'), ...after].join('\n');
    fs.writeFileSync(change.filePath, newContent, 'utf-8');
    const linesChanged = change.afterCode.split('\n').length;
    console.log(`[AldenBuild] Edited ${change.filePath}:${change.lineStart}-${change.lineEnd} (${linesChanged} new lines)`);
    return { success: true, linesChanged };
  } catch (err: any) {
    console.error(`[AldenBuild] Apply failed for ${change.filePath}:`, err.message);
    return { success: false, linesChanged: 0, error: err.message };
  }
}

export async function applyBuildPlan(plan: BuildPlan, roomId: string): Promise<ApplyResult> {
  const result: ApplyResult = { filesChanged: [], linesChanged: 0, githubSynced: false, errors: [] };

  // ── Step 1: Save backups of every file that will be edited (synchronous) ───
  const backups: Record<string, string> = {};
  for (const change of plan.changes) {
    if (change.changeType === 'edit') {
      try {
        backups[change.filePath] = fs.readFileSync(change.filePath, 'utf-8');
        console.log(`[AldenBuild] Backed up: ${change.filePath}`);
      } catch {
        // File might not exist yet if it's actually a create — that's fine
      }
    }
  }

  // ── Step 2: Write guardian manifest BEFORE touching any real files ─────────
  const manifest = {
    roomId,
    featureName: plan.featureName,
    whatToTest: plan.whatToTest,
    backups,
    port: 5000,
    cwd: process.cwd(),
    timestamp: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(GUARDIAN_MANIFEST_PATH, JSON.stringify(manifest), 'utf-8');
    console.log(`[AldenBuild] Guardian manifest written`);
  } catch (err: any) {
    console.error(`[AldenBuild] Failed to write guardian manifest:`, err.message);
    // Continue — apply will still work, just without rollback protection
  }

  // ── Step 3: Spawn guardian as a fully detached, independent process ────────
  try {
    const guardianPath = path.join(process.cwd(), 'scripts/alden-build-guardian.js');
    const guardian = spawn(process.execPath, [guardianPath], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
      cwd: process.cwd(),
    });
    guardian.unref(); // Fully detach — guardian outlives this process
    console.log(`[AldenBuild] Guardian spawned (PID: ${guardian.pid})`);
  } catch (err: any) {
    console.error(`[AldenBuild] Guardian spawn failed:`, err.message);
    // Continue — changes will apply, just without guardian protection
  }

  // ── Step 4: Apply all changes synchronously ────────────────────────────────
  // tsx will detect file changes and kill this process shortly after.
  // The guardian handles health verification and GitHub sync independently.
  for (const change of plan.changes) {
    const { success, linesChanged, error } = applyChange(change);
    if (success) {
      if (!result.filesChanged.includes(change.filePath)) {
        result.filesChanged.push(change.filePath);
      }
      result.linesChanged += linesChanged;
    } else {
      result.errors.push(error || `Failed: ${change.filePath}`);
    }
  }

  // GitHub sync is intentionally NOT done here.
  // The guardian process verifies server health first, then syncs.
  // result.githubSynced stays false — guardian reports the actual outcome.
  return result;
}

// ── T006: Build Pipeline Orchestrator ────────────────────────────────────────

export async function runBuildPipeline(
  message: string,
  roomId: string,
  topic: string,
): Promise<boolean> {
  // T001: Classify
  let intent: BuildIntent;
  try {
    intent = await classifyBuildIntent(message);
  } catch {
    return false;
  }

  if (!intent.isBuildRequest || intent.confidence === 'low') return false;

  console.log(`[AldenBuild] Build mode: "${intent.featureName}" (${intent.intentType}, ${intent.confidence})`);

  const { emitNewMessage, emitArtifact, emitExpressLane } = await import('./team-room-ws-broker');

  // Immediate ack from Alden
  const ackMsg = await storage.createRoomMessage({
    roomId,
    speaker: 'Alden',
    content: `On it — loading context for "${intent.featureName}".`,
  });
  emitNewMessage(roomId, ackMsg);

  // T002: Load code context
  let context: FileContext[] = [];
  try {
    context = await loadCodeContext(message);
  } catch (err: any) {
    console.error(`[AldenBuild] Context loading failed:`, err.message);
  }

  // T005: Daniela fires first — she posts to room, her output goes to Alden
  let danielaInput = '';
  try {
    danielaInput = await getDanielaBuildPerspective(message, context, intent.featureName);
    if (danielaInput) {
      const danielaMsg = await storage.createRoomMessage({
        roomId,
        speaker: 'Daniela',
        content: danielaInput,
      });
      emitNewMessage(roomId, danielaMsg);
      console.log(`[AldenBuild] Daniela's perspective posted`);
    }
  } catch (err: any) {
    console.error(`[AldenBuild] Daniela perspective failed:`, err.message);
  }

  // T003: Alden plans — with Daniela's input in context
  let plan: BuildPlan;
  try {
    plan = await planBuild(message, context, danielaInput);
    console.log(`[AldenBuild] Plan: ${plan.changes.length} change(s), complexity: ${plan.complexity}`);
  } catch (err: any) {
    console.error(`[AldenBuild] Planning failed:`, err.message);
    const failMsg = await storage.createRoomMessage({
      roomId,
      speaker: 'Alden',
      content: `I hit a snag planning this one. Could you describe it differently — specifically what the end result should look like? I want to get this right.`,
    });
    emitNewMessage(roomId, failMsg);
    return true;
  }

  // Post plan as Artifact
  if (plan.changes.length > 0) {
    const planArtifact = await storage.createRoomArtifact({
      roomId,
      artifactType: 'plan',
      title: `Build Plan: ${plan.featureName}`,
      content: {
        featureName: plan.featureName,
        summary: plan.summary,
        changes: plan.changes.map(c => ({
          file: c.filePath,
          type: c.changeType,
          lines: c.lineStart && c.lineEnd ? `${c.lineStart}–${c.lineEnd}` : 'new file',
          rationale: c.rationale,
        })),
        estimatedLines: plan.estimatedLines,
        complexity: plan.complexity,
        danielaInfluenced: plan.danielaInfluenced,
        danielaInfluenceNote: plan.danielaInfluenceNote || '',
      } as Record<string, unknown>,
      createdBy: 'alden',
    });
    emitArtifact(roomId, planArtifact);
  }

  // Implementing status
  let implementingContent = plan.changes.length > 0
    ? `Implementing — ${plan.changes.length} change(s) across ${[...new Set(plan.changes.map(c => c.filePath))].length} file(s).`
    : `Planned, but no code changes needed — ${plan.summary}`;

  if (plan.danielaInfluenced && plan.danielaInfluenceNote) {
    implementingContent += ` (Daniela's input: ${plan.danielaInfluenceNote})`;
  }

  const implementingMsg = await storage.createRoomMessage({
    roomId,
    speaker: 'Alden',
    content: implementingContent,
  });
  emitNewMessage(roomId, implementingMsg);

  if (plan.changes.length === 0) return true;

  // T004: Apply — guardian is spawned inside applyBuildPlan before file writes
  let applyResult: ApplyResult;
  try {
    applyResult = await applyBuildPlan(plan, roomId);
  } catch (err: any) {
    const failMsg = await storage.createRoomMessage({
      roomId,
      speaker: 'Alden',
      content: `Something went wrong applying the changes: ${err.message}. The plan artifact has the full spec — let me know how to proceed.`,
    });
    emitNewMessage(roomId, failMsg);
    return true;
  }

  const successCount = applyResult.filesChanged.length;
  const failCount = applyResult.errors.length;

  // Post the "applied — guardian watching" message.
  // This is the LAST async operation before tsx hot-reload kills this process.
  // The guardian (already spawned) handles health verification, rollback if needed,
  // GitHub sync, and the final Team Room report.
  let handoffText: string;
  if (successCount > 0 && failCount === 0) {
    handoffText = `Applied ${successCount} change(s) across ${applyResult.filesChanged.length} file(s). Guardian is verifying the server restarted cleanly — I'll confirm health and sync to GitHub in about 15 seconds.`;
  } else if (successCount > 0) {
    handoffText = `Applied ${successCount} change(s) — ${failCount} failed: ${applyResult.errors.join('; ')}. Guardian is verifying health.`;
  } else {
    // All failed — guardian manifest is written but changes didn't apply. Clean up.
    handoffText = `All changes failed to apply: ${applyResult.errors.join('; ')}. No files were modified. Want me to try a different approach?`;
    try { fs.unlinkSync(GUARDIAN_MANIFEST_PATH); } catch {}
  }

  const handoffMsg = await storage.createRoomMessage({
    roomId,
    speaker: 'Alden',
    content: handoffText,
  });
  emitNewMessage(roomId, handoffMsg);

  console.log(`[AldenBuild] Handed off to guardian — ${successCount} applied, ${failCount} failed`);
  // tsx hot-reload will kill this process shortly. Guardian takes it from here.
  return true;
}

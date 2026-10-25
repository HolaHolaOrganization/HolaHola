import { GoogleGenAI } from "@google/genai";
import Anthropic from "@anthropic-ai/sdk";
import { buildAldenSystemPrompt } from "../alden-system-prompt";
import { ALDEN_TOOLS, executeAldenTool, toAnthropicAldenTools } from "./alden-functions";
import { buildAldenWorkspaceContext } from "./alden-workspace-context";
import { aldenActivity } from "./alden-activity-emitter";
import { aldenCoordinationReadReceipt, serializeAldenToolResult } from "./alden-tool-result";
import { AldenReviewReadSession, type AldenReviewSourceReference } from "./alden-review-source";
import { loadAldenReviewSourceReferences } from "./alden-review-source-context";
import { costTracker } from "./cost-tracker";
import { runAldenAnthropicTurn } from "./alden-anthropic-turn";
import { getUserDb } from "../db";
import { aldenConfig, aldenEngineSwitches } from "@shared/schema";
import { desc, eq } from "drizzle-orm";

const GEMINI_MODEL = 'gemini-2.5-flash';
const ANTHROPIC_MODEL = 'claude-opus-5-5';
// Claude Opus 5.5 always thinks; effort is the only depth control and defaults to
// medium. Alden reviews code and reports on system state, so it runs at high.
// The installed SDK (0.71) predates output_config's types; the field is sent as-is.
const ANTHROPIC_EFFORT = { output_config: { effort: 'high' } } as Record<string, unknown>;
// Thinking counts toward max_tokens, so these leave room for it as well as the reply.
const ANTHROPIC_MAX_TOKENS = 16000;
const ANTHROPIC_WRAP_MAX_TOKENS = 8000;

export type AldenEngine = 'anthropic' | 'gemini';

let geminiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  if (geminiClient) return geminiClient;
  geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
  return geminiClient;
}

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (anthropicClient) return anthropicClient;
  anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropicClient;
}

// ── Engine selection (DB-backed, short-lived cache) ────────────────────────
const ENGINE_CACHE_TTL_MS = 15 * 1000;
let engineCache: { engine: AldenEngine; cachedAt: number } | null = null;

export async function getAldenEngine(): Promise<AldenEngine> {
  const now = Date.now();
  if (engineCache && (now - engineCache.cachedAt) < ENGINE_CACHE_TTL_MS) {
    return engineCache.engine;
  }
  try {
    const db = getUserDb();
    const rows = await db.select().from(aldenConfig).limit(1);
    const engine = (rows[0]?.engine as AldenEngine) || 'anthropic';
    engineCache = { engine, cachedAt: now };
    return engine;
  } catch (err: any) {
    console.warn('[Alden Engine] Failed to read alden_config, defaulting to anthropic:', err.message);
    return 'anthropic';
  }
}

export async function setAldenEngine(engine: AldenEngine, initiatedBy: string, reason?: string): Promise<void> {
  const db = getUserDb();
  const current = await getAldenEngine();
  const rows = await db.select().from(aldenConfig).limit(1);

  if (rows.length === 0) {
    await db.insert(aldenConfig).values({ engine, updatedBy: initiatedBy, reason });
  } else {
    await db.update(aldenConfig).set({ engine, updatedBy: initiatedBy, reason, updatedAt: new Date() }).where(eq(aldenConfig.id, rows[0].id));
  }

  await db.insert(aldenEngineSwitches).values({
    fromEngine: current,
    toEngine: engine,
    initiatedBy,
    reason,
  });

  engineCache = { engine, cachedAt: Date.now() };
  console.log(`[Alden Engine] Switched ${current} → ${engine} (by ${initiatedBy}${reason ? `: ${reason}` : ''})`);
}

export async function getRecentEngineSwitches(limit = 20) {
  const db = getUserDb();
  return db.select().from(aldenEngineSwitches).orderBy(desc(aldenEngineSwitches.createdAt)).limit(limit);
}

// Convert Anthropic-format tool declarations (input_schema) to Gemini function declarations (parameters).
// The inner JSON Schema structure is identical — only the wrapper key changes.
function toGeminiFunctions(anthropicTools: any[]): any[] {
  return anthropicTools.map(tool => ({
    name: tool.name,
    description: tool.gemini_description || tool.description,
    parameters: tool.input_schema,
  }));
}

export interface SceneContext {
  sceneId: string;
  sceneName: string;
  sceneObjective: string;
  zoneKey?: string;
  zoneName?: string;
  zoneType?: string;
}

export interface LearningContext {
  currentScene?: SceneContext;
  isOffScene?: boolean;
  sceneTransitionPending?: boolean;
}

interface AldenChatParams {
  userMessage: string;
  conversationHistory?: Array<{ role: 'user' | 'model'; content: string }>;
  founderName?: string;
  timezone?: string;
  learningContext?: LearningContext;
  conversationId?: string;
  engineOverride?: AldenEngine;
  reviewSourceReferences?: AldenReviewSourceReference[];
  reviewSourceEngine?: AldenEngine;
}

interface ContinuationInfo {
  phaseTitle: string;
  phaseSummary: string;
  nextPrompt: string;
}

interface AldenChatResponse {
  response: string;
  toolsUsed: string[];
  coordinationReadReceipts?: NonNullable<ReturnType<typeof aldenCoordinationReadReceipt>>[];
  continuation?: ContinuationInfo;
  reviewSourceReferences?: AldenReviewSourceReference[];
  reviewSourceEngine?: AldenEngine;
}

const MAX_AGENT_ROUNDS = 10;

// ── Workspace Context Cache ────────────────────────────────────────────────
const WORKSPACE_CONTEXT_TTL_MS = 10 * 60 * 1000;
let workspaceContextCache: { context: string; builtAt: number } | null = null;

async function getWorkspaceContext(): Promise<string> {
  const now = Date.now();
  if (workspaceContextCache && (now - workspaceContextCache.builtAt) < WORKSPACE_CONTEXT_TTL_MS) {
    return workspaceContextCache.context;
  }
  const context = await buildAldenWorkspaceContext();
  workspaceContextCache = { context, builtAt: now };
  return context;
}

export async function generateAldenResponse(params: AldenChatParams): Promise<AldenChatResponse> {
  const engine = params.engineOverride ?? await getAldenEngine();
  if (engine === 'anthropic') {
    return generateAldenResponseAnthropic(params);
  }
  return generateAldenResponseGemini(params);
}

async function generateAldenResponseAnthropic(params: AldenChatParams): Promise<AldenChatResponse> {
  const { userMessage, conversationHistory = [], founderName = 'David', timezone, learningContext, conversationId } = params;
  const toolsUsed: string[] = [];
  const coordinationReadReceipts: NonNullable<ReturnType<typeof aldenCoordinationReadReceipt>>[] = [];
  let reviewReadSession = new AldenReviewReadSession();

  try {
    reviewReadSession = new AldenReviewReadSession((params.reviewSourceEngine === "anthropic" ? params.reviewSourceReferences : undefined)
      ?? await loadAldenReviewSourceReferences("anthropic", conversationId));
    const claude = getAnthropicClient();
    const systemPrompt = buildAldenSystemPrompt({ founderName, timezone, engine: 'anthropic' });
    const anthropicTools = toAnthropicAldenTools();

    const messages: Anthropic.MessageParam[] = [];

    const workspaceContext = await getWorkspaceContext();
    if (workspaceContext) {
      messages.push({ role: 'user', content: `[WORKSPACE CONTEXT — read and internalize before responding]\n\n${workspaceContext}` });
      messages.push({ role: 'assistant', content: 'Workspace loaded. I have my memory, past session context, and Express Lane activity. Ready.' });
    }

    if (learningContext) {
      const parts: string[] = [];
      if (learningContext.currentScene) {
        const s = learningContext.currentScene;
        parts.push(`CURRENT SCENE: ${s.sceneName} (${s.sceneId})\nObjective: ${s.sceneObjective}`);
        if (s.zoneKey) {
          parts.push(`ACTIVE ZONE: ${s.zoneName} [${s.zoneType}]\nKey: ${s.zoneKey}\nNote: Zone type '${s.zoneType}' means ${
            s.zoneType === 'spatial' ? 'focus on prepositions and object placement' :
            s.zoneType === 'interactional' ? 'focus on dialogue sequences and social language functions' :
            s.zoneType === 'departmental' ? 'focus on vocabulary categories and item identification' :
            'focus on directions, navigation, and wayfinding language'
          }`);
        }
      }
      if (learningContext.isOffScene) parts.push('NOTE: Student is exploring outside the main scene objective. Stay flexible and encouraging.');
      if (learningContext.sceneTransitionPending) parts.push('NOTE: Scene transition pending — help wrap up current context gracefully.');
      if (parts.length > 0) {
        messages.push({ role: 'user', content: '[LEARNING CONTEXT]\n\n' + parts.join('\n\n') });
        messages.push({ role: 'assistant', content: 'Learning context received. I understand the current scene and zone and will tailor my teaching accordingly.' });
      }
    }

    const MAX_HISTORY_MSG_CHARS = 2_000;
    for (const msg of conversationHistory.slice(-12)) {
      const raw = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const content = raw.length > MAX_HISTORY_MSG_CHARS
        ? raw.slice(0, MAX_HISTORY_MSG_CHARS) + `\n[… ${raw.length - MAX_HISTORY_MSG_CHARS} chars truncated from history]`
        : raw;
      messages.push({ role: msg.role === 'user' ? 'user' : 'assistant', content });
    }

    messages.push({ role: 'user', content: [reviewReadSession.rereadContext, userMessage].filter(Boolean).join("\n\n") });

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const turn = await runAldenAnthropicTurn({
      messages,
      maxRounds: MAX_AGENT_ROUNDS,
      maxTokens: ANTHROPIC_MAX_TOKENS,
      wrapMaxTokens: ANTHROPIC_WRAP_MAX_TOKENS,
      call: async ({ messages: turnMessages, maxTokens, withTools }) => claude.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: maxTokens,
        system: systemPrompt,
        ...(withTools ? { tools: anthropicTools } : {}),
        messages: turnMessages,
        ...ANTHROPIC_EFFORT,
      }),
      onModelResponse: (resp) => {
        reviewReadSession.acknowledgeDelivery();
        totalInputTokens += resp.usage?.input_tokens ?? 0;
        totalOutputTokens += resp.usage?.output_tokens ?? 0;
      },
      runTool: async (tu) => {
        toolsUsed.push(tu.name);
        aldenActivity.push({ type: 'tool_start', name: tu.name, timestamp: new Date().toISOString() });
        try {
          const toolResult = await executeAldenTool(tu.name, (tu.input as Record<string, any>) || {}, { conversationId, engine: 'anthropic', reviewReadSession });
          aldenActivity.push({ type: 'tool_result', name: tu.name, success: true, timestamp: new Date().toISOString() });
          const truncatedResult = serializeAldenToolResult(tu.name, toolResult.data);
          reviewReadSession.stageDelivery(tu.name, truncatedResult);
          const receipt = aldenCoordinationReadReceipt(tu.name, toolResult.data, (tu.input as Record<string, unknown>) || {});
          if (receipt) coordinationReadReceipts.push(receipt);
          return { content: truncatedResult, isError: false, continuation: toolResult.sideEffects?.continuation };
        } catch (err: any) {
          console.warn(`[Alden Chat/Claude] Tool ${tu.name} failed:`, err.message);
          aldenActivity.push({ type: 'tool_result', name: tu.name, success: false, error: err.message, timestamp: new Date().toISOString() });
          return { content: `Error: ${err.message}`, isError: true };
        }
      },
    });
    const aldenResponse = turn.response;
    const pendingContinuation = turn.continuation as ContinuationInfo | undefined;

    const callCostUsd = costTracker.track(ANTHROPIC_MODEL, totalInputTokens, totalOutputTokens, 'alden-chat');
    console.log(`[Alden Chat/Claude] Response generated (${aldenResponse.length} chars, ${toolsUsed.length} tools used, ~$${callCostUsd.toFixed(4)} | ${(totalInputTokens/1000).toFixed(0)}k in / ${(totalOutputTokens/1000).toFixed(0)}k out)`);

    aldenActivity.push({ type: 'response_complete', timestamp: new Date().toISOString() });

    return { response: aldenResponse, toolsUsed, coordinationReadReceipts, continuation: pendingContinuation,
      reviewSourceReferences: reviewReadSession.sourceReferences, reviewSourceEngine: "anthropic" };
  } catch (error: any) {
    console.error('[Alden Chat/Claude] Error:', error.message);
    return {
      response: "Something went wrong on my end. Let me try to recover — ask me again in a moment.",
      toolsUsed,
      reviewSourceReferences: reviewReadSession.sourceReferences, reviewSourceEngine: "anthropic",
    };
  }
}

async function generateAldenResponseGemini(params: AldenChatParams): Promise<AldenChatResponse> {
  const { userMessage, conversationHistory = [], founderName = 'David', timezone, learningContext, conversationId } = params;
  const toolsUsed: string[] = [];
  const coordinationReadReceipts: NonNullable<ReturnType<typeof aldenCoordinationReadReceipt>>[] = [];
  let reviewReadSession = new AldenReviewReadSession();

  try {
    reviewReadSession = new AldenReviewReadSession((params.reviewSourceEngine === "gemini" ? params.reviewSourceReferences : undefined)
      ?? await loadAldenReviewSourceReferences("gemini", conversationId));
    const ai = getGeminiClient();
    const systemPrompt = buildAldenSystemPrompt({ founderName, timezone, engine: 'gemini' });

    // ── Build Gemini-format history ───────────────────────────────────────────
    const history: Array<{ role: string; parts: Array<{ text: string }> }> = [];

    // Workspace context injection (mirrors Daniela's classroom context pattern)
    const workspaceContext = await getWorkspaceContext();
    if (workspaceContext) {
      history.push({
        role: 'user',
        parts: [{ text: `[WORKSPACE CONTEXT — read and internalize before responding]\n\n${workspaceContext}` }],
      });
      history.push({
        role: 'model',
        parts: [{ text: 'Workspace loaded. I have my memory, past session context, and Express Lane activity. Ready.' }],
      });
    }

    // Learning context injection (scene & zone awareness)
    if (learningContext) {
      const parts: string[] = [];
      if (learningContext.currentScene) {
        const s = learningContext.currentScene;
        parts.push(`CURRENT SCENE: ${s.sceneName} (${s.sceneId})\nObjective: ${s.sceneObjective}`);
        if (s.zoneKey) {
          parts.push(`ACTIVE ZONE: ${s.zoneName} [${s.zoneType}]\nKey: ${s.zoneKey}\nNote: Zone type '${s.zoneType}' means ${
            s.zoneType === 'spatial' ? 'focus on prepositions and object placement' :
            s.zoneType === 'interactional' ? 'focus on dialogue sequences and social language functions' :
            s.zoneType === 'departmental' ? 'focus on vocabulary categories and item identification' :
            'focus on directions, navigation, and wayfinding language'
          }`);
        }
      }
      if (learningContext.isOffScene) parts.push('NOTE: Student is exploring outside the main scene objective. Stay flexible and encouraging.');
      if (learningContext.sceneTransitionPending) parts.push('NOTE: Scene transition pending — help wrap up current context gracefully.');
      if (parts.length > 0) {
        history.push({ role: 'user', parts: [{ text: '[LEARNING CONTEXT]\n\n' + parts.join('\n\n') }] });
        history.push({ role: 'model', parts: [{ text: 'Learning context received. I understand the current scene and zone and will tailor my teaching accordingly.' }] });
      }
    }

    // Conversation history (cap at 12 turns, 2 KB per message)
    const MAX_HISTORY_MSG_CHARS = 2_000;
    for (const msg of conversationHistory.slice(-12)) {
      const raw = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const content = raw.length > MAX_HISTORY_MSG_CHARS
        ? raw.slice(0, MAX_HISTORY_MSG_CHARS) + `\n[… ${raw.length - MAX_HISTORY_MSG_CHARS} chars truncated from history]`
        : raw;
      history.push({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: content }],
      });
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Create Gemini chat session with full history and tool declarations
    const chat = ai.chats.create({
      model: GEMINI_MODEL,
      config: {
        systemInstruction: systemPrompt,
        tools: [{ functionDeclarations: toGeminiFunctions(ALDEN_TOOLS) }],
        temperature: 0.7,
        thinkingConfig: { thinkingBudget: 0 },
      },
      history,
    });

    // Send the actual user message
    let response = await chat.sendMessage({ message: [reviewReadSession.rereadContext, userMessage].filter(Boolean).join("\n\n") });
    let aldenResponse: string | null = null;
    let pendingContinuation: ContinuationInfo | undefined;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // Accumulate token counts from first response
    totalInputTokens += (response as any).usageMetadata?.promptTokenCount ?? 0;
    totalOutputTokens += (response as any).usageMetadata?.candidatesTokenCount ?? 0;

    // ── Agentic tool-use loop ─────────────────────────────────────────────────
    for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
      reviewReadSession.acknowledgeDelivery();
      const functionCalls = response.functionCalls;

      // No more tool calls — extract the text response and exit
      if (!functionCalls || functionCalls.length === 0) {
        aldenResponse = response.text ?? null;
        break;
      }

      console.log(`[Alden Chat] Round ${round + 1}: ${functionCalls.length} tool call(s) — ${functionCalls.map((f: any) => f.name).join(', ')}`);

      // Execute each tool call
      const functionResponses: any[] = [];
      for (const fc of functionCalls) {
        const toolName = fc.name as string;
        const toolArgs = (fc.args as Record<string, any>) || {};

        toolsUsed.push(toolName);
        aldenActivity.push({ type: 'tool_start', name: toolName, timestamp: new Date().toISOString() });

        try {
          const toolResult = await executeAldenTool(toolName, toolArgs, { conversationId, engine: 'gemini', reviewReadSession });
          aldenActivity.push({ type: 'tool_result', name: toolName, success: true, timestamp: new Date().toISOString() });

          const truncatedResult = serializeAldenToolResult(toolName, toolResult.data);
          reviewReadSession.stageDelivery(toolName, truncatedResult);
          const receipt = aldenCoordinationReadReceipt(toolName, toolResult.data, toolArgs);
          if (receipt) coordinationReadReceipts.push(receipt);

          functionResponses.push({
            functionResponse: {
              name: toolName,
              response: { result: truncatedResult },
            },
          });

          if (toolResult.sideEffects?.continuation) {
            pendingContinuation = toolResult.sideEffects.continuation as ContinuationInfo;
          }
        } catch (err: any) {
          console.warn(`[Alden Chat] Tool ${toolName} failed:`, err.message);
          aldenActivity.push({ type: 'tool_result', name: toolName, success: false, error: err.message, timestamp: new Date().toISOString() });
          functionResponses.push({
            functionResponse: {
              name: toolName,
              response: { error: err.message },
            },
          });
        }
      }

      // Send function responses back to Gemini
      response = await chat.sendMessage({ message: functionResponses });
      totalInputTokens += (response as any).usageMetadata?.promptTokenCount ?? 0;
      totalOutputTokens += (response as any).usageMetadata?.candidatesTokenCount ?? 0;

      // If continuation was requested, let Gemini write its phase-completion text and exit
      if (pendingContinuation) {
        aldenResponse = response.text ?? null;
        break;
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Hit the round limit mid-task — request a wrap-up summary
    if (!aldenResponse) {
      console.log(`[Alden Chat] Round limit hit — requesting wrap-up summary`);
      try {
        const wrapUp = await chat.sendMessage({
          message: '[SYSTEM] You have reached the tool-use limit for this turn. Summarise what you have found and discovered so far, and clearly state what you still intend to do next turn.',
        });
        totalInputTokens += (wrapUp as any).usageMetadata?.promptTokenCount ?? 0;
        totalOutputTokens += (wrapUp as any).usageMetadata?.candidatesTokenCount ?? 0;
        aldenResponse = wrapUp.text ?? "I've been researching but ran into my context limit. Ask me again to continue.";
      } catch {
        aldenResponse = "I've been researching but ran into my context limit. Ask me again to continue.";
      }
    }

    const callCostUsd = costTracker.track(GEMINI_MODEL, totalInputTokens, totalOutputTokens, 'alden-chat');
    console.log(`[Alden Chat] Response generated (${aldenResponse.length} chars, ${toolsUsed.length} tools used, ~$${callCostUsd.toFixed(4)} | ${(totalInputTokens/1000).toFixed(0)}k in / ${(totalOutputTokens/1000).toFixed(0)}k out)`);

    aldenActivity.push({ type: 'response_complete', timestamp: new Date().toISOString() });

    if (pendingContinuation) {
      console.log(`[Alden Chat] Continuation queued: "${pendingContinuation.phaseTitle}" → "${pendingContinuation.nextPrompt.substring(0, 60)}..."`);
    }

    reviewReadSession.acknowledgeDelivery();
    return { response: aldenResponse, toolsUsed, coordinationReadReceipts, continuation: pendingContinuation,
      reviewSourceReferences: reviewReadSession.sourceReferences, reviewSourceEngine: "gemini" };
  } catch (error: any) {
    console.error('[Alden Chat] Error:', error.message);
    return {
      response: "Something went wrong on my end. Let me try to recover — ask me again in a moment.",
      toolsUsed,
      reviewSourceReferences: reviewReadSession.sourceReferences, reviewSourceEngine: "gemini",
    };
  }
}

console.log('[Alden Persona Service] Loaded — Alden voice chat ready (Anthropic default / Gemini insider mode)');

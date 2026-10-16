import * as fs from 'fs';
import { writeValidatedSourceFile } from './validated-source-write';
import { type SecurityFinding } from './wren-security-audit-service';
import { callGeminiWithSchema, GEMINI_MODELS } from '../gemini-utils';
import { getSharedDb } from '../db';
import { proposedCodeChanges } from '@shared/schema';

export interface AutoPatchResult {
  finding: SecurityFinding;
  action: 'proposed' | 'dismissed_false_positive' | 'skipped' | 'failed';
  reason: string;
  patchSummary?: string;
  beforeCode?: string;
  afterCode?: string;
  proposedChangeId?: string;
}

interface PatchReview {
  isRealIssue: boolean;
  isPatchable: boolean;
  reason: string;
  originalIntent: string;
  patchedCode?: string;
  lineStart?: number;
  lineEnd?: number;
}

const falsePositiveRegistry = new Map<string, string>();

function makeKey(f: SecurityFinding): string {
  return `${f.filePath}:${f.lineNumber ?? '?'}:${f.category}`;
}

function readFileSafe(filePath: string): string | null {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size > 200_000) return null;
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function readContext(filePath: string, lineNumber: number, pad = 18): string | null {
  const raw = readFileSafe(filePath);
  if (!raw) return null;
  const lines = raw.split('\n');
  const start = Math.max(0, lineNumber - pad - 1);
  const end = Math.min(lines.length, lineNumber + pad);
  return lines
    .slice(start, end)
    .map((l, i) => `${start + i + 1}: ${l}`)
    .join('\n');
}

async function reviewFinding(finding: SecurityFinding): Promise<PatchReview> {
  const contextText = readContext(finding.filePath, finding.lineNumber ?? 1);
  if (!contextText) {
    return { isRealIssue: true, isPatchable: false, reason: 'Could not read source file for review.', originalIntent: 'Unknown — source file could not be read.' };
  }

  const prompt = `You are Wren, a senior security engineer reviewing a static analysis finding for a Node.js/React codebase.

FINDING:
  Category: ${finding.category}
  Severity: ${finding.severity}
  Title: ${finding.title}
  Description: ${finding.description}
  File: ${finding.filePath}
  Line: ${finding.lineNumber}
  Evidence: ${finding.evidence}
  Suggested Action: ${finding.suggestedAction}

CODE CONTEXT (lines around ${finding.lineNumber}):
\`\`\`
${contextText}
\`\`\`

Review this finding in full context. Be rigorous:

1. FALSE POSITIVE criteria — mark isRealIssue=false if:
   - The content is developer-controlled (not user input)
   - The pattern is safe in this specific context (e.g., <style> tags, migration scripts with hardcoded values)
   - The surrounding code already handles the risk adequately
   - The code comments or file structure suggest this was an intentional architectural choice — if the author left evidence of deliberate reasoning (e.g., a comment explaining why, a surrounding guard that handles it, a filename suggesting an internal/admin context), treat that as a signal to investigate rather than auto-patch

2. AUTO-PATCH criteria — mark isPatchable=true ONLY if ALL of these are met:
   - The issue is provably a real security risk
   - The fix is localized (1-5 lines max)
   - No new npm packages/imports needed
   - The fix does not change the function's behavior, only hardens it
   - The fix is clearly safe and reversible
   - You understand WHY the original code was written this way — if the intent is unclear, set isPatchable=false and explain what you'd need to know before patching safely

Before deciding isPatchable, articulate the originalIntent field: your best reading of why this code was written this way. If you cannot state a coherent reason, that itself is a signal not to patch.

3. If isPatchable=true, provide:
   - patchedCode: the exact replacement lines (just the code, no line numbers)
   - lineStart: first line number to replace (1-indexed, from the code context above)
   - lineEnd: last line number to replace (1-indexed)

Be conservative: when in doubt, set isPatchable=false. Only auto-patch when you are certain it is safe.`;

  return await callGeminiWithSchema<PatchReview>(
    GEMINI_MODELS.FLASH,
    [{ role: 'user', content: prompt }],
    {
      type: 'object',
      properties: {
        isRealIssue: {
          type: 'boolean',
          description: 'True if this is a genuine security risk, false if it is a false positive.'
        },
        isPatchable: {
          type: 'boolean',
          description: 'True if this can be safely auto-patched per the strict criteria above.'
        },
        reason: {
          type: 'string',
          description: 'Clear explanation of the assessment (2-4 sentences). Be specific about why.'
        },
        originalIntent: {
          type: 'string',
          description: 'Your reading of why this code was written this way — what problem it was solving or what behavior it was intentionally encoding. If unclear, say so explicitly.'
        },
        patchedCode: {
          type: 'string',
          description: 'If isPatchable: the exact replacement lines of code (no line numbers, just code).'
        },
        lineStart: {
          type: 'number',
          description: 'If isPatchable: first 1-indexed line number to replace.'
        },
        lineEnd: {
          type: 'number',
          description: 'If isPatchable: last 1-indexed line number to replace (inclusive).'
        },
      },
      required: ['isRealIssue', 'isPatchable', 'reason', 'originalIntent'],
    }
  );
}

function applyPatch(
  filePath: string,
  lineStart: number,
  lineEnd: number,
  patchedCode: string
): { success: boolean; beforeCode: string } {
  try {
    const raw = readFileSafe(filePath);
    if (!raw) return { success: false, beforeCode: '' };

    const lines = raw.split('\n');
    const beforeLines = lines.slice(lineStart - 1, lineEnd);
    const beforeCode = beforeLines.join('\n');

    const before = lines.slice(0, lineStart - 1);
    const after = lines.slice(lineEnd);
    const newLines = [...before, ...patchedCode.split('\n'), ...after];

    writeValidatedSourceFile(filePath, newLines.join('\n'), raw);
    console.log(`[WrenAutoPatch] Applied patch to ${filePath}:${lineStart}-${lineEnd}`);
    return { success: true, beforeCode };
  } catch (err: any) {
    console.error(`[WrenAutoPatch] Write failed for ${filePath}:`, err.message);
    return { success: false, beforeCode: '' };
  }
}

export async function processFindings(findings: SecurityFinding[]): Promise<AutoPatchResult[]> {
  const results: AutoPatchResult[] = [];

  for (const finding of findings) {
    const key = makeKey(finding);

    const existingFP = falsePositiveRegistry.get(key);
    if (existingFP) {
      results.push({
        finding,
        action: 'dismissed_false_positive',
        reason: `[Cached] ${existingFP}`,
      });
      continue;
    }

    let review: PatchReview;
    try {
      console.log(`[WrenAutoPatch] Reviewing: ${finding.title} (${finding.filePath}:${finding.lineNumber})`);
      review = await reviewFinding(finding);
    } catch (err: any) {
      console.error(`[WrenAutoPatch] Review failed for ${finding.title}:`, err.message);
      results.push({ finding, action: 'failed', reason: `Gemini review failed: ${err.message}` });
      continue;
    }

    if (!review.isRealIssue) {
      falsePositiveRegistry.set(key, review.reason);
      console.log(`[WrenAutoPatch] Dismissed as false positive: ${finding.title}`);
      results.push({
        finding,
        action: 'dismissed_false_positive',
        reason: review.reason,
      });
    } else if (
      review.isPatchable &&
      review.patchedCode &&
      typeof review.lineStart === 'number' &&
      typeof review.lineEnd === 'number'
    ) {
      const raw = readFileSafe(finding.filePath);
      const lines = raw ? raw.split('\n') : [];
      const beforeCode = lines.slice(review.lineStart - 1, review.lineEnd).join('\n');

      let proposedChangeId: string | undefined;
      try {
        const db = getSharedDb();
        const [inserted] = await db.insert(proposedCodeChanges).values({
          findingTitle: finding.title,
          findingDescription: finding.description,
          findingSeverity: finding.severity,
          findingSource: 'wren_security',
          filePath: finding.filePath,
          lineStart: review.lineStart,
          lineEnd: review.lineEnd,
          beforeCode,
          afterCode: review.patchedCode,
          patchRationale: review.reason,
        }).returning({ id: proposedCodeChanges.id });
        proposedChangeId = inserted?.id;
        console.log(`[WrenAutoPatch] Proposed fix for "${finding.title}" → awaiting Alden review (id: ${proposedChangeId})`);
      } catch (err: any) {
        console.error(`[WrenAutoPatch] Failed to store proposal for "${finding.title}":`, err.message);
      }

      results.push({
        finding,
        action: 'proposed',
        reason: review.reason,
        patchSummary: `Lines ${review.lineStart}-${review.lineEnd} in ${finding.filePath}`,
        beforeCode,
        afterCode: review.patchedCode,
        proposedChangeId,
      });
    } else {
      console.log(`[WrenAutoPatch] Skipped (needs discussion): ${finding.title}`);
      results.push({ finding, action: 'skipped', reason: review.reason });
    }
  }

  return results;
}

export function formatAutoPatchReport(results: AutoPatchResult[], auditNumber: number): string {
  if (results.length === 0) {
    return `**Wren Auto-Patch Review — Audit #${auditNumber}**\n\nNo findings to review.\n\n*Wren Security Officer*`;
  }

  const proposed = results.filter(r => r.action === 'proposed');
  const dismissed = results.filter(r => r.action === 'dismissed_false_positive');
  const skipped = results.filter(r => r.action === 'skipped');
  const failed = results.filter(r => r.action === 'failed');

  const lines: string[] = [
    `**Wren Security Review — Audit #${auditNumber}**`,
    ``,
    `Reviewed ${results.length} finding(s): ${proposed.length} proposed for Alden review · ${dismissed.length} false positives · ${skipped.length} escalated · ${failed.length} errors`,
    ``,
  ];

  for (const r of proposed) {
    lines.push(`📋 **PROPOSED** (awaiting Alden review) — ${r.finding.title}`);
    lines.push(`File: \`${r.finding.filePath}:${r.finding.lineNumber}\``);
    lines.push(r.reason);
    if (r.patchSummary) lines.push(`Proposed change: ${r.patchSummary}`);
    if (r.beforeCode) lines.push(`\`\`\`\nBefore:\n${r.beforeCode}\nAfter:\n${r.afterCode}\n\`\`\``);
    lines.push('');
  }

  for (const r of dismissed) {
    lines.push(`✓ **FALSE POSITIVE** — ${r.finding.title}`);
    lines.push(`File: \`${r.finding.filePath}:${r.finding.lineNumber}\``);
    lines.push(r.reason);
    lines.push('');
  }

  for (const r of skipped) {
    lines.push(`📋 **ESCALATED** (needs discussion) — ${r.finding.title}`);
    lines.push(`File: \`${r.finding.filePath}:${r.finding.lineNumber}\``);
    lines.push(r.reason);
    lines.push('');
  }

  for (const r of failed) {
    lines.push(`✗ **FAILED** — ${r.finding.title}`);
    lines.push(r.reason);
    lines.push('');
  }

  lines.push(`*Wren Auto-Patch — ${new Date().toISOString()}*`);
  return lines.join('\n');
}

export function isFalsePositiveKnown(finding: SecurityFinding): boolean {
  return falsePositiveRegistry.has(makeKey(finding));
}

export function getFalsePositiveCount(): number {
  return falsePositiveRegistry.size;
}

#!/usr/bin/env node
// Run one stage of a Gemini consult and keep the record (consult-gemini skill).
//
//   node .agents/skills/consult-gemini/consult.mjs --dir <consult-dir> --stage <n> --prompt-file <file>
//        [--model gemini-3-flash-preview] [--max-tokens 6000] [--dry-run]
//
// Each stage n writes, in <consult-dir>, and never overwrites any of them:
//   stage-<n>-request.md         the exact prompt text for this stage
//   stage-<n>-request.json       the exact request: model, generationConfig and the full
//                                contents history (every earlier stage's request and
//                                response, then this prompt). No key, no headers.
//   stage-<n>-attempt-<k>.json   one file per send attempt: when, and how it ended
//   stage-<n>-response.md        Gemini's verbatim answer text
// The history for stage n is rebuilt from the stage-1..n-1 files, so stage 2 sees
// stage 1's exact exchange and stage 1's record stays as it was.
//
// One run owns a stage at a time (stage-<n>.lock, created exclusively). A stage whose
// send failed may be retried, but only with a byte-identical request.json: a changed
// prompt, model, setting or history is a new stage, not a retry. Every file is created
// exclusively, so no run can replace another's record. If a run is killed, its lock
// stays and the stage refuses to run until a person checks the attempt files and
// removes the lock.
//
// The API key is read from GEMINI_API_KEY, sent only in the x-goog-api-key header,
// and never written to disk. --dry-run records the request and a response marked
// DRY RUN without any network call.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const dir = opt('dir');
const stage = Number(opt('stage'));
const promptFile = opt('prompt-file');
const model = opt('model', 'gemini-3-flash-preview');
const maxOutputTokens = Number(opt('max-tokens', '6000'));
const dryRun = args.includes('--dry-run');
if (!dir || !Number.isInteger(stage) || stage < 1 || !promptFile) {
  console.error('usage: consult.mjs --dir <consult-dir> --stage <n> --prompt-file <file> [--model m] [--max-tokens n] [--dry-run]');
  process.exit(2);
}

const file = (n, kind) => join(dir, `stage-${n}-${kind}`);
const fail = (message) => { console.error(message); process.exitCode = 1; };
// Create-only write: throws EEXIST instead of replacing an existing record.
const create = (path, data) => writeFileSync(path, data, { flag: 'wx' });
mkdirSync(dir, { recursive: true });

const lockPath = join(dir, `stage-${stage}.lock`);
let lock;
try {
  lock = openSync(lockPath, 'wx');
} catch (e) {
  if (e.code !== 'EEXIST') throw e;
  console.error(`stage ${stage} is locked (${lockPath}): another run owns it, or a run was killed; check its attempt files before removing the lock`);
  process.exit(1);
}
try {
  await runStage();
} finally {
  closeSync(lock);
  unlinkSync(lockPath);
}

async function runStage() {
  if (existsSync(file(stage, 'response.md'))) {
    return fail(`refusing to overwrite ${file(stage, 'response.md')}: each stage is recorded once; start a new stage or a new consult dir`);
  }
  const contents = [];
  for (let n = 1; n < stage; n++) {
    if (!existsSync(file(n, 'request.md')) || !existsSync(file(n, 'response.md'))) {
      return fail(`stage ${n} is not complete in ${dir}; run the stages in order`);
    }
    contents.push({ role: 'user', parts: [{ text: readFileSync(file(n, 'request.md'), 'utf8') }] });
    contents.push({ role: 'model', parts: [{ text: readFileSync(file(n, 'response.md'), 'utf8') }] });
  }
  const prompt = readFileSync(promptFile, 'utf8');
  contents.push({ role: 'user', parts: [{ text: prompt }] });
  const request = { contents, generationConfig: { temperature: 0.3, maxOutputTokens } };
  const requestJson = JSON.stringify({ model, ...request }, null, 2) + '\n';

  // The request is on disk before anything is sent. A retry must resend it unchanged.
  if (existsSync(file(stage, 'request.json'))) {
    if (readFileSync(file(stage, 'request.json'), 'utf8') !== requestJson) {
      return fail(`stage ${stage} already recorded a different request (prompt, model, settings or history); a changed request is a new stage`);
    }
  } else {
    create(file(stage, 'request.md'), prompt);
    create(file(stage, 'request.json'), requestJson);
  }
  let attempt = 1;
  while (existsSync(file(stage, `attempt-${attempt}.json`))) attempt++;
  const attemptPath = file(stage, `attempt-${attempt}.json`);
  const startedAt = new Date().toISOString();
  create(attemptPath, JSON.stringify({ attempt, startedAt, dryRun, outcome: 'sending' }, null, 2) + '\n');
  // The attempt file is rewritten only by the run that created it, under the lock.
  const settle = (outcome) => writeFileSync(attemptPath, JSON.stringify({ attempt, startedAt, dryRun, endedAt: new Date().toISOString(), ...outcome }, null, 2) + '\n');

  if (dryRun) {
    create(file(stage, 'response.md'), `DRY RUN: no request was sent (stage ${stage}, ${model}).\n`);
    settle({ outcome: 'dry-run' });
    console.log(`dry run: recorded stage ${stage} request in ${dir}`);
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { settle({ outcome: 'not-sent', error: 'GEMINI_API_KEY not set' }); return fail('GEMINI_API_KEY not set'); }
  let res, result;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(request),
    });
    result = await res.json().catch(() => ({}));
  } catch (e) {
    settle({ outcome: 'failed', error: String(e?.message ?? e).slice(0, 500) });
    return fail(`send failed: ${e?.message ?? e}`);
  }
  const text = result.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
  if (!res.ok || !text) {
    // No response file: the stage stays incomplete; the request and attempt records show what was tried.
    settle({ outcome: 'failed', httpStatus: res.status, error: JSON.stringify(result).slice(0, 500) });
    return fail(`no answer (HTTP ${res.status}): ${JSON.stringify(result).slice(0, 500)}`);
  }
  create(file(stage, 'response.md'), text);
  settle({ outcome: 'answered', httpStatus: res.status });
  console.log(text);
}

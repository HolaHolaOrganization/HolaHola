#!/usr/bin/env node
// Run one stage of a Gemini consult and keep the record (consult-gemini skill).
//
//   node .agents/skills/consult-gemini/consult.mjs --dir <consult-dir> --stage <n> --prompt-file <file>
//        [--model gemini-3-flash-preview] [--max-tokens 6000] [--dry-run]
//
// Each stage n writes, in <consult-dir>, and never overwrites:
//   stage-<n>-request.md    the exact prompt text for this stage
//   stage-<n>-request.json  the exact request sent: model, generationConfig and the
//                           full contents history (every earlier stage's request and
//                           response, then this prompt). No key, no headers.
//   stage-<n>-response.md   Gemini's verbatim answer text
// The history for stage n is rebuilt from the stage-1..n-1 files, so stage 2 sees
// stage 1's exact exchange and stage 1's record stays as it was.
// The API key is read from GEMINI_API_KEY, sent only in the x-goog-api-key header,
// and never written to disk. --dry-run writes the request files and a response file
// marked DRY RUN without any network call.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
mkdirSync(dir, { recursive: true });
if (existsSync(file(stage, 'response.md'))) {
  console.error(`refusing to overwrite ${file(stage, 'response.md')}: each stage is recorded once; start a new stage or a new consult dir`);
  process.exit(1);
}

const contents = [];
for (let n = 1; n < stage; n++) {
  if (!existsSync(file(n, 'request.md')) || !existsSync(file(n, 'response.md'))) {
    console.error(`stage ${n} is not complete in ${dir}; run the stages in order`);
    process.exit(1);
  }
  contents.push({ role: 'user', parts: [{ text: readFileSync(file(n, 'request.md'), 'utf8') }] });
  contents.push({ role: 'model', parts: [{ text: readFileSync(file(n, 'response.md'), 'utf8') }] });
}
const prompt = readFileSync(promptFile, 'utf8');
// A stage whose call failed (request recorded, no response) may be retried, but only
// with the identical prompt: a reworded retry is a new round, not the same stage.
if (existsSync(file(stage, 'request.md')) && readFileSync(file(stage, 'request.md'), 'utf8') !== prompt) {
  console.error(`stage ${stage} already has a different recorded request; a changed prompt is a new stage`);
  process.exit(1);
}
contents.push({ role: 'user', parts: [{ text: prompt }] });
const request = { contents, generationConfig: { temperature: 0.3, maxOutputTokens } };

// The request is on disk before anything is sent.
writeFileSync(file(stage, 'request.md'), prompt);
writeFileSync(file(stage, 'request.json'), JSON.stringify({ model, ...request }, null, 2) + '\n');

if (dryRun) {
  writeFileSync(file(stage, 'response.md'), `DRY RUN: no request was sent (stage ${stage}, ${model}).\n`);
  console.log(`dry run: recorded stage ${stage} request in ${dir}`);
  process.exit(0);
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY not set'); process.exit(1); }
const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
  body: JSON.stringify(request),
});
const result = await res.json().catch(() => ({}));
const text = result.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
if (!res.ok || !text) {
  // No response file: the stage stays incomplete, and its request record shows what was attempted.
  console.error(`no answer (HTTP ${res.status}): ${JSON.stringify(result).slice(0, 500)}`);
  process.exit(1);
}
writeFileSync(file(stage, 'response.md'), text);
console.log(text);

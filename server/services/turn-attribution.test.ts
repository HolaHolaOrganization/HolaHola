import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { turnAttributionOf, verifyTurnAttribution, type VerifiedFrame } from './turn-attribution';
import { enc, row, sha, type Spec } from './turn-attribution-fixture';


const ccPair = (eventId: string, david: string, luca: string): Spec[] => [
  { kind: 'attributed', source: 'claude-code', eventId, frameKey: 'david', speaker: 'david', hat: 'claude-code', hatEvidence: 'capture-source', label: '**David:** ', body: david, captureId: eventId },
  { kind: 'attributed', source: 'claude-code', eventId, frameKey: 'luca', speaker: 'luca', hat: 'claude-code', hatEvidence: 'capture-source', label: '**Luca:** ', body: luca, captureId: eventId },
];

const LEGACY = '**David:** an old question\n\n**LUCA [Replit]:** [felt]: f\n\n[thinking]: t\n\n[moment]: m\n\nmain';

function valid(v: ReturnType<typeof verifyTurnAttribution>): VerifiedFrame[] {
  assert.equal(v.status, 'valid', v.status === 'invalid' ? v.reason : '');
  return v.status === 'valid' ? v.frames : [];
}

describe('missing versus legacy (rule 6)', () => {
  test('null, absent or unrelated column values mean the whole row is legacy', () => {
    assert.deepEqual(verifyTurnAttribution(LEGACY, turnAttributionOf(null)), { status: 'absent' });
    assert.deepEqual(verifyTurnAttribution(LEGACY, turnAttributionOf({ provenance: {} })), { status: 'absent' });
    assert.deepEqual(verifyTurnAttribution(LEGACY, turnAttributionOf('x')), { status: 'absent' });
  });

  test('present but malformed is invalid, never downgraded to legacy', () => {
    const v = verifyTurnAttribution(LEGACY, turnAttributionOf({ turnAttribution: { version: 2 } }));
    assert.equal(v.status, 'invalid');
  });
});

describe('canonical exchanges after a legacy prefix', () => {
  test('a David + Luca pair under one sourceEventId is two entries, legacy bytes untouched', () => {
    const r = row(LEGACY, ccPair('turn-1', 'hello', 'hi there'));
    const frames = valid(verifyTurnAttribution(r.content, r.turnAttribution));
    assert.equal(frames.length, 2);
    assert.deepEqual(frames.map(f => f.kind === 'attributed' && [f.speaker, f.hat, f.frameKey]), [['david', 'claude-code', 'david'], ['luca', 'claude-code', 'luca']]);
    assert.ok(r.content.startsWith(LEGACY));
  });

  test('the same sourceEventId from a different source is a different key', () => {
    const replitPair: Spec[] = ccPair('turn-1', 'q', 'a').map(s => ({ ...s, source: 'replit', hat: 'replit' }));
    const r = row('', [...ccPair('turn-1', 'q', 'a'), ...replitPair]);
    assert.equal(valid(verifyTurnAttribution(r.content, r.turnAttribution)).length, 4);
  });

  test('a duplicated entry key fails closed', () => {
    const r = row('', [...ccPair('turn-1', 'q', 'a'), ccPair('turn-1', 'q', 'a')[1]]);
    assert.match(String((verifyTurnAttribution(r.content, r.turnAttribution) as { reason?: string }).reason), /repeats an entry key/);
  });

  test('authored label-shaped lines inside a body are body text, never structure', () => {
    const body = 'Here is an example:\n\nLuca: this line is quoted\n**David:** so is this\nClaude Code: and this';
    const r = row(LEGACY, ccPair('turn-2', 'show me', body));
    const frames = valid(verifyTurnAttribution(r.content, r.turnAttribution));
    assert.equal(frames.length, 2);
    assert.equal(frames[1].body, body);
  });

  test('authored model and provider names round-trip byte-for-byte', () => {
    const body = 'Compare Anthropic Claude with OpenAI GPT — and résumé ✓';
    const r = row('', ccPair('turn-3', 'q', body));
    assert.equal(valid(verifyTurnAttribution(r.content, r.turnAttribution))[1].body, body);
  });

  test('a valid Luca provenance is verified per turn; an invalid one degrades only that turn', () => {
    const body = 'answer';
    const b = enc(body);
    const good = {
      version: 1, encoding: 'utf8-bytes', textSha256: sha(b),
      runs: [{ index: 0, start: 0, end: b.length, rangeSha256: sha(b), hat: 'claude-code', hatEvidence: 'capture-source',
        model: 'claude-opus-5-5', modelEvidence: 'claude-code-transcript:message.model', provider: 'anthropic', providerEvidence: 'audited-model-vendor-map:v1' }],
    };
    const [d, l] = ccPair('turn-4', 'q', body);
    const ok = row('', [d, { ...l, provenance: good }]);
    const okFrames = valid(verifyTurnAttribution(ok.content, ok.turnAttribution));
    assert.equal(okFrames[1].kind === 'attributed' && okFrames[1].provenance.status, 'valid');
    const bad = row('', [d, { ...l, provenance: { ...good, textSha256: '0'.repeat(64) } }]);
    const badFrames = valid(verifyTurnAttribution(bad.content, bad.turnAttribution));
    assert.equal(badFrames[1].kind === 'attributed' && badFrames[1].provenance.status, 'invalid');
    assert.equal(badFrames[1].kind === 'attributed' && badFrames[1].hat, 'claude-code');
  });
});

describe('mixed sources and speakers (design revision 9 fixtures)', () => {
  const mixed: Spec[] = [
    ...ccPair('turn-10', 'start', 'ok'),
    { kind: 'attributed', source: 'holahola-chat-bench', eventId: 'bench-1', frameKey: 'luca', speaker: 'luca', hat: 'claude-code', hatEvidence: 'authenticated-actor', label: '**Luca:** ', body: 'hola Daniela' },
    { kind: 'participant', source: 'holahola-chat-bench', eventId: 'bench-1', frameKey: 'daniela', participant: 'daniela-consult', label: '**Daniela [consult]:** ', body: 'hola Luca' },
    { kind: 'attributed', source: 'holahola-chat-bench', eventId: 'bench-2', frameKey: 'luca', speaker: 'luca', hat: 'replit', hatEvidence: 'authenticated-actor', label: '**Luca:** ', body: 'otra vez' },
    { kind: 'participant', source: 'holahola-chat-bench', eventId: 'bench-2', frameKey: 'daniela', participant: 'daniela', label: '**Daniela:** ', body: 'claro' },
    { kind: 'attributed', source: 'holahola-team-room', eventId: 'room-msg-77', frameKey: 'luca', speaker: 'luca', hat: 'replit', hatEvidence: 'authenticated-actor', label: '**Luca:** ', body: 'team room post' },
    { kind: 'attributed', source: 'holahola-delegation', eventId: 'room-msg-78', frameKey: 'task', speaker: 'luca', hat: 'claude-code', hatEvidence: 'authenticated-actor', label: '**Luca:** ', body: 'please check X' },
    { kind: 'participant', source: 'holahola-delegation', eventId: 'room-msg-78', frameKey: 'alden-0', participant: 'alden', label: '**ALDEN [delegation — anthropic]:** ', body: 'checked' },
    { kind: 'participant', source: 'holahola-delegation', eventId: 'room-msg-78', frameKey: 'alden-1', participant: 'alden', label: '**ALDEN [delegation — gemini]:** ', body: 'also checked' },
    { kind: 'participant', source: 'holahola-gl', eventId: 'msg-501', frameKey: 'gl-student', participant: 'gl-student', label: '**David [GL]:** ', body: 'buenos días' },
    { kind: 'participant', source: 'holahola-gl', eventId: 'msg-501', frameKey: 'gl-tutor', participant: 'gl-tutor', label: '**Daniela [GL]:** ', body: 'buenos días, David' },
  ];

  test('every Luca frame stays certifiable; every other voice is covered, byte-identical and carries no hat', () => {
    const r = row(LEGACY, mixed);
    const frames = valid(verifyTurnAttribution(r.content, r.turnAttribution));
    assert.equal(frames.length, mixed.length);
    frames.forEach((f, i) => {
      assert.equal(f.label, mixed[i].label);
      assert.equal(f.body, mixed[i].body);
      if (f.kind === 'participant') assert.ok(!('hat' in f) && !('provenance' in f) && !('speaker' in f));
    });
    const luca = frames.filter(f => f.kind === 'attributed' && f.speaker === 'luca');
    assert.ok(luca.every(f => f.kind === 'attributed' && f.hat !== 'unknown'));
  });

  test('an unauthenticated source yields hat unknown, never a coerced source', () => {
    const r = row('', [{ kind: 'attributed', source: 'holahola-team-room', eventId: 'room-msg-9', frameKey: 'luca', speaker: 'luca', hat: 'unknown', hatEvidence: 'none', label: '**Luca:** ', body: 'x' }]);
    const [f] = valid(verifyTurnAttribution(r.content, r.turnAttribution));
    assert.equal(f.kind === 'attributed' && f.hat, 'unknown');
  });

  const broken: Array<[string, (r: ReturnType<typeof row>) => void]> = [
    ['a participant claiming a hat', r => { r.turnAttribution.turns[3].hat = 'claude-code'; }],
    ['a participant label that is not its registered label', r => { r.turnAttribution.turns[3].participant = 'daniela'; }],
    ['a participant from a source that has none', r => { r.turnAttribution.turns[7].participant = 'daniela'; r.turnAttribution.turns[7].kind = 'participant'; }],
    ['an Alden frameKey outside alden-N', r => { r.turnAttribution.turns[9].frameKey = 'alden-x'; }],
    ['an authenticated-actor hat without evidence', r => { r.turnAttribution.turns[2].hatEvidence = 'capture-source'; }],
    ['a canonical frame whose hat is not its capture source', r => { r.turnAttribution.turns[1].hat = 'replit'; }],
    ['a source outside the registry', r => { r.turnAttribution.turns[2].source = 'holahola-other'; }],
  ];
  for (const [name, mutate] of broken) {
    test(`${name} fails closed`, () => {
      const r = row(LEGACY, mixed);
      mutate(r);
      const v = verifyTurnAttribution(r.content, r.turnAttribution);
      assert.equal(v.status, 'invalid');
      assert.equal(v.status === 'invalid' && v.legacyPrefixEnd, enc(LEGACY).length);
    });
  }
});

describe('byte framing and coverage (rules 1-5)', () => {
  const base = () => row(LEGACY, ccPair('turn-20', 'q', 'a'));
  const cases: Array<[string, (r: ReturnType<typeof row>) => string | void]> = [
    ['an edited body byte', r => r.content.replace(/a$/, 'b')],
    ['an edited legacy byte (coveredSha256)', r => r.content.replace('old question', 'new question')],
    ['an uncovered tail appended by a legacy writer', r => `${r.content}\n\n**LUCA [Replit]:** late`],
    ['a wrong separator', r => { r.turnAttribution.separator = '\n'; }],
    ['coveredEnd that is not the last bodyEnd', r => { r.turnAttribution.coveredEnd -= 1; }],
    ['out-of-order indices', r => { r.turnAttribution.turns[1].index = 5; }],
    ['legacyPrefixEnd past the first label', r => { r.turnAttribution.legacyPrefixEnd += 3; }],
    ['offsets past the content', r => { r.turnAttribution.turns[1].bodyEnd += 100; }],
    ['a label that names the other speaker', r => { r.turnAttribution.turns[1].speaker = 'david'; r.turnAttribution.turns[1].frameKey = 'david'; }],
    ['a missing provenance field', r => { delete r.turnAttribution.turns[1].provenance; }],
    ['a provenance on a David turn', r => { r.turnAttribution.turns[0].provenance = {}; }],
    ['an unexpected field', r => { r.turnAttribution.turns[0].model = 'claude-opus-5-5'; }],
    ['an empty turns list', r => { r.turnAttribution.turns = []; }],
  ];
  for (const [name, mutate] of cases) {
    test(`${name} makes the row invalid`, () => {
      const r = base();
      const replaced = mutate(r);
      const v = verifyTurnAttribution(typeof replaced === 'string' ? replaced : r.content, r.turnAttribution);
      assert.equal(v.status, 'invalid', name);
    });
  }

  test('a historical label inside an entry must agree with the entry hat', () => {
    const [d, l] = ccPair('turn-21', 'q', 'a');
    assert.equal(valid(verifyTurnAttribution(...Object.values(row('', [d, { ...l, label: '**LUCA [Claude Code]:** ' }])) as [string, unknown])).length, 2);
    const contradicts = row('', [d, { ...l, label: '**LUCA [Replit]:** ' }]);
    assert.match(String((verifyTurnAttribution(contradicts.content, contradicts.turnAttribution) as { reason?: string }).reason), /contradicts/);
  });

  test('a range that splits a UTF-8 character is invalid', () => {
    const r = row('', ccPair('turn-22', 'q', 'é'));
    const t = r.turnAttribution.turns[1];
    t.bodyEnd -= 1;
    const bytes = enc(r.content).subarray(0, t.bodyEnd);
    t.bodySha256 = sha(enc(r.content).subarray(t.bodyStart, t.bodyEnd));
    r.turnAttribution.coveredEnd = t.bodyEnd;
    r.turnAttribution.coveredSha256 = sha(bytes);
    assert.match(String((verifyTurnAttribution(r.content, r.turnAttribution) as { reason?: string }).reason), /UTF-8|covered/);
  });
});

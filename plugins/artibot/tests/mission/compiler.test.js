/**
 * lib/mission/compiler.js — verbatim extraction, target derivation, the
 * reduced/full split, and the first eval case of design §3.1.
 *
 * WHAT THESE TESTS CANNOT SEE
 * ---------------------------
 *  - They are hand-written prompts, not usage logs. NL activation accuracy is a
 *    Shadow-stage measurement against what users actually typed; nothing here
 *    is evidence for it. This file is a regression fence.
 *  - The fixture set is tiny (single-digit prompts) against a live prompt
 *    stream of unmeasured size. A pass here says the named behaviours hold, not
 *    that extraction generalizes.
 *  - Goal interpretation is not tested because the compiler does not interpret;
 *    it copies. `lib/intent/interpreter.js` (T-24) owns that and has not landed.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  compileMission,
  deriveRequestedTargets,
  extractExplicitRequests,
  projectCommandActivation,
} from '../../lib/mission/compiler.js';
import {
  checkIntentFidelity,
  validateMissionContract,
} from '../../lib/mission/contract.js';

const SPLIT_PROMPT = 'split 을 업그레이드해줘';

describe('extractExplicitRequests() — verbatim, with spans', () => {
  it('strips the Korean request ending and keeps the rest byte-for-byte', () => {
    const { requests, extraction } = extractExplicitRequests(SPLIT_PROMPT);
    expect(extraction).toBe('matched');
    expect(requests).toHaveLength(1);
    expect(requests[0].text).toBe('split 을 업그레이드');
    expect(SPLIT_PROMPT.slice(requests[0].span.start, requests[0].span.end))
      .toBe(requests[0].text);
  });

  it('prefers the longest matching ending so no dangling 해 is left', () => {
    const { requests } = extractExplicitRequests('split 을 업그레이드해주세요');
    expect(requests[0].text).toBe('split 을 업그레이드');
  });

  it('extracts two requests from two clauses', () => {
    const prompt = 'split 을 업그레이드해줘. 그리고 테스트도 추가해줘';
    const { requests } = extractExplicitRequests(prompt);
    expect(requests.map((r) => r.text)).toEqual([
      'split 을 업그레이드', '테스트도 추가',
    ]);
    for (const r of requests) {
      expect(prompt.slice(r.span.start, r.span.end)).toBe(r.text);
    }
  });

  it('splits a VERB-CONNECTIVE sentence into the same two requests a period would', () => {
    // T-47 finding: only `그리고` was a boundary, so this phrasing yielded ONE
    // request and substantive signal S3 (>= 2) could never fire for it, while the
    // identical sentence written with a period yielded two.
    const joined = '라우팅 테스트를 추가하고 README 의 라우팅 절도 갱신해줘';
    const { requests } = extractExplicitRequests(joined);
    expect(requests.map((r) => r.text)).toEqual([
      '라우팅 테스트를 추가', 'README 의 라우팅 절도 갱신',
    ]);
    // Every fragment is still a verbatim slice of the ORIGINAL prompt.
    for (const r of requests) {
      expect(joined.slice(r.span.start, r.span.end)).toBe(r.text);
    }
    const periods = extractExplicitRequests(
      '라우팅 테스트를 추가해줘. README 의 라우팅 절도 갱신해줘',
    );
    expect(requests.map((r) => r.text)).toEqual(periods.requests.map((r) => r.text));
  });

  it('does NOT split an auxiliary "-하고" that is one verb phrase', () => {
    // "테스트하고 싶어" is a single desiderative phrase, not two requests. The
    // guard is that the text after the connective is not itself request-shaped.
    const prompt = '테스트하고 싶어';
    const { requests, extraction } = extractExplicitRequests(prompt);
    expect(requests).toHaveLength(1);
    expect(requests[0].text).toBe(prompt);
    expect(extraction).toBe('fallback-whole-prompt');
  });

  it('keeps splitting on the standalone 그리고 (regression)', () => {
    const prompt = 'split 을 업그레이드해줘. 그리고 테스트도 추가해줘';
    const { requests } = extractExplicitRequests(prompt);
    expect(requests.map((r) => r.text)).toEqual([
      'split 을 업그레이드', '테스트도 추가',
    ]);
    for (const r of requests) {
      expect(prompt.slice(r.span.start, r.span.end)).toBe(r.text);
    }
  });


  it('handles an English imperative, dropping a leading "please"', () => {
    const prompt = 'Please upgrade the split command';
    const { requests } = extractExplicitRequests(prompt);
    expect(requests[0].text).toBe('upgrade the split command');
    expect(prompt.slice(requests[0].span.start, requests[0].span.end))
      .toBe(requests[0].text);
  });

  it('falls back to the WHOLE prompt rather than losing the user\'s words', () => {
    const prompt = '이게 좀 느린 것 같은데';
    const { requests, extraction } = extractExplicitRequests(prompt);
    expect(extraction).toBe('fallback-whole-prompt');
    expect(requests[0].text).toBe(prompt);
  });

  it('reports empty for an empty prompt instead of inventing an entry', () => {
    const { requests, extraction } = extractExplicitRequests('   ');
    expect(requests).toEqual([]);
    expect(extraction).toBe('empty');
  });

  it('does not cut an ordinary noun that merely ends in 해', () => {
    const { requests } = extractExplicitRequests('이해');
    expect(requests[0].text).toBe('이해');
  });

  it('deduplicates identical clauses', () => {
    const { requests } = extractExplicitRequests('고쳐줘. 고쳐줘');
    expect(requests).toHaveLength(1);
  });
});

describe('deriveRequestedTargets()', () => {
  it('takes the noun in front of the Korean object particle', () => {
    const { requests } = extractExplicitRequests(SPLIT_PROMPT);
    expect(deriveRequestedTargets(requests)).toContain('split');
  });

  it('drops a LEADING imperative verb but keeps the same word as an object', () => {
    // "split" is both an imperative and a real target; an unconditional verb
    // filter would erase the target in the Korean case.
    expect(deriveRequestedTargets([{ text: 'upgrade split' }])).toEqual(['split']);
    expect(deriveRequestedTargets([{ text: 'split 을 업그레이드' }])).toContain('split');
  });

  it('picks up path-like and file-like tokens', () => {
    const targets = deriveRequestedTargets([{ text: 'fix lib/core/config.js' }]);
    expect(targets).toContain('lib/core/config.js');
  });

  it('routes subjects through an injected resolveTarget port', () => {
    const targets = deriveRequestedTargets([{ text: 'upgrade split' }], {
      resolveTarget: (s) => (s === 'split' ? ['plugins/artibot/commands/split.md'] : []),
    });
    expect(targets).toEqual(['plugins/artibot/commands/split.md']);
  });

  it('returns an empty list when there is no subject to point at', () => {
    expect(deriveRequestedTargets([{ text: '고쳐' }])).toEqual([]);
    expect(deriveRequestedTargets(null)).toEqual([]);
  });
});

describe('projectCommandActivation() — derived projection only', () => {
  it('returns undefined when there is nothing to project', () => {
    expect(projectCommandActivation({})).toBeUndefined();
  });

  it('projects planning mode onto plan / ultraplan', () => {
    expect(projectCommandActivation({ planning: { mode: 'ultraplan' } }))
      .toEqual({ plan: false, ultraplan: true });
  });

  it('projects topology mode onto autopilot / autopilot_fast / split', () => {
    expect(projectCommandActivation({ topology: { mode: 'autopilot_fast' } }))
      .toEqual({ autopilot: true, autopilot_fast: true, split: false });
  });

  it('projects review.required', () => {
    expect(projectCommandActivation({ review: { required: true } }))
      .toEqual({ review: true });
  });
});

describe('compileMission() — the §3.1 first eval case', () => {
  const result = compileMission({ prompt: SPLIT_PROMPT });

  it('produces explicit_requests = ["split 을 업그레이드"]', () => {
    expect(result.contract.explicit_requests.map((r) => r.text))
      .toEqual(['split 을 업그레이드']);
  });

  it('puts split in scope.requested_target and validates', () => {
    expect(result.contract.scope.requested_target).toContain('split');
    expect(result.validation.valid).toBe(true);
  });

  it('every span slices back to the original prompt', () => {
    expect(result.spans.ok).toBe(true);
    expect(result.meta.originalRequest).toBe(SPLIT_PROMPT);
  });

  it('passes the Intent Fidelity check', () => {
    expect(result.fidelity.ok).toBe(true);
  });

  it('is INVALID when requested_target is emptied', () => {
    const stripped = { ...result.contract, scope: { requested_target: [] } };
    expect(validateMissionContract(stripped).valid).toBe(false);
  });

  it('RED: swapping the target for a "root cause" breaks fidelity', () => {
    const substituted = {
      ...result.contract,
      scope: { requested_target: ['lib/context/'], upstream: ['lib/context/rehydration.js'] },
    };
    // Structurally fine — which is the point: only the fidelity check catches it.
    expect(validateMissionContract(substituted).valid).toBe(true);
    const fidelity = checkIntentFidelity(substituted);
    expect(fidelity.ok).toBe(false);
    expect(fidelity.unmatched[0].text).toBe('split 을 업그레이드');
  });
});

describe('compileMission() — substantive judgment and ledger event', () => {
  it('a greeting compiles but is DEFERRED, with no mission event', () => {
    const result = compileMission({ prompt: '안녕하세요' });
    expect(result.substantive).toBe(false);
    expect(result.deferred).toBe(true);
    expect(result.signals).toEqual([]);
    expect(result.meta.ledgerEvent).toBe('mission-candidate-deferred');
  });

  it('two requests fire S3 and the event becomes mission.created', () => {
    const result = compileMission({
      prompt: 'split 을 업그레이드해줘. 그리고 테스트도 추가해줘',
    });
    expect(result.signals).toEqual(['S3']);
    expect(result.meta.ledgerEvent).toBe('mission.created');
  });

  it('an explicit /split invocation fires S5 and marks activation suppressed', () => {
    const result = compileMission({ prompt: '/split plan 을 만들어줘' });
    expect(result.signals).toContain('S5');
    expect(result.meta.slashCommand).toBe('split');
    expect(result.meta.activation_suppressed_by).toBe('explicit-command');
  });

  it('leaves activation_suppressed_by null when no command was typed', () => {
    expect(compileMission({ prompt: SPLIT_PROMPT }).meta.activation_suppressed_by)
      .toBeNull();
  });
});

/**
 * NEGATIVE CONTROL for the UserPromptSubmit source guard.
 *
 * 이 describe 가 green 이라는 것은 "컴파일러가 옳게 동작한다"는 뜻이 아니다.
 * **가드가 없으면 호스트 통지문이 그대로 미션으로 컴파일된다는 증명**이다.
 *
 * 실사고(2026-09-04T19:02:21.565Z): 하네스가 보낸 `<task-notification>` 본문
 * 5,047B 가 UserPromptSubmit 으로 흘러 디스패처의 6개 훅을 그대로 태웠고,
 * decisions 스토어에 4줄 + `mission.created` 원장 이벤트를 남겼다. 아래 단언은
 * 그 경로를 바이트 그대로 재현한다 — goal 은 통지문에 인용된 하위 에이전트의
 * 작업 지시에서 뽑혀 나오고, 사용자는 그런 요청을 한 적이 없다.
 *
 * **컴파일러를 고쳐서 이 테스트를 red 로 만들지 마라.** compileMission 은
 * 주어진 텍스트를 해석하지 않고 복사하는 것이 계약이고(파일 상단 주석 참조),
 * 통지문과 사람의 지시를 본문만 보고 구별하는 것은 컴파일러의 책임이 아니다.
 * 차단은 한 층 위 `scripts/hooks/_userprompt-dispatcher.js#classifyPromptSource`
 * 가 한다 — 통지문은 애초에 여기까지 도달하지 않아야 한다. 그 가드의 회귀
 * 테스트는 `tests/hooks/userprompt-dispatcher.test.js` 에 있다.
 *
 * 이 케이스가 언젠가 red 가 된다면 그건 가드의 성공이 아니라 컴파일러 추출
 * 로직이 바뀐 것이다. 그때는 실측값으로 갱신하되, 케이스를 삭제하지 마라.
 */
describe('compileMission() — NEGATIVE CONTROL: host notification body compiles as a mission', () => {
  const FIXTURE_PATH = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', 'fixtures', 'ups-task-notification-2026-09-04.txt',
  );
  const NOTIFICATION_BODY = readFileSync(FIXTURE_PATH, 'utf-8');

  it('fixture is the real 5,047B capture, not a toy string', () => {
    // §9: 실패 영역에 도달하지 못하는 픽스처는 아무것도 증명하지 않는다.
    // 통지문이 미션으로 컴파일되려면 S3(복수 요청)를 켤 만큼의 본문이 필요하다.
    expect(Buffer.byteLength(NOTIFICATION_BODY, 'utf-8')).toBeGreaterThanOrEqual(4096);
    expect(Buffer.byteLength(NOTIFICATION_BODY, 'utf-8')).toBe(5047);
    expect(NOTIFICATION_BODY.startsWith('<task-notification>')).toBe(true);
  });

  it('fixture keeps LF endings (proves the .gitattributes -text rule held)', () => {
    // core.autocrlf=true 인 Windows 체크아웃에서 규칙이 빠지면 59개 LF 가 CRLF 로
    // 바뀌어 5,106B 가 되고 위 바이트 단언과 추출 span 이 전부 어긋난다.
    // 이 케이스가 실패하면 코드가 아니라 `.gitattributes` 를 봐라.
    expect(NOTIFICATION_BODY).not.toContain('\r');
  });

  it('compiles the notification into a substantive mission with signals S3', () => {
    const result = compileMission({ prompt: NOTIFICATION_BODY });
    expect(result.substantive).toBe(true);
    expect(result.deferred).toBe(false);
    expect(result.signals).toContain('S3');
  });

  it('emits the mission.created ledger event — the store pollution in the incident', () => {
    const result = compileMission({ prompt: NOTIFICATION_BODY });
    expect(result.meta.ledgerEvent).toBe('mission.created');
  });

  it('lifts a goal out of the quoted sub-agent instructions the user never wrote', () => {
    const result = compileMission({ prompt: NOTIFICATION_BODY });
    expect(result.contract.goal).toMatch(/^Check syntactic validity/);
    // 4건 — 실사고 당시 decisions 에 남은 줄 수와 같은 출처다.
    expect(result.contract.explicit_requests).toHaveLength(4);
    // 통지문에는 슬래시 커맨드가 없다. 즉 S3 는 순전히 본문 길이·요청 밀도에서
    // 나온 것이고, 슬래시 커맨드 억제 경로로는 절대 막을 수 없었다.
    expect(result.meta.slashCommand).toBeNull();
  });

  it('compileMission is pure: neither it nor its deps can write a stage or ledger artifact', () => {
    // 가드를 디스패처에 두는 근거의 절반. 컴파일러 자체는 아무것도 쓰지 않으므로
    // 실사고의 파일 오염(decisions 4줄)은 컴파일러가 아니라 그것을 호출한 훅
    // 체인이 만들었다. 고칠 지점이 디스패처인 이유가 이것이다.
    //
    // 런타임 디렉터리 스냅샷 대조가 아니라 정적 검사인 이유: vitest 는 파일을
    // 병렬 워커로 돌리고 다른 스위트가 같은 순간 `runtime/` 에 쓸 수 있다.
    // 그러면 컴파일러와 무관한 이유로 red 가 뜬다(동시 편집 트리 측정 함정).
    const MISSION_LIB = path.join(
      path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'mission',
    );
    // mission-id.js imports lib/intent/interpreter.js, so the closure has to
    // include it or the check is one hop short (judge review W3, 2026-09-04).
    const reached = [
      'compiler.js', 'contract.js', 'problem-boundary.js',
      'blindspot-scanner.js', 'mission-id.js', '../intent/interpreter.js',
    ];
    for (const file of reached) {
      const src = readFileSync(path.join(MISSION_LIB, file), 'utf-8');
      expect(src, `${file} must not reach the filesystem`).not.toMatch(/node:fs|node:child_process/);
      expect(src, `${file} must not write files`).not.toMatch(/writeFileSync|appendFileSync|mkdirSync/);
    }

    // 그리고 같은 입력은 같은 출력을 준다 — 숨은 상태가 없다는 관측 증거.
    expect(compileMission({ prompt: NOTIFICATION_BODY }))
      .toEqual(compileMission({ prompt: NOTIFICATION_BODY }));
  });
});

describe('compileMission() — system1 reduced contract', () => {
  const result = compileMission({
    prompt: SPLIT_PROMPT,
    system: 'system1',
    intentConfidence: { goal: 0.9, product_decision_required: false },
  });

  it('carries only goal, explicit_requests and intent_confidence', () => {
    expect(Object.keys(result.contract).sort())
      .toEqual(['explicit_requests', 'goal', 'intent_confidence']);
    expect(result.mode).toBe('reduced');
  });

  it('validates in reduced mode and FAILS in full mode', () => {
    expect(result.validation.valid).toBe(true);
    expect(validateMissionContract(result.contract, { mode: 'full' }).valid).toBe(false);
  });

  it('does not run the boundary or blindspot passes', () => {
    expect(result.meta.boundary).toBeNull();
    expect(result.meta.blindspots).toBeNull();
    expect(result.fidelity).toBeNull();
  });

  it('still compiles for system1 — the agentTeam condition is NOT inherited', () => {
    // design §3.5: gating compilation on mode==='agentTeam' would erase the
    // Observe denominator for every system1 prompt.
    expect(result.contract.explicit_requests).toHaveLength(1);
    expect(result.spans.ok).toBe(true);
  });
});

describe('compileMission() — full contract assembly', () => {
  it('passes optional sub-objects through and stays schema-valid', () => {
    const result = compileMission({
      prompt: SPLIT_PROMPT,
      schemaVersion: 1,
      missionId: 'M-20260902-001',
      intentRevision: 1,
      status: 'queued',
      constraints: ['no commits'],
      inferredOutcomes: ['faster landing'],
      autonomy: { mode: 'agent_led', human_gates: ['HG-01'] },
      performance: { priority: 'quality', fast_mode: false },
      planning: { mode: 'plan' },
      topology: { mode: 'split' },
      review: { required: true, model: 'fable', status: 'pending' },
      completion: { expected_actions: ['implement', 'test'] },
      intentConfidence: { goal: 0.97, scope: 0.81, product_decision_required: false },
      userDecisions: [{ q: 'a', a: 'b' }],
    });
    expect(result.validation.valid).toBe(true);
    expect(result.validation.errors).toEqual([]);
    expect(result.contract.command_activation)
      .toEqual({
        plan: true, ultraplan: false, autopilot: false, autopilot_fast: false,
        split: true, review: true,
      });
  });

  it('classifies boundary candidates into scope', () => {
    const result = compileMission({
      prompt: SPLIT_PROMPT,
      candidates: [
        { subject: 'lib/core/config.js', relation: 'causes', evidence: ['config.js:3'] },
        { subject: 'lib/tui/theme.js' },
      ],
    });
    expect(result.contract.scope.upstream).toEqual(['lib/core/config.js']);
    expect(result.contract.scope.excluded).toEqual(['lib/tui/theme.js']);
  });

  it('carries blindspot findings and never authorizes a fix', () => {
    const result = compileMission({
      prompt: SPLIT_PROMPT,
      blindspotCandidates: [{
        subject: 'stale JSDoc',
        causal: true,
        small: true,
        reversible: true,
        intentClear: true,
        noNewProductDecision: true,
        verifiable: true,
      }],
    });
    expect(result.contract.findings.bounded_blindspots).toEqual(['stale JSDoc']);
    expect(result.contract.scope.bounded_blindspots).toEqual(['stale JSDoc']);
    expect(result.meta.blindspots.autoFix.allowed).toBe(false);
  });

  it('reports execution_profile as unchecked rather than validating it', () => {
    const result = compileMission({
      prompt: SPLIT_PROMPT,
      executionProfile: { reasoning: 'whatever' },
    });
    expect(result.validation.unchecked.map((u) => u.path)).toContain('execution_profile');
  });

  it('records goalSource when it had to fall back to the request verbatim', () => {
    const fallback = compileMission({ prompt: SPLIT_PROMPT });
    expect(fallback.meta.goalSource).toBe('derived-from-explicit-request');
    expect(fallback.contract.goal).toBe('split 을 업그레이드');

    const supplied = compileMission({ prompt: SPLIT_PROMPT, goal: 'Upgrade the split command' });
    expect(supplied.meta.goalSource).toBe('input');
    expect(supplied.contract.goal).toBe('Upgrade the split command');
  });
});

describe('compileMission() — determinism', () => {
  it('the same input compiles to the same contract', () => {
    const a = compileMission({ prompt: SPLIT_PROMPT, nowMs: 1 });
    const b = compileMission({ prompt: SPLIT_PROMPT, nowMs: 2 });
    expect(JSON.stringify(a.contract)).toBe(JSON.stringify(b.contract));
  });

  it('an unparseable prompt still yields a contract, invalid where it must be', () => {
    const result = compileMission({ prompt: '고쳐줘' });
    expect(result.contract.explicit_requests).toHaveLength(1);
    expect(result.contract.scope.requested_target).toEqual([]);
    expect(result.validation.valid).toBe(false);
    expect(result.validation.errors.some((e) => e.path === 'scope.requested_target'))
      .toBe(true);
  });
});

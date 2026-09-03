/**
 * Cross-check: does `validateMissionContract`'s structural fallback agree with a
 * real draft-07 validator on the actual schema?
 *
 * The fallback exists because `validateMissionContract` must return a verdict
 * with no port injected. A hand-rolled checker that quietly disagrees with the
 * schema is worse than none — it produces confident wrong verdicts — so the
 * agreement is measured here rather than assumed.
 *
 * ajv is a TRANSITIVE dependency (eslint -> ajv; package.json declares no
 * `ajv`, package-lock pins 6.15.0 and the installed tree resolves 6.12.6, both
 * measured 2026-09-03), so an eslint bump can remove the second opinion with
 * nothing else changing. This block therefore FAILS rather than skips when ajv
 * cannot be resolved: a skipped cross-check reports the same green as an
 * agreeing one, and the whole point of this file is that agreement is measured
 * rather than assumed. The fix when the oracle goes missing is to DECLARE ajv
 * as a devDependency — never to restore the skip.
 *
 * WHAT THIS CROSS-CHECK CANNOT SEE
 * -------------------------------
 *  - Only the fixtures written here. Agreement on 30-odd cases is not agreement
 *    on the input space; a construct nobody wrote a fixture for is unmeasured.
 *  - `execution_profile` is DELETED from the schema copy handed to ajv, because
 *    its `$ref` targets T-18's schema and ajv cannot compile an unresolvable
 *    ref. That subtree is therefore outside this comparison entirely — which is
 *    the same limit the fallback itself reports in `unchecked[]`.
 *  - ajv is being used as a second opinion, not as an oracle of the design. Both
 *    validators agreeing on a wrong schema still yields a wrong verdict.
 *  - WHICH ajv enforces this. The version is not pinned by anything in this
 *    repo (see the transitive-dependency note above), so the agreement measured
 *    here is agreement with whatever draft-07 implementation happens to be
 *    installed. A future ajv 8 would read `$defs` and `format` differently.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { compileMission } from '../../lib/mission/compiler.js';
import { validateMissionContract } from '../../lib/mission/contract.js';

let Ajv = null;
try {
  Ajv = (await import('ajv')).default;
} catch {
  Ajv = null;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(await readFile(
  path.resolve(__dirname, '../../schemas/mission-contract.schema.json'),
  'utf8',
));

function base() {
  return {
    goal: 'split 을 업그레이드',
    explicit_requests: [{ text: 'split 을 업그레이드', span: { start: 0, end: 13 } }],
    success: { functional: [], behavioral: [], regression: [], evidence: [] },
    scope: { requested_target: ['split'] },
  };
}

const FIXTURES = [
  ['minimal valid', base()],
  ['empty requested_target', { ...base(), scope: { requested_target: [] } }],
  ['empty explicit_requests', { ...base(), explicit_requests: [] }],
  ['explicit request without span', { ...base(), explicit_requests: [{ text: 'x' }] }],
  ['explicit request empty text', { ...base(), explicit_requests: [{ text: '', span: { start: 0, end: 0 } }] }],
  ['unknown top-level key', { ...base(), surprise: 1 }],
  ['bad status enum', { ...base(), status: 'done' }],
  ['good status enum', { ...base(), status: 'executing' }],
  ['autonomy mode auto (design 03 sample)', { ...base(), autonomy: { mode: 'auto' } }],
  ['autonomy mode agent_led', { ...base(), autonomy: { mode: 'agent_led', human_gates: ['HG-01'] } }],
  ['malformed mission_id', { ...base(), mission_id: 'M-2026-1' }],
  ['four-digit mission_id', { ...base(), mission_id: 'M-20260902-1001' }],
  ['session fallback mission_id', { ...base(), mission_id: 'M-20260902-Styc5j4aa' }],
  ['schema_version 0', { ...base(), schema_version: 0 }],
  ['schema_version 1', { ...base(), schema_version: 1 }],
  ['intent_revision 0', { ...base(), intent_revision: 0 }],
  ['confidence out of range', { ...base(), intent_confidence: { goal: 1.5 } }],
  ['confidence in range', { ...base(), intent_confidence: { goal: 0.9, product_decision_required: true } }],
  ['command_activation ok', { ...base(), command_activation: { plan: true, skills: ['a'] } }],
  ['command_activation wrong type', { ...base(), command_activation: { plan: 'yes' } }],
  ['findings ok', { ...base(), findings: { mission_blockers: ['a'], bounded_blindspots: [], future_opportunities: [] } }],
  ['findings unknown class', { ...base(), findings: { nope: [] } }],
  ['scope unknown key', { ...base(), scope: { requested_target: ['a'], nope: [] } }],
  ['success unknown key', { ...base(), success: { nope: [] } }],
  ['topology ok', { ...base(), topology: { mode: 'split' } }],
  ['topology bad enum', { ...base(), topology: { mode: 'solo2' } }],
  ['review ok', { ...base(), review: { required: true, model: 'fable', status: 'pending' } }],
  ['review wrong type', { ...base(), review: { required: 1 } }],
  ['performance ok', { ...base(), performance: { priority: 'maximum_performance', fast_mode: true } }],
  ['planning bad enum', { ...base(), planning: { mode: 'nope' } }],
  ['completion ok', { ...base(), completion: { expected_actions: ['implement'] } }],
  ['user_decisions array', { ...base(), user_decisions: [{ a: 1 }] }],
  ['constraints non-string item', { ...base(), constraints: [1] }],
  ['inverted span (schema permits)', { ...base(), explicit_requests: [{ text: 'x', span: { start: 9, end: 2 } }] }],
  ['compiled: split prompt', compileMission({ prompt: 'split 을 업그레이드해줘' }).contract],
  ['compiled: unparseable prompt', compileMission({ prompt: '고쳐줘' }).contract],
  ['compiled: two requests', compileMission({ prompt: 'split 을 업그레이드해줘. 그리고 테스트도 추가해줘' }).contract],
];

/**
 * What a reader sees when the schema oracle is gone. Written as guidance, not
 * as a bare failure: the correct response is to DECLARE the dependency, and
 * the wrong one — restoring the skip — is the one that looks easiest at 2am.
 * @type {string}
 */
const AJV_MISSING = [
  'ajv could not be resolved, so agreement between the structural fallback and a real draft-07 validator cannot be enforced and this gate',
  'proves nothing. ajv is only a TRANSITIVE dependency here (eslint -> ajv);',
  "package.json declares no 'ajv'.",
  'FIX: add ajv to devDependencies. Do NOT skip or delete these assertions —',
  'a skipped conformance test reports the same green as a passing one.',
].join(' ');

/**
 * The schema copy ajv actually compiles. execution_profile carries an
 * unresolvable $ref; removing it is what lets ajv compile at all, and it puts
 * that subtree outside this comparison.
 */
function standaloneSchema() {
  const clone = JSON.parse(JSON.stringify(schema));
  delete clone.properties.execution_profile;
  return clone;
}

describe('structural fallback vs ajv on schemas/mission-contract.schema.json', () => {
  // A THROWING STUB when ajv is absent, not null: a null validator turns every
  // assertion below into "ajvValidate is not a function", which buries the real
  // cause. The stub makes each fixture fail with the fix instruction instead.
  const ajvValidate = Ajv === null
    ? () => {
      throw new Error(AJV_MISSING);
    }
    : new Ajv({ allErrors: true }).compile(standaloneSchema());

  it.each(FIXTURES)('agrees on: %s', (_name, contract) => {
    expect(validateMissionContract(contract).valid).toBe(ajvValidate(contract));
  });

  it('covers every fixture (denominator stated, not implied)', () => {
    expect(FIXTURES).toHaveLength(37);
  });
});

describe('cross-check availability', () => {
  it('has a real oracle — present, and able to say NO as well as YES', () => {
    // The previous form here asserted `typeof (...) === 'string'`, which is
    // true whether ajv loaded or not: a gate that could not fail, sitting next
    // to a block that skipped. It now fails, and the compared value carries the
    // fix so the failure diff IS the instruction.
    expect(Ajv === null ? AJV_MISSING : 'oracle present').toBe('oracle present');

    // A second opinion that agrees with everything is not a second opinion.
    // The 37 agreements above are only worth reading if ajv can say NO, so
    // both directions are demanded of it here.
    const validate = new Ajv({ allErrors: true }).compile(standaloneSchema());
    expect(validate(base())).toBe(true);
    expect(validate({ ...base(), surprise: 1 })).toBe(false);
  });
});

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BLOCKER_PATTERN,
  MISSION_ID_PATTERN,
  MISSION_STATUSES,
  TASK_STATUSES,
  validateBlockers,
  validateController,
  validateLease,
  validateMission,
  validateMissionId,
  validateSnapshot,
  validateTask,
  validateTaskGraph,
} from '../../lib/project-state/validate.js';

const MID = 'M-20260902-001';
const ref = { path: 'x.md', revision: 1 };
const okMission = () => ({ status: 'executing', intent: { ...ref }, plan: { ...ref } });

const SCHEMA_DIR = path.resolve(fileURLToPath(new URL('../../schemas/', import.meta.url)));

/** Read a dotted path out of a schema file. */
const schemaPattern = (file, dotted) => dotted.split('.').reduce(
  (node, key) => node[key],
  JSON.parse(readFileSync(path.join(SCHEMA_DIR, file), 'utf-8')),
);

/**
 * Every place the mission id regex is written down. `validate.js` holds a
 * COPY of it — the repo ships no JSON-Schema validator (zero runtime
 * dependencies), so the constant is re-stated in JS rather than derived.
 *
 * All four are anchored, not just one. Anchoring a single file would leave a
 * drift in any of the other three invisible, and `MISSION_ID_PATTERN` gates
 * missions AND task graphs AND the ledger join, so a task-graph-only
 * re-spelling is exactly as damaging as a project-state one.
 */
const MISSION_ID_ANCHORS = [
  ['project-state.schema.json', 'properties.active_missions.propertyNames.pattern'],
  ['task-graph.schema.json', 'properties.mission_id.pattern'],
  ['task-graph.schema.json', 'definitions.task.properties.mission_id.pattern'],
  ['ledger-envelope.schema.json', 'properties.mission_id.pattern'],
];

describe('the mission id pattern is a copy, so it is pinned to its sources', () => {
  it.each(MISSION_ID_ANCHORS)(
    'is byte-identical to %s %s',
    (file, dotted) => {
      // Byte comparison, not behavioural. `\d` and `[0-9]` are the same
      // matcher, so a re-spelled copy stays green under every input test while
      // the two files quietly stop being one rule — which is precisely the
      // drift that reached this file once already.
      expect(MISSION_ID_PATTERN.source).toBe(schemaPattern(file, dotted));
    },
  );

  it('pins the canonical spelling itself, so the schemas cannot drift together', () => {
    // Without this, all five could be re-spelled in one commit and every
    // assertion above would still pass.
    expect(MISSION_ID_PATTERN.source).toBe('^M-\\d{8}-(?:\\d{3,}|S[0-9A-Za-z]{8})$');
  });
});

describe('the two vocabularies stay separate', () => {
  it('mission status has the 7 values of v1.1 §16', () => {
    expect([...MISSION_STATUSES]).toEqual([
      'queued', 'planning', 'executing', 'blocked', 'reviewing', 'completed', 'failed',
    ]);
  });

  it('task status has the 8 values of the Task Graph', () => {
    expect([...TASK_STATUSES]).toEqual([
      'queued', 'claimed', 'executing', 'blocked', 'reviewing', 'done', 'failed', 'cancelled',
    ]);
  });

  it('does not accept a task status as a mission status, or the reverse', () => {
    expect(MISSION_STATUSES).not.toContain('claimed');
    expect(MISSION_STATUSES).not.toContain('done');
    expect(TASK_STATUSES).not.toContain('planning');
    expect(TASK_STATUSES).not.toContain('completed');
  });
});

describe('mission ids', () => {
  it.each([
    'M-20260902-001',
    'M-20260902-1234',
    'M-20260902-Sabc12345',
  ])('accepts %s', (id) => {
    expect(validateMissionId(id)).toEqual([]);
  });

  it.each([
    ['a short date', 'M-2026902-001'],
    ['two-digit ordinal', 'M-20260902-01'],
    ['a seven-char session id', 'M-20260902-Sabc1234'],
    ['no prefix', '20260902-001'],
    ['an empty string', ''],
    ['a number', 12],
  ])('rejects %s', (_label, id) => {
    expect(validateMissionId(id)).toHaveLength(1);
  });
});

describe('missions', () => {
  it('accepts a well-formed mission', () => {
    expect(validateMission(okMission(), MID)).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(validateMission('executing', MID)).toEqual([`mission ${MID}: must be an object`]);
    expect(validateMission(null, MID)).toHaveLength(1);
    expect(validateMission([], MID)).toHaveLength(1);
  });

  it('requires intent and plan to be revision refs', () => {
    const errors = validateMission({ status: 'queued' }, MID);
    expect(errors.join(' ')).toMatch(/intent must be a \{path, revision\} object/);
    expect(errors.join(' ')).toMatch(/plan must be a \{path, revision\} object/);
  });

  it('requires a non-empty path and a revision of at least 1', () => {
    const errors = validateMission(
      { status: 'queued', intent: { path: '', revision: 0 }, plan: { ...ref } }, MID,
    );
    expect(errors.join(' ')).toMatch(/intent\.path must be a non-empty string/);
    expect(errors.join(' ')).toMatch(/intent\.revision must be an integer >= 1/);
  });
});

describe('blockers are an allowlist, never a deny-list', () => {
  it.each(['lane:w1', 'gate:3', 'human:approval', 'reconcile:worker-2'])(
    'accepts the design §3.5 prefix in %s', (reason) => {
      expect(BLOCKER_PATTERN.test(reason)).toBe(true);
    },
  );

  it.each([
    ['an unlisted prefix', 'waiting:ci'],
    ['a bare word', 'blocked'],
    ['a prefix with no reason', 'lane:'],
  ])('rejects %s — a prefix invented later must fail closed', (_label, reason) => {
    expect(validateBlockers([reason], 'x')).toHaveLength(1);
  });

  it('treats absent as valid and a non-array as an error', () => {
    expect(validateBlockers(undefined, 'x')).toEqual([]);
    expect(validateBlockers('lane:w1', 'x')).toEqual(['x must be an array']);
  });
});

describe('controller and lease', () => {
  const lease = {
    owner: 's1',
    acquired_at: '2026-09-02T00:00:00.000Z',
    expires_at: '2026-09-02T00:30:00.000Z',
    heartbeat_at: '2026-09-02T00:00:00.000Z',
  };

  it('accepts an absent controller', () => {
    expect(validateController(undefined, MID)).toEqual([]);
  });

  it('accepts a controller with both required fields', () => {
    expect(validateController({ session_id: 's1', lease }, MID)).toEqual([]);
  });

  it('rejects a non-object controller', () => {
    expect(validateController('s1', MID)).toHaveLength(1);
  });

  it('rejects a controller with no session_id', () => {
    expect(validateController({ lease }, MID).join(' ')).toMatch(/session_id is required/);
  });

  it('rejects a lease that is not an object', () => {
    expect(validateLease(null, 'L')).toEqual(['L must be an object']);
  });

  it('rejects a lease with an unparseable instant', () => {
    expect(validateLease({ ...lease, expires_at: 'soon' }, 'L').join(' '))
      .toMatch(/expires_at must be an ISO-8601 instant/);
  });

  it('rejects a lease with no owner', () => {
    expect(validateLease({ ...lease, owner: '' }, 'L').join(' ')).toMatch(/owner is required/);
  });
});

describe('tasks', () => {
  const okTask = (extra) => ({ id: 'T-1', mission_id: MID, status: 'queued', ...extra });

  it('accepts a well-formed task', () => {
    expect(validateTask(okTask(), MID, 0)).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(validateTask(null, MID, 3)).toEqual(['tasks[3]: must be an object']);
  });

  it('rejects an empty id', () => {
    expect(validateTask(okTask({ id: '' }), MID, 0).join(' ')).toMatch(/id must be a non-empty string/);
  });

  it('rejects an owner-requiring status with an empty owner', () => {
    expect(validateTask(okTask({ status: 'claimed', owner: '' }), MID, 0).join(' '))
      .toMatch(/requires a non-empty owner/);
  });

  it('accepts blocked when a blocker is present', () => {
    expect(validateTask(okTask({ status: 'blocked', blockers: ['lane:w'] }), MID, 0)).toEqual([]);
  });
});

describe('task graphs — the invariants draft-07 cannot state', () => {
  const g = (tasks, over) => ({ schema_version: 1, mission_id: MID, tasks, ...over });
  const t = (id, extra) => ({ id, mission_id: MID, status: 'queued', ...extra });

  it('accepts an empty graph', () => {
    expect(validateTaskGraph(g([]), MID)).toEqual([]);
  });

  it('rejects a non-object graph', () => {
    expect(validateTaskGraph(null, MID)).toEqual([`task graph for ${MID}: must be an object`]);
  });

  it('rejects a missing schema_version', () => {
    expect(validateTaskGraph(g([], { schema_version: 0 }), MID).join(' '))
      .toMatch(/schema_version must be an integer >= 1/);
  });

  it('rejects a graph whose mission_id disagrees with its key', () => {
    expect(validateTaskGraph(g([], { mission_id: 'M-20260902-002' }), MID).join(' '))
      .toMatch(/carries mission_id/);
  });

  it('rejects a non-array tasks field and stops there', () => {
    const errors = validateTaskGraph(g('none'), MID);
    expect(errors.join(' ')).toMatch(/tasks must be an array/);
  });

  it('accepts a dependency that names an existing node', () => {
    expect(validateTaskGraph(g([t('T-1'), t('T-2', { dependencies: ['T-1'] })]), MID)).toEqual([]);
  });

  it('rejects a non-array dependencies field', () => {
    expect(validateTaskGraph(g([t('T-1', { dependencies: 'T-2' })]), MID).join(' '))
      .toMatch(/dependencies must be an array/);
  });
});

describe('snapshots', () => {
  const snapshot = (over) => ({
    project: 'artibot',
    state_version: 1,
    active_missions: { [MID]: okMission() },
    task_graphs: { [MID]: { schema_version: 1, mission_id: MID, tasks: [] } },
    ...over,
  });

  it('accepts a coherent snapshot', () => {
    expect(validateSnapshot(snapshot())).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(validateSnapshot([])).toEqual(['snapshot: must be an object']);
  });

  it('rejects an empty project name', () => {
    expect(validateSnapshot(snapshot({ project: '' })).join(' '))
      .toMatch(/project must be a non-empty string/);
  });

  it('rejects a negative state_version', () => {
    expect(validateSnapshot(snapshot({ state_version: -1 })).join(' '))
      .toMatch(/state_version must be an integer >= 0/);
  });

  it('rejects a Task Graph with no matching mission', () => {
    const orphan = snapshot({ active_missions: {} });
    expect(validateSnapshot(orphan).join(' ')).toMatch(/no such mission in active_missions/);
  });

  it('tolerates a snapshot with no missions at all', () => {
    expect(validateSnapshot({ project: 'p', state_version: 0 })).toEqual([]);
  });
});

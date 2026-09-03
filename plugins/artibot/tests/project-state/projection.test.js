import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildProjection,
  composeOwners,
  projectWorkers,
  renderProjection,
} from '../../lib/project-state/projection.js';
import { cleanup, makeStore, MISSION_ID, seed, task } from './helpers.js';

const roots = [];
const store$ = (o) => {
  const made = makeStore(o);
  roots.push(made.projectRoot);
  return made;
};
afterEach(() => { while (roots.length > 0) cleanup(roots.pop()); });

const graph = (tasks) => ({ schema_version: 1, mission_id: MISSION_ID, tasks });

describe('workers[] is a view of the Task Graph', () => {
  it('keys a row by owner when that owner holds exactly one task', () => {
    const rows = projectWorkers(graph([
      task('T-1', { owner: 'routing-worker', status: 'executing' }),
      task('T-2', { owner: 'context-worker', status: 'reviewing' }),
    ]));
    expect(Object.keys(rows)).toEqual(['context-worker', 'routing-worker']);
  });

  it('keys by task id when one owner holds several tasks, keeping the map injective', () => {
    const rows = projectWorkers(graph([
      task('T-1', { owner: 'w', status: 'executing' }),
      task('T-2', { owner: 'w', status: 'reviewing' }),
    ]));
    expect(Object.keys(rows)).toEqual(['T-1', 'T-2']);
    expect(rows['T-1'].status).toBe('executing');
    expect(rows['T-2'].status).toBe('reviewing');
  });

  it('keys an unowned task by its id', () => {
    expect(Object.keys(projectWorkers(graph([task('T-1')])))).toEqual(['T-1']);
  });

  it('never aggregates two tasks into one row', () => {
    const rows = projectWorkers(graph([
      task('T-1', { owner: 'w', status: 'done' }),
      task('T-2', { owner: 'w', status: 'failed' }),
    ]));
    expect(Object.keys(rows)).toHaveLength(2);
  });

  it('projects file_ownership as owns[]', () => {
    const rows = projectWorkers(graph([task('T-1', { file_ownership: ['lib/routing/**'] })]));
    expect(rows['T-1'].owns).toEqual(['lib/routing/**']);
  });

  it('omits owns when file_ownership is absent or empty', () => {
    expect(projectWorkers(graph([task('T-1', { file_ownership: [] })]))['T-1'].owns).toBeUndefined();
  });

  it('emits heartbeat_at: null when the task carries it — the honest current value', () => {
    const rows = projectWorkers(graph([task('T-1', { heartbeat_at: null, heartbeat_source: null })]));
    expect(rows['T-1'].heartbeat_at).toBeNull();
    expect(rows['T-1'].heartbeat_source).toBeNull();
  });

  it('omits heartbeat_at entirely when the task never carried one', () => {
    expect(Object.hasOwn(projectWorkers(graph([task('T-1')]))['T-1'], 'heartbeat_at')).toBe(false);
  });

  it('projects blockers as blocked_by', () => {
    const rows = projectWorkers(graph([
      task('T-1', { status: 'blocked', blockers: ['gate:3'] }),
    ]));
    expect(rows['T-1'].blocked_by).toEqual(['gate:3']);
  });

  it('returns an empty map for a mission with no graph', () => {
    expect(projectWorkers(undefined)).toEqual({});
  });
});

describe('D14 — hand-written fields survive a rebuild', () => {
  it('takes humans from project_meta and agents from the store', () => {
    expect(composeOwners({ agents: ['routing-worker'] }, { humans: ['user-001'] }))
      .toEqual({ humans: ['user-001'], agents: ['routing-worker'] });
  });

  it('lets project_meta humans win over a store copy', () => {
    expect(composeOwners({ humans: ['stale'] }, { humans: ['user-001'] }).humans).toEqual(['user-001']);
  });

  it('falls back to store humans when project_meta holds none', () => {
    expect(composeOwners({ humans: ['user-001'] }, undefined).humans).toEqual(['user-001']);
  });

  it('omits owners entirely when both sides are empty', () => {
    expect(composeOwners({}, {})).toBeUndefined();
  });

  it('composes at projection time, from a real store write', () => {
    const { store } = store$();
    store.updateMission(MISSION_ID, () => ({
      status: 'executing',
      intent: { path: 'i.md', revision: 1 },
      plan: { path: 'p.md', revision: 1 },
      owners: { agents: ['routing-worker'] },
    }), { meta: { owners: { humans: ['user-001'] } }, reason: 'seed' });
    expect(store.getProjection().active_missions[MISSION_ID].owners)
      .toEqual({ humans: ['user-001'], agents: ['routing-worker'] });
  });
});

describe('projection shape', () => {
  it('emits the v1.1 §06 key order', () => {
    const { store } = store$();
    seed(store, [task('T-1', { owner: 'w', status: 'executing' })]);
    const keys = Object.keys(store.getProjection().active_missions[MISSION_ID]);
    expect(keys.slice(0, 6)).toEqual(['title', 'intent', 'plan', 'status', 'workers', 'blocked_by']);
  });

  it('copies updated_at from the snapshot rather than generating one', () => {
    const snapshot = {
      project: 'p', state_version: 1, updated_at: '2026-09-02T00:00:00.000Z',
      active_missions: {}, task_graphs: {},
    };
    expect(buildProjection(snapshot).updated_at).toBe('2026-09-02T00:00:00.000Z');
    expect(renderProjection(snapshot)).toBe(renderProjection(snapshot));
  });

  it('omits updated_at when the store has never been written', () => {
    const out = buildProjection({ project: 'p', state_version: 0, updated_at: null, active_missions: {} });
    expect(Object.hasOwn(out, 'updated_at')).toBe(false);
  });

  it('sorts mission keys so two renders of one store agree', () => {
    const snapshot = {
      project: 'p',
      state_version: 1,
      active_missions: {
        'M-20260902-002': { status: 'queued', intent: { path: 'i', revision: 1 }, plan: { path: 'p', revision: 1 } },
        'M-20260902-001': { status: 'queued', intent: { path: 'i', revision: 1 }, plan: { path: 'p', revision: 1 } },
      },
      task_graphs: {},
    };
    expect(Object.keys(buildProjection(snapshot).active_missions))
      .toEqual(['M-20260902-001', 'M-20260902-002']);
  });

  it('carries an unnamed store field through instead of dropping it', () => {
    const snapshot = {
      project: 'p',
      state_version: 1,
      active_missions: {
        'M-20260902-001': {
          status: 'queued', intent: { path: 'i', revision: 1 }, plan: { path: 'p', revision: 1 },
          execution_profile: { performance: 'maximum' },
        },
      },
      task_graphs: {},
    };
    expect(buildProjection(snapshot).active_missions['M-20260902-001'].execution_profile)
      .toEqual({ performance: 'maximum' });
  });
});

describe('the projection file', () => {
  it('is written to <projectRoot>/.artibot/state.yaml after a commit', () => {
    const { store, projectRoot } = store$();
    seed(store);
    expect(store.paths.projection).toBe(path.join(projectRoot, '.artibot', 'state.yaml'));
    expect(readFileSync(store.paths.projection, 'utf-8')).toBe(store.renderProjection());
  });

  it('re-renders byte-identically from the store', () => {
    const { store } = store$();
    seed(store, [task('T-1', { owner: 'w', status: 'executing', file_ownership: ['lib/**'] })]);
    const onDisk = readFileSync(store.paths.projection, 'utf-8');
    expect(store.renderProjection()).toBe(onDisk);
    store.writeProjection();
    expect(readFileSync(store.paths.projection, 'utf-8')).toBe(onDisk);
  });

  it('can be suppressed, leaving the store the only artefact', () => {
    const { store } = store$({ storeOptions: { renderProjectionFile: false } });
    seed(store);
    expect(() => readFileSync(store.paths.projection, 'utf-8')).toThrow();
    expect(store.getState().state_version).toBe(1);
  });
});


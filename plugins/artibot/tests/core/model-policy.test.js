import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL,
  FABLE_DENYLIST,
  getPolicyModel,
  isFableAllowed,
  isFableGateEnabled,
  isKnownAgent,
  listAgentsByModel,
  loadModelPolicy,
  normalizeAgentType,
  resolveModel,
  resolveModelForPhase,
} from '../../lib/core/model-policy.js';

// Read the real config so expected counts/agents are derived, not hardcoded.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, '..', '..', 'artibot.config.json');
const realConfig = JSON.parse(await readFile(configPath, 'utf8'));
const policy = realConfig.agents.modelPolicy;
// Shipped state (2026-09-02, owner decision "design + review on fable"):
// 2-tier fleet. The high bucket DECLARES model=fable for 21 agents, but only
// the `fable.allowlist` (8 design/review agents) actually resolves to fable;
// every other agent — including the 12 high-bucket implementation agents and
// the denylisted security-reviewer — is demoted to opus by the gate.
// Raw-bucket lookups (getPolicyModel/listAgentsByModel) still report the
// declaration; resolveModel reports the gated reality.
const highAgents = policy.high.agents;
const mediumAgents = policy.medium.agents;
const fableAllowlist = policy.fable.allowlist;
/** Effective tier the shipped config must yield for `agent`. */
const expectedShipped = (agent) =>
  fableAllowlist.includes(agent) && !FABLE_DENYLIST.includes(agent) ? 'fable' : 'opus';

describe('model-policy', () => {
  describe('normalizeAgentType()', () => {
    it('strips artibot: prefix', () => {
      expect(normalizeAgentType('artibot:planner')).toBe('planner');
    });

    it('strips artibot-cowork: prefix', () => {
      expect(normalizeAgentType('artibot-cowork:doc-updater')).toBe(
        'doc-updater',
      );
    });

    it('trims surrounding whitespace', () => {
      expect(normalizeAgentType('  orchestrator  ')).toBe('orchestrator');
    });

    it('returns bare name unchanged', () => {
      expect(normalizeAgentType('architect')).toBe('architect');
    });

    it('returns empty string for non-string input', () => {
      expect(normalizeAgentType(42)).toBe('');
      expect(normalizeAgentType(null)).toBe('');
      expect(normalizeAgentType(undefined)).toBe('');
      expect(normalizeAgentType({})).toBe('');
    });
  });

  describe('getPolicyModel()', () => {
    it('returns fable (raw bucket) for a known high-bucket agent', () => {
      expect(getPolicyModel('orchestrator', realConfig)).toBe('fable');
      expect(getPolicyModel('planner', realConfig)).toBe('fable');
    });

    it('returns the UNGATED bucket even for a denylisted agent', () => {
      // Raw bucket lookup — the denylist demotion happens in resolveModel.
      expect(getPolicyModel('security-reviewer', realConfig)).toBe('fable');
    });

    it('resolves prefixed names the same as bare names', () => {
      expect(getPolicyModel('artibot:planner', realConfig)).toBe('fable');
      expect(getPolicyModel('artibot:planner', realConfig)).toBe(
        getPolicyModel('planner', realConfig),
      );
    });

    it('returns opus for a known medium-bucket agent', () => {
      expect(getPolicyModel('doc-updater', realConfig)).toBe('opus');
      expect(getPolicyModel('seo-specialist', realConfig)).toBe('opus');
    });

    it('returns null for an unknown agent', () => {
      expect(getPolicyModel('totally-unknown-agent', realConfig)).toBeNull();
    });

    it('returns null for empty/non-string input', () => {
      expect(getPolicyModel('', realConfig)).toBeNull();
      expect(getPolicyModel(null, realConfig)).toBeNull();
    });
  });

  describe('loadModelPolicy()', () => {
    it('normalizes the real config policy shape', () => {
      const p = loadModelPolicy(realConfig);
      expect(p.high.model).toBe('fable');
      expect(p.medium.model).toBe('opus');
      expect(p.defaultModel).toBe(DEFAULT_MODEL);
      expect(p.advisorStrategy).toMatchObject({
        enabled: true,
        advisorModel: 'opus',
      });
    });

    it('returns a safe default when policy is missing', () => {
      const p = loadModelPolicy({ agents: {} });
      expect(p.high.agents).toEqual([]);
      expect(p.medium.agents).toEqual([]);
      expect(p.advisorStrategy).toBeNull();
      expect(p.defaultModel).toBe(DEFAULT_MODEL);
    });

    it('returns a safe default for malformed input', () => {
      const p = loadModelPolicy({ agents: { modelPolicy: 'nonsense' } });
      expect(p.high.agents).toEqual([]);
      expect(p.medium.agents).toEqual([]);
    });

    it('does not mutate the source config', () => {
      const snapshot = JSON.stringify(realConfig.agents.modelPolicy);
      loadModelPolicy(realConfig);
      expect(JSON.stringify(realConfig.agents.modelPolicy)).toBe(snapshot);
    });
  });

  describe('resolveModel()', () => {
    it('resolves a bucket agent to its effective (gated) policy model', () => {
      // planner: high bucket + allowlisted → fable.
      expect(resolveModel('planner', {}, realConfig)).toBe('fable');
      // backend-developer: high bucket declares fable, NOT allowlisted → opus.
      expect(resolveModel('backend-developer', {}, realConfig)).toBe('opus');
      // doc-updater: medium bucket → opus.
      expect(resolveModel('doc-updater', {}, realConfig)).toBe('opus');
    });

    it('denylisted security-reviewer resolves to opus, never fable', () => {
      expect(resolveModel('security-reviewer', {}, realConfig)).toBe('opus');
      expect(resolveModel('artibot:security-reviewer', {}, realConfig)).toBe(
        'opus',
      );
    });

    it('falls back to DEFAULT_MODEL for unknown agents', () => {
      expect(resolveModel('nobody-here', {}, realConfig)).toBe(DEFAULT_MODEL);
    });

    it('role review/inspect/crosscheck maps to phaseRoles.review (fable) for an allowlisted agent', () => {
      expect(resolveModel('planner', { role: 'review' }, realConfig)).toBe('fable');
      expect(resolveModel('code-reviewer', { role: 'inspect' }, realConfig)).toBe('fable');
      expect(resolveModel('spec-reviewer', { role: 'crosscheck' }, realConfig)).toBe('fable');
    });

    it('role review still demotes a NON-allowlisted agent to opus (allowlist wins over phase)', () => {
      // backend-developer is in the high bucket but not in fable.allowlist.
      expect(resolveModel('backend-developer', { role: 'review' }, realConfig)).toBe('opus');
      // doc-updater is medium bucket; a fable phase never promotes it.
      expect(resolveModel('doc-updater', { role: 'review' }, realConfig)).toBe('opus');
      // denylist beats both the phase map and the allowlist.
      expect(resolveModel('security-reviewer', { role: 'review' }, realConfig)).toBe('opus');
    });

    it('role implementation/build maps to phaseRoles.build (opus) even for an allowlisted agent', () => {
      expect(resolveModel('planner', { role: 'build' }, realConfig)).toBe('opus');
      expect(resolveModel('doc-updater', { role: 'implementation' }, realConfig)).toBe('opus');
      expect(resolveModel('seo-specialist', { role: 'impl' }, realConfig)).toBe('opus');
    });

    it('unknown role falls through to bucket resolution', () => {
      expect(resolveModel('planner', { role: 'mystery' }, realConfig)).toBe('fable');
      expect(resolveModel('backend-developer', { role: 'mystery' }, realConfig)).toBe('opus');
    });

    it('advisor:true with advisorStrategy.enabled returns advisorModel', () => {
      expect(resolveModel('doc-updater', { advisor: true }, realConfig)).toBe(
        'opus',
      );
    });

    it('advisor:true ignored when advisorStrategy is disabled', () => {
      const disabled = {
        agents: {
          modelPolicy: {
            ...policy,
            advisorStrategy: { ...policy.advisorStrategy, enabled: false },
          },
        },
      };
      // advisor ignored → falls through to bucket (opus for doc-updater)
      expect(resolveModel('doc-updater', { advisor: true }, disabled)).toBe(
        'opus',
      );
    });

    it('handles non-object opts safely', () => {
      expect(resolveModel('planner', null, realConfig)).toBe('fable');
      expect(resolveModel('backend-developer', null, realConfig)).toBe('opus');
    });
  });

  describe('resolveModelForPhase()', () => {
    /** Config with a custom phaseRoles block over the real fable gate. */
    const withPhaseRoles = (phaseRoles, fable = policy.fable) => ({
      agents: { modelPolicy: { ...policy, fable, phaseRoles } },
    });

    it('shipped config: build-side roles map to opus (phaseRoles.build)', () => {
      expect(policy.phaseRoles.build).toBe('opus');
      for (const role of ['implementation', 'build', 'impl']) {
        expect(resolveModelForPhase(role, realConfig)).toBe('opus');
      }
    });

    it('shipped config: review-side roles map to fable (phaseRoles.review, gate on)', () => {
      expect(policy.phaseRoles.review).toBe('fable');
      expect(policy.fable.enabled).toBe(true);
      for (const role of ['review', 'inspect', 'crosscheck']) {
        expect(resolveModelForPhase(role, realConfig)).toBe('fable');
      }
    });

    it('a config WITHOUT phaseRoles keeps the legacy mapping (both sides opus)', () => {
      const mp = { ...policy };
      delete mp.phaseRoles;
      const cfg = { agents: { modelPolicy: mp } };
      for (const role of ['build', 'review', 'inspect']) {
        expect(resolveModelForPhase(role, cfg)).toBe('opus');
      }
    });

    it('phaseRoles.review=fable is demoted to opus when the kill-switch is off', () => {
      const cfg = withPhaseRoles({ build: 'opus', review: 'fable' }, { enabled: false, allowlist: [] });
      expect(resolveModelForPhase('review', cfg)).toBe('opus');
    });

    it('phaseRoles accepts catalog role aliases and ignores unknown values', () => {
      const cfg = withPhaseRoles({ build: 'balanced', review: 'not-a-tier' });
      expect(resolveModelForPhase('build', cfg)).toBe('sonnet');
      // unknown → default for that side (opus)
      expect(resolveModelForPhase('review', cfg)).toBe('opus');
    });

    it('tolerates a malformed phaseRoles block', () => {
      expect(resolveModelForPhase('review', withPhaseRoles('nonsense'))).toBe('opus');
      expect(resolveModelForPhase('review', withPhaseRoles({ review: 42 }))).toBe('opus');
    });

    it('maps unknown role to DEFAULT_MODEL', () => {
      expect(resolveModelForPhase('something-else', realConfig)).toBe(DEFAULT_MODEL);
    });

    it('maps non-string input to DEFAULT_MODEL', () => {
      expect(resolveModelForPhase(null, realConfig)).toBe(DEFAULT_MODEL);
      expect(resolveModelForPhase(99, realConfig)).toBe(DEFAULT_MODEL);
    });

    it('never throws without a config (falls back to the default mapping)', () => {
      expect(() => resolveModelForPhase('review')).not.toThrow();
      expect(resolveModelForPhase('build')).toBe('opus');
    });
  });

  describe('isFableGateEnabled()', () => {
    it('reflects the kill-switch only', () => {
      expect(isFableGateEnabled(realConfig)).toBe(true);
      expect(isFableGateEnabled({ agents: { modelPolicy: { fable: { enabled: false } } } })).toBe(false);
      expect(isFableGateEnabled({ agents: { modelPolicy: {} } })).toBe(false);
      expect(isFableGateEnabled({})).toBe(false);
      expect(isFableGateEnabled(null)).toBe(false);
    });
  });

  describe('listAgentsByModel()', () => {
    it('lists all fable (high-bucket) agents matching config count', () => {
      const list = listAgentsByModel('fable', realConfig);
      expect(list).toHaveLength(highAgents.length);
      expect(list).toContain('orchestrator');
      expect(list).toContain('planner');
    });

    it('lists all opus (medium-bucket) agents matching config count', () => {
      const list = listAgentsByModel('opus', realConfig);
      expect(list).toHaveLength(mediumAgents.length);
      expect(list).toContain('doc-updater');
    });

    it('lists no sonnet agents after the fable migration', () => {
      expect(listAgentsByModel('sonnet', realConfig)).toEqual([]);
    });

    it('returns a copy, not the original array', () => {
      const list = listAgentsByModel('fable', realConfig);
      list.push('mutant');
      expect(listAgentsByModel('fable', realConfig)).not.toContain('mutant');
    });

    it('returns [] for an unknown model', () => {
      expect(listAgentsByModel('haiku', realConfig)).toEqual([]);
    });

    it('returns [] for non-string input', () => {
      expect(listAgentsByModel(null, realConfig)).toEqual([]);
    });
  });

  describe('isKnownAgent()', () => {
    it('is true for a bucket agent', () => {
      expect(isKnownAgent('planner', realConfig)).toBe(true);
      expect(isKnownAgent('artibot:doc-updater', realConfig)).toBe(true);
    });

    it('is false for an unknown agent', () => {
      expect(isKnownAgent('ghost-agent', realConfig)).toBe(false);
    });
  });

  describe('never-throws (no config loaded, bad input)', () => {
    // No config passed and getConfig() would throw — all must degrade safely.
    it('getPolicyModel returns null without crashing', () => {
      expect(getPolicyModel('planner')).toBeNull();
    });

    it('loadModelPolicy returns empty-ish default', () => {
      const p = loadModelPolicy();
      expect(p.high.agents).toEqual([]);
      expect(p.defaultModel).toBe(DEFAULT_MODEL);
    });

    it('resolveModel returns DEFAULT_MODEL', () => {
      expect(resolveModel('planner')).toBe(DEFAULT_MODEL);
    });

    it('handles null/undefined/number agent input', () => {
      expect(getPolicyModel(null, realConfig)).toBeNull();
      expect(getPolicyModel(undefined, realConfig)).toBeNull();
      expect(getPolicyModel(42, realConfig)).toBeNull();
      expect(resolveModel(null, {}, realConfig)).toBe(DEFAULT_MODEL);
      expect(isKnownAgent(42, realConfig)).toBe(false);
    });
  });

  // ---- Fable tier isolation (opt-in routing) ----

  /** Build a config whose modelPolicy carries a custom fable gate block. */
  const withFable = (fable) => ({
    agents: { modelPolicy: { ...policy, fable } },
  });
  /** Same, but with no fable block at all (legacy-shaped config). */
  const withoutFable = () => {
    const mp = { ...policy };
    delete mp.fable;
    return { agents: { modelPolicy: mp } };
  };

  describe('fable gate — backward compatibility (no fable / disabled)', () => {
    it('a config without a fable block demotes every agent to opus (kill-switch)', () => {
      // high bucket declares fable but the gate is absent → demote to opus;
      // medium bucket is opus already. Everything lands on opus.
      const cfg = withoutFable();
      for (const agent of [...highAgents, ...mediumAgents]) {
        expect(resolveModel(agent, {}, cfg)).toBe('opus');
      }
    });

    it('never resolves any policy agent to fable when block is absent', () => {
      const cfg = withoutFable();
      const fableHits = [...highAgents, ...mediumAgents].filter(
        (a) => resolveModel(a, {}, cfg) === 'fable',
      );
      expect(fableHits).toEqual([]);
    });

    it('enabled=false yields zero fable hits even with a populated allowlist (kill-switch)', () => {
      const cfg = withFable({ enabled: false, allowlist: ['architect'] });
      expect(resolveModel('architect', {}, cfg)).toBe('opus');
      const fableHits = [...highAgents, ...mediumAgents].filter(
        (a) => resolveModel(a, {}, cfg) === 'fable',
      );
      expect(fableHits).toEqual([]);
    });
  });

  describe('fable gate — enabled but empty allowlist', () => {
    it('enabled=true + allowlist=[] still produces zero fable hits', () => {
      const cfg = withFable({ enabled: true, allowlist: [] });
      const fableHits = [...highAgents, ...mediumAgents].filter(
        (a) => resolveModel(a, {}, cfg) === 'fable',
      );
      expect(fableHits).toEqual([]);
    });
  });

  describe('fable gate — opt-in allowlist', () => {
    it('allowlist=[architect] routes only architect to fable', () => {
      const cfg = withFable({ enabled: true, allowlist: ['architect'] });
      expect(isFableAllowed('architect', cfg)).toBe(true);
      expect(resolveModel('architect', {}, cfg)).toBe('fable');

      const others = [...highAgents, ...mediumAgents].filter(
        (a) => a !== 'architect',
      );
      for (const agent of others) {
        // non-allowlisted high agents demote to opus; medium is opus anyway.
        expect(resolveModel(agent, {}, cfg)).toBe('opus');
      }
    });

    it('the shipped config routes exactly the 8 allowlisted design/review agents to fable', () => {
      // Guards the owner's 2-tier decision (2026-09-02): design + review on
      // fable, everything else on opus. Changing the allowlist or the gate
      // without re-syncing agent frontmatter must fail here first.
      expect(policy.fable.enabled).toBe(true);
      expect([...fableAllowlist].sort()).toEqual(
        [
          'orchestrator', 'architect', 'planner', 'code-reviewer',
          'spec-reviewer', 'quality-reviewer', 'llm-architect', 'repo-benchmarker',
        ].sort(),
      );
      const fableHits = [...highAgents, ...mediumAgents].filter(
        (a) => resolveModel(a, {}, realConfig) === 'fable',
      );
      expect(fableHits.sort()).toEqual([...fableAllowlist].sort());
      for (const agent of [...highAgents, ...mediumAgents]) {
        expect(resolveModel(agent, {}, realConfig)).toBe(expectedShipped(agent));
      }
    });

    it('a high-bucket agent outside the allowlist is demoted to opus (allowlist wins over bucket)', () => {
      const demoted = highAgents.filter((a) => !fableAllowlist.includes(a));
      expect(demoted.length).toBeGreaterThan(0);
      for (const agent of demoted) {
        expect(getPolicyModel(agent, realConfig)).toBe('fable'); // declaration
        expect(resolveModel(agent, {}, realConfig)).toBe('opus'); // reality
      }
    });

    it('flipping enabled=false demotes every agent to opus (single-tier revert path)', () => {
      const reverted = withFable({ ...policy.fable, enabled: false });
      for (const agent of [...highAgents, ...mediumAgents]) {
        expect(resolveModel(agent, {}, reverted)).toBe('opus');
      }
    });

    it('a prefixed allowlist entry still matches the bare agent name', () => {
      const cfg = withFable({
        enabled: true,
        allowlist: ['artibot:architect'],
      });
      expect(isFableAllowed('architect', cfg)).toBe(true);
    });
  });

  describe('fable gate — security denylist (hard opus pin)', () => {
    it('exports a frozen denylist containing security-reviewer', () => {
      expect(FABLE_DENYLIST).toContain('security-reviewer');
      expect(FABLE_DENYLIST).toContain('artibot:security-reviewer');
      expect(Object.isFrozen(FABLE_DENYLIST)).toBe(true);
    });

    it('denylisted agent is forced to opus even when allowlisted', () => {
      const cfg = withFable({
        enabled: true,
        allowlist: ['security-reviewer', 'architect'],
      });
      expect(isFableAllowed('security-reviewer', cfg)).toBe(false);
      // architect (non-denylisted) still opts in, proving the gate is live.
      expect(isFableAllowed('architect', cfg)).toBe(true);
    });

    it('denylist applies to the prefixed form too', () => {
      const cfg = withFable({
        enabled: true,
        allowlist: ['artibot:security-reviewer'],
      });
      expect(isFableAllowed('artibot:security-reviewer', cfg)).toBe(false);
    });
  });

  describe('role-alias resolution (catalog roles → tier)', () => {
    it("'frontier' resolves to opus", () => {
      expect(resolveModel('frontier', {}, realConfig)).toBe('opus');
    });

    it("'balanced' resolves to sonnet", () => {
      expect(resolveModel('balanced', {}, realConfig)).toBe('sonnet');
    });

    it("'fast' resolves to haiku", () => {
      expect(resolveModel('fast', {}, realConfig)).toBe('haiku');
    });

    it("'deep-async' demotes to opus when fable gate is closed", () => {
      const cfg = withFable({ enabled: false, allowlist: [] });
      expect(resolveModel('deep-async', {}, cfg)).toBe('opus');
      expect(resolveModel('deep-async', { agentType: 'planner' }, cfg)).toBe('opus');
    });

    it("'deep-async' + opts.agentType is gated by the CALLING agent's allowlist/denylist", () => {
      // The alias string is never an allowlist key; the caller is.
      expect(resolveModel('deep-async', { agentType: 'planner' }, realConfig)).toBe('fable');
      expect(resolveModel('deep-async', { agentType: 'artibot:architect' }, realConfig)).toBe('fable');
      expect(resolveModel('deep-async', { agentType: 'backend-developer' }, realConfig)).toBe('opus');
      expect(resolveModel('deep-async', { agentType: 'security-reviewer' }, realConfig)).toBe('opus');
      expect(resolveModel('deep-async', { agentType: 'nobody-here' }, realConfig)).toBe('opus');
    });

    it("'deep-async' WITHOUT opts.agentType consults only the kill-switch (no agent to check)", () => {
      // Documented limitation: allowlist/denylist cannot be applied without an
      // agent identity, so gate ON → fable regardless of allowlist contents.
      expect(resolveModel('deep-async', {}, withFable({ enabled: true, allowlist: [] }))).toBe('fable');
      expect(resolveModel('deep-async', {}, realConfig)).toBe('fable');
      expect(resolveModel('deep-async', {}, withFable({ enabled: false, allowlist: ['planner'] }))).toBe('opus');
    });

    it('alias input wins over opts.role/advisor (documented precedence step 0)', () => {
      const closed = withFable({ enabled: false, allowlist: [] });
      // alias fast path ignores opts.role/advisor entirely — 'deep-async' is a
      // tier-family request, not an agent name.
      expect(resolveModel('deep-async', { role: 'review' }, closed)).toBe('opus');
      expect(resolveModel('frontier', { role: 'review' }, closed)).toBe('opus');
      expect(resolveModel('balanced', { advisor: true }, closed)).toBe('sonnet');
      // role is ignored even when the gate is open: build-side role does not
      // pull a deep-async request down to opus for an allowlisted caller.
      expect(resolveModel('deep-async', { role: 'build', agentType: 'planner' }, realConfig)).toBe('fable');
    });

    it('raw fable tier passes through the same gate as the alias', () => {
      expect(resolveModel('fable', {}, withFable({ enabled: true, allowlist: [] }))).toBe('fable');
      expect(resolveModel('fable', { agentType: 'backend-developer' }, realConfig)).toBe('opus');
      expect(resolveModel('fable', { agentType: 'code-reviewer' }, realConfig)).toBe('fable');
      const closed = withFable({ enabled: false, allowlist: [] });
      expect(resolveModel('fable', {}, closed)).toBe('opus');
    });

    it('opts.agentType is ignored on the agent-name path (first argument wins)', () => {
      expect(resolveModel('backend-developer', { agentType: 'planner' }, realConfig)).toBe('opus');
      expect(resolveModel('planner', { agentType: 'backend-developer' }, realConfig)).toBe('fable');
    });
  });

  describe('fable gate — never throws on bad input', () => {
    it('isFableAllowed tolerates malformed config/agent input', () => {
      expect(isFableAllowed('architect', null)).toBe(false);
      expect(isFableAllowed(42, realConfig)).toBe(false);
      expect(isFableAllowed('architect', { agents: 'nope' })).toBe(false);
      expect(
        isFableAllowed('architect', {
          agents: { modelPolicy: { fable: 'bad' } },
        }),
      ).toBe(false);
      expect(
        isFableAllowed('architect', {
          agents: { modelPolicy: { fable: { enabled: true, allowlist: 'x' } } },
        }),
      ).toBe(false);
    });

    it('resolveModel never throws on role-alias + malformed config', () => {
      expect(() => resolveModel('deep-async', {}, { agents: null })).not.toThrow();
      expect(resolveModel('frontier', null, undefined)).toBe('opus');
    });
  });
});

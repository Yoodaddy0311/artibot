/**
 * Agent Teams Integration Test
 *
 * Validates the full team lifecycle: create → spawn → task → message → shutdown → delete.
 * Uses mock tool interfaces to simulate the Claude Agent Teams API interactions
 * as described in the orchestrator agent definition.
 *
 * Tests the cognitive layer (system2-strategies) team recommendation logic
 * integrated with a simulated team lifecycle manager.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recommendTeam,
  selectTeammates,
  estimateComplexity,
  assessRisks,
  analyzeDependencies,
  estimateStepComplexity,
  TEAM_THRESHOLDS,
} from '../../lib/cognitive/system2-strategies.js';

// ---------------------------------------------------------------------------
// Mock Agent Teams API
// ---------------------------------------------------------------------------

/**
 * Simulates the Agent Teams API lifecycle.
 * Tracks all operations for assertion.
 */
function createMockTeamsAPI() {
  const state = {
    teams: {},
    tasks: {},
    messages: [],
    taskIdCounter: 0,
  };

  return {
    state,

    TeamCreate({ team_name, description }) {
      if (state.teams[team_name]) {
        throw new Error(`Team "${team_name}" already exists`);
      }
      state.teams[team_name] = {
        name: team_name,
        description,
        teammates: [],
        createdAt: Date.now(),
      };
      return { success: true, team_name };
    },

    TeamDelete({ team_name }) {
      if (!state.teams[team_name]) {
        throw new Error(`Team "${team_name}" not found`);
      }
      const team = state.teams[team_name];
      if (team.teammates.some((t) => t.status === 'active')) {
        throw new Error(`Team "${team_name}" has active teammates; shutdown them first`);
      }
      delete state.teams[team_name];
      return { success: true };
    },

    SpawnTeammate({ team_name, agent_type, name }) {
      const team = state.teams[team_name];
      if (!team) {
        throw new Error(`Team "${team_name}" not found`);
      }
      const teammate = { name, agent_type, status: 'active', spawnedAt: Date.now() };
      team.teammates.push(teammate);
      return { success: true, teammate: name };
    },

    TaskCreate({ subject, description, activeForm }) {
      state.taskIdCounter += 1;
      const id = String(state.taskIdCounter);
      state.tasks[id] = {
        id,
        subject,
        description,
        activeForm,
        status: 'pending',
        owner: null,
        blockedBy: [],
        completedAt: null,
      };
      return { id };
    },

    TaskUpdate({ taskId, status, owner, addBlockedBy }) {
      const task = state.tasks[taskId];
      if (!task) {
        throw new Error(`Task "${taskId}" not found`);
      }
      if (status) task.status = status;
      if (owner !== undefined) task.owner = owner;
      if (addBlockedBy) task.blockedBy.push(...addBlockedBy);
      if (status === 'completed') task.completedAt = Date.now();
      return { success: true };
    },

    TaskGet({ taskId }) {
      const task = state.tasks[taskId];
      if (!task) {
        throw new Error(`Task "${taskId}" not found`);
      }
      return { ...task };
    },

    TaskList() {
      return Object.values(state.tasks);
    },

    SendMessage({ type, recipient, content, summary, request_id, approve }) {
      const msg = { type, recipient, content, summary, request_id, approve, sentAt: Date.now() };
      state.messages.push(msg);
      return { success: true };
    },

    ShutdownTeammate({ team_name, teammate_name }) {
      const team = state.teams[team_name];
      if (!team) {
        throw new Error(`Team "${team_name}" not found`);
      }
      const teammate = team.teammates.find((t) => t.name === teammate_name);
      if (!teammate) {
        throw new Error(`Teammate "${teammate_name}" not found in team "${team_name}"`);
      }
      teammate.status = 'shutdown';
      return { success: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: Run a complete orchestration lifecycle
// ---------------------------------------------------------------------------

/**
 * Simulates a full orchestrator lifecycle for a feature implementation.
 * Follows the orchestrator.md playbook: create → spawn → task → message → shutdown → delete.
 */
function runFeatureLifecycle(api, teamName, recommendation) {
  // Phase 1: CREATE team
  api.TeamCreate({ team_name: teamName, description: 'Feature implementation team' });

  // Phase 2: SPAWN teammates based on recommendation
  const spawnedNames = [];
  for (const agentType of recommendation.teammates) {
    const name = `${agentType}-1`;
    api.SpawnTeammate({ team_name: teamName, agent_type: agentType, name });
    spawnedNames.push(name);
  }

  // Phase 3: CREATE and ASSIGN tasks
  const planTask = api.TaskCreate({
    subject: 'Create implementation plan',
    description: 'Analyze requirements and create phased plan',
    activeForm: 'Creating implementation plan',
  });
  api.TaskUpdate({ taskId: planTask.id, owner: spawnedNames[0], status: 'in_progress' });

  const implTask = api.TaskCreate({
    subject: 'Implement feature',
    description: 'Implement the core feature logic',
    activeForm: 'Implementing feature',
  });
  api.TaskUpdate({ taskId: implTask.id, owner: spawnedNames[1] || spawnedNames[0], addBlockedBy: [planTask.id] });

  const testTask = api.TaskCreate({
    subject: 'Write tests',
    description: 'Write unit and integration tests',
    activeForm: 'Writing tests',
  });
  api.TaskUpdate({ taskId: testTask.id, owner: spawnedNames[2] || spawnedNames[0], addBlockedBy: [planTask.id] });

  // Phase 4: Simulate progress - complete planning
  api.TaskUpdate({ taskId: planTask.id, status: 'completed' });
  api.SendMessage({
    type: 'broadcast',
    content: 'Phase 1 (Plan) complete. Moving to implementation.',
    summary: 'Phase 1 complete',
  });

  // Unblock and start implementation
  api.TaskUpdate({ taskId: implTask.id, status: 'in_progress' });
  api.TaskUpdate({ taskId: testTask.id, status: 'in_progress' });

  // DM specific teammate
  api.SendMessage({
    type: 'message',
    recipient: spawnedNames[1] || spawnedNames[0],
    content: 'Plan approved. Proceed with implementation.',
    summary: 'Plan approved',
  });

  // Complete implementation
  api.TaskUpdate({ taskId: implTask.id, status: 'completed' });
  api.TaskUpdate({ taskId: testTask.id, status: 'completed' });

  // Phase 5: SHUTDOWN teammates
  for (const name of spawnedNames) {
    api.SendMessage({
      type: 'shutdown_request',
      recipient: name,
      content: 'All tasks complete. Shutting down.',
      summary: 'Shutdown request',
    });
    api.ShutdownTeammate({ team_name: teamName, teammate_name: name });
  }

  // Phase 6: DELETE team
  api.TeamDelete({ team_name: teamName });

  return { planTask, implTask, testTask, spawnedNames };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Agent Teams Integration - Full Lifecycle', () => {
  /** @type {ReturnType<typeof createMockTeamsAPI>} */
  let api;

  beforeEach(() => {
    api = createMockTeamsAPI();
  });

  describe('Phase 1: Team Creation', () => {
    it('creates a team with name and description', () => {
      const result = api.TeamCreate({ team_name: 'feat-auth', description: 'Auth feature' });
      expect(result.success).toBe(true);
      expect(api.state.teams['feat-auth']).toBeDefined();
      expect(api.state.teams['feat-auth'].description).toBe('Auth feature');
    });

    it('prevents duplicate team creation', () => {
      api.TeamCreate({ team_name: 'feat-auth', description: 'Auth' });
      expect(() => api.TeamCreate({ team_name: 'feat-auth', description: 'Dup' }))
        .toThrow('already exists');
    });

    it('initializes team with empty teammates array', () => {
      api.TeamCreate({ team_name: 'new-team', description: 'New' });
      expect(api.state.teams['new-team'].teammates).toEqual([]);
    });
  });

  describe('Phase 2: Teammate Spawning', () => {
    beforeEach(() => {
      api.TeamCreate({ team_name: 'feat-auth', description: 'Auth' });
    });

    it('spawns a teammate into an existing team', () => {
      const result = api.SpawnTeammate({
        team_name: 'feat-auth',
        agent_type: 'frontend-developer',
        name: 'fe-dev',
      });
      expect(result.success).toBe(true);
      expect(api.state.teams['feat-auth'].teammates).toHaveLength(1);
      expect(api.state.teams['feat-auth'].teammates[0].name).toBe('fe-dev');
      expect(api.state.teams['feat-auth'].teammates[0].status).toBe('active');
    });

    it('spawns multiple teammates in parallel', () => {
      api.SpawnTeammate({ team_name: 'feat-auth', agent_type: 'frontend-developer', name: 'fe-dev' });
      api.SpawnTeammate({ team_name: 'feat-auth', agent_type: 'backend-developer', name: 'be-dev' });
      api.SpawnTeammate({ team_name: 'feat-auth', agent_type: 'tdd-guide', name: 'test-lead' });
      expect(api.state.teams['feat-auth'].teammates).toHaveLength(3);
    });

    it('fails to spawn into non-existent team', () => {
      expect(() => api.SpawnTeammate({
        team_name: 'no-team',
        agent_type: 'frontend-developer',
        name: 'fe-dev',
      })).toThrow('not found');
    });

    it('spawned teammates have correct agent type', () => {
      api.SpawnTeammate({ team_name: 'feat-auth', agent_type: 'architect', name: 'arch-1' });
      expect(api.state.teams['feat-auth'].teammates[0].agent_type).toBe('architect');
    });
  });

  describe('Phase 3: Task Management', () => {
    it('creates a task with auto-incrementing ID', () => {
      const t1 = api.TaskCreate({ subject: 'Task 1', description: 'First', activeForm: 'Working on task 1' });
      const t2 = api.TaskCreate({ subject: 'Task 2', description: 'Second', activeForm: 'Working on task 2' });
      expect(t1.id).toBe('1');
      expect(t2.id).toBe('2');
    });

    it('creates task with pending status and no owner', () => {
      const t = api.TaskCreate({ subject: 'Plan', description: 'Create plan', activeForm: 'Planning' });
      const task = api.TaskGet({ taskId: t.id });
      expect(task.status).toBe('pending');
      expect(task.owner).toBeNull();
    });

    it('assigns owner via TaskUpdate', () => {
      const t = api.TaskCreate({ subject: 'Design', description: 'Design API', activeForm: 'Designing' });
      api.TaskUpdate({ taskId: t.id, owner: 'arch-1' });
      expect(api.TaskGet({ taskId: t.id }).owner).toBe('arch-1');
    });

    it('sets task dependencies via addBlockedBy', () => {
      const t1 = api.TaskCreate({ subject: 'Plan', description: 'Plan', activeForm: 'Planning' });
      const t2 = api.TaskCreate({ subject: 'Implement', description: 'Impl', activeForm: 'Implementing' });
      api.TaskUpdate({ taskId: t2.id, addBlockedBy: [t1.id] });
      expect(api.TaskGet({ taskId: t2.id }).blockedBy).toContain(t1.id);
    });

    it('transitions task through status states: pending -> in_progress -> completed', () => {
      const t = api.TaskCreate({ subject: 'Work', description: 'Do work', activeForm: 'Working' });
      expect(api.TaskGet({ taskId: t.id }).status).toBe('pending');
      api.TaskUpdate({ taskId: t.id, status: 'in_progress' });
      expect(api.TaskGet({ taskId: t.id }).status).toBe('in_progress');
      api.TaskUpdate({ taskId: t.id, status: 'completed' });
      expect(api.TaskGet({ taskId: t.id }).status).toBe('completed');
      expect(api.TaskGet({ taskId: t.id }).completedAt).not.toBeNull();
    });

    it('TaskList returns all created tasks', () => {
      api.TaskCreate({ subject: 'A', description: 'A', activeForm: 'A' });
      api.TaskCreate({ subject: 'B', description: 'B', activeForm: 'B' });
      api.TaskCreate({ subject: 'C', description: 'C', activeForm: 'C' });
      expect(api.TaskList()).toHaveLength(3);
    });

    it('TaskGet throws for non-existent task', () => {
      expect(() => api.TaskGet({ taskId: '999' })).toThrow('not found');
    });

    it('TaskUpdate throws for non-existent task', () => {
      expect(() => api.TaskUpdate({ taskId: '999', status: 'completed' })).toThrow('not found');
    });
  });

  describe('Phase 4: Communication (SendMessage)', () => {
    it('sends a DM message', () => {
      api.SendMessage({
        type: 'message',
        recipient: 'fe-dev',
        content: 'Start working on the login form.',
        summary: 'Start login form',
      });
      expect(api.state.messages).toHaveLength(1);
      expect(api.state.messages[0].type).toBe('message');
      expect(api.state.messages[0].recipient).toBe('fe-dev');
    });

    it('sends a broadcast message', () => {
      api.SendMessage({
        type: 'broadcast',
        content: 'Phase 1 complete.',
        summary: 'Phase 1 done',
      });
      expect(api.state.messages[0].type).toBe('broadcast');
      expect(api.state.messages[0].recipient).toBeUndefined();
    });

    it('sends a shutdown request', () => {
      api.SendMessage({
        type: 'shutdown_request',
        recipient: 'be-dev',
        content: 'All tasks complete.',
        summary: 'Shutdown',
      });
      expect(api.state.messages[0].type).toBe('shutdown_request');
    });

    it('sends a plan approval response (approve)', () => {
      api.SendMessage({
        type: 'plan_approval_response',
        request_id: 'req-123',
        recipient: 'arch-1',
        approve: true,
      });
      expect(api.state.messages[0].approve).toBe(true);
      expect(api.state.messages[0].request_id).toBe('req-123');
    });

    it('sends a plan approval response (reject with feedback)', () => {
      api.SendMessage({
        type: 'plan_approval_response',
        request_id: 'req-456',
        recipient: 'arch-1',
        approve: false,
        content: 'Add rate limiting to the API design',
      });
      expect(api.state.messages[0].approve).toBe(false);
      expect(api.state.messages[0].content).toContain('rate limiting');
    });

    it('records messages in chronological order', () => {
      api.SendMessage({ type: 'message', recipient: 'a', content: 'First', summary: '1' });
      api.SendMessage({ type: 'message', recipient: 'b', content: 'Second', summary: '2' });
      api.SendMessage({ type: 'broadcast', content: 'Third', summary: '3' });
      expect(api.state.messages).toHaveLength(3);
      expect(api.state.messages[0].content).toBe('First');
      expect(api.state.messages[2].content).toBe('Third');
    });
  });

  describe('Phase 5: Teammate Shutdown', () => {
    beforeEach(() => {
      api.TeamCreate({ team_name: 'feat-auth', description: 'Auth' });
      api.SpawnTeammate({ team_name: 'feat-auth', agent_type: 'frontend-developer', name: 'fe-dev' });
    });

    it('shuts down an active teammate', () => {
      api.ShutdownTeammate({ team_name: 'feat-auth', teammate_name: 'fe-dev' });
      expect(api.state.teams['feat-auth'].teammates[0].status).toBe('shutdown');
    });

    it('throws when shutting down non-existent teammate', () => {
      expect(() => api.ShutdownTeammate({ team_name: 'feat-auth', teammate_name: 'ghost' }))
        .toThrow('not found');
    });

    it('throws when team does not exist', () => {
      expect(() => api.ShutdownTeammate({ team_name: 'no-team', teammate_name: 'fe-dev' }))
        .toThrow('not found');
    });
  });

  describe('Phase 6: Team Deletion', () => {
    beforeEach(() => {
      api.TeamCreate({ team_name: 'feat-auth', description: 'Auth' });
    });

    it('deletes a team with no active teammates', () => {
      const result = api.TeamDelete({ team_name: 'feat-auth' });
      expect(result.success).toBe(true);
      expect(api.state.teams['feat-auth']).toBeUndefined();
    });

    it('prevents deletion when active teammates remain', () => {
      api.SpawnTeammate({ team_name: 'feat-auth', agent_type: 'dev', name: 'dev-1' });
      expect(() => api.TeamDelete({ team_name: 'feat-auth' }))
        .toThrow('active teammates');
    });

    it('allows deletion after all teammates are shutdown', () => {
      api.SpawnTeammate({ team_name: 'feat-auth', agent_type: 'dev', name: 'dev-1' });
      api.ShutdownTeammate({ team_name: 'feat-auth', teammate_name: 'dev-1' });
      expect(() => api.TeamDelete({ team_name: 'feat-auth' })).not.toThrow();
    });

    it('throws when deleting non-existent team', () => {
      expect(() => api.TeamDelete({ team_name: 'no-team' })).toThrow('not found');
    });
  });
});

describe('Agent Teams Integration - Cognitive Layer (system2-strategies)', () => {
  describe('Team recommendation triggers lifecycle', () => {
    it('recommends squad for moderate complexity tasks', () => {
      const result = recommendTeam(0.7, { domain: 'frontend' });
      expect(result).not.toBeNull();
      expect(result.recommended).toBe(true);
      expect(result.level).toBe('squad');
      expect(result.teammates).toEqual(['frontend-dev', 'ui-designer', 'qa-tester']);
    });

    it('recommends platoon for high complexity tasks', () => {
      const result = recommendTeam(0.9, { domain: 'backend' });
      expect(result.level).toBe('platoon');
      expect(result.teammates).toContain('architect');
      expect(result.teammates).toContain('tech-lead');
    });

    it('returns null for low complexity tasks (no team needed)', () => {
      const result = recommendTeam(0.3, { domain: 'general' });
      expect(result).toBeNull();
    });

    it('returns null at threshold boundary (below 0.6)', () => {
      const result = recommendTeam(0.59, { domain: 'security' });
      expect(result).toBeNull();
    });

    it('returns squad at exact threshold (0.6)', () => {
      const result = recommendTeam(0.6, { domain: 'general' });
      expect(result).not.toBeNull();
      expect(result.level).toBe('squad');
    });

    it('returns platoon at exact platoon threshold (0.85)', () => {
      const result = recommendTeam(0.85, { domain: 'general' });
      expect(result.level).toBe('platoon');
    });

    it('defaults domain to general when not specified', () => {
      const result = recommendTeam(0.7, {});
      expect(result.domain).toBe('general');
      expect(result.teammates).toEqual(['developer', 'reviewer', 'tester']);
    });

    it('includes complexity and reason in recommendation', () => {
      const result = recommendTeam(0.75, { domain: 'security' });
      expect(result.complexity).toBe(0.75);
      expect(result.reason).toContain('0.75');
      expect(result.reason).toContain(String(TEAM_THRESHOLDS.teamRecommendation));
    });

    it('sets pattern to leader for all recommendations', () => {
      const result = recommendTeam(0.7, { domain: 'frontend' });
      expect(result.pattern).toBe('leader');
    });
  });

  describe('selectTeammates for different domains', () => {
    it('selects frontend team for frontend domain', () => {
      expect(selectTeammates('frontend', 'squad')).toEqual(['frontend-dev', 'ui-designer', 'qa-tester']);
    });

    it('selects backend team for backend domain', () => {
      expect(selectTeammates('backend', 'squad')).toEqual(['backend-dev', 'db-specialist', 'api-designer']);
    });

    it('selects security team for security domain', () => {
      expect(selectTeammates('security', 'squad')).toEqual(['security-analyst', 'penetration-tester', 'compliance-reviewer']);
    });

    it('selects performance team for performance domain', () => {
      expect(selectTeammates('performance', 'squad')).toEqual(['performance-engineer', 'profiler', 'load-tester']);
    });

    it('falls back to general team for unknown domain', () => {
      expect(selectTeammates('unknown-domain', 'squad')).toEqual(['developer', 'reviewer', 'tester']);
    });

    it('adds architect and tech-lead for platoon level', () => {
      const team = selectTeammates('frontend', 'platoon');
      expect(team).toContain('architect');
      expect(team).toContain('tech-lead');
      expect(team).toHaveLength(5);
    });

    it('does not add architect for squad level', () => {
      const team = selectTeammates('frontend', 'squad');
      expect(team).not.toContain('architect');
      expect(team).toHaveLength(3);
    });
  });

  describe('Complexity estimation drives team level', () => {
    it('complex plan with many steps, deps, and risks yields high complexity', () => {
      const steps = Array.from({ length: 10 }, (_, i) => ({
        id: String(i + 1),
        action: i < 5 ? 'Refactor module' : 'Deploy service',
        dependencies: i > 0 ? [String(i)] : [],
        estimatedComplexity: i < 5 ? 'high' : 'high',
        order: i + 1,
      }));

      const deps = analyzeDependencies(steps);
      const risks = assessRisks(steps, { name: 'test' });
      const complexity = estimateComplexity(steps, deps, risks);

      // With 10 steps (stepCount=1.0), 9 deps for 9 gaps (depRatio=1.0),
      // high-risk deploy steps, and all high complexity steps,
      // complexity should exceed team threshold
      expect(complexity).toBeGreaterThan(TEAM_THRESHOLDS.teamRecommendation);
      const rec = recommendTeam(complexity, { domain: 'backend' });
      expect(rec).not.toBeNull();
      expect(rec.recommended).toBe(true);
    });

    it('simple plan with few steps yields low complexity (no team)', () => {
      const steps = [
        { id: '1', action: 'Read config file', dependencies: [], estimatedComplexity: 'low', order: 1 },
        { id: '2', action: 'Check format', dependencies: [], estimatedComplexity: 'low', order: 2 },
      ];

      const deps = analyzeDependencies(steps);
      const risks = assessRisks(steps, { name: 'simple' });
      const complexity = estimateComplexity(steps, deps, risks);

      expect(complexity).toBeLessThan(TEAM_THRESHOLDS.teamRecommendation);
      const rec = recommendTeam(complexity, { domain: 'general' });
      expect(rec).toBeNull();
    });

    it('moderate plan with some high-risk steps yields moderate complexity', () => {
      const steps = [
        { id: '1', action: 'Analyze current architecture', dependencies: [], estimatedComplexity: 'medium', order: 1 },
        { id: '2', action: 'Install new dependencies', dependencies: ['1'], estimatedComplexity: 'medium', order: 2 },
        { id: '3', action: 'Deploy to staging', dependencies: ['2'], estimatedComplexity: 'high', order: 3 },
      ];

      const deps = analyzeDependencies(steps);
      const risks = assessRisks(steps, { name: 'moderate' });
      const complexity = estimateComplexity(steps, deps, risks);

      expect(complexity).toBeGreaterThan(0);
      expect(complexity).toBeLessThan(1);
    });
  });
});

describe('Agent Teams Integration - End-to-End Lifecycle', () => {
  /** @type {ReturnType<typeof createMockTeamsAPI>} */
  let api;

  beforeEach(() => {
    api = createMockTeamsAPI();
  });

  it('runs complete feature implementation lifecycle: create → spawn → task → message → shutdown → delete', () => {
    const recommendation = recommendTeam(0.75, { domain: 'frontend' });
    expect(recommendation).not.toBeNull();

    const { planTask, implTask, testTask, spawnedNames } = runFeatureLifecycle(
      api,
      'feat-login',
      recommendation,
    );

    // Verify team was created and deleted (no longer in state)
    expect(api.state.teams['feat-login']).toBeUndefined();

    // Verify all tasks were completed
    expect(api.state.tasks[planTask.id].status).toBe('completed');
    expect(api.state.tasks[implTask.id].status).toBe('completed');
    expect(api.state.tasks[testTask.id].status).toBe('completed');

    // Verify messages were sent (broadcast + DM + shutdown requests)
    const broadcasts = api.state.messages.filter((m) => m.type === 'broadcast');
    const dms = api.state.messages.filter((m) => m.type === 'message');
    const shutdowns = api.state.messages.filter((m) => m.type === 'shutdown_request');

    expect(broadcasts.length).toBeGreaterThanOrEqual(1);
    expect(dms.length).toBeGreaterThanOrEqual(1);
    expect(shutdowns).toHaveLength(spawnedNames.length);
  });

  it('runs complete lifecycle for platoon-level security audit', () => {
    const recommendation = recommendTeam(0.9, { domain: 'security' });
    expect(recommendation.level).toBe('platoon');
    expect(recommendation.teammates).toHaveLength(5);

    const { spawnedNames } = runFeatureLifecycle(api, 'security-audit', recommendation);

    // 5 teammates spawned (3 security + architect + tech-lead)
    expect(spawnedNames).toHaveLength(5);

    // Team cleaned up
    expect(api.state.teams['security-audit']).toBeUndefined();

    // All shutdown messages sent
    const shutdowns = api.state.messages.filter((m) => m.type === 'shutdown_request');
    expect(shutdowns).toHaveLength(5);
  });

  it('runs complete lifecycle for squad-level backend task', () => {
    const recommendation = recommendTeam(0.7, { domain: 'backend' });
    expect(recommendation.level).toBe('squad');

    runFeatureLifecycle(api, 'feat-api', recommendation);

    // All 3 tasks completed
    const tasks = api.TaskList();
    expect(tasks.every((t) => t.status === 'completed')).toBe(true);

    // Team deleted
    expect(Object.keys(api.state.teams)).toHaveLength(0);
  });

  it('enforces task dependency ordering', () => {
    api.TeamCreate({ team_name: 'ordered', description: 'Dependency test' });
    api.SpawnTeammate({ team_name: 'ordered', agent_type: 'dev', name: 'dev-1' });

    const design = api.TaskCreate({ subject: 'Design', description: 'Design', activeForm: 'Designing' });
    const impl = api.TaskCreate({ subject: 'Implement', description: 'Impl', activeForm: 'Implementing' });
    const review = api.TaskCreate({ subject: 'Review', description: 'Review', activeForm: 'Reviewing' });

    api.TaskUpdate({ taskId: impl.id, addBlockedBy: [design.id] });
    api.TaskUpdate({ taskId: review.id, addBlockedBy: [impl.id] });

    // Verify dependency chain
    expect(api.TaskGet({ taskId: impl.id }).blockedBy).toContain(design.id);
    expect(api.TaskGet({ taskId: review.id }).blockedBy).toContain(impl.id);

    // Complete in order
    api.TaskUpdate({ taskId: design.id, status: 'completed' });
    api.TaskUpdate({ taskId: impl.id, status: 'completed' });
    api.TaskUpdate({ taskId: review.id, status: 'completed' });

    expect(api.TaskGet({ taskId: design.id }).completedAt).not.toBeNull();
    expect(api.TaskGet({ taskId: review.id }).completedAt).not.toBeNull();

    // Cleanup
    api.ShutdownTeammate({ team_name: 'ordered', teammate_name: 'dev-1' });
    api.TeamDelete({ team_name: 'ordered' });
  });

  it('handles plan approval flow (approve)', () => {
    api.TeamCreate({ team_name: 'plan-test', description: 'Plan approval test' });
    api.SpawnTeammate({ team_name: 'plan-test', agent_type: 'architect', name: 'arch-1' });

    const planTask = api.TaskCreate({ subject: 'Design architecture', description: 'Design', activeForm: 'Designing' });
    api.TaskUpdate({ taskId: planTask.id, owner: 'arch-1', status: 'in_progress' });

    // Architect submits plan, orchestrator approves
    api.SendMessage({
      type: 'plan_approval_response',
      request_id: 'plan-req-1',
      recipient: 'arch-1',
      approve: true,
    });

    api.TaskUpdate({ taskId: planTask.id, status: 'completed' });

    const approvalMsg = api.state.messages.find((m) => m.type === 'plan_approval_response');
    expect(approvalMsg.approve).toBe(true);
    expect(approvalMsg.request_id).toBe('plan-req-1');

    // Cleanup
    api.ShutdownTeammate({ team_name: 'plan-test', teammate_name: 'arch-1' });
    api.TeamDelete({ team_name: 'plan-test' });
  });

  it('handles plan approval flow (reject with feedback)', () => {
    api.TeamCreate({ team_name: 'reject-test', description: 'Rejection test' });
    api.SpawnTeammate({ team_name: 'reject-test', agent_type: 'architect', name: 'arch-1' });

    const planTask = api.TaskCreate({ subject: 'Design API', description: 'Design', activeForm: 'Designing' });
    api.TaskUpdate({ taskId: planTask.id, owner: 'arch-1', status: 'in_progress' });

    // Orchestrator rejects plan
    api.SendMessage({
      type: 'plan_approval_response',
      request_id: 'plan-req-2',
      recipient: 'arch-1',
      approve: false,
      content: 'Add rate limiting to the API design',
    });

    const rejectMsg = api.state.messages.find((m) => m.request_id === 'plan-req-2');
    expect(rejectMsg.approve).toBe(false);
    expect(rejectMsg.content).toContain('rate limiting');

    // After revision, approve
    api.SendMessage({
      type: 'plan_approval_response',
      request_id: 'plan-req-3',
      recipient: 'arch-1',
      approve: true,
    });

    api.TaskUpdate({ taskId: planTask.id, status: 'completed' });

    // Cleanup
    api.ShutdownTeammate({ team_name: 'reject-test', teammate_name: 'arch-1' });
    api.TeamDelete({ team_name: 'reject-test' });
  });

  it('supports multiple concurrent teams', () => {
    api.TeamCreate({ team_name: 'team-a', description: 'Team A' });
    api.TeamCreate({ team_name: 'team-b', description: 'Team B' });

    api.SpawnTeammate({ team_name: 'team-a', agent_type: 'dev', name: 'a-dev' });
    api.SpawnTeammate({ team_name: 'team-b', agent_type: 'dev', name: 'b-dev' });

    expect(Object.keys(api.state.teams)).toHaveLength(2);
    expect(api.state.teams['team-a'].teammates).toHaveLength(1);
    expect(api.state.teams['team-b'].teammates).toHaveLength(1);

    // Cleanup both
    api.ShutdownTeammate({ team_name: 'team-a', teammate_name: 'a-dev' });
    api.ShutdownTeammate({ team_name: 'team-b', teammate_name: 'b-dev' });
    api.TeamDelete({ team_name: 'team-a' });
    api.TeamDelete({ team_name: 'team-b' });

    expect(Object.keys(api.state.teams)).toHaveLength(0);
  });

  it('verifies progress monitoring via TaskList during lifecycle', () => {
    api.TeamCreate({ team_name: 'monitor', description: 'Monitor test' });
    api.SpawnTeammate({ team_name: 'monitor', agent_type: 'dev', name: 'dev-1' });

    api.TaskCreate({ subject: 'Task A', description: 'A', activeForm: 'Doing A' });
    api.TaskCreate({ subject: 'Task B', description: 'B', activeForm: 'Doing B' });
    api.TaskCreate({ subject: 'Task C', description: 'C', activeForm: 'Doing C' });

    // All start as pending
    let tasks = api.TaskList();
    expect(tasks.filter((t) => t.status === 'pending')).toHaveLength(3);

    // Start one
    api.TaskUpdate({ taskId: '1', status: 'in_progress' });
    tasks = api.TaskList();
    expect(tasks.filter((t) => t.status === 'in_progress')).toHaveLength(1);
    expect(tasks.filter((t) => t.status === 'pending')).toHaveLength(2);

    // Complete all
    api.TaskUpdate({ taskId: '1', status: 'completed' });
    api.TaskUpdate({ taskId: '2', status: 'completed' });
    api.TaskUpdate({ taskId: '3', status: 'completed' });
    tasks = api.TaskList();
    expect(tasks.filter((t) => t.status === 'completed')).toHaveLength(3);

    // Cleanup
    api.ShutdownTeammate({ team_name: 'monitor', teammate_name: 'dev-1' });
    api.TeamDelete({ team_name: 'monitor' });
  });
});

describe('Agent Teams Integration - Step Complexity to Team Recommendation Pipeline', () => {
  it('high-complexity steps with risks lead to team recommendation', () => {
    // Simulate a complex plan with security-heavy steps
    const steps = [
      { id: '1', action: 'Analyze current security architecture', dependencies: [], order: 1 },
      { id: '2', action: 'Refactor authentication module', dependencies: ['1'], order: 2 },
      { id: '3', action: 'Migrate database schema', dependencies: ['2'], order: 3 },
      { id: '4', action: 'Deploy security patches', dependencies: ['3'], order: 4 },
      { id: '5', action: 'Delete deprecated endpoints', dependencies: ['4'], order: 5 },
    ].map((s) => ({ ...s, estimatedComplexity: estimateStepComplexity(s.action) }));

    // Verify step complexity classification
    expect(steps[1].estimatedComplexity).toBe('high'); // refactor
    expect(steps[2].estimatedComplexity).toBe('high'); // migrate
    expect(steps[4].estimatedComplexity).toBe('medium'); // delete (not in high list, but has risk)

    const deps = analyzeDependencies(steps);
    const risks = assessRisks(steps, { name: 'security-refactor' });
    const complexity = estimateComplexity(steps, deps, risks);

    // Pipeline: complexity -> team recommendation -> lifecycle
    const rec = recommendTeam(complexity, { domain: 'security' });
    expect(rec).not.toBeNull();
    expect(rec.teammates.length).toBeGreaterThanOrEqual(3);
  });

  it('step complexity estimation classifies correctly', () => {
    expect(estimateStepComplexity('Refactor the auth module')).toBe('high');
    expect(estimateStepComplexity('Migrate database')).toBe('high');
    expect(estimateStepComplexity('Optimize query performance')).toBe('high');
    expect(estimateStepComplexity('Security audit')).toBe('high');
    expect(estimateStepComplexity('Redesign the API')).toBe('high');
    expect(estimateStepComplexity('Read configuration')).toBe('low');
    expect(estimateStepComplexity('List all files')).toBe('low');
    expect(estimateStepComplexity('Check status')).toBe('low');
    expect(estimateStepComplexity('Format output')).toBe('low');
    expect(estimateStepComplexity('Lint the code')).toBe('low');
    expect(estimateStepComplexity('Implement feature')).toBe('medium');
    expect(estimateStepComplexity('Create new component')).toBe('medium');
  });

  it('risk assessment identifies destructive, deployment, and dependency risks', () => {
    const steps = [
      { id: '1', action: 'Delete old migration files', dependencies: [], estimatedComplexity: 'medium' },
      { id: '2', action: 'Deploy to production', dependencies: ['1'], estimatedComplexity: 'high' },
      { id: '3', action: 'Install new packages', dependencies: ['2'], estimatedComplexity: 'medium' },
      { id: '4', action: 'Remove deprecated APIs', dependencies: ['3'], estimatedComplexity: 'medium' },
    ];

    const risks = assessRisks(steps, { name: 'risky-plan' });

    const destructiveRisks = risks.filter((r) => r.risk.includes('Destructive'));
    const deployRisks = risks.filter((r) => r.risk.includes('Deployment'));
    const depRisks = risks.filter((r) => r.risk.includes('Dependency'));
    const complexRisks = risks.filter((r) => r.risk.includes('complexity'));

    expect(destructiveRisks.length).toBeGreaterThanOrEqual(1);
    expect(deployRisks.length).toBeGreaterThanOrEqual(1);
    expect(depRisks.length).toBeGreaterThanOrEqual(1);
    expect(complexRisks.length).toBeGreaterThanOrEqual(1); // step 2 has high complexity
  });

  it('TEAM_THRESHOLDS are correctly defined', () => {
    expect(TEAM_THRESHOLDS.teamRecommendation).toBe(0.6);
    expect(TEAM_THRESHOLDS.platoonRecommendation).toBe(0.85);
    expect(TEAM_THRESHOLDS.platoonRecommendation).toBeGreaterThan(TEAM_THRESHOLDS.teamRecommendation);
  });
});

// ---------------------------------------------------------------------------
// Error Scenarios
// ---------------------------------------------------------------------------

describe('Agent Teams Integration - Error Scenarios', () => {
  /** @type {ReturnType<typeof createMockTeamsAPI>} */
  let api;

  beforeEach(() => {
    api = createMockTeamsAPI();
  });

  describe('Spawn failure recovery', () => {
    it('handles spawn failure when team does not exist', () => {
      expect(() => api.SpawnTeammate({
        team_name: 'non-existent',
        agent_type: 'developer',
        name: 'dev-1',
      })).toThrow('not found');
    });

    it('allows lifecycle to continue after partial spawn failure', () => {
      api.TeamCreate({ team_name: 'partial', description: 'Partial spawn' });

      // First spawn succeeds
      api.SpawnTeammate({ team_name: 'partial', agent_type: 'developer', name: 'dev-1' });

      // Simulated spawn failure (wrong team name)
      let spawnFailed = false;
      try {
        api.SpawnTeammate({ team_name: 'wrong-team', agent_type: 'tester', name: 'test-1' });
      } catch {
        spawnFailed = true;
      }
      expect(spawnFailed).toBe(true);

      // Team still operational with one teammate
      expect(api.state.teams['partial'].teammates).toHaveLength(1);

      // Can still create and complete tasks
      const task = api.TaskCreate({ subject: 'Work', description: 'Do work', activeForm: 'Working' });
      api.TaskUpdate({ taskId: task.id, owner: 'dev-1', status: 'in_progress' });
      api.TaskUpdate({ taskId: task.id, status: 'completed' });
      expect(api.TaskGet({ taskId: task.id }).status).toBe('completed');

      // Cleanup
      api.ShutdownTeammate({ team_name: 'partial', teammate_name: 'dev-1' });
      api.TeamDelete({ team_name: 'partial' });
    });
  });

  describe('Message timeout simulation', () => {
    it('records messages even when recipient may not exist (fire-and-forget)', () => {
      // SendMessage is fire-and-forget; it doesn't validate recipients
      const result = api.SendMessage({
        type: 'message',
        recipient: 'non-existent-agent',
        content: 'Are you there?',
        summary: 'Check presence',
      });
      expect(result.success).toBe(true);
      expect(api.state.messages).toHaveLength(1);
    });

    it('handles multiple rapid messages without loss', () => {
      for (let i = 0; i < 50; i++) {
        api.SendMessage({
          type: 'message',
          recipient: `agent-${i % 5}`,
          content: `Message ${i}`,
          summary: `Msg ${i}`,
        });
      }
      expect(api.state.messages).toHaveLength(50);
    });

    it('maintains message order under high volume', () => {
      for (let i = 0; i < 20; i++) {
        api.SendMessage({
          type: 'message',
          recipient: 'dev-1',
          content: `Message ${i}`,
          summary: `Msg ${i}`,
        });
      }
      for (let i = 0; i < 20; i++) {
        expect(api.state.messages[i].content).toBe(`Message ${i}`);
      }
    });
  });

  describe('Shutdown rejection handling', () => {
    it('sends shutdown_response with approve=false (rejection)', () => {
      api.TeamCreate({ team_name: 'shutdown-test', description: 'Shutdown test' });
      api.SpawnTeammate({ team_name: 'shutdown-test', agent_type: 'dev', name: 'busy-dev' });

      // Leader sends shutdown request
      api.SendMessage({
        type: 'shutdown_request',
        recipient: 'busy-dev',
        content: 'Please shut down.',
        summary: 'Shutdown request',
      });

      // Agent rejects shutdown (still has work)
      api.SendMessage({
        type: 'shutdown_response',
        request_id: 'shutdown-req-1',
        approve: false,
        content: 'Still working on task #3, need 5 more minutes',
      });

      const rejection = api.state.messages.find(
        (m) => m.type === 'shutdown_response' && m.approve === false,
      );
      expect(rejection).toBeDefined();
      expect(rejection.content).toContain('Still working');
      expect(rejection.request_id).toBe('shutdown-req-1');

      // Agent is still active (not shutdown)
      expect(api.state.teams['shutdown-test'].teammates[0].status).toBe('active');

      // Eventually agent approves shutdown
      api.SendMessage({
        type: 'shutdown_response',
        request_id: 'shutdown-req-2',
        approve: true,
      });
      api.ShutdownTeammate({ team_name: 'shutdown-test', teammate_name: 'busy-dev' });

      expect(api.state.teams['shutdown-test'].teammates[0].status).toBe('shutdown');

      // Now team can be deleted
      api.TeamDelete({ team_name: 'shutdown-test' });
    });

    it('prevents team deletion when shutdown is rejected and agent remains active', () => {
      api.TeamCreate({ team_name: 'active-team', description: 'Active team' });
      api.SpawnTeammate({ team_name: 'active-team', agent_type: 'dev', name: 'dev-1' });

      // Shutdown rejected - agent stays active
      api.SendMessage({
        type: 'shutdown_response',
        request_id: 'req-1',
        approve: false,
        content: 'Not finished yet',
      });

      // Cannot delete team with active agent
      expect(() => api.TeamDelete({ team_name: 'active-team' })).toThrow('active teammates');

      // Cleanup
      api.ShutdownTeammate({ team_name: 'active-team', teammate_name: 'dev-1' });
      api.TeamDelete({ team_name: 'active-team' });
    });

    it('handles full lifecycle with intermediate shutdown rejections', () => {
      api.TeamCreate({ team_name: 'resilient', description: 'Resilient team' });
      api.SpawnTeammate({ team_name: 'resilient', agent_type: 'dev', name: 'dev-1' });
      api.SpawnTeammate({ team_name: 'resilient', agent_type: 'tester', name: 'test-1' });

      // Create tasks
      const t1 = api.TaskCreate({ subject: 'Implement', description: 'Impl', activeForm: 'Implementing' });
      const t2 = api.TaskCreate({ subject: 'Test', description: 'Test', activeForm: 'Testing' });
      api.TaskUpdate({ taskId: t1.id, owner: 'dev-1', status: 'in_progress' });
      api.TaskUpdate({ taskId: t2.id, owner: 'test-1', addBlockedBy: [t1.id] });

      // Complete first task
      api.TaskUpdate({ taskId: t1.id, status: 'completed' });

      // Try to shutdown dev-1 but they reject (wants to help with testing)
      api.SendMessage({ type: 'shutdown_request', recipient: 'dev-1', content: 'Shutdown', summary: 'Shutdown' });
      api.SendMessage({ type: 'shutdown_response', request_id: 'r1', approve: false, content: 'Helping with tests' });

      // Dev stays active, test proceeds
      expect(api.state.teams['resilient'].teammates[0].status).toBe('active');
      api.TaskUpdate({ taskId: t2.id, status: 'in_progress' });
      api.TaskUpdate({ taskId: t2.id, status: 'completed' });

      // Now all tasks done, shutdown both
      api.ShutdownTeammate({ team_name: 'resilient', teammate_name: 'dev-1' });
      api.ShutdownTeammate({ team_name: 'resilient', teammate_name: 'test-1' });
      api.TeamDelete({ team_name: 'resilient' });

      expect(api.state.teams['resilient']).toBeUndefined();
      expect(api.state.tasks[t1.id].status).toBe('completed');
      expect(api.state.tasks[t2.id].status).toBe('completed');
    });
  });

  describe('Edge cases', () => {
    it('handles shutting down already-shutdown teammate gracefully', () => {
      api.TeamCreate({ team_name: 'edge', description: 'Edge case' });
      api.SpawnTeammate({ team_name: 'edge', agent_type: 'dev', name: 'dev-1' });
      api.ShutdownTeammate({ team_name: 'edge', teammate_name: 'dev-1' });

      // Second shutdown still succeeds (idempotent status set)
      api.ShutdownTeammate({ team_name: 'edge', teammate_name: 'dev-1' });
      expect(api.state.teams['edge'].teammates[0].status).toBe('shutdown');

      api.TeamDelete({ team_name: 'edge' });
    });

    it('tasks persist after team deletion', () => {
      api.TeamCreate({ team_name: 'ephemeral', description: 'Short-lived' });
      api.SpawnTeammate({ team_name: 'ephemeral', agent_type: 'dev', name: 'dev-1' });

      const task = api.TaskCreate({ subject: 'Work', description: 'Work', activeForm: 'Working' });
      api.TaskUpdate({ taskId: task.id, owner: 'dev-1', status: 'completed' });

      api.ShutdownTeammate({ team_name: 'ephemeral', teammate_name: 'dev-1' });
      api.TeamDelete({ team_name: 'ephemeral' });

      // Tasks are global, not tied to team lifecycle
      expect(api.TaskGet({ taskId: task.id }).status).toBe('completed');
    });

    it('empty team can be deleted immediately', () => {
      api.TeamCreate({ team_name: 'empty', description: 'No teammates' });
      api.TeamDelete({ team_name: 'empty' });
      expect(api.state.teams['empty']).toBeUndefined();
    });
  });
});

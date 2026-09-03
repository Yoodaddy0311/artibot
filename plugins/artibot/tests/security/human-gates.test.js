/**
 * `lib/security/human-gates.js` 단위 테스트 — `classify` 의 계약과 경계.
 *
 * 매트릭스 자체의 형태·행 구성·중복 0 은 `tests/firewall/human-gate-matrix-selfcheck.test.js`
 * 가 소유한다. 여기서는 **함수 동작**만 본다: 도구 allowlist, probe 선택, 다중 hit,
 * 잘못된 입력에 대한 방어.
 *
 * 이 파일이 못 보는 것: 훅이 실제로 무엇을 하는지(T-39 소유), 실제 명령 분포에 대한
 * 오탐·미탐률(미측정), `policyRef` 가 가리키는 config 키의 실재.
 */

import { describe, expect, it } from 'vitest';
import {
  classify,
  getGateRow,
  HUMAN_GATE_MATRIX,
} from '../../lib/security/human-gates.js';

/** @param {object} input */
const ids = (input) => classify(input).hits.map((h) => h.id);

describe('classify — 도구 allowlist', () => {
  it('tool 이 행의 allowlist 밖이면 그 행은 보지 않는다', () => {
    // HG-08 은 Bash 행이다. 같은 문자열을 Write 의 path 로 줘도 걸리지 않는다.
    expect(ids({ tool: 'Bash', command: 'terraform apply' })).toContain('HG-08');
    expect(ids({ tool: 'Write', path: 'terraform apply' })).not.toContain('HG-08');
  });

  it('tool 을 생략하면 도구 필터 없이 payload 만으로 분류한다', () => {
    expect(ids({ command: 'docker push acme/app' })).toContain('HG-08');
  });

  it('알 수 없는 tool 은 어떤 행도 열지 않는다 (allowlist 형)', () => {
    expect(ids({ tool: 'UnknownTool', command: 'terraform apply' })).toEqual([]);
  });
});

describe('classify — probe 선택', () => {
  it('command 행은 path 만 줬을 때 걸리지 않는다', () => {
    expect(ids({ tool: 'Bash', command: 'gh pr create --fill' })).toContain('HG-06');
    expect(ids({ tool: 'Bash', path: 'gh pr create --fill' })).not.toContain('HG-06');
  });

  it('path 행은 command 만 줬을 때 걸리지 않는다', () => {
    expect(ids({ tool: 'Write', path: 'lib/foo.js' })).toContain('HG-02');
    expect(ids({ tool: 'Write', command: 'lib/foo.js' })).not.toContain('HG-02');
  });

  it('probe="both" 행은 command 와 path 양쪽에서 걸린다', () => {
    expect(ids({ tool: 'Bash', command: 'cat .env' })).toContain('HG-11');
    expect(ids({ tool: 'Write', path: 'plugins/artibot/artibot.config.json' })).toContain('HG-13');
  });
});

describe('classify — 다중 hit', () => {
  it('한 행동이 여러 행에 걸리면 매트릭스 순서대로 전부 돌려준다', () => {
    // artibot.config.json 쓰기 = 로컬 편집(HG-02, auto) ∧ 보안 정책 비활성화(HG-13, human)
    const hit = ids({ tool: 'Write', path: 'plugins/artibot/artibot.config.json' });
    expect(hit).toEqual(['HG-02', 'HG-13']);
  });

  it('축약하지 않는다 — auto 행이 human 행에 가려지지 않는다', () => {
    // cat .env = 읽기(HG-01, auto) ∧ 시크릿 접근(HG-11, human)
    expect(ids({ tool: 'Bash', command: 'cat .env' })).toEqual(['HG-01', 'HG-11']);
  });
});

describe('classify — 신규 패턴이 실측 구멍을 덮는다 (레인 5 §1-D)', () => {
  it.each([
    ['gh release create v1.0.0', 'HG-08'],
    ['docker push registry.example.com/app:1', 'HG-08'],
    ['vercel deploy --prod', 'HG-08'],
    ['netlify deploy --prod', 'HG-08'],
    ['kubectl apply -f deploy.yaml', 'HG-08'],
    ['curl -X DELETE https://api.example.com/v1/items/9', 'HG-07'],
    ['gh pr merge 42 --admin', 'HG-07'],
    ['git push origin main', 'HG-07'],
    ['prisma migrate deploy', 'HG-09'],
    ['alembic upgrade head', 'HG-09'],
    ['UPDATE accounts SET balance = 0', 'HG-09'],
  ])('%s → %s', (command, expected) => {
    expect(ids({ tool: 'Bash', command })).toContain(expected);
  });

  it('WHERE 가 있는 UPDATE 는 HG-09 가 아니다', () => {
    expect(ids({ tool: 'Bash', command: 'UPDATE accounts SET balance = 0 WHERE id = 7' }))
      .not.toContain('HG-09');
  });

  it.each([
    ['.claude/settings.json', 'HG-12'],
    ['.claude/settings.local.json', 'HG-12'],
    ['plugins/artibot/hooks.json', 'HG-12'],
    ['plugins/artibot/dispatch-table.json', 'HG-12'],
  ])('설정 자기수정 %s → %s', (writePath, expected) => {
    expect(ids({ tool: 'Write', path: writePath })).toContain(expected);
  });
});

describe('classify — 잘못된 입력', () => {
  it.each([
    ['인자 없음', undefined],
    ['빈 객체', {}],
    ['null', null],
    ['문자열', 'terraform apply'],
    ['숫자', 7],
    ['command 가 빈 문자열', { tool: 'Bash', command: '' }],
    ['command 가 문자열이 아님', { tool: 'Bash', command: { a: 1 } }],
  ])('%s → hits 빈 배열, 예외 없음', (_label, input) => {
    const result = classify(input);
    expect(result).toEqual({ hits: [] });
  });
});

describe('getGateRow', () => {
  it('id 로 행을 찾는다', () => {
    expect(getGateRow('HG-01').id).toBe('HG-01');
    expect(getGateRow('HG-13').default).toBe('human');
  });

  it('없는 id 는 null', () => {
    expect(getGateRow('HG-99')).toBeNull();
    expect(getGateRow('')).toBeNull();
  });

  it('돌려준 행은 동결돼 있다 — 소비자가 표를 못 바꾼다', () => {
    const row = getGateRow('HG-08');
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(row.patterns)).toBe(true);
  });
});

describe('HUMAN_GATE_MATRIX — 소비자가 쓰는 축', () => {
  // HG-07 외부 시스템 쓰기는 v5 §11 표에서 policy 였으나 OD-1(파괴·배포·외부쓰기·
  // 제품결정 = 단계 무관 항상 사람)이 이겨 human 으로 승격됐다. 그래서 policy 는 1행.
  it('기본값 분포가 설계와 일치한다 (auto 5 · policy 1 · human 7)', () => {
    const counts = HUMAN_GATE_MATRIX.reduce((acc, row) => {
      acc[row.default] = (acc[row.default] || 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ auto: 5, policy: 1, human: 7 });
  });

  it('HG-07 은 OD-1 승격 행이다 — policyRef 를 유지한 채 human', () => {
    const row = getGateRow('HG-07');
    expect(row.default).toBe('human');
    expect(row.policyRef).toBe('policy:autopilot.safety.blockExternalSend');
    expect(row.note).toBe('v5 §11 = policy, OD-1 로 human 승격');
  });

  it('부분 강제 행은 무엇까지만 강제되는지 적어 둔다', () => {
    for (const row of HUMAN_GATE_MATRIX.filter((r) => r.enforcement === 'hook')) {
      expect(typeof row.enforcementNote, `${row.id}`).toBe('string');
      expect(row.enforcementNote.trim().length, `${row.id}`).toBeGreaterThan(0);
    }
  });
});

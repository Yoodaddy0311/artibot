# PC 인수인계 census — 2026-11-07

- 측정: 2026-11-07T14:35:23.938Z · win32 10.0.26200 x64 · node v22.19.0 · claude 2.1.319 (Claude Code) · HEAD 70b63650 (ci/onfailure-block-20261107, dirty) · 설치본 4.71.14@70b63650 · 브랜치 package.json 4.71.14
- 러너: `node .artibot/guides/v5-design/practicality-improvement-20261023/pc-handoff.mjs census` (07 §A-2). 세 수치는 05 §8.1 로 옮길 때 각 절의 재현 명령과 함께 적는다. `unmeasured:*` 는 0 이 아니라 부재다.
- 커밋 전 가공: 이 파일과 JSON 사이드카에서 사용자 홈 절대경로만 `~` 로 바꿨다(md 118 B · json 45 B 감소, 남은 홈 참조 0 — `grep -c` 로 확인). 다른 바이트는 러너 출력 그대로다. 같은 폴더의 다른 증거 파일들도 홈 경로를 담지 않는다.

## 1. verify-result-census

- 무엇: REPORT 에 도달한 autopilot 세션 중 verifyResult 가 PASS/FAIL/UNMEASURED 인 비율과, evidenceMode 를 explicit-pass 로 바꾸면 늘어날 pause 수 (05 D-04 1단계 · 07 §B-2 의 입력)
- 재현: `node plugins/artibot/scripts/ledger/verify-result-census.mjs` · exit 0 · 130 ms
- 상태: `measured`
- 한 줄: verify result: 2 of 8 session(s) reached REPORT — fold PASS 0 / FAIL 0 / UNMEASURED 2 | ok under ack 0, under explicit-pass 0 | would pause under explicit-pass 0 | 8 file(s) at ~\.claude\artibot\runtime\autopilot | measured 2026-11-07T14:35:24.041Z

```json
{
  "ok": true,
  "reason": null,
  "inputPath": "~\\.claude\\artibot\\runtime\\autopilot",
  "files": 8,
  "parseFailures": 0,
  "sessions": 8,
  "reportReached": 2,
  "byFold": {
    "PASS": 0,
    "FAIL": 0,
    "UNMEASURED": 2
  },
  "underAck": {
    "ok": 0,
    "byCode": {
      "ok": 0,
      "NO_VERIFY_ATTEMPT": 2,
      "VERIFY_NOT_ACKED": 0,
      "VERIFY_NOT_DONE": 0,
      "STALE_BEFORE_EXECUTE": 0,
      "VERIFY_RESULT_FAILED": 0,
      "VERIFY_RESULT_UNMEASURED": 0,
      "VERIFY_EVIDENCE_MISSING": 0,
      "VERIFY_EVIDENCE_STALE": 0,
      "VERIFY_EVIDENCE_FAILED": 0
    }
  },
  "underExplicitPass": {
    "ok": 0,
    "byCode": {
      "ok": 0,
      "NO_VERIFY_ATTEMPT": 2,
      "VERIFY_NOT_ACKED": 0,
      "VERIFY_NOT_DONE": 0,
      "STALE_BEFORE_EXECUTE": 0,
      "VERIFY_RESULT_FAILED": 0,
      "VERIFY_RESULT_UNMEASURED": 0,
      "VERIFY_EVIDENCE_MISSING": 0,
      "VERIFY_EVIDENCE_STALE": 0,
      "VERIFY_EVIDENCE_FAILED": 0
    }
  },
  "wouldPauseUnderExplicitPass": 0,
  "measured_at": "2026-11-07T14:35:24.041Z",
  "status": "measured",
  "census": {
    "storePresent": true,
    "storeReadable": true,
    "sessionFilter": null,
    "perSession": [
      {
        "sessionId": "ap-20260802-033656-juamfq",
        "reportReached": false,
        "fold": "UNMEASURED",
        "ack": "NO_VERIFY_ATTEMPT",
        "explicitPass": "NO_VERIFY_ATTEMPT"
      },
      {
        "sessionId": "ap-20260918-185915-3g764t",
        "reportReached": false,
        "fold": "UNMEASURED",
        "ack": "NO_VERIFY_ATTEMPT",
        "explicitPass": "NO_VERIFY_ATTEMPT"
      },
      {
        "sessionId": "ap-20260923-094144-q7vbit",
        "reportReached": false,
        "fold": "UNMEASURED",
        "ack": "NO_VERIFY_ATTEMPT",
        "explicitPass": "NO_VERIFY_ATTEMPT"
      },
      {
        "sessionId": "ap-20260923-165242-sljort",
        "reportReached": true,
        "fold": "UNMEASURED",
        "ack": "NO_VERIFY_ATTEMPT",
        "explicitPass": "NO_VERIFY_ATTEMPT"
      },
      {
        "sessionId": "ap-20260924-002500-fy4jo3",
        "reportReached": false,
        "fold": "UNMEASURED",
        "ack": "NO_VERIFY_ATTEMPT",
        "explicitPass": "NO_VERIFY_ATTEMPT"
      },
      {
        "sessionId": "ap-20261002-172945-yz61no",
        "reportReached": false,
        "fold": "UNMEASURED",
        "ack": "NO_VERIFY_ATTEMPT",
        "explicitPass": "NO_VERIFY_ATTEMPT"
      },
      {
        "sessionId": "ap-20261006-153432-8fls05",
        "reportReached": false,
        "fold": "UNMEASURED",
        "ack": "NO_VERIFY_ATTEMPT",
        "explicitPass": "NO_VERIFY_ATTEMPT"
      },
      {
        "sessionId": "ap-20261107-103519-emzcad",
        "reportReached": true,
        "fold": "UNMEASURED",
        "ack": "NO_VERIFY_ATTEMPT",
        "explicitPass": "NO_VERIFY_ATTEMPT"
      }
    ],
    "legacyFallback": false,
    "readFrom": [
      "~\\.claude\\artibot\\runtime\\autopilot"
    ]
  }
}
```

## 2. loop-detection-census

- 무엇: 루프 감지 warn/block 수 · 도구 분포 · 반복 fingerprint (설치본이 D-01 을 포함한 뒤부터 쌓인다) (05 D-02 1단계 · 07 §B-1 의 입력)
- 재현: `node plugins/artibot/scripts/ledger/loop-detection-census.mjs` · exit 0 · 79 ms
- 상태: `measured:no-detections`
- 한 줄: loop-detection-census: files=3 parse_failures=0 sessions=2 warn=0 block=0 total=0 status=measured:no-detections

```json
{
  "ok": true,
  "reason": null,
  "inputPaths": [
    "~\\.claude\\artibot\\runtime\\sessions",
    "~\\.claude\\artibot\\loop-state.json"
  ],
  "measured_at": "2026-11-07T14:35:24.136Z",
  "filesRead": 3,
  "parseFailures": 0,
  "sessions": 2,
  "detections": {
    "warn": 0,
    "block": 0,
    "total": 0
  },
  "byTool": {},
  "topFingerprints": [],
  "status": "measured:no-detections"
}
```

## 3. existence-audit

- 무엇: 훅·커맨드·스킬·lib 모듈의 발화 수와 소비처 — "소비처 0 + 발화 0 이 2릴리스 연속" 후보 목록 (CLAUDE.md Existence Audit · 06 §8 #3(a) · 07 §B-6 의 입력)
- 재현: `node plugins/artibot/scripts/ledger/existence-audit.mjs --cwd . --plugin-root plugins/artibot` · exit 0 · 156 ms
- 상태: `entries 672 · measured 254 · unmeasured 418 · eventsReceived 5793`
- 한 줄: (stderr 없음)
- 전체 JSON(175.8 KB): `pc-handoff-census-20261107.existence-audit.json` (같은 폴더)
- 제거 후보(candidate true): 0건

```json
{
  "measuredAt": "2026-11-07T14:35:24.291Z",
  "inputPath": "~\\OneDrive\\바탕 화면\\AI\\artibot\\.git\\artibot\\ledger.jsonl",
  "since": null,
  "pluginRoot": "~\\OneDrive\\바탕 화면\\AI\\artibot\\plugins\\artibot",
  "sources": {
    "commands": {
      "path": "commands",
      "status": "enumerated",
      "count": 81,
      "skipped": 0
    },
    "skills": {
      "path": "skills",
      "status": "enumerated",
      "count": 114,
      "skipped": 0
    },
    "hooks": {
      "path": "hooks/dispatch-table.json",
      "status": "enumerated",
      "count": 59,
      "handlerEntries": 45,
      "directStatus": "enumerated",
      "directEntries": 24
    },
    "modules": {
      "path": "lib",
      "status": "enumerated",
      "count": 418
    }
  },
  "hooksOutsideCarrier": {
    "path": "hooks/hooks.json",
    "status": "enumerated",
    "count": 0,
    "entries": []
  },
  "unmatched": {
    "hooks": {},
    "commands": {},
    "skills": {},
    "modules": null
  },
  "skillCarrierCommands": {
    "save": 1,
    "verify": 1
  },
  "aliasesFolded": {
    "foldPrefix": {
      "value": "artibot:",
      "source": ".claude-plugin/plugin.json",
      "status": "resolved"
    },
    "skills": {},
    "commands": {}
  },
  "kinds": "<omitted 174.5 KB — see sidecar>",
  "summary": {
    "entries": 672,
    "measured": 254,
    "unmeasured": 418,
    "exempt": 1,
    "eventsReceived": 5793,
    "census": {
      "file": {
        "present": true,
        "readable": true,
        "bytes": 2298634,
        "path": "~\\OneDrive\\바탕 화면\\AI\\artibot\\.git\\artibot\\ledger.jsonl"
      },
      "lines": {
        "raw": 5794,
        "blank": 1,
        "nonblank": 5793
      },
      "dropped": {
        "loss": {
          "corrupt": 0,
          "malformed_envelope": 0,
          "duplicate": 0
        },
        "selection": {
          "rejected_excluded": 0,
          "filtered_out": 0
        }
      },
      "survivors": 5793,
      "dropped_total": {
        "loss": 0,
        "selection": 0
      }
    }
  }
}
```


---
description: (Artibot) REA(Reverse Engineer Anything)로 바이너리·Electron/JS 앱·APK·펌웨어·브라우저 대상을 역공학 조사 — 업스트림 morluto/rea 스킬을 그대로 따른다. 이중 용도 도구라 합법·허가된 분석에만 쓴다. REA MCP 가 연결돼 있지 않으면 업스트림 setup 절차(진단, dry-run, 사용자 승인, 적용, 재시작)로 안내한다
argument-hint: '<조사할 앱·바이너리·폴더 경로 또는 알고 싶은 것>'
allowed-tools: [Read, Bash(node --version), Bash(npx -y rea-agents@6.7.0 doctor --client claude_code --json), Bash(npx -y rea-agents@6.7.0 setup --client claude_code --dry-run --json)]
---

# /rea

REA(Reverse Engineer Anything, morluto/rea, MIT)로 앱·바이너리를 역공학 조사한다. 이 커맨드는 얇은 래퍼다 — 조사 방법은 업스트림 스킬이 정하고, 여기서는 연결돼 있으면 그 스킬을 읽게 하고 연결돼 있지 않으면 업스트림 절차대로 연결시키는 일만 한다. 스킬 문구와 엔진은 한 버전(rea-agents@6.7.0)으로 짝지어 고정돼 있다.

> **이중 용도**: REA 는 합법적이고 허가된 분석(보안 연구, 악성코드·사고 분석, 상호운용, 보존, 본인 소유이거나 분석 권한이 있는 소프트웨어 점검)을 위한 도구다. DRM·라이선스·안티치트 우회, 접근통제 우회, 허가 없는 대상 분석에는 쓰지 않는다. 책임과 범위는 [업스트림 DISCLAIMER](../vendor/rea/DISCLAIMER.md) 를 따른다.

## Arguments

`$ARGUMENTS` = 조사 대상(앱 이름, 파일·폴더 경로)과 알고 싶은 것. 대상이 비었거나 "내 앱" 처럼 불분명하면 먼저 어떤 대상인지 묻는다. 대상을 대신 고르거나 예시 앱을 쓰지 않는다. 사용자가 지정하지 않은 파일·프로그램은 열지도 실행하지도 않는다.

## 1. REA 가 연결돼 있는가

이 세션의 툴 목록에 `mcp__rea__` 로 시작하는 툴이 있으면 연결된 것이다(지연 로드 목록이면 ToolSearch 로 확인). 있으면 2 로, 없으면 3 으로 간다.

## 2. 연결돼 있을 때 — 업스트림 스킬을 그대로 따른다

1. 스킬을 Read 한다: `${CLAUDE_PLUGIN_ROOT}/vendor/rea/skill/SKILL.md` (호스트가 이 커맨드를 불러올 때 플러그인 경로를 채워 넣는다). 변수 참조가 그대로 보이거나 파일이 없으면 `rea setup` 이 설치한 사본 — 홈 폴더의 `.claude/skills/reverse-engineer-anything/SKILL.md` — 을 Read 한다(같은 내용). 둘 다 없으면 연결된 서버의 툴 목록과 입력 스키마를 따르고, 스킬을 읽지 못했다고 알린다.
2. SKILL.md 가 시키는 대로 `$ARGUMENTS` 를 조사한다. 문구를 고치거나 요약으로 갈음하지 않는다. SKILL.md 가 가리키는 `references/*.md` 는 SKILL.md 와 같은 폴더에서, 해당 주제가 나올 때만 Read 한다.
3. 대상 프로그램 실행·런타임 관찰·장치 조작은 사용자가 요청한 범위 안에서만 한다. REA 툴 호출은 업스트림과 같이 호스트 권한 확인을 거친다 — 이 커맨드는 REA 툴을 사전 승인하지 않는다.

## 3. 연결돼 있지 않을 때 — 업스트림 절차 그대로

먼저 사용자에게 REA 가 이 세션에 연결돼 있지 않다고 알린다. 아래는 업스트림 스킬(SKILL.md 의 "Connect only when needed")과 같은 순서다.

1. **Node 검사**: `node --version` 이 `^22.19 || ^24.11 || >=26` 이어야 한다(업스트림 engines). 미달이거나 node 를 못 찾으면 이유를 알리고 여기서 멈춘다. REA setup 은 Node 를 설치하거나 올리지 않는다.
2. **진단** (설정을 바꾸지 않는다. npx 가 패키지를 받아 npm 캐시에 쓴다):
   ```bash
   npx -y rea-agents@6.7.0 doctor --client claude_code --json
   ```
   등록이나 스킬이 어긋나 있으면 종료 코드가 1 이다(실측). 명령 실패가 아니라 진단 결과이니 JSON 의 classification 을 읽는다. 등록과 스킬이 정렬되면 0 으로 끝나고, 분석 엔진이 없어도 0 이다.
   - 등록(registration:claude_code)이나 스킬이 missing·config_drift → 설정 수리가 필요하다(3 단계).
   - 등록은 aligned 인데 이 세션에 툴이 없음 → 재시작·재연결만 하면 된다(5 단계). doctor 는 지금 세션의 연결을 증명하지 못한다.
   - 분석 엔진(Hopper·Ghidra·IDA·JADX·Kuna) 없음 → 그 엔진이 필요한 작업에만 영향이 있다. 정적 JavaScript 분석은 둘 다 필요 없다. 다른 소프트웨어를 설치하지 않는다.
3. **계획 보기** (읽기 전용):
   ```bash
   npx -y rea-agents@6.7.0 setup --client claude_code --dry-run --json
   ```
   plannedActions 의 대상 경로·백업·변경 내용을 사용자에게 그대로 보여준다. 사용자 전역 설정이다 — Claude Code 사용자 설정 파일(보통 홈의 .claude.json)에 MCP 서버 항목 rea 를 더하고(기존 설정은 보존·백업하고, Windows 에서는 cmd.exe /d /c npx 형태로 등록된다), 홈의 .claude/skills/reverse-engineer-anything 스킬을 설치하거나 교체한다.
4. **승인 후 적용**: 사용자가 명시적으로 승인("진행" 등)한 뒤에만 같은 범위로 실행한다. 침묵이나 모호한 답은 승인이 아니다.
   ```bash
   npx -y rea-agents@6.7.0 setup --client claude_code --yes
   ```
   `--install-hopper` 는 따로 필요하고 따로 승인받은 경우에만 붙인다.
5. **재시작**: Claude Code 를 다시 시작하고(MCP 등록은 시작할 때 읽는다) REA 툴이 실제로 나타나는지 확인한 뒤, 원래 요청으로 `/rea` 를 다시 실행한다. 계속 안 보이면 setup 을 반복하지 말고 클라이언트의 MCP 시작 오류를 본다.

등록 전에도 JavaScript·Electron 대상은 CLI 로 바로 조사할 수 있다(툴 등록과 네이티브 엔진이 필요 없다). 이 명령은 사전 승인 목록에 없으므로 평소 권한 규칙대로 처리된다:

```bash
npx -y rea-agents@6.7.0 analyze-javascript-application <절대경로> --json
```

## 4. 알아둘 것

- **공급망**: `npx -y` 는 실행할 때마다 npm 에서 `rea-agents@6.7.0` 과 그 의존성을 받아(캐시에 있으면 재사용) 실행한다. 제3자 코드를 내 컴퓨터에서 돌리는 일이다. 버전은 고정했지만 이 패키지에는 shrinkwrap 이 없어 하위 의존성 버전까지 고정되지는 않고, 선택 의존성 frida 는 설치 스크립트가 GitHub 에서 네이티브 바이너리를 내려받는다.
- **용량·지연**: 첫 실행은 패키지와 의존성을 npm 캐시에 설치하느라 시간이 걸리고 디스크를 수백 MB 쓴다(패키지 본체는 수십 MB). 등록 뒤 첫 세션 시작에도 같은 설치가 한 번 일어날 수 있다.
- **첫 진입**: 업스트림은 setup 이 끝나면 홈의 스킬 폴더에 깔린 스킬이 설명에 따라 자동으로 발화한다. 그 전의 첫 진입은 이렇게 `/rea` 로 명시 호출한다.
- **원상복구** (이 커맨드는 실행하지 않는다): `claude mcp remove --scope user rea` 로 등록을 지우고, 홈의 `.claude/skills/reverse-engineer-anything` 폴더를 지운다.

## 하지 않는 것

- `rea update`, `rea uninstall`, 전역 설치(`npm install --global`)는 실행하지 않는다. `--client` 가 `claude_code` 가 아닌 setup 도 실행하지 않는다.
- 플러그인 `.mcp.json` 에는 등록하지 않는다 — 등록하면 모든 세션에 REA 툴과 서버 기동이 붙는다.
- 업스트림 스킬 문구를 고치지 않는다. 스킬 사본은 `vendor/rea` 에 바이트 그대로 있고, 버전을 올릴 때는 `scripts/vendor/sync-rea.mjs` 로만 바꾼다.

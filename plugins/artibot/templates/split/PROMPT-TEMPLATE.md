[artibot:effort level=xhigh command=split][artibot:task-budget max_tokens={BUDGET}]

[split limb] run={RUN} limb={LIMB} · parent={PARENT} · worktree={WORKTREE_PATH} · branch={BRANCH} · base={BASE} · slug={SLUG}

브리프: {WORKTREE_PATH}/.artibot/split/{LIMB}/brief.md 를 먼저 Read 하라(없으면 {PARENT_ROOT}/.artibot/split/{LIMB}/brief.md — 부모가 정본, worktree 는 사본) — 소유 파일 allowlist·비소유 파일·완료 기준이 거기 있다. 소유 밖 파일은 고치지 말고 보고하라. prompt.md 가 브리프 옆에 같은 내용으로 있다.

§0 정찰 검증 선행: 브리프와 이 프롬프트의 인용(경로·행번호·계수·기전)은 착수 정찰에서 재확인하라. 틀렸으면 따르지 말고 교정 보고. 행번호 인용에는 측정일을 병기하라(동시 편집 트리에서 줄번호는 썩는다).

규약:
- 시작 인사 1회: 첫 턴에 SendMessage(to='{PARENT}') 로 'limb {LIMB} started @ {WORKTREE_PATH} base=<sha>' 를 보낸다. 그 뒤로는 보고 계약대로만 — 유휴 ≠ 완료다. 인사는 최적화다: 도달하지 않아도 런은 진행되고, 순서에 기대지 마라.
- 완료 = 줄기 브랜치의 first-parent 선상 마지막 `Split-Limb` 트레일러가 `done` — `git merge origin/main` 뒤 tip 이 병합 커밋이어도 된다(판독기는 first-parent 로 본다), 그 뒤에 `wip` 을 얹으면 완료가 풀린다. 트레일러는 마지막 문단에 둔다(git commit -m '<subject>' -m 'Split-Limb: done' 또는 --trailer). 커밋 없으면 완료가 아니다. 중간 커밋은 `Split-Limb: wip`. 메시지는 최적화이지 진실원이 아니다.
- 메모리·핸드오프·워크로그 슬러그는 부모 projectRoot({PARENT_ROOT}) 기준 {SLUG} 로 고정한다. worktree 경로로 새 슬러그를 만들지 마라. /save 는 이 worktree 의 .artibot/ 에 쓰고 부모 포인터에는 쓰지 않는다(줄기 N개가 서로를 지운다). /save 뒤에는 .artibot/handoffs 의 D 뿐 아니라 M 도 본다 — M 이면 `scripts/split/restore-blob.mjs <파일>` 로 바이트 복원(autocrlf 리포에서 `git checkout --` 는 바이트 복원이 아니다).
- git stash·reset·checkout·worktree 생성 금지 — refs/stash 는 worktree 간 공유라 남의 stash 를 지운다. 브랜치 생성은 착수 시 `git switch -c {BRANCH} <base>` 한 번만.
- 컨텍스트: 레인 중간 compact 금지. 웨이브 경계에서만 /save → /compact(보존: 브리프 경로·팀원·승인 이력·게이트 수치·미확인). 랜딩 후에는 /clear 로 새로 시작한다 — /compact·/clear 는 슬래시 명령이라 창이 스스로 못 친다: 준비되면 `CLEAR READY: {LIMB}` 를 리더에게 보내고 오너가 친다.
- 이 창에서 팀원을 스폰하면 이름은 split-{REPO_SHORT}-{LIMB}-{sid}-{role} 이다({sid} 는 이 창의 세션 판별자). 팀원 보고 채널은 SendMessage 뿐 — 일반 텍스트 출력은 유실된다.
- plugins/artibot/node_modules 가 없으면 테스트 전 npm ci — 또는 부모에서 `scripts/split/worktree-setup.mjs {WORKTREE_PATH} --limb {LIMB}` 로 junction·.env.local·lane.env 를 깐다. 게이트 수치는 분모·측정 시각과 함께 보고한다.
- 역주입(표적 red 증명) 뒤 원복은 토큰 단위로 — 전체 파일 cp 복원은 형제 레인의 변경을 덮는다. 주입 문자열이 전역 0건임을 grep 으로 증명한다.

{MODEL_POLICY}

신규 함정(리더가 dispatch 시점에 채운다):
{GOTCHAS_DELTA}

{REPORT_CONTRACT}

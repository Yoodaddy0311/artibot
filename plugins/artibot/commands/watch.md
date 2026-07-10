---
description: (Artibot) 유튜브 영상을 로컬에서 판독 — 공개 자막 추출(기본) + 선택적 장면 키프레임 캡처 후 요약/분석. 트리거 "유튜브 분석해줘", "영상 요약해줘", "이 영상 봐줘", "watch", "youtube 판독", 그리고 프롬프트에 유튜브 링크(youtube.com/watch, youtu.be/, youtube.com/shorts, youtube.com/embed)가 포함될 때
argument-hint: '[youtube-url] [--frames] [--max-frames N]'
allowed-tools: [Read, Bash]
---

# /watch

유튜브 영상을 **로컬에서 읽을 수 있는 형태**로 인제스트한 뒤 Claude가 판독해 요약/분석한다. 두 모드:

1. **transcript (기본)** — 공개 자막(수동 우선, ko>en)만 추출. 영상 다운로드 없음. 가장 빠름.
2. **balanced (`--frames`)** — 위 + 최저화질 임시 다운로드 → 장면 전환 키프레임(기본 24장, 상한 50) 캡처 → 임시 영상 삭제. 자막이 없거나 시각 정보가 중요한 영상용.

> **DATA POLICY**: 유튜브 → 로컬 인바운드만. 외부 API·업로드·클라우드 STT 절대 사용 안 함. 결과물은 전부 `.artibot/media/<video-id>/`에만 저장.

> **필요 바이너리**: `yt-dlp`(자막/다운로드), `ffmpeg`(--frames 키프레임). 미설치 시 스크립트가 크래시 없이 설치 안내를 내보낸다.

## Arguments

`$ARGUMENTS` 파싱:
- `<youtube-url>` → 인제스트 대상 (watch/youtu.be/shorts/embed URL 또는 11자 ID)
- `--frames` → balanced 모드(키프레임 포함). 없으면 transcript 모드.
- `--max-frames N` → 키프레임 상한 조정(기본 24, 하드캡 50).

## 실행 (엔진 호출)

엔진은 `scripts/media/watch-ingest.js`. **설치 방식에 따라 위치가 다르다** (theme 커맨드와 동일 규약):
- **flat / full install (install.sh)**: `$HOME/.claude/artibot/scripts/media/watch-ingest.js` (안정 경로)
- **네이티브 마켓플레이스 install**: `$CLAUDE_PLUGIN_ROOT/scripts/media/watch-ingest.js`

아래 스니펫은 `$HOME` 경로를 우선하고 없으면 `$CLAUDE_PLUGIN_ROOT`로 폴백하며, 두 경로 모두 없으면 안내 문구를 낸다.

```
Bash: ENGINE="$HOME/.claude/artibot/scripts/media/watch-ingest.js"; [ -f "$ENGINE" ] || ENGINE="${CLAUDE_PLUGIN_ROOT:-}/scripts/media/watch-ingest.js"; if [ -f "$ENGINE" ]; then node "$ENGINE" "<youtube-url>" [--frames] [--max-frames N]; else echo "watch engine not found — run the full install (bash install.sh) to use /watch"; fi
```

## 판독 흐름 (커맨드가 수행)

1. 위 스니펫으로 엔진 실행 → **stdout JSON** 수신: `{ videoId, mode, title, transcriptPath, frames: [...], durations }`.
2. JSON에 `error` 필드가 있으면(예: `yt_dlp_missing`, `ffmpeg_missing`, `no_captions`, `bad_url`) **그 `hint`를 그대로 사용자에게 한국어로 안내**하고 중단. (바이너리 미설치면 설치 명령을 그대로 전달.)
3. `transcriptPath`가 있으면 **Read로 열어** 내용을 파악.
4. balanced 모드이고 `frames` 배열이 있으면 **각 프레임을 Read(이미지)로 열어** 시각 정보를 판독.
5. 자막 + 프레임을 종합해 **요약/분석**을 사용자 언어로 제시. (타임라인·핵심 주제·시각적 하이라이트를 표/불릿로 정리.)

## 제약 / 안전

- 공개 자막이 없는 영상은 transcript 모드에서 `no_captions`를 반환 — 이때 `--frames`로 화면 분석을 제안.
- 비공개/연령제한/지역제한 영상은 다운로드가 실패할 수 있고, 그 경우 자막만 처리된다(`download_failed` hint).
- 임시 영상은 키프레임 추출 후 즉시 삭제된다. 최종 산출물은 자막·프레임(jpg)뿐.
- 모든 실패는 exit 0 + JSON `error`로 표면화 — statusline/세션이 죽지 않는다.

## Next Steps

| # | 액션 | 설명 |
|---|------|------|
| 1 | `/watch <url> --frames` | 시각 정보까지 포함해 재분석 |
| 2 | Read `.artibot/media/<id>/transcript.txt` | 원문 자막 직접 확인 |

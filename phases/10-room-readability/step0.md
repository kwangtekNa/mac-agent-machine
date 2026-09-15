# Step 0: context-filter-own-cards

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/PROTOCOL.md` 6.4 "턴 입력"(2026-09-14 추가 문단 포함), 6.1 `RoomMessage`
- `/docs/ADR.md` ADR-018(에이전트 간 대화 분리와 맥락 필터)
- `/packages/server/src/teams/format.ts` (`isContextRelevant`, `buildTurnText`, `approvalSummary`, `changesSummary`)
- `/packages/server/src/teams/team-manager.ts` 의 `buildInput`
- `/packages/server/test/teams/format.test.ts` (특히 "맥락 절감 측정" 케이스 — 수치를 갱신해야 한다), `team-manager.test.ts`

이전 phase 에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경

Phase 9 에서 **다른 팀원의** 승인·변경 카드를 턴 입력에서 뺐다. 자기 자신의 카드는 아직 한 줄씩 들어간다. 그런데 자기가 실행한 명령과 자기가 바꾼 파일은 **그 팀원의 세션 타임라인에 이미 있다**(에이전트는 자기 턴을 기억한다). 방 맥락에까지 넣을 이유가 없다.

실제 팀 측정: 그룹방 승인 카드 제목은 `npx eslint src 2>&1 | tail -30` 같은 bash 명령 원문이고, 렌더 기준 맥락의 20%를 차지했다.

## 확정된 결정 (바꾸지 마라)

- 턴 입력에서 **모든 승인·변경 카드를 뺀다**(자기 것 포함).
- `text`(사용자·에이전트)와 `system` 메시지는 그대로 둔다. 시스템 메시지는 홉 상한 안내, 서버 재시작 공지, 곁방 연결, **머지 충돌 해결 지시**를 나르므로 반드시 남아야 한다.
- 방 화면·방 로그는 건드리지 않는다. 사람은 승인·머지를 눌러야 한다.

## 작업

### 1. `src/teams/format.ts`

`isContextRelevant(message, memberId)` 를 고친다:

1. `kind: "approval"` → 항상 `false`.
2. `kind: "changes"` → 항상 `false`.
3. `kind: "text"` 이고 작성자가 자신 → `false`(현행 유지).
4. 그 외(`text` 남의 것·사용자, `system`) → `true`.

`memberId` 인자는 3번 때문에 여전히 필요하다. `approvalSummary`/`changesSummary` 는 더 이상 맥락에 쓰이지 않지만 **지우지 마라** — 트리거 메시지가 그 종류일 때 `formatMessageLine` 이 쓴다(트리거는 필터와 무관하게 항상 마지막에 들어간다). 그 사실을 주석으로 남긴다.

### 2. 문서

- `docs/PROTOCOL.md` 6.4 의 2026-09-14 문단을 갱신: "턴 입력에는 승인·변경 카드가 **전혀** 들어가지 않는다(자기 것 포함). 방 화면에는 남는다. 자기가 실행한 명령·바꾼 파일은 그 팀원 세션 타임라인에 이미 있다."(2026-09-15 갱신 표기)
- `docs/ADR.md` ADR-018 에 한 줄 추가: 자기 카드까지 제외하도록 2026-09-15 에 좁혔다는 사실과 이유.

### 3. 테스트 (먼저 쓴다)

- `format.test.ts`: `isContextRelevant` 표를 갱신 — 내 승인 카드 `false`, 내 변경 카드 `false`, 남의 것도 `false`, 내 text `false`, 남의 text `true`, 사용자 text `true`, system `true`.
- 트리거가 승인 카드일 때 `buildTurnText` 결과의 마지막 줄이 여전히 그 승인 요약인지(필터가 트리거를 먹지 않는지).
- **"맥락 절감 측정" 케이스 갱신**: 같은 corpus 로 필터 off / phase 9 규칙 / 이번 규칙 세 값을 비교해 단언하고, 주석에 실측 수치를 적는다. 그 수치를 summary 에도 적어라.
- `team-manager.test.ts`: 팀원 A 가 자기 턴에서 승인을 받고 파일을 바꾼 뒤, A 의 **다음 턴** 입력에 자기 승인·변경 줄이 없는지.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
bash scripts/dev-smoke.sh
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 방에 게시되는 메시지와 방 로그가 하나도 바뀌지 않았는가(필터는 턴 입력 전용)?
   - 시스템 메시지가 여전히 맥락에 들어가는가(머지 충돌 지시가 팀원에게 전달되는가)?
   - `format.ts` 가 순수 모듈로 남아 있는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(절감 수치 포함)
   - 실패 → `error` / 개입 필요 → `blocked` / 설계 분기 → `needs_input`

## 금지사항

- `system` 메시지를 필터하지 마라. 이유: 홉 상한·재시작·머지 충돌 지시가 이 종류로 전달된다.
- 방에 올라가는 카드를 줄이지 마라. 이유: 사람이 승인·머지해야 한다. 화면 정리는 step 1(iOS 묶기)이 한다.
- 상한 값(40건/12,000자)을 바꾸지 마라.
- iOS 를 수정하지 마라(step 1).
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라

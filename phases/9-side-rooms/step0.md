# Step 0: context-filter

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/PROTOCOL.md` 6.4 "턴 입력"(맥락 접두어·상한 규칙), 6.1 `RoomMessage`
- `/packages/server/src/teams/format.ts` 전체 (`buildTurnText`, `formatMessageLine`, `approvalSummary`, `changesSummary`)
- `/packages/server/src/teams/team-manager.ts` 의 `buildInput`(맥락 수집)과 `statusRooms`
- `/packages/server/test/teams/format.test.ts`, `team-manager.test.ts`

이전 phase 에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경: 실제로 측정된 문제

사용자의 실제 팀(5명, 그룹방 82개 메시지)을 분석한 결과:

- 방 구성: 대화 22건, **승인 카드 40건, 변경 카드 20건**. 승인 카드의 제목은 실행할 bash 명령 원문이다(`npx eslint src 2>&1 | tail -30` 등).
- 각 팀원 기준 **맥락의 57%가 자기와 무관한 내용**(팀장 92%, 기획자 91%).
- 렌더 기준 남의 카드가 맥락의 20%(4,945자).
- 상한(40건/12,000자) 초과로 이미 잘린 턴이 있다(팀장 2턴 중 1회, 리뷰어 6턴 중 1회 — 최대 55건/14,761자).

원인: `buildInput` 이 방의 메시지를 **필터 없이** 전부 턴 입력에 넣는다.

## 확정된 결정 (설계 인터뷰 결과, 바꾸지 마라)

- **다른 팀원의 승인·변경 카드는 턴 입력에서 완전히 뺀다.** 자기 것은 지금처럼 한 줄로 남긴다.
- 방 화면(UI)과 방 로그는 **그대로 둔다**. 사람은 승인·변경 카드를 봐야 머지·승인을 누른다. 거르는 것은 에이전트 턴 입력뿐이다.
- 팀장도 예외 없이 같은 필터를 받는다.
- 대화(`text`)와 시스템(`system`) 메시지는 거르지 않는다. 에이전트 간 잡담은 step 2 의 곁방이 분리한다.

## 작업

### 1. `src/teams/format.ts`

`buildTurnText` 의 `candidates` 필터를 확장한다. 순수 함수를 하나 노출해 테스트한다:

```ts
/** 이 팀원의 턴 입력에 넣을 메시지인가. `memberId` 는 턴을 도는 팀원. */
export function isContextRelevant(message: RoomMessage, memberId: string): boolean;
```

규칙(위에서부터 판정):

1. `kind: "approval"` → `message.approval?.memberId === memberId` 일 때만 포함.
2. `kind: "changes"` → `message.changes?.memberId === memberId` 일 때만 포함.
3. `kind: "text"` 이고 작성자가 자신 → 제외(현행 유지. 세션이 이미 기억한다).
4. 그 외(`text` 남의 것·사용자·`system`) → 포함.

`buildTurnText` 는 이 함수로 거른 뒤 기존 상한·정렬·생략 줄 로직을 그대로 적용한다. `omitted` 는 **상한 때문에 버린 개수만** 센다(필터로 뺀 것은 세지 않는다 — 그건 애초에 그 팀원의 대화가 아니다).

### 2. 문서

`docs/PROTOCOL.md` 6.4 "턴 입력" 문단에 한 줄 추가(2026-09-14 추가 표기): "턴 입력에는 **그 팀원 자신의** 승인·변경 카드만 한 줄로 들어간다. 다른 팀원의 카드는 방 화면에는 남지만 턴 입력에서는 제외된다(맥락 절약)."

### 3. 테스트 (먼저 쓴다)

- `test/teams/format.test.ts` 확장:
  - `isContextRelevant` 표 기반: 내 승인 카드 포함 / 남의 승인 카드 제외 / 내 변경 카드 포함 / 남의 변경 카드 제외 / 내 text 제외 / 남의 text 포함 / 사용자 text 포함 / system 포함.
  - `buildTurnText`: 남의 카드 20건 + 내 대화 2건을 넣으면 렌더 줄에 남의 카드가 하나도 없고, 상한을 넘지 않아 `omitted === 0`.
  - 기존 접두어·꼬리말·트리거 위치 테스트는 그대로 통과해야 한다. **트리거 메시지는 필터와 무관하게 항상 마지막에 넣는다**(남의 승인 카드가 트리거가 되는 일은 없지만, 방어적으로 명시).
- `test/teams/team-manager.test.ts` 확장: 팀원 A 가 승인을 요청·해결한 뒤 팀원 B 가 턴을 돌면, B 의 `startCalls`/Fake 입력 텍스트에 A 의 승인 카드 줄(`승인 요청`)이 **없고** A 의 대화 메시지는 있는지.

## Acceptance Criteria

```bash
npm ci
npm run typecheck
npm test
grep -q "isContextRelevant" packages/server/src/teams/format.ts
bash scripts/dev-smoke.sh
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 방 로그·방 화면에 나가는 내용은 하나도 바뀌지 않았는가(필터는 턴 입력 전용인가)?
   - 승인 응답·변경 머지 흐름이 그대로인가(기존 team-manager 테스트 전부 통과)?
   - `format.ts` 가 여전히 I/O 없는 순수 모듈인가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 방에 게시되는 메시지를 줄이거나 바꾸지 마라. 이유: 사람이 승인·머지하려면 UI 에는 다 보여야 한다.
- `text` 메시지를 필터하지 마라(내 것 제외는 현행 유지). 이유: 에이전트 간 대화 분리는 step 2 의 곁방이 한다.
- 상한 값(40건/12,000자)을 바꾸지 마라. 이유: 이번 변경의 효과를 따로 측정해야 한다.
- `packages/protocol` 을 수정하지 마라(문서 한 줄만).
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라

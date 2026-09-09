# Codex app-server 프로토콜 바인딩 (생성물)

이 디렉토리는 손으로 수정하지 않는다. Codex CLI 업데이트 시 아래 명령으로 재생성하고 `mapping.ts`/테스트를 다시 맞춘다(ADR-007).

```bash
codex --version   # codex-cli 0.153.4
codex app-server generate-ts --out packages/server/src/agents/codex/generated
```

- 생성 시점 codex 버전: **codex-cli 0.153.4**
- 타입 전용(ts-rs 생성). 요청/알림/서버요청 유니온은 `ClientRequest.ts`, `ServerNotification.ts`, `ServerRequest.ts`, v2 파라미터는 `v2/`.

# OpenInstinct (한국어)

내 Mac에 상주하면서 메뉴바 Chat 창으로 대화하는 개인 에이전트. iMessage는 선택 사항이며, 폰 문자도 쓰고 싶을 때 연결합니다. 가재는 읽고, 브라우저를 돌리고, 기억하고, 백그라운드 작업과 정기 감시를 실행하며, iMessage 레인이 연결되면 문자로도 답합니다. 캐릭터는 [gajae-code](https://github.com/Yeachan-Heo/gajae-code)의 **가재(Gajae)** — 터미널 세션 대신 항상 켜져 있는 데몬으로 돕니다.

아카이브 하나로 자기완결(bun 런타임과 `gjc` 포함), SIP는 켠 채로.

```
나 (Chat 창) ──제어 소켓──▶ openinstinctd
                              │
나 (iPhone) ──선택적 iMessage──▶ Mac의 Messages.app ──chat.db──▶ openinstinctd
                              │                                      │
                              └──AppleScript 전송── Messages.app ◀────┘
                                                                   │
                                       영구 gjc SDK 세션 하나
                                       ├─ 브라우저 (전용 Chrome 프로파일)
                                       ├─ 메모리 (git 저장소, BM25 검색)
                                       ├─ 백그라운드 자식 세션
                                       └─ 모니터 (cron / 파일 감시 / webhook)
```

## 하는 일

- **Chat 창**: 메뉴바 패널에서 여는 별도 iMessage풍 플레인 텍스트 대화창. AI 계정에 로그인하면 바로 쓸 수 있으며, Chat과 iMessage는 하나의 영구 세션과 공유 소유자 턴 ingress를 사용해 steering과 메모리를 일관되게 유지합니다.
- **선택적 iMessage**: 나중에 폰 handle을 연결하면 소유자 턴의 답장·이미지·입력 중·읽음 표시를 Messages로 미러링합니다. 레인이 분리되어도 Chat은 계속 작동합니다.
- **이미지**: 사진 보내면 봅니다. 가재가 스크린샷을 직접 볼 때는 그 사진이 나한테도 옵니다.
- **백그라운드 작업**: 느린 일(브라우징, 스크래핑, 긴 조사)은 자식 세션에서 돌고, "하는 중" 한 줄 뒤에 결과가 옵니다.
- **모니터**: "매일 9시에 캘린더 브리핑", "이 사이트 바뀌면 알려줘", "24시간만
  DM 감시" — cron, 파일 감시, webhook으로 채팅에서 만들고 메뉴바에서 끄거나
  지웁니다. **Run now**/`monitors.run`으로 예약과 무관하게 즉시 한 번 실행할 수도
  있습니다. 실패하면 가재가 먼저 진단하고 고칩니다.
- **메모리**: 모든 턴이 gajae-way 구조(daily → people/projects/decisions)의 git 저장소에 기록되고, 6시간마다 정리, 매일 점검, BM25로 검색됩니다. `memory.backfillCaptures`로 예전 소유자 교환을 원래 시각에 맞춰 중복 없이 보충할 수도 있습니다.
- **AI 계정**: 설정에서 기존 Claude, ChatGPT/Codex CLI 자격 증명을 찾아볼 수 있고, 소유자가 직접 **Adopt**를 눌러 선택한 계정만 채택합니다. 기존 구독을 과금할 수 있으므로 자동 채택하지 않습니다.
- **전용 Chrome**: 한 번만 로그인해두는 가재 전용 프로파일. 브라우저 툴은 여기에만 고정되며 내 개인 Chrome은 절대 건드리지 않습니다.
- **일일 제안**: 하루 한 번 내가 Mac을 어떻게 쓰는지 살펴보고 먼저 자동화를 제안합니다.
- **메뉴바 패널**: 상태를 쉬운 말로, 항상 쓸 수 있는 **Chat…** 창, 예약 작업, 일시정지/재개, 그리고 설정 창(AI 계정 — Claude/ChatGPT 등 OAuth 또는 커스텀 엔드포인트, 선택적 iMessage, 소유자, 브라우저, 제한, 성격).

## 설치 (일반 사용자)

터미널에 아래 한 줄:

```sh
curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/openinstinct/main/scripts/install-remote.sh | sh
```

`~/.openinstinct`에 설치하고 메뉴바 패널을 엽니다. 패널의 설정 UI에서 AI 계정(OAuth, API 키 또는 커스텀 엔드포인트)을 먼저 준비하면 Chat 창을 바로 사용할 수 있습니다. iMessage 신원, 전체 디스크 접근, 자동화, 문자 보내기 단계는 폰 문자용 선택적 iMessage 레인을 명시적으로 고른 뒤에만 표시됩니다. 각 선택한 단계의 상태는 실시간으로 갱신되며, **Accounts** 탭에서는 기존 CLI 자격 증명을 발견하고 소유자가 **Adopt**를 눌러야만 채택합니다. 셸로 바로 파이프하기 싫다면 [Releases](https://github.com/Yeachan-Heo/openinstinct/releases/latest)에서 `.tar.gz`를 받아 풀고 `sh <폴더>/scripts/bootstrap-from-payload.sh <폴더>`를 실행하세요. 자세한 건 [사용자 가이드](user-guide.md).

**iMessage를 연결하기 전에** 이 Mac의 Messages를 *전용* Apple ID로 로그인해두세요 — 선택적 레인이 그 Messages 계정을 쓰므로 내가 쓰는 계정에 붙이면 안 됩니다. 자세한 내용은 [운영 가이드](runbook.md)를 참고하세요.

## Chat 우선, 선택적 iMessage

Chat 창은 제어 소켓으로 데몬에 연결되며 AI 계정이 준비되면 사용할 수 있습니다. 전화번호, Messages, `chat.db`, 전체 디스크 접근, 자동화, 손쉬운 사용 권한은 Chat에 필요하지 않습니다. 폰 문자도 쓰려면 **Settings… → iMessage**에서 선택적 레인을 설정하세요. 전용 Apple ID에 대한 identity gate와 권한 화면은 이 선택을 한 뒤에만 나타나며, 레인이 분리되어도 공유 세션과 Chat은 계속 작동합니다.

## 설치 (개발자)

```sh
git clone … openinstinct && cd openinstinct
bun install
bash scripts/install.sh          # 데몬 + launchd + 패널 + presence 헬퍼
bash scripts/build-release.sh    # → dist/openinstinct-<version>-darwin-arm64.tar.gz
```

검증:

```sh
bun test daemon/test
bunx tsc --noEmit -p tsconfig.json
bash scripts/drills/failure-drills.sh
(cd panel && swift test)
```

## 구조

| 경로 | 내용 |

|---|---|
| `daemon/src/main.ts` | 데몬 조립: 부트스트랩, 수신 루프, 레인 |
| `daemon/src/imessage/` | chat.db 리더(커서, attributedBody), AppleScript 발신 |
| `daemon/src/sdk-session/` | 영구 메인 세션: 스티어, 워치독, 세그먼트, 리로드 |
| `daemon/src/children/` | 백그라운드 자식(인프로세스 SDK 또는 외부 `gjc`) |
| `daemon/src/monitors/` | 모니터 저장소, cron 스케줄러, 트리거, 전파/진단 |
| `daemon/src/memory/` | gajae-way 메모리 벤더링(`vendor/`) + 어댑터 + 툴 |
| `daemon/src/persona/` | `GAJAE_SOUL.md`(캐릭터), `RUNTIME.md`(환경) |
| `daemon/src/browser/` | 전용 Chrome 프로파일 강제 |
| `daemon/src/control/` | 패널용 NDJSON 유닉스 소켓 프로토콜 |
| `daemon/src/settings/` | 소유자 설정, gjc auth-broker 연동 |
| `panel/` | SwiftUI 메뉴바 앱 (`NSStatusItem` + popover + 별도 Chat 창 + Settings 창) |
| `presence/` | `oi-presence`: 손쉬운 사용으로 입력 중/읽음 표시 |
| `scripts/` | 설치, 릴리스 아카이브, 인수 테스트, soak, 장애 드릴 |
| `docs/` | [사용자 가이드](user-guide.md), [아키텍처](architecture.md), [운영 가이드](runbook.md) |

## 안 하는 것

그룹 채팅, 음성, 탭백을 명령으로 쓰기, 다중 소유자, 원격 접속, SIP 끄기.

## 라이선스

이 저장소의 라이선스를 따릅니다. `presence/`는 [beeper/platform-imessage](https://github.com/beeper/platform-imessage)(MIT)의 기법을 가져왔고 고지문을 포함합니다. `daemon/src/memory/vendor/`는 gajae-way의 특정 커밋을 복사한 것입니다(`daemon/src/memory/PROVENANCE.md`).

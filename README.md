# drake-mods

Claude Code mods.

| mod | 하는 일 |
| --- | --- |
| [prompt-recap](mods/prompt-recap) | 내가 한 질문, 작업 중에 덧붙인 말, 턴 결과 요약에 더해 세션의 목표·지금 하는 일·나를 기다리는 것·다음 단계를 오른쪽 창에 모아 보여준다. 질문을 누르면 대화의 그 위치로 이동한다. |

## 설치

Claude Code 2.1.287 이상. 세션 프롬프트에서:

```
/plugin install prompt-recap --marketplace jangjaeyong/drake-mods
```

마켓플레이스 추가를 물으면 `y`, 이어서 설치 범위를 고른다. 셸에서는:

```
claude plugin install prompt-recap --marketplace jangjaeyong/drake-mods
```

설치 뒤 `/reload-plugins` 또는 재시작. 셸(zsh, bash, PowerShell)이나 OS 와 무관하게 동작한다: 셸 명령, 파일, 환경변수를 쓰지 않는다.

## prompt-recap

`/prompt-recap` 으로 창을 연다.

```
◆ Goal: 로그인 기능 완성
  now: editing src/login.tsx
  next: 로그아웃 버튼
  waiting on you: 화면 확인
[ Full recap ] [ Summary: on ]

#2 로그아웃 버튼도 추가해줘
  … working

#1 로그인 페이지 추가해줘
  + 기존 폼 스타일 그대로 써줘
  → 로그인 페이지 추가, 기존 폼 스타일 적용  · 1m 23s
  ⏳ 화면 확인
```

위쪽: 세션 한눈에 보기

- `Goal` 세션 전체 목표, `now` 지금 하는 일(도구 호출로 실시간), `next` 다음 단계, `waiting on you` 나를 기다리는 것.
- `Full recap` (`r`): 최근 대화를 6줄 이내로 요약해 창에 보여준다. `/prompt-recap recap` 도 같다. `Hide` (`h`) 로 닫는다.
- `Summary: on/off` (`s`): 요약 켜기/끄기.

아래쪽: 질문 목록 (최신이 위)

- `#n` 줄: 내가 보낸 질문. 누르면 대화에서 그 질문 위치로 스크롤한다.
- `+` 줄: 그 턴이 도는 중에 덧붙인 말. ctrl+x enter 로 "차례 기다리기" 한 질문은 새 항목이 된다.
- `→` 줄: 턴 결과 요약과 걸린 시간.
- `⏳` 줄: 그 턴이 끝나고 나를 기다린 것.

### 요약 끄기

요약은 내 턴이 끝날 때마다 Haiku 를 한 번 불러 만든다(요금제 사용량에 잡힘). 끄면 모델 호출이 전혀 없고, `→` 줄에는 답변 첫 줄이 들어간다.

- 창에서 `Summary` 버튼 (`s`)
- `/prompt-recap summary off` / `/prompt-recap summary on`
- `/config` 의 "Turn summaries"

참고

- 오른쪽에 붙는 창과 질문 위치로 이동은 fullscreen 화면에서만 된다. `~/.claude/settings.json` 에 `"tui": "fullscreen"`. 기본 화면에서는 창이 입력창 위에 붙고 최근 3개만 보인다.
- 목록은 세션 안에서만 쌓인다. `/clear`, `/resume` 하면 비워지고, resume 이전 질문은 나오지 않는다.
- 슬래시 커맨드, 백그라운드 알림, 다른 mod 가 보낸 프롬프트는 넣지 않는다.
- where-am-i 와 같은 일을 하므로 둘 다 켜면 요약 호출이 두 번 나간다. 하나만 켠다.

## 개발

```
claude --plugin-dir mods/prompt-recap
claude plugin validate mods/prompt-recap
claude plugin test mods/prompt-recap
```

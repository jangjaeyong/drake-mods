# drake-mods

Claude Code mods. · Claude Code 용 mod 모음.

[English](#english) · [한국어](#한국어)

---

## English

| mod | What it does |
| --- | --- |
| [prompt-recap](mods/prompt-recap) | A pane beside the chat with your questions, what you added while Claude worked, and how each turn ended, plus the session at a glance: goal, what's happening now, what's waiting on you, next step. Press a question to jump back to it. |

### Install

Claude Code 2.1.287 or later. At the prompt of a session:

```
/plugin install prompt-recap --marketplace jangjaeyong/drake-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install prompt-recap --marketplace jangjaeyong/drake-mods
```

Then `/reload-plugins` or restart. It works the same on any shell (zsh, bash, PowerShell) and OS: it runs no shell commands and reads no files or environment variables.

### prompt-recap

Open the pane with `/prompt-recap`.

```
◆ Goal: finish the login feature
  now: editing src/login.tsx
  next: logout button
  waiting on you: check the screen
[ Full recap ] [ Summary: on ] [ Clear ]

#2 add a logout button too
  … working

#1 add a login page
  + reuse the existing form styles
  → login page added with the existing form styles  · 1m 23s
  ⏳ check the screen
```

Top: the session at a glance

- `Goal` what you are working toward now, `now` what Claude is doing (live, from its tool calls), `next` the next step, `waiting on you` what Claude needs from you.
- `Full recap` (`r`): the recent conversation in up to 6 bullets, in the pane. `/prompt-recap recap` does the same. `Hide` (`h`) closes it. It runs whenever you ask, even with summaries off.
- `Summary: on/off` (`s`): turn the automatic summaries on or off.
- `Clear` (no hotkey, so a stray key never wipes it) or `/prompt-recap clear`: empty the pane; numbering starts over.

Below: your questions, newest first

- `#n` line: a question you sent. Press it to scroll the conversation to it.
- `+` line: what you added while that turn ran. Press it to scroll to that message. A question you queued with ctrl+x enter (wait its turn) gets its own entry.
- `→` line: how the turn ended, and how long it took.
- `⏳` line: what was waiting on you when that turn ended.

#### Turning summaries off

With summaries on, a small model (Haiku) is called once after each turn you typed, whether or not the pane is open (it counts toward your plan's usage). Off, no automatic call is made and the `→` line shows the first line of the reply. Full recap still runs when you press it.

- `Summary` button in the pane (`s`)
- `/prompt-recap summary off` / `/prompt-recap summary on`
- "Turn summaries" in `/config`

#### Notes

- The pane docks on the right, and jumping scrolls the conversation, only in the fullscreen view: `"tui": "fullscreen"` in `~/.claude/settings.json`. In the classic view the pane sits above the prompt and shows the last 3 entries.
- Pane hotkeys work while the pane holds the keyboard (click it, or ctrl+x tab). Press Esc to go back to the prompt.
- The list lives for the session. `/clear` and `/resume` empty it, and questions from before a resume are not listed.
- Slash commands, background notifications and prompts other mods send are left out. Turns that end in an error, a refusal or an interrupt are not summarized (no model call).
- Jumping finds only rows that have been drawn on screen at least once. If you sent the same words several times ("ok", "continue"), it goes to the one drawn last.
- A message you send while a background notification's turn runs may, rarely, get that turn's answer if the turn ended before taking it.
- Changing the summary option reloads the mod: change it between turns (a turn running at that moment may lose its summary).
- It does what [where-am-i](https://github.com/hamzafer/claude-code-mods/tree/main/mods/where-am-i) does; with both on, summaries are made twice. Keep one.

---

## 한국어

| mod | 하는 일 |
| --- | --- |
| [prompt-recap](mods/prompt-recap) | 내가 한 질문, 작업 중에 덧붙인 말, 턴 결과 요약에 더해 세션의 목표·지금 하는 일·나를 기다리는 것·다음 단계를 오른쪽 창에 모아 보여준다. 질문을 누르면 대화의 그 위치로 이동한다. |

### 설치

Claude Code 2.1.287 이상. 세션 프롬프트에서:

```
/plugin install prompt-recap --marketplace jangjaeyong/drake-mods
```

마켓플레이스 추가를 물으면 `y`, 이어서 설치 범위를 고른다. 셸에서는:

```
claude plugin install prompt-recap --marketplace jangjaeyong/drake-mods
```

설치 뒤 `/reload-plugins` 또는 재시작. 셸(zsh, bash, PowerShell)이나 OS 와 무관하게 동작한다: 셸 명령, 파일, 환경변수를 쓰지 않는다.

### prompt-recap

`/prompt-recap` 으로 창을 연다.

```
◆ Goal: 로그인 기능 완성
  now: editing src/login.tsx
  next: 로그아웃 버튼
  waiting on you: 화면 확인
[ Full recap ] [ Summary: on ] [ Clear ]

#2 로그아웃 버튼도 추가해줘
  … working

#1 로그인 페이지 추가해줘
  + 기존 폼 스타일 그대로 써줘
  → 로그인 페이지 추가, 기존 폼 스타일 적용  · 1m 23s
  ⏳ 화면 확인
```

위쪽: 세션 한눈에 보기

- `Goal` 지금 하고 있는 일의 목표, `now` 지금 하는 일(도구 호출로 실시간), `next` 다음 단계, `waiting on you` 나를 기다리는 것.
- `Full recap` (`r`): 최근 대화를 6줄 이내로 요약해 창에 보여준다. `/prompt-recap recap` 도 같다. `Hide` (`h`) 로 닫는다. 요약을 꺼도 누르면 동작한다.
- `Summary: on/off` (`s`): 자동 요약 켜기/끄기.
- `Clear` (실수로 지워지지 않게 단축키 없음) 또는 `/prompt-recap clear`: 창을 비운다. 번호는 1부터 다시.

아래쪽: 질문 목록 (최신이 위)

- `#n` 줄: 내가 보낸 질문. 누르면 대화에서 그 질문 위치로 스크롤한다.
- `+` 줄: 그 턴이 도는 중에 덧붙인 말. 누르면 그 메시지 위치로 스크롤한다. ctrl+x enter 로 "차례 기다리기" 한 질문은 새 항목이 된다.
- `→` 줄: 턴 결과 요약과 걸린 시간.
- `⏳` 줄: 그 턴이 끝나고 나를 기다린 것.

#### 요약 끄기

요약을 켜 두면 내가 질문한 턴이 끝날 때마다 Haiku 를 한 번 부른다(창을 열지 않아도, 요금제 사용량에 잡힘). 끄면 자동 호출이 없고 `→` 줄에는 답변 첫 줄이 들어간다. Full recap 은 누르면 그때 한 번 호출한다.

- 창에서 `Summary` 버튼 (`s`)
- `/prompt-recap summary off` / `/prompt-recap summary on`
- `/config` 의 "Turn summaries"

#### 참고

- 오른쪽에 붙는 창과 질문 위치로 이동은 fullscreen 화면에서만 된다. `~/.claude/settings.json` 에 `"tui": "fullscreen"`. 기본 화면에서는 창이 입력창 위에 붙고 최근 3개만 보인다.
- 창 단축키는 창에 포커스가 있을 때(창 클릭 또는 ctrl+x tab) 동작한다. Esc 로 입력창에 돌아간다.
- 목록은 세션 안에서만 쌓인다. `/clear`, `/resume` 하면 비워지고, resume 이전 질문은 나오지 않는다.
- 슬래시 커맨드, 백그라운드 알림, 다른 mod 가 보낸 프롬프트는 넣지 않는다. 오류·거부·중단으로 끝난 턴은 요약하지 않는다(모델 호출 없음).
- 점프는 화면에 한 번이라도 그려진 질문 행만 찾는다. 같은 말("계속", "ok")을 여러 번 보냈으면 마지막으로 그려진 행으로 간다.
- 백그라운드 알림 턴이 도는 중에 보낸 말은, 그 턴이 말을 받기 전에 끝나면 드물게 알림 쪽 답변이 붙을 수 있다.
- 요약 켜기/끄기는 mod 를 다시 불러오므로 턴과 턴 사이에 바꾼다(도는 중에 바꾸면 그 턴 요약이 빠질 수 있다).
- [where-am-i](https://github.com/hamzafer/claude-code-mods/tree/main/mods/where-am-i) 와 같은 일을 하므로 둘 다 켜면 요약 호출이 두 번 나간다. 하나만 켠다.

---

## Development · 개발

```
claude --plugin-dir mods/prompt-recap
claude plugin validate mods/prompt-recap
claude plugin test mods/prompt-recap
```

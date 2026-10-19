# drake-mods

Claude Code mods. · Claude Code 용 mod 모음.

[English](#english) · [한국어](#한국어)

---

## English

| mod | What it does |
| --- | --- |
| [prompt-recap](mods/prompt-recap) | A pane beside the chat with your questions, what you added while Claude worked, and how each turn ended, plus the session at a glance (goal, what's happening now, what's waiting on you, next step) and the background agents at work. Press a question to jump back to it, an agent to watch it. |
| [boot-console](mods/boot-console) | IntelliJ's Run tab for a Spring Boot app, in a pane: Run, Stop, Restart, Build, with the app's log live. Compiles what changed and starts the main class from the compiled classes, no jar. Profile, JVM options and JDK per project. |

### Install

Claude Code 2.1.287 or later. At the prompt of a session (`<mod>` is `prompt-recap` or `boot-console`):

```
/plugin install <mod> --marketplace jangjaeyong/drake-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install <mod> --marketplace jangjaeyong/drake-mods
```

Then `/reload-plugins` or restart.

### prompt-recap

Open the pane with `/prompt-recap`. It works the same on any shell (zsh, bash, PowerShell) and OS: it runs no shell commands and reads no files or environment variables.

```
🎯 Goal: finish the login feature
  ⏳ now: editing src/login.tsx
  ⏭ next: logout button
  🔔 waiting on you: check the screen
[ 📋 Full recap ] [ Summary: on ] [ 🧹 Clear ] [ 🤖 Agents 1/2 ▴ ]
 ▌⏳ Fable review of the login code   fable · 3m 12s · 41 tools
      ↳ reading src/login.tsx
  ✓ Explore the auth module          Explore · 1m 03s · 12 tools
╭────────────────────────────────────────────╮
│▌#2 add a logout button too                █│
│▌  ⏳ working… · editing src/login.tsx      │
│                                           │
│ #1 add a login page                       │
│   ↳ reuse the existing form styles        │
│   ✓ login page added  · 1m 23s            │
│   🔔 check the screen                      │
╰────────────────────────────────────────────╯
```

Top: the session at a glance, and the background agents

- `Goal` what you are working toward now, `now` what Claude is doing (live, from its tool calls), `next` the next step, `waiting on you` what Claude needs from you.
- `Full recap` (`r`): the recent conversation in up to 6 bullets, at the top of the list. `/prompt-recap recap` does the same. `Hide` (`h`) closes it. It runs whenever you ask, even with summaries off.
- `Summary: on/off` (`s`): turn the automatic summaries on or off.
- `Clear` (no hotkey, so a stray key never wipes it) or `/prompt-recap clear`: empty the list; numbering starts over. Agents still at work stay.
- `Agents running/all`: the background agents of the session (subagents, a review run in the background), running ones first, up to 5: what each is for, its model, how long it has run, its tool calls, and for one at work what it did last. Press one to watch its transcript in the main view; `← Back to main` returns. The button folds the list.

Below: your questions, newest first, in a frame

- `#n` line: a question you sent. Press it to scroll the conversation to it.
- `↳` line: what you added while that turn ran. Press it to scroll to that message. A question you queued with ctrl+x enter (wait its turn) gets its own entry.
- The question at work is marked with a yellow bar down its left side, its `⏳ working…` line saying what Claude is doing; a finished one shows `✓` and how the turn ended, with how long it took.
- `🔔` line: what was waiting on you when that turn ended.
- Docked on the right, the top stays put and only the list scrolls: the wheel (3 rows a tick), the arrows and PageUp/PageDown (with the pane focused), or the scrollbar on its right, which you click to jump or drag.

#### Turning summaries off

With summaries on, a small model (Haiku) is called once after each turn you typed, whether or not the pane is open (it counts toward your plan's usage). Off, no automatic call is made and the `✓` line shows the first line of the reply. Full recap still runs when you press it.

- `Summary` button in the pane (`s`)
- `/prompt-recap summary off` / `/prompt-recap summary on`
- "Turn summaries" in `/config`

#### Notes

- The pane docks on the right, and jumping scrolls the conversation, only in the fullscreen view: `"tui": "fullscreen"` in `~/.claude/settings.json`. In the classic view the pane sits above the prompt and shows the last 3 entries; the Full recap button is hidden there, but `/prompt-recap recap` still works.
- Clear empties the pane, not the conversation: a turn still running keeps going, and what it does next shows up again.
- Pane hotkeys work while the pane holds the keyboard (click it, or ctrl+x tab). Press Esc to go back to the prompt.
- The list lives for the session. `/clear` and `/resume` empty it, and questions from before a resume are not listed.
- Slash commands, background notifications and prompts other mods send are left out. Turns that end in an error, a refusal or an interrupt are not summarized (no model call).
- Jumping finds only rows that have been drawn on screen at least once. If you sent the same words several times ("ok", "continue"), it goes to the one drawn last.
- A message you send while a background notification's turn runs may, rarely, get that turn's answer if the turn ended before taking it.
- Changing the summary option reloads the mod: change it between turns (a turn running at that moment may lose its summary).
- It does what [where-am-i](https://github.com/hamzafer/claude-code-mods/tree/main/mods/where-am-i) does; with both on, summaries are made twice. Keep one.
- Light on your computer: nothing animates (the hourglass stands still), and the only timer, every 3 seconds, asks after the agents only while there are any and redraws only while one runs.
- Kept for a resume: as each turn ends, the list (the latest 100 prompts) and the recap on top are saved by session in this plugin's own JSON file under your Claude Code folder (`~/.claude`), never sent anywhere. `claude --resume` or `--continue` brings them back at start; `/resume` inside Claude Code brings them back at your first prompt there. Only the latest 10 sessions are kept, the older ones deleted, and of each prompt its latest 10 follow-ups, so the file stays small (around 1 MB at most in typical use). A prompt still at work when you left shows `(interrupted)`. Clear forgets the session's saved list too; `/clear` does not, so a `/resume` back to that conversation brings it back.
- Agents only for now: background shell commands are not listed, as the engine gives no structured word of when one ends.

### boot-console

Open the pane with `/boot-console` in a Spring Boot project built with the Gradle wrapper (`gradlew`). `/boot-console run`, `stop`, `restart` and `build` do the same as the buttons.

```
demo  ● running since 13:02:11  · profile local
[ Stop ] [ Restart ] [ Clear ] [ Settings ▾ ]

$ C:/jdk-25/bin/java.exe ... org.gradle.wrapper.GradleWrapperMain ... bootConsoleArgs
BUILD SUCCESSFUL in 4s
$ C:/jdk-25/bin/java.exe -Dfile.encoding=UTF-8 ... @.../java.args --spring.profiles.active=local
2026-10-19 13:02:19  INFO  Started DemoApplication in 6.3 seconds
2026-10-19 13:02:25  WARN  ...                                      (yellow)
2026-10-19 13:02:31  ERROR ...                                      (red)
```

- `Run`: compiles what changed (Gradle `classes`), then starts the app. `Stop`: ends it, and frees its port. `Restart`: Stop, compile, start, as IntelliJ's Rerun. `Build`: compile only; errors show in the log. `Clear`: empty the log.
- Docked on the right, the top (status, buttons, settings) stays put and only the log, in its own frame, scrolls: the wheel (3 lines a tick), the arrows and PageUp/PageDown (with the pane focused), or the scrollbar on its right, which you click to jump to a place or drag. Scrolled up, new lines don't move what you read, and `Follow` goes back to the end.
- The log level alone is coloured, as IntelliJ's console does: INFO green, DEBUG and TRACE gray, WARN yellow, ERROR red. Lines with no level: stack frames dim red, `Caused by:` and build failures red.
- `Settings`: the profile (picked from `src/main/resources/application-*.yml`, or typed, comma-separated), the JVM options, the JDK home (empty: `JAVA_HOME`) and Gradle args (e.g. `--offline`, before the task). Kept per project; used from the next Run or Restart.
- From IntelliJ: until you save settings for a project, its IntelliJ Spring Boot run configuration (`.idea/workspace.xml`) gives the profile and the JVM options, so what the app needs from IntelliJ's VM options (a key, a path) comes along. `From IntelliJ` under Settings takes them again. Without one, the JVM options start as `-Dfile.encoding="UTF-8" -Dsun.stderr.encoding="UTF-8" -Dsun.stdout.encoding="UTF-8" -Djava.net.preferIPv4Stack=true`.
- A `-D` option whose name holds password, secret, token or credential shows as `****` in the log (it is still passed to the app, and kept in the settings as typed).
- How it runs: each Run writes a small Gradle init script to `build/boot-console/` and runs the `bootConsoleArgs` task it adds, which compiles and writes what `bootRun` would start (classpath and main class) as a java argument file. The mod then starts that JVM itself: one process, so Stop really ends it. Gradle starts the way `gradlew` starts it, java running the wrapper's jar (`gradle/wrapper/gradle-wrapper.jar`, so the project needs the Gradle wrapper): no cmd.exe, bat file or sh in between, so your shell (zsh, bash, PowerShell) and the OS's are not involved.

#### Notes

- For a single-project Gradle build with the default `build` folder, the Spring Boot plugin applied at the root.
- The JDK that runs the app should match the project's Java toolchain (a JDK 17 `JAVA_HOME` cannot run classes compiled for 25): set it under Settings when `JAVA_HOME` differs. With no `local` profile in the project, none is picked until you choose one.
- Keep the project and the Gradle cache on paths without non-ASCII characters: on Windows java reads its argument file in the system code page.
- The app lives as long as Claude Code's session: quitting Claude Code, `/reload-plugins` and updating the mod stop it.
- Stopping during a build ends the wait, but Gradle may finish its build in the background: give it a moment before the next Run, or two builds may write the same classes.
- Some apps read the active profile as a single value: if in doubt, run with one profile.
- No debugger: for breakpoints, use your IDE.
- If the first Run fails, the top of the log has the exact Gradle and java commands, and Gradle's error below them.

---

## 한국어

| mod | 하는 일 |
| --- | --- |
| [prompt-recap](mods/prompt-recap) | 내가 한 질문, 작업 중에 덧붙인 말, 턴 결과 요약에 더해 세션의 목표·지금 하는 일·나를 기다리는 것·다음 단계, 그리고 일하는 백그라운드 에이전트를 오른쪽 창에 모아 보여준다. 질문을 누르면 그 위치로, 에이전트를 누르면 그 에이전트 화면으로. |
| [boot-console](mods/boot-console) | Spring Boot 앱용 IntelliJ Run 탭을 창으로: Run, Stop, Restart, Build 와 실시간 로그. jar 없이 바뀐 것만 컴파일하고 컴파일된 클래스에서 main 을 바로 실행한다. 프로필, JVM 옵션, JDK 를 프로젝트별로. |

### 설치

Claude Code 2.1.287 이상. 세션 프롬프트에서(`<mod>` 는 `prompt-recap` 또는 `boot-console`):

```
/plugin install <mod> --marketplace jangjaeyong/drake-mods
```

마켓플레이스 추가를 물으면 `y`, 이어서 설치 범위를 고른다. 셸에서는:

```
claude plugin install <mod> --marketplace jangjaeyong/drake-mods
```

설치 뒤 `/reload-plugins` 또는 재시작.

### prompt-recap

`/prompt-recap` 으로 창을 연다. 셸(zsh, bash, PowerShell)이나 OS 와 무관하게 동작한다: 셸 명령, 파일, 환경변수를 쓰지 않는다.

```
🎯 Goal: 로그인 기능 완성
  ⏳ now: editing src/login.tsx
  ⏭ next: 로그아웃 버튼
  🔔 waiting on you: 화면 확인
[ 📋 Full recap ] [ Summary: on ] [ 🧹 Clear ] [ 🤖 Agents 1/2 ▴ ]
 ▌⏳ 로그인 코드 Fable 리뷰           fable · 3m 12s · 41 tools
      ↳ reading src/login.tsx
  ✓ 인증 모듈 탐색                    Explore · 1m 03s · 12 tools
╭────────────────────────────────────────────╮
│▌#2 로그아웃 버튼도 추가해줘               █│
│▌  ⏳ working… · editing src/login.tsx      │
│                                           │
│ #1 로그인 페이지 추가해줘                  │
│   ↳ 기존 폼 스타일 그대로 써줘             │
│   ✓ 로그인 페이지 추가  · 1m 23s           │
│   🔔 화면 확인                             │
╰────────────────────────────────────────────╯
```

위쪽: 세션 한눈에 보기와 백그라운드 에이전트

- `Goal` 지금 하고 있는 일의 목표, `now` 지금 하는 일(도구 호출로 실시간), `next` 다음 단계, `waiting on you` 나를 기다리는 것.
- `Full recap` (`r`): 최근 대화를 6줄 이내로 요약해 목록 맨 위에 보여준다. `/prompt-recap recap` 도 같다. `Hide` (`h`) 로 닫는다. 요약을 꺼도 누르면 동작한다.
- `Summary: on/off` (`s`): 자동 요약 켜기/끄기.
- `Clear` (실수로 지워지지 않게 단축키 없음) 또는 `/prompt-recap clear`: 목록을 비운다. 번호는 1부터 다시. 아직 일하는 에이전트는 남는다.
- `Agents 실행중/전체`: 세션의 백그라운드 에이전트(서브에이전트, 백그라운드로 돌린 리뷰). 실행 중인 것이 먼저, 최대 5개: 무슨 일인지, 모델, 실행 시간, 도구 호출 수, 일하는 중이면 마지막으로 한 일. 누르면 그 에이전트의 대화를 메인 화면에서 보고, `← Back to main` 으로 돌아온다. 버튼으로 목록을 접는다.

아래쪽: 질문 목록 (최신이 위), 테두리 안

- `#n` 줄: 내가 보낸 질문. 누르면 대화에서 그 질문 위치로 스크롤한다.
- `↳` 줄: 그 턴이 도는 중에 덧붙인 말. 누르면 그 메시지 위치로 스크롤한다. ctrl+x enter 로 "차례 기다리기" 한 질문은 새 항목이 된다.
- 처리 중인 질문은 왼쪽에 노란 막대가 붙고 `⏳ working…` 줄에 지금 하는 일이 나온다. 끝난 질문은 `✓` 와 결과 요약, 걸린 시간.
- `🔔` 줄: 그 턴이 끝나고 나를 기다린 것.
- 오른쪽에 붙은 창에서는 위쪽이 고정되고 목록만 스크롤된다: 휠(한 칸 3줄), 화살표, PageUp/PageDown(창에 포커스가 있을 때), 또는 오른쪽 스크롤바(클릭하면 그 위치로, 드래그로 이동).

#### 요약 끄기

요약을 켜 두면 내가 질문한 턴이 끝날 때마다 Haiku 를 한 번 부른다(창을 열지 않아도, 요금제 사용량에 잡힘). 끄면 자동 호출이 없고 `✓` 줄에는 답변 첫 줄이 들어간다. Full recap 은 누르면 그때 한 번 호출한다.

- 창에서 `Summary` 버튼 (`s`)
- `/prompt-recap summary off` / `/prompt-recap summary on`
- `/config` 의 "Turn summaries"

#### 참고

- 오른쪽에 붙는 창과 질문 위치로 이동은 fullscreen 화면에서만 된다. `~/.claude/settings.json` 에 `"tui": "fullscreen"`. 기본 화면에서는 창이 입력창 위에 붙고 최근 3개만 보인다. 이때 Full recap 버튼은 숨겨지지만 `/prompt-recap recap` 은 동작한다.
- Clear 는 창만 비우고 대화는 그대로다: 도는 중인 턴은 계속 진행되고, 그 뒤 하는 일은 다시 창에 나타난다.
- 창 단축키는 창에 포커스가 있을 때(창 클릭 또는 ctrl+x tab) 동작한다. Esc 로 입력창에 돌아간다.
- 목록은 세션 안에서만 쌓인다. `/clear`, `/resume` 하면 비워지고, resume 이전 질문은 나오지 않는다.
- 슬래시 커맨드, 백그라운드 알림, 다른 mod 가 보낸 프롬프트는 넣지 않는다. 오류·거부·중단으로 끝난 턴은 요약하지 않는다(모델 호출 없음).
- 점프는 화면에 한 번이라도 그려진 질문 행만 찾는다. 같은 말("계속", "ok")을 여러 번 보냈으면 마지막으로 그려진 행으로 간다.
- 백그라운드 알림 턴이 도는 중에 보낸 말은, 그 턴이 말을 받기 전에 끝나면 드물게 알림 쪽 답변이 붙을 수 있다.
- 요약 켜기/끄기는 mod 를 다시 불러오므로 턴과 턴 사이에 바꾼다(도는 중에 바꾸면 그 턴 요약이 빠질 수 있다).
- [where-am-i](https://github.com/hamzafer/claude-code-mods/tree/main/mods/where-am-i) 와 같은 일을 하므로 둘 다 켜면 요약 호출이 두 번 나간다. 하나만 켠다.
- 컴퓨터에 부담이 없게: 움직이는 애니메이션이 없고(모래시계는 멈춘 아이콘), 하나뿐인 3초 타이머는 에이전트가 있을 때만 상태를 묻고 실행 중일 때만 다시 그린다.
- resume 시 복원: 턴이 끝날 때마다 목록(최근 질문 100개)과 위쪽 요약을 세션별로 이 mod 전용 JSON 파일(Claude Code 폴더 `~/.claude` 아래)에 저장한다. 다른 곳으로 보내지 않는다. `claude --resume`·`--continue` 는 시작할 때, Claude Code 안의 `/resume` 은 그 세션에서 첫 질문을 보낼 때 되살린다. 최근 세션 10개만 남기고 오래된 것은 지우며, 질문마다 덧붙인 말은 최근 10개까지만 저장해 파일이 작게 유지된다(보통 1 MB 안팎). 나갈 때 처리 중이던 질문은 `(interrupted)` 로 보인다. Clear 하면 그 세션의 저장본도 지운다. `/clear` 는 지우지 않아 그 대화로 `/resume` 하면 돌아온다.
- 지금은 에이전트만: 백그라운드 셸 명령은 엔진이 끝났다는 신호를 구조화된 형태로 주지 않아 목록에 넣지 않는다.

### boot-console

Gradle wrapper(`gradlew`)로 빌드하는 Spring Boot 프로젝트에서 `/boot-console` 로 창을 연다. `/boot-console run`, `stop`, `restart`, `build` 는 버튼과 같다.

```
demo  ● running since 13:02:11  · profile local
[ Stop ] [ Restart ] [ Clear ] [ Settings ▾ ]

$ C:/jdk-25/bin/java.exe ... org.gradle.wrapper.GradleWrapperMain ... bootConsoleArgs
BUILD SUCCESSFUL in 4s
$ C:/jdk-25/bin/java.exe -Dfile.encoding=UTF-8 ... @.../java.args --spring.profiles.active=local
2026-10-19 13:02:19  INFO  Started DemoApplication in 6.3 seconds
2026-10-19 13:02:25  WARN  ...                                      (노랑)
2026-10-19 13:02:31  ERROR ...                                      (빨강)
```

- `Run`: 바뀐 것만 컴파일(Gradle `classes`)한 뒤 앱을 띄운다. `Stop`: 앱을 끄고 포트도 비운다. `Restart`: IntelliJ 의 Rerun 처럼 끄고, 컴파일하고, 다시 띄운다. `Build`: 컴파일만, 에러는 로그에. `Clear`: 로그 비우기.
- 오른쪽에 붙은 창에서는 위쪽(상태·버튼·설정)이 고정되고 테두리 안의 로그만 스크롤된다: 휠(한 칸 3줄), 화살표, PageUp/PageDown(창에 포커스가 있을 때), 또는 오른쪽 스크롤바(클릭하면 그 위치로, 드래그로 이동). 위로 올려 보는 동안 새 로그가 와도 보던 곳은 그대로이고, `Follow` 로 맨 아래로 돌아간다.
- IntelliJ 콘솔처럼 로그 레벨 글자에만 색을 입힌다: INFO 초록, DEBUG·TRACE 회색, WARN 노랑, ERROR 빨강. 레벨이 없는 줄은 스택트레이스 흐린 빨강, `Caused by:`·빌드 실패 빨강.
- `Settings`: 프로필(`src/main/resources/application-*.yml` 에서 고르거나, 콤마로 직접 입력), JVM 옵션, JDK 경로(비우면 `JAVA_HOME`), Gradle 인자(예: `--offline`, 태스크 앞에 붙음). 프로젝트별로 기억하고 다음 Run/Restart 부터 적용.
- IntelliJ 에서 가져오기: 그 프로젝트에서 설정을 저장하기 전까지는 IntelliJ 의 Spring Boot 실행 구성(`.idea/workspace.xml`)에서 프로필과 JVM 옵션을 가져온다. 그래서 IntelliJ VM 옵션에 들어 있던 앱에 필요한 값(키, 경로)도 같이 온다. Settings 의 `From IntelliJ` 로 언제든 다시 가져온다. 실행 구성이 없으면 JVM 옵션 기본값은 `-Dfile.encoding="UTF-8" -Dsun.stderr.encoding="UTF-8" -Dsun.stdout.encoding="UTF-8" -Djava.net.preferIPv4Stack=true`.
- 이름에 password, secret, token, credential 이 들어간 `-D` 옵션은 로그에 `****` 로 보인다(앱에는 그대로 넘어가고, 설정에는 입력한 대로 저장된다).
- 동작 방식: Run 마다 작은 Gradle init script 를 `build/boot-console/` 에 쓰고, 그 스크립트가 추가하는 `bootConsoleArgs` 태스크를 돌린다. 이 태스크가 컴파일하고 `bootRun` 이 띄울 것(classpath, main 클래스)을 java 인자 파일로 쓴다. 그다음 mod 가 그 JVM 을 직접 띄운다: 프로세스 하나라 Stop 이 확실하다. Gradle 은 `gradlew` 가 하는 방식 그대로 java 로 wrapper jar(`gradle/wrapper/gradle-wrapper.jar`, 그래서 Gradle wrapper 가 있는 프로젝트여야 한다)를 실행해 띄운다: cmd.exe, bat, sh 를 거치지 않아 쓰는 셸(zsh, bash, PowerShell)이나 OS 셸과 무관하다.

#### 참고

- 단일 프로젝트 Gradle 빌드, 기본 `build` 폴더, 루트에 Spring Boot 플러그인이 적용된 프로젝트용이다.
- 앱을 띄우는 JDK 는 프로젝트의 Java toolchain 과 맞아야 한다(JDK 17 인 `JAVA_HOME` 으로는 25 로 컴파일한 클래스를 못 띄운다): `JAVA_HOME` 이 다르면 Settings 에서 지정한다. 프로젝트에 `local` 프로필이 없으면 직접 고르기 전까지 프로필 없이 띄운다.
- 프로젝트와 Gradle 캐시 경로에 한글 같은 비 ASCII 문자가 없게 둔다: Windows 에서 java 가 인자 파일을 시스템 코드페이지로 읽는다.
- 앱은 Claude Code 세션이 살아 있는 동안만 돈다: Claude Code 종료, `/reload-plugins`, mod 업데이트 때 꺼진다.
- 빌드 중에 Stop 하면 기다림은 끝나지만 Gradle 은 뒤에서 빌드를 마칠 수 있다: 다음 Run 은 잠깐 기다렸다가 한다(안 그러면 두 빌드가 같은 클래스를 쓸 수 있다).
- 활성 프로필을 값 하나로 읽는 앱도 있다: 잘 모르면 프로필은 하나로 띄운다.
- 디버거 없음: 브레이크포인트는 IDE 에서.
- 첫 Run 이 실패하면 로그 맨 위에 실제 Gradle·java 명령이, 그 아래 Gradle 에러가 있다.

---

## Development · 개발

```
claude --plugin-dir mods/<mod>
claude plugin validate mods/<mod>
claude plugin test mods/<mod>
```

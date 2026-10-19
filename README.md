# drake-mods

Claude Code mods.

| mod | 하는 일 |
| --- | --- |
| [prompt-recap](mods/prompt-recap) | 내가 한 질문, 작업 중에 덧붙인 말, 턴이 끝난 결과 요약을 오른쪽 창에 모아 보여준다. 질문을 누르면 대화의 그 위치로 이동한다. |

## 설치

Claude Code 2.1.287 이상. 세션 프롬프트에서:

```
/plugin install prompt-recap --marketplace jangjaeyong/drake-mods
```

마켓플레이스 추가를 물으면 `y`, 이어서 설치 범위를 고른다. 셸에서는:

```
claude plugin install prompt-recap --marketplace jangjaeyong/drake-mods
```

설치 뒤 `/reload-plugins` 또는 재시작.

## prompt-recap

`/prompt-recap` 으로 창을 연다.

```
#2 로그아웃 버튼도 추가해줘
  … working

#1 로그인 페이지 추가해줘
  + 기존 폼 스타일 그대로 써줘
  → 로그인 페이지 추가, 기존 폼 스타일 적용  · 1m 23s
  ⏳ 화면 확인 부탁
```

- `#n` 줄: 내가 보낸 질문. 누르면 대화에서 그 질문 위치로 스크롤한다.
- `+` 줄: 그 턴이 도는 중에 덧붙인 말.
- `→` 줄: 턴 결과 요약과 걸린 시간. [where-am-i](https://github.com/hamzafer/claude-code-mods/tree/main/mods/where-am-i) 가 켜져 있으면 그 요약("now")을 쓰고, 없으면 답변의 첫 줄을 쓴다.
- `⏳` 줄: where-am-i 가 본 "나를 기다리는 것".

참고

- 오른쪽에 붙는 창과 질문 위치로 이동은 fullscreen 화면에서만 된다. `~/.claude/settings.json` 에 `"tui": "fullscreen"`. 기본 화면에서는 창이 입력창 위에 붙고 최근 3개만 보인다.
- 목록은 세션 안에서만 쌓인다. `/clear`, `/resume` 하면 비워진다.
- 슬래시 커맨드, 백그라운드 알림, 다른 mod 가 보낸 프롬프트는 넣지 않는다.

## 개발

```
claude --plugin-dir mods/prompt-recap
claude plugin validate mods/prompt-recap
claude plugin test mods/prompt-recap
```

/* @jsx h */
import type { EngineInterface, Register } from 'claude-code'
import { pickAuto, pickRandom, type AutoContext } from './games/auto.ts'
import { isBetter } from './games/best.ts'
import { feed, level, newPet, petEvent, stage, type Pet } from './games/pet.ts'

// One command, /arcade. With no argument it opens a pane beside the chat with a picker; `/arcade <game>`
// starts a game, `random` picks one, `auto` picks one for the moment, `list` prints them, `stop` closes.
// Each board in ./boards is a surface module that runs on the drawing thread; this module mounts the
// board, keeps each game's best score in $.store, pauses the open game when Claude finishes a turn,
// and feeds the pet from Claude's tool calls.
// cc-arcade by Seza Akgün (MIT), drawn in a pane rather than above the prompt.

type Game = { title: string; blurb: string; lowerIsBetter?: boolean; unit?: string }

const GAMES: Record<string, Game> = {
  snake: { title: 'Snake', blurb: 'eat, grow, and keep off the walls and yourself' },
  tetris: { title: 'Tetris', blurb: 'fit the falling pieces and clear lines' },
  '2048': { title: '2048', blurb: 'slide and merge tiles up to 2048' },
  minesweeper: { title: 'Minesweeper', blurb: 'open every cell that is not a mine', lowerIsBetter: true, unit: 's' },
  flappy: { title: 'Flappy', blurb: 'flap through the gaps in the pipes' },
  pong: { title: 'Pong', blurb: 'first to 5 against the computer' },
  typing: { title: 'Typing test', blurb: 'retype a line of code as fast as you can', unit: ' wpm' },
  invaders: { title: 'Space Invaders', blurb: 'shoot each wave before it lands' },
  doom: { title: 'Doom', blurb: 'a corridor shooter: imps, a shotgun, and the floor below' },
  pet: { title: 'Pet', blurb: 'grows as Claude tests, commits and edits' },
}
// spelled out: Object.keys would put the integer-like '2048' first
const NAMES = ['snake', 'tetris', 'doom', '2048', 'minesweeper', 'flappy', 'pong', 'typing', 'invaders', 'pet']
// random never lands on the pet: it is not a game you play
const PLAYABLE = NAMES.filter(n => n !== 'pet')
const PICKER = 'picker'
const PANE = 'arcade'
const TITLE = 'Arcade'
// a board's first mount in a pane loads the boards' surface module and is not painted: draw again after
const REDRAW_MS = 400
const isGame = (name: unknown): name is string => typeof name === 'string' && Object.hasOwn(GAMES, name)

// a game name, PICKER, or nothing open
let active: string | undefined
let lastGame: string | undefined
let turnStartedAt: number | undefined
// bumped at each finished turn; the open game pauses when it sees a new value
let turnsDone = 0
const best: Record<string, number> = {}
// a palette and pattern that do not lean on red against green; doom is the game that uses it
let safe = false
let pet: Pet | undefined

const isPet = (value: unknown): value is Pet => typeof value === 'object' && value !== null && typeof (value as Pet).xp === 'number'
const autoContext = (now: number): AutoContext => ({
  working: turnStartedAt !== undefined,
  turnMs: turnStartedAt === undefined ? 0 : now - turnStartedAt,
  lastEvent: pet?.last,
  lastEventAgoMs: pet ? now - pet.at : undefined,
  lastGame,
})

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // a store that cannot be read or written costs the pet and the scores, never the games:
    // an unhandled rejection here would unmount the whole module
    const stored = (key: string) => $.store.get(key).catch(err => { $.ui.log(`cc-arcade: store read failed: ${err}`); return undefined })
    const saved = await stored('pet')
    pet = isPet(saved) ? saved : newPet(await $.clock.now())
    if (!isPet(saved)) await $.store.set('pet', pet).catch(err => $.ui.log(`cc-arcade: store write failed: ${err}`))
    for (const name of NAMES) {
      const score = Number(await stored(`best:${name}`))
      if (score) best[name] = score
    }
    safe = (await stored('colorblind')) === true
    await $.command.register({
      name: 'arcade',
      description: 'Games in a pane beside the chat: pick one, or list, random, auto, stop',
      argumentHint: '[game | list | random | auto | colorblind | stop]',
      immediate: true,
    }).catch(err => $.ui.log(`cc-arcade: /arcade not registered: ${err}`))
    return r
  })

  // every form of /arcade answers here; none of them passes the command on
  on('command.run', { command: 'arcade' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const open = async (name: string, why?: string) => {
      active = name
      lastGame = name
      redrawBoard($)
      await $.ui.open({ id: PANE, title: TITLE })
      const how = name === 'pet' ? 'click it to pet it' : 'click the board to play · Esc returns to the prompt'
      return { text: `${GAMES[name].title}${why ? ` (${why})` : ''} · ${how} · /arcade stop closes` }
    }
    if (arg === '') {
      active = PICKER
      $.ui.invalidate('ui.render')
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: 'arcade: click a game in the pane · /arcade list describes them' }
    }
    if (arg === 'stop') {
      active = undefined
      await $.ui.close({ id: PANE }).catch(() => {})
      return { text: 'arcade closed' }
    }
    if (arg === 'colorblind' || arg === 'cb') {
      safe = !safe
      await $.store.set('colorblind', safe).catch(err => $.ui.log(`cc-arcade: store write failed: ${err}`))
      $.ui.invalidate('ui.render')
      return { text: `colour-blind mode ${safe ? 'on' : 'off'} · doom swaps in a palette that holds up without red against green, and marks the door and the exit with a pattern each` }
    }
    if (arg === 'list') {
      const rows = NAMES.map(n => {
        const score = best[n] ? ` · best ${best[n]}${GAMES[n].unit ?? ''}` : ''
        return `${n.padEnd(12)}${GAMES[n].blurb}${score}`
      })
      return { text: [...rows, '', 'random      a game you did not just play', 'auto        a game for the moment', `colorblind  doom without red against green (now ${safe ? 'on' : 'off'})`, 'stop        close the arcade'].join('\n') }
    }
    if (arg === 'random') return open(pickRandom(PLAYABLE, lastGame))
    if (arg === 'auto') {
      const pick = pickAuto(autoContext(await $.clock.now()))
      return open(pick.game, `auto: ${pick.reason}`)
    }
    if (isGame(arg)) return open(arg)
    return { text: `no game called "${arg}" · /arcade list shows them` }
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) turnStartedAt = await $.clock.now()
    return next(e)
  })

  // the main turn's end pauses the game; a subagent finishing does not
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    turnStartedAt = undefined
    if (active && active !== PICKER) {
      turnsDone++
      $.ui.invalidate('ui.render')
    }
    return r
  })

  // the pet feeds on work: a test run passing or failing, a commit, an edit. It is re-read from the
  // store first, so sessions running side by side feed the same pet instead of overwriting it.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    const command = (e as { command?: unknown }).command
    const event = petEvent(e.tool, typeof command === 'string' ? command : undefined, 'deny' in r ? undefined : !r.isError)
    if (!event) return r
    const saved = await $.store.get('pet').catch(() => undefined)
    const now = await $.clock.now()
    const current = isPet(saved) ? saved : pet ?? newPet(now)
    const fed = feed(current, event, now)
    pet = fed
    await $.store.set('pet', fed).catch(err => $.ui.log(`cc-arcade: store write failed: ${err}`))
    if (level(fed.xp) > level(current.xp)) {
      const grew = stage(fed.xp) !== stage(current.xp) ? `, and is now ${stage(fed.xp) === 'adult' ? 'an adult' : `a ${stage(fed.xp)}`}` : ''
      $.ui.toast(`pet: reached level ${level(fed.xp)}${grew}`)
    }
    if (active === 'pet') $.ui.invalidate('ui.render')
    return r
  })

  // a finished round, posted by a board: keep the best score and hand it back with the next props
  on('ui.message', async ($, e, next) => {
    const data = e.data as { game?: unknown; score?: unknown } | null
    const name = data?.game
    const score = data?.score
    if (!isGame(name) || typeof score !== 'number') return next(e)
    const game = GAMES[name]
    if (isBetter(score, best[name], game.lowerIsBetter)) {
      best[name] = score
      await $.store.set(`best:${name}`, score).catch(err => $.ui.log(`cc-arcade: store write failed: ${err}`))
      $.ui.toast(`${name}: new best ${score}${game.unit ?? ''}`)
    }
    return { props: { best: best[name] ?? 0, done: turnsDone, safe } }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = await $.ui.resolve(e)
    const { Box, Button, Text } = table
    const Client = 'Client' in table ? table.Client : undefined
    // boards need a terminal's keys and mouse
    if (e.surface !== 'terminal' || !Client) return <Text dimColor>{'arcade plays in the terminal'}</Text>
    // $.clock.now() answers a promise: read once per draw, for auto's pick and the pet's mood
    const now = await $.clock.now()
    // the pane is closed from its own buttons and /arcade stop
    const closePane = () => {
      active = undefined
      void $.ui.close({ id: PANE }).catch(() => {})
    }

    // open with nothing chosen (a reload keeps the pane, not the game): the picker
    if (!active || active === PICKER) {
      const choose = (name: string) => {
        if (name === 'close') return closePane()
        if (name === 'random') active = pickRandom(PLAYABLE, lastGame)
        else if (name === 'auto') {
          const pick = pickAuto(autoContext(now))
          active = pick.game
          $.ui.toast(`auto: ${pick.game}, ${pick.reason}`)
        } else active = name
        lastGame = active
        redrawBoard($)
      }
      return (
        <Box flexDirection="column">
          <Text dimColor>{'click a game · /arcade <game> works too · /arcade stop closes'}</Text>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {[...NAMES, 'random', 'auto', 'close'].map(name => (
              <Button key={`pick:${name}`} label={name} onPress={() => choose(name)} />
            ))}
          </Box>
        </Box>
      )
    }

    // the pane's room: its columns, and its rows less one for the back and close buttons
    const cols = e.props.bodyColumns || 60
    const rows = Math.max(8, (e.props.scroll?.bodyRows || 24) - 1)
    const tall = (max: number) => Math.min(rows, max)
    const props = { best: best[active] ?? 0, done: turnsDone, safe }
    // the key names the board, so switching mounts a fresh one and a redraw keeps the running one;
    // module paths must be string literals, since the engine reads them off this source
    const key = `board:${active}`
    const board =
      active === 'snake' ? <Client key={key} module="./boards/snake.tsx" width={cols} height={rows} props={props} />
      : active === 'tetris' ? <Client key={key} module="./boards/tetris.tsx" width={cols} height={tall(23)} props={props} />
      : active === '2048' ? <Client key={key} module="./boards/twenty48.tsx" width={cols} props={props} />
      : active === 'minesweeper' ? <Client key={key} module="./boards/minesweeper.tsx" width={cols} height={tall(12)} props={props} />
      : active === 'flappy' ? <Client key={key} module="./boards/flappy.tsx" width={cols} height={tall(19)} props={props} />
      : active === 'pong' ? <Client key={key} module="./boards/pong.tsx" width={cols} height={tall(18)} props={props} />
      : active === 'invaders' ? <Client key={key} module="./boards/invaders.tsx" width={cols} height={tall(19)} props={props} />
      // doom is a view, not a board: it takes every row and column the pane gives it
      : active === 'doom' ? <Client key={key} module="./boards/doom.tsx" width={cols} height={rows} props={props} />
      : active === 'pet' ? <Client key={key} module="./boards/pet.tsx" width={cols} props={{ pet, now }} />
      : <Client key={key} module="./boards/typing.tsx" width={cols} props={props} />
    // back to the picker, or close; click-only like the picker
    const toPicker = () => {
      active = PICKER
      $.ui.invalidate('ui.render')
    }
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Button key="arcade:back" label="← games" onPress={toPicker} />
          <Button key="arcade:close" label="close" onPress={closePane} />
        </Box>
        {board}
      </Box>
    )
  })
}

// Draws the pane now, and once more a moment later: the first board a session mounts in it loads the
// boards' surface module, and the frame drawn while that loads never reaches the screen.
function redrawBoard($: EngineInterface) {
  $.ui.invalidate('ui.render')
  $.clock.after(REDRAW_MS, () => $.ui.invalidate('ui.render'))
}

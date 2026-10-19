// Boot Console: build and run a Spring Boot app the way IntelliJ's Run does (compile what changed, then
// start its main class straight from the compiled classes), with its log live in a pane.
// Gradle compiles and writes what `bootRun` would start; the mod starts that JVM itself, one process,
// so Stop ends the app whole and frees its port. No shell of yours is used: the OS picks the launcher.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

import type { BootPhase, BootSettings, BootStatus } from '../types'

const PANE = 'boot-console'
const TITLE = 'Boot Console'
const DIR = 'build/boot-console' // in the project's build folder, which git leaves out
const INIT_SCRIPT = `${DIR}/init.gradle`
const ARGS_FILE = `${DIR}/java.args`
const TASK = 'bootConsoleArgs'
const MAX_LINES = 3000
const SHOWN_LINES = 400
const INLINE_LINES = 12 // an inline pane sits above the prompt: keep it short
const MAX_LINE = 500
const REDRAW_MS = 250
const WHEEL_LINES = 3 // log lines one wheel tick moves
const ENCODING = ['-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8'] // a piped JVM writes the OS code page otherwise
// What the JVM options field holds until it is changed for a project.
const DEFAULT_JVM_OPTIONS = '-Dfile.encoding="UTF-8" -Dsun.stderr.encoding="UTF-8" -Dsun.stdout.encoding="UTF-8" -Djava.net.preferIPv4Stack=true'
const STARTED = /\bStarted \S+ in [\d.]+ seconds?\b/
const IDEA_WORKSPACE = '.idea/workspace.xml' // IntelliJ keeps its run configurations here
const WRAPPER_JAR = 'gradle/wrapper/gradle-wrapper.jar'

// Written into the project for each Run: compiles the app and writes, as a java argument file, what
// `bootRun` would start (its classpath and main class). No Groovy `${}` here: this is a JS template.
const INIT_GRADLE = String.raw`// Written by the boot-console mod for each Run or Build; safe to delete.
gradle.rootProject { root ->
  root.plugins.withId('org.springframework.boot') {
    root.tasks.register('bootConsoleArgs') { task ->
      task.dependsOn { ['classes'] + (root.tasks.names.contains('resolveMainClassName') ? ['resolveMainClassName'] : []) }
      task.notCompatibleWithConfigurationCache('reads bootRun when it runs')
      def out = root.layout.buildDirectory.file('boot-console/java.args')
      task.doLast {
        def run = root.tasks.named('bootRun').get()
        def quote = { String s -> '"' + s.replace('\\', '/') + '"' }
        def entries = run.classpath.files.collect { it.absolutePath }
        def file = out.get().asFile
        file.parentFile.mkdirs()
        file.text = ['-cp', quote(entries.join(File.pathSeparator)), run.mainClass.get()].join('\n') + '\n'
        println 'boot-console: ' + run.mainClass.get() + ' with ' + entries.size() + ' classpath entries'
      }
    }
  }
}
`

const status = atom({ plugin: 'boot-console', key: 'status' } as const, { phase: 'idle', since: 0, detail: '' } as BootStatus)
const settings = atom({ plugin: 'boot-console', key: 'settings' } as const, { profile: '', jvmOptions: '', javaHome: '', gradleArgs: '' } as BootSettings)
const profiles = atom({ plugin: 'boot-console', key: 'profiles' } as const, [] as string[])
const javaPath = atom({ plugin: 'boot-console', key: 'javaPath' } as const, '')
const logVersion = atom({ plugin: 'boot-console', key: 'logVersion' } as const, 0)
const isSettingsOpen = atom({ plugin: 'boot-console', key: 'isSettingsOpen' } as const, false)

export type LineKind = 'info' | 'build' | 'out' | 'err'
type Line = { text: string; kind: LineKind }

// The run in flight. It lives in this module on purpose: unloading the module ends its child anyway.
const rt = {
  cwd: '',
  isWindows: false,
  run: 0, // the current run's id: pieces and ends of older runs are dropped
  isActive: false, // a Run or Build is under way: another press waits for Stop
  child: undefined as HookStream<ProcessSpawnChunk, ProcessSpawnResult> | undefined,
  stopping: undefined as Promise<void> | undefined, // the Stop under way, which a second one joins
  lines: [] as Line[],
  isRedrawDue: false,
  back: 0, // how many lines the log is scrolled up from its end; 0 follows the end
  isPinned: false, // the pane is docked and held to its height, so its log scrolls here
  // Runs a verb with the session's own $. A press hands its closure the $ of the drawing it was drawn
  // in, and a command the $ of its own dispatch; neither can start a child that outlives them, so the
  // children (Gradle, the app) are started with the $ the session started with.
  act: undefined as ((action: Action) => Promise<void>) | undefined,
}

type Action =
  | { verb: 'run' | 'stop' | 'restart' | 'build' | 'clear' | 'import' | 'follow' }
  | { verb: 'save'; patch: Partial<BootSettings> }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    rt.cwd = e.cwd
    rt.isWindows = isWindowsPath(e.cwd)
    rt.act = action => act($, action)
    // A reload ended any app this module had started: the pane says so rather than "running".
    await update($, status, () => ({ phase: 'idle', since: 0, detail: '' }))
    await loadSettings($).catch(() => {})
    await $.command.register({
      name: 'boot-console',
      description: 'Build and run the Spring Boot app with its log in a pane',
      argumentHint: '[run | stop | restart | build]',
    }).catch(() => {}) // a name Claude Code already has is refused: start anyway
    return r
  })

  on('command.run', { command: 'boot-console' }, async ($, e) => {
    const verb = e.args.trim().toLowerCase()
    await $.ui.open({ id: PANE, title: TITLE })
    if (verb === 'stop') await ask({ verb: 'stop' })
    else if (verb === 'run' || verb === 'restart' || verb === 'build') void ask({ verb })
    return { text: verb ? `Boot Console: ${verb}` : 'Boot Console opened' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const fields = 'Input' in table ? table : null // the mobile app draws no fields yet
    await read($, logVersion) // redraws as the log grows
    const st = await read($, status)
    const s = await read($, settings)
    const isOpen = await read($, isSettingsOpen)
    const found = await read($, profiles)
    const java = await read($, javaPath)
    const isInline = e.props.placement === 'inline'
    const isBusy = st.phase === 'building' || st.phase === 'starting' || st.phase === 'running'
    // Docked, the pane is held to its body's height: the top stays put and only the log scrolls, by
    // this mod (ui.scroll below), not by the engine. Inline above the prompt it keeps its natural height.
    const rows = e.props.scroll?.bodyRows ?? 0
    rt.isPinned = !isInline && rows > 0
    const shown = isInline
      ? rt.lines.slice(-INLINE_LINES)
      : visibleLines(rt.lines, rt.back, rt.isPinned ? rows : SHOWN_LINES, e.props.bodyColumns)
    const head = phaseLabel(st)
    const choices = [...new Set([...found, ...(s.profile ? [s.profile] : [])])]
    const pin = rt.isPinned ? { height: rows, overflow: 'hidden' as const } : {}
    const tail = rt.isPinned ? { flexGrow: 1, overflow: 'hidden' as const, justifyContent: 'flex-end' as const } : {}

    return (
      <Box flexDirection="column" gap={1} {...pin}>
        <Box flexDirection="column" flexShrink={0}>
          <Text wrap="wrap">
            <Text bold>{baseName(rt.cwd)}</Text>
            <Text>{'  '}</Text>
            <Text color={head.color}>{head.text}</Text>
            <Text dimColor>{s.profile ? `  · profile ${s.profile}` : '  · no profile'}</Text>
          </Text>
          <Box flexDirection="row" gap={1}>
            {isBusy ? (
              <Button key="stop" label="Stop" variant="primary" onPress={() => void ask({ verb: 'stop' })} />
            ) : (
              <Button key="run" label="Run" variant="primary" onPress={() => void ask({ verb: 'run' })} />
            )}
            {isBusy ? (
              <Button key="restart" label="Restart" onPress={() => void ask({ verb: 'restart' })} />
            ) : (
              <Button key="build" label="Build" onPress={() => void ask({ verb: 'build' })} />
            )}
            <Button key="clear" label="Clear" dimColor onPress={() => void ask({ verb: 'clear' })} />
            <Button key="settings" label={isOpen ? 'Settings ▴' : 'Settings ▾'} dimColor onPress={() => void update($, isSettingsOpen, v => !v)} />
            {rt.back > 0 && <Text color="yellow">{`↑ ${rt.back} lines up`}</Text>}
            {rt.back > 0 && <Button key="follow" label="Follow" dimColor onPress={() => void ask({ verb: 'follow' })} />}
          </Box>
        </Box>

        {isOpen && !fields && <Text dimColor>Settings are edited in the terminal or the desktop app.</Text>}
        {isOpen &&
          fields &&
          (() => {
            const { Select, Input } = fields
            return (
              <Box flexDirection="column" flexShrink={0}>
                {choices.length > 0 && (
                  <Select
                    key="profile"
                    label="Profile"
                    value={s.profile}
                    options={[{ value: '', label: '(none)' }, ...choices.map(value => ({ value }))]}
                    onSelect={value => void ask({ verb: 'save', patch: { profile: value } })}
                  />
                )}
                <Input
                  key="profileText"
                  label="Profiles (typed, comma-separated)"
                  placeholder="local"
                  value={s.profile}
                  onSubmit={value => void ask({ verb: 'save', patch: { profile: value.trim() } })}
                />
                <Input
                  key="jvm"
                  label="JVM options"
                  placeholder="-Xmx2g -Dfoo=bar"
                  value={s.jvmOptions}
                  onSubmit={value => void ask({ verb: 'save', patch: { jvmOptions: value.trim() } })}
                />
                <Input
                  key="javaHome"
                  label="JDK home"
                  placeholder="empty: JAVA_HOME"
                  value={s.javaHome}
                  onSubmit={value => void ask({ verb: 'save', patch: { javaHome: value.trim() } })}
                />
                <Input
                  key="gradleArgs"
                  label="Gradle args"
                  placeholder="--offline"
                  value={s.gradleArgs}
                  onSubmit={value => void ask({ verb: 'save', patch: { gradleArgs: value.trim() } })}
                />
                <Button key="fromIntellij" label="From IntelliJ" dimColor onPress={() => void ask({ verb: 'import' })} />
                <Text dimColor wrap="wrap">{`java: ${java || '(not found yet)'}  · applies from the next Run or Restart`}</Text>
              </Box>
            )
          })()}

        <Box key="log" flexDirection="column" {...tail}>
          {shown.length === 0 && <Text dimColor>Press Run to compile and start the app. Its log shows here.</Text>}
          {shown.map(line => {
            const t = tone(line)
            return (
              <Text color={t.color} dimColor={t.isDim} wrap="wrap">
                {line.text}
              </Text>
            )
          })}
        </Box>
      </Box>
    )
  })

  // The docked pane scrolls its log itself: the wheel, the arrows and the page keys move the log, and
  // the engine's window stays at the top, where the buttons are. Inline, the engine scrolls as usual.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (!rt.isPinned) return next(e)
    rt.back = scrolledBack(rt.back, e.pointer ? e.by * WHEEL_LINES : e.by, rt.lines.length)
    void update($, logVersion, n => n + 1).catch(() => {})
    return next({ ...e, offset: 0 })
  })
}

// What a press or a command asks for, done with the session's $ (see rt.act).
async function ask(action: Action) {
  if (!rt.act) rt.lines.push({ text: '(boot-console has not started in this session yet: /reload-plugins)', kind: 'err' })
  await rt.act?.(action).catch(() => {})
}

// An error as log lines: what failed and why, then where (the first frames of its stack).
function failure(what: string, err: unknown): string[] {
  const e = err as Error
  const frames = (e?.stack ?? '').split(/\r?\n/).filter(line => /^\s+at /.test(line)).slice(0, 3)
  return [`(${what}: ${e?.message ?? String(err)})`, ...frames.map(frame => `  ${frame.trim()}`)]
}

// A failure says which action it ended in the log, rather than nowhere.
async function act($: EngineInterface, action: Action) {
  try {
    if (action.verb === 'run') await start($)
    else if (action.verb === 'stop') await stop($)
    else if (action.verb === 'restart') await restart($)
    else if (action.verb === 'build') await buildOnly($)
    else if (action.verb === 'clear') await clearLog($)
    else if (action.verb === 'import') await importIntellij($)
    else if (action.verb === 'follow') await follow($)
    else if (action.verb === 'save') await saveSettings($, action.patch)
  } catch (err) {
    for (const text of failure(`${action.verb} failed`, err)) rt.lines.push({ text, kind: 'err' })
    redrawSoon($)
  }
}

// Compile, then start the app's JVM and follow its log until it ends or Stop.
async function start($: EngineInterface) {
  if (rt.isActive) return
  rt.isActive = true
  const id = ++rt.run
  try {
    const s = await read($, settings)
    const home = await resolveHome($, s)
    if (!(await compile($, id, home, s.gradleArgs))) return
    const argv = javaArgv(javaExe(home, rt.isWindows), s.jvmOptions, `${slashed(rt.cwd)}/${ARGS_FILE}`, s.profile)
    note($, `$ ${argv.map(maskSecret).join(' ')}`)
    await setStatusIf($, id, 'starting')
    if (id !== rt.run) return // stopped meanwhile: start nothing
    const code = await pump($, id, $.process.spawn({ argv, cwd: rt.cwd }), 'out')
    await setStatusIf($, id, code === 0 ? 'stopped' : 'failed', exitText(code))
  } finally {
    if (id === rt.run) rt.isActive = false
  }
}

// Compile only, as IntelliJ's Build does: the compile errors show in the log.
async function buildOnly($: EngineInterface) {
  if (rt.isActive) return
  rt.isActive = true
  const id = ++rt.run
  try {
    const s = await read($, settings)
    if (await compile($, id, await resolveHome($, s), s.gradleArgs)) await setStatusIf($, id, 'built')
  } finally {
    if (id === rt.run) rt.isActive = false
  }
}

// Ends what is running (the app, or the build under way) and drops whatever it still says. A new
// Run waits until the old JVM has ended, so its port is free; with nothing running it changes nothing.
// A second Stop while one is under way joins it rather than letting a Run in early.
function stop($: EngineInterface): Promise<void> {
  if (rt.stopping) return rt.stopping
  const stopping = stopNow($).finally(() => {
    if (rt.stopping === stopping) rt.stopping = undefined
  })
  rt.stopping = stopping
  return stopping
}

async function stopNow($: EngineInterface) {
  const child = rt.child
  const wasActive = rt.isActive || child !== undefined
  rt.run++
  rt.child = undefined
  if (child) {
    note($, '■ stopped')
    await child.return(undefined as never).catch(() => {}) // ends the child, even a quiet one
  }
  rt.isActive = false
  if (wasActive) await setStatus($, 'stopped', '')
}

async function restart($: EngineInterface) {
  await stop($) // waits for the old JVM to end, so its port is free
  await start($)
}

// Gradle compiles what changed and writes the java argument file. True when it can be started.
// A run Stop has passed over writes no status: only the current one says where the app is.
async function compile($: EngineInterface, id: number, home: string, gradleArgs: string): Promise<boolean> {
  if (id !== rt.run) return false
  await setStatusIf($, id, 'building')
  note($, `── ${new Date(await $.clock.now()).toTimeString().slice(0, 8)} ──`)
  const wrapper = `${slashed(rt.cwd)}/${WRAPPER_JAR}`
  if (!(await $.fs.exists(wrapper))) {
    note($, `no ${WRAPPER_JAR} in this project: boot-console runs Gradle through its wrapper`)
    await setStatusIf($, id, 'failed', 'no Gradle wrapper')
    return false
  }
  await $.fs.write(`${rt.cwd}/${INIT_SCRIPT}`, INIT_GRADLE)
  const env: Record<string, string> = {}
  if (home) env.JAVA_HOME = jdkRoot(home) // the JDK itself, even when the setting names its java
  const gradleOpts = [...tokenize((await $.env.get('JAVA_OPTS')) ?? ''), ...tokenize((await $.env.get('GRADLE_OPTS')) ?? '')]
  const argv = gradleArgv(javaExe(home, rt.isWindows), wrapper, gradleOpts, [
    ...tokenize(gradleArgs),
    '--console=plain',
    '--no-configuration-cache',
    '--init-script',
    INIT_SCRIPT,
    TASK,
  ])
  note($, `$ ${argv.map(maskSecret).join(' ')}`)
  rt.back = 0 // a new run is followed from its first line
  if (id !== rt.run) return false
  const code = await pump($, id, $.process.spawn({ argv, cwd: rt.cwd, env }), 'build')
  if (id !== rt.run) return false
  if (code !== 0) {
    await setStatusIf($, id, 'failed', `build ${exitText(code)}`)
    return false
  }
  return true
}

// Reads a child to its end, a line at a time into the log. Never waits on anything slow per piece:
// a child whose output goes unread blocks, and a Spring app logs a lot while it starts.
async function pump($: EngineInterface, id: number, child: HookStream<ProcessSpawnChunk, ProcessSpawnResult>, kind: 'build' | 'out'): Promise<number | null> {
  rt.child = child
  const partial = { stdout: '', stderr: '' }
  try {
    let piece = await child.next()
    while (!piece.done) {
      if (id === rt.run) {
        const { stream, text } = piece.value
        const [lines, rest] = splitChunk(partial[stream] + text)
        partial[stream] = rest
        for (const line of lines) take($, id, line, kindOf(kind, stream))
      }
      piece = await child.next()
    }
    if (id === rt.run) for (const stream of ['stdout', 'stderr'] as const) if (partial[stream] !== '') take($, id, partial[stream], kindOf(kind, stream))
    return piece.value?.code ?? null
  } catch (err) {
    if (id === rt.run) for (const line of failure(`${kind === 'build' ? 'Gradle' : 'the app'}'s output stopped`, err)) take($, id, line, 'err')
    return null
  } finally {
    if (rt.child === child) rt.child = undefined
  }
}

function take($: EngineInterface, id: number, raw: string, kind: LineKind) {
  const text = clean(raw)
  add({ text, kind })
  if (kind === 'out' && STARTED.test(text)) void setStatusIf($, id, 'running').catch(() => {})
  redrawSoon($)
}

function note($: EngineInterface, text: string) {
  add({ text, kind: 'info' })
  redrawSoon($)
}

// A line on the log. Scrolled up, the view stays on what it shows while new lines come in below.
function add(line: Line) {
  rt.lines.push(line)
  if (rt.lines.length > MAX_LINES) rt.lines.splice(0, rt.lines.length - MAX_LINES)
  if (rt.back > 0) rt.back = Math.min(rt.back + 1, rt.lines.length - 1)
}

// Back to the end of the log, following what comes.
async function follow($: EngineInterface) {
  rt.back = 0
  await update($, logVersion, n => n + 1)
}

// One redraw per REDRAW_MS at most, however fast the lines come.
function redrawSoon($: EngineInterface) {
  if (rt.isRedrawDue) return
  rt.isRedrawDue = true
  $.clock.after(REDRAW_MS, () => {
    rt.isRedrawDue = false
    void update($, logVersion, n => n + 1).catch(() => {})
  })
}

async function clearLog($: EngineInterface) {
  rt.lines = []
  rt.back = 0
  await update($, logVersion, n => n + 1)
}

// The log lines that fill `rows` rows ending `back` lines up from the end, a long line counted for the
// rows it wraps to. What still overflows (wide characters) is cut at the top, so the newest stays.
export function visibleLines<T extends { text: string }>(lines: T[], back: number, rows: number, columns: number): T[] {
  const end = Math.max(0, lines.length - back)
  const out: T[] = []
  let used = 0
  for (let i = end - 1; i >= 0 && used < rows; i--) {
    const line = lines[i] as T
    out.unshift(line)
    used += Math.max(1, Math.ceil(line.text.length / Math.max(1, columns)))
  }
  return out
}

// Where the log stands after a scroll of `by` rows (negative is up), between its end and its first line.
export function scrolledBack(back: number, by: number, total: number): number {
  return Math.min(Math.max(back - by, 0), Math.max(0, total - 1))
}

async function setStatus($: EngineInterface, phase: BootPhase, detail: string) {
  const since = await $.clock.now()
  await update($, status, () => ({ phase, since, detail }))
}

async function setStatusIf($: EngineInterface, id: number, phase: BootPhase, detail = '') {
  if (id === rt.run) await setStatus($, phase, detail)
}

// The settings for this project, and the profiles its resources name. Until any is saved here, the
// project's IntelliJ Spring Boot run configuration gives the profile and the JVM options, so a project
// that runs in IntelliJ runs here too (its VM options often carry what the app needs, a key, a path).
async function loadSettings($: EngineInterface) {
  const entries = await $.fs.list(`${rt.cwd}/src/main/resources`).catch(() => [])
  const found = profilesFrom(entries.filter(entry => entry.kind === 'file').map(entry => entry.name))
  const saved = ((await $.store.get(storeKey())) ?? {}) as Partial<BootSettings>
  const ide = saved.profile === undefined || saved.jvmOptions === undefined ? await readIntellij($) : undefined
  const next: BootSettings = {
    // local when the project has it; otherwise none, never a guess that could be prod's
    profile: saved.profile ?? (ide?.profiles || (found.includes('local') ? 'local' : '')),
    jvmOptions: saved.jvmOptions ?? (ide?.vmOptions || DEFAULT_JVM_OPTIONS),
    javaHome: saved.javaHome ?? '',
    gradleArgs: saved.gradleArgs ?? '',
  }
  if (ide) note($, `settings from IntelliJ run configuration "${ide.name}"`)
  await update($, profiles, () => found)
  await update($, settings, () => next)
  await update($, javaPath, () => '')
  await showJava($, next)
}

// Takes the profile and JVM options from the IntelliJ run configuration again, and keeps them.
async function importIntellij($: EngineInterface) {
  const ide = await readIntellij($)
  if (!ide) {
    note($, `no Spring Boot run configuration in ${IDEA_WORKSPACE}`)
    return
  }
  const s = await read($, settings)
  await saveSettings($, { profile: ide.profiles || s.profile, jvmOptions: ide.vmOptions || s.jvmOptions })
  note($, `settings from IntelliJ run configuration "${ide.name}"`)
}

async function readIntellij($: EngineInterface): Promise<IdeaRun | undefined> {
  const xml = await $.fs.read(`${rt.cwd}/${IDEA_WORKSPACE}`).catch(() => '')
  return typeof xml === 'string' && xml !== '' ? intellijRun(xml) : undefined
}

async function saveSettings($: EngineInterface, patch: Partial<BootSettings>) {
  const next = await update($, settings, s => ({ ...s, ...patch }))
  await $.store.set(storeKey(), next)
  await showJava($, next)
}

async function showJava($: EngineInterface, s: BootSettings) {
  const exe = javaExe(await resolveHome($, s), rt.isWindows)
  await update($, javaPath, () => exe)
}

// The JDK: the one set in the pane, else JAVA_HOME; '' leaves `java` to the PATH.
async function resolveHome($: EngineInterface, s: BootSettings) {
  return s.javaHome.trim() || ((await $.env.get('JAVA_HOME')) ?? '').trim()
}

function storeKey() {
  return `settings:${slashed(rt.cwd)}`
}

// Gradle through its wrapper, started the way gradlew and gradlew.bat start it: java runs the wrapper's
// jar. No cmd.exe, bat file or sh in between, so nothing depends on the OS's shell (and on Windows the
// engine's spawn of cmd.exe and .bat files hangs or fails now and then; java itself runs reliably).
export function gradleArgv(java: string, wrapperJar: string, jvmOptions: string[], args: string[]): string[] {
  return [java, '-Xmx64m', '-Xms64m', ...jvmOptions, ...ENCODING, '-Dorg.gradle.appname=gradlew', '-classpath', wrapperJar, 'org.gradle.wrapper.GradleWrapperMain', ...args]
}

// The java to start: a path to java itself as given, else the JDK's bin/java, else `java` on the PATH.
export function javaExe(home: string, isWindows: boolean): string {
  const h = home.trim().replace(/[\\/]+$/, '')
  if (h === '') return 'java'
  if (/(^|[\\/])java(\.exe)?$/i.test(h)) return h
  return `${h}/bin/${isWindows ? 'java.exe' : 'java'}`
}

export type IdeaRun = { name: string; vmOptions: string; profiles: string }

// The Spring Boot run configuration in IntelliJ's workspace file: the one selected there, else the
// first; the template IntelliJ keeps for new ones is left out.
export function intellijRun(xml: string): IdeaRun | undefined {
  const manager = /<component name="RunManager"([^>]*)>([\s\S]*?)<\/component>/.exec(xml)
  if (!manager) return undefined
  const selected = unescapeXml(/\bselected="([^"]*)"/.exec(manager[1] ?? '')?.[1] ?? '')
  const body = (manager[2] ?? '').replace(/<configuration\b[^>]*\/>/g, '') // self-closing ones hold nothing
  const runs: IdeaRun[] = []
  for (const m of body.matchAll(/<configuration\b([^>]*)>([\s\S]*?)<\/configuration>/g)) {
    const attrs = m[1] ?? ''
    if (!/\btype="SpringBootApplicationConfigurationType"/.test(attrs) || /\bdefault="true"/.test(attrs)) continue
    const option = (name: string) => unescapeXml(new RegExp(`<option name="${name}" value="([^"]*)"`).exec(m[2] ?? '')?.[1] ?? '')
    runs.push({ name: unescapeXml(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? ''), vmOptions: option('VM_PARAMETERS'), profiles: option('ACTIVE_PROFILES') })
  }
  return runs.find(run => selected === `Spring Boot.${run.name}`) ?? runs[0]
}

function unescapeXml(text: string) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

// A secret in a -D or -P option is not written to the log: -Dsome.password=x shows as -Dsome.password=****.
export function maskSecret(arg: string): string {
  return arg.replace(/^(-[DP][^=]*(password|passwd|secret|token|credential)[^=]*=).+$/i, '$1****')
}

// The JDK a setting names, for JAVA_HOME: a path to its java is taken back to the JDK's root.
export function jdkRoot(home: string): string {
  return home
    .trim()
    .replace(/[\\/]+$/, '')
    .replace(/[\\/]bin[\\/]java(\.exe)?$/i, '')
}

export function javaArgv(exe: string, jvmOptions: string, argsFile: string, profile: string): string[] {
  const active = profile.trim()
  return [exe, ...tokenize(jvmOptions), ...ENCODING, `@${argsFile}`, ...(active ? [`--spring.profiles.active=${active}`] : [])]
}

// JVM options split at spaces outside double quotes: -Dname="a b" stays one, without its quotes.
export function tokenize(text: string): string[] {
  return [...text.matchAll(/(?:[^\s"]+|"[^"]*")+/g)].map(m => m[0].replace(/"/g, ''))
}

// Whole lines out of what has come so far; the unfinished tail waits for the next piece.
export function splitChunk(text: string): [string[], string] {
  const parts = text.split(/\r?\n/)
  const rest = parts.pop() ?? ''
  return [parts, rest]
}

export function profilesFrom(names: string[]): string[] {
  const found = names.map(name => /^application-(.+)\.(ya?ml|properties)$/.exec(name)?.[1]).filter((p): p is string => p !== undefined)
  return [...new Set(found)].sort()
}

export function isStarted(line: string) {
  return STARTED.test(line)
}

// How a log line is drawn: errors red, their stack frames dimmer, warnings yellow, Gradle's own dim.
export function tone(line: { text: string; kind: LineKind }): { color?: string; isDim?: boolean } {
  const t = line.text
  if (line.kind === 'info') return { color: 'cyan' }
  if (/^\s+at |^\s*\.\.\. \d+ (more|common frames omitted)/.test(t)) return { color: 'red', isDim: true }
  if (/\.java:\d+: (warning|경고):/.test(t)) return { color: 'yellow' } // javac, in English or Korean
  if (/\b(ERROR|FATAL|SEVERE)\b|^Caused by:|^\S*(Exception|Error)(: |$)|BUILD FAILED|^FAILURE:|: (error|오류):|\.java:\d+: /.test(t)) return { color: 'red' }
  if (/\bWARN(ING)?\b|: (warning|경고):/.test(t)) return { color: 'yellow' }
  if (/BUILD SUCCESSFUL/.test(t) || STARTED.test(t)) return { color: 'green' }
  if (line.kind === 'build') return { isDim: true }
  if (line.kind === 'err') return { color: 'red' }
  return {}
}

function phaseLabel(st: BootStatus): { text: string; color?: string } {
  const at = st.since ? new Date(st.since).toTimeString().slice(0, 8) : ''
  const detail = st.detail ? ` (${st.detail})` : ''
  if (st.phase === 'building') return { text: '◐ compiling…', color: 'yellow' }
  if (st.phase === 'built') return { text: `✓ compiled ${at}`, color: 'green' }
  if (st.phase === 'starting') return { text: '◐ starting…', color: 'yellow' }
  if (st.phase === 'running') return { text: `● running since ${at}`, color: 'green' }
  if (st.phase === 'stopped') return { text: `■ stopped ${at}${detail}` }
  if (st.phase === 'failed') return { text: `✗ failed ${at}${detail}`, color: 'red' }
  return { text: '○ not running' }
}

function exitText(code: number | null) {
  return code === null ? 'ended' : `exit ${code}`
}

function kindOf(kind: 'build' | 'out', stream: 'stdout' | 'stderr'): LineKind {
  return kind === 'build' ? 'build' : stream === 'stderr' ? 'err' : 'out'
}

// Terminal colour codes out, and a line held to what a pane can show.
function clean(text: string) {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  return plain.length > MAX_LINE ? `${plain.slice(0, MAX_LINE - 1)}…` : plain
}

function isWindowsPath(path: string) {
  return /^[A-Za-z]:[\\/]/.test(path)
}

function slashed(path: string) {
  return path.replace(/\\/g, '/')
}

function baseName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

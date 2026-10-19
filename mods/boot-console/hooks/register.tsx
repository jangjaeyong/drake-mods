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
const ENCODING = ['-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8'] // a piped JVM writes the OS code page otherwise
// What the JVM options field holds until it is changed for a project.
const DEFAULT_JVM_OPTIONS = '-Dfile.encoding="UTF-8" -Dsun.stderr.encoding="UTF-8" -Dsun.stdout.encoding="UTF-8" -Djava.net.preferIPv4Stack=true'
const STARTED = /\bStarted \S+ in [\d.]+ seconds?\b/

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
const settings = atom({ plugin: 'boot-console', key: 'settings' } as const, { profile: '', jvmOptions: '', javaHome: '' } as BootSettings)
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
  lines: [] as Line[],
  isRedrawDue: false,
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    rt.cwd = e.cwd
    rt.isWindows = isWindowsPath(e.cwd)
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
    if (verb === 'run') void start($).catch(() => {})
    else if (verb === 'stop') await stop($)
    else if (verb === 'restart') void restart($).catch(() => {})
    else if (verb === 'build') void buildOnly($).catch(() => {})
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
    const shown = rt.lines.slice(-(isInline ? INLINE_LINES : SHOWN_LINES))
    const head = phaseLabel(st)
    const choices = [...new Set([...found, ...(s.profile ? [s.profile] : [])])]

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text wrap="wrap">
            <Text bold>{baseName(rt.cwd)}</Text>
            <Text>{'  '}</Text>
            <Text color={head.color}>{head.text}</Text>
            <Text dimColor>{s.profile ? `  · profile ${s.profile}` : '  · no profile'}</Text>
          </Text>
          <Box flexDirection="row" gap={1}>
            {isBusy ? (
              <Button key="stop" label="Stop" variant="primary" onPress={() => void stop($).catch(() => {})} />
            ) : (
              <Button key="run" label="Run" variant="primary" onPress={() => void start($).catch(() => {})} />
            )}
            {isBusy ? (
              <Button key="restart" label="Restart" onPress={() => void restart($).catch(() => {})} />
            ) : (
              <Button key="build" label="Build" onPress={() => void buildOnly($).catch(() => {})} />
            )}
            <Button key="clear" label="Clear" dimColor onPress={() => void clearLog($).catch(() => {})} />
            <Button key="settings" label={isOpen ? 'Settings ▴' : 'Settings ▾'} dimColor onPress={() => void update($, isSettingsOpen, v => !v)} />
          </Box>
        </Box>

        {isOpen && !fields && <Text dimColor>Settings are edited in the terminal or the desktop app.</Text>}
        {isOpen &&
          fields &&
          (() => {
            const { Select, Input } = fields
            return (
              <Box flexDirection="column">
                {choices.length > 0 && (
                  <Select
                    key="profile"
                    label="Profile"
                    value={s.profile}
                    options={[{ value: '', label: '(none)' }, ...choices.map(value => ({ value }))]}
                    onSelect={value => void saveSettings($, { profile: value }).catch(() => {})}
                  />
                )}
                <Input
                  key="profileText"
                  label="Profiles (typed, comma-separated)"
                  placeholder="local"
                  value={s.profile}
                  onSubmit={value => void saveSettings($, { profile: value.trim() }).catch(() => {})}
                />
                <Input
                  key="jvm"
                  label="JVM options"
                  placeholder="-Xmx2g -Dfoo=bar"
                  value={s.jvmOptions}
                  onSubmit={value => void saveSettings($, { jvmOptions: value.trim() }).catch(() => {})}
                />
                <Input
                  key="javaHome"
                  label="JDK home"
                  placeholder="empty: JAVA_HOME"
                  value={s.javaHome}
                  onSubmit={value => void saveSettings($, { javaHome: value.trim() }).catch(() => {})}
                />
                <Text dimColor wrap="wrap">{`java: ${java || '(not found yet)'}  · applies from the next Run or Restart`}</Text>
              </Box>
            )
          })()}

        <Box flexDirection="column">
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
}

// Compile, then start the app's JVM and follow its log until it ends or Stop.
async function start($: EngineInterface) {
  if (rt.isActive) return
  rt.isActive = true
  const id = ++rt.run
  try {
    const s = await read($, settings)
    const home = await resolveHome($, s)
    if (!(await compile($, id, home))) return
    const argv = javaArgv(javaExe(home, rt.isWindows), s.jvmOptions, `${slashed(rt.cwd)}/${ARGS_FILE}`, s.profile)
    note($, `$ ${argv.join(' ')}`)
    await setStatus($, 'starting', '')
    if (id !== rt.run) return // stopped meanwhile: start nothing
    const code = await pump($, id, $.process.spawn({ argv, cwd: rt.cwd }), 'out')
    if (id === rt.run) await setStatus($, code === 0 ? 'stopped' : 'failed', exitText(code))
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
    if (await compile($, id, await resolveHome($, await read($, settings)))) await setStatus($, 'built', '')
  } finally {
    if (id === rt.run) rt.isActive = false
  }
}

// Ends what is running (the app, or the build under way) and drops whatever it still says.
async function stop($: EngineInterface) {
  const child = rt.child
  rt.run++
  rt.isActive = false
  rt.child = undefined
  if (child) {
    note($, '■ stopped')
    await child.return(undefined as never).catch(() => {}) // ends the child, even a quiet one
  }
  await setStatus($, 'stopped', '')
}

async function restart($: EngineInterface) {
  await stop($) // waits for the old JVM to end, so its port is free
  await start($)
}

// Gradle compiles what changed and writes the java argument file. True when it can be started.
async function compile($: EngineInterface, id: number, home: string): Promise<boolean> {
  await setStatus($, 'building', '')
  note($, `── ${new Date(await $.clock.now()).toTimeString().slice(0, 8)} ──`)
  await $.fs.write(`${rt.cwd}/${INIT_SCRIPT}`, INIT_GRADLE)
  const env: Record<string, string> = { GRADLE_OPTS: `${(await $.env.get('GRADLE_OPTS')) ?? ''} ${ENCODING.join(' ')}`.trim() }
  if (home) env.JAVA_HOME = home
  const argv = gradleArgv(rt.isWindows, await $.env.get('ComSpec'), ['--console=plain', '--no-configuration-cache', '--init-script', INIT_SCRIPT, TASK])
  note($, `$ ${argv.join(' ')}`)
  note($, `java: ${javaExe(home, rt.isWindows)}`)
  void $.ui.scroll({ in: PANE, to: 'end' }).catch(() => {}) // follow the log until the person scrolls
  if (id !== rt.run) return false
  const code = await pump($, id, $.process.spawn({ argv, cwd: rt.cwd, env }), 'build')
  if (id !== rt.run) return false
  if (code !== 0) {
    await setStatus($, 'failed', `build ${exitText(code)}`)
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
    if (id === rt.run) take($, id, `(${(err as Error).message ?? String(err)})`, 'err')
    return null
  } finally {
    if (rt.child === child) rt.child = undefined
  }
}

function take($: EngineInterface, id: number, raw: string, kind: LineKind) {
  const text = clean(raw)
  rt.lines.push({ text, kind })
  if (rt.lines.length > MAX_LINES) rt.lines.splice(0, rt.lines.length - MAX_LINES)
  if (kind === 'out' && STARTED.test(text)) void setStatusIf($, id, 'running').catch(() => {})
  redrawSoon($)
}

function note($: EngineInterface, text: string) {
  rt.lines.push({ text, kind: 'info' })
  redrawSoon($)
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
  await update($, logVersion, n => n + 1)
}

async function setStatus($: EngineInterface, phase: BootPhase, detail: string) {
  const since = await $.clock.now()
  await update($, status, () => ({ phase, since, detail }))
}

async function setStatusIf($: EngineInterface, id: number, phase: BootPhase) {
  if (id === rt.run) await setStatus($, phase, '')
}

// The settings for this project, and the profiles its resources name.
async function loadSettings($: EngineInterface) {
  const entries = await $.fs.list(`${rt.cwd}/src/main/resources`).catch(() => [])
  const found = profilesFrom(entries.filter(entry => entry.kind === 'file').map(entry => entry.name))
  const saved = ((await $.store.get(storeKey())) ?? {}) as Partial<BootSettings>
  const next: BootSettings = {
    profile: saved.profile ?? (found.includes('local') ? 'local' : (found[0] ?? '')),
    jvmOptions: saved.jvmOptions ?? DEFAULT_JVM_OPTIONS,
    javaHome: saved.javaHome ?? '',
  }
  await update($, profiles, () => found)
  await update($, settings, () => next)
  await update($, javaPath, () => '')
  await showJava($, next)
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

// Gradle through its wrapper: cmd runs gradlew.bat on Windows, sh runs gradlew elsewhere.
export function gradleArgv(isWindows: boolean, comspec: string | undefined, args: string[]): string[] {
  return isWindows ? [comspec || 'cmd.exe', '/d', '/c', 'gradlew.bat', ...args] : ['sh', './gradlew', ...args]
}

// The java to start: a path to java itself as given, else the JDK's bin/java, else `java` on the PATH.
export function javaExe(home: string, isWindows: boolean): string {
  const h = home.trim().replace(/[\\/]+$/, '')
  if (h === '') return 'java'
  if (/(^|[\\/])java(\.exe)?$/i.test(h)) return h
  return `${h}/bin/${isWindows ? 'java.exe' : 'java'}`
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
  if (/\b(ERROR|FATAL|SEVERE)\b|^Caused by:|^\S*(Exception|Error)(: |$)|BUILD FAILED|^FAILURE:|: error:/.test(t)) return { color: 'red' }
  if (/\bWARN(ING)?\b|: warning:/.test(t)) return { color: 'yellow' }
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

import { describe, expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

import { gradleArgv, isStarted, javaArgv, javaExe, jdkRoot, profilesFrom, splitChunk, tokenize, tone } from '../hooks/register'

const PANE = { component: 'Pane', requestId: 'boot-console', props: { title: 'Boot Console', isFocused: false, bodyColumns: 100, placement: 'dock' } }
const WIN = 'C:/work/demo'
const GRADLE_TAIL = ['--console=plain', '--no-configuration-cache', '--init-script', 'build/boot-console/init.gradle', 'bootConsoleArgs']
const DEFAULT_JVM = ['-Dfile.encoding=UTF-8', '-Dsun.stderr.encoding=UTF-8', '-Dsun.stdout.encoding=UTF-8', '-Djava.net.preferIPv4Stack=true']

type Piece = { stream: 'stdout' | 'stderr'; text: string }
type Child = (e: { argv: string[] }) => AsyncGenerator<Piece, { code: number | null; signal: string | null }>

async function* gradleOk() {
  yield { stream: 'stdout', text: '> Task :compileJava\n> Task :bootConsole' } as Piece
  yield { stream: 'stdout', text: 'Args\nboot-console: com.example.DemoApplication with 3 classpath entries\nBUILD SUCCESSFUL in 2s\n' } as Piece
  return { code: 0, signal: null }
}

async function* gradleFails() {
  yield { stream: 'stderr', text: 'Demo.java:3: error: cannot find symbol\n' } as Piece
  yield { stream: 'stderr', text: 'BUILD FAILED in 1s\n' } as Piece
  return { code: 1, signal: null }
}

// A JVM that starts, then stays up until `release` lets it say one more thing and end.
function javaUp() {
  let release = () => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  async function* child() {
    yield { stream: 'stdout', text: 'Starting DemoApplication using Java 25\n' } as Piece
    yield { stream: 'stdout', text: '2026-10-19 INFO Started DemoApplication in 3.21 seconds (process running for 3.6)\n' } as Piece
    await gate
    yield { stream: 'stdout', text: 'a line after Stop\n' } as Piece
    return { code: 143, signal: null }
  }
  return { child, release: () => release() }
}

// A Gradle that compiles until `release` lets it finish.
function gradleHeld() {
  let release = () => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  async function* child() {
    yield { stream: 'stdout', text: '> Task :compileJava\n' } as Piece
    await gate
    yield { stream: 'stdout', text: 'BUILD SUCCESSFUL in 9s\n' } as Piece
    return { code: 0, signal: null }
  }
  return { child, release: () => release() }
}

// A JVM per start, each up until its own release; `ends` records the order they end in.
function javas() {
  const releases: (() => void)[] = []
  const ends: number[] = []
  function child() {
    const n = releases.length
    let release = () => {}
    const gate = new Promise<void>(resolve => (release = resolve))
    releases.push(() => release())
    return (async function* () {
      try {
        yield { stream: 'stdout', text: `Started DemoApplication in 1.0 seconds (process running for ${n})\n` } as Piece
        await gate
        yield { stream: 'stdout', text: 'bye\n' } as Piece
        return { code: 143, signal: null }
      } finally {
        ends.push(n)
      }
    })()
  }
  return { child, release: (n: number) => releases[n]?.(), ends, count: () => releases.length }
}

// The engine beneath the mod: files, the pane, and the two children it may start.
function world(on: any, children: { gradle: Child; java: Child }, resources = ['application.yml', 'application-dev.yml', 'application-local.yml']) {
  const spawns: { argv: string[]; cwd?: string; env?: Record<string, string> }[] = []
  const writes: { path: string; text: string }[] = []
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  on('fs.list', () => ({ value: [...resources.map(name => ({ name, kind: 'file' })), { name: 'static', kind: 'dir' }] }))
  on('fs.write', (_$: any, e: any) => (writes.push({ path: String(e.path).replace(/\\/g, '/'), text: e.text }), { value: undefined }))
  on('process.spawn', async function* (_$: any, e: any) {
    spawns.push(e)
    const isGradle = e.argv.includes('gradlew.bat') || e.argv.includes('./gradlew')
    const result = yield* (isGradle ? children.gradle : children.java)(e)
    return { value: result } // a stream hook ends with { value }
  })
  return { spawns, writes }
}

const start = (cwd: string) => ({ surface: 'terminal', isInteractive: true, cwd }) as any

describe('the pieces', () => {
  test('runs Gradle through its wrapper by the OS, not by your shell', async () => {
    expect(gradleArgv(true, 'C:\\Windows\\system32\\cmd.exe', ['classes'])).toEqual(['C:\\Windows\\system32\\cmd.exe', '/d', '/c', 'gradlew.bat', 'classes'])
    expect(gradleArgv(true, undefined, ['classes'])).toEqual(['cmd.exe', '/d', '/c', 'gradlew.bat', 'classes'])
    expect(gradleArgv(false, undefined, ['classes'])).toEqual(['sh', './gradlew', 'classes'])
  })

  test('finds java from the JDK home, a path to java itself, or the PATH', async () => {
    expect(javaExe('C:\\jdk-25', true)).toBe('C:\\jdk-25/bin/java.exe')
    expect(javaExe('/opt/jdk-25/', false)).toBe('/opt/jdk-25/bin/java')
    expect(javaExe('C:\\jdk-25\\bin\\java.exe', true)).toBe('C:\\jdk-25\\bin\\java.exe')
    expect(javaExe('/usr/bin/java', false)).toBe('/usr/bin/java')
    expect(javaExe('', true)).toBe('java')
  })

  test('gives Gradle the JDK itself as JAVA_HOME, even when the setting names its java', async () => {
    expect(jdkRoot('C:\\jdk-25\\bin\\java.exe')).toBe('C:\\jdk-25')
    expect(jdkRoot('/opt/jdk-25/bin/java')).toBe('/opt/jdk-25')
    expect(jdkRoot('/opt/jdk-25/')).toBe('/opt/jdk-25')
    expect(jdkRoot('C:\\jdk-25')).toBe('C:\\jdk-25')
  })

  test('starts the JVM with your options, UTF-8 output, the argument file and the profile', async () => {
    expect(javaArgv('java', '-Xmx2g  -Dmode="a b"', '/w/build/boot-console/java.args', 'local,debug')).toEqual([
      'java',
      '-Xmx2g',
      '-Dmode=a b',
      '-Dstdout.encoding=UTF-8',
      '-Dstderr.encoding=UTF-8',
      '@/w/build/boot-console/java.args',
      '--spring.profiles.active=local,debug',
    ])
    expect(javaArgv('java', '', '/a', ' ')).toEqual(['java', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', '@/a'])
    expect(tokenize('')).toEqual([])
  })

  test('cuts output into whole lines, keeping an unfinished one for the next piece', async () => {
    expect(splitChunk('a\r\nb\nc')).toEqual([['a', 'b'], 'c'])
    expect(splitChunk('done\n')).toEqual([['done'], ''])
    expect(splitChunk('partial')).toEqual([[], 'partial'])
  })

  test('lists the profiles the resources name', async () => {
    expect(profilesFrom(['application.yml', 'application-local.yml', 'application-dev.yaml', 'application-prod.properties', 'logback.xml'])).toEqual(['dev', 'local', 'prod'])
  })

  test('colours errors, their stack frames, warnings and success', async () => {
    expect(tone({ text: '2026 ERROR 123 --- [main] o.s.boot.SpringApplication : failed', kind: 'out' })).toEqual({ color: 'red' })
    expect(tone({ text: '\tat com.example.Demo.main(Demo.java:3)', kind: 'out' })).toEqual({ color: 'red', isDim: true })
    expect(tone({ text: 'Caused by: java.net.BindException: Address already in use', kind: 'out' })).toEqual({ color: 'red' })
    expect(tone({ text: '2026  WARN 123 --- [main] HikariPool-1 : slow', kind: 'out' })).toEqual({ color: 'yellow' })
    expect(tone({ text: 'BUILD SUCCESSFUL in 2s', kind: 'build' })).toEqual({ color: 'green' })
    expect(tone({ text: '> Task :compileJava', kind: 'build' })).toEqual({ isDim: true })
    expect(tone({ text: '2026  INFO 1 --- Tomcat started on port 8080', kind: 'out' })).toEqual({})
    expect(isStarted('Started DemoApplication in 3.21 seconds (process running for 3.6)')).toBe(true)
    expect(isStarted('Starting DemoApplication')).toBe(false)
  })
})

describe('boot-console', () => {
  test('Run compiles with Gradle, then starts the JVM itself with the profile, and shows it running', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    mock.store(on)
    mock.env(on, { JAVA_HOME: 'C:\\jdk-25', ComSpec: 'C:\\Windows\\system32\\cmd.exe' })
    const java = javaUp()
    const w = world(on, { gradle: gradleOk, java: java.child })
    await $.session.start(start(WIN))

    expect((await $.command.run({ command: 'boot-console', args: 'run' } as any)).text).toBe('Boot Console: run')
    await clock.settle()

    expect(w.writes[0]?.path).toBe(`${WIN}/build/boot-console/init.gradle`)
    expect(w.writes[0]?.text).toContain("register('bootConsoleArgs')")
    expect(w.spawns[0]?.argv).toEqual(['C:\\Windows\\system32\\cmd.exe', '/d', '/c', 'gradlew.bat', ...GRADLE_TAIL])
    expect(w.spawns[0]?.env?.JAVA_HOME).toBe('C:\\jdk-25')
    expect(w.spawns[0]?.env?.GRADLE_OPTS).toBe('-Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8')
    expect(w.spawns[1]?.argv).toEqual([
      'C:\\jdk-25/bin/java.exe',
      ...DEFAULT_JVM, // the JVM options a project starts with
      '-Dstdout.encoding=UTF-8',
      '-Dstderr.encoding=UTF-8',
      `@${WIN}/build/boot-console/java.args`,
      '--spring.profiles.active=local',
    ])

    const ui = await $.ui.mount({ plugin: 'boot-console', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /● running since/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Started DemoApplication in 3\.21 seconds/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'boot-console: com.example.DemoApplication with 3 classpath entries' })).toBeDefined() // a line split across two pieces
    expect(await ui.find({ type: 'Button', key: 'stop' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'run' })).toBeUndefined()
    await ui.unmount()
    java.release()
    await clock.settle()
  })

  test('Stop ends the JVM, drops what it says after, and offers Run again', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    mock.store(on)
    mock.env(on, { JAVA_HOME: 'C:\\jdk-25' })
    const java = javaUp()
    world(on, { gradle: gradleOk, java: java.child })
    await $.session.start(start(WIN))
    await $.command.run({ command: 'boot-console', args: 'run' } as any)
    await clock.settle()

    const stopping = $.command.run({ command: 'boot-console', args: 'stop' } as any)
    java.release() // the child reaches its next piece, where the stop lands
    await stopping
    await clock.settle()

    const ui = await $.ui.mount({ plugin: 'boot-console', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /■ stopped/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'a line after Stop' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'run' })).toBeDefined()
    await ui.unmount()
  })

  test('a failed build shows its errors and starts no JVM', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    mock.store(on)
    mock.env(on, {})
    const w = world(on, { gradle: gradleFails, java: javaUp().child })
    await $.session.start(start(WIN))
    await $.command.run({ command: 'boot-console', args: 'run' } as any)
    await clock.settle()

    expect(w.spawns).toHaveLength(1)
    const ui = await $.ui.mount({ plugin: 'boot-console', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /✗ failed .*\(build exit 1\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Demo.java:3: error: cannot find symbol' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'run' })).toBeDefined()
    await ui.unmount()
  })

  test('Build compiles only', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    mock.store(on)
    mock.env(on, {})
    const w = world(on, { gradle: gradleOk, java: javaUp().child })
    await $.session.start(start(WIN))
    await $.command.run({ command: 'boot-console', args: 'build' } as any)
    await clock.settle()

    expect(w.spawns).toHaveLength(1)
    const ui = await $.ui.mount({ plugin: 'boot-console', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /✓ compiled/ })).toBeDefined()
    await ui.unmount()
  })

  test('settings are kept per project and used by the next Run', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    mock.store(on)
    mock.env(on, {})
    const java = javaUp()
    const w = world(on, { gradle: gradleOk, java: java.child })
    await $.session.start(start('/home/me/demo'))

    const ui = (await $.ui.mount({ plugin: 'boot-console', surface: 'terminal', ...PANE } as any)) as Mounted<'terminal', 'Pane'>
    await ui.press({ key: 'settings' })
    await ui.input({ key: 'jvm', text: '-Xmx2g -Dmode="a b"' })
    await ui.input({ key: 'javaHome', text: '/opt/jdk-25' })
    await ui.input({ key: 'profileText', text: 'dev' })
    expect(await ui.find({ type: 'Text', text: /java: \/opt\/jdk-25\/bin\/java/ })).toBeDefined()
    await ui.press({ key: 'run' })
    await clock.settle()

    expect(w.spawns[0]?.argv.slice(0, 2)).toEqual(['sh', './gradlew'])
    expect(w.spawns[0]?.env?.JAVA_HOME).toBe('/opt/jdk-25')
    expect(w.spawns[1]?.argv).toEqual([
      '/opt/jdk-25/bin/java',
      '-Xmx2g',
      '-Dmode=a b',
      '-Dstdout.encoding=UTF-8',
      '-Dstderr.encoding=UTF-8',
      '@/home/me/demo/build/boot-console/java.args',
      '--spring.profiles.active=dev',
    ])
    await ui.unmount()
    java.release()
    await clock.settle()

    // Read back from the store, as a new session in this project would.
    await $.session.start(start('/home/me/demo'))
    const again = await $.ui.mount({ plugin: 'boot-console', surface: 'terminal', ...PANE } as any)
    expect((await again.find({ type: 'Text', text: /profile/ }))?.text).toMatch(/· profile dev$/)
    // The settings stay open from before: the pane's state outlives a reload.
    expect((await again.find({ type: 'Text', text: /applies from the next Run/ }))?.text).toMatch(/^java: \/opt\/jdk-25\/bin\/java /)
    expect(((await again.find({ type: 'Input', key: 'jvm' })) as any)?.props?.value).toBe('-Xmx2g -Dmode="a b"')
    await again.unmount()
  })

  test('without JAVA_HOME or a JDK set, java comes from the PATH and Gradle gets no JAVA_HOME', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    mock.store(on)
    mock.env(on, {})
    const java = javaUp()
    const w = world(on, { gradle: gradleOk, java: java.child })
    await $.session.start(start('/home/me/demo'))
    await $.command.run({ command: 'boot-console', args: 'run' } as any)
    await clock.settle()

    expect(w.spawns[0]?.env?.JAVA_HOME).toBeUndefined()
    expect(w.spawns[1]?.argv[0]).toBe('java')
    java.release()
    await clock.settle()
  })

  test('a JDK set as its java still gives Gradle a JAVA_HOME it can use', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    mock.store(on, { 'settings:C:/work/demo': { profile: 'local', jvmOptions: '', javaHome: 'C:\\jdk-25\\bin\\java.exe' } })
    mock.env(on, {})
    const java = javaUp()
    const w = world(on, { gradle: gradleOk, java: java.child })
    await $.session.start(start(WIN))
    await $.command.run({ command: 'boot-console', args: 'run' } as any)
    await clock.settle()

    expect(w.spawns[0]?.env?.JAVA_HOME).toBe('C:\\jdk-25')
    expect(w.spawns[1]?.argv[0]).toBe('C:\\jdk-25\\bin\\java.exe')
    java.release()
    await clock.settle()
  })

  test('Stop during the build ends it, starts no JVM, and offers Run again', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    mock.store(on)
    mock.env(on, {})
    const gradle = gradleHeld()
    const w = world(on, { gradle: gradle.child, java: javaUp().child })
    await $.session.start(start(WIN))
    await $.command.run({ command: 'boot-console', args: 'run' } as any)
    await clock.settle()

    const stopping = $.command.run({ command: 'boot-console', args: 'stop' } as any)
    gradle.release()
    await stopping
    await clock.settle()

    expect(w.spawns).toHaveLength(1)
    const ui = await $.ui.mount({ plugin: 'boot-console', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /■ stopped/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'BUILD SUCCESSFUL in 9s' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'run' })).toBeDefined()
    await ui.unmount()
  })

  test('a second Run while one is under way does nothing', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    mock.store(on)
    mock.env(on, {})
    const gradle = gradleHeld()
    const w = world(on, { gradle: gradle.child, java: javaUp().child })
    await $.session.start(start(WIN))
    await $.command.run({ command: 'boot-console', args: 'run' } as any)
    await clock.settle()
    await $.command.run({ command: 'boot-console', args: 'run' } as any)
    await clock.settle()

    expect(w.spawns).toHaveLength(1)
    const stopping = $.command.run({ command: 'boot-console', args: 'stop' } as any)
    gradle.release()
    await stopping
    await clock.settle()
  })

  test('Restart ends the old JVM before compiling and starting the new one', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    mock.store(on)
    mock.env(on, {})
    const jvms = javas()
    const w = world(on, { gradle: gradleOk, java: jvms.child })
    await $.session.start(start(WIN))
    await $.command.run({ command: 'boot-console', args: 'run' } as any)
    await clock.settle()
    expect(jvms.count()).toBe(1)

    const restarting = $.command.run({ command: 'boot-console', args: 'restart' } as any)
    await clock.settle()
    expect(w.spawns).toHaveLength(2) // nothing new until the old JVM has ended
    jvms.release(0)
    await restarting
    await clock.settle()

    expect(jvms.ends).toEqual([0])
    expect(w.spawns.map(s => (s.argv.includes('gradlew.bat') ? 'gradle' : 'java'))).toEqual(['gradle', 'java', 'gradle', 'java'])
    const ui = await $.ui.mount({ plugin: 'boot-console', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /● running since/ })).toBeDefined()
    await ui.unmount()
    jvms.release(1)
    await clock.settle()
  })

  test('a second Stop while the first waits for the JVM keeps Run out until it has ended', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    mock.store(on)
    mock.env(on, {})
    const jvms = javas()
    const w = world(on, { gradle: gradleOk, java: jvms.child })
    await $.session.start(start(WIN))
    await $.command.run({ command: 'boot-console', args: 'run' } as any)
    await clock.settle()

    const first = $.command.run({ command: 'boot-console', args: 'stop' } as any)
    await clock.settle()
    const second = $.command.run({ command: 'boot-console', args: 'stop' } as any)
    await clock.settle()
    await $.command.run({ command: 'boot-console', args: 'run' } as any) // the old JVM has not ended yet
    await clock.settle()
    expect(w.spawns).toHaveLength(2)

    jvms.release(0)
    await Promise.all([first, second])
    await clock.settle()
    expect(jvms.ends).toEqual([0])
    expect(w.spawns).toHaveLength(2)
    const ui = await $.ui.mount({ plugin: 'boot-console', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /■ stopped/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'run' })).toBeDefined()
    await ui.unmount()
  })

  test('without a local profile none is picked: no guess that could be prod', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    mock.store(on)
    mock.env(on, {})
    const java = javaUp()
    const w = world(on, { gradle: gradleOk, java: java.child }, ['application-batch.yml', 'application-prod.yml'])
    await $.session.start(start(WIN))
    await $.command.run({ command: 'boot-console', args: 'run' } as any)
    await clock.settle()

    expect(w.spawns[1]?.argv.some(arg => arg.startsWith('--spring.profiles.active'))).toBe(false)
    const ui = await $.ui.mount({ plugin: 'boot-console', surface: 'terminal', ...PANE } as any)
    expect((await ui.find({ type: 'Text', text: /profile/ }))?.text).toMatch(/· no profile$/)
    await ui.unmount()
    java.release()
    await clock.settle()
  })

  test('Stop with nothing running leaves the status as it was', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    mock.store(on)
    mock.env(on, {})
    world(on, { gradle: gradleOk, java: javaUp().child })
    await $.session.start(start(WIN))
    await $.command.run({ command: 'boot-console', args: 'build' } as any)
    await clock.settle()
    await $.command.run({ command: 'boot-console', args: 'stop' } as any)
    await clock.settle()

    const ui = await $.ui.mount({ plugin: 'boot-console', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /✓ compiled/ })).toBeDefined()
    await ui.unmount()
  })

  test('a fresh load says the app is not running', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    mock.store(on)
    mock.env(on, {})
    world(on, { gradle: gradleOk, java: javaUp().child })
    await $.session.start(start(WIN))
    await clock.settle()

    const ui = await $.ui.mount({ plugin: 'boot-console', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: '○ not running' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  · profile local' })).toBeDefined() // local is picked when the resources have it
    expect(await ui.find({ type: 'Text', text: /Press Run/ })).toBeDefined()
    await ui.unmount()
  })
})

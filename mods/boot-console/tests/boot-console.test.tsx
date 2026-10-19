import { describe, expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

import { gradleArgv, intellijRun, isStarted, javaArgv, javaExe, jdkRoot, levelOf, maskSecret, profilesFrom, scrolledBack, splitChunk, tokenize, tone, visibleLines } from '../hooks/register'
import { backAt, thumb } from '../hooks/scrollbar'

// An IntelliJ workspace file as IntelliJ writes it: a Gradle task, the Spring Boot run, its template.
const WORKSPACE = `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="RunManager" selected="Spring Boot.DemoApplication">
    <configuration name="demo [build]" type="GradleRunConfiguration" factoryName="Gradle" temporary="true">
      <ExternalSystemSettings><option name="scriptParameters" value="--offline" /></ExternalSystemSettings>
    </configuration>
    <configuration name="DemoApplication" type="SpringBootApplicationConfigurationType" factoryName="Spring Boot">
      <option name="ACTIVE_PROFILES" value="local" />
      <module name="demo.main" />
      <option name="SPRING_BOOT_MAIN_CLASS" value="com.example.DemoApplication" />
      <option name="VM_PARAMETERS" value="-Dapp.key.password=s3cr3t -Dfile.encoding=&quot;UTF-8&quot; -Xmx1g" />
      <method v="2"><option name="Make" enabled="true" /></method>
    </configuration>
    <configuration default="true" type="SpringBootApplicationConfigurationType" factoryName="Spring Boot">
      <option name="SHORTEN_COMMAND_LINE" value="ARGS_FILE" />
    </configuration>
  </component>
</project>`

const PANE = { component: 'Pane', requestId: 'boot-console', props: { title: 'Boot Console', isFocused: false, bodyColumns: 100, placement: 'dock' } }
const WIN = 'C:/work/demo'
const GRADLE_TAIL = ['--console=plain', '--no-configuration-cache', '--init-script', 'build/boot-console/init.gradle', 'bootConsoleArgs']
const WRAPPER = ['-Dorg.gradle.appname=gradlew', '-classpath'] // then the wrapper jar, its main class and Gradle's args
const gradleOf = (java: string, cwd: string, args: string[]) => [java, '-Xmx64m', '-Xms64m', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', ...WRAPPER, `${cwd}/gradle/wrapper/gradle-wrapper.jar`, 'org.gradle.wrapper.GradleWrapperMain', ...args]
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
function world(on: any, children: { gradle: Child; java: Child }, resources = ['application.yml', 'application-dev.yml', 'application-local.yml'], hasWrapper = true) {
  const spawns: { argv: string[]; cwd?: string; env?: Record<string, string> }[] = []
  const writes: { path: string; text: string }[] = []
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  on('fs.list', () => ({ value: [...resources.map(name => ({ name, kind: 'file' })), { name: 'static', kind: 'dir' }] }))
  on('fs.exists', () => ({ value: hasWrapper })) // the Gradle wrapper's jar
  on('fs.write', (_$: any, e: any) => (writes.push({ path: String(e.path).replace(/\\/g, '/'), text: e.text }), { value: undefined }))
  on('process.spawn', async function* (_$: any, e: any) {
    spawns.push(e)
    const isGradle = e.argv.includes('org.gradle.wrapper.GradleWrapperMain')
    const result = yield* (isGradle ? children.gradle : children.java)(e)
    return { value: result } // a stream hook ends with { value }
  })
  return { spawns, writes }
}

const start = (cwd: string) => ({ surface: 'terminal', isInteractive: true, cwd }) as any

describe('the pieces', () => {
  test('runs Gradle the way gradlew does, java on the wrapper jar, with no shell in between', async () => {
    expect(gradleArgv('java', '/w/gradle/wrapper/gradle-wrapper.jar', ['-Xmx1g'], ['classes'])).toEqual([
      'java',
      '-Xmx64m',
      '-Xms64m',
      '-Xmx1g',
      '-Dstdout.encoding=UTF-8',
      '-Dstderr.encoding=UTF-8',
      '-Dorg.gradle.appname=gradlew',
      '-classpath',
      '/w/gradle/wrapper/gradle-wrapper.jar',
      'org.gradle.wrapper.GradleWrapperMain',
      'classes',
    ])
  })

  test('finds java from the JDK home, a path to java itself, or the PATH', async () => {
    expect(javaExe('C:\\jdk-25', true)).toBe('C:\\jdk-25/bin/java.exe')
    expect(javaExe('/opt/jdk-25/', false)).toBe('/opt/jdk-25/bin/java')
    expect(javaExe('C:\\jdk-25\\bin\\java.exe', true)).toBe('C:\\jdk-25\\bin\\java.exe')
    expect(javaExe('/usr/bin/java', false)).toBe('/usr/bin/java')
    expect(javaExe('', true)).toBe('java')
  })

  test('shows the log lines that fill the rows, counting a long line for the rows it wraps to', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => ({ text: `line ${i}` }))
    expect(visibleLines(lines, 0, 3, 80).map(l => l.text)).toEqual(['line 7', 'line 8', 'line 9'])
    expect(visibleLines(lines, 2, 3, 80).map(l => l.text)).toEqual(['line 5', 'line 6', 'line 7'])
    expect(visibleLines(lines, 0, 50, 80)).toHaveLength(10)
    const wide = [{ text: 'a' }, { text: 'b'.repeat(25) }, { text: 'c' }]
    expect(visibleLines(wide, 0, 3, 10).map(l => l.text[0])).toEqual(['b', 'c']) // b wraps to 3 rows
  })

  test('scrolls the log up and down between its end and a screen that starts at its first line', async () => {
    expect(scrolledBack(0, -3, 100, 10)).toBe(3) // up
    expect(scrolledBack(3, 5, 100, 10)).toBe(0) // down, no further than the end
    expect(scrolledBack(80, -50, 100, 10)).toBe(90) // no further than a full screen from the first line
    expect(scrolledBack(0, -3, 5, 10)).toBe(0) // the whole log fits
  })

  test('the scrollbar: a press at the top shows the first lines, at the bottom the end; the thumb is the share on screen', async () => {
    expect(backAt(0, 10, 100)).toBe(90)
    expect(backAt(9, 10, 100)).toBe(0)
    expect(backAt(-3, 10, 100)).toBe(90) // dragged past the edge
    expect(backAt(4, 10, 5)).toBe(0) // the whole log fits
    expect(thumb(10, 100, 0)).toEqual({ top: 9, size: 1 }) // at the end
    expect(thumb(10, 100, 90)).toEqual({ top: 0, size: 1 }) // at the start
    expect(thumb(10, 20, 0)).toEqual({ top: 5, size: 5 }) // half the log on screen
    expect(thumb(10, 8, 0)).toEqual({ top: 0, size: 0 }) // it all fits: no thumb
  })

  test('finds the log level in a line, to colour it alone', async () => {
    expect(levelOf('2026-10-19T13:02:19.123+09:00  INFO 1234 --- [main] c.e.DemoApplication : Started')).toEqual({
      before: '2026-10-19T13:02:19.123+09:00  ',
      level: 'INFO',
      after: ' 1234 --- [main] c.e.DemoApplication : Started',
    })
    expect(levelOf('13:02:19 DEBUG jdbc.sqlonly - select 1')?.level).toBe('DEBUG')
    expect(levelOf('[WARN] slow')?.level).toBe('WARN')
    expect(levelOf('INFORMATION here')).toBeUndefined() // a word, not a level
    expect(levelOf('> Task :compileJava')).toBeUndefined()
  })

  test('reads the Spring Boot run configuration from an IntelliJ workspace file', async () => {
    expect(intellijRun(WORKSPACE)).toEqual({ name: 'DemoApplication', vmOptions: '-Dapp.key.password=s3cr3t -Dfile.encoding="UTF-8" -Xmx1g', profiles: 'local' })
    expect(intellijRun('<project><component name="RunManager"></component></project>')).toBeUndefined()
    expect(intellijRun('<project/>')).toBeUndefined()
  })

  test('keeps secrets in -D options out of the log', async () => {
    expect(maskSecret('-Djasypt.encryptor.password=abc')).toBe('-Djasypt.encryptor.password=****')
    expect(maskSecret('-Dapi.token=xyz')).toBe('-Dapi.token=****')
    expect(maskSecret('-PnexusPassword=x')).toBe('-PnexusPassword=****') // a Gradle property in Gradle args
    expect(maskSecret('-Dfile.encoding=UTF-8')).toBe('-Dfile.encoding=UTF-8')
    expect(maskSecret('-Xmx1g')).toBe('-Xmx1g')
  })

  test('colours javac errors and warnings in Korean too', async () => {
    expect(tone({ text: 'Demo.java:3: 오류: 기호를 찾을 수 없습니다', kind: 'build' })).toEqual({ color: 'red' })
    expect(tone({ text: 'Demo.java:9: 경고: [deprecation] old() 은(는) 더 이상 사용되지 않습니다', kind: 'build' })).toEqual({ color: 'yellow' })
    expect(tone({ text: 'Demo.java:9: warning: [deprecation] old() has been deprecated', kind: 'build' })).toEqual({ color: 'yellow' })
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

  test('colours lines without a level: errors, their stack frames, warnings and success; a line with a level keeps its own', async () => {
    expect(tone({ text: '2026 ERROR 123 --- [main] o.s.boot.SpringApplication : failed', kind: 'out' })).toEqual({}) // its ERROR alone is red
    expect(tone({ text: '\tat com.example.Demo.main(Demo.java:3)', kind: 'out' })).toEqual({ color: 'red', isDim: true })
    expect(tone({ text: 'Caused by: java.net.BindException: Address already in use', kind: 'out' })).toEqual({ color: 'red' })
    expect(tone({ text: '2026  WARN 123 --- [main] HikariPool-1 : slow', kind: 'out' })).toEqual({}) // its WARN alone is yellow
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
    mock.env(on, { JAVA_HOME: 'C:\\jdk-25', GRADLE_OPTS: '-Xmx1g' })
    const java = javaUp()
    const w = world(on, { gradle: gradleOk, java: java.child })
    await $.session.start(start(WIN))

    expect((await $.command.run({ command: 'boot-console', args: 'run' } as any)).text).toBe('Boot Console: run')
    await clock.settle()

    expect(w.writes[0]?.path).toBe(`${WIN}/build/boot-console/init.gradle`)
    expect(w.writes[0]?.text).toContain("register('bootConsoleArgs')")
    expect(w.spawns[0]?.argv).toEqual([
      'C:\\jdk-25/bin/java.exe',
      '-Xmx64m',
      '-Xms64m',
      '-Xmx1g', // GRADLE_OPTS, as gradlew passes it
      '-Dstdout.encoding=UTF-8',
      '-Dstderr.encoding=UTF-8',
      ...WRAPPER,
      `${WIN}/gradle/wrapper/gradle-wrapper.jar`,
      'org.gradle.wrapper.GradleWrapperMain',
      ...GRADLE_TAIL,
    ])
    expect(w.spawns[0]?.env?.JAVA_HOME).toBe('C:\\jdk-25')
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
    const level = (await ui.findAll({ type: 'Text', text: /INFO/ })).find(found => found.text === 'INFO') as any
    expect(level?.props?.color).toBe('green') // the level alone is coloured
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

    expect(w.spawns[0]?.argv).toEqual(gradleOf('/opt/jdk-25/bin/java', '/home/me/demo', GRADLE_TAIL))
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
    expect(w.spawns.map(s => (s.argv.includes('org.gradle.wrapper.GradleWrapperMain') ? 'gradle' : 'java'))).toEqual(['gradle', 'java', 'gradle', 'java'])
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

  test('a project run in IntelliJ starts with its run configuration, and the secret stays out of the log', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    mock.store(on)
    mock.env(on, {})
    on('fs.read', (_$: any, e: any) => (String(e.path).replace(/\\/g, '/').endsWith('.idea/workspace.xml') ? { value: WORKSPACE } : { deny: 'no such file' }))
    const java = javaUp()
    const w = world(on, { gradle: gradleOk, java: java.child }, ['application-dev.yml', 'application-local.yml'])
    await $.session.start(start(WIN))
    await $.command.run({ command: 'boot-console', args: 'run' } as any)
    await clock.settle()

    expect(w.spawns[1]?.argv).toEqual([
      'java',
      '-Dapp.key.password=s3cr3t',
      '-Dfile.encoding=UTF-8',
      '-Xmx1g',
      '-Dstdout.encoding=UTF-8',
      '-Dstderr.encoding=UTF-8',
      `@${WIN}/build/boot-console/java.args`,
      '--spring.profiles.active=local',
    ])
    const ui = await $.ui.mount({ plugin: 'boot-console', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: 'settings from IntelliJ run configuration "DemoApplication"' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /-Dapp\.key\.password=\*\*\*\* / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /s3cr3t/ })).toBeUndefined()
    await ui.unmount()
    java.release()
    await clock.settle()
  })

  test('From IntelliJ takes the run configuration again over what was saved, and Gradle args go before the task', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    mock.store(on, { 'settings:C:/work/demo': { profile: 'dev', jvmOptions: '-Xmx2g', javaHome: '', gradleArgs: '--offline' } })
    mock.env(on, {})
    on('fs.read', (_$: any, e: any) => (String(e.path).replace(/\\/g, '/').endsWith('.idea/workspace.xml') ? { value: WORKSPACE } : { deny: 'no such file' }))
    const java = javaUp()
    const w = world(on, { gradle: gradleOk, java: java.child })
    await $.session.start(start(WIN))

    const ui = await $.ui.mount({ plugin: 'boot-console', surface: 'terminal', ...PANE } as any)
    expect((await ui.find({ type: 'Text', text: /profile/ }))?.text).toMatch(/· profile dev$/) // what was saved comes first
    await ui.press({ key: 'settings' })
    await ui.press({ key: 'fromIntellij' })
    expect((await ui.find({ type: 'Text', text: /profile/ }))?.text).toMatch(/· profile local$/)
    await ui.press({ key: 'run' })
    await clock.settle()

    expect(w.spawns[0]?.argv).toEqual(gradleOf('java', WIN, ['--offline', ...GRADLE_TAIL]))
    expect(w.spawns[1]?.argv.slice(1, 4)).toEqual(['-Dapp.key.password=s3cr3t', '-Dfile.encoding=UTF-8', '-Xmx1g'])
    await ui.unmount()
    java.release()
    await clock.settle()
  })

  test('a project without the Gradle wrapper says so and starts nothing', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    mock.store(on)
    mock.env(on, {})
    const w = world(on, { gradle: gradleOk, java: javaUp().child }, undefined, false)
    await $.session.start(start(WIN))
    await $.command.run({ command: 'boot-console', args: 'run' } as any)
    await clock.settle()

    expect(w.spawns).toHaveLength(0)
    const ui = await $.ui.mount({ plugin: 'boot-console', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /no gradle\/wrapper\/gradle-wrapper\.jar in this project/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /✗ failed .*\(no Gradle wrapper\)/ })).toBeDefined()
    await ui.unmount()
  })

  test('docked, the pane holds to its height: the buttons stay and the newest log lines show', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    mock.store(on)
    mock.env(on, {})
    let release = () => {}
    const gate = new Promise<void>(resolve => (release = resolve))
    async function* chatty() {
      yield { stream: 'stdout', text: `${Array.from({ length: 50 }, (_, i) => `log line ${i}`).join('\n')}\n` } as Piece
      await gate
      return { code: 0, signal: null }
    }
    world(on, { gradle: gradleOk, java: chatty })
    await $.session.start(start(WIN))
    await $.command.run({ command: 'boot-console', args: 'run' } as any)
    await clock.settle()

    const docked = { ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 12 } } }
    const ui = (await $.ui.mount({ plugin: 'boot-console', surface: 'terminal', ...docked } as any)) as Mounted<'terminal', 'Pane'>
    const tree = (await ui.drawn()) as any
    expect(tree.props).toMatchObject({ height: 12, overflow: 'hidden' })
    expect(await ui.find({ type: 'Button', key: 'stop' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'log line 49' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'log line 0' })).toBeUndefined()
    expect((await ui.find({ type: 'Box', key: 'log' })) as any).toMatchObject({ props: { borderStyle: 'round' } })

    // The scrollbar: laid out 8 rows tall, a press at its top shows the first lines, at its bottom the end.
    await ui.resize({ in: 'scrollbar', columns: 1, rows: 8 })
    await ui.pointer({ in: 'scrollbar', type: 'down', x: 0, y: 0, button: 'left' })
    await ui.pointer({ in: 'scrollbar', type: 'up', x: 0, y: 0, button: 'left' })
    expect(await ui.find({ type: 'Text', text: 'log line 0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'log line 49' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'follow' })).toBeDefined()
    // A drag down to the bottom row brings the end back.
    await ui.pointer({ in: 'scrollbar', type: 'down', x: 0, y: 0, button: 'left' })
    await ui.pointer({ in: 'scrollbar', type: 'move', x: 0, y: 7, button: 'left' })
    await ui.pointer({ in: 'scrollbar', type: 'up', x: 0, y: 7, button: 'left' })
    expect(await ui.find({ type: 'Text', text: 'log line 49' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'follow' })).toBeUndefined()
    await ui.unmount()
    release()
    await clock.settle()
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

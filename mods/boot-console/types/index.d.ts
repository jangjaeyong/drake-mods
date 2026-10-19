// Where the app is in its life, as the pane shows it.
export type BootPhase = 'idle' | 'building' | 'built' | 'starting' | 'running' | 'stopped' | 'failed'
export type BootStatus = { phase: BootPhase; since: number; detail: string }

// How the app is started, kept per project.
export type BootSettings = {
  profile: string // --spring.profiles.active; '' for none, several comma-separated
  jvmOptions: string // before the main class, e.g. -Xmx2g -Dfoo=bar
  javaHome: string // the JDK; '' for JAVA_HOME
  gradleArgs: string // before the task, e.g. --offline
}

declare module 'claude-code' {
  interface PluginState {
    'boot-console': {
      status: BootStatus
      settings: BootSettings
      profiles: string[] // found in src/main/resources/application-*.yml
      javaPath: string // the java the next Run starts
      logVersion: number // bumped to redraw the log, which lives in the module
      isSettingsOpen: boolean
    }
  }
}

export const REAL_DEMO_INPUT_LIMIT = 128 * 1024 * 1024;
export const REAL_DEMO_PROCESSING_DEADLINE = 120_000;
export function allowedRealDemoFiles(files: readonly { name: string; size: number }[]): boolean {
  return files.length === 1 && /\.dem$/i.test(files[0].name) && Number.isSafeInteger(files[0].size)
    && files[0].size > 0 && files[0].size <= REAL_DEMO_INPUT_LIMIT;
}
/** Separate processing deadlines; time spent choosing a player is not a processing phase. */
export function realDemoDeadlines(onTimeout: () => void) {
  const timers: Partial<Record<"parse" | "pipeline", ReturnType<typeof setTimeout>>> = {};
  const finish = (phase?: "parse" | "pipeline") => {
    for (const key of phase ? [phase] : ["parse", "pipeline"] as const) { clearTimeout(timers[key]); delete timers[key]; }
  };
  return { finish, start: (phase: "parse" | "pipeline") => {
    finish(phase); timers[phase] = setTimeout(() => { finish(); onTimeout(); }, REAL_DEMO_PROCESSING_DEADLINE);
  } };
}

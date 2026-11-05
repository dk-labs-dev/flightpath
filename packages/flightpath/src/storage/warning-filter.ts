// Swallow exactly one warning: the experimental notice Node prints
// when node:sqlite loads. Flightpath loads that module deliberately,
// so the notice is noise for its users; every other warning passes
// through untouched.

export function installSqliteWarningFilter(): void {
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((
    warning: string | Error,
    ...rest: unknown[]
  ): void => {
    let message = "";
    if (typeof warning === "string") {
      message = warning;
    } else if (warning instanceof Error) {
      message = warning.message;
    }
    if (/sqlite is an experimental feature/i.test(message)) {
      return;
    }
    (original as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

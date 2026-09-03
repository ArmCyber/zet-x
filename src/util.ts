const noColor = !!process.env.NO_COLOR;

export function outAnsi(code: string): string {
  return !noColor && process.stdout.isTTY ? `\x1b[${code}m` : "";
}

export function errAnsi(code: string): string {
  return !noColor && process.stderr.isTTY ? `\x1b[${code}m` : "";
}

export function isTaggedTemplate(arg: unknown): arg is TemplateStringsArray {
  return Array.isArray(arg) && 'raw' in arg;
}

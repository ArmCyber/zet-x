export class CommandOutput {
  code: number;
  output: string | null;
  stdout: string | null;
  stderr: string | null;

  constructor(code: number, output: string | null, stdout: string | null, stderr: string | null) {
    this.code = code;
    this.output = output;
    this.stdout = stdout;
    this.stderr = stderr;
  }

  get succeeded(): boolean {
    return this.code === 0;
  }

  get failed(): boolean {
    return this.code !== 0;
  }

  throw(): this {
    if (this.failed) {
      throw new Error(`Command failed with exit code ${this.code}`);
    }
    return this;
  }
}

export class TemplateResult {
  parts: string[];

  constructor(parts: string[]) {
    this.parts = parts;
  }

  toString(): string {
    return this.parts.join(" ");
  }
}

export interface TemplateFn {
  (...args: (string | TemplateResult)[]): TemplateResult;
  _isZetTemplate: boolean;
  _expectedArgs: number;
}

export function flattenParts(parts: unknown[]): string[] {
  const result: string[] = [];
  for (const part of parts) {
    if (typeof part === "function" && (part as TemplateFn)._isZetTemplate) {
      if ((part as TemplateFn)._expectedArgs === 0) {
        const tr = (part as TemplateFn)();
        result.push(...flattenParts(tr.parts));
    } else {
      throw new Error(
        "A template was used without being called -- add () with the required arguments"
      );
    }
    } else if (part instanceof TemplateResult) {
      result.push(...flattenParts(part.parts));
    } else if (Array.isArray(part)) {
      result.push(...flattenParts(part));
    } else {
      result.push(String(part));
    }
  }
  return result;
}

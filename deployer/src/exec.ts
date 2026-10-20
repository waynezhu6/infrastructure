import { spawn } from "node:child_process";

export interface ExecOptions {
  env?: NodeJS.ProcessEnv;
  // Called with each line of stdout and stderr as it arrives.
  onLine?: (line: string) => void;
}

export interface ExecResult {
  code: number;
  stdout: string;
}

export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

// Runs a command without a shell, so nothing in args is ever interpreted.
export const exec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    const lines = (stream: NodeJS.ReadableStream, keep: boolean) => {
      let buf = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        if (keep) stdout += chunk;
        buf += chunk;
        const parts = buf.split(/\r?\n|\r/);
        buf = parts.pop()!;
        for (const line of parts) if (line) opts.onLine?.(line);
      });
      stream.on("end", () => {
        if (buf) opts.onLine?.(buf);
      });
    };
    lines(child.stdout!, true);
    lines(child.stderr!, false);
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
  });

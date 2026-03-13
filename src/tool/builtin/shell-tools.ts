import { spawn } from "node:child_process";
import { resolve } from "node:path";

function asString(value: unknown, field: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === undefined || value === null) {
    return "";
  }
  throw new Error(`Parameter '${field}' must be a string-compatible value`);
}

function runForeground(command: string, cwd: string): Promise<Record<string, unknown>> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";

    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code, signal) => {
      const result: Record<string, unknown> = {
        output: output.length > 0 ? output : "(empty)",
      };
      if (code && code !== 0) {
        result.exit_code = code;
      }
      if (signal) {
        result.signal = signal;
      }
      resolveResult(result);
    });
  });
}

export async function runShellCommandTool(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const command = asString(params.command, "command");
  const isBackground = Boolean(params.is_background ?? false);
  const cwd = params.dir_path ? resolve(asString(params.dir_path, "dir_path")) : process.cwd();

  if (isBackground) {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    return {
      output: "(background process started)",
      background_pids: child.pid ? [child.pid] : [],
      process_group_pgid: child.pid ?? null,
    };
  }

  return runForeground(command, cwd);
}

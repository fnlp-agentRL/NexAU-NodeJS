import { ConfigError } from "../core/config-error.js";

const ENV_PATTERN = /\$\{env\.([A-Za-z_][A-Za-z0-9_]*)\}/g;
const VARIABLE_PATTERN = /\$\{variables\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}/g;

function resolvePathValue(source: unknown, dottedPath: string): unknown {
  const parts = dottedPath.split(".");
  let current: unknown = source;

  for (const part of parts) {
    if (typeof current !== "object" || current === null || !(part in current)) {
      throw new ConfigError(`Variable '${dottedPath}' is not defined in 'variables'`);
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function scalarToString(value: unknown, key: string): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  throw new ConfigError(
    `Variable '${key}' resolves to a non-scalar value and cannot be embedded in a string`,
  );
}

export function replaceThisFileDir(input: string, absoluteDir: string): string {
  return input.replaceAll("${this_file_dir}", absoluteDir);
}

export function replaceEnvTemplates(
  input: string,
  envSource: NodeJS.ProcessEnv = process.env,
): string {
  return input.replaceAll(ENV_PATTERN, (_match, envName: string) => {
    const value = envSource[envName];
    if (!value) {
      throw new ConfigError(`Environment variable '${envName}' is not set`);
    }
    return value;
  });
}

export function replaceVariableTemplates(
  input: string,
  variables: Record<string, unknown>,
): string {
  return input.replaceAll(VARIABLE_PATTERN, (_match, variablePath: string) => {
    const resolved = resolvePathValue(variables, variablePath);
    return scalarToString(resolved, variablePath);
  });
}

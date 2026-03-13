import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import YAML from "yaml";

import { ConfigError } from "../core/config-error.js";
import {
  replaceEnvTemplates,
  replaceThisFileDir,
  replaceVariableTemplates,
} from "./env-template.js";

export interface LoadYamlWithVarsOptions {
  env?: NodeJS.ProcessEnv;
}

export type YamlValue =
  | Record<string, unknown>
  | Array<unknown>
  | string
  | number
  | boolean
  | null
  | undefined;

export function loadYamlWithVars(path: string, options: LoadYamlWithVarsOptions = {}): YamlValue {
  const absolutePath = resolve(path);
  const baseDir = dirname(absolutePath);
  const envSource = options.env ?? process.env;

  let text = readFileSync(absolutePath, "utf-8");
  text = replaceThisFileDir(text, baseDir);
  text = replaceEnvTemplates(text, envSource);

  const firstPass = YAML.parse(text) as YamlValue;
  if (!firstPass || typeof firstPass !== "object" || Array.isArray(firstPass)) {
    return firstPass;
  }

  const variablesValue = firstPass.variables;
  if (variablesValue === undefined) {
    return firstPass;
  }

  if (
    typeof variablesValue !== "object" ||
    variablesValue === null ||
    Array.isArray(variablesValue)
  ) {
    throw new ConfigError("'variables' must be a mapping if provided in YAML");
  }

  const secondText = replaceVariableTemplates(text, variablesValue as Record<string, unknown>);
  const secondPass = YAML.parse(secondText) as YamlValue;

  if (secondPass && typeof secondPass === "object" && !Array.isArray(secondPass)) {
    delete secondPass.variables;
  }

  return secondPass;
}

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as AjvModule from "ajv";
import YAML from "yaml";
import { z } from "zod";

import { ConfigError } from "../core/config-error.js";
import { resolveToolImplementation } from "./registry.js";
import type { ToolImplementation } from "./types.js";

const ToolYamlSchema = z
  .object({
    type: z.literal("tool").optional(),
    name: z.string(),
    description: z.string(),
    input_schema: z.record(z.string(), z.unknown()).default({}),
    skill_description: z.string().optional(),
    disable_parallel: z.boolean().default(false),
    lazy: z.boolean().default(false),
    template_override: z.string().optional(),
    builtin: z.string().optional(),
    binding: z.string().optional(),
  })
  .strict();

interface ToolFromYamlOptions {
  asSkill?: boolean;
  extraKwargs?: Record<string, unknown>;
  lazy?: boolean;
  nameOverride?: string;
}

function ensureObjectSchema(
  schema: Record<string, unknown>,
  toolName: string,
): Record<string, unknown> {
  if (Object.keys(schema).length === 0) {
    return {
      type: "object",
      properties: {},
    };
  }

  if (!("type" in schema)) {
    return {
      type: "object",
      properties: schema.properties ?? {},
      required: schema.required ?? [],
      additionalProperties: schema.additionalProperties ?? false,
    };
  }

  if (schema.type !== "object") {
    throw new ConfigError(`Invalid JSON Schema for tool '${toolName}': root type must be object`);
  }

  return schema;
}

function buildTraceback(error: unknown): string {
  if (error instanceof Error && error.stack) {
    return error.stack;
  }
  return String(error);
}

function hasSchemaCombinator(schema: Record<string, unknown>): boolean {
  return Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf) || Array.isArray(schema.allOf);
}

type CompiledValidator = ((data: unknown) => boolean) & { errors?: unknown[] | null };
type AjvLike = {
  validateSchema: (schema: unknown) => boolean;
  errorsText: (errors?: unknown[] | null) => string;
  errors: unknown[] | null | undefined;
  compile: (schema: unknown) => CompiledValidator;
};
type AjvLikeConstructor = new (options: Record<string, unknown>) => AjvLike;

export class Tool {
  public readonly name: string;
  public readonly description: string;
  public readonly skillDescription: string | null;
  public readonly asSkill: boolean;
  public readonly inputSchema: Record<string, unknown>;
  public readonly disableParallel: boolean;
  public readonly lazy: boolean;
  public readonly templateOverride: string | null;
  public readonly implementationImportPath: string | null;

  private readonly schemaValidator: {
    validateSchema: (schema: unknown) => boolean;
    errorsText: (errors?: unknown[] | null) => string;
    errors: unknown[] | null | undefined;
    compile: (schema: unknown) => CompiledValidator;
  };
  private readonly paramsValidator: CompiledValidator;
  private implementation: ToolImplementation | null;

  public constructor(input: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    implementation: ToolImplementation | string | null;
    asSkill?: boolean;
    skillDescription?: string;
    disableParallel?: boolean;
    lazy?: boolean;
    templateOverride?: string;
    extraKwargs?: Record<string, unknown>;
  }) {
    this.name = input.name;
    this.description = input.description;
    this.skillDescription = input.skillDescription ?? null;
    this.asSkill = input.asSkill ?? false;
    this.disableParallel = input.disableParallel ?? false;
    this.lazy = input.lazy ?? false;
    this.templateOverride = input.templateOverride ?? null;

    const reservedKeys = new Set(["agent_state", "global_storage"]);
    const extraKwargs = input.extraKwargs ?? {};
    const conflictKeys = Object.keys(extraKwargs).filter((key) => reservedKeys.has(key));
    if (conflictKeys.length > 0) {
      throw new ConfigError(
        `Tool '${this.name}' extra_kwargs contains reserved keys that cannot be overridden: ${JSON.stringify(conflictKeys.sort())}`,
      );
    }

    this.inputSchema = ensureObjectSchema(input.inputSchema, this.name);
    this.implementationImportPath =
      typeof input.implementation === "string" ? input.implementation : null;
    this.implementation = typeof input.implementation === "function" ? input.implementation : null;

    const AjvConstructor = ((AjvModule as { default?: unknown }).default ??
      AjvModule) as unknown as AjvLikeConstructor;
    this.schemaValidator = new AjvConstructor({ allErrors: true, strict: false });
    const schemaValid = this.schemaValidator.validateSchema(this.inputSchema);
    if (!schemaValid) {
      throw new ConfigError(
        `Invalid JSON Schema for tool '${this.name}': ${this.schemaValidator.errorsText(this.schemaValidator.errors ?? [])}`,
      );
    }
    this.paramsValidator = this.schemaValidator.compile(this.inputSchema);

    this.extraKwargs = { ...extraKwargs };

    if (!this.lazy && !this.implementation) {
      this.implementation =
        resolveToolImplementation(this.implementationImportPath ?? undefined, this.name) ?? null;
    }
  }

  private readonly extraKwargs: Record<string, unknown>;

  public static fromYaml(
    yamlPath: string,
    binding: ToolImplementation | string | null = null,
    options: ToolFromYamlOptions = {},
  ): Tool {
    const resolvedPath = resolve(yamlPath);

    let parsed: unknown;
    try {
      parsed = YAML.parse(readFileSync(resolvedPath, "utf-8"));
    } catch (error) {
      throw new ConfigError(`Error loading tool YAML '${yamlPath}': ${String(error)}`);
    }

    const parsedResult = ToolYamlSchema.safeParse(parsed);
    if (!parsedResult.success) {
      const issue = parsedResult.error.issues
        .map((item) => `${item.path.join("->") || "root"}: ${item.message}`)
        .join("; ");
      throw new ConfigError(`Invalid tool configuration: ${issue}`);
    }

    const toolDef = parsedResult.data;
    const effectiveBinding = binding ?? toolDef.binding ?? null;
    const effectiveLazy = options.lazy ?? toolDef.lazy;

    const properties = (toolDef.input_schema.properties ?? {}) as Record<string, unknown>;
    if ("global_storage" in properties) {
      throw new ConfigError(
        `Tool definition of '${toolDef.name}' contains 'global_storage' field in ${yamlPath}, which is framework injected`,
      );
    }
    if ("agent_state" in properties) {
      throw new ConfigError(
        `Tool definition of '${toolDef.name}' contains 'agent_state' field in ${yamlPath}, which is framework injected`,
      );
    }

    return new Tool({
      name: options.nameOverride ?? toolDef.name,
      description: toolDef.description,
      inputSchema: toolDef.input_schema,
      implementation: effectiveBinding,
      asSkill: options.asSkill ?? false,
      skillDescription: toolDef.skill_description,
      disableParallel: toolDef.disable_parallel,
      lazy: effectiveLazy,
      templateOverride: toolDef.template_override,
      extraKwargs: options.extraKwargs,
    });
  }

  private ensureImplementation(): ToolImplementation {
    if (this.implementation) {
      return this.implementation;
    }

    const resolved = resolveToolImplementation(
      this.implementationImportPath ?? undefined,
      this.name,
    );
    if (!resolved) {
      throw new Error(
        `Tool '${this.name}' has no implementation (binding=${this.implementationImportPath ?? "none"})`,
      );
    }

    this.implementation = resolved;
    return resolved;
  }

  public validateParams(params: Record<string, unknown>): void {
    // For combinator schemas (anyOf/oneOf/allOf), validating a property-filtered
    // object may drop discriminator fields like `action`, causing false failures.
    if (hasSchemaCombinator(this.inputSchema)) {
      const valid = this.paramsValidator(params);
      if (!valid) {
        const detail = this.schemaValidator.errorsText(this.paramsValidator.errors ?? []);
        throw new Error(
          `Invalid parameters for tool '${this.name}': ${detail}. params=${JSON.stringify(params)}`,
        );
      }
      return;
    }

    const schemaProperties =
      typeof this.inputSchema.properties === "object" && this.inputSchema.properties
        ? (this.inputSchema.properties as Record<string, unknown>)
        : {};

    const filteredParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (key in schemaProperties) {
        filteredParams[key] = value;
      }
    }

    const valid = this.paramsValidator(filteredParams);
    if (!valid) {
      const detail = this.schemaValidator.errorsText(this.paramsValidator.errors ?? []);
      throw new Error(
        `Invalid parameters for tool '${this.name}': ${detail}. params=${JSON.stringify(filteredParams)}`,
      );
    }
  }

  public async execute(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const mergedParams = {
      ...this.extraKwargs,
      ...params,
    };

    const validationParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(mergedParams)) {
      if (["agent_state", "global_storage", "sandbox"].includes(key)) {
        continue;
      }
      validationParams[key] = value;
    }

    try {
      this.validateParams(validationParams);

      const implementation = this.ensureImplementation();
      const rawResult = await implementation(mergedParams);

      if (rawResult !== null && typeof rawResult === "object" && !Array.isArray(rawResult)) {
        return rawResult as Record<string, unknown>;
      }

      if (Array.isArray(rawResult)) {
        return { result: rawResult };
      }

      return { result: rawResult };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        error_type: error instanceof Error ? error.name : "Error",
        traceback: buildTraceback(error),
        tool_name: this.name,
      };
    }
  }

  public getSchema(): Record<string, unknown> {
    return { ...this.inputSchema };
  }

  public getInfo(): Record<string, unknown> {
    return {
      name: this.name,
      template_override: this.templateOverride,
      description: this.description,
      skill_description: this.skillDescription,
      input_schema: this.inputSchema,
    };
  }

  public toOpenAI(): Record<string, unknown> {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: this.inputSchema,
      },
    };
  }

  public toAnthropic(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.inputSchema,
    };
  }
}

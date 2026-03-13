import { ConfigError } from "./config-error.js";

const MODEL_ENV_KEYS = ["MODEL", "OPENAI_MODEL", "LLM_MODEL"] as const;
const BASE_URL_ENV_KEYS = ["OPENAI_BASE_URL", "BASE_URL", "LLM_BASE_URL"] as const;
const API_KEY_ENV_KEYS = ["LLM_API_KEY", "OPENAI_API_KEY", "API_KEY", "ANTHROPIC_API_KEY"] as const;

export interface LLMConfigInput {
  model?: string;
  base_url?: string;
  api_key?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  timeout?: number;
  max_retries?: number;
  debug?: boolean;
  stream?: boolean;
  additional_drop_params?: string[];
  api_type?: string;
  cache_control_ttl?: string;
  [key: string]: unknown;
}

interface LLMConfigEnvSource {
  env?: NodeJS.ProcessEnv;
}

function readFirstDefined(
  source: NodeJS.ProcessEnv,
  keys: readonly string[],
  errorMessage: string,
): string {
  for (const key of keys) {
    const value = source[key];
    if (value) {
      return value;
    }
  }
  throw new ConfigError(errorMessage);
}

export class LLMConfig {
  public readonly model: string;
  public readonly base_url: string;
  public readonly api_key: string;
  public readonly temperature?: number;
  public readonly max_tokens?: number;
  public readonly top_p?: number;
  public readonly frequency_penalty?: number;
  public readonly presence_penalty?: number;
  public readonly timeout?: number;
  public readonly max_retries: number;
  public readonly debug: boolean;
  public readonly stream: boolean;
  public readonly additional_drop_params: string[];
  public readonly api_type: string;
  public readonly cache_control_ttl?: string;
  public readonly extra_params: Record<string, unknown>;

  public constructor(input: LLMConfigInput = {}, source: LLMConfigEnvSource = {}) {
    const envSource = source.env ?? process.env;

    this.model =
      input.model ??
      readFirstDefined(envSource, MODEL_ENV_KEYS, "Model not found in environment variables");
    this.base_url =
      input.base_url ??
      readFirstDefined(envSource, BASE_URL_ENV_KEYS, "Base URL not found in environment variables");
    this.api_key =
      input.api_key ??
      readFirstDefined(envSource, API_KEY_ENV_KEYS, "API key not found in environment variables");

    this.temperature = input.temperature;
    this.max_tokens = input.max_tokens;
    this.top_p = input.top_p;
    this.frequency_penalty = input.frequency_penalty;
    this.presence_penalty = input.presence_penalty;
    this.timeout = input.timeout;
    this.max_retries = input.max_retries ?? 3;
    this.debug = input.debug ?? false;
    this.stream = input.stream ?? false;
    this.additional_drop_params = [...(input.additional_drop_params ?? [])];
    this.api_type = input.api_type ?? "openai_chat_completion";
    this.cache_control_ttl = input.cache_control_ttl;

    const {
      model: _model,
      base_url: _baseUrl,
      api_key: _apiKey,
      temperature: _temperature,
      max_tokens: _maxTokens,
      top_p: _topP,
      frequency_penalty: _frequencyPenalty,
      presence_penalty: _presencePenalty,
      timeout: _timeout,
      max_retries: _maxRetries,
      debug: _debug,
      stream: _stream,
      additional_drop_params: _additionalDropParams,
      api_type: _apiType,
      cache_control_ttl: _cacheControlTtl,
      ...extra
    } = input;
    this.extra_params = extra;
  }

  public toOpenAIParams(): Record<string, unknown> {
    const params: Record<string, unknown> = {
      model: this.model,
      ...this.extra_params,
    };

    if (this.temperature !== undefined) {
      params.temperature = this.temperature;
    }
    if (this.max_tokens !== undefined) {
      params.max_tokens = this.max_tokens;
    }
    if (this.top_p !== undefined) {
      params.top_p = this.top_p;
    }
    if (this.frequency_penalty !== undefined) {
      params.frequency_penalty = this.frequency_penalty;
    }
    if (this.presence_penalty !== undefined) {
      params.presence_penalty = this.presence_penalty;
    }
    if (this.stream) {
      params.stream = true;
    }

    return this.applyParamDrops(params);
  }

  public toClientKwargs(): Record<string, unknown> {
    const kwargs: Record<string, unknown> = {
      api_key: this.api_key,
      base_url: this.base_url,
    };

    if (this.timeout !== undefined) {
      kwargs.timeout = this.timeout;
    }
    if (this.max_retries !== undefined) {
      kwargs.max_retries = this.max_retries;
    }

    return kwargs;
  }

  public applyParamDrops(params: Record<string, unknown>): Record<string, unknown> {
    if (this.additional_drop_params.length === 0) {
      return params;
    }

    const copied = { ...params };
    for (const key of this.additional_drop_params) {
      delete copied[key];
    }
    return copied;
  }
}

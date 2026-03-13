import { setTimeout as sleep } from "node:timers/promises";

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

function stripHtml(input: string): string {
  return input
    .replaceAll(/<script[\s\S]*?<\/script>/gi, "")
    .replaceAll(/<style[\s\S]*?<\/style>/gi, "")
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

export async function webSearchTool(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const query = asString(params.query, "query");
  const numResults = params.num_results === undefined ? 10 : Number(params.num_results);

  // Lightweight compatibility stub. Real provider integration lands in later phases.
  await sleep(0);

  return {
    query,
    num_results: numResults,
    results: [],
    provider: "stub",
  };
}

export async function webFetchTool(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = asString(params.url, "url");
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });

  const text = await response.text();
  const titleMatch = text.match(/<title>(.*?)<\/title>/i);

  return {
    url,
    final_url: response.url,
    status: response.status,
    title: titleMatch?.[1]?.trim() ?? null,
    content: stripHtml(text).slice(0, 20_000),
  };
}

import type { ToolResult } from "../tools";
import { describeToolOutputTrust } from "../security/toolOutputTrustPolicy";
import { sanitizeToolErrorMessage } from "../tools/sanitizeToolError";

export type ToolResultRelay = Record<string, unknown>;

const MAX_RELAY_SUMMARY_CHARS = 800;
const MAX_RELAY_TOTAL_TEXT_CHARS = 5_200;
const MAX_RELAY_STRING_CHARS = 1_600;
const MAX_RELAY_ARRAY_ITEMS = 40;
const MAX_RELAY_OBJECT_KEYS = 80;
const MAX_RELAY_DEPTH = 8;
const MAX_RELAY_TRUNCATION_PATHS = 12;

type RelayTruncationStats = {
  usedTextCharacters: number;
  omittedTextCharacters: number;
  omittedArrayItems: number;
  omittedObjectKeys: number;
  omittedDepthItems: number;
  paths: string[];
  seenObjects: WeakSet<object>;
};

export function buildToolResultRelay(
  toolName: string,
  result: ToolResult
): ToolResultRelay {
  if (!result.ok) {
    return {
      ok: false,
      error: {
        ...result.error,
        message: sanitizeToolErrorMessage(result.error.message)
      }
    };
  }

  const truncationStats = createTruncationStats();
  const relay: ToolResultRelay = {
    ok: true,
    summary: compactRelayValue(result.summary, truncationStats, "summary", 0, MAX_RELAY_SUMMARY_CHARS),
    data: compactRelayValue(result.data, truncationStats, "data", 0, MAX_RELAY_STRING_CHARS)
  };
  const contentSafety = describeToolOutputTrust(toolName);
  if (contentSafety) {
    relay.contentSafety = contentSafety;
  }
  const truncation = buildTruncationMetadata(truncationStats);
  if (truncation) {
    relay.truncation = truncation;
  }
  return relay;
}

function createTruncationStats(): RelayTruncationStats {
  return {
    usedTextCharacters: 0,
    omittedTextCharacters: 0,
    omittedArrayItems: 0,
    omittedObjectKeys: 0,
    omittedDepthItems: 0,
    paths: [],
    seenObjects: new WeakSet<object>()
  };
}

function compactRelayValue(
  value: unknown,
  stats: RelayTruncationStats,
  path: string,
  depth: number,
  stringLimit: number
): unknown {
  if (typeof value === "string") {
    return compactRelayString(value, stats, path, stringLimit);
  }

  if (
    value === null
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return compactRelayString(value.toString(), stats, path, stringLimit);
  }

  if (value instanceof Date) {
    return compactRelayString(value.toISOString(), stats, path, stringLimit);
  }

  if (Array.isArray(value)) {
    return compactRelayArray(value, stats, path, depth, stringLimit);
  }

  if (typeof value === "object") {
    return compactRelayObject(value as Record<string, unknown>, stats, path, depth, stringLimit);
  }

  return undefined;
}

function compactRelayArray(
  value: unknown[],
  stats: RelayTruncationStats,
  path: string,
  depth: number,
  stringLimit: number
): unknown[] {
  if (depth >= MAX_RELAY_DEPTH) {
    stats.omittedDepthItems += value.length;
    rememberTruncatedPath(stats, path);
    return ["[数组内容已省略：工具结果嵌套过深]"];
  }

  const keptItems = value.slice(0, MAX_RELAY_ARRAY_ITEMS);
  if (value.length > keptItems.length) {
    stats.omittedArrayItems += value.length - keptItems.length;
    rememberTruncatedPath(stats, path);
  }

  return keptItems.map((item, index) =>
    compactRelayValue(item, stats, `${path}[${index}]`, depth + 1, stringLimit)
  );
}

function compactRelayObject(
  value: Record<string, unknown>,
  stats: RelayTruncationStats,
  path: string,
  depth: number,
  stringLimit: number
): Record<string, unknown> | string {
  if (stats.seenObjects.has(value)) {
    stats.omittedObjectKeys += 1;
    rememberTruncatedPath(stats, path);
    return "[对象内容已省略：检测到循环引用]";
  }

  if (depth >= MAX_RELAY_DEPTH) {
    stats.omittedDepthItems += 1;
    rememberTruncatedPath(stats, path);
    return "[对象内容已省略：工具结果嵌套过深]";
  }

  stats.seenObjects.add(value);
  const entries = Object.entries(value);
  const keptEntries = entries.slice(0, MAX_RELAY_OBJECT_KEYS);
  if (entries.length > keptEntries.length) {
    stats.omittedObjectKeys += entries.length - keptEntries.length;
    rememberTruncatedPath(stats, path);
  }

  const compacted: Record<string, unknown> = {};
  for (const [key, item] of keptEntries) {
    const compactedValue = compactRelayValue(
      item,
      stats,
      `${path}.${key}`,
      depth + 1,
      stringLimit
    );
    if (compactedValue !== undefined) {
      compacted[key] = compactedValue;
    }
  }
  return compacted;
}

function compactRelayString(
  value: string,
  stats: RelayTruncationStats,
  path: string,
  stringLimit: number
): string {
  const remainingBudget = Math.max(0, MAX_RELAY_TOTAL_TEXT_CHARS - stats.usedTextCharacters);
  const allowedCharacters = Math.min(stringLimit, remainingBudget);

  if (value.length <= allowedCharacters) {
    stats.usedTextCharacters += value.length;
    return value;
  }

  rememberTruncatedPath(stats, path);

  if (allowedCharacters < 160) {
    const placeholder = "[文本内容已省略：工具结果超过回灌预算]";
    stats.omittedTextCharacters += value.length;
    stats.usedTextCharacters += placeholder.length;
    return placeholder;
  }

  const { text: truncated, omittedCharacters } = truncateMiddle(value, allowedCharacters);
  stats.omittedTextCharacters += omittedCharacters;
  stats.usedTextCharacters += truncated.length;
  return truncated;
}

function truncateMiddle(value: string, maxCharacters: number): {
  text: string;
  omittedCharacters: number;
} {
  const markerPreview = "\n...[已省略 0 个字符]...\n";
  const contentBudgetPreview = Math.max(0, maxCharacters - markerPreview.length);
  const omittedCharacters = Math.max(0, value.length - contentBudgetPreview);
  const marker = `\n...[已省略 ${omittedCharacters} 个字符]...\n`;
  const contentBudget = Math.max(0, maxCharacters - marker.length);
  const headCharacters = Math.ceil(contentBudget * 0.7);
  const tailCharacters = contentBudget - headCharacters;
  return {
    text: `${value.slice(0, headCharacters)}${marker}${tailCharacters > 0 ? value.slice(-tailCharacters) : ""}`,
    omittedCharacters: Math.max(0, value.length - headCharacters - tailCharacters)
  };
}

function rememberTruncatedPath(stats: RelayTruncationStats, path: string): void {
  if (stats.paths.length >= MAX_RELAY_TRUNCATION_PATHS || stats.paths.includes(path)) {
    return;
  }
  stats.paths.push(path);
}

function buildTruncationMetadata(stats: RelayTruncationStats): Record<string, unknown> | undefined {
  const truncated =
    stats.omittedTextCharacters > 0
    || stats.omittedArrayItems > 0
    || stats.omittedObjectKeys > 0
    || stats.omittedDepthItems > 0;
  if (!truncated) {
    return undefined;
  }

  return {
    truncated: true,
    note: "Tool result was compacted before being relayed to the model; do not assume omitted content was inspected.",
    limits: {
      maxTotalTextCharacters: MAX_RELAY_TOTAL_TEXT_CHARS,
      maxStringCharacters: MAX_RELAY_STRING_CHARS,
      maxArrayItems: MAX_RELAY_ARRAY_ITEMS,
      maxObjectKeys: MAX_RELAY_OBJECT_KEYS,
      maxDepth: MAX_RELAY_DEPTH
    },
    omitted: {
      textCharacters: stats.omittedTextCharacters,
      arrayItems: stats.omittedArrayItems,
      objectKeys: stats.omittedObjectKeys,
      depthItems: stats.omittedDepthItems
    },
    paths: stats.paths
  };
}

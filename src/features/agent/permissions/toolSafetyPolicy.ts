import type { RiskLevel } from "../tools";

export type ToolSafetyReview = {
  riskLevel?: RiskLevel;
  confirmationTitle?: string;
  confirmationDescription?: string;
  reason?: string;
};

export type RequestSafetyFinding = {
  kind: "sensitive-url" | "sensitive-path";
  value: string;
  riskLevel: RiskLevel;
  reason: string;
  requiresConfirmation: boolean;
  relevantToolNames: string[];
  recommendation: string;
};

export type ToolSafetyHookDefinition = {
  id: string;
  label: string;
  kind: RequestSafetyFinding["kind"];
  riskLevel: RiskLevel;
  requiresConfirmation: boolean;
  executionToolNames: string[];
  preflightRelevantToolNames: string[];
  triggerSummary: string[];
  confirmationTitles: string[];
  boundary: string;
};

const RISK_ORDER: Record<RiskLevel, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3
};

type SensitiveUrlToolRule = {
  urlField: string;
  confirmationTitle: string;
  actionLine: string;
  impactLine: string;
  refusalLine: string;
};

type SensitivePathToolRule = {
  pathField: string;
  confirmationTitle: string;
  actionLine: string;
  impactLine: string;
  refusalLine: string;
};

const SENSITIVE_URL_TOOL_RULES = new Map<string, SensitiveUrlToolRule>([
  [
    "browser.open",
    {
      urlField: "url",
      confirmationTitle: "确认访问本地或内网地址",
      actionLine: "将打开本地或私有网络地址（风险 L2）。",
      impactLine: "这类地址可能指向本机端口、路由器、NAS、开发服务或内网管理页。",
      refusalLine: "只有当你明确要访问这个地址时才继续；拒绝则不会打开。"
    }
  ],
  [
    "browser.revealInSystemBrowser",
    {
      urlField: "url",
      confirmationTitle: "确认访问本地或内网地址",
      actionLine: "将在系统浏览器中打开本地或私有网络地址（风险 L2）。",
      impactLine: "这类地址可能指向本机端口、路由器、NAS、开发服务或内网管理页。",
      refusalLine: "只有当你明确要访问这个地址时才继续；拒绝则不会打开。"
    }
  ],
  [
    "file.downloadToTemp",
    {
      urlField: "url",
      confirmationTitle: "确认从本地或内网地址下载",
      actionLine: "将从本地或私有网络地址下载文件（风险 L2）。",
      impactLine: "这类下载可能读取本机端口、路由器、NAS、开发服务或内网管理页返回的内容。",
      refusalLine: "只有当你明确信任这个来源时才继续；拒绝则不会下载。"
    }
  ]
]);

const SENSITIVE_PATH_TOOL_RULES = new Map<string, SensitivePathToolRule>([
  [
    "file.readText",
    {
      pathField: "path",
      confirmationTitle: "确认读取敏感文件",
      actionLine: "将读取可能包含密钥、令牌或凭据的本地文件（风险 L2）。",
      impactLine: "文件内容会进入本轮模型上下文，用于回答你的请求；虽然仍在本地工具白名单内，也应避免误读密钥。",
      refusalLine: "只有当你明确要读取这个文件时才继续；拒绝则不会读取。"
    }
  ]
]);

const REQUEST_HTTP_URL_PATTERN = /https?:\/\/[^\s<>"'，。！？；、）)\]}]+/gi;
const REQUEST_WINDOWS_PATH_PATTERN = /[A-Za-z]:[\\/][^\s"'<>|，。！？；、）)\]}]+/g;
const REQUEST_AWS_CREDENTIALS_PATTERN = /(?:~?[\\/])?\.aws[\\/]credentials\b/gi;
const REQUEST_SENSITIVE_FILE_TOKEN_PATTERN =
  /(?:^|[\s"'“”‘’（(【\[])(\.env(?:\.[A-Za-z0-9_.-]+)?|\.npmrc|\.pypirc|\.yarnrc|id_(?:rsa|dsa|ecdsa|ed25519)|application_default_credentials\.json|(?:secret|secrets|token|tokens|service-account)\.json|[A-Za-z0-9_.-]+\.(?:pem|key|p12|pfx))(?:$|[\s"'“”‘’。，,；;：:、）)】\]])/gi;

const URL_RELEVANT_TOOL_NAMES = [
  "browser.open",
  "browser.revealInSystemBrowser",
  "file.downloadToTemp"
];

const PATH_RELEVANT_TOOL_NAMES = [
  "file.readText",
  "file.searchText",
  "file.writeText",
  "file.move",
  "file.verify",
  "desktop.revealPath"
];

/**
 * 内置工具安全 hook。只抬升风险，不直接扩大或执行权限。
 * 当前覆盖本地/私网 URL 与敏感文件读取，避免模型被外部内容诱导探测端口或读取密钥。
 */
export function inspectToolInputSafety(toolName: string, input: unknown): ToolSafetyReview {
  const urlRule = SENSITIVE_URL_TOOL_RULES.get(toolName);
  if (urlRule) {
    const url = readStringField(input, urlRule.urlField);
    if (url) {
      const urlKind = classifySensitiveHttpUrl(url);
      if (urlKind) {
        return {
          riskLevel: "L2",
          reason: urlKind,
          confirmationTitle: urlRule.confirmationTitle,
          confirmationDescription: [
            urlRule.actionLine,
            `URL：${url.trim()}`,
            `原因：${urlKind}`,
            urlRule.impactLine,
            urlRule.refusalLine
          ].join("\n")
        };
      }
    }
  }

  const pathRule = SENSITIVE_PATH_TOOL_RULES.get(toolName);
  if (pathRule) {
    const path = readStringField(input, pathRule.pathField);
    if (path) {
      const pathKind = classifySensitiveFilePath(path);
      if (pathKind) {
        return {
          riskLevel: "L2",
          reason: pathKind,
          confirmationTitle: pathRule.confirmationTitle,
          confirmationDescription: [
            pathRule.actionLine,
            `路径：${path.trim()}`,
            `原因：${pathKind}`,
            pathRule.impactLine,
            pathRule.refusalLine
          ].join("\n")
        };
      }
    }
  }

  return {};
}

export function listToolSafetyHookDefinitions(): ToolSafetyHookDefinition[] {
  return [
    {
      id: "sensitive-local-network-url",
      label: "本地/私网 URL 动态确认",
      kind: "sensitive-url",
      riskLevel: "L2",
      requiresConfirmation: true,
      executionToolNames: [...SENSITIVE_URL_TOOL_RULES.keys()],
      preflightRelevantToolNames: [...URL_RELEVANT_TOOL_NAMES],
      triggerSummary: [
        "localhost / *.localhost",
        "127.0.0.0/8 回环地址",
        "10.0.0.0/8、172.16.0.0/12、192.168.0.0/16 私有地址",
        "169.254.0.0/16 链路本地地址",
        ".local / .lan / .internal / .home.arpa 内网域名",
        "单标签主机名和 IPv6 回环/链路本地/唯一本地地址"
      ],
      confirmationTitles: listUniqueRuleTitles(SENSITIVE_URL_TOOL_RULES),
      boundary: "只抬升风险并要求确认；不会主动扫描端口、不会请求 URL、不会扩大浏览器或下载权限。"
    },
    {
      id: "sensitive-credential-file-path",
      label: "敏感凭据路径动态确认",
      kind: "sensitive-path",
      riskLevel: "L2",
      requiresConfirmation: true,
      executionToolNames: [...SENSITIVE_PATH_TOOL_RULES.keys()],
      preflightRelevantToolNames: [...PATH_RELEVANT_TOOL_NAMES],
      triggerSummary: [
        ".env / .env.* 环境变量文件",
        ".npmrc / .pypirc / .yarnrc 包管理器 token 配置",
        "id_rsa / id_dsa / id_ecdsa / id_ed25519 SSH 私钥",
        ".pem / .key / .p12 / .pfx 证书或私钥文件",
        ".aws/credentials、application_default_credentials.json",
        "secret.json / token.json / service-account.json 等凭据 JSON"
      ],
      confirmationTitles: listUniqueRuleTitles(SENSITIVE_PATH_TOOL_RULES),
      boundary: "只对读取敏感正文前抬升确认；预演阶段只分析请求文本，不读取路径或探测文件是否存在。"
    }
  ];
}

/**
 * 只读分析自然语言请求里的安全信号，供任务预演提前解释动态风险。
 * 不读取路径、不请求 URL，只做字符串级别的本地分类。
 */
export function inspectFreeformRequestSafety(
  request: string,
  allowedToolNames: string[] = []
): RequestSafetyFinding[] {
  const allowedToolSet = new Set(allowedToolNames);
  const findings: RequestSafetyFinding[] = [];

  for (const url of extractUniqueMatches(request, REQUEST_HTTP_URL_PATTERN)) {
    const reason = classifySensitiveHttpUrl(url);
    if (!reason) {
      continue;
    }
    findings.push({
      kind: "sensitive-url",
      value: trimFindingValue(url),
      riskLevel: "L2",
      reason,
      requiresConfirmation: true,
      relevantToolNames: filterRelevantTools(URL_RELEVANT_TOOL_NAMES, allowedToolSet),
      recommendation: "真正执行前应确认这是用户明确想访问或下载的本机/内网地址，避免被外部内容诱导探测本地端口。"
    });
  }

  const requestWithoutUrls = request.replace(REQUEST_HTTP_URL_PATTERN, " ");
  const pathCandidates = [
    ...extractUniqueMatches(requestWithoutUrls, REQUEST_WINDOWS_PATH_PATTERN),
    ...extractUniqueMatches(requestWithoutUrls, REQUEST_AWS_CREDENTIALS_PATTERN),
    ...extractSensitiveFileTokens(requestWithoutUrls)
  ];

  for (const path of dedupeStrings(pathCandidates)) {
    const reason = classifySensitiveFilePath(path);
    if (!reason) {
      continue;
    }
    findings.push({
      kind: "sensitive-path",
      value: trimFindingValue(path),
      riskLevel: "L2",
      reason,
      requiresConfirmation: true,
      relevantToolNames: filterRelevantTools(PATH_RELEVANT_TOOL_NAMES, allowedToolSet),
      recommendation: "真正执行前应确认用户确实需要处理该敏感路径；文件内容进入模型上下文前仍会走确认与脱敏边界。"
    });
  }

  return dedupeFindings(findings).slice(0, 10);
}

export function resolveHighestRiskLevel(...levels: Array<RiskLevel | undefined>): RiskLevel {
  let highest: RiskLevel = "L0";
  for (const level of levels) {
    if (level && RISK_ORDER[level] > RISK_ORDER[highest]) {
      highest = level;
    }
  }
  return highest;
}

function extractUniqueMatches(text: string, pattern: RegExp): string[] {
  pattern.lastIndex = 0;
  const matches = Array.from(text.matchAll(pattern), (match) => match[0]);
  pattern.lastIndex = 0;
  return dedupeStrings(matches.map(trimFindingValue).filter(Boolean));
}

function extractSensitiveFileTokens(text: string): string[] {
  REQUEST_SENSITIVE_FILE_TOKEN_PATTERN.lastIndex = 0;
  const matches = Array.from(
    text.matchAll(REQUEST_SENSITIVE_FILE_TOKEN_PATTERN),
    (match) => match[1] ?? ""
  );
  REQUEST_SENSITIVE_FILE_TOKEN_PATTERN.lastIndex = 0;
  return dedupeStrings(matches.map(trimFindingValue).filter(Boolean));
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function dedupeFindings(findings: RequestSafetyFinding[]): RequestSafetyFinding[] {
  const seen = new Set<string>();
  const result: RequestSafetyFinding[] = [];
  for (const finding of findings) {
    const key = `${finding.kind}:${finding.value.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(finding);
  }
  return result;
}

function filterRelevantTools(
  toolNames: string[],
  allowedToolSet: ReadonlySet<string>
): string[] {
  if (allowedToolSet.size === 0) {
    return [...toolNames];
  }
  const filtered = toolNames.filter((toolName) => allowedToolSet.has(toolName));
  return filtered.length > 0 ? filtered : [];
}

function listUniqueRuleTitles(
  rules: ReadonlyMap<string, { confirmationTitle: string }>
): string[] {
  return dedupeStrings([...rules.values()].map((rule) => rule.confirmationTitle));
}

function trimFindingValue(value: string): string {
  return value.trim().replace(/[，。！？；、）)\]}]+$/g, "");
}

function readStringField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function classifySensitiveHttpUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!hostname) {
    return null;
  }

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return "localhost 回环地址";
  }
  if (
    hostname.endsWith(".local")
    || hostname.endsWith(".lan")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".home.arpa")
  ) {
    return "本地域名或内网域名";
  }
  if (!hostname.includes(".") && !hostname.includes(":")) {
    return "单标签主机名，通常指向内网设备";
  }

  const ipv4Reason = classifyIpv4Host(hostname);
  if (ipv4Reason) {
    return ipv4Reason;
  }

  const ipv6Reason = classifyIpv6Host(hostname);
  if (ipv6Reason) {
    return ipv6Reason;
  }

  return null;
}

export function classifySensitiveFilePath(pathText: string): string | null {
  const normalized = pathText.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (!normalized) {
    return null;
  }

  const segments = normalized.split("/").filter(Boolean);
  const fileName = segments.at(-1) ?? "";
  if (!fileName) {
    return null;
  }

  if (fileName === ".env" || fileName.startsWith(".env.")) {
    return "环境变量文件可能包含 API Key 或令牌";
  }
  if (fileName === ".npmrc" || fileName === ".pypirc" || fileName === ".yarnrc") {
    return "包管理器配置可能包含访问令牌";
  }
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(fileName)) {
    return "SSH 私钥文件";
  }
  if (/\.(pem|key|p12|pfx)$/.test(fileName)) {
    return "证书或私钥文件";
  }
  if (fileName === "credentials" && segments.includes(".aws")) {
    return "AWS credentials 文件";
  }
  if (fileName === "application_default_credentials.json") {
    return "Google Cloud 默认凭据文件";
  }
  if (/^(secret|secrets|token|tokens|service-account)\.json$/.test(fileName)) {
    return "凭据或令牌 JSON 文件";
  }

  return null;
}

function classifyIpv4Host(hostname: string): string | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (
    octets.some((octet, index) =>
      !Number.isInteger(octet)
      || octet < 0
      || octet > 255
      || String(octet) !== parts[index]
    )
  ) {
    return null;
  }

  const [a, b] = octets;
  if (a === 10) {
    return "10.0.0.0/8 私有地址";
  }
  if (a === 127) {
    return "127.0.0.0/8 回环地址";
  }
  if (a === 169 && b === 254) {
    return "169.254.0.0/16 链路本地地址";
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return "172.16.0.0/12 私有地址";
  }
  if (a === 192 && b === 168) {
    return "192.168.0.0/16 私有地址";
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return "100.64.0.0/10 运营商级 NAT 地址";
  }
  if (a === 0) {
    return "0.0.0.0/8 本地网络地址";
  }

  return null;
}

function classifyIpv6Host(hostname: string): string | null {
  if (!hostname.includes(":")) {
    return null;
  }

  if (hostname === "::1" || hostname === "0:0:0:0:0:0:0:1") {
    return "IPv6 回环地址";
  }
  if (hostname.startsWith("fe80:")) {
    return "IPv6 链路本地地址";
  }
  if (/^f[cd][0-9a-f]{2}:/i.test(hostname)) {
    return "IPv6 唯一本地地址";
  }
  if (hostname.startsWith("::ffff:127.") || hostname.startsWith("0:0:0:0:0:ffff:127.")) {
    return "IPv4 映射回环地址";
  }
  if (hostname.startsWith("::ffff:10.") || hostname.startsWith("0:0:0:0:0:ffff:10.")) {
    return "IPv4 映射私有地址";
  }
  if (hostname.startsWith("::ffff:192.168.") || hostname.startsWith("0:0:0:0:0:ffff:192.168.")) {
    return "IPv4 映射私有地址";
  }

  return null;
}

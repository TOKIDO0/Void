export type CodeLanguage = "javascript" | "python";

export type CodeRunRequest = {
  language: CodeLanguage;
  code: string;
  timeoutMs?: number;
};

export type CodeRunData = {
  language: CodeLanguage;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
  ranAt: number;
};

export type CodeApiResponse<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };

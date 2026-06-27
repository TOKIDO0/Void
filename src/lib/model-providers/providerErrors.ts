export type ProviderRequestErrorKind = "http" | "network" | "proxy-unavailable";

type ProviderRequestErrorOptions = {
  kind: ProviderRequestErrorKind;
  status?: number;
  serviceMessage?: string;
  endpointUrl?: string;
  cause?: unknown;
};

export class ProviderRequestError extends Error {
  readonly kind: ProviderRequestErrorKind;
  readonly status?: number;
  readonly serviceMessage: string;
  readonly endpointUrl?: string;

  constructor(message: string, options: ProviderRequestErrorOptions) {
    super(message);
    this.name = "ProviderRequestError";
    this.kind = options.kind;
    this.status = options.status;
    this.serviceMessage = options.serviceMessage ?? "";
    this.endpointUrl = options.endpointUrl;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function createHttpStatusError(status: number, serviceMessage: string, endpointUrl: string) {
  return new ProviderRequestError(`模型请求失败：${status}`, {
    kind: "http",
    status,
    serviceMessage,
    endpointUrl
  });
}

export function createNetworkError(message: string, endpointUrl: string, cause?: unknown) {
  return new ProviderRequestError(message, {
    kind: "network",
    endpointUrl,
    cause
  });
}

export function createProxyUnavailableError(message: string, endpointUrl: string, cause?: unknown) {
  return new ProviderRequestError(message, {
    kind: "proxy-unavailable",
    endpointUrl,
    cause
  });
}

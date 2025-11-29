export type RepoFileInformationRequest = {
  id?: string;
  type: "repo_file";
  path: string;
  startLine?: number;
  endLine?: number;
  maxBytes?: number;
  reason?: string;
};

export type HttpInformationRequest = {
  id?: string;
  type: "http_get";
  url: string;
  method?: "GET";
  headers?: Record<string, string>;
  maxBytes?: number;
  reason?: string;
};

export type InformationRequest =
  | RepoFileInformationRequest
  | HttpInformationRequest;

export type InformationRequestRecord = {
  request: InformationRequest;
  status: "success" | "error" | "duplicate";
  summaryBlock: string;
  contentSnippet?: string;
  truncated?: boolean;
  artifactPath?: string;
  error?: string;
  metadata?: Record<string, any>;
};

export interface HandlerMeta {
  persona: string;
  step: string;
  iteration: number;
  taskId?: string | number;
}

/**
 * Runtime Type Definitions
 *
 * Types used by the workflow executor and HTTP client at runtime.
 */

// ─── Workflow Execution ───

export interface WorkflowExecutionOptions {
  /** Input values for the workflow */
  inputs: Record<string, unknown>;
  /** Base URLs for source descriptions (name → baseUrl) */
  serverUrls: Record<string, string>;
  /** Auth token provider: given a source name, return the auth header value */
  authProvider?: AuthProvider;
  /** Custom HTTP client (defaults to fetch-based) */
  httpClient?: HttpClient;
  /** Event hooks for step execution */
  hooks?: ExecutionHooks;
  /**
   * Handler for interactive GNAP grants that require user consent.
   *
   * When a step's response contains `interact.redirect`, the executor pauses
   * and calls this handler with the redirect URL. The handler must:
   * 1. Redirect the user to the URL for consent
   * 2. Capture the `interact_ref` from the callback
   * 3. Return the `interact_ref` so the executor can continue the grant
   *
   * If not provided, interactive grant steps will throw an error.
   */
  interactionHandler?: InteractionHandler;
}

/**
 * Handles interactive GNAP grant consent flows.
 *
 * @param context - Details about the interaction required
 * @returns The `interact_ref` received from the redirect callback
 */
export type InteractionHandler = (
  context: InteractionContext,
) => Promise<string>;

export interface InteractionContext {
  /** The URL to redirect the user to for consent */
  redirectUrl: string;
  /** The grant continuation URI */
  continueUri: string;
  /** The continue access token */
  continueAccessToken: string;
  /** Finish nonce for verifying the interaction hash */
  finishNonce?: string;
  /** Server-suggested wait time in seconds before continuing */
  continueWait?: number;
  /** The workflow step that triggered the interaction */
  stepId: string;
}

export interface AuthProvider {
  /** Get authorization header value for requests to a given source */
  getAuthHeader(sourceName: string, operationId: string): Promise<string | undefined>;
  /** Optional: sign the full request (for HTTP message signatures) */
  signRequest?(request: HttpRequest): Promise<HttpRequest>;
}

export interface HttpClient {
  execute(request: HttpRequest): Promise<HttpResponse>;
}

export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

// ─── Step Results ───

export interface StepResult {
  stepId: string;
  request: HttpRequest;
  response: HttpResponse;
  outputs: Record<string, unknown>;
  success: boolean;
  duration: number;
  /** If this step triggered an interaction, the details are captured here */
  interaction?: InteractionContext;
}

export interface WorkflowResult {
  workflowId: string;
  success: boolean;
  outputs: Record<string, unknown>;
  steps: StepResult[];
  duration: number;
  error?: string;
}

// ─── Execution Hooks ───

export interface ExecutionHooks {
  /** Called before each step executes */
  beforeStep?(stepId: string, request: HttpRequest): void | Promise<void>;
  /** Called after each step completes */
  afterStep?(stepId: string, result: StepResult): void | Promise<void>;
  /** Called if a step fails */
  onStepError?(stepId: string, error: Error): void | Promise<void>;
  /** Called when a token is acquired from a grant step */
  onTokenAcquired?(stepId: string, token: string, type: string): void | Promise<void>;
  /** Called when server URLs are dynamically resolved */
  onServerResolved?(stepId: string, servers: Record<string, string>): void | Promise<void>;
}

// ─── GNAP Auth Configuration ───

export interface GnapAuthConfig {
  /** The client's wallet address URL for GNAP identification */
  clientWalletAddress: string;
  /** Private key for HTTP message signatures (PEM or JWK) */
  privateKey: string | JsonWebKey;
  /** Key ID for the signing key */
  keyId: string;
}

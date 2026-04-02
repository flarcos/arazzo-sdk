/**
 * Workflow Executor
 *
 * Executes a parsed Arazzo workflow at runtime with:
 *
 * 1. **Dynamic token passing** — Captures access tokens from grant steps
 *    and automatically injects them as Authorization headers in subsequent
 *    resource server calls.
 *
 * 2. **Interactive grant handling** — When a step returns an interact.redirect,
 *    the executor pauses and calls the user-provided InteractionHandler to
 *    obtain consent, then resumes the grant continuation.
 *
 * 3. **Dynamic server URL resolution** — When a wallet address resolution step
 *    returns authServer/resourceServer URLs, the executor dynamically updates
 *    the server URL map for subsequent steps.
 */

import type { WorkflowObject, StepObject } from '../parser/types.js';
import { splitOperationId } from '../parser/arazzo-parser.js';
import {
  resolveExpression,
  resolveDeep,
  type ExpressionContext,
} from './expression-resolver.js';
import { FetchHttpClient } from './http-client.js';
import type {
  WorkflowExecutionOptions,
  WorkflowResult,
  StepResult,
  HttpRequest,
  HttpClient,
  InteractionContext,
} from './types.js';

export class WorkflowExecutionError extends Error {
  constructor(
    message: string,
    public workflowId: string,
    public stepId?: string,
  ) {
    super(
      `[WorkflowExecutor] ${workflowId}${stepId ? `.${stepId}` : ''}: ${message}`,
    );
    this.name = 'WorkflowExecutionError';
  }
}

/**
 * Internal execution state maintained across steps.
 * Tracks dynamically resolved server URLs and acquired tokens.
 */
interface ExecutionState {
  /** Mutable copy of server URLs, updated when wallet addresses are resolved */
  serverUrls: Record<string, string>;
  /** Most recently acquired access token (used for the next resource call) */
  currentToken: string | null;
  /** All tokens acquired during execution, keyed by step output name */
  tokenHistory: Map<string, string>;
}

/**
 * Execute an Arazzo workflow.
 *
 * @param workflow - The parsed workflow object
 * @param options - Execution options including inputs, server URLs, and auth
 * @returns The workflow result with all outputs and step details
 */
export async function executeWorkflow(
  workflow: WorkflowObject,
  options: WorkflowExecutionOptions,
): Promise<WorkflowResult> {
  const startTime = Date.now();
  const httpClient: HttpClient =
    options.httpClient || new FetchHttpClient(options.authProvider);

  // Build execution context
  const context: ExpressionContext = {
    inputs: options.inputs,
    steps: {},
  };

  // Initialize mutable execution state
  const state: ExecutionState = {
    serverUrls: { ...options.serverUrls },
    currentToken: null,
    tokenHistory: new Map(),
  };

  const stepResults: StepResult[] = [];

  try {
    // Execute each step sequentially
    for (const step of workflow.steps) {
      const stepResult = await executeStep(
        step,
        workflow.workflowId,
        context,
        options,
        state,
        httpClient,
      );

      stepResults.push(stepResult);

      // Store step result in context for subsequent expression resolution
      context.steps[step.stepId] = stepResult;

      // ─── Feature 1: Capture tokens from grant step outputs ───
      captureTokens(stepResult, state, options);

      // ─── Feature 3: Capture dynamic server URLs ───
      captureDynamicServerUrls(stepResult, state, options);

      // ─── Feature 2: Handle interactive grants ───
      if (hasInteractionRedirect(stepResult)) {
        await handleInteraction(
          step,
          stepResult,
          workflow.workflowId,
          context,
          options,
          state,
          httpClient,
          stepResults,
        );
      }

      // Call afterStep hook
      if (options.hooks?.afterStep) {
        await options.hooks.afterStep(step.stepId, stepResult);
      }

      // Check if step failed
      if (!stepResult.success) {
        return {
          workflowId: workflow.workflowId,
          success: false,
          outputs: {},
          steps: stepResults,
          duration: Date.now() - startTime,
          error: `Step "${step.stepId}" failed with status ${stepResult.response.status}`,
        };
      }
    }

    // Resolve workflow-level outputs
    const outputs = resolveWorkflowOutputs(workflow, context);

    return {
      workflowId: workflow.workflowId,
      success: true,
      outputs,
      steps: stepResults,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    return {
      workflowId: workflow.workflowId,
      success: false,
      outputs: {},
      steps: stepResults,
      duration: Date.now() - startTime,
      error: errorMessage,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Feature 1: Dynamic Token Passing
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Token output naming convention in Open Payments Arazzo workflows:
 *
 *   incomingPaymentAccessToken  → used for create-incoming-payment
 *   quoteAccessToken           → used for create-quote
 *   outgoingPaymentAccessToken → used for create-outgoing-payment
 *   continueAccessToken        → used for post-continue
 *   accessToken                → generic (used for list/get operations)
 *
 * The executor captures ANY output whose key ends with "AccessToken" or
 * equals "accessToken" and stores it as the current auth token for the
 * next resource server request.
 */

const TOKEN_OUTPUT_PATTERNS = [
  /AccessToken$/,     // e.g., incomingPaymentAccessToken
  /^accessToken$/,    // generic accessToken
];

function captureTokens(
  stepResult: StepResult,
  state: ExecutionState,
  options: WorkflowExecutionOptions,
): void {
  for (const [key, value] of Object.entries(stepResult.outputs)) {
    if (typeof value === 'string' && isTokenOutput(key)) {
      state.currentToken = value;
      state.tokenHistory.set(key, value);

      // Notify via hook
      if (options.hooks?.onTokenAcquired) {
        options.hooks.onTokenAcquired(stepResult.stepId, value, key);
      }
    }
  }
}

function isTokenOutput(key: string): boolean {
  return TOKEN_OUTPUT_PATTERNS.some((pattern) => pattern.test(key));
}

// ═══════════════════════════════════════════════════════════════════════════
// Feature 2: Interactive Grant Handling
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Detects if a step's response contains an interactive grant redirect.
 * In Open Payments, this means the response has `interact.redirect`.
 */
function hasInteractionRedirect(stepResult: StepResult): boolean {
  const body = stepResult.response.body as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return false;

  const interact = body.interact as Record<string, unknown> | undefined;
  return !!(interact && typeof interact.redirect === 'string');
}

/**
 * Handle an interactive grant by:
 * 1. Extracting redirect URL and continuation details
 * 2. Calling the user's InteractionHandler
 * 3. The interact_ref is stored so the NEXT step (continue grant)
 *    can use it in its request body
 */
async function handleInteraction(
  step: StepObject,
  stepResult: StepResult,
  workflowId: string,
  context: ExpressionContext,
  options: WorkflowExecutionOptions,
  state: ExecutionState,
  _httpClient: HttpClient,
  _stepResults: StepResult[],
): Promise<void> {
  const body = stepResult.response.body as Record<string, unknown>;
  const interact = body.interact as Record<string, unknown>;
  const continueInfo = body.continue as Record<string, unknown>;

  const redirectUrl = interact.redirect as string;
  const continueUri = continueInfo?.uri as string;
  const continueAccessTokenObj = continueInfo?.access_token as Record<string, unknown>;
  const continueAccessToken = continueAccessTokenObj?.value as string;
  const continueWait = continueInfo?.wait as number | undefined;
  const finishNonce = interact.finish as string | undefined;

  const interactionContext: InteractionContext = {
    redirectUrl,
    continueUri,
    continueAccessToken,
    finishNonce,
    continueWait,
    stepId: step.stepId,
  };

  // Store interaction context on the step result
  stepResult.interaction = interactionContext;

  // Store the continue token for the next step
  if (continueAccessToken) {
    state.currentToken = continueAccessToken;
    state.tokenHistory.set('continueAccessToken', continueAccessToken);
  }

  if (!options.interactionHandler) {
    throw new WorkflowExecutionError(
      `Step "${step.stepId}" requires user interaction (redirect to ${redirectUrl}) ` +
        `but no interactionHandler was provided. Pass an interactionHandler in the ` +
        `workflow execution options to handle interactive grants.`,
      workflowId,
      step.stepId,
    );
  }

  // Call the user's handler and get the interact_ref
  const interactRef = await options.interactionHandler(interactionContext);

  // Store the interact_ref in the step outputs so the next step
  // (continue grant) can reference it via $steps.{stepId}.outputs.interactRef
  stepResult.outputs.interactRef = interactRef;

  // Also update in the context
  if (context.steps[step.stepId]) {
    context.steps[step.stepId].outputs.interactRef = interactRef;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Feature 3: Dynamic Server URL Resolution
// ═══════════════════════════════════════════════════════════════════════════

/**
 * When a wallet address resolution step returns authServer and
 * resourceServer URLs, dynamically update the server URL map.
 *
 * This handles the Open Payments pattern where:
 * - Step 1: GET wallet address → returns authServer + resourceServer
 * - Step 2+: Use the discovered URLs for subsequent requests
 */

const SERVER_OUTPUT_PATTERNS: Record<string, string> = {
  // Output keys that map to source description names
  authServer: 'authServer',
  recipientAuthServer: 'authServer',
  senderAuthServer: 'authServer',
  resourceServer: 'resourceServer',
  recipientResourceServer: 'resourceServer',
  senderResourceServer: 'resourceServer',
};

function captureDynamicServerUrls(
  stepResult: StepResult,
  state: ExecutionState,
  options: WorkflowExecutionOptions,
): void {
  const resolved: Record<string, string> = {};

  for (const [key, value] of Object.entries(stepResult.outputs)) {
    if (typeof value === 'string' && key in SERVER_OUTPUT_PATTERNS) {
      const sourceName = SERVER_OUTPUT_PATTERNS[key];
      state.serverUrls[sourceName] = value;
      resolved[sourceName] = value;
    }
  }

  if (Object.keys(resolved).length > 0 && options.hooks?.onServerResolved) {
    options.hooks.onServerResolved(stepResult.stepId, resolved);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Step Execution
// ═══════════════════════════════════════════════════════════════════════════

async function executeStep(
  step: StepObject,
  workflowId: string,
  context: ExpressionContext,
  options: WorkflowExecutionOptions,
  state: ExecutionState,
  httpClient: HttpClient,
): Promise<StepResult> {
  const stepStart = Date.now();

  // Build the HTTP request from the step definition
  const request = buildRequest(step, workflowId, context, state);

  // ─── Inject auth token ───
  // If we have a current token and this is a resource server or auth continue call,
  // inject it as the Authorization header
  if (state.currentToken && !request.headers['Authorization']) {
    const [sourceName, operationName] = splitOperationId(step.operationId || '');

    // Inject token for resource server calls and auth continuation calls
    if (
      sourceName === 'resourceServer' ||
      operationName === 'post-continue' ||
      operationName === 'post-token' ||
      operationName === 'delete-token' ||
      operationName === 'delete-continue'
    ) {
      request.headers['Authorization'] = `GNAP ${state.currentToken}`;
    }
  }

  // Call beforeStep hook
  if (options.hooks?.beforeStep) {
    await options.hooks.beforeStep(step.stepId, request);
  }

  try {
    // Execute HTTP request
    const response = await httpClient.execute(request);

    // Update context with current response for expression resolution
    context.currentResponse = {
      status: response.status,
      headers: response.headers,
      body: response.body,
    };
    context.currentRequest = {
      url: request.url,
      method: request.method,
    };

    // Evaluate success criteria
    const success = evaluateSuccessCriteria(step, context);

    // Resolve step outputs
    const outputs = resolveStepOutputs(step, context);

    return {
      stepId: step.stepId,
      request,
      response,
      outputs,
      success,
      duration: Date.now() - stepStart,
    };
  } catch (error) {
    if (options.hooks?.onStepError) {
      await options.hooks.onStepError(
        step.stepId,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    throw new WorkflowExecutionError(
      `HTTP request failed: ${error instanceof Error ? error.message : error}`,
      workflowId,
      step.stepId,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Request Building
// ═══════════════════════════════════════════════════════════════════════════

function buildRequest(
  step: StepObject,
  workflowId: string,
  context: ExpressionContext,
  state: ExecutionState,
): HttpRequest {
  if (!step.operationId) {
    throw new WorkflowExecutionError(
      'Only operationId-based steps are currently supported',
      workflowId,
      step.stepId,
    );
  }

  const [sourceName, operationName] = splitOperationId(step.operationId);

  // Use dynamically resolved server URLs
  const baseUrl = state.serverUrls[sourceName];
  if (!baseUrl) {
    throw new WorkflowExecutionError(
      `No server URL configured for source "${sourceName}". ` +
        `Available: [${Object.keys(state.serverUrls).join(', ')}]`,
      workflowId,
      step.stepId,
    );
  }

  // Build URL from operation name
  const { url, method } = resolveOperationUrl(
    baseUrl,
    operationName,
    step,
    context,
  );

  // Build headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  // Apply parameter-based headers
  if (step.parameters) {
    for (const param of step.parameters) {
      if (param.in === 'header') {
        const value = resolveExpression(String(param.value), context);
        headers[param.name] = String(value);
      }
    }
  }

  // Build request body
  let body: unknown;
  if (step.requestBody?.payload) {
    body = resolveDeep(step.requestBody.payload, context);

    // ─── Feature 2: Replace interact_ref placeholder ───
    // If the body contains the placeholder string, replace it with the
    // actual interact_ref from the previous step's outputs
    body = replaceInteractRefPlaceholder(body, context);
  }

  return { url, method, headers, body };
}

/**
 * Replace the `{interact_ref_from_redirect}` placeholder in request bodies
 * with the actual interact_ref obtained from the interaction handler.
 */
function replaceInteractRefPlaceholder(
  body: unknown,
  context: ExpressionContext,
): unknown {
  if (typeof body === 'string') {
    if (body === '{interact_ref_from_redirect}') {
      // Find the interact_ref from any previous step's outputs
      for (const stepResult of Object.values(context.steps)) {
        if (stepResult.outputs.interactRef) {
          return stepResult.outputs.interactRef;
        }
      }
    }
    return body;
  }

  if (Array.isArray(body)) {
    return body.map((item) => replaceInteractRefPlaceholder(item, context));
  }

  if (body !== null && typeof body === 'object') {
    const replaced: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(body as Record<string, unknown>)) {
      replaced[key] = replaceInteractRefPlaceholder(val, context);
    }
    return replaced;
  }

  return body;
}

/**
 * Maps an Arazzo operationId to an HTTP method and URL path.
 * Uses Open Payments naming conventions.
 */
function resolveOperationUrl(
  baseUrl: string,
  operationName: string,
  step: StepObject,
  context: ExpressionContext,
): { url: string; method: string } {
  // Operation name to HTTP method + path mapping
  const operationMap: Record<string, { method: string; path: string }> = {
    // Wallet Address
    'get-wallet-address': { method: 'GET', path: '/' },

    // Incoming Payments
    'create-incoming-payment': { method: 'POST', path: '/incoming-payments' },
    'list-incoming-payments': { method: 'GET', path: '/incoming-payments' },
    'get-incoming-payment': { method: 'GET', path: '/incoming-payments/{id}' },
    'complete-incoming-payment': {
      method: 'POST',
      path: '/incoming-payments/{id}/complete',
    },

    // Outgoing Payments
    'create-outgoing-payment': { method: 'POST', path: '/outgoing-payments' },
    'list-outgoing-payments': { method: 'GET', path: '/outgoing-payments' },
    'get-outgoing-payment': {
      method: 'GET',
      path: '/outgoing-payments/{id}',
    },

    // Quotes
    'create-quote': { method: 'POST', path: '/quotes' },
    'get-quote': { method: 'GET', path: '/quotes/{id}' },

    // Auth (GNAP)
    'post-request': { method: 'POST', path: '/' },
    'post-continue': { method: 'POST', path: '/continue/{id}' },
    'delete-continue': { method: 'DELETE', path: '/continue/{id}' },
    'post-token': { method: 'POST', path: '/token/{id}' },
    'delete-token': { method: 'DELETE', path: '/token/{id}' },
  };

  const mapping = operationMap[operationName];
  if (!mapping) {
    throw new Error(
      `Unknown operation "${operationName}". Add it to the operation map.`,
    );
  }

  let path = mapping.path;

  // Resolve path parameters
  if (step.parameters) {
    for (const param of step.parameters) {
      if (param.in === 'path') {
        const value = resolveExpression(String(param.value), context);
        path = path.replace(`{${param.name}}`, encodeURIComponent(String(value)));
      }
    }
  }

  // Resolve query parameters
  const queryParams: string[] = [];
  if (step.parameters) {
    for (const param of step.parameters) {
      if (param.in === 'query') {
        const value = resolveExpression(String(param.value), context);
        if (value !== undefined && value !== null) {
          queryParams.push(
            `${encodeURIComponent(param.name)}=${encodeURIComponent(String(value))}`,
          );
        }
      }
    }
  }

  const cleanBase = baseUrl.replace(/\/+$/, '');
  const cleanPath = path === '/' ? '' : path;
  let url = `${cleanBase}${cleanPath}`;

  if (queryParams.length > 0) {
    url += `?${queryParams.join('&')}`;
  }

  return { url, method: mapping.method };
}

// ═══════════════════════════════════════════════════════════════════════════
// Success Criteria Evaluation
// ═══════════════════════════════════════════════════════════════════════════

function evaluateSuccessCriteria(
  step: StepObject,
  context: ExpressionContext,
): boolean {
  if (!step.successCriteria || step.successCriteria.length === 0) {
    const status = context.currentResponse?.status ?? 0;
    return status >= 200 && status < 300;
  }

  return step.successCriteria.every((criterion) => {
    return evaluateCondition(criterion.condition, context);
  });
}

function evaluateCondition(
  condition: string,
  context: ExpressionContext,
): boolean {
  const match = condition.match(
    /^(\$[.\w]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/,
  );
  if (!match) {
    return true;
  }

  const [, leftExpr, operator, rightRaw] = match;
  const leftValue = resolveExpression(leftExpr, context);
  const rightValue = parseConditionValue(rightRaw.trim());

  switch (operator) {
    case '==':
      return leftValue == rightValue;
    case '!=':
      return leftValue != rightValue;
    case '>=':
      return Number(leftValue) >= Number(rightValue);
    case '<=':
      return Number(leftValue) <= Number(rightValue);
    case '>':
      return Number(leftValue) > Number(rightValue);
    case '<':
      return Number(leftValue) < Number(rightValue);
    default:
      return true;
  }
}

function parseConditionValue(raw: string): unknown {
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

// ═══════════════════════════════════════════════════════════════════════════
// Output Resolution
// ═══════════════════════════════════════════════════════════════════════════

function resolveStepOutputs(
  step: StepObject,
  context: ExpressionContext,
): Record<string, unknown> {
  if (!step.outputs) {
    return {};
  }

  const outputs: Record<string, unknown> = {};
  for (const [key, expression] of Object.entries(step.outputs)) {
    outputs[key] = resolveExpression(expression, context);
  }
  return outputs;
}

function resolveWorkflowOutputs(
  workflow: WorkflowObject,
  context: ExpressionContext,
): Record<string, unknown> {
  if (!workflow.outputs) {
    return {};
  }

  const outputs: Record<string, unknown> = {};
  for (const [key, expression] of Object.entries(workflow.outputs)) {
    outputs[key] = resolveExpression(expression, context);
  }
  return outputs;
}

/**
 * Code Templates
 *
 * TypeScript code templates used by the code generator to emit
 * workflow SDK files.
 */

/**
 * Generate the file header with imports.
 */
export function fileHeader(): string {
  return `/**
 * Open Payments Arazzo SDK — Auto-generated workflow functions
 *
 * Generated from Arazzo 1.0.1 workflow specifications.
 * Do not edit manually — regenerate with: arazzo-sdk generate
 *
 * @generated
 */

import type {
  WorkflowExecutionOptions,
  WorkflowResult,
  AuthProvider,
  GnapAuthConfig,
  ExecutionHooks,
  InteractionHandler,
} from '../runtime/types.js';
import { executeWorkflow } from '../runtime/workflow-executor.js';
import { FetchHttpClient, GnapAuthProvider } from '../runtime/http-client.js';
import type { WorkflowObject } from '../parser/types.js';
`;
}

/**
 * Generate the Amount type used across Open Payments.
 */
export function amountType(): string {
  return `
/** Open Payments amount object */
export interface Amount {
  /** Amount in minor units (e.g., "2500" for $25.00) */
  value: string;
  /** Currency code (e.g., "USD") */
  assetCode: string;
  /** Asset scale (e.g., 2 for cents) */
  assetScale: number;
}
`;
}

/**
 * Generate the client class that wraps all workflows.
 */
export function clientClassHeader(className: string): string {
  return `
/**
 * ${className} — typed workflow executor for Open Payments API.
 *
 * Usage:
 * \`\`\`typescript
 * const client = new ${className}({
 *   clientWalletAddress: 'https://wallet.example.com/me',
 *   serverUrls: {
 *     walletAddressServer: 'https://wallet.example.com',
 *     resourceServer: 'https://wallet.example.com',
 *     authServer: 'https://auth.wallet.example.com',
 *   },
 * });
 *
 * const result = await client.oneTimePaymentFixedReceive({ ... });
 * \`\`\`
 */
export class ${className} {
  private serverUrls: Record<string, string>;
  private authProvider?: AuthProvider;
  private hooks?: ExecutionHooks;
  private interactionHandler?: InteractionHandler;

  constructor(options: {
    /** Base URLs for each source description */
    serverUrls: Record<string, string>;
    /** GNAP auth configuration */
    gnapConfig?: GnapAuthConfig;
    /** Custom auth provider (overrides gnapConfig) */
    authProvider?: AuthProvider;
    /** Execution hooks for monitoring */
    hooks?: ExecutionHooks;
    /**
     * Handler for interactive GNAP grants requiring user consent.
     * Called when a workflow step returns an interact.redirect URL.
     * Must return the interact_ref from the redirect callback.
     */
    interactionHandler?: InteractionHandler;
  }) {
    this.serverUrls = options.serverUrls;
    this.hooks = options.hooks;
    this.interactionHandler = options.interactionHandler;

    if (options.authProvider) {
      this.authProvider = options.authProvider;
    } else if (options.gnapConfig) {
      this.authProvider = new GnapAuthProvider(options.gnapConfig);
    }
  }

  /**
   * Set the GNAP access token for a source.
   * Call this after obtaining tokens from grant requests.
   */
  setToken(sourceName: string, token: string): void {
    if (this.authProvider && 'setToken' in this.authProvider) {
      (this.authProvider as GnapAuthProvider).setToken(sourceName, token);
    }
  }
`;
}

/**
 * Generate a workflow method inside the client class.
 */
export function workflowMethod(
  methodName: string,
  inputTypeName: string,
  outputTypeName: string,
  workflowId: string,
  description: string,
  workflowDefinition: string,
): string {
  return `
  /**
   * ${description}
   */
  async ${methodName}(inputs: ${inputTypeName}): Promise<${outputTypeName} & { _raw: WorkflowResult }> {
    const workflow: WorkflowObject = ${workflowDefinition};

    const result = await executeWorkflow(workflow, {
      inputs: inputs as unknown as Record<string, unknown>,
      serverUrls: this.serverUrls,
      authProvider: this.authProvider,
      hooks: this.hooks,
      interactionHandler: this.interactionHandler,
    });

    if (!result.success) {
      throw new Error(
        \`Workflow "${workflowId}" failed: \${result.error || 'Unknown error'}\`,
      );
    }

    return {
      ...(result.outputs as unknown as ${outputTypeName}),
      _raw: result,
    };
  }
`;
}

/**
 * Generate the client class footer.
 */
export function clientClassFooter(): string {
  return `}
`;
}

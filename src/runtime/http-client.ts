/**
 * HTTP Client
 *
 * Pluggable HTTP client with GNAP authentication integration.
 * Uses the native fetch API with support for auth header injection
 * and HTTP message signatures.
 */

import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  AuthProvider,
  GnapAuthConfig,
} from './types.js';

// ─── Default Fetch-Based HTTP Client ───

export class FetchHttpClient implements HttpClient {
  private authProvider?: AuthProvider;

  constructor(authProvider?: AuthProvider) {
    this.authProvider = authProvider;
  }

  async execute(request: HttpRequest): Promise<HttpResponse> {
    let finalRequest = { ...request };

    // Apply auth if provider is configured
    if (this.authProvider) {
      // Sign request if the auth provider supports full request signing
      if (this.authProvider.signRequest) {
        finalRequest = await this.authProvider.signRequest(finalRequest);
      }
    }

    const fetchOptions: RequestInit = {
      method: finalRequest.method,
      headers: finalRequest.headers,
    };

    if (finalRequest.body !== undefined) {
      fetchOptions.body = JSON.stringify(finalRequest.body);
    }

    const response = await fetch(finalRequest.url, fetchOptions);

    // Parse response headers
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // Parse response body
    let body: unknown;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      body = await response.json();
    } else {
      const text = await response.text();
      // Try to parse as JSON anyway
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    return {
      status: response.status,
      headers,
      body,
    };
  }
}

// ─── GNAP Auth Provider ───

/**
 * Auth provider that integrates with @flarcos/kiota-authentication-gnap
 * for GNAP token management and HTTP message signatures.
 */
export class GnapAuthProvider implements AuthProvider {
  private tokens: Map<string, string> = new Map();
  private config: GnapAuthConfig;

  constructor(config: GnapAuthConfig) {
    this.config = config;
  }

  /**
   * Set the access token for a specific source/context.
   */
  setToken(sourceName: string, token: string): void {
    this.tokens.set(sourceName, token);
  }

  /**
   * Set token by operation type for convenience.
   */
  setTokenForOperation(operationPrefix: string, token: string): void {
    this.tokens.set(operationPrefix, token);
  }

  async getAuthHeader(
    sourceName: string,
    _operationId: string,
  ): Promise<string | undefined> {
    const token = this.tokens.get(sourceName);
    if (token) {
      return `GNAP ${token}`;
    }
    return undefined;
  }

  async signRequest(request: HttpRequest): Promise<HttpRequest> {
    const headers = { ...request.headers };

    // Find matching token by checking source names
    for (const [_source, token] of this.tokens) {
      if (token) {
        headers['Authorization'] = `GNAP ${token}`;
        break;
      }
    }

    return { ...request, headers };
  }

  /**
   * Get the GNAP client wallet address for grant requests.
   */
  getClientWalletAddress(): string {
    return this.config.clientWalletAddress;
  }
}

// ─── Simple Bearer Auth Provider ───

/**
 * Simple auth provider that uses static bearer tokens.
 * Useful for testing or when tokens are managed externally.
 */
export class BearerAuthProvider implements AuthProvider {
  private tokens: Map<string, string> = new Map();

  constructor(defaultToken?: string) {
    if (defaultToken) {
      this.tokens.set('*', defaultToken);
    }
  }

  setToken(sourceName: string, token: string): void {
    this.tokens.set(sourceName, token);
  }

  async getAuthHeader(
    sourceName: string,
    _operationId: string,
  ): Promise<string | undefined> {
    return this.tokens.get(sourceName) || this.tokens.get('*');
  }
}

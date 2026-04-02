/**
 * @flarcos/arazzo-sdk
 *
 * Parse Arazzo 1.0.1 workflow specifications and generate typed
 * TypeScript SDKs for Open Payments API workflows.
 *
 * This package provides:
 * - **Parser**: Read Arazzo YAML files into typed ASTs
 * - **Runtime**: Execute workflows dynamically at runtime
 * - **Generator**: Generate typed TypeScript SDK code from Arazzo specs
 * - **CLI**: Command-line tool for code generation and validation
 */

// ─── Parser ───
export {
  parseArazzoFile,
  parseArazzoFiles,
  parseArazzoContent,
  extractOperationIds,
  extractExpressions,
  splitOperationId,
  ArazzoParserError,
} from './parser/arazzo-parser.js';

export type {
  ArazzoDocument,
  InfoObject,
  SourceDescription,
  WorkflowObject,
  StepObject,
  ParameterObject,
  RequestBodyObject,
  SuccessCriterionObject,
  ActionObject,
  JsonSchemaObject,
  JsonSchemaProperty,
  ParsedWorkflow,
  ResolvedSource,
} from './parser/types.js';

// ─── Runtime ───
export { executeWorkflow, WorkflowExecutionError } from './runtime/workflow-executor.js';

export {
  resolveExpression,
  resolveDeep,
  isExpression,
  extractExpressionRefs,
  ExpressionError,
} from './runtime/expression-resolver.js';

export type { ExpressionContext } from './runtime/expression-resolver.js';

export {
  FetchHttpClient,
  GnapAuthProvider,
  BearerAuthProvider,
} from './runtime/http-client.js';

export type {
  WorkflowExecutionOptions,
  WorkflowResult,
  StepResult,
  HttpClient,
  HttpRequest,
  HttpResponse,
  AuthProvider,
  GnapAuthConfig,
  ExecutionHooks,
  InteractionHandler,
  InteractionContext,
} from './runtime/types.js';

// ─── Generator ───
export { generateSDK, generateTypes } from './generator/codegen.js';
export type { CodegenOptions } from './generator/codegen.js';

export {
  mapSchemaTypeToTS,
  generateInterface,
  generateOutputInterface,
  generateInterfaceProperties,
  toPascalCase,
  toCamelCase,
} from './generator/type-mapper.js';

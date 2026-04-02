/**
 * Arazzo Specification 1.0.1 Type Definitions
 *
 * Typed interfaces for the complete Arazzo spec, used by the parser
 * and code generator.
 *
 * @see https://spec.openapis.org/arazzo/v1.0.1
 */

// ─── Root Document ───

export interface ArazzoDocument {
  arazzo: string;
  info: InfoObject;
  sourceDescriptions: SourceDescription[];
  workflows: WorkflowObject[];
  components?: ComponentsObject;
}

// ─── Info ───

export interface InfoObject {
  title: string;
  summary?: string;
  description?: string;
  version: string;
}

// ─── Source Descriptions ───

export interface SourceDescription {
  name: string;
  url: string;
  type: 'openapi' | 'arazzo';
}

// ─── Workflows ───

export interface WorkflowObject {
  workflowId: string;
  summary?: string;
  description?: string;
  inputs?: JsonSchemaObject;
  parameters?: ParameterObject[];
  steps: StepObject[];
  outputs?: Record<string, string>;
  successActions?: ActionObject[];
  failureActions?: ActionObject[];
}

// ─── Steps ───

export interface StepObject {
  stepId: string;
  description?: string;
  operationId?: string;
  operationPath?: string;
  workflowId?: string;
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  successCriteria?: SuccessCriterionObject[];
  successActions?: ActionObject[];
  failureActions?: ActionObject[];
  outputs?: Record<string, string>;
}

// ─── Parameters ───

export interface ParameterObject {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie' | 'body';
  value: unknown;
}

// ─── Request Body ───

export interface RequestBodyObject {
  contentType?: string;
  payload: Record<string, unknown>;
  replacements?: PayloadReplacement[];
}

export interface PayloadReplacement {
  target: string;
  value: unknown;
}

// ─── Success Criteria ───

export interface SuccessCriterionObject {
  condition: string;
  context?: string;
  type?: 'simple' | 'regex' | 'jsonpath' | 'xpath';
}

// ─── Actions ───

export interface ActionObject {
  name: string;
  type: 'goto' | 'end';
  workflowId?: string;
  stepId?: string;
  criteria?: CriterionObject[];
}

export interface CriterionObject {
  condition: string;
  context?: string;
  type?: 'simple' | 'regex' | 'jsonpath' | 'xpath';
}

// ─── Components ───

export interface ComponentsObject {
  inputs?: Record<string, JsonSchemaObject>;
  parameters?: Record<string, ParameterObject>;
  successActions?: Record<string, ActionObject>;
  failureActions?: Record<string, ActionObject>;
}

// ─── JSON Schema (subset) ───

export interface JsonSchemaObject {
  type: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array';
  required?: string[];
  properties?: Record<string, JsonSchemaProperty>;
  description?: string;
}

export interface JsonSchemaProperty {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  format?: string;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
}

// ─── Parsed Result (enriched AST) ───

export interface ParsedWorkflow {
  document: ArazzoDocument;
  filePath: string;
  /** Resolved source descriptions with absolute paths */
  resolvedSources: ResolvedSource[];
}

export interface ResolvedSource {
  name: string;
  absolutePath: string;
  type: 'openapi' | 'arazzo';
}

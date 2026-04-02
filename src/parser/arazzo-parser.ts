/**
 * Arazzo YAML Parser
 *
 * Parses Arazzo 1.0.1 YAML workflow files into a typed AST.
 * Validates required fields and resolves source description paths.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  ArazzoDocument,
  ParsedWorkflow,
  ResolvedSource,
  WorkflowObject,
  StepObject,
} from './types.js';

export class ArazzoParserError extends Error {
  constructor(
    message: string,
    public filePath: string,
    public context?: string,
  ) {
    super(`[ArazzoParser] ${filePath}: ${message}${context ? ` (${context})` : ''}`);
    this.name = 'ArazzoParserError';
  }
}

/**
 * Parse a single Arazzo YAML file into a typed AST.
 */
export function parseArazzoFile(filePath: string): ParsedWorkflow {
  const absolutePath = resolve(filePath);
  const content = readFileSync(absolutePath, 'utf-8');
  const doc = parseYaml(content) as ArazzoDocument;

  validateDocument(doc, absolutePath);

  const resolvedSources = resolveSourceDescriptions(doc, absolutePath);

  return {
    document: doc,
    filePath: absolutePath,
    resolvedSources,
  };
}

/**
 * Parse multiple Arazzo YAML files.
 */
export function parseArazzoFiles(filePaths: string[]): ParsedWorkflow[] {
  return filePaths.map((fp) => parseArazzoFile(fp));
}

/**
 * Parse Arazzo YAML content from a string (useful for testing).
 */
export function parseArazzoContent(
  content: string,
  virtualPath: string = '<inline>',
): ParsedWorkflow {
  const doc = parseYaml(content) as ArazzoDocument;
  validateDocument(doc, virtualPath);

  return {
    document: doc,
    filePath: virtualPath,
    resolvedSources: [],
  };
}

// ─── Validation ───

function validateDocument(doc: ArazzoDocument, filePath: string): void {
  if (!doc.arazzo) {
    throw new ArazzoParserError('Missing required field "arazzo"', filePath);
  }

  if (!doc.arazzo.startsWith('1.')) {
    throw new ArazzoParserError(
      `Unsupported Arazzo version "${doc.arazzo}". Only 1.x is supported.`,
      filePath,
    );
  }

  if (!doc.info?.title) {
    throw new ArazzoParserError('Missing required field "info.title"', filePath);
  }

  if (!doc.sourceDescriptions || doc.sourceDescriptions.length === 0) {
    throw new ArazzoParserError(
      'At least one sourceDescription is required',
      filePath,
    );
  }

  if (!doc.workflows || doc.workflows.length === 0) {
    throw new ArazzoParserError(
      'At least one workflow is required',
      filePath,
    );
  }

  // Validate each workflow
  for (const workflow of doc.workflows) {
    validateWorkflow(workflow, filePath);
  }
}

function validateWorkflow(workflow: WorkflowObject, filePath: string): void {
  if (!workflow.workflowId) {
    throw new ArazzoParserError(
      'Workflow missing required "workflowId"',
      filePath,
    );
  }

  if (!workflow.steps || workflow.steps.length === 0) {
    throw new ArazzoParserError(
      'Workflow must have at least one step',
      filePath,
      `workflowId: ${workflow.workflowId}`,
    );
  }

  const stepIds = new Set<string>();
  for (const step of workflow.steps) {
    validateStep(step, workflow.workflowId, filePath);
    if (stepIds.has(step.stepId)) {
      throw new ArazzoParserError(
        `Duplicate stepId "${step.stepId}"`,
        filePath,
        `workflowId: ${workflow.workflowId}`,
      );
    }
    stepIds.add(step.stepId);
  }
}

function validateStep(step: StepObject, workflowId: string, filePath: string): void {
  if (!step.stepId) {
    throw new ArazzoParserError(
      'Step missing required "stepId"',
      filePath,
      `workflowId: ${workflowId}`,
    );
  }

  // A step must have exactly one of: operationId, operationPath, or workflowId
  const refs = [step.operationId, step.operationPath, step.workflowId].filter(Boolean);
  if (refs.length === 0) {
    throw new ArazzoParserError(
      `Step "${step.stepId}" must specify operationId, operationPath, or workflowId`,
      filePath,
      `workflowId: ${workflowId}`,
    );
  }
  if (refs.length > 1) {
    throw new ArazzoParserError(
      `Step "${step.stepId}" must specify only one of operationId, operationPath, or workflowId`,
      filePath,
      `workflowId: ${workflowId}`,
    );
  }
}

// ─── Source Resolution ───

function resolveSourceDescriptions(
  doc: ArazzoDocument,
  filePath: string,
): ResolvedSource[] {
  const dir = dirname(filePath);

  return doc.sourceDescriptions.map((sd) => {
    // If it's a relative path, resolve against the arazzo file's directory
    const absolutePath = sd.url.startsWith('http')
      ? sd.url
      : resolve(dir, sd.url);

    return {
      name: sd.name,
      absolutePath,
      type: sd.type,
    };
  });
}

// ─── Utility Extractors ───

/**
 * Extract all unique operationIds referenced across all workflows in a document.
 */
export function extractOperationIds(doc: ArazzoDocument): string[] {
  const ids = new Set<string>();
  for (const workflow of doc.workflows) {
    for (const step of workflow.steps) {
      if (step.operationId) {
        ids.add(step.operationId);
      }
    }
  }
  return Array.from(ids);
}

/**
 * Extract all runtime expressions used in a workflow's outputs and step outputs.
 */
export function extractExpressions(workflow: WorkflowObject): string[] {
  const exprs: string[] = [];

  // Workflow-level outputs
  if (workflow.outputs) {
    exprs.push(...Object.values(workflow.outputs));
  }

  // Step-level outputs
  for (const step of workflow.steps) {
    if (step.outputs) {
      exprs.push(...Object.values(step.outputs));
    }
  }

  return exprs;
}

/**
 * Get the source name and operation name from a qualified operationId.
 * e.g., "resourceServer.create-incoming-payment" → ["resourceServer", "create-incoming-payment"]
 */
export function splitOperationId(operationId: string): [string, string] {
  const dotIndex = operationId.indexOf('.');
  if (dotIndex === -1) {
    return ['', operationId];
  }
  return [operationId.substring(0, dotIndex), operationId.substring(dotIndex + 1)];
}

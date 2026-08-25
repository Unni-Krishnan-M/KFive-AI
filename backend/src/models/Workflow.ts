import { Schema, model } from 'mongoose';

export const WORKFLOW_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_TEMPLATE_TOKEN = '{{input}}';
export const WORKFLOW_DEFINITION_LIMITS = Object.freeze({
  templateBytes: 16 * 1024,
  systemPromptBytes: 16 * 1024,
  modelBytes: 200,
});

export type WorkflowNodeType = 'input' | 'prompt' | 'llm' | 'output';

export interface WorkflowPosition { x: number; y: number }
export interface WorkflowInputNode {
  id: 'input'; type: 'input'; label: 'Input'; position: WorkflowPosition; config: Record<string, never>;
}
export interface WorkflowPromptNode {
  id: 'prompt'; type: 'prompt'; label: 'Prompt'; position: WorkflowPosition;
  config: { template: string; systemPrompt: string };
}
export interface WorkflowLlmNode {
  id: 'llm'; type: 'llm'; label: 'LLM'; position: WorkflowPosition;
  config: { model: string; temperature: number };
}
export interface WorkflowOutputNode {
  id: 'output'; type: 'output'; label: 'Output'; position: WorkflowPosition; config: Record<string, never>;
}
export type WorkflowNode = WorkflowInputNode | WorkflowPromptNode | WorkflowLlmNode | WorkflowOutputNode;
export interface WorkflowEdge { id: string; source: string; target: string }
export interface WorkflowDefinition { nodes: WorkflowNode[]; edges: WorkflowEdge[] }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasUnsafeText(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point === 0xfffd || /\p{Cf}/u.test(character)
      || (point < 32 && point !== 9 && point !== 10) || (point >= 127 && point <= 159);
  });
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function safeBoundedString(value: unknown, minimum: number, maximumBytes: number): value is string {
  return typeof value === 'string'
    && value.length >= minimum
    && Buffer.byteLength(value, 'utf8') <= maximumBytes
    && !hasUnsafeText(value);
}

export function isExactWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  const convertible = value as { toObject?: () => unknown } | null;
  const candidate = convertible && typeof convertible.toObject === 'function' ? convertible.toObject() : value;
  if (!isPlainObject(candidate) || !hasExactKeys(candidate, ['nodes', 'edges'])) return false;
  if (!Array.isArray(candidate.nodes) || candidate.nodes.length !== 4 || !Array.isArray(candidate.edges) || candidate.edges.length !== 3) return false;

  const expectedNodes = [
    { id: 'input', type: 'input', label: 'Input', x: 0 },
    { id: 'prompt', type: 'prompt', label: 'Prompt', x: 320 },
    { id: 'llm', type: 'llm', label: 'LLM', x: 640 },
    { id: 'output', type: 'output', label: 'Output', x: 960 },
  ] as const;

  for (let index = 0; index < expectedNodes.length; index += 1) {
    const node = candidate.nodes[index];
    const expected = expectedNodes[index];
    if (!isPlainObject(node) || !hasExactKeys(node, ['id', 'type', 'label', 'position', 'config'])) return false;
    if (node.id !== expected.id || node.type !== expected.type || node.label !== expected.label) return false;
    if (!isPlainObject(node.position) || !hasExactKeys(node.position, ['x', 'y'])
      || node.position.x !== expected.x || node.position.y !== 0) return false;
    if (!isPlainObject(node.config)) return false;
    if (expected.type === 'input' || expected.type === 'output') {
      if (!hasExactKeys(node.config, [])) return false;
    } else if (expected.type === 'prompt') {
      if (!hasExactKeys(node.config, ['template', 'systemPrompt'])
        || !safeBoundedString(node.config.template, 1, WORKFLOW_DEFINITION_LIMITS.templateBytes)
        || node.config.template.split(WORKFLOW_TEMPLATE_TOKEN).length !== 2
        || !safeBoundedString(node.config.systemPrompt, 1, WORKFLOW_DEFINITION_LIMITS.systemPromptBytes)) return false;
    } else if (!hasExactKeys(node.config, ['model', 'temperature'])
      || !safeBoundedString(node.config.model, 1, WORKFLOW_DEFINITION_LIMITS.modelBytes)
      || typeof node.config.temperature !== 'number' || !Number.isFinite(node.config.temperature)
      || node.config.temperature < 0 || node.config.temperature > 2) return false;
  }

  const expectedEdges = [
    { id: 'input-to-prompt', source: 'input', target: 'prompt' },
    { id: 'prompt-to-llm', source: 'prompt', target: 'llm' },
    { id: 'llm-to-output', source: 'llm', target: 'output' },
  ];
  return candidate.edges.every((edge, index) => isPlainObject(edge)
    && hasExactKeys(edge, ['id', 'source', 'target'])
    && edge.id === expectedEdges[index].id
    && edge.source === expectedEdges[index].source
    && edge.target === expectedEdges[index].target);
}

const positionSchema = new Schema({
  x: { type: Number, required: true },
  y: { type: Number, required: true },
}, { _id: false });

const configSchema = new Schema({
  template: { type: String, maxlength: WORKFLOW_DEFINITION_LIMITS.templateBytes },
  systemPrompt: { type: String, maxlength: WORKFLOW_DEFINITION_LIMITS.systemPromptBytes },
  model: { type: String, maxlength: WORKFLOW_DEFINITION_LIMITS.modelBytes },
  temperature: { type: Number, min: 0, max: 2 },
}, { _id: false, strict: 'throw' });

const nodeSchema = new Schema({
  id: { type: String, required: true, enum: ['input', 'prompt', 'llm', 'output'] },
  type: { type: String, required: true, enum: ['input', 'prompt', 'llm', 'output'] },
  label: { type: String, required: true, enum: ['Input', 'Prompt', 'LLM', 'Output'] },
  position: { type: positionSchema, required: true },
  config: { type: configSchema, required: true },
}, { _id: false, strict: 'throw' });

const edgeSchema = new Schema({
  id: { type: String, required: true, enum: ['input-to-prompt', 'prompt-to-llm', 'llm-to-output'] },
  source: { type: String, required: true, enum: ['input', 'prompt', 'llm'] },
  target: { type: String, required: true, enum: ['prompt', 'llm', 'output'] },
}, { _id: false, strict: 'throw' });

export const workflowDefinitionSchema = new Schema({
  nodes: { type: [nodeSchema], required: true },
  edges: { type: [edgeSchema], required: true },
}, { _id: false, strict: 'throw' });

const workflowSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', immutable: true, index: true },
  name: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
  description: { type: String, default: '', maxlength: 2000 },
  schemaVersion: { type: Number, required: true, immutable: true, enum: [WORKFLOW_SCHEMA_VERSION], default: WORKFLOW_SCHEMA_VERSION },
  revision: { type: Number, required: true, min: 1, max: 1_000_000, default: 1 },
  definition: {
    type: workflowDefinitionSchema,
    required: true,
    validate: { validator: isExactWorkflowDefinition, message: 'Workflow definition must be the exact supported linear graph.' },
  },
}, { timestamps: true, strict: 'throw' });

workflowSchema.index({ ownerId: 1, updatedAt: -1 });
workflowSchema.index({ ownerId: 1, projectId: 1, updatedAt: -1 });
workflowSchema.pre('validate', function validateExactDefinition() {
  if (!isExactWorkflowDefinition(this.definition)) {
    this.invalidate('definition', 'Workflow definition must be the exact supported linear graph.');
  }
});

export const WorkflowModel = model('Workflow', workflowSchema);

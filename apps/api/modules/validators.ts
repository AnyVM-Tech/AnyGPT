import Ajv, { ErrorObject } from 'ajv';

export interface AdminProviderPayload {
  providerId: string;
  providerBaseUrl: string;
  apiKey?: string | null;
}

export interface AdminGenerateKeyPayload {
  userId: string;
  tier?: string;
  role?: 'admin' | 'user';
}

export interface AdminKeyIngestPayload {
  key: string;
  provider: string;
  tier?: number | null;
}

export interface AdminApiKeySelector {
  userId?: string;
  apiKey?: string;
}

export interface AdminApiKeyUpdatePayload extends AdminApiKeySelector {
  role?: 'admin' | 'user';
  tier?: string;
}

export interface AdminApiKeyRotatePayload extends AdminApiKeySelector {
  role?: 'admin' | 'user';
  tier?: string;
}

const ajv = new Ajv({
  allErrors: true,
  allowUnionTypes: true,
});

export const validateAdminProviderPayload = ajv.compile<AdminProviderPayload>({
  type: 'object',
  additionalProperties: false,
  required: ['providerId', 'providerBaseUrl'],
  properties: {
    providerId: { type: 'string', minLength: 1 },
    providerBaseUrl: { type: 'string', minLength: 1 },
    apiKey: {
      anyOf: [
        { type: 'string' },
        { type: 'null' },
      ],
    },
  },
});

export const validateAdminGenerateKeyPayload = ajv.compile<AdminGenerateKeyPayload>({
  type: 'object',
  additionalProperties: false,
  required: ['userId'],
  properties: {
    userId: { type: 'string', minLength: 1 },
    tier: { type: 'string', minLength: 1 },
    role: { type: 'string', enum: ['admin', 'user'] },
  },
});

export const validateAdminKeyIngestPayload = ajv.compile<AdminKeyIngestPayload>({
  type: 'object',
  additionalProperties: false,
  required: ['key', 'provider'],
  properties: {
    key: { type: 'string', minLength: 8, maxLength: 512 },
    provider: { type: 'string', minLength: 2, maxLength: 32, pattern: '^[a-z0-9][a-z0-9_-]{1,31}$' },
    tier: {
      anyOf: [
        { type: 'integer', minimum: 0, maximum: 100 },
        { type: 'null' }
      ]
    },
  },
});

const adminApiKeySelectorSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    userId: { type: 'string', minLength: 1 },
    apiKey: { type: 'string', minLength: 8 },
  },
  anyOf: [
    { required: ['userId'] },
    { required: ['apiKey'] },
  ],
};

export const validateAdminApiKeySelector = ajv.compile<AdminApiKeySelector>(adminApiKeySelectorSchema);

export const validateAdminApiKeyUpdatePayload = ajv.compile<AdminApiKeyUpdatePayload>({
  type: 'object',
  additionalProperties: false,
  properties: {
    userId: { type: 'string', minLength: 1 },
    apiKey: { type: 'string', minLength: 8 },
    role: { type: 'string', enum: ['admin', 'user'] },
    tier: { type: 'string', minLength: 1 },
  },
  allOf: [
    { anyOf: [{ required: ['userId'] }, { required: ['apiKey'] }] },
    { anyOf: [{ required: ['role'] }, { required: ['tier'] }] },
  ],
});

export const validateAdminApiKeyRotatePayload = ajv.compile<AdminApiKeyRotatePayload>({
  type: 'object',
  additionalProperties: false,
  properties: {
    userId: { type: 'string', minLength: 1 },
    apiKey: { type: 'string', minLength: 8 },
    role: { type: 'string', enum: ['admin', 'user'] },
    tier: { type: 'string', minLength: 1 },
  },
  anyOf: [
    { required: ['userId'] },
    { required: ['apiKey'] },
  ],
});

export function formatAjvErrors(errors?: ErrorObject[] | null): string[] {
  if (!errors || errors.length === 0) return [];
  return errors.map((err) => {
    const path = err.instancePath || '/';
    const message = err.message || 'Invalid value';
    return `${path} ${message}`.trim();
  });
}

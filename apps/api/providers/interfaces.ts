// Interface for the structure of data in models.json
export type ModelCapability = 'text' | 'image_input' | 'image_output' | 'audio_input' | 'audio_output';

export interface ModelDefinition {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  providers?: number;
  throughput?: number; // Represents tokens per second from the static file
  capabilities?: ModelCapability[]; // Supported modalities for the model
}

// Removed TokenSpeedEntry interface

// Interface for runtime Model state within a Provider object
export interface Model {
  id: string;
  token_generation_speed: number; // Default or last known average speed
  response_times: ResponseEntry[]; // Array stores response data including observed speed
  errors: number;
  consecutive_errors: number; // Number of consecutive errors (made required)
  avg_response_time: number | null;
  avg_provider_latency: number | null;
  avg_token_speed: number | null; // Calculated average token speed (tokens/sec, e.g., EMA)
}

export interface ResponseEntry {
  timestamp: number;           // Epoch milliseconds
  response_time: number;       // Total time for the API call (ms)
  input_tokens: number;
  output_tokens: number;
  tokens_generated: number;
  provider_latency: number | null; // Calculated latency attributable to the provider (ms)
  observed_speed_tps?: number | null; // Observed speed (tokens/sec) for this specific request
  apiKey?: string | null; // User's API key making the request
}

export interface Provider {
  id: string;
  apiKey: string | null;
  provider_url: string;
  streamingCompatible?: boolean;
  models: { [modelId: string]: Model }; // Map of model IDs to their runtime state
  avg_response_time: number | null;
  avg_provider_latency: number | null;
  errors: number;
  provider_score: number | null; // Kept at provider level
  disabled: boolean; // Flag if provider is auto-disabled (made required)
}

export interface IAIProvider {
  sendMessage(message: IMessage): Promise<{ response: string; latency: number }>;
  sendMessageStream?(message: IMessage): AsyncGenerator<{ chunk: string; latency: number; response: string; anystream: any; }, void, unknown>;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } };

export interface IMessage {
  content: string | ContentPart[];
  model: {
    id: string;
  };
}

// --- Potentially for user management/API key tracking --- //
export interface UserData {
  userId: string;
  tokenUsage: number;
  role: 'admin' | 'user';
}

export interface KeysFile {
  [apiKey: string]: UserData;
}

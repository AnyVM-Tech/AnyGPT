
export interface IAIProvider {
  sendMessage(message: IMessage): Promise<{ response: string; latency: number }>;
  isBusy(): boolean;
  getLatency(): number;
}

export interface Model {
  model_id: string;
  token_generation_speed: number; // Tokens per second
  response_times: ResponseEntry[]; // List of response times
  errors: number; // Total number of errors
  avg_response_time?: number;
  avg_provider_latency?: number;
}

export interface Provider {
  id: string;
  apiKey: string | null;
  provider_url: string;
  models: { [modelId: string]: Model }; 
  avg_response_time?: number; // Average response time across all models
  avg_provider_latency?: number; // Average provider latency across all models
  errors?: number; // Total number of errors across all models
  provider_score?: number; // Overall score calculated for the provider
}

export interface IMessage {
  content: string;
  model: {
    id: string;
    [key: string]: any;
  };
  [key: string]: any;
}

export interface ResponseEntry {
  timestamp: Date;
  response_time: number; // in milliseconds
  input_tokens: number;
  output_tokens: number;
  tokens_generated: number; // Total tokens generated (input_tokens + output_tokens)
  provider_latency: number; // New field: latency per token
}
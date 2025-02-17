export interface IAIProvider {
  sendMessage(message: IMessage): Promise<{ response: string; latency: number }>;
  isBusy(): boolean;
  getLatency(): number;
}



export interface Model {
  id: string;
  token_generation_speed: number;
  errors: number;
  provider_score: number | null;
  response_time: number | null;
  [key: string]: any;
}

export interface Provider {
  id: string;
  apiKey: string | null;
  provider_url: string;
  models: { [modelId: string]: Model };
  avg_response_time: number | null;
  avg_provider_latency: number | null;
  errors: number;
  provider_score: number | null;
}

export type DevModels = Provider[];

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
  tokens_generated: number; // input_tokens + output_tokens
  provider_latency: number; // latency per token
}

export interface UserData {
  userId: string;
  tokenUsage: number;
  role: 'admin' | 'user';
}

export interface KeysFile {
  [apiKey: string]: UserData;
}
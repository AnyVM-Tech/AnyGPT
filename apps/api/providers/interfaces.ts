export interface IAIProvider {
  sendMessage(message: IMessage): Promise<{ response: string; latency: number }>;
  isBusy(): boolean;
  getLatency(): number;
}
// models.json models list
export interface Model {
  model_id: string;
  response_time: number | null;
}

// devmodels.json
export interface Provider {
  id: string;
  apiKey: string | null;
  provider_url: string;
  models: Model[];  
}
export interface IMessage {
  content: string;
  model: {
    id: string;
    [key: string]: any;
  };
  [key: string]: any;
}
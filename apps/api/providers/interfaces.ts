export interface IAIProvider {
    sendMessage(message: IMessage): Promise<{ response: string; latency: number }>;
    isBusy(): boolean;
    getLatency(): number;
  }
  
  export interface IMessage {
    content: string;
    model: {
      id: string;
      [key: string]: any;
    };
    [key: string]: any;
  }
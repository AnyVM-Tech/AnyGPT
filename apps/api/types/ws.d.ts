declare module 'ws' {
  import { EventEmitter } from 'events';
  
  export default class WebSocket extends EventEmitter {
    constructor(address: string, options?: any);
    send(data: string | Buffer): void;
    close(): void;
    on(event: 'open', listener: () => void): this;
    on(event: 'close', listener: () => void): this;
    on(event: 'message', listener: (data: Buffer | string) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
  }
}
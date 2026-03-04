declare module 'ws' {
  import { EventEmitter } from 'events';

  export type RawData = string | Buffer | ArrayBuffer | Uint8Array;

  export default class WebSocket extends EventEmitter {
    constructor(address: string, options?: any);
    readonly readyState: number;
    send(data: RawData): void;
    close(code?: number, reason?: string): void;
    on(event: 'open', listener: () => void): this;
    on(event: 'close', listener: (code?: number, reason?: Buffer) => void): this;
    on(event: 'message', listener: (data: RawData, isBinary?: boolean) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
  }
}

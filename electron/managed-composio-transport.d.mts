export function createBrokerClientTransport(port: {
  on(event: 'message', listener: (event: { data?: object }) => void): void;
  postMessage(message: object): void;
}): { fetch(path: string, init?: RequestInit): Promise<Response>; close(): void };

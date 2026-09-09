import { Server } from 'node:http';

export async function closeHttpServerIfListening(server: Pick<Server, 'listening' | 'close'>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

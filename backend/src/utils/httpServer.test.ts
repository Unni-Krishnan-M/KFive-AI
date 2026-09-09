import { closeHttpServerIfListening } from './httpServer';

describe('closeHttpServerIfListening', () => {
  it('does not close an HTTP server already closed by Socket.IO', async () => {
    const server = { listening: false, close: jest.fn() };
    await expect(closeHttpServerIfListening(server as never)).resolves.toBeUndefined();
    expect(server.close).not.toHaveBeenCalled();
  });

  it('closes a listening HTTP server and propagates close failures', async () => {
    const close = jest.fn((callback: (error?: Error) => void) => callback());
    await expect(closeHttpServerIfListening({ listening: true, close } as never)).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);

    const failure = new Error('close failed');
    await expect(closeHttpServerIfListening({ listening: true,
      close: (callback: (error?: Error) => void) => callback(failure) } as never)).rejects.toThrow('close failed');
  });
});

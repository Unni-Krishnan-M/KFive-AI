import { Types } from 'mongoose';
import { Conversation } from './Conversation';

function base() {
  return {
    userId: new Types.ObjectId(),
    title: 'Test conversation',
    messages: [],
    metadata: { totalTokens: 0, messageCount: 0, lastMessageAt: new Date() },
  };
}

describe('Conversation model safety invariants', () => {
  it('does not claim a hardcoded provider or model by default', () => {
    const conversation = new Conversation(base());
    expect(conversation.settings?.provider).toBeUndefined();
    expect(conversation.settings?.model).toBeUndefined();
  });

  it('accepts an empty assistant only for a durable non-success terminal state', async () => {
    const failed = new Conversation({
      ...base(),
      messages: [{
        role: 'assistant', content: '', status: 'failed', requestId: 'request-1234',
        error: { code: 'CHAT_GENERATION_FAILED', message: 'The AI response could not be generated.' },
      }],
    });
    await expect(failed.validate()).resolves.toBeUndefined();

    const user = new Conversation({ ...base(), messages: [{ role: 'user', content: '' }] });
    await expect(user.validate()).rejects.toMatchObject({ name: 'ValidationError' });

    const succeeded = new Conversation({
      ...base(), messages: [{ role: 'assistant', content: '', status: 'succeeded', requestId: 'request-1234' }],
    });
    await expect(succeeded.validate()).rejects.toMatchObject({ name: 'ValidationError' });
  });

  it('requires a deadline for running generation leases', async () => {
    const withoutDeadline = new Conversation({
      ...base(),
      generation: {
        requestId: 'request-1234', status: 'running', userMessageId: new Types.ObjectId(),
        outputBytes: 0, startedAt: new Date(),
      },
    });
    await expect(withoutDeadline.validate()).rejects.toMatchObject({ name: 'ValidationError' });

    const withDeadline = new Conversation({
      ...base(),
      generation: {
        requestId: 'request-1234', status: 'running', userMessageId: new Types.ObjectId(),
        outputBytes: 0, startedAt: new Date(), deadlineAt: new Date(Date.now() + 120_000),
      },
    });
    await expect(withDeadline.validate()).resolves.toBeUndefined();
  });

  it('rejects unsupported public error codes and more than 64 stored messages', async () => {
    const unsafeError = new Conversation({
      ...base(),
      messages: [{
        role: 'assistant', content: '', status: 'failed', requestId: 'request-1234',
        error: { code: 'RAW_PROVIDER_SECRET', message: 'unsafe' },
      }],
    });
    await expect(unsafeError.validate()).rejects.toMatchObject({ name: 'ValidationError' });

    const tooMany = new Conversation({
      ...base(),
      messages: Array.from({ length: 65 }, (_, index) => ({ role: 'user', content: `message ${index}` })),
    });
    await expect(tooMany.validate()).rejects.toMatchObject({ name: 'ValidationError' });
  });
});

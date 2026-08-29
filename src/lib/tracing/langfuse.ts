import { CallbackHandler } from 'langfuse-langchain';

export function getLangfuseCallbackHandler(options?: {
  userId?: string;
  sessionId?: string;
  tags?: string[];
  metadata?: Record<string, any>;
}) {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl =
    process.env.LANGFUSE_BASE_URL ||
    process.env.LANGFUSE_HOST ||
    'https://cloud.langfuse.com';

  if (!publicKey || !secretKey) {
    return null;
  }

  try {
    return new CallbackHandler({
      publicKey,
      secretKey,
      baseUrl,
      userId: options?.userId,
      sessionId: options?.sessionId,
      tags: options?.tags || ['cadai', 'langgraph', 'gemini'],
      metadata: options?.metadata,
    });
  } catch (err) {
    console.warn('Langfuse CallbackHandler initialization warning:', err);
    return null;
  }
}

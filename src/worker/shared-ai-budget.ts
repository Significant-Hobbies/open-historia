import type { WorkerEnv } from '../../lib/worker-env';

const DAILY_CAP = 9_500;

export class SharedAiBudgetError extends Error {
  constructor() {
    super('Shared AI budget is unavailable or exhausted.');
    this.name = 'SharedAiBudgetError';
  }
}

function deny(): never {
  throw new SharedAiBudgetError();
}

const MODEL_RATES: Record<string, { input: number; output: number }> = {
  // Exact priced model ID from Cloudflare's current Workers AI pricing table.
  '@cf/meta/llama-3.1-8b-instruct-fp8': { input: 13_778, output: 26_128 },
};

export async function reserveWorkersAiCall(
  env: WorkerEnv,
  model: string,
  input: unknown,
  outputTokens: number,
): Promise<void> {
  const rates = MODEL_RATES[model];
  if (!rates || !Number.isSafeInteger(outputTokens) || outputTokens <= 0 || outputTokens > 8_192) return deny();
  const serializedBytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  const estimatedInputTokens = Math.ceil(serializedBytes * 1.2);
  const neurons = Math.ceil((estimatedInputTokens * rates.input + outputTokens * rates.output) / 1_000_000);
  if (!Number.isSafeInteger(neurons) || neurons <= 0 || neurons > DAILY_CAP) return deny();
  const namespace = env.NEURON_BUDGET;
  if (!namespace) return deny();

  let response: Response;
  try {
    const stub = namespace.get(namespace.idFromName('global-budget'));
    response = await stub.fetch('https://internal.local/try-debit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ neurons }),
    });
  } catch {
    return deny();
  }
  if (response.status !== 200) return deny();
  let result: Record<string, unknown>;
  try {
    result = await response.json() as Record<string, unknown>;
  } catch {
    return deny();
  }
  if (
    result.allowed !== true ||
    result.dayKey !== new Date().toISOString().slice(0, 10) ||
    result.retryAfter !== 0 ||
    !Number.isSafeInteger(result.used) || (result.used as number) < neurons ||
    !Number.isSafeInteger(result.remaining) || (result.remaining as number) < 0 ||
    (result.used as number) + (result.remaining as number) !== DAILY_CAP
  ) return deny();
}

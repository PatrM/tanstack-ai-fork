import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveDebugOption } from '@tanstack/ai/adapter-internals'
import { createOpenRouterText } from '../src/adapters/text'
import type { OpenRouterTextAdapter } from '../src/adapters/text'

// Drive the REAL @openrouter/sdk retry loop against a stubbed fetch, so the
// test proves a configured `retryCodes` actually changes SDK behaviour rather
// than only reaching a mocked `chat.send`.
const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const testLogger = resolveDebugOption(false)

// `maxInterval: 1` caps the SDK's backoff (which adds up to 1s of jitter) so
// the retry is near-instant.
const retryConfig = {
  strategy: 'backoff' as const,
  backoff: {
    initialInterval: 1,
    maxInterval: 1,
    exponent: 1,
    maxElapsedTime: 5000,
  },
  retryConnectionErrors: false,
}

function rateLimited(): Response {
  return new Response(
    JSON.stringify({ error: { code: 429, message: 'Rate limited' } }),
    { status: 429, headers: { 'content-type': 'application/json' } },
  )
}

function completion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: 'gen-1',
      object: 'chat.completion',
      created: 0,
      system_fingerprint: 'fp-test',
      model: 'openai/gpt-4o-mini',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

const structuredOutput = (
  adapter: OpenRouterTextAdapter<'openai/gpt-4o-mini'>,
) =>
  adapter.structuredOutput({
    chatOptions: {
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      logger: testLogger,
    },
    outputSchema: { type: 'object' },
  })

describe('OpenRouter text adapter retryCodes', () => {
  it('retries a 429 when retryCodes includes it', async () => {
    fetchMock
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(completion('{"ok":true}'))
    const adapter = createOpenRouterText('openai/gpt-4o-mini', 'sk-or-test', {
      retryConfig,
      retryCodes: ['429', '5XX'],
    })

    const result = await structuredOutput(adapter)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.data).toEqual({ ok: true })
  })

  it('does not retry a 429 by default', async () => {
    fetchMock
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(completion('{"ok":true}'))
    const adapter = createOpenRouterText('openai/gpt-4o-mini', 'sk-or-test', {
      retryConfig,
    })

    await expect(structuredOutput(adapter)).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// OpenRouter sends status 200 when the provider accepts the request. A
// provider error after that arrives as an error chunk in the stream.
const rateLimitedChunk = () =>
  new Response(
    `data: ${JSON.stringify({
      id: 'gen-1',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'openai/gpt-4o-mini',
      error: { code: 429, message: 'Rate limited upstream' },
      choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
    })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )

async function runError(retryCodes?: Array<string>) {
  fetchMock.mockResolvedValueOnce(rateLimitedChunk())
  const adapter = createOpenRouterText('openai/gpt-4o-mini', 'sk-or-test', {
    retryConfig,
    ...(retryCodes && { retryCodes }),
  })
  for await (const event of adapter.chatStream({
    model: 'openai/gpt-4o-mini',
    messages: [{ role: 'user', content: 'Hello' }],
    logger: testLogger,
  })) {
    if (event.type === 'RUN_ERROR') return event
  }
  throw new Error('no RUN_ERROR')
}

describe('OpenRouter text adapter retryAfterMs', () => {
  it('waits the backoff interval after an error chunk with a retried code', async () => {
    const event = await runError(['429', '5XX'])
    expect(event).toMatchObject({ code: '429', retryAfterMs: 1 })
  })

  it('sets no wait for an error chunk the SDK would not retry', async () => {
    const event = await runError()
    expect(event.code).toBe('429')
    expect(event.retryAfterMs).toBeUndefined()
  })
})

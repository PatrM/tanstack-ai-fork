import { createFileRoute } from '@tanstack/react-router'
import { chat } from '@tanstack/ai'
import { createAnthropicChat } from '@tanstack/ai-anthropic'
import {
  createOpenaiChat,
  createOpenaiChatCompletions,
} from '@tanstack/ai-openai'
import { createOpenRouterText } from '@tanstack/ai-openrouter'
import { HTTPClient } from '@openrouter/sdk'

const LLMOCK_DEFAULT_BASE = process.env.LLMOCK_URL || 'http://127.0.0.1:4010'
const DUMMY_KEY = 'sk-e2e-test-dummy-key'
// The SDKs must not retry the 429 themselves.
const config = { maxRetries: 0 }

const adapters = {
  anthropic: () =>
    createAnthropicChat('claude-haiku-4-5', DUMMY_KEY, {
      ...config,
      baseURL: LLMOCK_DEFAULT_BASE,
    }),
  'openai-responses': () =>
    createOpenaiChat('gpt-4o', DUMMY_KEY, {
      ...config,
      baseURL: `${LLMOCK_DEFAULT_BASE}/v1`,
    }),
  'openai-chat-completions': () =>
    createOpenaiChatCompletions('gpt-4o', DUMMY_KEY, {
      ...config,
      baseURL: `${LLMOCK_DEFAULT_BASE}/v1`,
    }),
}

/**
 * `chat({ retry })` against `[chat-retry]`: aimock answers the first call with
 * a 429 and `Retry-After: 1`, and the second call with text. `testId` gives the
 * test its own aimock `sequenceIndex` count.
 */
async function retryThenAnswer(testId: string | undefined) {
  const adapter = createOpenaiChatCompletions('gpt-4o', DUMMY_KEY, {
    ...config,
    baseURL: `${LLMOCK_DEFAULT_BASE}/v1`,
    ...(testId ? { defaultHeaders: { 'X-Test-Id': testId } } : {}),
  })
  const types: Array<string> = []
  let text = ''
  for await (const chunk of chat({
    adapter,
    messages: [{ role: 'user', content: '[chat-retry] say hello' }],
    retry: { maxRetries: 1 },
  })) {
    types.push(chunk.type)
    if (chunk.type === 'TEXT_MESSAGE_CONTENT') text += chunk.delta
  }
  return Response.json({ types, text })
}

/**
 * `chat({ retry })` with OpenRouter. OpenRouter sends a provider 429 as an
 * error chunk in a status-200 stream, which aimock cannot send. So the fetcher
 * sends that chunk first, then text.
 */
async function openRouterStreamErrorThenAnswer() {
  const chunks = [
    { error: { code: 429, message: 'Rate limited' }, choices: [] },
    {
      choices: [
        {
          index: 0,
          delta: { content: 'hello after the wait' },
          finish_reason: 'stop',
        },
      ],
    },
  ]
  let calls = 0
  const httpClient = new HTTPClient({
    fetcher: async () =>
      new Response(
        `data: ${JSON.stringify({ id: 'gen-e2e', object: 'chat.completion.chunk', created: 0, model: 'openai/gpt-4o', ...chunks[calls++] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
  })
  const adapter = createOpenRouterText('openai/gpt-4o', DUMMY_KEY, {
    httpClient,
    retryCodes: ['429'],
  })
  const types: Array<string> = []
  let text = ''
  for await (const chunk of chat({
    adapter,
    messages: [{ role: 'user', content: 'say hello' }],
    retry: { maxRetries: 1 },
  })) {
    types.push(chunk.type)
    if (chunk.type === 'TEXT_MESSAGE_CONTENT') text += chunk.delta
  }
  return Response.json({ types, text, calls })
}

/**
 * Streams one chat against the aimock fixture in `fixtures/retry-after`. aimock
 * answers with a 429 and `Retry-After: 7`. Returns the `retryAfterMs` of the
 * `RUN_ERROR` that `chat()` yields. `?api=` picks the adapter.
 * `?mode=retry` runs `retryThenAnswer`. `?mode=openrouter-stream-error` runs
 * `openRouterStreamErrorThenAnswer`.
 */
export const Route = createFileRoute('/api/retry-after')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('mode') === 'retry') {
          return retryThenAnswer(url.searchParams.get('testId') ?? undefined)
        }
        if (url.searchParams.get('mode') === 'openrouter-stream-error') {
          return openRouterStreamErrorThenAnswer()
        }
        const api = url.searchParams.get('api')
        if (
          api !== 'anthropic' &&
          api !== 'openai-responses' &&
          api !== 'openai-chat-completions'
        ) {
          return Response.json({ ok: false, error: `Unknown api: ${api}` })
        }

        let runError: Record<string, unknown> | undefined
        try {
          for await (const chunk of chat({
            adapter: adapters[api](),
            messages: [{ role: 'user', content: '[retry-after] say hello' }],
          })) {
            if (chunk.type === 'RUN_ERROR') {
              runError = {
                message: chunk.message,
                retryAfterMs: chunk.metadata?.tanstack?.retryAfterMs,
              }
            }
          }
        } catch (error) {
          return Response.json({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }

        return Response.json({ ok: true, runError })
      },
    },
  },
})

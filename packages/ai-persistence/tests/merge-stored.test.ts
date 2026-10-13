import { describe, expect, it } from 'vitest'
import { mergeStoredMessages } from '../src/merge-stored'
import type { ModelMessage } from '@tanstack/ai'

const call = (id: string, toolCallId: string): ModelMessage => ({
  id,
  role: 'assistant',
  content: null,
  toolCalls: [
    {
      id: toolCallId,
      type: 'function',
      function: { name: 'ask', arguments: '{}' },
    },
  ],
})
const result = (id: string, toolCallId: string, content: string) =>
  ({ id, role: 'tool', toolCallId, content }) satisfies ModelMessage

describe('mergeStoredMessages', () => {
  // The old result comes back under a snapshot id or under its stored id.
  it.each(['snap_1', 'r1'])(
    'keeps the result of a later call that reuses a stored toolCallId (%s)',
    (replayedId) => {
      const user: ModelMessage = { id: 'u2', role: 'user', content: 'again' }
      const stored = [
        call('a1', 'call_x'),
        result('r1', 'call_x', 'first'),
        user,
      ]
      const incoming = [
        call('a1', 'call_x'),
        result(replayedId, 'call_x', 'first'),
        user,
        call('a2', 'call_x'),
        result('snap_2', 'call_x', 'second'),
      ]

      expect(
        mergeStoredMessages(stored, incoming).map((m) => m.content),
      ).toEqual([null, 'first', 'again', null, 'second'])
    },
  )
})

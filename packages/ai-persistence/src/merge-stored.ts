import type { ModelMessage } from '@tanstack/ai'

// Empty incoming keeps stored. Non-empty: the last incoming id that already
// exists in stored is a cutoff (reload drops the old assistant after that
// user). Same id is replaced in place, but a stored mid-conversation record
// stays when the incoming copy has none. A tool result whose toolCallId has a
// stored result is dropped, once per stored result. New ids and messages with
// no id are appended.
/** How many stored messages the merge keeps. Less than `stored.length` on a reload. */
export function storedCutoff(
  stored: ReadonlyArray<ModelMessage>,
  incoming: ReadonlyArray<ModelMessage>,
) {
  for (let index = incoming.length - 1; index >= 0; index--) {
    const id = incoming[index]?.id
    if (id === undefined) continue
    const storedIndex = stored.findIndex((message) => message.id === id)
    if (storedIndex >= 0) return storedIndex + 1
  }
  return stored.length
}

export function mergeStoredMessages(
  stored: ReadonlyArray<ModelMessage>,
  incoming: ReadonlyArray<ModelMessage>,
) {
  if (incoming.length === 0) {
    return stored.slice()
  }

  const prefix = stored.slice(0, storedCutoff(stored, incoming))

  const incomingById = new Map<string, ModelMessage>()
  for (const message of incoming) {
    const id = message.id
    if (id) incomingById.set(id, message)
  }

  // A resumed run posts stored tool results under the interrupt snapshot's
  // ids, which the store never saw. Match tool results by toolCallId, once per
  // stored result, so a later call that reuses the id still gets its result.
  const storedResults = new Map<string, number>()
  const storedIds = new Set<string>()
  const merged: Array<ModelMessage> = []
  for (const message of prefix) {
    if (message.role === 'tool' && message.toolCallId) {
      const key = message.toolCallId
      storedResults.set(key, (storedResults.get(key) ?? 0) + 1)
    }
    const id = message.id
    if (id) {
      storedIds.add(id)
      const replacement = incomingById.get(id)
      merged.push(
        replacement ? keepStoredRecord(replacement, message) : message,
      )
      continue
    }
    merged.push(message)
  }

  for (let index = 0; index < incoming.length; index++) {
    const message = incoming[index]
    if (!message) continue
    // Before the id check, so a replayed result under its stored id also
    // uses up its count.
    if (message.role === 'tool' && message.toolCallId) {
      const left = storedResults.get(message.toolCallId) ?? 0
      if (left > 0) {
        storedResults.set(message.toolCallId, left - 1)
        continue
      }
    }
    const id = message.id
    if (id && storedIds.has(id)) continue
    // Attach/reload can post the stored transcript again with no ids. Keep the
    // prefix row instead of appending a second copy of the same turn.
    if (!id) {
      const existing = merged[index]
      if (
        existing &&
        existing.id === undefined &&
        existing.role === message.role &&
        existing.content === message.content
      ) {
        continue
      }
    }
    merged.push(message)
  }

  return merged
}

// A client never sends the engine's mid-conversation record (UIMessages have
// none), so keep the stored one. Without it, each turn starts a new start
// point and the prompt cache breaks once per turn.
function keepStoredRecord(
  incoming: ModelMessage,
  stored: ModelMessage,
): ModelMessage {
  if (incoming.midConversationChange || !stored.midConversationChange) {
    return incoming
  }
  return { ...incoming, midConversationChange: stored.midConversationChange }
}

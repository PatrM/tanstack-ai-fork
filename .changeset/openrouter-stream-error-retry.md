---
'@tanstack/ai-openrouter': patch
---

`chat({ retry })` now retries an OpenRouter rate limit that arrives in the stream. OpenRouter sends status 200 when the provider accepts the request, so a later provider 429 or 5xx comes as an error chunk that the SDK cannot retry. When the SDK would retry that status (`retryCodes`, default `['5XX']`), the `RUN_ERROR` now has `retryAfterMs` set to the `initialInterval` of `retryConfig` (default 500).

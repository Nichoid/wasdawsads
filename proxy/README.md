# StructuredPrefill proxy

The same prefill-to-schema trick as the SillyTavern extension, as a small
OpenAI-compatible HTTP proxy. Point any Chat Completions client at it.

Requires Node.js 18 or newer. There are no dependencies to install.

## Run

```bash
cp proxy/config.example.json proxy/config.json   # optional, edit as needed
node proxy/server.mjs
```

The proxy listens on `http://127.0.0.1:8787/v1` by default and forwards to
`upstreamUrl`. Use it as the base URL in your client, for example as a
"Custom (OpenAI-compatible)" source.

The client's `Authorization` header is forwarded. Set `upstreamApiKey` (or the
`UPSTREAM_API_KEY` environment variable) to use a fixed key instead.

## What it does to `POST /v1/chat/completions`

1. If the last message has role `assistant`, it is removed and used as the prefill.
2. A `response_format: { type: "json_schema" }` is added whose `pattern` forces
   the reply to start with that prefill. All `[[...]]` stubs work, including
   `[[keep]]`, `[[end]]` and `[[pg]]`.
3. The JSON reply is unwrapped, streaming or not, so the client sees plain text.

Requests without a prefill and without banned words, and requests that already
set `response_format`, pass through unchanged. Every other path is proxied as is.

## Configuration

| Key | Meaning |
| --- | --- |
| `port`, `host` | Where the proxy listens. Also `PORT` and `HOST` env vars. |
| `upstreamUrl` | Upstream base URL including `/v1`. Also `UPSTREAM_URL`. |
| `upstreamApiKey` | Optional fixed upstream key. Also `UPSTREAM_API_KEY`. |
| `hidePrefill` | Hide the prefill (up to `[[keep]]`) from the returned text. |
| `minChars` | Minimum characters after the prefix. |
| `newlineToken` | Token the model may use for newlines in the prefill. |
| `bannedWords` | Array of banned words (anti-slop). |
| `names` | Names offered to `[[name]]`. |
| `pg.*` | Prefill generator for `[[pg]]`: any OpenAI-compatible `url`, `apiKey` (or `PG_API_KEY`), `model`, `maxTokens`, `stop`, `timeoutSec`, `systemPrompt`. |

Set `SP_CONFIG` to load a config file from another path.

Continue/overlap is a SillyTavern feature and is not handled by the proxy.

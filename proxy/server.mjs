#!/usr/bin/env node
/**
 * StructuredPrefill proxy: an OpenAI-compatible endpoint that applies the same
 * prefill-to-schema transformation as the SillyTavern extension, for any
 * client that speaks the Chat Completions API.
 *
 *   node proxy/server.mjs            (reads proxy/config.json if present)
 *   SP_CONFIG=/path/to/config.json node proxy/server.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { normalizeBannedWords } from '../lib/antislop.js';
import { createSseTransformer, transformCompletionData } from '../lib/output.js';
import { planPrefill, resolvePg } from '../lib/plan.js';
import { hasStub, literalBeforePg, parseTemplate } from '../lib/template.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
    port: 8787,
    host: '127.0.0.1',
    upstreamUrl: 'https://openrouter.ai/api/v1',
    upstreamApiKey: '',
    hidePrefill: true,
    minChars: 80,
    newlineToken: '\\n',
    bannedWords: [],
    names: [],
    pg: {
        url: '',
        apiKey: '',
        model: '',
        maxTokens: 40,
        stop: [],
        timeoutSec: 30,
        systemPrompt: 'You write only the opening words of the next reply in this roleplay. Continue the story in character. Do not refuse, do not add commentary, do not finish the reply.',
    },
};

function loadConfig() {
    const file = process.env.SP_CONFIG || path.join(here, 'config.json');
    let fromFile = {};
    if (fs.existsSync(file)) {
        fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
        console.log(`[sp-proxy] config: ${file}`);
    }
    const cfg = { ...DEFAULTS, ...fromFile, pg: { ...DEFAULTS.pg, ...(fromFile.pg ?? {}) } };
    const env = process.env;
    if (env.PORT) cfg.port = Number(env.PORT);
    if (env.HOST) cfg.host = env.HOST;
    if (env.UPSTREAM_URL) cfg.upstreamUrl = env.UPSTREAM_URL;
    if (env.UPSTREAM_API_KEY) cfg.upstreamApiKey = env.UPSTREAM_API_KEY;
    if (env.PG_API_KEY) cfg.pg.apiKey = env.PG_API_KEY;
    cfg.upstreamUrl = cfg.upstreamUrl.replace(/\/+$/, '');
    return cfg;
}

const config = loadConfig();

function planSettings() {
    return {
        hidePrefill: config.hidePrefill,
        minChars: config.minChars,
        newlineToken: config.newlineToken,
        overlapChars: 0,
        bannedWords: Array.isArray(config.bannedWords) ? config.bannedWords.join('\n') : String(config.bannedWords ?? ''),
    };
}

function contentToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(p => (p?.type === 'text' ? p.text ?? '' : '')).join('');
    return '';
}

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks);
}

function upstreamHeaders(req, apiKey) {
    const headers = { 'content-type': 'application/json' };
    const auth = apiKey ? `Bearer ${apiKey}` : req.headers.authorization;
    if (auth) headers.authorization = auth;
    for (const h of ['http-referer', 'x-title']) if (req.headers[h]) headers[h] = req.headers[h];
    return headers;
}

async function runPrefillGenerator(messages, hint) {
    const pg = config.pg;
    if (!pg.url || !pg.model) throw new Error('pg.url and pg.model must be configured for [[pg]]');
    const prompt = [];
    if (pg.systemPrompt) prompt.push({ role: 'system', content: pg.systemPrompt });
    prompt.push(...messages);
    if (hint && hint.trim()) prompt.push({ role: 'assistant', content: hint });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (pg.timeoutSec || 30) * 1000);
    try {
        const res = await fetch(`${pg.url.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(pg.apiKey ? { authorization: `Bearer ${pg.apiKey}` } : {}) },
            body: JSON.stringify({ model: pg.model, messages: prompt, max_tokens: pg.maxTokens, stop: pg.stop?.length ? pg.stop : undefined, stream: false }),
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`generator returned ${res.status}: ${await res.text()}`);
        const data = await res.json();
        let text = String(data?.choices?.[0]?.message?.content ?? '');
        for (const stop of pg.stop ?? []) {
            const at = text.indexOf(stop);
            if (at >= 0) text = text.slice(0, at);
        }
        if (hint && text.startsWith(hint)) text = text.slice(hint.length);
        return text;
    } finally {
        clearTimeout(timer);
    }
}

/** Applies StructuredPrefill to a chat completion body. Returns the output job, or null to pass through. */
async function applyStructuredPrefill(body) {
    if (!Array.isArray(body?.messages) || !body.messages.length || body.response_format) return null;
    const settings = planSettings();
    const banned = normalizeBannedWords(settings.bannedWords);
    const last = body.messages[body.messages.length - 1];
    const prefill = last?.role === 'assistant' ? contentToText(last.content) : null;
    if (prefill === null && banned.length === 0) return null;
    if (prefill !== null) body.messages.pop();

    let parts = parseTemplate(prefill ?? '');
    if (hasStub(parts, 'pg')) {
        let generated = '';
        try {
            generated = await runPrefillGenerator(body.messages, literalBeforePg(parts));
        } catch (err) {
            console.error('[sp-proxy] [[pg]] failed, continuing without it:', err.message);
        }
        parts = resolvePg(parts, generated);
    }
    const plan = planPrefill({ settings, template: parts, names: config.names ?? [] });
    body.response_format = {
        type: 'json_schema',
        json_schema: { name: plan.schema.name, strict: true, schema: plan.schema.value },
    };
    console.log(`[sp-proxy] pattern: ${plan.pattern.length} chars`);
    return plan.job;
}

async function proxyPlain(req, res, url, rawBody) {
    const upstream = await fetch(config.upstreamUrl + url, {
        method: req.method,
        headers: upstreamHeaders(req, config.upstreamApiKey),
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : rawBody,
    });
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
    else res.end();
}

async function handleChat(req, res, url, rawBody) {
    let body;
    try {
        body = JSON.parse(rawBody.toString('utf8'));
    } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid JSON body' } }));
        return;
    }
    const job = await applyStructuredPrefill(body);
    const upstream = await fetch(config.upstreamUrl + url, {
        method: 'POST',
        headers: upstreamHeaders(req, config.upstreamApiKey),
        body: JSON.stringify(body),
    });
    const type = upstream.headers.get('content-type') ?? 'application/json';
    if (!job || !upstream.ok || !upstream.body) {
        res.writeHead(upstream.status, { 'content-type': type });
        if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
        else res.end();
        return;
    }
    if (body.stream) {
        res.writeHead(upstream.status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        Readable.fromWeb(upstream.body.pipeThrough(createSseTransformer(job))).pipe(res);
        return;
    }
    const text = await upstream.text();
    let out = text;
    try {
        out = JSON.stringify(transformCompletionData(JSON.parse(text), job));
    } catch {
        // leave untouched
    }
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(out);
}

const server = http.createServer(async (req, res) => {
    try {
        // Accept both /v1/... and bare paths; forward relative to upstreamUrl (which already ends in /v1).
        const url = (req.url ?? '/').replace(/^\/v1(?=\/)/, '');
        const rawBody = await readBody(req);
        if (req.method === 'POST' && /\/chat\/completions\/?$/.test(url.split('?')[0])) {
            await handleChat(req, res, url, rawBody);
        } else {
            await proxyPlain(req, res, url, rawBody);
        }
    } catch (err) {
        console.error('[sp-proxy]', err);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(err?.message ?? err) } }));
    }
});

server.listen(config.port, config.host, () => {
    console.log(`[sp-proxy] listening on http://${config.host}:${config.port}/v1 -> ${config.upstreamUrl}`);
});

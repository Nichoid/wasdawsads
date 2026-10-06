/**
 * Response side: unwraps `{"value": "..."}` while it streams, hides the forced
 * prefix (or the Continue overlap) and re-emits plain text to SillyTavern.
 */

const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/**
 * Incrementally decodes the string value of the "value" key from a JSON
 * object that arrives in pieces. Falls back to raw text when the model did
 * not answer with JSON at all.
 */
export class JsonValueDecoder {
    constructor() {
        this.raw = '';
        this.value = '';
        this.mode = 'detect'; // detect | json | raw | done
        this.pos = 0;
    }

    /** @param {string} chunk @returns {string} decoded value so far */
    push(chunk) {
        this.raw += chunk;
        this.process();
        return this.text();
    }

    /** @returns {string} the final decoded value */
    finish() {
        if (this.mode === 'detect') {
            const parsed = tryParseValue(this.raw);
            if (parsed !== null) {
                this.value = parsed;
                this.mode = 'done';
            } else {
                this.mode = 'raw';
            }
        }
        return this.text();
    }

    text() {
        return this.mode === 'raw' ? this.raw : this.value;
    }

    process() {
        if (this.mode === 'detect') {
            const trimmed = this.raw.trimStart();
            if (!trimmed) return;
            if (trimmed[0] !== '{' && trimmed[0] !== '`') {
                this.mode = 'raw';
                return;
            }
            const m = /"value"\s*:\s*"/.exec(this.raw);
            if (!m) return;
            this.mode = 'json';
            this.pos = m.index + m[0].length;
        }
        if (this.mode !== 'json') return;
        const raw = this.raw;
        let pos = this.pos;
        let out = '';
        while (pos < raw.length) {
            const c = raw[pos];
            if (c === '\\') {
                if (pos + 1 >= raw.length) break;
                const n = raw[pos + 1];
                if (n === 'u') {
                    if (pos + 6 > raw.length) break;
                    const code = parseInt(raw.slice(pos + 2, pos + 6), 16);
                    out += Number.isNaN(code) ? raw.slice(pos, pos + 6) : String.fromCharCode(code);
                    pos += 6;
                } else {
                    out += ESCAPES[n] ?? n;
                    pos += 2;
                }
            } else if (c === '"') {
                this.mode = 'done';
                pos++;
                break;
            } else {
                out += c;
                pos++;
            }
        }
        this.value += out;
        this.pos = pos;
    }
}

function tryParseValue(raw) {
    let text = String(raw).trim();
    const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fence) text = fence[1];
    try {
        const obj = JSON.parse(text);
        if (obj && typeof obj === 'object' && typeof obj.value === 'string') return obj.value;
    } catch {
        // not JSON
    }
    return null;
}

/**
 * @typedef {object} OutputJob
 * @property {'prefill'|'continue'} mode
 * @property {boolean} hide                  hide the forced prefix (prefill mode)
 * @property {string} newlineToken
 * @property {string|null} hiddenRegexSource regex source for the hidden part (prefill mode)
 * @property {string|null} hiddenLiteral     hidden part as plain text when it has no stubs
 * @property {string} overlapText            continue mode: characters the model must repeat
 * @property {boolean} trimLeading           continue mode: drop leading whitespace of the new text
 */

/**
 * Decides which part of the decoded value the user gets to see. The cut point
 * is frozen as soon as it is known, so the visible text only ever grows while
 * streaming.
 */
export class OutputView {
    /** @param {OutputJob} job */
    constructor(job) {
        this.job = job;
        this.cut = null;
        this.hiddenRegex = null;
        if (job.mode === 'prefill' && job.hide && job.hiddenRegexSource !== null) {
            try {
                this.hiddenRegex = new RegExp('^(?:' + job.hiddenRegexSource + ')');
            } catch (err) {
                console.warn('[StructuredPrefill] Could not compile the hide-prefill regex, showing everything.', err);
            }
        }
    }

    normalize(text, final) {
        const token = this.job.newlineToken;
        if (!token) return text;
        if (!final) {
            // Hold back a partially received token so it is not shown raw.
            for (let k = Math.min(token.length - 1, text.length); k > 0; k--) {
                if (text.endsWith(token.slice(0, k))) {
                    text = text.slice(0, -k);
                    break;
                }
            }
        }
        return text.split(token).join('\n');
    }

    /** @param {string} decoded @param {boolean} final */
    compute(decoded, final) {
        const norm = this.normalize(decoded, final);
        const job = this.job;

        if (job.mode === 'continue') {
            if (this.cut === null) {
                const ov = job.overlapText || '';
                if (!ov) this.cut = 0;
                else if (norm.length >= ov.length) this.cut = norm.startsWith(ov) ? ov.length : 0;
                else if (!ov.startsWith(norm)) this.cut = 0; // model ignored the overlap
                else if (final) this.cut = norm.length;
                else return '';
            }
            const visible = norm.slice(this.cut);
            return job.trimLeading ? visible.trimStart() : visible;
        }

        if (!job.hide) return norm;

        if (this.cut === null) {
            if (!this.hiddenRegex) {
                this.cut = 0;
            } else {
                const m = this.hiddenRegex.exec(norm);
                const lit = job.hiddenLiteral;
                if (m && (m[0].length < norm.length || final)) {
                    this.cut = m[0].length;
                } else if (lit !== null && lit !== undefined && !lit.startsWith(norm) && !norm.startsWith(lit)) {
                    this.cut = 0; // model deviated from the prefill: show everything
                } else if (final) {
                    this.cut = 0;
                } else {
                    return '';
                }
            }
        }
        return norm.slice(this.cut).trimStart();
    }
}

/** Tracks one streamed choice. */
class ChoiceState {
    /** @param {OutputJob} job */
    constructor(job) {
        this.decoder = new JsonValueDecoder();
        this.view = new OutputView(job);
        this.emitted = '';
    }

    advance(visible) {
        if (!visible.startsWith(this.emitted)) {
            console.warn('[StructuredPrefill] Visible text diverged from what was already streamed.');
            return '';
        }
        const delta = visible.slice(this.emitted.length);
        this.emitted = visible;
        return delta;
    }

    push(content) {
        return this.advance(this.view.compute(this.decoder.push(content), false));
    }

    finish() {
        return this.advance(this.view.compute(this.decoder.finish(), true));
    }

    /** Full visible text for non-streaming responses. */
    full(content) {
        this.decoder.push(content);
        return this.view.compute(this.decoder.finish(), true);
    }
}

/**
 * Rewrites one parsed SSE payload in place.
 * @param {any} payload
 * @param {Map<number, ChoiceState>} states
 * @param {OutputJob} job
 */
function rewritePayload(payload, states, job) {
    if (!payload || !Array.isArray(payload.choices)) return;
    for (const choice of payload.choices) {
        const index = Number(choice?.index ?? 0);
        const holder = choice?.delta && typeof choice.delta.content === 'string' ? choice.delta
            : choice?.message && typeof choice.message.content === 'string' ? choice.message
                : null;
        const hasText = typeof choice?.text === 'string';
        if (!holder && !hasText) continue;
        if (!states.has(index)) states.set(index, new ChoiceState(job));
        const state = states.get(index);
        if (holder) holder.content = state.push(holder.content);
        else choice.text = state.push(choice.text);
    }
}

function flushEvents(states) {
    let out = '';
    for (const [index, state] of states) {
        const delta = state.finish();
        if (delta) {
            out += `data: ${JSON.stringify({ choices: [{ index, delta: { content: delta } }] })}\n\n`;
        }
    }
    return out;
}

/**
 * A TransformStream that rewrites an OpenAI-style SSE byte stream.
 * @param {OutputJob} job
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function createSseTransformer(job) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const states = new Map();
    let buffer = '';
    let flushed = false;

    const handleLine = (line) => {
        const m = /^data:\s?(.*)$/.exec(line);
        if (!m) return line + '\n';
        const payload = m[1].trim();
        if (payload === '[DONE]') {
            flushed = true;
            return flushEvents(states) + line + '\n';
        }
        try {
            const obj = JSON.parse(payload);
            rewritePayload(obj, states, job);
            return 'data: ' + JSON.stringify(obj) + '\n';
        } catch {
            return line + '\n';
        }
    };

    return new TransformStream({
        transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';
            let out = '';
            for (const line of lines) out += handleLine(line);
            if (out) controller.enqueue(encoder.encode(out));
        },
        flush(controller) {
            buffer += decoder.decode();
            let out = '';
            if (buffer) out += handleLine(buffer) + '\n';
            if (!flushed) out += flushEvents(states);
            if (out) controller.enqueue(encoder.encode(out));
        },
    });
}

/**
 * Rewrites a non-streaming chat completion response in place.
 * @param {any} data
 * @param {OutputJob} job
 */
export function transformCompletionData(data, job) {
    if (!data || !Array.isArray(data.choices)) return data;
    for (const choice of data.choices) {
        const state = new ChoiceState(job);
        if (typeof choice?.message?.content === 'string') {
            choice.message.content = state.full(choice.message.content);
        } else if (typeof choice?.text === 'string') {
            choice.text = state.full(choice.text);
        }
    }
    return data;
}

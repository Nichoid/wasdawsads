import assert from 'node:assert';
import { JsonValueDecoder, createSseTransformer, transformCompletionData } from '../lib/output.js';
import { planPrefill, planContinue } from '../lib/plan.js';

const settings = { hidePrefill: true, minChars: 0, newlineToken: '\\n', overlapChars: 8, bannedWords: '' };

function randomSplit(str) {
    const pieces = [];
    let i = 0;
    while (i < str.length) {
        const n = 1 + Math.floor(Math.random() * 7);
        pieces.push(str.slice(i, i + n));
        i += n;
    }
    return pieces;
}

/** Streams `value` (JSON-wrapped) through the transformer, returns what SillyTavern would accumulate. */
async function runStream(job, json, { done = true, extra = {} } = {}) {
    let sse = '';
    for (const piece of randomSplit(json)) {
        sse += `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece, ...extra } }] })}\n\n`;
    }
    if (done) sse += 'data: [DONE]\n\n';
    // Split the byte stream at arbitrary points too.
    const bytes = new TextEncoder().encode(sse);
    const source = new ReadableStream({
        start(controller) {
            let i = 0;
            while (i < bytes.length) {
                const n = 1 + Math.floor(Math.random() * 40);
                controller.enqueue(bytes.slice(i, i + n));
                i += n;
            }
            controller.close();
        },
    });
    const text = await new Response(source.pipeThrough(createSseTransformer(job))).text();
    let acc = '';
    const deltas = [];
    for (const line of text.split('\n')) {
        const m = /^data: (.*)$/.exec(line);
        if (!m || m[1] === '[DONE]') continue;
        const obj = JSON.parse(m[1]);
        const c = obj.choices?.[0]?.delta?.content ?? '';
        deltas.push(c);
        acc += c;
    }
    return { acc, deltas, text };
}

// decoder: escapes split across chunks
{
    const value = 'Line one\nquote " backslash \\ unicode é emoji 😀 tab\t';
    const json = JSON.stringify({ value });
    for (let k = 0; k < 50; k++) {
        const d = new JsonValueDecoder();
        let last = '';
        for (const piece of randomSplit(json)) {
            const now = d.push(piece);
            assert.ok(now.startsWith(last), 'decoder output must only grow');
            last = now;
        }
        assert.strictEqual(d.finish(), value);
    }
    const raw = new JsonValueDecoder();
    raw.push('Not JSON at all');
    assert.strictEqual(raw.finish(), 'Not JSON at all');
}

// hide prefill, literal prefix
for (let k = 0; k < 30; k++) {
    const plan = planPrefill({ settings, template: 'Briolette didn\'t even have time to turn' });
    const json = JSON.stringify({ value: 'Briolette didn\'t even have time to turn before the door burst open.' });
    const { acc } = await runStream(plan.job, json);
    assert.strictEqual(acc, 'before the door burst open.');
}

// hide off: everything visible
{
    const plan = planPrefill({ settings: { ...settings, hidePrefill: false }, template: 'Hello' });
    const { acc } = await runStream(plan.job, JSON.stringify({ value: 'Hello there.' }));
    assert.strictEqual(acc, 'Hello there.');
}

// [[keep]] with stubs before it, newline token converted back
for (let k = 0; k < 30; k++) {
    const plan = planPrefill({ settings, template: '<thinking>[[w:2-4]]</thinking>\n[[keep]]\nAlice' });
    const json = JSON.stringify({ value: '<thinking>she is upset</thinking>\\nAlice frowned.\\nThen she left.' });
    const { acc } = await runStream(plan.job, json);
    assert.strictEqual(acc, 'Alice frowned.\nThen she left.');
}

// model ignores the prefill: everything is shown
{
    const plan = planPrefill({ settings, template: 'Expected start' });
    const { acc } = await runStream(plan.job, JSON.stringify({ value: 'Something else.' }));
    assert.strictEqual(acc, 'Something else.');
}

// provider ignores the schema and sends plain text
{
    const plan = planPrefill({ settings: { ...settings, hidePrefill: false }, template: 'X' });
    const { acc } = await runStream(plan.job, 'Plain text answer');
    assert.strictEqual(acc, 'Plain text answer');
}

// stream without [DONE] still flushes
{
    const plan = planPrefill({ settings, template: 'Hi' });
    const { acc } = await runStream(plan.job, JSON.stringify({ value: 'Hi you\\n' }), { done: false });
    assert.strictEqual(acc, 'you\n');
}

// other delta fields (reasoning) survive
{
    const plan = planPrefill({ settings, template: 'Hi' });
    const { text } = await runStream(plan.job, JSON.stringify({ value: 'Hi you' }), { extra: { reasoning: 'thinking...' } });
    assert.ok(text.includes('"reasoning":"thinking..."'));
}

// continue: overlap stripped
for (let k = 0; k < 30; k++) {
    const plan = planContinue({ settings, existingText: 'He reached for the han', trimLeading: false });
    const { acc } = await runStream(plan.job, JSON.stringify({ value: ' the handle and pulled.' }));
    assert.strictEqual(acc, 'dle and pulled.');
}
{
    const plan = planContinue({ settings, existingText: 'She smiled.', trimLeading: true });
    const { acc } = await runStream(plan.job, JSON.stringify({ value: ' smiled. Then she waved.' }));
    assert.strictEqual(acc, 'Then she waved.');
}

// non-streaming
{
    const plan = planPrefill({ settings, template: 'Hi' });
    const data = { choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ value: 'Hi there\\nfriend' }) } }] };
    transformCompletionData(data, plan.job);
    assert.strictEqual(data.choices[0].message.content, 'there\nfriend');
}
console.log('output ok');

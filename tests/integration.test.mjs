// Loads index.js against a mocked SillyTavern context and a mocked backend.
import assert from 'node:assert';

const listeners = {};
const extensionSettings = { disabledExtensions: [] };
const chat = [
    { is_user: true, mes: 'Hello' },
    { is_user: false, mes: 'She looked up from her book and smi' },
];
let lastBackendBody = null;
let pgCalls = [];

globalThis.document = { getElementById: () => null };
globalThis.toastr = { error: (m) => console.log('toast error:', m), info() {}, warning() {} };

// Mock backend: returns the reply passed via `nextReply`, streaming or not.
let nextReply = '';
globalThis.fetch = async (url, init) => {
    lastBackendBody = JSON.parse(init.body);
    const json = JSON.stringify({ value: nextReply });
    if (lastBackendBody.stream) {
        let sse = '';
        for (let i = 0; i < json.length; i += 5) {
            sse += `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: json.slice(i, i + 5) } }] })}\n\n`;
        }
        sse += 'data: [DONE]\n\n';
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: json } }] }), { status: 200 });
};

globalThis.SillyTavern = {
    getContext: () => ({
        extensionSettings,
        saveSettingsDebounced() {},
        eventSource: { on: (e, fn) => { (listeners[e] ??= []).push(fn); } },
        eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready' },
        chat,
        name1: 'User',
        name2: 'Mira',
        chatCompletionSettings: { chat_completion_source: 'openrouter', continue_postfix: ' ' },
        mainApi: 'openai',
        substituteParams: (s) => s,
        ConnectionManagerRequestService: {
            async sendRequest(profileId, prompt, maxTokens, custom, override) {
                pgCalls.push({ profileId, prompt, maxTokens, override });
                return { content: 'Mira didn\'t even have time to turn\n\nUSER: nope' };
            },
        },
    }),
};

await import('../index.js');
const ready = async (data) => { for (const fn of listeners.chat_completion_settings_ready) await fn(data); };

async function sendLikeST(data) {
    await ready(data);
    const response = await fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(data) });
    if (!data.stream) return (await response.json()).choices[0].message.content;
    const text = await response.text();
    let acc = '';
    for (const line of text.split('\n')) {
        const m = /^data: (.*)$/.exec(line);
        if (m && m[1] !== '[DONE]') acc += JSON.parse(m[1]).choices[0].delta.content ?? '';
    }
    return acc;
}

// 1. Prefill is moved into the schema and hidden from the output.
{
    const data = {
        type: 'normal', stream: true, chat_completion_source: 'openrouter',
        messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Mira closed the book' }],
    };
    nextReply = 'Mira closed the book and stood up, smoothing her skirt before walking over to the window.';
    const out = await sendLikeST(data);
    assert.strictEqual(lastBackendBody.messages.length, 1, 'prefill removed from the request');
    assert.ok(!('__structured_prefill_job' in lastBackendBody), 'marker stripped before sending');
    assert.ok(lastBackendBody.json_schema.value.properties.value.pattern.startsWith('^Mira closed the book'));
    assert.strictEqual(out, 'and stood up, smoothing her skirt before walking over to the window.');
}

// 2. Unsupported source: untouched.
{
    const data = { type: 'normal', stream: false, chat_completion_source: 'claude', messages: [{ role: 'assistant', content: 'X' }] };
    await ready(data);
    assert.strictEqual(data.json_schema, undefined);
    assert.strictEqual(data.messages.length, 1);
}

// 3. Quiet generations: untouched.
{
    const data = { type: 'quiet', chat_completion_source: 'openrouter', messages: [{ role: 'assistant', content: 'X' }] };
    await ready(data);
    assert.strictEqual(data.json_schema, undefined);
}

// 4. Continue with overlap, non-streaming.
{
    const data = {
        type: 'continue', stream: false, chat_completion_source: 'openrouter',
        messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: chat[1].mes }],
    };
    const ov = chat[1].mes.slice(-40);
    nextReply = ov + 'led warmly at you, as though she had been waiting for a long time.';
    const out = await sendLikeST(data);
    assert.strictEqual(lastBackendBody.messages.at(-1).role, 'user', 'nudge appended after trailing assistant');
    assert.strictEqual(out, 'led warmly at you, as though she had been waiting for a long time.');
}

// 5. [[pg]]: generator output becomes part of the forced prefix.
{
    extensionSettings.structuredPrefill.pgProfileId = 'profile-1';
    extensionSettings.structuredPrefill.pgStopStrings = '\\n\\n';
    const data = {
        type: 'normal', stream: true, chat_completion_source: 'openrouter',
        messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: '[[keep]]\n[[pg]]' }],
    };
    nextReply = '\nMira didn\'t even have time to turn before the door burst open and three guards rushed in.';
    const out = await sendLikeST(data);
    assert.strictEqual(pgCalls.length, 1);
    assert.deepStrictEqual(pgCalls[0].override, { stop: ['\n\n'] });
    assert.ok(lastBackendBody.json_schema.value.properties.value.pattern.includes('Mira didn\'t even have time to turn'));
    assert.ok(!lastBackendBody.json_schema.value.properties.value.pattern.includes('USER'), 'stop string applied');
    assert.strictEqual(out, 'Mira didn\'t even have time to turn before the door burst open and three guards rushed in.');
}

// 6. Last assistant message that is just chat history is not treated as a prefill.
{
    const data = {
        type: 'normal', stream: false, chat_completion_source: 'openrouter',
        messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: chat[1].mes }],
    };
    await ready(data);
    assert.strictEqual(data.json_schema, undefined, 'no prefill and no banned words: nothing to do');
    assert.strictEqual(data.messages.length, 2);
}

// 7. Banned words alone activate the schema.
{
    extensionSettings.structuredPrefill.bannedWords = 'ozone\ntapestry';
    const data = { type: 'normal', stream: false, chat_completion_source: 'openrouter', messages: [{ role: 'user', content: 'Hi' }] };
    nextReply = 'The air smelled of rain and old stone, and somewhere far off a bell was ringing over the hills. Nobody in the village seemed to notice it.';
    const out = await sendLikeST(data);
    const re = new RegExp(lastBackendBody.json_schema.value.properties.value.pattern);
    assert.ok(re.test(nextReply));
    assert.ok(!re.test('The air smelled of ozone and something else entirely, like a storm.'));
    assert.strictEqual(out, nextReply);
}
// 8. Prefill box in the settings, with macros, overrides a prompt-level prefill.
{
    extensionSettings.structuredPrefill.bannedWords = '';
    extensionSettings.structuredPrefill.prefill = '{{char}} smiled';
    const realCtx = globalThis.SillyTavern.getContext;
    globalThis.SillyTavern.getContext = () => ({ ...realCtx(), substituteParams: (t) => t.replace('{{char}}', 'Mira') });
    const data = {
        type: 'normal', stream: true, chat_completion_source: 'openrouter',
        messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Prompt manager prefill' }],
    };
    nextReply = 'Mira smiled and handed over the letter without a word, then turned back toward the crowded harbour.';
    const out = await sendLikeST(data);
    globalThis.SillyTavern.getContext = realCtx;
    assert.strictEqual(lastBackendBody.messages.length, 1, 'prompt-level prefill still removed');
    assert.ok(lastBackendBody.json_schema.value.properties.value.pattern.startsWith('^Mira smiled'));
    assert.strictEqual(out, 'and handed over the letter without a word, then turned back toward the crowded harbour.');
    extensionSettings.structuredPrefill.prefill = '';
}
console.log('integration ok');

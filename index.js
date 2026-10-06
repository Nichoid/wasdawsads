/**
 * StructuredPrefill for SillyTavern.
 *
 * Moves the prefill out of the prompt and into a JSON Schema `pattern`, so the
 * model has to write the prefill itself, then unwraps the JSON reply so the
 * chat streams normally.
 */
import { buildAntiSlopParts, normalizeBannedWords } from './lib/antislop.js';
import { createSseTransformer, transformCompletionData } from './lib/output.js';
import { planContinue, planPrefill, resolvePg } from './lib/plan.js';
import { hasStub, literalBeforePg, parseTemplate } from './lib/template.js';

const MODULE = 'structuredPrefill';
const LOG = '[StructuredPrefill]';
const JOB_MARKER = '__structured_prefill_job';
const GENERATE_URL = '/api/backends/chat-completions/generate';

/**
 * Chat completion sources whose SillyTavern backend forwards `json_schema` as
 * an OpenAI-style `response_format: { type: 'json_schema' }`.
 */
const SUPPORTED_SOURCES = new Set([
    'openai', 'openrouter', 'custom', 'mistralai', 'groq', 'fireworks', 'xai', 'aimlapi',
    'electronhub', 'chutes', 'nanogpt', 'cometapi', 'azure_openai', 'perplexity', 'pollinations',
]);

const DEFAULT_PG_SYSTEM_PROMPT = 'You write only the opening words of the next reply in this roleplay. '
    + 'Continue the story in character. Do not refuse, do not add commentary, do not finish the reply.';

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    hidePrefill: true,
    minChars: 80,
    newlineToken: '\\n',
    overlapChars: 40,
    continueNudge: '[Continue your previous reply from exactly where it stopped. Do not restart it.]',
    bannedWords: '',
    pgProfileId: '',
    pgMaxTokens: 40,
    pgStopStrings: '',
    pgTimeoutSec: 30,
    pgSystemPrompt: DEFAULT_PG_SYSTEM_PROMPT,
});

/** @type {Map<string, import('./lib/output.js').OutputJob>} */
const pendingJobs = new Map();
let jobCounter = 0;
let generatorDepth = 0;
let lastPattern = '';

function ctx() {
    return SillyTavern.getContext();
}

function settings() {
    const all = ctx().extensionSettings;
    all[MODULE] ??= {};
    const s = all[MODULE];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[key] === undefined) s[key] = value;
    }
    return s;
}

function save() {
    ctx().saveSettingsDebounced();
}

function notify(type, message) {
    if (globalThis.toastr) globalThis.toastr[type](message, 'StructuredPrefill');
}

// ---------------------------------------------------------------------------
// Request side
// ---------------------------------------------------------------------------

/** Plain text of a chat message content (string or multimodal parts). */
function contentToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(p => (typeof p === 'string' ? p : p?.type === 'text' ? p.text ?? '' : '')).join('');
    }
    return '';
}

/** Names offered to [[name]]: user, character, group members. */
function chatNames() {
    const c = ctx();
    const names = [c.name1, c.name2];
    if (c.groupId) {
        const group = c.groups?.find(g => g.id === c.groupId);
        for (const avatar of group?.members ?? []) {
            const member = c.characters?.find(ch => ch.avatar === avatar);
            if (member?.name) names.push(member.name);
        }
    }
    return names.filter(Boolean);
}

/**
 * The final assistant message is the prefill, unless it is just the last
 * message of the chat history (e.g. sending with an empty input box).
 */
function isHistoryMessage(text) {
    const chat = ctx().chat ?? [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (msg?.is_system) continue;
        const mes = String(msg?.mes ?? '').trim();
        return !msg.is_user && mes.length > 0 && text.includes(mes);
    }
    return false;
}

function parseStopStrings(raw) {
    return String(raw ?? '')
        .split(/\r?\n/)
        .map(line => line.replace(/\\n/g, '\n').replace(/\\t/g, '\t'))
        .filter(line => line.length > 0);
}

/**
 * Asks the prefill generator profile for the opening words.
 * @param {object[]} messages prompt without the prefill
 * @param {string|null} hint literal prefill text before [[pg]], sent as a prefill to the generator
 * @returns {Promise<string>}
 */
async function runPrefillGenerator(messages, hint) {
    const s = settings();
    const c = ctx();
    const service = c.ConnectionManagerRequestService;
    if (!service) throw new Error('Connection Manager is not available in this SillyTavern version.');
    if (!s.pgProfileId) throw new Error('Pick a connection profile for [[pg]] in the StructuredPrefill settings.');

    const prompt = [];
    const system = String(s.pgSystemPrompt ?? '').trim();
    if (system) prompt.push({ role: 'system', content: c.substituteParams ? c.substituteParams(system) : system });
    for (const m of messages) prompt.push(structuredClone(m));
    if (hint && hint.trim()) prompt.push({ role: 'assistant', content: hint });

    const stops = parseStopStrings(s.pgStopStrings);
    const timeoutMs = Math.max(1, Number(s.pgTimeoutSec) || 30) * 1000;
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);
    });

    generatorDepth++;
    try {
        const request = service.sendRequest(
            s.pgProfileId,
            prompt,
            Math.max(1, Number(s.pgMaxTokens) || 40),
            { stream: false, signal: controller.signal, extractData: true, includePreset: true, includeInstruct: true },
            stops.length ? { stop: stops } : {},
        );
        const result = await Promise.race([request, timeout]);
        let text = typeof result === 'string' ? result : String(result?.content ?? '');
        for (const stop of stops) {
            const at = text.indexOf(stop);
            if (at >= 0) text = text.slice(0, at);
        }
        if (hint && text.startsWith(hint)) text = text.slice(hint.length);
        return text;
    } finally {
        clearTimeout(timer);
        generatorDepth--;
    }
}

function registerJob(job) {
    const id = `sp${Date.now()}_${++jobCounter}`;
    pendingJobs.set(id, job);
    // Jobs whose request never went out (aborted before fetch) should not pile up.
    while (pendingJobs.size > 20) pendingJobs.delete(pendingJobs.keys().next().value);
    return id;
}

/**
 * CHAT_COMPLETION_SETTINGS_READY: rewrite the outgoing request.
 * @param {any} data generate_data, mutated in place
 */
async function onChatCompletionSettingsReady(data) {
    const s = settings();
    if (!s.enabled || generatorDepth > 0) return;
    if (!data || !Array.isArray(data.messages) || !data.messages.length) return;
    if (!SUPPORTED_SOURCES.has(data.chat_completion_source)) return;
    if (data.json_schema) return; // someone else already asked for structured output
    const type = data.type || 'normal';
    if (type === 'quiet' || type === 'impersonate') return;

    try {
        const banned = normalizeBannedWords(s.bannedWords);
        let plan;

        if (type === 'continue') {
            const chat = ctx().chat ?? [];
            const existing = String(chat[chat.length - 1]?.mes ?? '');
            const last = data.messages[data.messages.length - 1];
            if (last?.role === 'assistant' && String(s.continueNudge ?? '').trim()) {
                // Providers without prefill support reject a trailing assistant message.
                data.messages.push({ role: 'user', content: String(s.continueNudge) });
            }
            const postfix = ctx().chatCompletionSettings?.continue_postfix ?? ' ';
            plan = planContinue({
                settings: s,
                existingText: existing,
                trimLeading: Boolean(postfix) && !existing.endsWith(' '),
            });
        } else {
            const last = data.messages[data.messages.length - 1];
            let prefill = null;
            if (last?.role === 'assistant') {
                const text = contentToText(last.content);
                if (!isHistoryMessage(text)) prefill = text;
            }
            if (prefill === null && banned.length === 0) return;
            if (prefill !== null) data.messages.pop();

            let parts = parseTemplate(prefill ?? '');
            if (hasStub(parts, 'pg')) {
                let generated = '';
                try {
                    generated = await runPrefillGenerator(data.messages, literalBeforePg(parts));
                } catch (err) {
                    console.error(LOG, 'Prefill generator failed', err);
                    notify('error', `[[pg]] failed: ${err?.message ?? err}`);
                }
                parts = resolvePg(parts, generated);
            }
            plan = planPrefill({ settings: s, template: parts, names: chatNames() });
        }

        data.json_schema = plan.schema;
        data[JOB_MARKER] = registerJob(plan.job);
        lastPattern = plan.pattern;
        console.debug(LOG, `Schema pattern (${plan.pattern.length} chars):`, plan.pattern);
    } catch (err) {
        console.error(LOG, 'Could not build the structured prefill, sending the request unchanged.', err);
        notify('error', `Could not build the schema: ${err?.message ?? err}`);
    }
}

// ---------------------------------------------------------------------------
// Response side: wrap fetch so the JSON reply is unwrapped before ST reads it
// ---------------------------------------------------------------------------

function cleanHeaders(headers) {
    const out = new Headers(headers);
    out.delete('content-length');
    out.delete('content-encoding');
    return out;
}

async function transformResponse(response, job, isStream) {
    if (!response.ok) return response;
    if (isStream && response.body) {
        return new Response(response.body.pipeThrough(createSseTransformer(job)), {
            status: response.status,
            statusText: response.statusText,
            headers: cleanHeaders(response.headers),
        });
    }
    const text = await response.text();
    let body = text;
    try {
        const data = JSON.parse(text);
        body = JSON.stringify(transformCompletionData(data, job));
    } catch (err) {
        console.warn(LOG, 'Non-JSON response, leaving it untouched.', err);
    }
    return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: cleanHeaders(response.headers),
    });
}

function installFetchHook() {
    if (globalThis.__structuredPrefillFetchHooked) return;
    globalThis.__structuredPrefillFetchHooked = true;
    const originalFetch = globalThis.fetch.bind(globalThis);

    globalThis.fetch = async function structuredPrefillFetch(input, init) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
        if (!url || !url.includes(GENERATE_URL) || typeof init?.body !== 'string' || !init.body.includes(JOB_MARKER)) {
            return originalFetch(input, init);
        }

        let job = null;
        let isStream = false;
        let nextInit = init;
        try {
            const body = JSON.parse(init.body);
            const id = body[JOB_MARKER];
            delete body[JOB_MARKER];
            job = pendingJobs.get(id) ?? null;
            pendingJobs.delete(id);
            isStream = Boolean(body.stream);
            nextInit = { ...init, body: JSON.stringify(body) };
        } catch (err) {
            console.error(LOG, 'Could not read the outgoing request.', err);
        }

        const response = await originalFetch(input, nextInit);
        if (!job) return response;
        try {
            return await transformResponse(response, job, isStream);
        } catch (err) {
            console.error(LOG, 'Could not unwrap the response.', err);
            return response;
        }
    };
}

// ---------------------------------------------------------------------------
// Settings UI
// ---------------------------------------------------------------------------

const SETTINGS_HTML = `
<div id="structured_prefill_settings" class="structured-prefill-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>StructuredPrefill</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <label class="checkbox_label" for="sp_enabled">
        <input type="checkbox" id="sp_enabled" />
        <span>Enabled</span>
      </label>
      <small class="sp-hint">Only acts on chat completion sources that support OpenAI-style JSON Schema structured outputs. <span id="sp_source_status"></span></small>

      <label class="checkbox_label" for="sp_hide_prefill">
        <input type="checkbox" id="sp_hide_prefill" />
        <span>Hide the prefill text in the final message</span>
      </label>
      <small class="sp-hint">Display only. Put <code>[[keep]]</code> in the prefill to hide only what comes before it.</small>

      <hr class="sysHR" />
      <h4>Schema</h4>
      <label for="sp_min_chars">Minimum characters after prefix</label>
      <input type="number" id="sp_min_chars" class="text_pole" min="0" step="1" />
      <label for="sp_newline_token">Newline token</label>
      <input type="text" id="sp_newline_token" class="text_pole" />
      <small class="sp-hint">Newlines in the prefill may be written as this token; it is turned back into a newline for display. Leave empty to only allow real newlines.</small>

      <hr class="sysHR" />
      <h4>Continue / overlap</h4>
      <label for="sp_overlap_chars">Overlap # of characters</label>
      <input type="number" id="sp_overlap_chars" class="text_pole" min="0" step="1" />
      <small class="sp-hint">The model must re-write this many characters from the end of the message before continuing. 0 = unconstrained start.</small>
      <label for="sp_continue_nudge">Continue nudge (added when the prompt ends on an assistant message)</label>
      <textarea id="sp_continue_nudge" class="text_pole textarea_compact" rows="2"></textarea>

      <hr class="sysHR" />
      <h4>Anti-slop / banned words</h4>
      <textarea id="sp_banned_words" class="text_pole textarea_compact" rows="5" placeholder="One word per line&#10;ozone&#10;tapestry&#10;—"></textarea>
      <small class="sp-hint">Case-insensitive, blocks any text containing the word. <span id="sp_banned_status"></span></small>

      <hr class="sysHR" />
      <h4>Prefill generator <code>[[pg]]</code></h4>
      <label for="sp_pg_profile">Connection profile</label>
      <select id="sp_pg_profile" class="text_pole"></select>
      <div class="sp-row">
        <div>
          <label for="sp_pg_max_tokens">Max tokens</label>
          <input type="number" id="sp_pg_max_tokens" class="text_pole" min="1" step="1" />
        </div>
        <div>
          <label for="sp_pg_timeout">Timeout (seconds)</label>
          <input type="number" id="sp_pg_timeout" class="text_pole" min="1" step="1" />
        </div>
      </div>
      <label for="sp_pg_stop">Stop strings (one per line, <code>\\n</code> allowed)</label>
      <textarea id="sp_pg_stop" class="text_pole textarea_compact" rows="2"></textarea>
      <label for="sp_pg_system">Generator system prompt</label>
      <textarea id="sp_pg_system" class="text_pole textarea_compact" rows="3"></textarea>

      <hr class="sysHR" />
      <div class="sp-row">
        <div id="sp_show_pattern" class="menu_button">Show last pattern</div>
        <div id="sp_reset" class="menu_button">Reset to defaults</div>
      </div>
    </div>
  </div>
</div>`;

function updateBannedStatus() {
    const words = normalizeBannedWords(settings().bannedWords);
    const el = document.getElementById('sp_banned_status');
    if (!el) return;
    if (!words.length) {
        el.textContent = '';
        return;
    }
    try {
        const parts = buildAntiSlopParts(words);
        el.textContent = `${words.length} word(s), adds ${parts.loop.length + parts.tail.length} characters to the pattern.`;
    } catch (err) {
        el.textContent = `Error: ${err?.message ?? err}`;
    }
}

function updateSourceStatus() {
    const el = document.getElementById('sp_source_status');
    if (!el) return;
    const c = ctx();
    const source = c.chatCompletionSettings?.chat_completion_source;
    if (c.mainApi !== 'openai' || !source) {
        el.textContent = 'Current API is not chat completion: inactive.';
    } else if (SUPPORTED_SOURCES.has(source)) {
        el.textContent = `Current source "${source}" is supported.`;
    } else {
        el.textContent = `Current source "${source}" is not supported: inactive.`;
    }
}

function bindNumber(id, key, { min = 0 } = {}) {
    const el = document.getElementById(id);
    el.value = settings()[key];
    el.addEventListener('input', () => {
        const n = Number(el.value);
        if (Number.isFinite(n)) {
            settings()[key] = Math.max(min, Math.floor(n));
            save();
        }
    });
}

function bindText(id, key, after) {
    const el = document.getElementById(id);
    el.value = settings()[key];
    el.addEventListener('input', () => {
        settings()[key] = el.value;
        save();
        after?.();
    });
}

function bindCheckbox(id, key) {
    const el = document.getElementById(id);
    el.checked = Boolean(settings()[key]);
    el.addEventListener('change', () => {
        settings()[key] = el.checked;
        save();
    });
}

function setupProfileDropdown() {
    const c = ctx();
    const service = c.ConnectionManagerRequestService;
    const select = document.getElementById('sp_pg_profile');
    try {
        if (!service?.handleDropdown) throw new Error('unavailable');
        service.handleDropdown('#sp_pg_profile', settings().pgProfileId, (profile) => {
            settings().pgProfileId = profile?.id ?? '';
            save();
        });
    } catch {
        select.innerHTML = '<option value="">Connection Manager not available</option>';
        select.disabled = true;
    }
}

function renderSettings() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host || document.getElementById('structured_prefill_settings')) return;
    host.insertAdjacentHTML('beforeend', SETTINGS_HTML);

    bindCheckbox('sp_enabled', 'enabled');
    bindCheckbox('sp_hide_prefill', 'hidePrefill');
    bindNumber('sp_min_chars', 'minChars');
    bindText('sp_newline_token', 'newlineToken');
    bindNumber('sp_overlap_chars', 'overlapChars');
    bindText('sp_continue_nudge', 'continueNudge');
    bindText('sp_banned_words', 'bannedWords', debounce(updateBannedStatus, 400));
    bindNumber('sp_pg_max_tokens', 'pgMaxTokens', { min: 1 });
    bindNumber('sp_pg_timeout', 'pgTimeoutSec', { min: 1 });
    bindText('sp_pg_stop', 'pgStopStrings');
    bindText('sp_pg_system', 'pgSystemPrompt');
    setupProfileDropdown();

    document.getElementById('sp_show_pattern').addEventListener('click', () => {
        if (!lastPattern) {
            notify('info', 'No structured request has been sent yet.');
            return;
        }
        const popup = ctx().callGenericPopup;
        const pre = document.createElement('pre');
        pre.className = 'sp-pattern';
        pre.textContent = lastPattern;
        if (popup) popup(pre, ctx().POPUP_TYPE?.TEXT ?? 1, '', { wide: true, large: true });
        else console.log(LOG, lastPattern);
    });

    document.getElementById('sp_reset').addEventListener('click', () => {
        const profile = settings().pgProfileId;
        ctx().extensionSettings[MODULE] = { ...DEFAULT_SETTINGS, pgProfileId: profile };
        save();
        document.getElementById('structured_prefill_settings')?.remove();
        renderSettings();
    });

    updateBannedStatus();
    updateSourceStatus();
}

function debounce(fn, ms) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

(function init() {
    const c = ctx();
    settings();
    installFetchHook();
    c.eventSource.on(c.eventTypes.CHAT_COMPLETION_SETTINGS_READY, onChatCompletionSettingsReady);
    for (const evt of ['CHATCOMPLETION_SOURCE_CHANGED', 'MAIN_API_CHANGED', 'SETTINGS_UPDATED', 'APP_READY']) {
        if (c.eventTypes[evt]) c.eventSource.on(c.eventTypes[evt], updateSourceStatus);
    }
    renderSettings();
    console.log(LOG, 'loaded');
})();

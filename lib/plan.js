/**
 * Turns settings + the outgoing prefill into a JSON schema and an output job.
 */
import { buildFreeTextPattern, normalizeBannedWords } from './antislop.js';
import { buildPrefixPattern, literalPattern, parseTemplate } from './template.js';

export const SCHEMA_NAME = 'structured_prefill';

/**
 * Wraps a regex pattern into the json_schema object SillyTavern forwards to
 * the provider as `response_format: { type: 'json_schema', ... }`.
 * @param {string} pattern
 */
export function makeJsonSchema(pattern) {
    return {
        name: SCHEMA_NAME,
        description: 'The assistant reply as a single string.',
        strict: true,
        value: {
            type: 'object',
            properties: {
                value: { type: 'string', pattern },
            },
            required: ['value'],
            additionalProperties: false,
        },
    };
}

/**
 * Replaces every [[pg]] stub with the generated text.
 * @param {import('./template.js').TemplatePart[]} parts
 * @param {string} text
 */
export function resolvePg(parts, text) {
    return parts.map(p => (p.type === 'stub' && p.name === 'pg') ? { type: 'text', text: String(text ?? '') } : p);
}

/**
 * Last `n` characters (code points) of a string.
 */
export function tailChars(str, n) {
    const arr = Array.from(String(str ?? ''));
    const count = Math.max(0, Math.floor(Number(n) || 0));
    return count ? arr.slice(-count).join('') : '';
}

/**
 * @typedef {object} PlanSettings
 * @property {boolean} hidePrefill
 * @property {number} minChars
 * @property {string} newlineToken
 * @property {number} overlapChars
 * @property {string} bannedWords
 */

/**
 * Plan for a normal generation with a prefill (possibly empty).
 * @param {object} args
 * @param {PlanSettings} args.settings
 * @param {import('./template.js').TemplatePart[]|string} args.template parsed prefill or raw text
 * @param {string[]} [args.names]
 */
export function planPrefill({ settings, template, names = [] }) {
    const parts = typeof template === 'string' ? parseTemplate(template) : template;
    const ctx = { newlineToken: settings.newlineToken, names };
    const built = buildPrefixPattern(parts, ctx);
    const banned = normalizeBannedWords(settings.bannedWords);
    const tail = built.hasEnd ? '' : buildFreeTextPattern(banned, settings.minChars);
    const pattern = `^${built.prefix}${tail}$`;
    return {
        pattern,
        schema: makeJsonSchema(pattern),
        job: {
            mode: 'prefill',
            hide: Boolean(settings.hidePrefill),
            newlineToken: settings.newlineToken,
            hiddenRegexSource: built.hidden,
            hiddenLiteral: built.hiddenLiteral,
            overlapText: '',
            trimLeading: false,
        },
    };
}

/**
 * Plan for a Continue generation.
 * @param {object} args
 * @param {PlanSettings} args.settings
 * @param {string} args.existingText the message being continued
 * @param {boolean} args.trimLeading  drop leading whitespace (SillyTavern already inserted a separator)
 */
export function planContinue({ settings, existingText, trimLeading = false }) {
    const overlap = tailChars(existingText, settings.overlapChars);
    const ctx = { newlineToken: settings.newlineToken, names: [] };
    const banned = normalizeBannedWords(settings.bannedWords);
    const pattern = `^${literalPattern(overlap, ctx)}${buildFreeTextPattern(banned, settings.minChars)}$`;
    return {
        pattern,
        schema: makeJsonSchema(pattern),
        job: {
            mode: 'continue',
            hide: false,
            newlineToken: settings.newlineToken,
            hiddenRegexSource: null,
            hiddenLiteral: null,
            overlapText: overlap,
            trimLeading: Boolean(trimLeading),
        },
    };
}

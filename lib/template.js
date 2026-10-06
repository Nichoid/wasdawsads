/**
 * Prefill templates: parses `[[...]]` stubs and turns the prefill into the
 * regex used for the JSON Schema `pattern`.
 */

export const EMOTIONS = [
    'happy', 'sad', 'angry', 'afraid', 'scared', 'nervous', 'anxious', 'excited', 'calm', 'content',
    'curious', 'confused', 'surprised', 'shocked', 'embarrassed', 'flustered', 'shy', 'bashful', 'proud', 'ashamed',
    'guilty', 'jealous', 'envious', 'lonely', 'bored', 'tired', 'exhausted', 'frustrated', 'annoyed', 'irritated',
    'amused', 'playful', 'mischievous', 'smug', 'confident', 'determined', 'hopeful', 'hopeless', 'grateful', 'relieved',
    'disappointed', 'hurt', 'heartbroken', 'loving', 'affectionate', 'tender', 'aroused', 'flirty', 'suspicious', 'wary',
    'defiant', 'resigned', 'melancholic', 'nostalgic', 'tense', 'panicked', 'furious', 'cheerful', 'gloomy', 'neutral',
];

const STUB_RE = /\[\[\s*([a-zA-Z]+)\s*(?::([\s\S]*?))?\]\]/g;

const KNOWN_STUBS = new Set([
    'w', 'words', 'opt', 're', 'free', 'end', 'stop', 'eos', 'emotion', 'mood', 'line', 'lines',
    'name', 'action', 'thought', 'num', 'number', 'keep', 'pg',
]);

/**
 * @typedef {{ type: 'text', text: string }
 *   | { type: 'stub', name: string, arg: string, raw: string }} TemplatePart
 */

/**
 * Splits a prefill into literal text and stubs. Unknown `[[...]]` blocks stay literal.
 * @param {string} text
 * @returns {TemplatePart[]}
 */
export function parseTemplate(text) {
    const src = String(text ?? '').replace(/\r\n?/g, '\n');
    /** @type {TemplatePart[]} */
    const parts = [];
    let last = 0;
    const pushText = (t) => {
        if (!t) return;
        const prev = parts[parts.length - 1];
        if (prev && prev.type === 'text') prev.text += t;
        else parts.push({ type: 'text', text: t });
    };
    for (const m of src.matchAll(STUB_RE)) {
        const name = m[1].toLowerCase();
        if (!KNOWN_STUBS.has(name)) continue;
        pushText(src.slice(last, m.index));
        parts.push({ type: 'stub', name, arg: (m[2] ?? '').trim(), raw: m[0] });
        last = m.index + m[0].length;
    }
    pushText(src.slice(last));
    return parts;
}

/** @param {TemplatePart[]} parts */
export function hasStub(parts, ...names) {
    return parts.some(p => p.type === 'stub' && names.includes(p.name));
}

export function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
}

function escapeClass(ch) {
    return /[\\\]\[^\-]/.test(ch) ? '\\' + ch : ch;
}

function parseRange(arg, fallbackMin = 1, fallbackMax = fallbackMin) {
    const m = String(arg ?? '').trim().match(/^(-?\d+)\s*(?:-\s*(-?\d+))?$/);
    if (!m) return [fallbackMin, fallbackMax];
    let a = parseInt(m[1], 10);
    let b = m[2] !== undefined ? parseInt(m[2], 10) : a;
    if (b < a) [a, b] = [b, a];
    return [a, b];
}

function quant(min, max) {
    if (min === max) return min === 1 ? '' : `{${min}}`;
    return `{${min},${max}}`;
}

/**
 * Regex for an integer range. Small ranges are enumerated, larger ones are
 * constrained by digit count.
 */
export function numberRangePattern(a, b) {
    if (b - a <= 30) {
        const values = [];
        for (let i = a; i <= b; i++) values.push(String(i));
        values.sort((x, y) => y.length - x.length || Number(y) - Number(x));
        return `(?:${values.map(escapeRegex).join('|')})`;
    }
    if (a < 0) {
        const maxLen = Math.max(String(Math.abs(a)).length, String(Math.abs(b)).length);
        return b < 0 ? `-\\d{1,${maxLen}}` : `-?\\d{1,${maxLen}}`;
    }
    const digits = (min, max) => max <= 0 ? '' : min === max ? `\\d{${min}}` : `\\d{${min},${max}}`;
    const minLen = String(a).length;
    const maxLen = String(b).length;
    if (a === 0) return `(?:0|[1-9]${digits(0, maxLen - 1)})`;
    return `(?:[1-9]${digits(minLen - 1, maxLen - 1)})`;
}

/**
 * Context used to build stub patterns.
 * @typedef {object} BuildContext
 * @property {string} newlineToken   literal token used for newlines ('' = real newline only)
 * @property {string[]} names        names available for [[name]]
 */

/**
 * Builds the shared building blocks for a given newline token.
 * @param {string} newlineToken
 */
export function regexAtoms(newlineToken) {
    const token = String(newlineToken ?? '');
    const nl = token ? `(?:\\n|${escapeRegex(token)})` : '\\n';
    // Exclude the token's first char from "one line" text so the token cannot hide inside it.
    const tokFirst = token ? escapeClass(Array.from(token)[0]) : '';
    const wordChar = `[^\\s${tokFirst}]`;
    const lineChar = `[^\\r\\n${tokFirst}]`;
    return { nl, wordChar, lineChar, tokFirst };
}

function wordsPattern(min, max, charClass) {
    const word = `${charClass}+`;
    if (max < 1) return '';
    if (min <= 0) return `(?:${word}(?:[ \\t]+${word}){0,${max - 1}})?`;
    const rest = quant(min - 1, max - 1);
    if (max === 1) return word;
    return `${word}(?:[ \\t]+${word})${rest || '{1}'}`;
}

function emotionPattern() {
    return `(?:${EMOTIONS.map(e => `[${e[0]}${e[0].toUpperCase()}]${escapeRegex(e.slice(1))}`).join('|')})`;
}

/**
 * Converts one stub into a regex fragment.
 * @param {{ name: string, arg: string }} stub
 * @param {BuildContext} ctx
 * @returns {string}
 */
export function stubPattern(stub, ctx) {
    const { nl, wordChar, lineChar, tokFirst } = regexAtoms(ctx.newlineToken);
    switch (stub.name) {
        case 'w':
        case 'words': {
            const [a, b] = parseRange(stub.arg, 1, 1);
            return `(?:${wordsPattern(Math.max(0, a), Math.max(1, b), wordChar)})`;
        }
        case 'opt': {
            const options = stub.arg.split('|').map(x => x.trim()).filter(Boolean);
            if (!options.length) return '';
            options.sort((x, y) => y.length - x.length);
            return `(?:${options.map(escapeRegex).join('|')})`;
        }
        case 're': {
            let body = stub.arg.replace(/[\r\n]+/g, '');
            const slash = body.match(/^\/([\s\S]*)\/[a-z]*$/);
            if (slash) body = slash[1];
            // Anchors would break the surrounding pattern.
            body = body.replace(/^\^/, '').replace(/(?<!\\)\$$/, '');
            return body ? `(?:${body})` : '';
        }
        case 'free':
            return '[\\s\\S]+?';
        case 'emotion':
        case 'mood':
            return emotionPattern();
        case 'line':
            return `${lineChar}+`;
        case 'lines': {
            const [a, b] = parseRange(stub.arg, 1, 1);
            const min = Math.max(1, a);
            const max = Math.max(min, b);
            const line = `${lineChar}+`;
            if (max === 1) return line;
            return `${line}(?:${nl}${line})${quant(min - 1, max - 1) || '{1}'}`;
        }
        case 'name': {
            const names = [...new Set((ctx.names ?? []).map(n => String(n).trim()).filter(Boolean))];
            if (!names.length) return `[A-Z][a-z]+(?: [A-Z][a-z]+)?`;
            names.sort((x, y) => y.length - x.length);
            return `(?:${names.map(escapeRegex).join('|')})`;
        }
        case 'action':
            // Narration for *[[action]]*: no dialogue quotes, no asterisks.
            return `(?:${wordsPattern(1, 6, `[^\\s"“”*${tokFirst}]`)})`;
        case 'thought':
            // Inner monologue for (([[thought]])): no dialogue quotes, no parentheses.
            return `(?:${wordsPattern(1, 10, `[^\\s"“”()${tokFirst}]`)})`;
        case 'num':
            return '-?\\d+';
        case 'number': {
            if (!stub.arg) return '-?\\d+';
            const [a, b] = parseRange(stub.arg, 0, 100);
            return numberRangePattern(a, b);
        }
        default:
            return '';
    }
}

/**
 * Turns literal prefill text into a regex fragment.
 * @param {string} text
 * @param {BuildContext} ctx
 */
export function literalPattern(text, ctx) {
    const { nl } = regexAtoms(ctx.newlineToken);
    return String(text).split('\n').map(escapeRegex).join(nl);
}

/**
 * Builds the regex for a parsed prefill.
 *
 * @param {TemplatePart[]} parts  parsed template; `[[pg]]` must already be resolved to text
 * @param {BuildContext} ctx
 * @returns {{
 *   prefix: string,        // regex for the whole forced prefix
 *   hidden: string,        // regex for the part hidden in the final message (before [[keep]], or all of it)
 *   hasKeep: boolean,
 *   hasEnd: boolean,       // [[end]] seen: nothing may follow
 *   literal: string|null,  // the prefix as plain text when it contains no stubs
 *   hiddenLiteral: string|null, // the hidden part as plain text when it contains no stubs
 * }}
 */
export function buildPrefixPattern(parts, ctx) {
    let prefix = '';
    let hidden = '';
    let hasKeep = false;
    let hasEnd = false;
    let literal = '';
    let isLiteral = true;
    let hiddenLiteral = null;
    // [[keep]]: everything before the LAST keep marker is hidden.
    const lastKeep = parts.map(p => p.type === 'stub' && p.name === 'keep').lastIndexOf(true);

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part.type === 'text') {
            prefix += literalPattern(part.text, ctx);
            literal += part.text;
        } else if (part.name === 'keep') {
            if (i === lastKeep) {
                hasKeep = true;
                hidden = prefix;
                hiddenLiteral = isLiteral ? literal : null;
            }
        } else if (part.name === 'end' || part.name === 'stop' || part.name === 'eos') {
            hasEnd = true;
            break;
        } else if (part.name === 'pg') {
            // Unresolved generator slot: contributes nothing.
        } else {
            prefix += stubPattern(part, ctx);
            isLiteral = false;
        }
    }
    if (!hasKeep) {
        hidden = prefix;
        hiddenLiteral = isLiteral ? literal : null;
    }
    return { prefix, hidden, hasKeep, hasEnd, literal: isLiteral ? literal : null, hiddenLiteral };
}

/**
 * Literal text that comes before the first [[pg]] stub, if it contains no other stubs.
 * Used as a prefill hint for the prefill generator.
 * @param {TemplatePart[]} parts
 */
export function literalBeforePg(parts) {
    let text = '';
    for (const part of parts) {
        if (part.type === 'text') text += part.text;
        else if (part.name === 'pg') return text;
        else if (part.name === 'keep') continue;
        else return null;
    }
    return null;
}

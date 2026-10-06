/**
 * Anti-slop: builds a regex (no lookarounds) that matches exactly the strings
 * which do NOT contain any of the banned words, case-insensitively.
 *
 * Construction:
 *   1. Build an Aho-Corasick automaton over the lowercased banned words.
 *   2. Drop every state that recognises a banned word. What is left is a DFA
 *      for the complement language, where every remaining state is accepting.
 *   3. Convert that DFA into a regex with GNFA state elimination, eliminating
 *      the root state last so the result has the shape  LOOP* TAIL.
 *
 * Providers' JSON Schema regex engines generally reject lookaheads, which is
 * why the complement is spelled out explicitly instead of `(?!word)`.
 */

const OTHER = -1; // symbol id for "any character that appears in no banned word"

// ---------------------------------------------------------------------------
// Regex AST helpers
// ---------------------------------------------------------------------------
// Node shapes:
//   { t: 'eps' }
//   { t: 'cls', s: Set<number> }   set of symbol ids
//   { t: 'cat', c: Node[] }
//   { t: 'alt', c: Node[] }
//   { t: 'star', c: Node }
const EPS = Object.freeze({ t: 'eps' });

function cls(symbols) {
    return { t: 'cls', s: new Set(symbols) };
}

function cat(...nodes) {
    const out = [];
    for (const n of nodes) {
        if (!n) return null; // concatenation with the empty language
        if (n.t === 'eps') continue;
        if (n.t === 'cat') out.push(...n.c);
        else out.push(n);
    }
    if (out.length === 0) return EPS;
    if (out.length === 1) return out[0];
    return { t: 'cat', c: out };
}

function alt(a, b) {
    return altAll([a, b]);
}

/** Union of many nodes (null = empty language, skipped). */
function altAll(nodes) {
    const items = [];
    for (const n of nodes) {
        if (!n) continue;
        if (n.t === 'alt') items.push(...n.c);
        else items.push(n);
    }
    if (items.length === 0) return null;
    // Merge every character class into one, dedupe the rest structurally.
    const merged = new Set();
    let hasCls = false;
    const rest = [];
    const seen = new Set();
    for (const n of items) {
        if (n.t === 'cls') {
            hasCls = true;
            n.s.forEach(x => merged.add(x));
        } else {
            const key = keyOf(n);
            if (!seen.has(key)) {
                seen.add(key);
                rest.push(n);
            }
        }
    }
    const all = hasCls ? [cls(merged), ...rest] : rest;
    if (all.length === 1) return all[0];
    return { t: 'alt', c: all };
}

function star(n) {
    if (!n || n.t === 'eps') return EPS;
    if (n.t === 'star') return n;
    // (eps | X)* == X*
    if (n.t === 'alt' && n.c.some(x => x.t === 'eps')) {
        const inner = n.c.filter(x => x.t !== 'eps');
        if (inner.length === 0) return EPS;
        return star(inner.length === 1 ? inner[0] : { t: 'alt', c: inner });
    }
    return { t: 'star', c: n };
}

const keyCache = new WeakMap();
function keyOf(n) {
    if (n.t === 'eps') return 'ε';
    let k = keyCache.get(n);
    if (k !== undefined) return k;
    switch (n.t) {
        case 'cls': k = 'c' + [...n.s].sort((x, y) => x - y).join(','); break;
        case 'cat': k = '(' + n.c.map(keyOf).join('.') + ')'; break;
        case 'alt': k = '(' + n.c.map(keyOf).sort().join('|') + ')'; break;
        case 'star': k = '(' + keyOf(n.c) + ')*'; break;
    }
    keyCache.set(n, k);
    return k;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function escapeClassChar(ch) {
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    if (ch === '\t') return '\\t';
    return /[\\\]\[^\-]/.test(ch) ? '\\' + ch : ch;
}

class Renderer {
    /**
     * @param {string[][]} symbolChars chars (all case variants) for each symbol id
     */
    constructor(symbolChars) {
        this.symbolChars = symbolChars;
        this.allSymbols = symbolChars.map((_, i) => i);
        this.cache = new WeakMap();
    }

    renderCls(set) {
        if (set.has(OTHER)) {
            // Negated class: everything except the word-chars NOT in the set.
            const excluded = this.allSymbols.filter(i => !set.has(i));
            if (excluded.length === 0) return '[\\s\\S]';
            return '[^' + excluded.flatMap(i => this.symbolChars[i]).map(escapeClassChar).join('') + ']';
        }
        const chars = [...set].sort((a, b) => a - b).flatMap(i => this.symbolChars[i]);
        if (chars.length === 1) {
            const ch = chars[0];
            if (ch === '\n') return '\\n';
            if (ch === '\r') return '\\r';
            if (ch === '\t') return '\\t';
            return /[.*+?^${}()|[\]\\\/]/.test(ch) ? '\\' + ch : ch;
        }
        return '[' + chars.map(escapeClassChar).join('') + ']';
    }

    /** @returns {{ s: string, atom: boolean, alt: boolean }} */
    render(n) {
        // Subtrees are shared (memoised builders), so cache their rendering.
        let r = this.cache.get(n);
        if (!r) {
            r = this.renderUncached(n);
            if (n.t !== 'eps') this.cache.set(n, r);
        }
        return r;
    }

    renderUncached(n) {
        switch (n.t) {
            case 'eps': return { s: '', atom: true, alt: false };
            case 'cls': return { s: this.renderCls(n.s), atom: true, alt: false };
            case 'star': {
                const inner = this.render(n.c);
                return { s: (inner.atom ? inner.s : `(?:${inner.s})`) + '*', atom: false, alt: false };
            }
            case 'cat': {
                const s = n.c.map(x => {
                    const r = this.render(x);
                    return r.alt ? `(?:${r.s})` : r.s;
                }).join('');
                return { s, atom: false, alt: false };
            }
            case 'alt': {
                const hasEps = n.c.some(x => x.t === 'eps');
                const parts = n.c.filter(x => x.t !== 'eps').map(x => this.render(x).s);
                if (hasEps) {
                    if (parts.length === 1) {
                        const r = this.render(n.c.find(x => x.t !== 'eps'));
                        return { s: (r.atom ? r.s : `(?:${r.s})`) + '?', atom: false, alt: false };
                    }
                    return { s: `(?:${parts.join('|')})?`, atom: false, alt: false };
                }
                return { s: parts.join('|'), atom: false, alt: true };
            }
        }
        throw new Error('bad node');
    }

    toString(n, wrap = false) {
        const r = this.render(n);
        if (wrap && !r.atom) return `(?:${r.s})`;
        return r.s;
    }
}

// ---------------------------------------------------------------------------
// Automaton
// ---------------------------------------------------------------------------

/**
 * Splits a string into code points (so astral chars like emoji stay whole).
 */
function chars(str) {
    return Array.from(str);
}

function lowerChar(ch) {
    const l = ch.toLowerCase();
    return Array.from(l).length === 1 ? l : ch;
}

function caseVariants(ch) {
    const out = new Set([ch]);
    const u = ch.toUpperCase();
    const l = ch.toLowerCase();
    if (Array.from(u).length === 1) out.add(u);
    if (Array.from(l).length === 1) out.add(l);
    return [...out];
}

/**
 * Normalises the banned word list: trims, drops blanks and duplicates, and
 * drops words that contain another banned word (they are redundant).
 * @param {string[]|string} words
 * @returns {string[]}
 */
export function normalizeBannedWords(words) {
    const list = (Array.isArray(words) ? words : String(words ?? '').split(/\r?\n/))
        .map(w => chars(String(w).trim()).map(lowerChar).join(''))
        .filter(w => w.length > 0);
    const unique = [...new Set(list)];
    return unique.filter(w => !unique.some(o => o !== w && w.includes(o)));
}

/**
 * Builds the automaton shared by the regex builders.
 */
function buildAutomaton(words) {
    const symbolOf = new Map();
    const symbolChars = [];
    for (const w of words) {
        for (const ch of chars(w)) {
            if (!symbolOf.has(ch)) {
                symbolOf.set(ch, symbolChars.length);
                symbolChars.push(caseVariants(ch));
            }
        }
    }
    const symbols = [...symbolChars.keys(), OTHER];

    // Trie
    const next = [new Map()];
    const terminal = [false];
    for (const w of words) {
        let s = 0;
        for (const ch of chars(w)) {
            const sym = symbolOf.get(ch);
            if (!next[s].has(sym)) {
                next.push(new Map());
                terminal.push(false);
                next[s].set(sym, next.length - 1);
            }
            s = next[s].get(sym);
        }
        terminal[s] = true;
    }

    // Aho-Corasick failure links + full transition function
    const n = next.length;
    const fail = new Array(n).fill(0);
    const dead = terminal.slice();
    const delta = Array.from({ length: n }, () => new Map());
    const queue = [];
    for (const sym of symbols) {
        const t = next[0].get(sym);
        if (t !== undefined) {
            delta[0].set(sym, t);
            queue.push(t);
        } else {
            delta[0].set(sym, 0);
        }
    }
    while (queue.length) {
        const s = queue.shift();
        dead[s] = dead[s] || dead[fail[s]];
        for (const sym of symbols) {
            const t = next[s].get(sym);
            if (t !== undefined) {
                fail[t] = delta[fail[s]].get(sym);
                delta[s].set(sym, t);
                queue.push(t);
            } else {
                delta[s].set(sym, delta[fail[s]].get(sym));
            }
        }
    }
    return { symbols, symbolChars, next, delta, dead };
}

/**
 * Regex construction with bounded tracking depth.
 *
 * An exact DFA-to-regex conversion explodes (roughly 10x per extra word),
 * because a partial match of one word can hand over to a partial match of
 * any other word. Here the automaton is unrolled into "levels": a walk starts
 * at the root on level 0, and every time a partial match hands over to a new
 * partial match (instead of extending or resetting to the root) the level goes
 * up by one. Within a level the walk is a tree, so it converts to a compact
 * regex. Past `maxLevel` a hand-over is treated as a reset.
 *
 * Consequence: a banned word is always blocked, except when it is glued
 * directly onto more than `maxLevel` chained fragments of banned words
 * (e.g. with maxLevel=1, banning "tapestry" and "ozone", the string "toozone"
 * slips through). Every rejected string really contains a banned word.
 */
function buildLevelled(auto, maxLevel) {
    const { symbols, next, delta, dead } = auto;

    // Classify every outgoing transition of state v.
    const edgeCache = new Map();
    function edges(v) {
        if (edgeCache.has(v)) return edgeCache.get(v);
        const children = new Map(); // childState -> symbols
        const resets = [];
        const fresh = new Map(); // targetState -> symbols
        const childStates = new Set(next[v].values());
        for (const sym of symbols) {
            const t = delta[v].get(sym);
            if (dead[t]) continue;
            if (t === 0) resets.push(sym);
            else if (childStates.has(t)) {
                if (!children.has(t)) children.set(t, []);
                children.get(t).push(sym);
            } else {
                if (!fresh.has(t)) fresh.set(t, []);
                fresh.get(t).push(sym);
            }
        }
        const e = { children, resets, fresh };
        edgeCache.set(v, e);
        return e;
    }

    // Targets reachable by a hand-over from the in-level tree under v.
    function freshTargets(v, acc = new Set()) {
        const { children, fresh } = edges(v);
        fresh.forEach((_, t) => acc.add(t));
        children.forEach((_, c) => freshTargets(c, acc));
        return acc;
    }

    // Paths inside the level tree from v that end by stepping to `target`
    // ('root' = reset). At the top level, hand-overs count as resets.
    const pathMemo = new Map();
    function paths(v, target, level) {
        const memoKey = v + ':' + target + ':' + (target === 'root' && level >= maxLevel ? 'top' : '');
        if (pathMemo.has(memoKey)) return pathMemo.get(memoKey);
        const result = pathsUncached(v, target, level);
        pathMemo.set(memoKey, result);
        return result;
    }
    function pathsUncached(v, target, level) {
        const { children, resets, fresh } = edges(v);
        const syms = [];
        if (target === 'root') {
            syms.push(...resets);
            if (level >= maxLevel) fresh.forEach(s => syms.push(...s));
        } else if (fresh.has(target)) {
            syms.push(...fresh.get(target));
        }
        const items = [syms.length ? cls(syms) : null];
        for (const [c, s] of children) {
            const sub = paths(c, target, level);
            if (sub) items.push(cat(cls(s), sub));
        }
        return altAll(items);
    }

    // Paths inside the level tree from v that simply stop (end of string).
    const prefixMemo = new Map();
    function prefixes(v) {
        if (prefixMemo.has(v)) return prefixMemo.get(v);
        const result = prefixesUncached(v);
        prefixMemo.set(v, result);
        return result;
    }
    function prefixesUncached(v) {
        const { children } = edges(v);
        const items = [EPS];
        for (const [c, s] of children) items.push(cat(cls(s), prefixes(c)));
        return altAll(items);
    }

    const rMemo = new Map();
    // Strings that start in state v on `level` and return to the root.
    function R(v, level) {
        const key = v + ':' + level;
        if (rMemo.has(key)) return rMemo.get(key);
        const items = [paths(v, 'root', level)];
        if (level < maxLevel) {
            for (const t of freshTargets(v)) {
                const p = paths(v, t, level);
                const r = R(t, level + 1);
                if (p && r) items.push(cat(p, r));
            }
        }
        const node = altAll(items);
        rMemo.set(key, node);
        return node;
    }

    const eMemo = new Map();
    // Strings that start in state v on `level` and end without returning.
    function E(v, level) {
        const key = v + ':' + level;
        if (eMemo.has(key)) return eMemo.get(key);
        const items = [prefixes(v)];
        if (level < maxLevel) {
            for (const t of freshTargets(v)) {
                const p = paths(v, t, level);
                if (p) items.push(cat(p, E(t, level + 1)));
            }
        }
        const node = altAll(items);
        eMemo.set(key, node);
        return node;
    }

    return { loop: R(0, 0), tail: E(0, 0) };
}

/**
 * Reference implementation of the levelled semantics, used by tests:
 * returns true when `text` is accepted by the pattern built with `maxLevel`.
 * @param {string[]} bannedWords
 * @param {number} maxLevel
 * @param {string} text
 */
export function simulateAntiSlop(bannedWords, maxLevel, text) {
    const words = normalizeBannedWords(bannedWords);
    if (words.length === 0) return true;
    const auto = buildAutomaton(words);
    const symbolOfChar = new Map();
    auto.symbolChars.forEach((variants, i) => variants.forEach(ch => symbolOfChar.set(ch, i)));
    let v = 0;
    let level = 0;
    for (const ch of chars(text)) {
        const sym = symbolOfChar.has(ch) ? symbolOfChar.get(ch) : OTHER;
        const t = auto.delta[v].get(sym);
        if (auto.dead[t]) return false;
        const isChild = [...auto.next[v].values()].includes(t);
        if (t === 0) {
            v = 0; level = 0;
        } else if (isChild) {
            v = t;
        } else if (level < maxLevel) {
            v = t; level += 1;
        } else {
            v = 0; level = 0;
        }
    }
    return true;
}

/** Patterns longer than this make providers unhappy; trade tracking depth for size. */
export const ANTI_SLOP_SIZE_BUDGET = 8000;
const MAX_TRACKING_LEVEL = 3;

/**
 * Builds the complement regex parts.
 * @param {string[]|string} bannedWords
 * @param {{ budget?: number, maxLevel?: number }} [options]
 * @returns {{ loop: string, tail: string, level: number, words: string[] } | null} null when there are no words
 */
export function buildAntiSlopParts(bannedWords, options = {}) {
    const words = normalizeBannedWords(bannedWords);
    if (words.length === 0) return null;
    const budget = options.budget ?? ANTI_SLOP_SIZE_BUDGET;
    const auto = buildAutomaton(words);
    const renderer = new Renderer(auto.symbolChars);

    const build = (level) => {
        const { loop, tail } = buildLevelled(auto, level);
        return {
            loop: renderer.toString(loop, true),
            tail: renderer.toString(tail ?? EPS, true),
            level,
            words,
        };
    };
    if (options.maxLevel !== undefined) return build(options.maxLevel);

    // Grow the tracking depth while the pattern stays within budget.
    let result = build(0);
    for (let level = 1; level <= MAX_TRACKING_LEVEL; level++) {
        const candidate = build(level);
        if (candidate.loop.length + candidate.tail.length > budget) break;
        result = candidate;
    }
    return result;
}

/**
 * Builds the regex fragment for "free text, at least `minChars` characters,
 * containing none of the banned words".
 *
 * Without banned words this is exactly `[\s\S]{min,}`. With banned words the
 * minimum is enforced as a minimum number of loop iterations; every iteration
 * consumes at least one character, so the output is always >= minChars long.
 *
 * @param {string[]|string} bannedWords
 * @param {number} minChars
 * @param {{ budget?: number, maxLevel?: number }} [options]
 * @returns {string}
 */
export function buildFreeTextPattern(bannedWords, minChars = 0, options = {}) {
    const min = Math.max(0, Math.floor(Number(minChars) || 0));
    const parts = buildAntiSlopParts(bannedWords, options);
    if (!parts) {
        return min > 0 ? `[\\s\\S]{${min},}` : '[\\s\\S]*';
    }
    const quant = min > 0 ? `{${min},}` : '*';
    // The loop always contains at least one single-character branch, so it is never empty.
    return `${parts.loop}${quant}${parts.tail}`;
}

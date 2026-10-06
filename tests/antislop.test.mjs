import { buildFreeTextPattern, buildAntiSlopParts, simulateAntiSlop } from '../lib/antislop.js';
import assert from 'node:assert';

function randStr(alphabet, len) {
    let s = '';
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s;
}

const cases = [
    ['ozone'],
    ['gaze'],
    ['aa'],
    ['abab', 'bab'],
    ['ozone', 'elara', 'luminous', 'tapestry', '—', 'firmament'],
    ['shiver', 'spine', 'testament', 'barely above a whisper', 'ministrations', 'smirk', 'ozone', 'gaze'],
];

for (const words of cases) {
    const lower = words.map(w => w.toLowerCase());
    const alphabet = [...new Set([...words.join('').toLowerCase(), ...words.join('').toUpperCase(), 'x', ' ', '\n'])];
    for (const level of [0, 1, 2]) {
        const parts = buildAntiSlopParts(words, { maxLevel: level });
        const re = new RegExp('^(?:' + parts.loop + ')*' + parts.tail + '$', 'u');
        for (let i = 0; i < 4000; i++) {
            const s = randStr(alphabet, Math.floor(Math.random() * 14));
            const contains = lower.some(w => s.toLowerCase().includes(w));
            const got = re.test(s);
            // The regex implements exactly the levelled semantics.
            assert.strictEqual(got, simulateAntiSlop(words, level, s), `level=${level} words=${words} s=${JSON.stringify(s)}`);
            // It never rejects clean text.
            if (!contains) assert.strictEqual(got, true, `clean text rejected: ${JSON.stringify(s)}`);
        }
        // A banned word that is not glued onto another banned fragment is always blocked.
        for (const w of words) {
            assert.strictEqual(re.test('hello ' + w.toUpperCase() + ' there'), false, `${w} leaked`);
            assert.strictEqual(re.test('the ' + w + '.'), false, `${w} leaked`);
            assert.strictEqual(re.test('hello ' + w.slice(0, -1) + ' there'), true);
        }
    }
    const auto = buildAntiSlopParts(words);
    console.log(`${words.length} word(s): auto level ${auto.level}, pattern length ${auto.loop.length + auto.tail.length}`);
}

// Gluing: with level >= 1, a word right after a fragment of itself is still blocked.
{
    const parts = buildAntiSlopParts(['ozone'], { maxLevel: 1 });
    const re = new RegExp('^(?:' + parts.loop + ')*' + parts.tail + '$');
    assert.strictEqual(re.test('oozone'), false);
    assert.strictEqual(re.test('ozozone'), false);
}

// min-length: strings shorter than min never match, long clean strings match
{
    const p = buildFreeTextPattern(['ozone'], 10);
    const re = new RegExp('^' + p + '$');
    assert.strictEqual(re.test('short'), false);
    assert.strictEqual(re.test('a long enough clean sentence'), true);
    assert.strictEqual(re.test('a long enough sentence with ozone'), false);
}
assert.strictEqual(buildFreeTextPattern([], 5), '[\\s\\S]{5,}');
assert.strictEqual(buildFreeTextPattern('', 0), '[\\s\\S]*');

// Large lists stay within budget and build quickly.
{
    const many = ['shiver', 'spine', 'testament', 'barely above a whisper', 'ministrations', 'smirk', 'ozone', 'gaze',
        'tapestry', 'elara', 'luminous', '—', 'firmament', 'delve', 'palpable', 'kaleidoscope', 'symphony', 'unspoken'];
    const t = Date.now();
    const parts = buildAntiSlopParts(many);
    assert.ok(Date.now() - t < 2000, 'too slow');
    assert.ok(parts.loop.length + parts.tail.length < 10000, 'too large');
}
console.log('antislop ok');

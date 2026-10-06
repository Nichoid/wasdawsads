import assert from 'node:assert';
import { parseTemplate, stubPattern, numberRangePattern } from '../lib/template.js';
import { planPrefill, planContinue } from '../lib/plan.js';

const settings = { hidePrefill: true, minChars: 5, newlineToken: '\\n', overlapChars: 10, bannedWords: '' };
const match = (pattern, s) => new RegExp(pattern).test(s);
const ctx = { newlineToken: '\\n', names: ['Alice', 'Bob Smith'] };
const full = (stub) => '^' + stubPattern(parseTemplate(stub)[0], ctx) + '$';

// --- individual stubs ---
assert.ok(match(full('[[w:2]]'), 'two words'));
assert.ok(!match(full('[[w:2]]'), 'three words here'));
assert.ok(match(full('[[w:2-5]]'), 'a b c d e'));
assert.ok(!match(full('[[w:2-5]]'), 'a'));
assert.ok(!match(full('[[words:2-5]]'), 'a b c d e f'));
assert.ok(match(full('[[opt:yes|no|maybe]]'), 'maybe'));
assert.ok(!match(full('[[opt:yes|no|maybe]]'), 'perhaps'));
assert.ok(match(full('[[re:/[A-Z]{3}/i]]'), 'ABC'));
assert.ok(match(full('[[free]]'), 'anything\nat all'));
assert.ok(!match(full('[[free]]'), ''));
assert.ok(match(full('[[emotion]]'), 'flustered'));
assert.ok(match(full('[[mood]]'), 'Nervous'));
assert.ok(!match(full('[[emotion]]'), 'hungry'));
assert.ok(match(full('[[line]]'), 'one line only'));
assert.ok(!match(full('[[line]]'), 'two\nlines'));
assert.ok(!match(full('[[line]]'), 'two\\nlines'), 'newline token cannot hide inside a line');
assert.ok(match(full('[[lines:2-4]]'), 'a\nb\nc'));
assert.ok(match(full('[[lines:2-4]]'), 'a\\nb'), 'token works as newline');
assert.ok(!match(full('[[lines:2-4]]'), 'a'));
assert.ok(!match(full('[[lines:2-4]]'), 'a\nb\nc\nd\ne'));
assert.ok(match(full('[[name]]'), 'Bob Smith'));
assert.ok(!match(full('[[name]]'), 'Carol'));
assert.ok(match('^' + stubPattern({ name: 'name', arg: '' }, { newlineToken: '', names: [] }) + '$', 'Carol'));
assert.ok(match(full('[[action]]'), 'leans against the wall'));
assert.ok(!match(full('[[action]]'), 'says "hi"'));
assert.ok(!match(full('[[action]]'), 'one two three four five six seven'));
assert.ok(match(full('[[thought]]'), 'why is he here'));
assert.ok(!match(full('[[thought]]'), 'why (is) he here'));
assert.ok(match(full('[[num]]'), '-42'));
assert.ok(match(full('[[number:1-100]]'), '100'));
assert.ok(!match(full('[[number:1-100]]'), '0'));
assert.ok(match(full('[[number:0-100]]'), '0'));
for (let i = -5; i <= 40; i++) assert.strictEqual(match('^' + numberRangePattern(1, 20) + '$', String(i)), i >= 1 && i <= 20);
assert.ok(match('^' + numberRangePattern(0, 5000) + '$', '4999'));
assert.ok(!match('^' + numberRangePattern(0, 5000) + '$', '012'));
assert.ok(!match('^' + numberRangePattern(100, 5000) + '$', '12'));

// unknown stubs stay literal
assert.deepStrictEqual(parseTemplate('a [[unknown]] b'), [{ type: 'text', text: 'a [[unknown]] b' }]);

// --- thinking block example from the README ---
const thinking = `<thinking>
**what just happened**
- last response ended with: [[w:6-35]]
- emotional carryover: [[w:3-20]]

**pick one**
going with: option [[opt:A|B|C]]
why: [[w:8-40]]
</thinking>

[here is my response:]`;
{
    const plan = planPrefill({ settings, template: thinking });
    const good = `<thinking>
**what just happened**
- last response ended with: she slammed the door and walked out
- emotional carryover: anger and some regret
\\n**pick one**
going with: option B
why: it keeps the tension high and gives him a reason to follow
</thinking>

[here is my response:] He stood there for a long moment.`;
    assert.ok(match(plan.pattern, good), 'thinking example should match');
    assert.ok(!match(plan.pattern, good.replace('option B', 'option D')));
    assert.ok(!match(plan.pattern, good.replace('anger and some regret', 'anger')), 'too few words');
    // The pattern must not contain literal newlines.
    assert.ok(!plan.pattern.includes('\n'));
}

// --- status block + [[end]] ---
{
    const plan = planPrefill({ settings, template: '[STATUS]\n- mood: [[emotion]]\n- hp: [[number:0-100]]\n[[end]]' });
    assert.ok(match(plan.pattern, '[STATUS]\n- mood: tense\n- hp: 42\n'));
    assert.ok(!match(plan.pattern, '[STATUS]\n- mood: tense\n- hp: 42\nand more text'), '[[end]] forbids continuation');
}

// --- min chars + banned words ---
{
    const plan = planPrefill({ settings: { ...settings, minChars: 10, bannedWords: 'ozone\nElara' }, template: 'She said' });
    assert.ok(match(plan.pattern, 'She said nothing at all for a while.'));
    assert.ok(!match(plan.pattern, 'She said hi'));
    assert.ok(!match(plan.pattern, 'She said the air smelled of OZONE today.'));
    assert.ok(!match(plan.pattern, 'She said elara was coming soon.'));
}

// --- empty prefill with banned words only ---
{
    const plan = planPrefill({ settings: { ...settings, minChars: 0, bannedWords: 'tapestry' }, template: '' });
    assert.ok(match(plan.pattern, 'A rich story.'));
    assert.ok(!match(plan.pattern, 'A rich tapestry.'));
}

// --- continue ---
{
    const plan = planContinue({ settings, existingText: 'He reached for the han' });
    assert.strictEqual(plan.job.overlapText, 'or the han');
    assert.ok(match(plan.pattern, 'or the handle and pulled.'));
    assert.ok(!match(plan.pattern, 'Something else entirely.'));
}
console.log('template ok');

import { describe, expect, it } from 'vitest';
import { aggregate, makeRunner, parseRead, readTable } from './read.js';

describe('parseRead', () => {
  it('takes the last valid verdict object, fenced or bare', () => {
    const reply = [
      'Thinking about it: {"rating": 5, "verdict": "nope"}',
      '```json',
      '{"rating": 72.4, "verdict": "rewrite-as-contract", "bug": "none", "refactor": "rename", "symptom": "x", "confidence": "high", "notes": "n"}',
      '```',
    ].join('\n');
    expect(parseRead(reply)).toEqual({
      rating: 72,
      verdict: 'rewrite-as-contract',
      bug: 'none',
      refactor: 'rename',
      symptom: 'x',
      confidence: 'high',
      notes: 'n',
    });
    expect(parseRead('{"rating": 140, "verdict": "keep"}').rating).toBe(100);
    expect(parseRead('{"rating": 10, "verdict": "keep", "confidence": "wild"}').confidence).toBe(
      'medium',
    );
    expect(parseRead('{"rating": 40, "verdict": "investigate"}').verdict).toBe('investigate');
    expect(() => parseRead('no json here')).toThrow(/no verdict/);
  });
});

describe('aggregate', () => {
  const read = (rating: number, verdict: 'keep' | 'delete' | 'fold') => ({
    rating,
    verdict,
    bug: '',
    refactor: '',
    symptom: '',
    confidence: 'medium' as const,
    notes: '',
  });
  it('takes the median rating and the majority verdict, investigating ties', () => {
    expect(aggregate([])).toEqual({ rating: null, verdict: null, disagree: false });
    expect(aggregate([read(10, 'keep'), read(80, 'delete'), read(30, 'keep')])).toEqual({
      rating: 30,
      verdict: 'keep',
      disagree: true,
    });
    expect(aggregate([read(20, 'keep'), read(40, 'delete')])).toEqual({
      rating: 30,
      verdict: 'investigate',
      disagree: true,
    });
    expect(aggregate([read(20, 'keep'), read(25, 'keep')])).toEqual({
      rating: 23,
      verdict: 'keep',
      disagree: false,
    });
  });
});

describe('makeRunner', () => {
  it('builds the presets and unwraps the claude envelope', () => {
    const claude = makeRunner('claude', 'opus', undefined);
    expect(claude.args).toEqual(['-p', '--output-format', 'json', '--model', 'opus']);
    expect(claude.extract('{"result":"{\\"rating\\":1}"}')).toBe('{"rating":1}');
    expect(claude.extract('not json')).toBe('not json');
    const codex = makeRunner('codex', 'gpt-5.5', undefined);
    expect(codex.command).toBe('codex');
    expect(codex.args).toContain('-m');
    const custom = makeRunner('claude', undefined, 'my-tool --flag');
    expect(custom).toMatchObject({ command: 'sh', args: ['-c', 'my-tool --flag'] });
  });
});

describe('readTable', () => {
  it('renders one row per file with disagreement marked', () => {
    const table = readTable([
      {
        file: 'a.test.ts',
        score: 40,
        finding: 'review',
        reasons: [],
        reads: [
          {
            rating: 50,
            verdict: 'fold',
            bug: 'off | by one',
            refactor: 'rename',
            symptom: '',
            confidence: 'high',
            notes: '',
          },
        ],
        rating: 50,
        verdict: 'fold',
        disagree: true,
        errors: [],
      },
    ]);
    expect(table).toContain(
      '| 40 | review | 50 ± | fold | `a.test.ts` | off \\| by one | rename |',
    );
  });
});

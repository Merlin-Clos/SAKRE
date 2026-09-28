import { expect, test } from 'bun:test';
import { collectRoutedModelIds, resolveModelRoute } from '../../src/review/agents';
import { validateUserReviewConfig } from '../../src/config/validation';

test('preserves per-tier variants while the default route has no overlay', () => {
    const config = {
        provider: 'opencode',
        model: 'global#default',
        models: { routing: { security: { default: 'agent#fast', hard: 'agent#precise' } } }
    };

    expect(resolveModelRoute(config, 'security', 'hard')).toEqual({
        provider: 'opencode',
        model: 'agent',
        variant: 'precise'
    });
    expect(resolveModelRoute(config, 'security', 'lite')).toEqual({
        provider: 'opencode',
        model: 'agent',
        variant: 'fast'
    });
    expect(resolveModelRoute(config, 'correctness', 'lite')).toEqual({ provider: 'opencode', model: 'global' });
    expect(collectRoutedModelIds(config)).toEqual(['agent', 'global']);
});

test('rejects malformed variant refs without inventing variant names', () => {
    expect(() => validateUserReviewConfig({ model: 'model#' })).toThrow('empty variant');
    expect(() => validateUserReviewConfig({ models: { routing: { security: { hard: 'model#bad#ref' } } } })).toThrow(
        'models.routing.security.hard'
    );
    expect(() => validateUserReviewConfig({ model: '   ' })).toThrow('must not be blank');
    expect(() => validateUserReviewConfig({ models: { routing: { security: { hard: '   #v' } } } })).toThrow(
        'empty model id'
    );
    expect(() => validateUserReviewConfig({ model: 'm#   ' })).toThrow('blank variant');
    expect(validateUserReviewConfig({ model: 'model#arbitrary-overlay' }).model).toBe('model#arbitrary-overlay');
});

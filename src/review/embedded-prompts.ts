import conventions from '../../defaults/prompts/conventions.md' with { type: 'text' };
import coordinator from '../../defaults/prompts/coordinator.md' with { type: 'text' };
import correctness from '../../defaults/prompts/correctness.md' with { type: 'text' };
import maintainability from '../../defaults/prompts/maintainability.md' with { type: 'text' };
import performance from '../../defaults/prompts/performance.md' with { type: 'text' };
import security from '../../defaults/prompts/security.md' with { type: 'text' };
import shared from '../../defaults/prompts/shared.md' with { type: 'text' };
import tests from '../../defaults/prompts/tests.md' with { type: 'text' };
import verifier from '../../defaults/prompts/verifier.md' with { type: 'text' };

const embeddedPrompts = {
    shared,
    correctness,
    security,
    performance,
    conventions,
    maintainability,
    tests,
    coordinator,
    verifier
} as const;

export { embeddedPrompts };

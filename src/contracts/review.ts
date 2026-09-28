import { z } from 'zod';
import { isReviewMapBoundary, type ReviewMap } from '../intelligence/schema';

const reviewSeverities = ['Blocker', 'Important', 'Minor'] as const;

const reviewStatuses = ['complete', 'incomplete', 'stale'] as const;

const reviewVerdicts = ['clean', 'comments', 'changes_required'] as const;

const verificationStates = ['confirmed', 'rejected', 'unverified'] as const;

const reviewCategories = [
    'correctness',
    'security',
    'performance',
    'maintainability',
    'conventions',
    'documentation'
] as const;

const reviewFailureKinds = [
    'provider-auth',
    'rate-limit',
    'timeout',
    'cancelled',
    'deadline-exceeded',
    'invalid-output',
    'runtime-failure',
    'unknown'
] as const;

const severitySchema = z.enum(reviewSeverities);

const reviewStatusSchema = z.enum(reviewStatuses);

const reviewVerdictSchema = z.enum(reviewVerdicts);

const verificationStateSchema = z.enum(verificationStates);

const reviewCategorySchema = z.enum(reviewCategories);

const reviewFailureKindSchema = z.enum(reviewFailureKinds);

const findingLocationSchema = z
    .strictObject({
        file: z.string().min(1),
        line: z.int().min(1).optional(),
        lineEnd: z.int().min(1).optional()
    })
    .superRefine((location, ctx) => {
        if (location.lineEnd !== undefined && location.line === undefined) {
            ctx.addIssue({
                code: 'custom',
                path: ['lineEnd'],
                message: 'lineEnd requires line to be provided.'
            });

            return;
        }

        if (location.lineEnd !== undefined && location.line !== undefined && location.lineEnd < location.line) {
            ctx.addIssue({
                code: 'custom',
                path: ['lineEnd'],
                message: 'lineEnd must be greater than or equal to line.'
            });
        }
    });

/* Pipeline adds id, fingerprint, provenance, and verification state. Impact and
evidence stay required; suggestedFix stays optional; category stays internal. */
const candidateFindingSchema = z.strictObject({
    severity: severitySchema,
    category: reviewCategorySchema,
    title: z.string().min(1),
    impact: z.string().min(1),
    evidence: z.string().min(1),
    location: findingLocationSchema.optional(),
    suggestedFix: z.string().min(1).optional()
});

const candidateFindingListSchema = z.array(candidateFindingSchema);

const agentOutputSchema = z.strictObject({
    summary: z.string().min(1),
    findings: candidateFindingListSchema,
    usedContext7: z.boolean(),
    context7Topics: z.array(z.string().min(1))
});

/* Every coordinator finding must reference the stable id of the candidate it
comes from: provenance survives deduplication. */
const coordinatorFindingSchema = candidateFindingSchema.extend({
    sourceIds: z.array(z.string().min(1)).min(1)
});

const coordinatorOutputSchema = z.strictObject({
    summary: z.string().min(1),
    findings: z.array(coordinatorFindingSchema)
});

const verifierOutputSchema = z.strictObject({
    findingId: z.string().min(1),
    state: z.enum(['confirmed', 'rejected']),
    reason: z.string().min(1)
});

/* Candidate materialized by the pipeline: stable id, fingerprint, and
provenance added after agent output validation. */
const materializedFindingSchema = candidateFindingSchema.extend({
    id: z.string().min(1),
    fingerprint: z.string().min(1),
    sourceAgents: z.array(z.string().min(1))
});

const verificationSchema = z.strictObject({
    state: verificationStateSchema,
    reason: z.string().min(1).optional(),
    verifiedBy: z.string().min(1).optional()
});

/* Final published finding: stable identifier, fingerprint, provenance, and
verification always present. */
const findingSchema = candidateFindingSchema.extend({
    id: z.string().min(1),
    fingerprint: z.string().min(1),
    sourceAgents: z.array(z.string().min(1)),
    verification: verificationSchema
});

const findingListSchema = z.array(findingSchema);

/* Produced by the deterministic pre-pass, never from external input. Boundary
check defers to the ReviewMap module instead of duplicating the map shape. */
const reviewIntelligenceSchema = z.custom<ReviewMap>((value) => isReviewMapBoundary(value));

const reviewFailureSchema = z.strictObject({
    kind: reviewFailureKindSchema,
    stage: z.string().min(1),
    message: z.string().min(1)
});

const reviewBaseFields = {
    /* Deterministic risk/route diagnostic, not a human review summary: it is
       rendered as collapsed provenance, never as the review's headline. */
    riskSummary: z.string(),
    riskTier: z.enum(['lite', 'standard', 'hard']),
    reviewedHeadSha: z.string().min(1),
    findings: findingListSchema,
    intelligence: reviewIntelligenceSchema.optional()
} as const;

/* Only complete reviews carry a verdict; incomplete and stale force null. */
const completeReviewResultSchema = z.strictObject({
    ...reviewBaseFields,
    status: z.literal('complete'),
    verdict: reviewVerdictSchema
});

const incompleteReviewResultSchema = z.strictObject({
    ...reviewBaseFields,
    status: z.literal('incomplete'),
    verdict: z.null(),
    unverifiedFindings: findingListSchema,
    failures: z.array(reviewFailureSchema).min(1)
});

const staleReviewResultSchema = z.strictObject({
    ...reviewBaseFields,
    status: z.literal('stale'),
    verdict: z.null(),
    currentHeadSha: z.string().min(1),
    unverifiedFindings: findingListSchema,
    failures: z.array(reviewFailureSchema)
});

const reviewResultSchema = z
    .discriminatedUnion('status', [completeReviewResultSchema, incompleteReviewResultSchema, staleReviewResultSchema])
    .superRefine((result, ctx) => {
        if (result.status === 'stale' && result.currentHeadSha === result.reviewedHeadSha) {
            ctx.addIssue({
                code: 'custom',
                path: ['currentHeadSha'],
                message: 'A stale review must reference a currentHeadSha different from reviewedHeadSha.'
            });
        }
    });

/* Strict parsers: external data is validated at runtime, never cast. Zod
errors expose the precise path of the faulty field. */
function parseCandidateFindings(value: unknown): z.infer<typeof candidateFindingListSchema> {
    return candidateFindingListSchema.parse(value);
}

function parseAgentOutput(value: unknown): z.infer<typeof agentOutputSchema> {
    return agentOutputSchema.parse(value);
}

function parseCoordinatorOutput(value: unknown): CoordinatorOutput {
    return coordinatorOutputSchema.parse(value);
}

function parseVerifierOutput(value: unknown): VerifierOutput {
    return verifierOutputSchema.parse(value);
}

/* Retryable kinds: only transient transport failures. An authentication
error, a cancellation, or an invalid output is never retried. */
function isRetryableKind(kind: ReviewFailureKind): boolean {
    return kind === 'rate-limit' || kind === 'timeout' || kind === 'runtime-failure';
}

function parseReviewResult(value: unknown): ReviewResult {
    return reviewResultSchema.parse(value);
}

/* OpenCode contracts: the JSON Schema sent to the model and the response
validation come from the same source, so they cannot diverge. */
function agentOutputJsonSchema(): Record<string, unknown> {
    return z.toJSONSchema(agentOutputSchema);
}

function coordinatorOutputJsonSchema(): Record<string, unknown> {
    return z.toJSONSchema(coordinatorOutputSchema);
}

function verifierOutputJsonSchema(): Record<string, unknown> {
    return z.toJSONSchema(verifierOutputSchema);
}

type Severity = z.infer<typeof severitySchema>;

type ReviewStatus = z.infer<typeof reviewStatusSchema>;

type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

type VerificationState = z.infer<typeof verificationStateSchema>;

type ReviewCategory = z.infer<typeof reviewCategorySchema>;

type ReviewFailureKind = z.infer<typeof reviewFailureKindSchema>;

type FindingLocation = z.infer<typeof findingLocationSchema>;

type CandidateFinding = z.infer<typeof candidateFindingSchema>;

type AgentOutput = z.infer<typeof agentOutputSchema>;

type CoordinatorOutput = z.infer<typeof coordinatorOutputSchema>;

type CoordinatorFinding = z.infer<typeof coordinatorFindingSchema>;

type MaterializedFinding = z.infer<typeof materializedFindingSchema>;

type VerifierOutput = z.infer<typeof verifierOutputSchema>;

type VerifiedFinding = z.infer<typeof findingSchema>;

type ReviewFailure = z.infer<typeof reviewFailureSchema>;

type ReviewResult =
    | z.infer<typeof completeReviewResultSchema>
    | z.infer<typeof incompleteReviewResultSchema>
    | z.infer<typeof staleReviewResultSchema>;

export type {
    AgentOutput,
    CandidateFinding,
    CoordinatorFinding,
    MaterializedFinding,
    CoordinatorOutput,
    VerifierOutput,
    FindingLocation,
    ReviewCategory,
    ReviewFailure,
    ReviewFailureKind,
    ReviewResult,
    ReviewStatus,
    ReviewVerdict,
    Severity,
    VerifiedFinding,
    VerificationState
};

export {
    agentOutputJsonSchema,
    agentOutputSchema,
    candidateFindingListSchema,
    candidateFindingSchema,
    coordinatorOutputJsonSchema,
    coordinatorOutputSchema,
    findingLocationSchema,
    findingSchema,
    isRetryableKind,
    materializedFindingSchema,
    parseAgentOutput,
    parseVerifierOutput,
    verifierOutputJsonSchema,
    verifierOutputSchema,
    parseCandidateFindings,
    parseCoordinatorOutput,
    parseReviewResult,
    reviewCategories,
    reviewCategorySchema,
    reviewFailureKindSchema,
    reviewFailureKinds,
    reviewFailureSchema,
    reviewResultSchema,
    reviewSeverities,
    reviewStatusSchema,
    reviewStatuses,
    reviewVerdictSchema,
    reviewVerdicts,
    severitySchema,
    verificationSchema,
    verificationStateSchema,
    verificationStates
};

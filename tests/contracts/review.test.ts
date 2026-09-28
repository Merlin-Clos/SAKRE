import { describe, expect, test } from 'bun:test';
import {
    agentOutputJsonSchema,
    agentOutputSchema,
    coordinatorOutputJsonSchema,
    parseAgentOutput,
    parseCoordinatorOutput,
    parseReviewResult,
    reviewSeverities
} from '../../src/contracts/review';
import { jsonSchemaObjectAtPath, omitPropertyAtPath } from '../helpers/review-contracts';

const validAgentOutput = {
    summary: 'Specialist review finished.',
    findings: [
        {
            severity: 'Blocker',
            category: 'security',
            title: 'SQL injection in login handler',
            impact: 'Attackers can read arbitrary rows.',
            evidence: 'User input is concatenated into the query at src/auth/login.ts:42.',
            location: { file: 'src/auth/login.ts', line: 42, lineEnd: 48 },
            suggestedFix: 'Use parameterized queries.'
        }
    ],
    usedContext7: false,
    context7Topics: []
};

const validCoordinatorOutput = {
    summary: 'Coordinator finished.',
    findings: validAgentOutput.findings.map((finding) => ({
        ...finding,
        sourceIds: ['correctness:src/auth/login.ts:42:abc123']
    }))
};

const validFinding = {
    severity: 'Blocker',
    category: 'security',
    title: 'SQL injection in login handler',
    impact: 'Attackers can read arbitrary rows.',
    evidence: 'User input is concatenated into the query at src/auth/login.ts:42.',
    location: { file: 'src/auth/login.ts', line: 42 },
    suggestedFix: 'Use parameterized queries.',
    id: 'security:src/auth/login.ts:42:abc123',
    fingerprint: 'a1b2c3d4e5f6a7b8',
    sourceAgents: ['security'],
    verification: { state: 'confirmed', reason: 'Reproduced in an independent session.', verifiedBy: 'verifier' }
};

const completeResult = {
    riskSummary: 'Review finished.',
    riskTier: 'standard',
    reviewedHeadSha: 'a'.repeat(40),
    findings: [validFinding],
    status: 'complete',
    verdict: 'comments'
};

const incompleteResult = {
    riskSummary: 'Review incomplete.',
    riskTier: 'hard',
    reviewedHeadSha: 'a'.repeat(40),
    findings: [],
    status: 'incomplete',
    verdict: null,
    unverifiedFindings: [validFinding],
    failures: [{ kind: 'timeout', stage: 'specialist:security', message: 'Agent timed out.' }]
};

const staleResult = {
    riskSummary: 'Findings from a replaced head.',
    riskTier: 'lite',
    reviewedHeadSha: 'a'.repeat(40),
    findings: [],
    status: 'stale',
    verdict: null,
    currentHeadSha: 'b'.repeat(40)
};

describe('review contracts strict validation', () => {
    test('accepts a well-formed agent output', () => {
        expect(parseAgentOutput(validAgentOutput).findings).toHaveLength(1);
    });

    test('rejects unknown properties with a precise path', () => {
        const result = agentOutputSchema.safeParse({ ...validAgentOutput, extra: true });
        expect(result.success).toBe(false);

        if (!result.success) {
            const [issue] = result.error.issues;
            expect(issue?.code).toBe('unrecognized_keys');
            expect(JSON.stringify(issue)).toContain('extra');
        }
    });

    test('rejects an unknown severity even when the JSON is syntactically valid', () => {
        const invalid = {
            ...validAgentOutput,
            findings: [{ ...validAgentOutput.findings[0], severity: 'high' }]
        };

        expect(() => parseAgentOutput(invalid)).toThrow();
    });

    test('the canonical severity enum is exactly Blocker | Important | Minor', () => {
        expect(reviewSeverities).toEqual(['Blocker', 'Important', 'Minor']);
    });

    test('rejects every retired severity label without an alias', () => {
        for (const severity of ['Critical', 'Warning', 'Suggestion']) {
            const invalid = {
                ...validAgentOutput,
                findings: [{ ...validAgentOutput.findings[0], severity }]
            };

            expect(() => parseAgentOutput(invalid), severity).toThrow();
        }
    });

    test('rejects structurally invalid coordinator output instead of returning zero findings', () => {
        expect(() => parseCoordinatorOutput({ summary: 'ok', findings: 'none' })).toThrow();
        expect(() => parseCoordinatorOutput({ findings: [] })).toThrow();
    });

    test('requires impact and evidence on every finding', () => {
        const withoutImpact = {
            ...validAgentOutput,
            findings: [{ ...validAgentOutput.findings[0], impact: undefined }]
        };

        const withoutEvidence = {
            ...validAgentOutput,
            findings: [{ ...validAgentOutput.findings[0], evidence: undefined }]
        };

        expect(() => parseAgentOutput(withoutImpact)).toThrow();
        expect(() => parseAgentOutput(withoutEvidence)).toThrow();
    });

    test('rejects the retired details and suggestion fields without fallback', () => {
        const retired = {
            ...validAgentOutput,
            findings: [
                {
                    ...validAgentOutput.findings[0],
                    details: 'Old field.',
                    suggestion: 'Old suggestion.'
                }
            ]
        };

        expect(() => parseAgentOutput(retired)).toThrow();
    });
});

describe('review contracts JSON schemas', () => {
    test('JSON Schema required fields match agent and coordinator runtime validation', () => {
        const candidateFindingFields = ['severity', 'category', 'title', 'impact', 'evidence'] as const;

        const contracts = [
            {
                name: 'agent',
                schema: agentOutputJsonSchema(),
                output: validAgentOutput,
                parse: parseAgentOutput,
                requiredGroups: [
                    {
                        schemaPath: [],
                        outputPath: [],
                        fields: ['summary', 'findings', 'usedContext7', 'context7Topics']
                    },
                    {
                        schemaPath: ['findings', 'items'],
                        outputPath: ['findings', 0],
                        fields: candidateFindingFields
                    }
                ]
            },
            {
                name: 'coordinator',
                schema: coordinatorOutputJsonSchema(),
                output: validCoordinatorOutput,
                parse: parseCoordinatorOutput,
                requiredGroups: [
                    { schemaPath: [], outputPath: [], fields: ['summary', 'findings'] },
                    {
                        schemaPath: ['findings', 'items'],
                        outputPath: ['findings', 0],
                        fields: [...candidateFindingFields, 'sourceIds']
                    }
                ]
            }
        ];

        for (const contract of contracts) {
            expect(() => contract.parse(contract.output), `${contract.name} fixture should be valid`).not.toThrow();

            for (const group of contract.requiredGroups) {
                const schema = jsonSchemaObjectAtPath(contract.schema, group.schemaPath);
                expect(schema.type).toBe('object');
                expect(schema.additionalProperties).toBe(false);
                expect(schema.required).toEqual([...group.fields].toSorted());

                for (const field of group.fields) {
                    expect(Object.hasOwn(schema.properties, field)).toBe(true);
                    const outputPath = [...group.outputPath, field];
                    const outputWithoutField = omitPropertyAtPath(contract.output, outputPath);
                    expect(
                        () => contract.parse(outputWithoutField),
                        `${contract.name} validation should reject missing ${outputPath.join('.')}`
                    ).toThrow();
                }
            }
        }
    });

    test('the submit JSON schemas expose only the current severity enum', () => {
        const expected = ['Blocker', 'Important', 'Minor'];

        // SAFETY: the schema builder emits the Finding JSON Schema; the severity-enum path read below is asserted by the expectations.
        const agentJsonSchema = agentOutputJsonSchema() as {
            properties: { findings: { items: { properties: { severity: { enum: string[] } } } } };
        };

        // SAFETY: the schema builder emits the Finding JSON Schema; the severity-enum path read below is asserted by the expectations.
        const coordinatorJsonSchema = coordinatorOutputJsonSchema() as {
            properties: { findings: { items: { properties: { severity: { enum: string[] } } } } };
        };

        expect(agentJsonSchema.properties.findings.items.properties.severity.enum).toEqual(expected);
        expect(coordinatorJsonSchema.properties.findings.items.properties.severity.enum).toEqual(expected);
    });
});

describe('finding location range invariants', () => {
    test('rejects lineEnd without line', () => {
        const invalid = {
            ...validAgentOutput,
            findings: [{ ...validAgentOutput.findings[0], location: { file: 'src/a.ts', lineEnd: 10 } }]
        };

        expect(() => parseAgentOutput(invalid)).toThrow(/lineEnd requires line/u);
    });

    test('rejects an inverted line range', () => {
        const invalid = {
            ...validAgentOutput,
            findings: [{ ...validAgentOutput.findings[0], location: { file: 'src/a.ts', line: 10, lineEnd: 5 } }]
        };

        expect(() => parseAgentOutput(invalid)).toThrow(/lineEnd must be greater/u);
    });

    test('accepts an equal line range as a single line', () => {
        const single = {
            ...validAgentOutput,
            findings: [{ ...validAgentOutput.findings[0], location: { file: 'src/a.ts', line: 10, lineEnd: 10 } }]
        };

        expect(() => parseAgentOutput(single)).not.toThrow();
    });
});

describe('review result status and verdict invariants', () => {
    test('accepts a complete result with a verdict', () => {
        expect(parseReviewResult(completeResult).verdict).toBe('comments');
    });

    test('names the deterministic risk diagnostic riskSummary, not a review summary', () => {
        expect(parseReviewResult(completeResult).riskSummary).toBe('Review finished.');
        expect(() => parseReviewResult({ ...completeResult, riskSummary: undefined })).toThrow();
        expect(() => parseReviewResult({ ...completeResult, summary: 'Review finished.' })).toThrow();
    });

    test('accepts an incomplete result only with a null verdict', () => {
        expect(parseReviewResult(incompleteResult).verdict).toBeNull();
    });

    test('rejects an incomplete result carrying a verdict', () => {
        const invalid = { ...incompleteResult, verdict: 'clean' };
        expect(() => parseReviewResult(invalid)).toThrow();
    });

    test('rejects a stale result carrying a verdict', () => {
        const invalid = { ...staleResult, verdict: 'clean' };
        expect(() => parseReviewResult(invalid)).toThrow();
    });

    test('rejects a stale result whose heads are identical', () => {
        const invalid = { ...staleResult, currentHeadSha: staleResult.reviewedHeadSha };
        expect(() => parseReviewResult(invalid)).toThrow();
    });

    test('accepts a stale result whose heads differ with a null verdict', () => {
        expect(parseReviewResult({ ...staleResult, unverifiedFindings: [], failures: [] }).verdict).toBeNull();
    });

    test('rejects each missing required final-finding provenance field', () => {
        const provenancePaths = ['id', 'fingerprint', 'sourceAgents', 'verification', 'verification.state'] as const;

        for (const field of provenancePaths) {
            const path = field.split('.');

            const invalid = {
                ...completeResult,
                findings: [omitPropertyAtPath(validFinding, path)]
            };

            expect(() => parseReviewResult(invalid), `Complete findings should require ${field}`).toThrow();
        }
    });

    test('accepts a result whose intelligence carries the versioned anchors', () => {
        const intelligence = {
            schemaVersion: 1,
            revisions: { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) },
            files: [],
            warnings: []
        };

        const parsed = parseReviewResult({ ...completeResult, intelligence });
        expect(parsed.intelligence?.schemaVersion).toBe(1);
    });

    test('rejects a result whose intelligence is not a versioned ReviewMap', () => {
        const invalid = { ...completeResult, intelligence: { schemaVersion: 2, files: [], warnings: [] } };
        expect(() => parseReviewResult(invalid)).toThrow();
    });
});

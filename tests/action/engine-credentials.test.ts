import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
    cleanupRoots,
    fileExists,
    PS_RESOLVER,
    RESOLVER,
    runResolver,
    sha256,
    tempRoot,
    writeActionPin,
    writeExecutable
} from '../helpers/action-resolver';
import { stubCurl } from '../helpers/curl-stub';

/* The engine-download credential is a separate trust domain from the
   target-repository token: it must be selectable on its own, must never fall
   back to the target token, and must not reach the engine process. The
   PowerShell resolver is pinned statically because only the bash path runs
   here; the Windows artifact job executes it. */

setDefaultTimeout(30_000);

afterEach(cleanupRoots);

const ENGINE_ASSET = 'sakre-linux-x64.gz';

const ENGINE_INSTALLED = ['runner-temp', 'sakre-engine', 'v1.0.0', 'sakre-linux-x64'];

const GITHUB_EXPRESSION_OPEN = `${String.fromCodePoint(36)}{{`;

const ENGINE_TOKEN_EXPRESSION = `${GITHUB_EXPRESSION_OPEN} secrets.SAKRE_ENGINE_TOKEN }}`;

describe('engine download credential', () => {
    test('uses the SAKRE_ENGINE_TOKEN environment fallback when the input is unset', async () => {
        const root = await tempRoot('sakre-engine-env-token-');

        const fixture = await writeExecutable(
            path.join(root, 'fixture-engine.sh'),
            '#!/usr/bin/env bash\nprintf "engine:%s\\n" "$*"\n'
        );

        const digest = sha256(await readFile(fixture));
        const actionPath = await writeActionPin(root, 'v1.0.0', { [ENGINE_ASSET]: digest });
        const stubBin = await stubCurl(root, fixture, { authenticated: true });
        const curlLog = path.join(root, 'curl.log');

        const result = await runResolver({
            root,
            actionPath,
            args: ['--version'],
            env: {
                PATH: `${stubBin}:${process.env.PATH ?? ''}`,
                SAKRE_ENGINE_TOKEN: 'test-token',
                RESOLVER_CURL_LOG: curlLog
            }
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('engine:--version');
        /* The credential must never appear in a curl argument list. */
        expect(await readFile(curlLog, 'utf8')).not.toContain('test-token');
    });

    test('never uses the target-repository token for the engine download', async () => {
        const root = await tempRoot('sakre-engine-target-token-');

        const fixture = await writeExecutable(
            path.join(root, 'fixture-engine.sh'),
            '#!/usr/bin/env bash\nprintf "engine:%s\\n" "$*"\n'
        );

        const digest = sha256(await readFile(fixture));
        const actionPath = await writeActionPin(root, 'v1.0.0', { [ENGINE_ASSET]: digest });
        const stubBin = await stubCurl(root, fixture, { authenticated: true });

        const result = await runResolver({
            root,
            actionPath,
            args: ['--version'],
            env: {
                PATH: `${stubBin}:${process.env.PATH ?? ''}`,
                INPUT_GITHUB_TOKEN: 'test-token',
                GITHUB_TOKEN: 'test-token'
            }
        });

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain('engine_token');
        expect(await fileExists(path.join(root, ...ENGINE_INSTALLED))).toBe(false);
    });

    test('removes the engine credential from the engine process environment', async () => {
        const root = await tempRoot('sakre-engine-token-scope-');

        const fixture = await writeExecutable(
            path.join(root, 'fixture-engine.sh'),
            `#!/usr/bin/env bash\nprintf "engine-token=%s\\n" "\${SAKRE_ENGINE_TOKEN-unset}"\n`
        );

        const digest = sha256(await readFile(fixture));
        const actionPath = await writeActionPin(root, 'v1.0.0', { [ENGINE_ASSET]: digest });
        const stubBin = await stubCurl(root, fixture, { authenticated: true });

        const result = await runResolver({
            root,
            actionPath,
            args: ['--version'],
            env: {
                PATH: `${stubBin}:${process.env.PATH ?? ''}`,
                INPUT_ENGINE_TOKEN: 'test-token'
            }
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('engine-token=unset');
        expect(result.stdout).not.toContain('test-token');
    });

    test('scripts and Action metadata keep the engine credential separate', async () => {
        const [bashResolver, pwshResolver, actionMetadata] = await Promise.all([
            readFile(RESOLVER, 'utf8'),
            readFile(PS_RESOLVER, 'utf8'),
            readFile('action.yml', 'utf8')
        ]);

        for (const script of [bashResolver, pwshResolver]) {
            expect(script).toContain('INPUT_ENGINE_TOKEN');
            expect(script).toContain('SAKRE_ENGINE_TOKEN');
            expect(script).not.toContain('GITHUB_TOKEN');
        }

        const inputMetadataSchema = z.object({ description: z.string(), required: z.boolean().optional() });
        const stepMetadataSchema = z.object({ env: z.record(z.string(), z.string()) });

        const action = z
            .object({
                inputs: z.record(z.string(), inputMetadataSchema),
                runs: z.object({ steps: z.array(stepMetadataSchema) })
            })
            .parse(parseYaml(actionMetadata));

        expect(action.inputs.engine_token?.description).toContain('Contents: Read');
        expect(action.inputs.engine_token?.required).toBe(false);
        expect(action.inputs.github_token?.description).toContain('target repository');
        expect(action.inputs.github_token?.required).toBe(true);

        for (const step of action.runs.steps) {
            expect(step.env.INPUT_ENGINE_TOKEN).toBe(`${GITHUB_EXPRESSION_OPEN} inputs.engine_token }}`);
            expect(step.env.INPUT_GITHUB_TOKEN).toBe(`${GITHUB_EXPRESSION_OPEN} inputs.github_token }}`);
        }
    });

    test('the private workflow example adds only the engine credential', async () => {
        const [publicContent, privateContent] = await Promise.all([
            readFile('examples/workflow.yml', 'utf8'),
            readFile('examples/workflow-private-engine.yml', 'utf8')
        ]);

        expect(privateContent).toContain(`engine_token: '${ENGINE_TOKEN_EXPRESSION}'`);
        expect(privateContent).toContain('fetch-depth: 0');
        const stepSchema = z.object({ uses: z.string(), with: z.record(z.string(), z.unknown()) });
        const reviewSchema = z.object({ steps: z.array(stepSchema) });

        const workflowSchema = z.object({
            permissions: z.record(z.string(), z.string()),
            concurrency: z.record(z.string(), z.unknown()),
            jobs: z.object({ review: reviewSchema })
        });

        const publicData: unknown = parseYaml(publicContent);
        const privateData: unknown = parseYaml(privateContent);
        const publicWorkflow = workflowSchema.parse(publicData);
        const privateWorkflow = workflowSchema.parse(privateData);
        expect(privateWorkflow.permissions).toEqual(publicWorkflow.permissions);
        expect(privateWorkflow.concurrency).toEqual(publicWorkflow.concurrency);
        /* The first step checks out the pull request head; the second runs the Action. */
        const [, publicStep] = publicWorkflow.jobs.review.steps;
        const [, privateStep] = privateWorkflow.jobs.review.steps;

        if (publicStep === undefined || privateStep === undefined) {
            throw new Error('The workflow examples do not contain the expected Action step.');
        }

        expect(privateStep.uses).toBe(publicStep.uses);
        const engineToken = privateStep.with.engine_token;
        Reflect.deleteProperty(privateStep.with, 'engine_token');
        expect(engineToken).toBe(ENGINE_TOKEN_EXPRESSION);
        expect(privateStep.with).toEqual(publicStep.with);
    });
});

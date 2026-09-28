import { expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

test('artifact jobs gate PR CI while release keeps bounded per-target publication', async () => {
    const stringList = z.array(z.string());
    const stringOrStringList = z.union([z.string(), stringList]);

    const jobSchema = z.object({
        'continue-on-error': z.unknown().optional(),
        'timeout-minutes': z.number().optional(),
        if: z.string().optional(),
        needs: stringOrStringList.optional(),
        strategy: z.unknown().optional(),
        steps: z.unknown().optional(),
        'runs-on': z.unknown().optional()
    });

    const jobsSchema = z.record(z.string(), jobSchema);
    const workflowSchema = z.object({ jobs: jobsSchema });

    const ciText = await Bun.file('.github/workflows/ci.yml').text();
    const ciData: unknown = parseYaml(ciText);
    const ci = workflowSchema.parse(ciData);
    /* A broken artifact build must fail the PR run, not merge under a green
       quality-check. */
    expect(ci.jobs['build-artifacts']?.['continue-on-error']).toBeUndefined();
    expect(ci.jobs['build-artifacts']?.['timeout-minutes']).toBeGreaterThan(0);
    expect(ciText).not.toContain('ubuntu-latest');
    expect(ciText).toContain('runner: ubuntu-22.04');
    expect(ciText).toContain('runner: ubuntu-22.04-arm');
    expect(ci.jobs['test-linux-compatibility']?.strategy).toMatchObject({
        matrix: {
            include: [
                { runner: 'ubuntu-22.04', artifact: 'sakre-linux-x64', experimental: false },
                { runner: 'ubuntu-24.04', artifact: 'sakre-linux-x64', experimental: false },
                { runner: 'ubuntu-26.04', artifact: 'sakre-linux-x64', experimental: true },
                { runner: 'ubuntu-22.04-arm', artifact: 'sakre-linux-arm64', experimental: false },
                { runner: 'ubuntu-24.04-arm', artifact: 'sakre-linux-arm64', experimental: false },
                { runner: 'ubuntu-26.04-arm', artifact: 'sakre-linux-arm64', experimental: true }
            ]
        }
    });
    expect(ci.jobs['test-linux-compatibility']?.['continue-on-error']).toBe(
        ['$', '{{ matrix.experimental }}'].join('')
    );
    expect(ciText).toContain('actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131');
    expect(ciText).toContain('sha256sum --check');
    expect(ciText).toContain('chmod +x "$SAKRE_ENGINE_BINARY"');
    expect(ciText).toContain('"$SAKRE_ENGINE_BINARY" --version');
    expect(ciText).toContain('bun test tests/artifact tests/integration');

    const releaseText = await Bun.file('.github/workflows/release.yml').text();
    const releaseData: unknown = parseYaml(releaseText);
    const release = workflowSchema.parse(releaseData);
    /* Non-Linux release targets remain individually best-effort; Linux artifact
       publication is gated by the required downloaded-artifact test matrix. */
    expect(release.jobs.build?.['continue-on-error']).toBe(true);
    expect(release.jobs.build?.['timeout-minutes']).toBeGreaterThan(0);
    expect(release.jobs.publish?.if).toContain("needs.linux-compatibility.result == 'success'");
    expect(release.jobs['linux-compatibility']?.needs).toBe('build');
    expect(release.jobs.publish?.['timeout-minutes']).toBeGreaterThan(0);
    expect(releaseText).not.toContain('ubuntu-latest');
    expect(release.jobs['linux-compatibility']?.strategy).toMatchObject({
        matrix: {
            include: [
                { runner: 'ubuntu-22.04', artifact: 'sakre-linux-x64', experimental: false },
                { runner: 'ubuntu-24.04', artifact: 'sakre-linux-x64', experimental: false },
                { runner: 'ubuntu-26.04', artifact: 'sakre-linux-x64', experimental: true },
                { runner: 'ubuntu-22.04-arm', artifact: 'sakre-linux-arm64', experimental: false },
                { runner: 'ubuntu-24.04-arm', artifact: 'sakre-linux-arm64', experimental: false },
                { runner: 'ubuntu-26.04-arm', artifact: 'sakre-linux-arm64', experimental: true }
            ]
        }
    });
    expect(release.jobs['linux-compatibility']?.['continue-on-error']).toBe(
        ['$', '{{ matrix.experimental }}'].join('')
    );
    expect(releaseText).toContain('actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131');
    expect(releaseText).toContain('sha256sum --check');
    expect(releaseText).toContain('needs: [validate, build, linux-compatibility]');
    expect(releaseText).toContain('test -f dist-release/sakre-linux-arm64.gz');

    const benchmarkText = await Bun.file('.github/workflows/benchmark.yml').text();
    const benchmarkData: unknown = parseYaml(benchmarkText);
    const benchmark = workflowSchema.parse(benchmarkData);
    expect(benchmark.jobs.measure?.['timeout-minutes']).toBeGreaterThan(0);
    expect(benchmark.jobs['cache-restore']?.['timeout-minutes']).toBeGreaterThan(0);
    expect(benchmarkText).not.toContain('ubuntu-latest');
});

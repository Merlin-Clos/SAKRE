import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSccArguments, measureScc } from '../../src/intelligence/measure-scc';
import { resolvePinnedBinary } from '../helpers/native-binary';

/* Official-output parity: the production invocation and one `--format-multi`
   invocation run over the same fixture, and the derived ULOC/Lines/dryness must
   match the official numbers. The test needs an SCC 4.1.0 binary; CI provides
   SAKRE_SCC_BINARY or the pinned cache entry. */

const SCC_VERSION = '4.1.0';

const FILES = ['README.md', 'src/a.ts', 'src/b.ts'];

const sccBinary = await resolvePinnedBinary('scc', SCC_VERSION, 'SAKRE_SCC_BINARY');

function runScc(binary: string, directory: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, {
            cwd: directory,
            env: { ...process.env, SCC_CONFIG_PATH: '' },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
        });
        child.on('error', reject);
        child.on('close', (code) => {
            resolve({ code, stdout });
        });
    });
}

describe('SCC official-output parity', () => {
    test.skipIf(sccBinary === undefined)('derived ULOC/Lines/dryness match one --format-multi invocation', async () => {
        if (sccBinary === undefined) {
            throw new Error('The parity test started without an SCC binary.');
        }

        const root = await mkdtemp(path.join(tmpdir(), 'sakre-scc-parity-'));
        const fixture = path.join(root, 'fixture');
        const out = path.join(root, 'out');
        await Promise.all([mkdir(path.join(fixture, 'src'), { recursive: true }), mkdir(out, { recursive: true })]);

        try {
            await Promise.all([
                writeFile(path.join(fixture, 'src', 'a.ts'), 'export function a(){ if (x) { return 1; } return 0; }\n'),
                writeFile(path.join(fixture, 'src', 'b.ts'), 'export const b = 1;\nexport const c = 2;\n'),
                writeFile(path.join(fixture, 'README.md'), '# doc\n\nsome docs\n')
            ]);

            const production = await measureScc({ binaryPath: sccBinary, directory: fixture, files: FILES });

            const officialJson = path.join(out, 'official.json');
            const multiArgs = buildSccArguments();
            multiArgs.splice(multiArgs.indexOf('--format'), 2, '--format-multi', `json:${officialJson},tabular:stdout`);
            const multi = await runScc(sccBinary, fixture, multiArgs);
            expect(multi.code).toBe(0);
            expect(multi.stdout).toContain('TypeScript');

            // SAFETY: scc JSON output is the per-language table; the Lines/ULOC/Files fields are summed below.
            const official = (await Bun.file(officialJson).json()) as {
                Lines: number;
                ULOC?: number;
                Files?: { Uloc?: number }[];
            }[];

            const officialLines = official.reduce((sum, language) => sum + language.Lines, 0);
            const officialUloc = official.reduce((sum, language) => sum + (language.ULOC ?? 0), 0);

            const officialFileUloc = official.reduce(
                (sum, language) => sum + (language.Files ?? []).reduce((files, file) => files + (file.Uloc ?? 0), 0),
                0
            );

            expect(production.totals.lines).toBe(officialLines);
            expect(production.totals.uloc).toBe(officialUloc);
            expect(production.files.reduce((sum, file) => sum + file.uloc, 0)).toBe(officialFileUloc);

            const reportPath = path.join(out, 'report.html');
            const reportArgs = buildSccArguments().filter((argument) => argument !== '--by-file');
            reportArgs.splice(reportArgs.indexOf('--format'), 2, `--report=${reportPath}`);
            const report = await runScc(sccBinary, fixture, reportArgs);
            expect(report.code).toBe(0);

            const displayed = /(?<uloc>[\d,]+) ULOC \((?<percent>[\d.]+)% DRYness\)/u.exec(
                await readFile(reportPath, 'utf8')
            );

            if (displayed?.groups?.uloc === undefined || displayed.groups.percent === undefined) {
                throw new Error('Expected the SCC HTML report to contain its ULOC and DRYness summary.');
            }

            expect(Number(displayed.groups.uloc.replaceAll(',', ''))).toBe(officialUloc);
            const derivedPercent = (production.totals.dryness ?? 0) * 100;
            expect(Math.abs(Number(displayed.groups.percent) - derivedPercent)).toBeLessThanOrEqual(0.05);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PRODUCT_SLUG } from '../identity';
import { engineSubmitToolSpecs } from './submit';

export const ENGINE_PLUGIN_ID = `${PRODUCT_SLUG}-engine`;

/* Engine loads custom tools from a plugin directory containing `index.js`.
   Directory is generated from the same Zod contracts as the pipeline, so
   schemas cannot drift. Submission map enforces "first valid submission
   wins" per session; the SDK itself rejects schema-invalid input before this
   code runs. */
export function enginePluginSource(): string {
    const tools = JSON.stringify(engineSubmitToolSpecs(), null, 2);

    return [
        'const SUBMISSIONS = new Map();',
        `const TOOLS = ${tools};`,
        '',
        'export default {',
        `    id: '${ENGINE_PLUGIN_ID}',`,
        '    async setup(context) {',
        '        await context.tool.transform((editor) => {',
        '            for (const tool of TOOLS) {',
        '                editor.add({',
        '                    name: tool.name,',
        '                    description: tool.description,',
        '                    input: tool.input,',
        '                    options: { codemode: false },',
        '                    execute: async (input, toolContext) => {',
        '                        const sessionID = String(toolContext.sessionID);',
        '                        if (SUBMISSIONS.has(sessionID)) {',
        "                            throw new Error('A submission is already recorded for this session. Do not submit again.');",
        '                        }',
        '                        SUBMISSIONS.set(sessionID, input);',
        "                        return { content: 'Submission recorded.' };",
        '                    }',
        '                });',
        '            }',
        '        });',
        '    }',
        '};',
        ''
    ].join('\n');
}

/* Content-addressed materialization under one cache root: directory name is
   the plugin source hash, so a compiled change never reuses a stale plugin
   and a warm cache pays for one read. Write is atomic, so concurrent
   processes install the same verified file and the last rename wins without
   exposing a partial directory. */
export async function materializeEnginePlugin(cacheRoot: string): Promise<string> {
    const source = enginePluginSource();
    const digest = createHash('sha256').update(source).digest('hex');
    const directory = path.join(cacheRoot, ENGINE_PLUGIN_ID, digest);

    if (await isCurrentPlugin(path.join(directory, 'index.js'), source)) {
        return directory;
    }

    await installPlugin(directory, source);

    return directory;
}

async function installPlugin(directory: string, source: string): Promise<void> {
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `index.js.${process.pid}.tmp`);
    await writeFile(temporary, source, 'utf8');
    await rename(temporary, path.join(directory, 'index.js'));
}

async function isCurrentPlugin(target: string, expected: string): Promise<boolean> {
    try {
        return (await readFile(target, 'utf8')) === expected;
    } catch {
        return false;
    }
}

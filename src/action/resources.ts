import type { AiRuntime } from '../ai/runtime';
import { asError } from '../errors';
import type { TrustedWorkspace } from '../workspace/trusted';

/* Each owned resource closes in its own guard, so one close failure skips
   nothing and hides no primary error. */
export async function closeOwnedResources(
    runtime: AiRuntime | undefined,
    workspace: TrustedWorkspace | undefined
): Promise<Error | undefined> {
    let failure: Error | undefined = undefined;

    for (const resource of [runtime, workspace]) {
        if (resource !== undefined) {
            try {
                // eslint-disable-next-line no-await-in-loop -- close order is deliberate
                await resource.close();
            } catch (error) {
                failure ??= asError(error);
            }
        }
    }

    return failure;
}

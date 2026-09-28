import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/* Serves the composite resolver `curl` calls from a gzip fixture engine. The
   stub copies the compressed fixture for the public download URL, or, in
   authenticated mode, rejects that URL and answers the release and asset API
   routes only when the expected token is present. It lets the resolver tests
   execute the real script without network access, and logs every invocation so
   tests can assert the token never reaches argv. */
export async function stubCurl(
    root: string,
    fixture: string,
    options: { authenticated?: boolean; assetName?: string } = {}
): Promise<string> {
    const bin = path.join(root, 'bin');
    await mkdir(bin, { recursive: true });
    const compressedFixture = `${fixture}.gz`;
    await writeFile(compressedFixture, Bun.gzipSync(await readFile(fixture)));
    const assetName = options.assetName ?? 'sakre-linux-x64.gz';
    /* The delay keeps the reported download phase above zero so the resolver
       timing assertions are deterministic even on a fast machine. */
    let anonymous = `sleep 0.05\ncp '${compressedFixture}' "$destination"`;

    if (options.authenticated === true) {
        anonymous = 'exit 22';
    }

    const script = `#!/usr/bin/env bash
destination=""
url=""
authorized=0
config_from_stdin=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --output) destination="$2"; shift 2 ;;
        --config)
            if [ "$2" = "-" ]; then config_from_stdin=1; fi
            shift 2
            ;;
        --header)
            case "$2" in
                'Authorization: Bearer test-token') authorized=1 ;;
            esac
            shift 2
            ;;
        --retry) shift 2 ;;
        -*) shift ;;
        *) url="$1"; shift ;;
    esac
done
if [ -n "\${RESOLVER_CURL_LOG:-}" ]; then
    printf '%s\\n' "$*" >> "$RESOLVER_CURL_LOG"
fi
if [ "$config_from_stdin" = "1" ]; then
    config=$(cat)
    case "$config" in *'Authorization: Bearer test-token'*) authorized=1 ;; esac
fi
case "$url" in
    */releases/download/*)
        ${anonymous}
        ;;
    */releases/tags/*)
        if [ "$authorized" != "1" ]; then exit 22; fi
        printf '{"assets":[{"url":"https://api.github.com/assets/42","id":42,"node_id":"RA_42","name":"%s"}]}\\n' '${assetName}'
        ;;
    */releases/assets/42)
        if [ "$authorized" != "1" ]; then exit 22; fi
        cp '${compressedFixture}' "$destination"
        ;;
    *) exit 22 ;;
esac
`;

    await writeFile(path.join(bin, 'curl'), script, { mode: 0o755 });

    return bin;
}

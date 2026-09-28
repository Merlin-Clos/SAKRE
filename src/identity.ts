/* Single source of product identity; a rename or fork changes this file. Markers, cache dirs, file names, env prefix and CLI command derive from it. */
import packageJson from '../package.json' with { type: 'json' };

const PRODUCT_NAME = 'SAKRE';

const PRODUCT_SLUG = 'sakre';

const PRODUCT_MARKER = 'sakre';

const PRODUCT_VERSION = packageJson.version;

const CLI_LOCAL_COMMAND = 'local';

const CLI_AUTH_COMMAND = 'auth';

const ENV_PREFIX = PRODUCT_SLUG.toUpperCase();

const DEFAULT_CONFIG_PATH = `.github/${PRODUCT_SLUG}.yml`;

const DEFAULT_AGENT_NAME = 'sakre';

const REVIEW_COMMENT_MARKER = `${PRODUCT_MARKER}-review`;

const METADATA_COMMENT_MARKER = `${PRODUCT_MARKER}-metadata`;

const CACHE_DIRECTORY = PRODUCT_MARKER;

const PROVIDER_API_KEY_ENV = `${ENV_PREFIX}_PROVIDER_API_KEY`;

const PROVIDER_BASE_URL_ENV = `${ENV_PREFIX}_PROVIDER_BASE_URL`;

const CONTEXT7_API_KEY_ENV = `${ENV_PREFIX}_CONTEXT7_API_KEY`;

export {
    CACHE_DIRECTORY,
    CLI_AUTH_COMMAND,
    CLI_LOCAL_COMMAND,
    CONTEXT7_API_KEY_ENV,
    DEFAULT_AGENT_NAME,
    DEFAULT_CONFIG_PATH,
    ENV_PREFIX,
    METADATA_COMMENT_MARKER,
    PRODUCT_MARKER,
    PRODUCT_NAME,
    PRODUCT_SLUG,
    PRODUCT_VERSION,
    PROVIDER_API_KEY_ENV,
    PROVIDER_BASE_URL_ENV,
    REVIEW_COMMENT_MARKER
};

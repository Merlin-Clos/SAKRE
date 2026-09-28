/* One owner of untrusted-text escaping: paths and names are attacker-controlled, so every Markdown interpolation goes through these helpers. */

const LINE_BREAK_PATTERN = /[\n\r\u2028\u2029]/gu;

const PERCENT_BASE = 100;

/* Replaces Unicode line terminators, so a hostile label cannot break out of a bullet or block. */
export function neutralizeLineBreaks(value: string): string {
    return value.replaceAll(LINE_BREAK_PATTERN, ' ');
}

/* Neutralize line breaks but keep the raw value otherwise. */
export function plainText(value: string): string {
    return neutralizeLineBreaks(value);
}

/* Fence exceeds the longest backtick run; edge backticks are padded so they cannot merge. */
export function inlineCode(value: string): string {
    const safe = neutralizeLineBreaks(value);
    const fence = '`'.repeat(longestBacktickRun(safe) + 1);
    const needsPadding = safe.startsWith('`') || safe.endsWith('`');

    if (needsPadding) {
        return `${fence} ${safe} ${fence}`;
    }

    return `${fence}${safe}${fence}`;
}

/* Table cell with neutralized breaks and escaped pipes. */
export function escapeTableCell(value: string): string {
    return neutralizeLineBreaks(value).replaceAll('|', String.raw`\|`);
}

/* Raw HTML text (like `pre`) must not parse as markup; ampersands go first to preserve entities. */
export function escapeHtmlText(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function signed(value: number): string {
    if (value > 0) {
        return `+${String(value)}`;
    }

    return String(value);
}

export function formatDryness(value: number | null): string {
    if (value === null || Number.isNaN(value)) {
        return 'n/a';
    }

    return `${(value * PERCENT_BASE).toFixed(1)}%`;
}

/* PR-signals formatting: separators, signed deltas, relative percent when meaningful, point deltas for DRYness. */
export function formatCount(value: number): string {
    return value.toLocaleString('en-US');
}

export function formatSignedCount(delta: number): string {
    const absolute = Math.abs(delta).toLocaleString('en-US');

    if (delta > 0) {
        return `+${absolute}`;
    }

    if (delta < 0) {
        return `-${absolute}`;
    }

    return '0';
}

export function formatRelativePercent(delta: number, base: number): string {
    if (base === 0 || Number.isNaN(delta) || Number.isNaN(base)) {
        return 'n/a';
    }

    const percent = (delta / base) * PERCENT_BASE;
    const absolute = Math.abs(percent).toFixed(1);

    if (percent > 0) {
        return `+${absolute}%`;
    }

    if (percent < 0) {
        return `-${absolute}%`;
    }

    return '+0.0%';
}

export function formatDrynessDeltaPp(delta: number | null): string {
    if (delta === null || Number.isNaN(delta)) {
        return 'n/a';
    }

    const points = delta * PERCENT_BASE;
    const absolute = Math.abs(points).toFixed(1);

    if (points > 0) {
        return `+${absolute} pp`;
    }

    if (points < 0) {
        return `-${absolute} pp`;
    }

    return '+0.0 pp';
}

function longestBacktickRun(value: string): number {
    let longest = 0;

    for (const run of value.match(/`+/gu) ?? []) {
        longest = Math.max(longest, run.length);
    }

    return longest;
}

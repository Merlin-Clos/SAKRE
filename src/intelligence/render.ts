import {
    escapeTableCell,
    formatCount,
    formatDryness,
    formatDrynessDeltaPp,
    formatRelativePercent,
    formatSignedCount,
    inlineCode
} from './format';
import type { CcccDistribution } from './measure-cccc';
import type { CcccDistributionBlock, CcccDistributionDelta, Hotspot, ReviewMap } from './schema';

const MAX_LANGUAGE_ROWS = 20;

const MAX_STRUCTURAL_PER_GROUP = 10;

export function renderPrSignalsTable(map: ReviewMap): string[] {
    const { base, head, delta } = map.repository;

    const rows: [string, string, string, string][] = [
        [
            'Repository files',
            `${formatCount(base.files)} -> ${formatCount(head.files)}`,
            formatSignedCount(delta.files),
            formatRelativePercent(delta.files, base.files)
        ],
        [
            'Code LOC',
            `${formatCount(base.code)} -> ${formatCount(head.code)}`,
            formatSignedCount(delta.code),
            formatRelativePercent(delta.code, base.code)
        ],
        [
            'DRYness',
            `${formatDryness(base.dryness)} -> ${formatDryness(head.dryness)}`,
            formatDrynessDeltaPp(delta.dryness),
            'n/a'
        ],
        [
            'McCabe complexity',
            `${formatCount(base.complexity)} -> ${formatCount(head.complexity)}`,
            formatSignedCount(delta.complexity),
            formatRelativePercent(delta.complexity, base.complexity)
        ],
        [
            'Cognitive complexity',
            `${formatCount(base.cognitive)} -> ${formatCount(head.cognitive)}`,
            formatSignedCount(delta.cognitive),
            formatRelativePercent(delta.cognitive, base.cognitive)
        ]
    ];

    return [
        '### Analysis signals',
        '',
        '| Metric | Change | Δ | Δ % |',
        '| --- | ---: | ---: | ---: |',
        ...rows.map((row) => tableRow(boldDelta(row)))
    ];
}

function boldDelta(row: [string, string, string, string]): [string, string, string, string] {
    const [metric, change, delta, percent] = row;

    return [metric, change, `**${delta}**`, percent];
}

export function renderIntelligenceComment(map: ReviewMap): string[] {
    return [
        '',
        '<details>',
        '<summary>Review intelligence · deterministic SCC + CCCC</summary>',
        '',
        '[SCC](https://github.com/boyter/scc) measures repository size, languages, ULOC, DRYness, and a file-level complexity estimate.',
        '',
        '[CCCC](https://github.com/moznion/cccc) measures function-level McCabe and cognitive complexity.',
        '',
        'These deterministic signals help rank attention. They do not decide findings or review scope.',
        '',
        ...sccDetails(map),
        '',
        ...ccccDetails(map),
        '',
        '</details>'
    ];
}

/* The table consumes the map's own deltas; the renderer never recomputes them. */
function distributionTable(map: ReviewMap): string[] {
    const { base, head, delta } = map.distributions.cccc;

    if (base === null || head === null || delta === null) {
        return ['CCCC distributions unavailable for this run.'];
    }

    const rows = distributionValues(base, head, delta).map((values) => countRow(values));

    return ['| Metric | Change | Δ | Δ % |', '| --- | ---: | ---: | ---: |', ...rows.map((row) => tableRow(row))];
}

interface DistributionValues {
    label: string;
    base: number;
    head: number;
    delta: number;
}

function distributionValues(
    base: CcccDistributionBlock,
    head: CcccDistributionBlock,
    delta: CcccDistributionDelta
): DistributionValues[] {
    return [
        { label: 'Function count', base: base.functionCount, head: head.functionCount, delta: delta.functionCount },
        { label: 'Parse errors', base: base.parseErrorCount, head: head.parseErrorCount, delta: delta.parseErrorCount },
        ...distributionGroup('Cognitive', { base: base.cognitive, head: head.cognitive, delta: delta.cognitive }),
        ...distributionGroup('Cyclomatic', { base: base.cyclomatic, head: head.cyclomatic, delta: delta.cyclomatic })
    ];
}

function distributionGroup(
    prefix: string,
    snapshots: { base: CcccDistribution; head: CcccDistribution; delta: CcccDistribution }
): DistributionValues[] {
    const { base, head, delta } = snapshots;

    return [
        { label: `${prefix} sum`, base: base.sum, head: head.sum, delta: delta.sum },
        { label: `${prefix} median`, base: base.median, head: head.median, delta: delta.median },
        { label: `${prefix} p90`, base: base.p90, head: head.p90, delta: delta.p90 },
        { label: `${prefix} p95`, base: base.p95, head: head.p95, delta: delta.p95 },
        { label: `${prefix} max`, base: base.max, head: head.max, delta: delta.max }
    ];
}

function countRow(values: {
    label: string;
    base: number;
    head: number;
    delta: number;
}): [string, string, string, string] {
    return [
        values.label,
        `${formatCount(values.base)} -> ${formatCount(values.head)}`,
        formatSignedCount(values.delta),
        formatRelativePercent(values.delta, values.base)
    ];
}

function tableRow(cells: [string, string, string, string]): string {
    return `| ${cells.map((cell) => escapeTableCell(cell)).join(' | ')} |`;
}

function languageDetails(map: ReviewMap): string[] {
    const rows = map.languages.slice(0, MAX_LANGUAGE_ROWS).map((language) => {
        const baseCode = language.base?.code;
        const headCode = language.head?.code;
        const baseUloc = language.base?.uloc;
        const headUloc = language.head?.uloc;

        return tableRow([
            language.name,
            `${formatCountOrNa(baseCode)} -> ${formatCountOrNa(headCode)}`,
            `${formatCountOrNa(baseUloc)} -> ${formatCountOrNa(headUloc)}`,
            `${formatDryness(language.base?.dryness ?? null)} -> ${formatDryness(language.head?.dryness ?? null)}`
        ]);
    });

    return [
        '<details>',
        `<summary>Language breakdown (${String(rows.length)})</summary>`,
        '',
        '| Language | Code | ULOC | DRYness |',
        '| --- | ---: | ---: | ---: |',
        ...rows,
        '',
        '</details>'
    ];
}

function sccDetails(map: ReviewMap): string[] {
    const groups: [string, Hotspot[], 'lines' | 'complexity' | 'dryness'][] = [
        ['Largest file growth', map.hotspots.largestCodeGrowth, 'lines'],
        ['Largest file complexity growth', map.hotspots.largestFileComplexityGrowth, 'complexity'],
        ['Largest DRYness regressions', map.hotspots.drynessRegression, 'dryness']
    ];

    if (groups.every(([, hotspots]) => hotspots.length === 0) && map.languages.length === 0) {
        return [];
    }

    const output = ['<details>', '<summary>Repository &amp; files / SCC</summary>', ''];

    for (const [title, hotspots, kind] of groups) {
        output.push(...renderSccGroup(title, hotspots, kind));
    }

    if (map.languages.length > 0) {
        output.push(...languageDetails(map));
    }

    output.push('', '</details>');

    return output;
}

function renderSccGroup(title: string, hotspots: Hotspot[], kind: 'lines' | 'complexity' | 'dryness'): string[] {
    if (hotspots.length === 0) {
        return [];
    }

    const output = ['<details>', `<summary>${title} (${String(hotspots.length)})</summary>`, ''];

    if (title === 'Largest file complexity growth') {
        output.push(
            "SCC's file complexity value is a lightweight control-flow estimate. It is useful for direction, not as a quality score.",
            ''
        );
    }

    for (const hotspot of hotspots.slice(0, MAX_STRUCTURAL_PER_GROUP)) {
        output.push(`- ${inlineCode(hotspot.path)}: ${formatSccValue(hotspot.value, kind)}`);
    }

    output.push('', '</details>', '');

    return output;
}

function formatSccValue(value: number, kind: 'lines' | 'complexity' | 'dryness'): string {
    if (kind === 'dryness') {
        return formatDrynessDeltaPp(-value);
    }

    if (kind === 'lines') {
        return `+${formatCount(value)} lines`;
    }

    return `+${formatCount(value)}`;
}

function ccccDetails(map: ReviewMap): string[] {
    const groups: [string, Hotspot[], string, boolean][] = [
        [
            'Largest cognitive-complexity growth',
            map.hotspots.largestCognitiveGrowth,
            'The number after each function is the increase in CCCC cognitive complexity for this diff.',
            false
        ],
        [
            'Largest McCabe-complexity growth',
            map.hotspots.largestCyclomaticGrowth,
            'The number after each function is the increase in CCCC McCabe complexity for this diff.',
            false
        ],
        [
            'Highest-complexity new functions',
            map.hotspots.newFunctions,
            'The number after each function is its CCCC cognitive complexity in HEAD.',
            true
        ]
    ];

    const output = ['<details>', '<summary>Functions / CCCC</summary>', '', ...distributionTable(map), ''];

    for (const [title, hotspots, description, headValue] of groups) {
        renderCcccGroup(output, { title, hotspots, description, headValue });
    }

    output.push('', '</details>');

    return output;
}

function renderCcccGroup(
    output: string[],
    group: { title: string; hotspots: Hotspot[]; description: string; headValue: boolean }
): void {
    if (group.hotspots.length === 0) {
        return;
    }

    output.push(
        '<details>',
        `<summary>${group.title} (${String(group.hotspots.length)})</summary>`,
        '',
        group.description,
        ''
    );

    for (const hotspot of group.hotspots.slice(0, MAX_STRUCTURAL_PER_GROUP)) {
        output.push(`- ${functionLabel(hotspot)}: ${formatCcccValue(hotspot.value, group.headValue)}`);
    }

    output.push('', '</details>', '');
}

function functionLabel(hotspot: Hotspot): string {
    let label = inlineCode(hotspot.path);

    if (hotspot.line !== undefined) {
        label += `:${String(hotspot.line)}`;
    }

    if (hotspot.name !== undefined) {
        label += ` ${inlineCode(hotspot.name)}`;
    }

    return label;
}

function formatCcccValue(value: number, headValue: boolean): string {
    if (headValue) {
        return formatCount(value);
    }

    return formatSignedCount(value);
}

function formatCountOrNa(value: number | undefined): string {
    if (value === undefined) {
        return 'n/a';
    }

    return formatCount(value);
}

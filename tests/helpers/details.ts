/* Collapsed sections are paired structurally: an unclosed `<details>` would
   swallow the rest of the published Markdown while the suite stays green. This
   helper counts the tags so a test can assert the pairing it depends on. */
export function countDetailsSections(text: string): { open: number; close: number } {
    // eslint-disable-next-line anti-slop/no-known-value-widening -- fixture contract annotation; documents the helper result shape
    return {
        open: text.split('<details>').length - 1,
        close: text.split('</details>').length - 1
    };
}

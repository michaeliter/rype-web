// Read ids of a FASTQ text, in order, mate suffix (/1, /2) stripped: the one normalisation
// every parity check (browser outputs, per-part truth, Node drivers) relies on.
export const readIds = (text) => text.split('\n').filter((l, i) => i % 4 === 0 && l).map((l) => l.slice(1).split(/\s/)[0].replace(/\/[12]$/, ''));

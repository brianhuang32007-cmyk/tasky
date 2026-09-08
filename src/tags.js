// The tag palette, in one place because two very different renderers need it:
// the DOM publishes the hex as a custom property, and the PDF writer needs the
// same value as a number it can put in a content stream. A CSS-only palette
// would have to be duplicated in JavaScript for the report to match.

export const TAG_COLOURS = [
  { id: 'red', label: 'Red', hex: '#e5484d' },
  { id: 'orange', label: 'Orange', hex: '#ef7c22' },
  { id: 'yellow', label: 'Yellow', hex: '#d9a406' },
  { id: 'green', label: 'Green', hex: '#30a46c' },
  { id: 'blue', label: 'Blue', hex: '#3b82f6' },
  { id: 'purple', label: 'Purple', hex: '#a855f7' },
  { id: 'grey', label: 'Grey', hex: '#8b7460' },
];

export const TAG_NAME_LIMIT = 25;

/** Falls back to the first colour, so a tag saved with an unknown one still draws. */
export const colourHex = (id) =>
  (TAG_COLOURS.find((c) => c.id === id) ?? TAG_COLOURS[0]).hex;

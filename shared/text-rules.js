const titleKey = value => String(value ?? '').trim().replace(/\s/g, '').replace(/（/g, '(').replace(/）/g, ')');

// Deliberately not fuzzy matching: one complete title must equal the other
// plus a single terminal travel/posting annotation. Other parentheses matter.
export function compareTitles(expected, observed) {
  const a = titleKey(expected), b = titleKey(observed);
  if (a && a === b) return {kind: 'exact'};
  const suffix = /\((?:出差|驻)[\p{Script=Han}A-Za-z·、/&-]{2,40}\)$/u;
  for (const [base, extended] of [[a, b], [b, a]]) {
    const note = extended.match(suffix)?.[0];
    if (base && note && extended.slice(0, -note.length) === base) return {
      kind: 'travel_suffix', expected_title: String(expected), observed_title: String(observed), annotation: note
    };
  }
  return {kind: 'conflict'};
}

// Known Word/Wingdings list markers seen at line starts in the export. Do not
// U+F0B7 is also observed as an inline Word bullet between text clauses. Do not
// normalize it next to digits or decode any other private-use glyph in prose.
export function displayJD(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/^([ \t]*)[\uF0B7\uF0FC\uF09F\uF077\uF06C]/gm, '$1• ').replace(/(?<!\d)\uF0B7(?!\d)/gu,'• ');
}

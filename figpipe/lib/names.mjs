// Section names across pages and languages. Designers move a section from the in-progress page to
// the ready page under a new id and a suffixed name: "Location" becomes "Location_EN", with
// "Location_GER" beside it. figpipe compares names by their base (language tag off, case, accents
// and separators ignored), so a moved section is recognised and a language variant inherits its
// owner. Pure functions, no state.

const LANGS = {
  en: "en", eng: "en", english: "en",
  de: "de", ger: "de", deu: "de", german: "de", deutsch: "de",
  fr: "fr", fra: "fr", fre: "fr", french: "fr",
  it: "it", ita: "it", italian: "it",
  es: "es", esp: "es", spa: "es", spanish: "es",
  nl: "nl", nld: "nl", dut: "nl", dutch: "nl",
  pt: "pt", por: "pt",
  pl: "pl", pol: "pl",
  sv: "sv", swe: "sv",
  da: "da", dan: "da",
  no: "no", nor: "no",
  fi: "fi", fin: "fi",
  ja: "ja", jpn: "ja",
  zh: "zh", zho: "zh", chi: "zh",
  ko: "ko", kor: "ko",
};

// A tag set off by "_", "/", "|" or brackets counts in any case ("Main_en", "Main (FR)"). After a
// space, a hyphen or a dot it must be upper case, so "Check it" and "Sign-in" keep their last word.
const MARKED = /^(.*\S)\s*(?:[_/|]\s*|[([]\s*)([A-Za-z]{2,8})\s*[)\]]?$/;
const SPACED = /^(.*\S)(?:\s+|\s*[-–—.:]\s*)([A-Z]{2,3})$/;

const key = (s) =>
  String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// "Location_EN" -> { base: "location", lang: "en", bare: "Location" }. lang is null without a tag.
export function nameParts(name) {
  const raw = String(name ?? "").trim();
  for (const re of [MARKED, SPACED]) {
    const m = raw.match(re);
    const lang = m ? LANGS[m[2].toLowerCase()] : null;
    if (lang && key(m[1])) return { base: key(m[1]), lang, bare: m[1].trim() };
  }
  return { base: key(raw), lang: null, bare: raw };
}

export const baseKey = (name) => nameParts(name).base;

// Same section in another language, or under another spelling of the same name?
export const sameBase = (a, b) => !!baseKey(a) && baseKey(a) === baseKey(b);

// Can `to` be `from` after a move: the same base, and no clash of languages ("Location" may become
// "Location_EN"; "Location_EN" never becomes "Location_GER").
export function sameSection(from, to) {
  const a = nameParts(from);
  const b = nameParts(to);
  return !!a.base && a.base === b.base && (!a.lang || !b.lang || a.lang === b.lang);
}

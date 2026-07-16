#!/usr/bin/env node
import { select, input, checkbox, confirm } from '@inquirer/prompts';
import { Command, Help } from 'commander';
import fsSync from 'fs';
import * as fs from 'fs/promises';
import fs__default from 'fs/promises';
import { stdin, env } from 'process';
import open from 'open';
import path, { join, resolve } from 'path';
import { z } from 'zod';
import { glob } from 'glob';
import ignore from 'ignore';
import { pathToFileURL } from 'url';
import * as minimatch from 'minimatch';
import { minimatch as minimatch$1 } from 'minimatch';
import { parse, stringify } from 'yaml';
import { fromError } from 'zod-validation-error';
import yaml from 'js-yaml';
import PO from 'pofile';
import { Parser, Language, Query } from 'web-tree-sitter';

const nodeParts = process.versions.node.split(".").map(Number);
const major = nodeParts[0] ?? 0;
const minor = nodeParts[1] ?? 0;
if (major < 20 || major === 20 && minor < 11) {
  console.error(
    "\x1B[31mError: Babli CLI requires Node.js version 20.11 or higher\x1B[0m"
  );
  console.error(`Current version: ${process.versions.node}`);
  process.exit(1);
}

const Reset = "\x1B[0m";
const Bold = "\x1B[1m";
const Dim = "\x1B[2m";
const FgRed = "\x1B[31m";
const FgGreen = "\x1B[32m";
const FgYellow = "\x1B[33m";
const FgBlue = "\x1B[34m";

function analyzeFilePatterns({
  translationFilesConfig,
  defaultFilePattern
}) {
  const translationFilesConfigsByLang = /* @__PURE__ */ new Map();
  for (const file of translationFilesConfig) {
    if ("languages" in file && file.languages) {
      if (Array.isArray(file.languages)) {
        for (const lang of file.languages) {
          translationFilesConfigsByLang.set(lang, file);
        }
      } else if (typeof file.languages === "string") {
        translationFilesConfigsByLang.set(file.languages, file);
      }
    }
  }
  function firstFilePatternWithoutLanguage() {
    for (const file of translationFilesConfig) {
      if (!("languages" in file)) {
        return file.path;
      }
    }
    return void 0;
  }
  const alreadyWarned = /* @__PURE__ */ new Set();
  function warnMissingPatternForLanguage(lang) {
    if (alreadyWarned.has(lang)) {
      return;
    }
    alreadyWarned.add(lang);
    console.warn(
      `${FgYellow}Could not determine file path for language: ${lang}${Reset}`
    );
  }
  function getFilePatternOrPath({
    lang
  }) {
    const file = translationFilesConfigsByLang.get(lang);
    if (file) {
      return file.path;
    } else {
      const defaultPath = defaultFilePattern ?? firstFilePatternWithoutLanguage();
      if (defaultPath) {
        return defaultPath;
      } else {
        warnMissingPatternForLanguage(lang);
        return void 0;
      }
    }
  }
  return {
    getFilePatternOrPath
  };
}

const zFileFormat = z.enum([
  "json",
  "yaml",
  "neon",
  "flutterArb",
  "typescript",
  "po"
]);
const defaultHost = "https://www.babli.ai";
const zYamlOptions = z.object({
  version: z.string().optional()
});
const zFileOptions = z.object({
  nested: z.boolean().default(true).describe(
    `Define if keys should be exported as nested values \`{ "a": { "b": "x"}}\` or not nested \`{ "a.b": "x" }\``
  ),
  topLevelLanguageCode: z.boolean().default(false),
  pullWithEmptyValues: z.boolean().default(false),
  yaml: zYamlOptions.default({}),
  sortBy: z.union([z.literal("key"), z.literal("value"), z.literal("original")]).default("original")
});
const zTranslationFileConfig = z.object({
  path: z.string().describe(
    "The path to the translation file. Use {{lang}} placeholder to define the language code."
  ),
  /**
   * when not provided, we will use all languages found by the pattern for push, and all languages not included in other patterns for pull
   */
  languages: z.array(z.string()).describe(
    "Babli will autodetect languages by default, but in case you need different languages with different languages, you can define the languages here."
  ).optional(),
  format: zFileFormat.optional().describe(
    "Babli will autodetect format from file extensions. But if using non-standard extensions, you can change format here."
  ),
  namespace: z.string().optional().describe(
    "Fixed namespace for all keys from this file entry. Mutually exclusive with {{namespace}} in path."
  ),
  mapLocalToRemote: z.record(z.string(), z.string()).optional().describe(
    'Maps local file language codes to remote Babli language codes. E.g. { "en": "en-US", "de": "de-DE" }. Unmapped codes pass through as-is.'
  ),
  transform: z.string().optional().describe(
    "Path to a custom transform file (.ts/.js) for non-standard file formats. The transform handles push/pull for all languages in a single file."
  )
}).merge(zFileOptions);
const zConfigFileInternal = z.object({
  projectId: z.string().describe("The project ID. You can find it in the project settings."),
  sortBy: z.union([z.literal("key"), z.literal("value"), z.literal("original")]).default("original").describe("How to sort the keys in the file"),
  /**
   * this is needed for the case when we have multiple files with pattern
   */
  defaultFilePattern: z.string().optional().describe("HIDDEN"),
  translationFiles: z.array(zTranslationFileConfig).describe("Source files for the translations."),
  // defaultFormat: zFileFormat.optional(),
  // defaultOptions: zFileOptions.optional(),
  defaultFile: z.string().optional().describe("HIDDEN"),
  /**
   * for development only
   */
  host: z.string().default(defaultHost).describe("HIDDEN"),
  emptyValueString: z.string().nullable().default(null).describe(
    `In case you use some specific value to mark the value is not translated yet,
For example 'NOT_TRANSLATED' or an empty string, You can define it here.`
  )
});
const zTranslationFileConfigInput = zTranslationFileConfig.extend({
  /**
   * the same as languages with only one language
   */
  language: z.string().optional()
});
const zConfigFileInput = zConfigFileInternal.extend({
  translationFiles: z.array(zTranslationFileConfigInput)
});

function getNamespace$1(key) {
  if ("namespace" in key) {
    return key.namespace;
  }
  return key.local?.namespace ?? key.server?.namespace ?? "";
}
function getComparisonKey(key) {
  return `${getNamespace$1(key)}:${key.key}`;
}
function formatNamespacedKey(key) {
  const namespace = getNamespace$1(key);
  return namespace ? `${key.key} [${namespace}]` : key.key;
}

function compareLocalAndServer(languagesOnServer, languagesOnLocal, mergedKeysByKeyByNamespace, emptyValueString) {
  const missingLanguagesOnLocal = /* @__PURE__ */ new Set();
  const missingLanguagesOnServer = /* @__PURE__ */ new Set();
  for (const lang of languagesOnServer) {
    if (!languagesOnLocal.has(lang)) {
      missingLanguagesOnLocal.add(lang);
    }
  }
  for (const lang of languagesOnLocal) {
    if (!languagesOnServer.has(lang)) {
      missingLanguagesOnServer.add(lang);
    }
  }
  const missingKeysOnLocal = {};
  const missingKeysOnServer = {};
  const missingTranslationsOnLocalPerLanguage = {};
  const missingTranslationsOnServerPerLanguage = {};
  const differentTranslationsLanguage = {};
  const missingOrDifferentKeysOnServer = {};
  for (const mergedKeysByKey of Object.values(mergedKeysByKeyByNamespace)) {
    for (const key of Object.values(mergedKeysByKey)) {
      if (!key.local) {
        missingKeysOnLocal[getComparisonKey(key)] = key;
      }
      if (!key.server) {
        const comparisonKey = getComparisonKey(key);
        missingKeysOnServer[comparisonKey] = key;
        missingOrDifferentKeysOnServer[comparisonKey] = key;
      }
      for (const [lang, translation] of Object.entries(key.translations)) {
        const configuredEmptyOnBothSides = emptyValueString === "" && translation?.local?.value == null && translation?.server?.currentValue === "";
        if (translation?.local?.value == void 0 && translation?.server?.currentValue != void 0 && !configuredEmptyOnBothSides) {
          missingTranslationsOnLocalPerLanguage[lang] ?? (missingTranslationsOnLocalPerLanguage[lang] = []);
          missingTranslationsOnLocalPerLanguage[lang].push(key);
        }
        if (translation?.server?.currentValue == void 0 && translation?.local?.value != void 0) {
          missingTranslationsOnServerPerLanguage[lang] ?? (missingTranslationsOnServerPerLanguage[lang] = []);
          missingTranslationsOnServerPerLanguage[lang].push(key);
          missingOrDifferentKeysOnServer[getComparisonKey(key)] = key;
        }
        if (translation?.local?.value != void 0 && translation?.server?.currentValue != void 0 && translation.local.value !== translation.server.currentValue) {
          differentTranslationsLanguage[lang] ?? (differentTranslationsLanguage[lang] = []);
          differentTranslationsLanguage[lang].push(key);
          missingOrDifferentKeysOnServer[getComparisonKey(key)] = key;
        }
      }
    }
  }
  let needPull = false;
  let needPush = false;
  if (missingLanguagesOnLocal.size !== 0) {
    needPull = true;
  }
  if (missingLanguagesOnServer.size !== 0) {
    needPush = true;
  }
  if (Object.keys(missingKeysOnLocal).length !== 0) {
    needPull = true;
  }
  if (Object.keys(missingKeysOnServer).length !== 0) {
    needPush = true;
  }
  if (Object.keys(missingTranslationsOnLocalPerLanguage).length !== 0) {
    needPull = true;
  }
  if (Object.keys(missingTranslationsOnServerPerLanguage).length !== 0) {
    needPush = true;
  }
  if (Object.keys(differentTranslationsLanguage).length !== 0) {
    needPush = true;
  }
  return {
    needPull,
    needPush,
    missingLanguagesOnServer,
    missingKeysOnServer,
    missingTranslationsOnServerPerLanguage,
    differentTranslationsLanguage,
    missingKeysOnLocal,
    missingTranslationsOnLocalPerLanguage,
    missingOrDifferentKeysOnServer
  };
}

function exists(value, message) {
  if (value === null || value === void 0) {
    throw new Error(message ?? "Assertion failed: Value is null or undefined");
  }
  return value;
}
function assertNever(x) {
  throw new Error(`Unexpected value: ${x}`);
}

function nonNullable(value) {
  return value !== null && value !== void 0;
}

function computePushPlan(comparison) {
  const newLanguages = Array.from(
    comparison.missingLanguagesOnServer
  ).map((lang) => ({
    code: lang,
    instructions: null,
    name: null
  }));
  const newKeys = Object.values(comparison.missingKeysOnServer).map(
    (key) => key.key
  );
  const missingTranslationsPerLanguage = {};
  for (const [lang, keys] of Object.entries(
    comparison.missingTranslationsOnServerPerLanguage
  )) {
    missingTranslationsPerLanguage[lang] = keys.map((k) => k.key);
  }
  const conflicts = [];
  for (const [lang, keys] of Object.entries(
    comparison.differentTranslationsLanguage
  )) {
    for (const key of keys) {
      const local = key.translations[lang]?.local?.value;
      const server = key.translations[lang]?.server?.currentValue;
      if (local != void 0 && server != void 0) {
        conflicts.push({
          key: key.key,
          language: lang,
          localValue: local,
          serverValue: server
        });
      }
    }
  }
  const hasChanges = newLanguages.length > 0 || newKeys.length > 0 || Object.keys(missingTranslationsPerLanguage).length > 0 || conflicts.length > 0;
  return {
    newLanguages,
    newKeys,
    missingTranslationsPerLanguage,
    conflicts,
    hasChanges
  };
}
function buildPushPayload(projectId, comparison) {
  return {
    projectId,
    newLanguages: Array.from(comparison.missingLanguagesOnServer).map(
      (lang) => ({
        code: lang,
        instructions: null,
        name: null
      })
    ),
    input: {
      markAllAsPreferred: false,
      keysToRemove: comparison.keysToRemove ?? [],
      keys: Object.values(comparison.missingOrDifferentKeysOnServer).map(
        (key) => buildKeyPayload(key)
      )
    }
  };
}
function buildKeyPayload(key) {
  return {
    key: key.key,
    description: key.local?.description,
    namespace: key.local?.namespace ?? "",
    source: key.local?.source ?? "",
    translations: Object.entries(key.translations).map(([lang, translation]) => {
      const value = translation.local?.value;
      if (value === void 0 || value === null) {
        return null;
      }
      return { language: lang, value };
    }).filter(nonNullable)
  };
}

function computeStatus(comparison, languagesOnServer, languagesOnLocal) {
  const synced = [...languagesOnServer].filter((l) => languagesOnLocal.has(l));
  const localOnly = [...languagesOnLocal].filter(
    (l) => !languagesOnServer.has(l)
  );
  const serverOnly = [...languagesOnServer].filter(
    (l) => !languagesOnLocal.has(l)
  );
  const newKeys = Object.values(
    comparison.missingKeysOnServer
  ).map((key) => ({
    key: key.key,
    namespace: getNamespace$1(key)
  }));
  const changedValues = [];
  for (const [lang, keys] of Object.entries(
    comparison.differentTranslationsLanguage
  )) {
    for (const key of keys) {
      const local = key.translations[lang]?.local?.value;
      const server = key.translations[lang]?.server?.currentValue;
      if (local != void 0 && server != void 0) {
        changedValues.push({
          key: key.key,
          language: lang,
          localValue: local,
          serverValue: server
        });
      }
    }
  }
  const missingTranslationsOnServer = {};
  for (const [lang, keys] of Object.entries(
    comparison.missingTranslationsOnServerPerLanguage
  )) {
    missingTranslationsOnServer[lang] = keys.map((k) => k.key);
  }
  const missingKeys = Object.values(
    comparison.missingKeysOnLocal
  ).map((key) => ({
    key: key.key,
    namespace: getNamespace$1(key)
  }));
  const missingTranslationsOnLocal = {};
  for (const [lang, keys] of Object.entries(
    comparison.missingTranslationsOnLocalPerLanguage
  )) {
    missingTranslationsOnLocal[lang] = keys.map((k) => k.key);
  }
  const serverOnlyKeys = Object.values(
    comparison.missingKeysOnLocal
  ).map((key) => ({
    key: key.key,
    namespace: getNamespace$1(key)
  }));
  return {
    languages: { synced, localOnly, serverOnly },
    toPush: {
      newKeys,
      changedValues,
      missingTranslations: missingTranslationsOnServer
    },
    toPull: {
      missingKeys,
      missingTranslations: missingTranslationsOnLocal
    },
    issues: { serverOnlyKeys },
    needPush: comparison.needPush,
    needPull: comparison.needPull
  };
}

function detectFormatFromExtension(fileName) {
  const extension = fileName.split(".").pop();
  if (extension === "json") {
    return "json";
  }
  if (extension === "yml" || extension === "yaml") {
    return "yaml";
  }
  if (extension === "neon") {
    return "neon";
  }
  if (extension === "arb") {
    return "flutterArb";
  }
  if (extension === "ts" || extension === "tsx" || extension === "js") {
    return "typescript";
  }
  if (extension === "po") {
    return "po";
  }
  return void 0;
}

const manuallyIgnored = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  ".next",
  ".cache",
  "dist",
  "build"
]);
async function findIgnorePatterns(fileAPI, basePath = ".") {
  let gitIgnoreFile = "";
  try {
    const gitIgnorePath = basePath === "." ? ".gitignore" : `${basePath}/.gitignore`;
    if (await fileAPI.fileExists(gitIgnorePath)) {
      gitIgnoreFile = await fileAPI.readFile(gitIgnorePath);
    }
  } catch {
  }
  const ig = ignore().add(gitIgnoreFile);
  return {
    ig,
    shouldIgnore: (path) => {
      const parts = path.split("/");
      const lastPart = parts[parts.length - 1];
      return ig.ignores(path) || manuallyIgnored.has(lastPart);
    }
  };
}

const popularLanguagesToDetect = /* @__PURE__ */ new Set([
  "en",
  "en-US",
  "en-GB",
  "es",
  "es-ES",
  "es-MX",
  "fr",
  "fr-FR",
  "fr-CA",
  "de",
  "de-DE",
  "de-AT",
  "zh",
  "zh-CN",
  "zh-TW",
  "zh-HK",
  "pt",
  "pt-PT",
  "pt-BR",
  "ru",
  "ru-RU",
  "ja",
  "ja-JP",
  "ar",
  "ar-SA",
  "ar-EG",
  "it",
  "it-IT",
  "nl",
  "nl-NL",
  "nl-BE",
  "ko",
  "ko-KR",
  "hi",
  "hi-IN",
  "tr",
  "tr-TR",
  "pl",
  "pl-PL",
  "id",
  "id-ID",
  "ms",
  "ms-MY",
  "th",
  "th-TH",
  "vi",
  "vi-VN",
  "sv",
  "sv-SE",
  "da",
  "da-DK",
  "fi",
  "fi-FI",
  "no",
  "no-NO",
  "cs",
  "cs-CZ",
  "sk",
  "sk-SK",
  "el",
  "el-GR",
  "hu",
  "hu-HU",
  "ro",
  "ro-RO",
  "bg",
  "bg-BG",
  "uk",
  "uk-UA",
  "he",
  "he-IL",
  "hr",
  "hr-HR",
  "ca",
  "ca-ES",
  "sr",
  "sr-RS",
  "sl",
  "sl-SI",
  "lt",
  "lt-LT"
]);

const contriesPerLanguage = {
  ab: ["GE"],
  aa: ["ER", "DJ"],
  af: ["ZA", "NA"],
  ak: ["GH"],
  sq: ["AL", "XK"],
  am: ["ET"],
  ar: [
    "DZ",
    "BH",
    "TD",
    "KM",
    "DJ",
    "EG",
    "ER",
    "IQ",
    "IL",
    "JO",
    "KW",
    "LB",
    "LY",
    "MR",
    "MA",
    "OM",
    "PS",
    "QA",
    "SA",
    "SO",
    "SS",
    "SD",
    "SY",
    "TN",
    "AE",
    "YE"
  ],
  an: ["ES"],
  hy: ["AM"],
  as: ["IN"],
  av: ["RU"],
  ae: [],
  ay: ["BO"],
  az: ["AZ"],
  bm: ["ML"],
  ba: ["RU"],
  eu: ["ES"],
  be: ["BY"],
  bn: ["BD", "IN"],
  bh: ["IN"],
  bi: ["VU"],
  bs: ["BA"],
  br: ["FR"],
  bg: ["BG"],
  my: ["MM"],
  ca: ["ES", "AD"],
  ch: ["GU"],
  ce: ["RU"],
  ny: ["MW"],
  zh: ["CN", "SG", "TW"],
  "zh-Hans": ["CN", "SG"],
  "zh-Hant": ["TW", "HK", "MO"],
  cv: ["RU"],
  kw: ["GB"],
  co: ["FR"],
  cr: ["CA"],
  hr: ["HR", "BA"],
  cs: ["CZ"],
  da: ["DK", "GL"],
  dv: ["MV"],
  nl: ["NL", "BE", "SR", "CW", "SX", "BQ"],
  dz: ["BT"],
  en: ["US", "GB", "AU", "CA", "IE", "NZ", "ZA", "IN", "SG", "PH"],
  eo: [],
  et: ["EE"],
  ee: ["GH", "TG"],
  fo: ["FO"],
  fj: ["FJ"],
  fi: ["FI"],
  fr: [
    "FR",
    "BE",
    "BF",
    "BI",
    "CM",
    "CA",
    "CF",
    "TD",
    "KM",
    "CG",
    "CD",
    "CI",
    "DJ",
    "GQ",
    "GA",
    "GF",
    "GN",
    "GP",
    "LU",
    "MG",
    "ML",
    "MQ",
    "MC",
    "NE",
    "RW",
    "RE",
    "BL",
    "MF",
    "PM",
    "SN",
    "SC",
    "CH",
    "TG",
    "TN",
    "VU",
    "WF",
    "YT"
  ],
  ff: ["SN", "ML", "MR", "NE", "GN", "SL", "BF"],
  gl: ["ES"],
  gd: ["GB"],
  gv: ["GB"],
  ka: ["GE"],
  de: ["DE", "AT", "BE", "CH", "LI", "LU"],
  el: ["GR", "CY"],
  kl: ["GL"],
  gn: ["PY"],
  gu: ["IN"],
  ht: ["HT"],
  ha: ["NG", "NE", "GH"],
  he: ["IL"],
  hz: ["NA"],
  hi: ["IN"],
  ho: [],
  hu: ["HU"],
  is: ["IS"],
  io: [],
  ig: ["NG"],
  id: ["ID"],
  in: ["ID"],
  ia: [],
  ie: [],
  iu: ["CA"],
  ik: ["US"],
  ga: ["IE"],
  it: ["IT", "SM", "CH", "VA"],
  ja: ["JP"],
  jv: ["ID"],
  kn: ["IN"],
  kr: ["NE"],
  ks: ["IN", "PK"],
  kk: ["KZ"],
  km: ["KH"],
  ki: ["KE"],
  rw: ["RW"],
  rn: ["BI"],
  ky: ["KG"],
  kv: ["RU"],
  kg: ["CG"],
  ko: ["KR", "KP"],
  ku: ["IQ", "TR", "SY", "IR"],
  kj: ["AO"],
  lo: ["LA"],
  la: [],
  lv: ["LV"],
  li: ["BE", "NL"],
  ln: ["CG", "CD", "CF", "GA"],
  lt: ["LT"],
  lu: ["CD"],
  lg: ["UG"],
  lb: ["LU"],
  mk: ["MK"],
  mg: ["MG"],
  ms: ["MY", "BN", "SG"],
  ml: ["IN"],
  mt: ["MT"],
  mi: ["NZ"],
  mr: ["IN"],
  mh: ["MH"],
  mo: [],
  mn: ["MN"],
  na: ["NR"],
  nv: ["US"],
  ng: ["NA"],
  nd: ["ZW"],
  ne: ["NP"],
  no: ["NO"],
  nb: ["NO"],
  nn: ["NO"],
  ii: ["CN"],
  oc: ["FR"],
  oj: ["CA"],
  cu: [],
  or: ["IN"],
  om: ["ET", "KE"],
  os: ["GE", "RU"],
  pi: [],
  ps: ["AF"],
  fa: ["IR", "AF"],
  pl: ["PL"],
  pt: ["PT", "BR", "AO", "CV", "GW", "MO", "MZ", "ST", "TL"],
  pa: ["IN", "PK"],
  qu: ["PE", "BO", "EC"],
  rm: ["CH"],
  ro: ["RO", "MD"],
  ru: ["RU", "BY", "KZ", "KG", "TJ", "TM", "UA"],
  se: ["NO", "SE", "FI"],
  sm: ["WS"],
  sg: ["CF"],
  sa: ["IN"],
  sr: ["RS", "ME", "BA", "XK"],
  sh: ["RS", "HR", "BA", "ME"],
  st: ["LS", "ZA"],
  tn: ["BW", "ZA"],
  sn: ["ZW"],
  sd: ["PK"],
  si: ["LK"],
  ss: ["SZ", "ZA"],
  sk: ["SK"],
  sl: ["SI"],
  so: ["SO", "DJ", "ET"],
  nr: ["ZA"],
  es: [
    "ES",
    "AR",
    "BO",
    "CL",
    "CO",
    "CR",
    "CU",
    "DO",
    "EC",
    "SV",
    "GQ",
    "GT",
    "HN",
    "MX",
    "NI",
    "PA",
    "PY",
    "PE",
    "PR",
    "UY",
    "VE"
  ],
  su: ["ID"],
  sw: ["TZ", "KE", "UG", "RW", "CD"],
  sv: ["SE", "FI"],
  tl: ["PH"],
  ty: ["PF"],
  tg: ["TJ"],
  ta: ["IN", "LK", "SG", "MY"],
  tt: ["RU"],
  te: ["IN"],
  th: ["TH"],
  bo: ["CN", "IN"],
  ti: ["ET", "ER"],
  to: ["TO"],
  ts: ["ZA"],
  tr: ["TR", "CY"],
  tk: ["TM"],
  tw: ["GH"],
  ug: ["CN"],
  uk: ["UA"],
  ur: ["PK", "IN"],
  uz: ["UZ"],
  ve: ["ZA"],
  vi: ["VN"],
  vo: [],
  wa: ["BE"],
  cy: ["GB"],
  wo: ["SN"],
  fy: ["NL"],
  xh: ["ZA"],
  yi: ["IL"],
  ji: ["IL"],
  yo: ["NG"],
  za: ["CN"],
  zu: ["ZA"]
};

const allCodes = new Set(
  Object.entries(contriesPerLanguage).flatMap(([code, countries]) => {
    return [code, ...countries.map((countryCode) => `${code}-${countryCode}`)];
  })
);
const DELIMITERS = [".", "_", "-"];
function findLanguageCodeInFileName(fileName, customLanguageCodes, limited = false) {
  const nameWithoutExtension = fileName.replace(/\.[^/.]+$/, "");
  const corrected = nameWithoutExtension.replace("_", "-");
  if (popularLanguagesToDetect.has(corrected)) {
    return corrected;
  }
  const withoutStandardAdditions = nameWithoutExtension.replace("intl_", "").replace("intl.", "").replace("intl-", "").replace("messages_", "").replace("messages.", "").replace("messages-", "").replace("i18n_", "").replace("i18n.", "").replace("i18n-", "");
  if (popularLanguagesToDetect.has(withoutStandardAdditions)) {
    return withoutStandardAdditions;
  }
  if (limited) {
    return null;
  }
  for (const delimiter of DELIMITERS) {
    const parts = withoutStandardAdditions.split(delimiter);
    for (const part of parts) {
      const corrected2 = part.replace("_", "-");
      if (allCodes.has(corrected2)) {
        return corrected2;
      }
      if (customLanguageCodes.has(corrected2)) {
        return corrected2;
      }
    }
  }
  return null;
}

const supportedExtensions = /* @__PURE__ */ new Set([
  "json",
  "arb",
  "po",
  "yml",
  "yaml",
  "neon"
]);
async function findTranslationFiles(fileAPI, basePath = ".", log = () => {
}) {
  const translationFiles = [];
  const { shouldIgnore } = await findIgnorePatterns(fileAPI, basePath);
  await walkDirectory(
    fileAPI,
    basePath,
    [],
    translationFiles,
    shouldIgnore,
    log
  );
  return translationFiles;
}
async function walkDirectory(fileAPI, basePath, currentPath, translationFiles, shouldIgnore, log) {
  const pattern = currentPath.length === 0 ? "**/*" : `${currentPath.join("/")}/**/*`;
  const allFiles = await fileAPI.glob(pattern, { cwd: basePath });
  const filesByDirectory = /* @__PURE__ */ new Map();
  const directories = /* @__PURE__ */ new Set();
  for (const filePath of allFiles) {
    if (shouldIgnore(filePath)) {
      log(`Ignoring ${filePath}`);
      continue;
    }
    const pathParts = filePath.split("/");
    const fileName = pathParts[pathParts.length - 1];
    const directoryPath = pathParts.slice(0, -1).join("/");
    const extension = getFileExtension(fileName);
    if (extension && supportedExtensions.has(extension)) {
      if (!filesByDirectory.has(directoryPath)) {
        filesByDirectory.set(directoryPath, []);
      }
      filesByDirectory.get(directoryPath).push(filePath);
    }
    if (pathParts.length > 1) {
      directories.add(directoryPath);
    }
  }
  for (const [directoryPath, files] of filesByDirectory) {
    await processDirectoryFiles(
      fileAPI,
      basePath,
      directoryPath,
      files,
      translationFiles,
      log
    );
  }
}
async function processDirectoryFiles(fileAPI, basePath, directoryPath, files, translationFiles, log) {
  const pathParts = directoryPath ? directoryPath.split("/") : [];
  let isTranslationFolder = false;
  for (const filePath of files) {
    const fileName = filePath.split("/").pop();
    const extension = getFileExtension(fileName);
    if (!extension || !supportedExtensions.has(extension)) {
      continue;
    }
    const potentialLang = findLanguageCodeInFileName(fileName, /* @__PURE__ */ new Set(), true);
    if (potentialLang && popularLanguagesToDetect.has(potentialLang)) {
      const format = detectFormatFromExtension(fileName);
      if (format) {
        isTranslationFolder = true;
        await registerTranslationFile(
          fileAPI,
          basePath,
          filePath,
          fileName,
          potentialLang,
          format,
          translationFiles,
          log
        );
      }
    }
  }
  const directoryName = pathParts[pathParts.length - 1];
  if (directoryName) {
    const potentialLang = findLanguageCodeInFileName(
      directoryName,
      /* @__PURE__ */ new Set(),
      true
    );
    if (potentialLang && popularLanguagesToDetect.has(potentialLang)) {
      for (const filePath of files) {
        const fileName = filePath.split("/").pop();
        const extension = getFileExtension(fileName);
        if (extension && supportedExtensions.has(extension)) {
          const format = detectFormatFromExtension(fileName);
          if (format) {
            await registerTranslationFile(
              fileAPI,
              basePath,
              filePath,
              fileName,
              potentialLang,
              format,
              translationFiles,
              log
            );
          }
        }
      }
    }
  }
  if (isTranslationFolder) {
    for (const filePath of files) {
      const fileName = filePath.split("/").pop();
      const extension = getFileExtension(fileName);
      if (!extension || !supportedExtensions.has(extension)) {
        continue;
      }
      const potentialLang = findLanguageCodeInFileName(
        fileName,
        /* @__PURE__ */ new Set(),
        false
      );
      if (potentialLang && extension) {
        const format = detectFormatFromExtension(fileName);
        if (format) {
          const alreadyRegistered = translationFiles.some(
            (f) => f.path === filePath
          );
          if (!alreadyRegistered) {
            await registerTranslationFile(
              fileAPI,
              basePath,
              filePath,
              fileName,
              potentialLang,
              format,
              translationFiles,
              log
            );
          }
        }
      }
    }
  }
}
async function registerTranslationFile(fileAPI, basePath, filePath, fileName, language, format, translationFiles, log) {
  try {
    const fullPath = basePath === "." ? filePath : `${basePath}/${filePath}`;
    const content = await fileAPI.readFile(fullPath);
    translationFiles.push({
      path: filePath,
      detectedLanguageCode: language,
      content,
      name: fileName,
      format
    });
    log(`Found translation file: ${filePath} (${language})`);
  } catch (error) {
    log(`Failed to read translation file ${filePath}: ${error}`);
  }
}
function getFileExtension(fileName) {
  const parts = fileName.split(".");
  return parts.length > 1 ? parts.pop() : void 0;
}

function langFilePathToRegex(langFilePath) {
  const re = minimatch.makeRe(langFilePath, {
    matchBase: true
  });
  const reString = re.source;
  const modified = reString.replace("\\{\\{lang\\}\\}", "([a-zA-Z_-]+)");
  return new RegExp(modified);
}
function namespaceFilePathToRegex(namespaceFilePath) {
  const re = minimatch.makeRe(namespaceFilePath, {
    matchBase: true
  });
  const reString = re.source;
  const modified = reString.replace("\\{\\{namespace\\}\\}", "(.+)").replace("\\{\\{source\\}\\}", "(.+)");
  return new RegExp(modified);
}

var __defProp$1 = Object.defineProperty;
var __defNormalProp$1 = (obj, key, value) => key in obj ? __defProp$1(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField$1 = (obj, key, value) => __defNormalProp$1(obj, key + "" , value);
async function gatherLocalFiles(translationFilesConfig, fileAPI, cwd) {
  const allFilesByPattern = {};
  const languagesInConfig = new AllLanguagesGatherer(translationFilesConfig);
  for (const fileConfig of translationFilesConfig) {
    if (fileConfig.transform) {
      continue;
    }
    const files = [];
    const pathPattern = fileConfig.path.replace(/^\.\//, "");
    const globPath = pathPattern.replace("{{lang}}", "*").replace("{{namespace}}", "**/*").replace("{{source}}", "**/*");
    const foundFilePaths = await fileAPI.glob(globPath, {
      cwd
    });
    for (const filePath of foundFilePaths) {
      let foundLang = null;
      if (pathPattern.includes("{{lang}}")) {
        const langRegex = langFilePathToRegex(
          pathPattern.replace("{{namespace}}", "**/*").replace("{{source}}", "**/*")
        );
        const match = langRegex.exec(filePath);
        if (!match?.[1]) {
          throw new Error(
            `Failed to match file path: ${filePath} with ${langRegex}`
          );
        }
        foundLang = match[1];
      }
      if (fileConfig.languages?.length === 1) {
        if (foundLang && foundLang !== fileConfig.languages[0]) {
          continue;
        }
        foundLang = fileConfig.languages[0];
      }
      if (foundLang && fileConfig.languages?.length && !fileConfig.languages?.includes(foundLang)) {
        if (!languagesInConfig.has(foundLang)) {
          console.warn(`Ignoring language '${foundLang}' in path ${filePath}`);
        }
        continue;
      }
      if (!foundLang) {
        throw new Error(
          `Failed to match lang for file: ${filePath} use either {{lang}} placeholder or define exactly one language`
        );
      }
      let namespace = "";
      let source = "";
      if (pathPattern.includes("{{namespace}}") || pathPattern.includes("{{source}}")) {
        if (pathPattern.includes("{{namespace}}") && pathPattern.includes("{{source}}")) {
          throw new Error(
            "Can't use both {{namespace}} and {{source}} placeholders"
          );
        }
        const type = pathPattern.includes("{{namespace}}") ? "namespace" : "source";
        const namespaceRegex = namespaceFilePathToRegex(
          pathPattern.replace("{{lang}}", "*")
        );
        const match = namespaceRegex.exec(filePath);
        if (!match?.[1]) {
          throw new Error(
            `Failed to match file path: ${filePath} with ${namespaceRegex}`
          );
        }
        if (type === "namespace") {
          namespace = match[1];
        } else if (type === "source") {
          source = match[1];
        }
      }
      const resolvedNamespace = fileConfig.namespace ?? namespace;
      const remoteLang = fileConfig.mapLocalToRemote?.[foundLang] ?? foundLang;
      const fullPath = filePath;
      const text = await fileAPI.readFile(fullPath);
      const fileFormat = fileConfig.format;
      if (!fileFormat) {
        throw new Error(`File format not found`);
      }
      const res = {
        lang: remoteLang,
        path: filePath,
        content: text,
        pathTemplate: pathPattern,
        fileFormat,
        namespace: resolvedNamespace,
        source,
        usedOptions: fileConfig
      };
      files.push(res);
    }
    allFilesByPattern[pathPattern] = files;
  }
  return allFilesByPattern;
}
class AllLanguagesGatherer {
  constructor(translationFilesConfig) {
    this.translationFilesConfig = translationFilesConfig;
    __publicField$1(this, "allLanguagesInConfig", /* @__PURE__ */ new Set());
    for (const fileConfig of this.translationFilesConfig) {
      if (fileConfig.languages) {
        for (const lang of fileConfig.languages) {
          this.allLanguagesInConfig.add(lang);
        }
      }
    }
  }
  translationFilesConfig;
  has(lang) {
    return this.allLanguagesInConfig.has(lang);
  }
}

function gatherTranslationsFromMaybeNestedObject(source, projectSeparator) {
  const translations = /* @__PURE__ */ new Map();
  if (typeof source !== "object") return translations;
  if (Array.isArray(source)) return translations;
  if (source == null) return translations;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") {
      translations.set(key, {
        value
      });
    } else if (value === null || value === void 0) {
      translations.set(key, {
        value
      });
    } else {
      const nestedTranslations = gatherTranslationsFromMaybeNestedObject(
        value,
        projectSeparator
      );
      for (const [nestedKey, nestedValue] of nestedTranslations.entries()) {
        translations.set(`${key}${projectSeparator}${nestedKey}`, nestedValue);
      }
    }
  }
  return translations;
}

let initialized = null;
async function typescriptProcessor(fileContent, projectSeparator) {
  if (!initialized) {
    await Parser.init({
      locateFile(scriptName) {
        return `/${scriptName}`;
      }
    });
    const parser2 = new Parser();
    const JavaScript2 = await Language.load("/parsers/tree-sitter-tsx.wasm");
    parser2.setLanguage(JavaScript2);
    initialized = { parser: parser2, JavaScript: JavaScript2 };
  }
  const { parser, JavaScript } = initialized;
  const tree = parser.parse(fileContent);
  if (!tree) {
    return { keys: /* @__PURE__ */ new Map(), fileFormat: "typescript" };
  }
  let translations = /* @__PURE__ */ new Map();
  const startingNode = findStartingNode(tree.rootNode, JavaScript);
  if (startingNode) {
    const plainObject = extractObject(startingNode);
    translations = gatherTranslationsFromMaybeNestedObject(
      plainObject,
      projectSeparator
    );
  }
  return { keys: translations, fileFormat: "typescript" };
}
function findStartingNode(node, JavaScript) {
  let queryStr = `
  (export_statement (expression) @exported)
  `;
  let query = new Query(JavaScript, queryStr);
  let matches = query.matches(node);
  for (const match of matches) {
    for (const capture of match.captures) {
      if (capture.name === "exported") {
        return capture.node;
      }
    }
  }
  queryStr = `
  (expression_statement (assignment_expression left: (member_expression
    object: (identifier) @object
    property: (property_identifier) @property
  ) right: (object) @exported))
  `;
  query = new Query(JavaScript, queryStr);
  matches = query.matches(node);
  for (const match of matches) {
    if (match.captures.some(
      (capture) => capture.name === "object" && capture.node.text === "module"
    ) && match.captures.some(
      (capture) => capture.name === "property" && capture.node.text === "exports"
    )) {
      for (const capture of match.captures) {
        if (capture.name === "exported") {
          return capture.node;
        }
      }
    }
  }
  return null;
}
function extractObject(node) {
  if (node.type !== "object") {
    throw new Error("Node is not an object.");
  }
  const obj = {};
  node.namedChildren.forEach((child) => {
    if (child?.type === "pair") {
      const keyNode = child.namedChildren.find(
        (n) => n?.type === "property_identifier" || n?.type === "string"
      );
      const valueNode = child.namedChildren.find(
        (n) => n?.type !== "property_identifier" && (n?.type === "string" || n?.type === "object")
      );
      if (keyNode && valueNode) {
        const key = keyNode.text;
        let value;
        if (valueNode.type === "object") {
          value = extractObject(valueNode);
        } else {
          value = valueNode.text.slice(1, -1);
        }
        obj[key] = value;
      }
    }
  });
  return obj;
}

const fileProcessors = {
  json: async (fileContent, projectSeparator) => {
    const parsed = JSON.parse(fileContent);
    return {
      keys: gatherTranslationsFromMaybeNestedObject(parsed, projectSeparator),
      fileFormat: "json"
    };
  },
  yaml: async (fileContent, projectSeparator, fileOptions, languageCode) => {
    let parsed = yaml.load(fileContent, {
      json: true
    });
    if (fileOptions?.topLevelLanguageCode) {
      parsed = parsed[languageCode];
    }
    return {
      keys: gatherTranslationsFromMaybeNestedObject(parsed, projectSeparator),
      fileFormat: "yaml"
    };
  },
  neon: async (fileContent, projectSeparator, fileOptions, languageCode) => {
    let parsed = yaml.load(fileContent, { json: true });
    if (fileOptions?.topLevelLanguageCode) {
      parsed = parsed[languageCode];
    }
    return {
      keys: gatherTranslationsFromMaybeNestedObject(parsed, projectSeparator),
      fileFormat: "neon"
    };
  },
  typescript: typescriptProcessor,
  po: async (fileContent, projectSeparator) => {
    const translations = /* @__PURE__ */ new Map();
    const po = PO.parse(fileContent);
    for (const item of po.items) {
      if (!item.msgid) continue;
      if (item.msgid_plural && item.msgstr.length > 1) {
        const pluralForms = ["zero", "one", "two", "few", "many", "other"];
        for (let i = 0; i < item.msgstr.length; i++) {
          if (item.msgstr[i]) {
            const pluralKey = `${item.msgid}${projectSeparator}${pluralForms[i] || i}`;
            const val = {
              value: item.msgstr[i],
              meta: {
                msgctxt: item.msgctxt,
                references: item.references,
                extractedComments: item.extractedComments,
                flags: item.flags
              }
            };
            if (item.comments.length > 0) {
              val.description = item.comments.join(" ");
            }
            translations.set(pluralKey, val);
          }
        }
      } else {
        const val = {
          value: item.msgstr[0] || null,
          meta: {
            msgctxt: item.msgctxt,
            references: item.references,
            extractedComments: item.extractedComments,
            flags: item.flags
          }
        };
        if (item.comments.length > 0) {
          val.description = item.comments.join(" ");
        }
        translations.set(item.msgid, val);
      }
    }
    return { keys: translations, fileFormat: "po" };
  },
  flutterArb: async (fileContent) => {
    const translations = /* @__PURE__ */ new Map();
    const parsed = JSON.parse(fileContent);
    for (const [key, value] of Object.entries(parsed)) {
      if (key.startsWith("@")) continue;
      if (typeof value === "string") {
        const metadata = parsed[`@${key}`];
        const description = typeof metadata?.description === "string" ? metadata.description : void 0;
        const val = {
          value,
          meta: metadata ?? {}
        };
        if (description) {
          val.description = description;
        }
        translations.set(key, val);
      } else {
        throw new Error(
          `We don't support nested objects in Flutter ARB files yet. Key: ${key}`
        );
      }
    }
    return { keys: translations, fileFormat: "flutterArb" };
  }
};
async function detectAndProcessTranslationFile({
  format,
  content,
  projectSeparator,
  fileOptions,
  langCode
}) {
  switch (format) {
    case "json": {
      const processor = fileProcessors.json;
      return processor(content, projectSeparator, fileOptions, langCode);
    }
    case "flutterArb": {
      const processor = fileProcessors.flutterArb;
      return processor(content, projectSeparator);
    }
    case "typescript": {
      const processor = fileProcessors.typescript;
      return processor(content, projectSeparator);
    }
    case "yaml": {
      const processor = fileProcessors.yaml;
      return processor(content, projectSeparator, fileOptions, langCode);
    }
    case "neon": {
      const processor = fileProcessors.neon;
      return processor(content, projectSeparator, fileOptions, langCode);
    }
    case "po": {
      const processor = fileProcessors.po;
      return processor(content, projectSeparator, fileOptions, langCode);
    }
    default:
      return assertNever(format);
  }
}

function processLocalValue(value, emptyValueString) {
  if (emptyValueString != null && value === emptyValueString) {
    return null;
  }
  return value;
}

async function gatherLocalKeys({
  allFilesByPattern,
  keySeparator,
  emptyValueString
}) {
  var _a, _b;
  const localAllFiles = [];
  const mergedKeysByKeyByNamespace = {};
  const mergedKeysInLocalOrder = {};
  const languagesOnLocal = /* @__PURE__ */ new Set();
  for (const allFilesForTemplate of Object.values(allFilesByPattern)) {
    for (const file of allFilesForTemplate) {
      languagesOnLocal.add(file.lang);
      const format = file.fileFormat;
      if (!format) {
        throw new Error(`File format not found`);
      }
      const processed = await detectAndProcessTranslationFile({
        content: file.content,
        format,
        projectSeparator: keySeparator,
        fileOptions: file.usedOptions ?? void 0,
        langCode: file.lang
      });
      const { fileFormat } = processed;
      const keys = extendKeysWithNamespaceAndSource(
        processed.keys,
        file.namespace,
        file.source
      );
      file.fileFormat = fileFormat;
      mergedKeysByKeyByNamespace[_a = file.namespace] ?? (mergedKeysByKeyByNamespace[_a] = {});
      const mergedKeysByKey = mergedKeysByKeyByNamespace[file.namespace];
      for (const [key, val] of keys) {
        if (mergedKeysByKey[key]) {
          mergedKeysByKey[key].translations[file.lang] = {
            local: {
              value: processLocalValue(val.value, emptyValueString)
            }
          };
        } else {
          mergedKeysByKey[key] = {
            key,
            translations: {
              [file.lang]: {
                local: {
                  value: processLocalValue(val.value, emptyValueString)
                }
              }
            },
            local: {
              // filePathTemplate: pathTemplate,
              fileFormat,
              description: val.description,
              meta: val.meta,
              namespace: file.namespace,
              source: file.source
            }
          };
        }
        mergedKeysInLocalOrder[_b = file.path] ?? (mergedKeysInLocalOrder[_b] = { lang: file.lang, keys: [] });
        mergedKeysInLocalOrder[file.path].keys.push(mergedKeysByKey[key]);
      }
    }
    localAllFiles.push(...allFilesForTemplate);
  }
  return {
    languagesOnLocal,
    mergedKeysByKeyByNamespace,
    mergedKeysInLocalOrder
  };
}
function extendKeysWithNamespaceAndSource(keys, namespace, source) {
  return new Map(
    [...keys.entries()].map(([key, value]) => {
      return [
        key,
        {
          ...value,
          namespace,
          source
        }
      ];
    })
  );
}

function gatherServerKeys({
  allServerKeys,
  mergedKeysByKeyByNamespace,
  getLangCode,
  getFilePatternOrPath,
  mergedKeysInLocalOrder
}) {
  var _a;
  for (const serverKey of allServerKeys) {
    mergedKeysByKeyByNamespace[_a = serverKey.namespace] ?? (mergedKeysByKeyByNamespace[_a] = {});
    const mergedKeysByKey = mergedKeysByKeyByNamespace[serverKey.namespace];
    if (mergedKeysByKey[serverKey.key]) {
      mergedKeysByKey[serverKey.key].server = {
        id: serverKey.id,
        description: serverKey.description ?? void 0,
        namespace: serverKey.namespace,
        source: serverKey.source
      };
    } else {
      mergedKeysByKey[serverKey.key] = {
        key: serverKey.key,
        translations: mergedKeysByKey[serverKey.key]?.translations ?? {},
        server: {
          id: serverKey.id,
          description: serverKey.description ?? void 0,
          namespace: serverKey.namespace,
          source: serverKey.source
        }
      };
    }
    for (const translation of serverKey.translations) {
      const lang = getLangCode(translation.languageId);
      if (mergedKeysByKey[serverKey.key].translations[lang]) {
        mergedKeysByKey[serverKey.key].translations[lang].server = {
          id: translation.id,
          approved: translation.approved,
          currentValue: translation.currentVersion.value
        };
      } else {
        mergedKeysByKey[serverKey.key].translations[lang] = {
          server: {
            id: translation.id,
            approved: translation.approved,
            currentValue: translation.currentVersion.value
          }
        };
      }
      const pattern = getFilePatternOrPath({ lang });
      if (pattern) {
        const filePath = pattern.replace("{{lang}}", lang);
        mergedKeysInLocalOrder[filePath] ?? (mergedKeysInLocalOrder[filePath] = { lang, keys: [] });
        mergedKeysInLocalOrder[filePath].keys.push(
          mergedKeysByKey[serverKey.key]
        );
      }
    }
  }
}

async function gatherTransformKeys({
  transformConfigs,
  transforms,
  fileAPI,
  emptyValueString,
  cwd
}) {
  const mergedKeysByKeyByNamespace = {};
  const languagesOnLocal = /* @__PURE__ */ new Set();
  for (const config of transformConfigs) {
    const namespace = exists(config.namespace, "Transform must have namespace");
    const transform = exists(
      transforms.get(config.path),
      `Transform not loaded for "${config.path}"`
    );
    const pathPattern = config.path.replace(/^\.\//, "");
    const fullPath = cwd ? join(cwd, pathPattern) : pathPattern;
    const content = await fileAPI.readFile(fullPath);
    let result;
    try {
      result = transform.push(content);
    } catch (err) {
      throw new Error(
        `Transform push failed for "${config.path}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
    mergedKeysByKeyByNamespace[namespace] ?? (mergedKeysByKeyByNamespace[namespace] = {});
    const mergedKeysByKey = mergedKeysByKeyByNamespace[namespace];
    for (const [lang, keys] of Object.entries(result)) {
      if (config.languages && !config.languages.includes(lang)) {
        continue;
      }
      const remoteLang = config.mapLocalToRemote?.[lang] ?? lang;
      languagesOnLocal.add(remoteLang);
      for (const [key, value] of Object.entries(keys)) {
        if (mergedKeysByKey[key]) {
          mergedKeysByKey[key].translations[remoteLang] = {
            local: {
              value: processLocalValue(value, emptyValueString)
            }
          };
        } else {
          mergedKeysByKey[key] = {
            key,
            translations: {
              [remoteLang]: {
                local: {
                  value: processLocalValue(value, emptyValueString)
                }
              }
            },
            local: {
              fileFormat: "json",
              namespace,
              source: ""
            }
          };
        }
      }
    }
  }
  return { mergedKeysByKeyByNamespace, languagesOnLocal };
}

function generateTranslationConfig(detectedFiles) {
  if (detectedFiles.length === 0) {
    return [
      {
        path: "locales/{{lang}}.json"
      }
    ];
  }
  const patternGroups = /* @__PURE__ */ new Map();
  for (const file of detectedFiles) {
    const pattern = extractPattern(file.path, file.detectedLanguageCode);
    if (!patternGroups.has(pattern)) {
      patternGroups.set(pattern, {
        languages: /* @__PURE__ */ new Set(),
        format: file.format,
        example: file.path
      });
    }
    const group = patternGroups.get(pattern);
    group.languages.add(file.detectedLanguageCode);
    if (!group.format) {
      group.format = file.format;
    }
  }
  const configs = [];
  for (const [pattern, group] of patternGroups) {
    const config = {
      path: pattern
    };
    if (group.languages.size > 1) {
      config.languages = Array.from(group.languages).sort();
    } else if (group.languages.size === 1) {
      config.languages = Array.from(group.languages);
    }
    if (group.format && !isFormatAutoDetectable(pattern, group.format)) {
      config.format = group.format;
    }
    configs.push(config);
  }
  return configs.length > 0 ? configs : [{ path: "locales/{{lang}}.json" }];
}
function replaceLangSegmentInFileName(fileName, languageCode) {
  const extMatch = fileName.match(/\.[^/.]+$/);
  const extension = extMatch ? extMatch[0] : "";
  const nameWithoutExtension = extension ? fileName.slice(0, -extension.length) : fileName;
  const escaped = languageCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[-_]");
  const re = new RegExp(`(^|[._-])${escaped}($|[._-])`);
  if (!re.test(nameWithoutExtension)) {
    return null;
  }
  const replaced = nameWithoutExtension.replace(
    re,
    (_match, before, after) => `${before}{{lang}}${after}`
  );
  return replaced + extension;
}
function extractPattern(filePath, languageCode) {
  const pathParts = filePath.split("/");
  const fileName = pathParts[pathParts.length - 1];
  const replacedFileName = replaceLangSegmentInFileName(fileName, languageCode);
  if (replacedFileName !== null) {
    pathParts[pathParts.length - 1] = replacedFileName;
    return pathParts.join("/");
  }
  const languageIndex = pathParts.findIndex(
    (part) => part.replace(/_/g, "-") === languageCode
  );
  if (languageIndex !== -1) {
    pathParts[languageIndex] = "{{lang}}";
    return pathParts.join("/");
  }
  const fileNameParts = fileName.split(".");
  if (fileNameParts.length > 1) {
    const extension = fileNameParts.pop();
    const baseName = fileNameParts.join(".");
    pathParts[pathParts.length - 1] = `${baseName}.{{lang}}.${extension}`;
  } else {
    pathParts[pathParts.length - 1] = `{{lang}}.${fileName}`;
  }
  return pathParts.join("/");
}
function isFormatAutoDetectable(pattern, format) {
  const extension = pattern.split(".").pop();
  switch (format) {
    case "json":
      return extension === "json";
    case "yaml":
      return extension === "yml" || extension === "yaml";
    case "neon":
      return extension === "neon";
    case "flutterArb":
      return extension === "arb";
    case "po":
      return extension === "po";
    default:
      return false;
  }
}

async function loadConfigFile(fileAPI) {
  const configFiles = ["babli.json", "babli.yml", "babli.yaml"];
  let obj;
  for (const file of configFiles) {
    if (await fileAPI.fileExists(file)) {
      const content = await fileAPI.readFile(file);
      obj = file.endsWith(".json") ? JSON.parse(content) : parse(content);
      break;
    }
  }
  if (!obj) {
    return null;
  }
  try {
    return parseAndExtendCliConfig(obj);
  } catch (err) {
    console.error(
      "Failed to parse config file (babli.json, babli.yml, or babli.yaml)"
    );
    console.error(fromError(err).message);
    throw err;
  }
}
function parseAndExtendCliConfig(obj) {
  const parsed = zConfigFileInput.parse(obj);
  return {
    ...parsed,
    translationFiles: parsed.translationFiles.map(
      (file) => {
        const normalizedFile = {
          ...file,
          path: toPosixPath(file.path),
          ...file.transform ? { transform: toPosixPath(file.transform) } : {}
        };
        validateTranslationFileConfig(normalizedFile);
        const mods = {};
        if ("languages" in normalizedFile) {
          mods.languages = normalizedFile.languages;
        } else if ("language" in normalizedFile && normalizedFile.language) {
          mods.languages = [normalizedFile.language];
        }
        if (!normalizedFile.transform && !mods.format) {
          mods.format = detectFormatFromExtension(normalizedFile.path);
        }
        return { ...normalizedFile, ...mods };
      }
    )
  };
}
function toPosixPath(p) {
  return p.replace(/\\/g, "/");
}
function validateTranslationFileConfig(file) {
  if (file.namespace && file.path.includes("{{namespace}}")) {
    throw new Error(
      `Cannot use both "namespace" and "{{namespace}}" placeholder in path "${file.path}"`
    );
  }
  if (file.transform) {
    if (file.path.includes("{{lang}}")) {
      throw new Error(
        `Transform entries cannot use "{{lang}}" placeholder in path "${file.path}". The transform handles all languages in a single file.`
      );
    }
    if (!file.namespace) {
      throw new Error(
        `Transform entries require an explicit "namespace" for path "${file.path}"`
      );
    }
  }
}

function makeGetLangCode(languages) {
  const langById = languages.reduce(
    (acc, lang) => {
      acc[lang.id] = lang.code;
      return acc;
    },
    {}
  );
  function getLangCode(id) {
    const code = langById[id];
    if (!code) {
      throw new Error(`Language not found: ${id}`);
    }
    return code;
  }
  return getLangCode;
}

function generateFlutterArb(keys, localeCode) {
  const arbStructure = {};
  arbStructure["@@locale"] = localeCode;
  for (const [key, value] of keys) {
    arbStructure[key] = value.value;
    if (value.description) {
      arbStructure[`@${key}`] = {
        // description: value.description,
        ...value.meta ?? {}
      };
      arbStructure[`@${key}`].description = value.description;
    }
  }
  return JSON.stringify(arbStructure, null, 2);
}

function makeFlatObject(keys) {
  const flat = {};
  for (const [key, value] of keys) {
    flat[key] = value.value;
  }
  return flat;
}
function makeNestedObject(keys) {
  const nested = {};
  for (const [key, value] of keys) {
    const parts = key.split(".");
    let current = nested;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current[part]) {
        current[part] = {};
      }
      current = current[part];
    }
    current[parts[parts.length - 1]] = value.value;
  }
  return nested;
}

function generateJson(keys, localeCode, fileOptions) {
  let jsonObject = fileOptions.nested ? makeNestedObject(keys) : makeFlatObject(keys);
  if (fileOptions.topLevelLanguageCode) {
    jsonObject = {
      [localeCode]: jsonObject
    };
  }
  return JSON.stringify(jsonObject, null, 2);
}

function generatePO(keys, localeCode) {
  const po = new PO();
  po.headers = {
    "Content-Type": "text/plain; charset=UTF-8",
    Language: localeCode
  };
  for (const [key, value] of keys) {
    const item = new PO.Item();
    if (key.includes("::")) {
      const [baseKey, pluralForm] = key.split("::");
      if (!baseKey) {
        continue;
      }
      let existingItem = po.items.find(
        (i) => i.msgid === baseKey && i.msgid_plural
      );
      if (!existingItem) {
        existingItem = new PO.Item();
        existingItem.msgid = baseKey;
        existingItem.msgid_plural = `${baseKey}s`;
        existingItem.msgstr = ["", "", "", "", "", ""];
        po.items.push(existingItem);
      }
      const pluralIndex = [
        "zero",
        "one",
        "two",
        "few",
        "many",
        "other"
      ].indexOf(pluralForm ?? "");
      if (pluralIndex >= 0 && value.value) {
        existingItem.msgstr[pluralIndex] = value.value;
      }
    } else {
      item.msgid = key;
      item.msgstr = [value.value ?? ""];
      if (value.description) {
        item.comments = [value.description];
      }
      if (value.meta?.msgctxt) {
        item.msgctxt = value.meta.msgctxt;
      }
      if (value.meta?.references) {
        item.references = value.meta.references;
      }
      if (value.meta?.extractedComments) {
        item.extractedComments = value.meta.extractedComments;
      }
      if (value.meta?.flags) {
        item.flags = value.meta.flags;
      }
      po.items.push(item);
    }
  }
  return po.toString();
}

function generateYaml(keys, localeCode, fileOptions) {
  let yamlObject = fileOptions.nested ? makeNestedObject(keys) : makeFlatObject(keys);
  if (fileOptions.topLevelLanguageCode) {
    yamlObject = {
      [localeCode]: yamlObject
    };
  }
  return stringify(yamlObject, {
    version: "1.1",
    nullStr: "",
    singleQuote: true
  });
}

function generateTranslationFile(keys, format, localeCode, fileOptions) {
  switch (format) {
    case "json":
      return generateJson(keys, localeCode, fileOptions);
    case "yaml":
      return generateYaml(keys, localeCode, fileOptions);
    case "neon":
      return generateYaml(keys, localeCode, fileOptions);
    case "flutterArb":
      return generateFlutterArb(keys, localeCode);
    case "typescript":
      throw new Error("Not implemented");
    case "po":
      return generatePO(keys, localeCode);
  }
}

function invertMap(map) {
  if (!map) return {};
  return Object.fromEntries(
    Object.entries(map).map(([local, remote]) => [remote, local])
  );
}

const KEY = 0;
const VALUE = 1;
function sortKeys({
  sortBy,
  keys
}) {
  if (sortBy === "original") {
    return keys;
  }
  if (sortBy === "key") {
    return keys.sort((a, b) => a[KEY].localeCompare(b[KEY]));
  }
  if (sortBy === "value") {
    return keys.sort((a, b) => {
      const aValue = a[VALUE].value ?? "";
      const bValue = b[VALUE].value ?? "";
      return aValue.localeCompare(bValue);
    });
  }
  return keys;
}

async function prepareFilesToPull(mergedKeysInLocalOrder, mergedKeysByKeyByNamespace, translationFilesConfig, allLanguages, onlyApproved, emptyValueString, selectedKeys) {
  const keysToPullByFile = {};
  translationFilesConfig.forEach((fileConfig) => {
    if (fileConfig.transform) {
      return;
    }
    const localToRemote = fileConfig.mapLocalToRemote ?? {};
    const remoteToLocal = invertMap(fileConfig.mapLocalToRemote);
    const languages = fileConfig.languages ? fileConfig.languages.map((local) => localToRemote[local] ?? local) : allLanguages.map((l) => l.code);
    languages.forEach((remoteLang) => {
      const localLang = remoteToLocal[remoteLang] ?? remoteLang;
      const pathWithLang = fileConfig.path.replace("{{lang}}", localLang);
      const fileFormat = fileConfig.format;
      function insertKeys(path, keys, namespace) {
        const keysInLocalOrder = mergedKeysInLocalOrder[path]?.keys.filter(
          (k) => (k.server?.namespace ?? k.local?.namespace ?? "") === namespace
        );
        const allKeys = keysInLocalOrder ? uniq([...keysInLocalOrder, ...Object.values(keys)]) : Object.values(keys);
        for (const key of allKeys) {
          const translation = key.translations[remoteLang];
          const isSelectedForPull = !selectedKeys || selectedKeys.has(getComparisonKey(key));
          const serverValue = onlyApproved ? translation?.server?.approved ? translation?.server?.currentValue : null : translation?.server?.currentValue;
          const hasServerKey = key.server != null;
          const value = isSelectedForPull && (!selectedKeys || hasServerKey) ? serverValue : translation?.local?.value;
          if (value != void 0 || fileConfig.pullWithEmptyValues) {
            if (!fileFormat) {
              throw new Error("Could not determine file format");
            }
            keysToPullByFile[path] ?? (keysToPullByFile[path] = {
              keys: [],
              lang: remoteLang,
              fileFormat,
              usedConfig: fileConfig
            });
            keysToPullByFile[path].keys.push({
              key: key.key,
              value: value ?? emptyValueString,
              description: key.server?.description,
              meta: key.local?.meta ?? {}
            });
          }
        }
      }
      const namespacesToProcess = fileConfig.namespace ? [
        [
          fileConfig.namespace,
          mergedKeysByKeyByNamespace[fileConfig.namespace] ?? {}
        ]
      ] : fileConfig.path.includes("{{namespace}}") ? Object.entries(mergedKeysByKeyByNamespace) : [["", mergedKeysByKeyByNamespace[""] ?? {}]];
      for (const [namespace, mergedKeysByKey] of namespacesToProcess) {
        const pathWithNamespace = pathWithLang.replace(
          "{{namespace}}",
          namespace
        );
        if (pathWithLang.includes("{{source}}")) {
          const groupedBySource = {};
          for (const key of Object.values(mergedKeysByKey)) {
            const source = key.server?.source ?? "";
            if (!groupedBySource[source]) {
              groupedBySource[source] = {};
            }
            groupedBySource[source][key.key] = key;
          }
          for (const [source, sourceKeys] of Object.entries(groupedBySource)) {
            insertKeys(
              pathWithNamespace.replace("{{source}}", source),
              Object.values(sourceKeys),
              namespace
            );
          }
        } else {
          insertKeys(
            pathWithNamespace,
            Object.values(mergedKeysByKey),
            namespace
          );
        }
      }
    });
  });
  const filesToPull = {};
  for (const [file, { keys, lang, fileFormat, usedConfig }] of Object.entries(
    keysToPullByFile
  )) {
    const keysToUse = keys.map(
      ({ key, value, description, meta }) => {
        return [
          key,
          {
            value,
            description,
            meta
          }
        ];
      }
    );
    const res = generateTranslationFile(
      sortKeys({ sortBy: usedConfig.sortBy, keys: keysToUse }),
      fileFormat,
      lang,
      usedConfig
    );
    filesToPull[file] = res;
  }
  return filesToPull;
}
function uniq(arr) {
  return [...new Set(arr)];
}

function boldInfo(text) {
  console.info(Bold + text + Reset);
}
function greenInfo(text) {
  console.info(FgGreen + text + Reset);
}

function isDoubleWidth(code) {
  return code >= 4352 && code <= 4447 || code >= 11904 && code <= 12350 || code >= 12352 && code <= 13247 || code >= 13312 && code <= 19903 || code >= 19968 && code <= 42191 || code >= 43360 && code <= 43388 || code >= 44032 && code <= 55203 || code >= 63744 && code <= 64255 || code >= 65072 && code <= 65135 || code >= 65281 && code <= 65376 || code >= 65504 && code <= 65510 || code >= 131072 && code <= 196605 || code >= 196608 && code <= 262141;
}
function visualWidth(str) {
  let width = 0;
  for (const char of str) {
    const code = char.codePointAt(0);
    if (code === void 0) continue;
    width += isDoubleWidth(code) ? 2 : 1;
  }
  return width;
}
function truncateToWidth(text, maxWidth) {
  let width = 0;
  let i = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === void 0) break;
    const charWidth = isDoubleWidth(code) ? 2 : 1;
    if (width + charWidth > maxWidth - 1) {
      return text.slice(0, i) + "\u2026";
    }
    width += charWidth;
    i += char.length;
  }
  return text;
}
function displayValue(val) {
  return val === "" ? '""' : val;
}
function collectTranslations(key, options) {
  const entries = [];
  const keyId = key.server?.id;
  for (const [lang, t] of Object.entries(key.translations)) {
    const localVal = t.local?.value;
    const serverVal = t.server?.currentValue;
    const hasLocal = localVal != null;
    const hasServer = serverVal != null;
    const score = keyId && options.scores ? options.scores.get(`${keyId}:${lang}`) : void 0;
    if (hasLocal && hasServer && localVal === serverVal) {
      if (options.onlyChanges) continue;
      entries.push({ lang, value: displayValue(localVal), score });
    } else if (options.showDiff && hasLocal && hasServer) {
      entries.push({ lang, value: `${displayValue(serverVal)} \u2192 ${displayValue(localVal)}`, score });
    } else if (hasLocal) {
      entries.push({ lang, value: displayValue(localVal), score });
    } else if (hasServer) {
      entries.push({ lang, value: displayValue(serverVal), score });
    }
  }
  return entries;
}
function getNamespace(key) {
  return key.local?.namespace ?? key.server?.namespace ?? "";
}
const KEY_INDENT = 4;
const COL_GAP = 2;
const MIN_COL_WIDTH = 20;
const MAX_KEY_WIDTH = 30;
function keyLabelFor(key) {
  return key.length > MAX_KEY_WIDTH ? `${key.slice(0, MAX_KEY_WIDTH - 1)}\u2026` : key;
}
function renderKeyCard(key, termWidth, options) {
  const translations = collectTranslations(key, {
    showDiff: options?.showDiff,
    onlyChanges: options?.onlyChanges,
    scores: options?.scores
  });
  const keyLabel = keyLabelFor(key.key);
  const namespace = getNamespace(key);
  if (translations.length === 0) {
    const lines2 = [`${" ".repeat(KEY_INDENT)}${Bold}${keyLabel}${Reset}`];
    if (namespace) {
      lines2.push(`${" ".repeat(KEY_INDENT)}${Dim}${namespace}${Reset}`);
    }
    return lines2.join("\n");
  }
  const keyColWidth = options?.fixedKeyColWidth ?? keyLabel.length + COL_GAP;
  const availableWidth = termWidth - KEY_INDENT - keyColWidth;
  const maxCols = Math.max(1, Math.floor(availableWidth / MIN_COL_WIDTH));
  const numCols = Math.min(maxCols, translations.length);
  const actualColWidth = Math.floor(availableWidth / numCols);
  const lines = [];
  const padding = " ".repeat(KEY_INDENT);
  const keyPadding = " ".repeat(KEY_INDENT + keyColWidth);
  for (let i = 0; i < translations.length; i += numCols) {
    const row = translations.slice(i, i + numCols);
    const cells = row.map(({ lang, value, score }) => {
      const langPrefix = `${lang}: `;
      const langPrefixWidth = visualWidth(langPrefix);
      const scoreStr = score != null ? ` (${score})` : "";
      const scoreVisibleWidth = score != null ? scoreStr.length : 0;
      const maxValWidth = actualColWidth - langPrefixWidth - scoreVisibleWidth - COL_GAP;
      const truncated = truncateToWidth(value, Math.max(5, maxValWidth));
      const scoreColored = score != null ? ` ${score >= 80 ? FgGreen : FgYellow}(${score})${Reset}` : "";
      const cell = `${Dim}${lang}:${Reset} ${truncated}${scoreColored}`;
      const cellVisibleWidth = langPrefixWidth + visualWidth(truncated) + scoreVisibleWidth;
      const pad = Math.max(0, actualColWidth - cellVisibleWidth);
      return cell + " ".repeat(pad);
    });
    const lineContent = cells.join("");
    if (i === 0) {
      const keyStr = `${Bold}${keyLabel}${Reset}`;
      const keyPad = " ".repeat(Math.max(0, keyColWidth - keyLabel.length));
      lines.push(`${padding}${keyStr}${keyPad}${lineContent}`);
    } else {
      lines.push(`${keyPadding}${lineContent}`);
    }
  }
  if (namespace) {
    lines.splice(1, 0, `${padding}${Dim}${namespace}${Reset}`);
  }
  return lines.join("\n");
}
function renderKeyCards(keys, termWidth, options) {
  const limit = options?.limit ?? 10;
  const visible = keys.slice(0, limit);
  const hiddenCount = Math.max(0, keys.length - limit);
  const maxKeyLen = Math.min(
    MAX_KEY_WIDTH,
    Math.max(...visible.map((k) => keyLabelFor(k.key).length))
  );
  const fixedKeyColWidth = maxKeyLen + COL_GAP;
  const cards = visible.map(
    (k) => renderKeyCard(k, termWidth, {
      showDiff: options?.showDiff,
      onlyChanges: options?.onlyChanges,
      fixedKeyColWidth,
      scores: options?.scores
    })
  );
  return { text: cards.join("\n\n"), hiddenCount };
}

async function showAllPrompt(hiddenCount, allText, prompt) {
  if (hiddenCount <= 0) return;
  const answer = await prompt.select({
    message: `${Dim}... ${hiddenCount} more keys${Reset}`,
    choices: [
      { name: "Continue", value: "continue", description: "" },
      { name: "Show all", value: "show-all", description: "" }
    ]
  });
  if (answer === "show-all") {
    console.info(allText);
  }
}
async function push(comparison, pushToServer, projectInfo, appHost, prompt, exit, options) {
  const {
    missingLanguagesOnServer,
    missingKeysOnServer,
    missingTranslationsOnServerPerLanguage,
    differentTranslationsLanguage
  } = comparison;
  const termWidth = process.stdout.columns ?? 80;
  if (options?.filterSummary && !options.quiet) {
    const { pushed, withheld, patterns } = options.filterSummary;
    console.info(
      `${Dim}Filtered by ${patterns}: ${pushed} key(s) selected, ${withheld} other local change(s) NOT pushed${Reset}`
    );
  }
  const langs = [...missingLanguagesOnServer];
  if (langs.length > 0) {
    greenInfo(`${langs.length} new languages will be pushed:`);
    console.info(`    ${langs.join(", ")}`);
    const answer = await prompt.confirm({ message: "Continue?" });
    if (!answer) {
      console.info("Aborting");
      exit();
    }
  }
  const newKeys = Object.values(missingKeysOnServer);
  if (newKeys.length > 0) {
    greenInfo(`
${Bold}${newKeys.length} new keys:${Reset}`);
    const { text, hiddenCount } = renderKeyCards(newKeys, termWidth);
    console.info(text);
    const allResult = renderKeyCards(newKeys, termWidth, { limit: newKeys.length });
    await showAllPrompt(hiddenCount, allResult.text, prompt);
    const answer2 = await prompt.confirm({ message: "Continue?" });
    if (!answer2) {
      console.info("Aborting");
      exit();
    }
  }
  const newKeyNames = new Set(
    Object.values(missingKeysOnServer).map((key) => getComparisonKey(key))
  );
  const seen = /* @__PURE__ */ new Set();
  const translationKeys = Object.values(missingTranslationsOnServerPerLanguage).flat().filter((k) => {
    const comparisonKey = getComparisonKey(k);
    if (newKeyNames.has(comparisonKey) || seen.has(comparisonKey)) return false;
    seen.add(comparisonKey);
    return true;
  });
  if (translationKeys.length > 0) {
    const langCount = Object.keys(missingTranslationsOnServerPerLanguage).length;
    greenInfo(`
${Bold}${translationKeys.length} missing translations across ${langCount} languages:${Reset}`);
    const { text, hiddenCount } = renderKeyCards(translationKeys, termWidth, { onlyChanges: true });
    console.info(text);
    const allResult = renderKeyCards(translationKeys, termWidth, { limit: translationKeys.length, onlyChanges: true });
    await showAllPrompt(hiddenCount, allResult.text, prompt);
    const answer3 = await prompt.confirm({ message: "Continue?" });
    if (!answer3) {
      console.info("Aborting");
      exit();
    }
  }
  const conflicts = Object.entries(differentTranslationsLanguage).flatMap(
    ([lang, keys]) => keys.map((key) => ({ lang, key }))
  );
  if (conflicts.length > 0) {
    greenInfo(`${conflicts.length} conflicting translations found`);
    let sticky = options?.conflictResolution;
    if (!sticky) {
      const choice = await prompt.select({
        message: "How to resolve conflicts?",
        choices: [
          { name: "Review each", value: "each", description: "" },
          {
            name: "Use local for ALL (overwrite server)",
            value: "local",
            description: ""
          },
          {
            name: "Use server for ALL (discard local changes)",
            value: "server",
            description: ""
          }
        ]
      });
      if (choice === "local" || choice === "server") sticky = choice;
    }
    for (const { lang, key } of conflicts) {
      const local = key.translations[lang]?.local;
      const server = key.translations[lang]?.server;
      if (!local || !server) {
        throw new Error(`Expected both local and server translation for key "${key.key}" lang "${lang}"`);
      }
      let answer = sticky;
      if (!answer) {
        boldInfo(`

Different translations were found on server and local:`);
        console.info(`Key: ${key.key}`);
        console.info(`Language: ${lang}`);
        console.info(`${FgBlue}Local:${Reset} ${local.value}`);
        console.info(`${FgBlue}Server:${Reset} ${server.currentValue}`);
        const selected = await prompt.select({
          message: "Select version to push",
          choices: [
            {
              name: "local (overwrite the server)",
              value: "local",
              description: `translations for ${lang}: ${local.value}`
            },
            {
              name: "server (keep the original)",
              value: "server",
              description: `translations for ${lang}: ${server.currentValue}`
            },
            {
              name: "local for ALL remaining",
              value: "local-all",
              description: ""
            },
            {
              name: "server for ALL remaining",
              value: "server-all",
              description: ""
            }
          ]
        });
        if (selected === "local-all") {
          sticky = "local";
          answer = "local";
        } else if (selected === "server-all") {
          sticky = "server";
          answer = "server";
        } else {
          answer = selected === "server" ? "server" : "local";
        }
      }
      if (answer === "server") {
        delete key.translations[lang]?.local;
      }
    }
  }
  const answer4 = await prompt.confirm({ message: "Ready to push?" });
  if (!answer4) {
    console.info("Aborting");
    exit();
  }
  if (!options?.quiet) {
    console.info(`
  ${Dim}Pushing...${Reset}`);
  }
  const result = await pushToServer(
    buildPushPayload(projectInfo.id, comparison)
  );
  if (!options?.quiet) {
    console.info(`  ${FgGreen}\u2713 Push complete${Reset}
`);
    console.info(`  ${Dim}Project:${Reset}   ${FgBlue}${appHost}/app/project/${projectInfo.id}${Reset}`);
    console.info(`  ${Dim}Translate:${Reset} ${FgBlue}${appHost}/app/project/${projectInfo.id}/translate${Reset}
`);
  }
  return result;
}

function filterRecord(record, selectedKeys) {
  const result = {};
  for (const [comparisonKey, key] of Object.entries(record)) {
    if (selectedKeys.has(getComparisonKey(key))) {
      result[comparisonKey] = key;
    }
  }
  return result;
}
function filterPerLanguage(perLanguage, selectedKeys) {
  const result = {};
  for (const [lang, keys] of Object.entries(perLanguage)) {
    const kept = keys.filter((key) => selectedKeys.has(getComparisonKey(key)));
    if (kept.length > 0) result[lang] = kept;
  }
  return result;
}
function filterComparisonBySelectedKeys(comparison, selectedKeys) {
  const missingKeysOnServer = filterRecord(
    comparison.missingKeysOnServer,
    selectedKeys
  );
  const missingOrDifferentKeysOnServer = filterRecord(
    comparison.missingOrDifferentKeysOnServer,
    selectedKeys
  );
  const missingKeysOnLocal = filterRecord(
    comparison.missingKeysOnLocal,
    selectedKeys
  );
  const missingTranslationsOnServerPerLanguage = filterPerLanguage(
    comparison.missingTranslationsOnServerPerLanguage,
    selectedKeys
  );
  const missingTranslationsOnLocalPerLanguage = filterPerLanguage(
    comparison.missingTranslationsOnLocalPerLanguage,
    selectedKeys
  );
  const differentTranslationsLanguage = filterPerLanguage(
    comparison.differentTranslationsLanguage,
    selectedKeys
  );
  const languagesInSelection = /* @__PURE__ */ new Set();
  for (const key of Object.values(missingOrDifferentKeysOnServer)) {
    for (const [lang, translation] of Object.entries(key.translations)) {
      if (translation?.local?.value != void 0)
        languagesInSelection.add(lang);
    }
  }
  const missingLanguagesOnServer = new Set(
    [...comparison.missingLanguagesOnServer].filter(
      (lang) => languagesInSelection.has(lang)
    )
  );
  const needPush = Object.keys(missingKeysOnServer).length > 0 || Object.keys(missingTranslationsOnServerPerLanguage).length > 0 || Object.keys(differentTranslationsLanguage).length > 0 || missingLanguagesOnServer.size > 0;
  const needPull = Object.keys(missingKeysOnLocal).length > 0 || Object.keys(missingTranslationsOnLocalPerLanguage).length > 0;
  return {
    needPull,
    needPush,
    missingLanguagesOnServer,
    missingKeysOnServer,
    missingTranslationsOnServerPerLanguage,
    differentTranslationsLanguage,
    missingKeysOnLocal,
    missingTranslationsOnLocalPerLanguage,
    missingOrDifferentKeysOnServer,
    keysToRemove: comparison.keysToRemove
  };
}

const MATCH_OPTS = { nocomment: true, dot: true };
function isGlob(pattern) {
  return /[*?[\]{}!]/.test(pattern);
}
function matchNamespace(ns, pattern) {
  if (ns === "" && (pattern === "*" || pattern === "**")) return true;
  return minimatch$1(ns, pattern, MATCH_OPTS);
}
function matchKeyPattern(pattern, key, ns) {
  if (getComparisonKey(key) === pattern) return true;
  if (ns === "" && key.key === pattern) return true;
  const colon = pattern.indexOf(":");
  if (colon !== -1) {
    const nsGlob = pattern.slice(0, colon);
    const keyGlob = pattern.slice(colon + 1);
    return matchNamespace(ns, nsGlob) && minimatch$1(key.key, keyGlob, MATCH_OPTS);
  }
  if (pattern === "*" || pattern === "**")
    return minimatch$1(key.key, pattern, MATCH_OPTS);
  return ns === "" && minimatch$1(key.key, pattern, MATCH_OPTS);
}
function resolveSelectedKeys(requestedKeys, mergedKeysByKeyByNamespace, requestedNamespaces = []) {
  const allKeys = Object.values(mergedKeysByKeyByNamespace).flatMap(
    (keys) => Object.values(keys)
  );
  const selected = /* @__PURE__ */ new Set();
  const keyHits = new Map(requestedKeys.map((p) => [p, 0]));
  const namespaceHits = new Map(
    requestedNamespaces.map((p) => [p, 0])
  );
  for (const key of allKeys) {
    const ns = getNamespace$1(key);
    const matchedKeyPatterns = requestedKeys.filter(
      (p) => matchKeyPattern(p, key, ns)
    );
    const keyMatches = requestedKeys.length === 0 || matchedKeyPatterns.length > 0;
    const matchedNamespacePatterns = requestedNamespaces.filter(
      (p) => matchNamespace(ns, p)
    );
    const namespaceMatches = requestedNamespaces.length === 0 || matchedNamespacePatterns.length > 0;
    for (const p of matchedKeyPatterns)
      keyHits.set(p, (keyHits.get(p) ?? 0) + 1);
    for (const p of matchedNamespacePatterns)
      namespaceHits.set(p, (namespaceHits.get(p) ?? 0) + 1);
    if (keyMatches && namespaceMatches) {
      selected.add(getComparisonKey(key));
    }
  }
  const unmatchedKeys = [...keyHits].filter(([, n]) => n === 0).map(([p]) => p);
  const unmatchedNamespaces = [...namespaceHits].filter(([, n]) => n === 0).map(([p]) => p);
  const problems = [];
  if (unmatchedKeys.length > 0) {
    const hasLiteral = unmatchedKeys.some(
      (p) => !isGlob(p) && !p.includes(":")
    );
    problems.push(
      `No keys match: ${unmatchedKeys.join(", ")}.${hasLiteral ? ` Use the "namespace:key" form to target a key in a namespace.` : ""}`
    );
  }
  if (unmatchedNamespaces.length > 0) {
    problems.push(`No namespaces match: ${unmatchedNamespaces.join(", ")}.`);
  }
  if (problems.length > 0) {
    throw new Error(problems.join(" "));
  }
  if (selected.size === 0 && requestedKeys.length > 0 && requestedNamespaces.length > 0) {
    throw new Error(
      `No keys match --key [${requestedKeys.join(", ")}] within --namespace [${requestedNamespaces.join(", ")}]: the patterns matched individually but their intersection is empty.`
    );
  }
  return selected;
}

async function pullTransformFiles({
  transformConfigs,
  transforms,
  mergedKeysByKeyByNamespace,
  allLanguages,
  onlyApproved,
  selectedKeys,
  fileAPI,
  cwd
}) {
  const filesToPull = {};
  for (const config of transformConfigs) {
    const namespace = exists(config.namespace, "Transform must have namespace");
    const transform = exists(
      transforms.get(config.path),
      `Transform not loaded for "${config.path}"`
    );
    const mergedKeysByKey = mergedKeysByKeyByNamespace[namespace] ?? {};
    const localToRemote = config.mapLocalToRemote ?? {};
    const remoteToLocal = invertMap(config.mapLocalToRemote);
    const languagePairs = config.languages ? config.languages.map((local) => ({
      local,
      remote: localToRemote[local] ?? local
    })) : allLanguages.map((l) => ({
      local: remoteToLocal[l.code] ?? l.code,
      remote: l.code
    }));
    const translations = {};
    for (const { local, remote } of languagePairs) {
      translations[local] = {};
      for (const [key, universalKey] of Object.entries(mergedKeysByKey)) {
        const translation = universalKey.translations[remote];
        const isSelectedForPull = !selectedKeys || selectedKeys.has(getComparisonKey({ key, namespace }));
        const hasServerKey = universalKey.server != null;
        const serverValue = onlyApproved ? translation?.server?.approved ? translation?.server?.currentValue : null : translation?.server?.currentValue;
        const value = isSelectedForPull && (!selectedKeys || hasServerKey) ? serverValue ?? translation?.local?.value : translation?.local?.value;
        if (value != null) {
          translations[local][key] = value;
        }
      }
    }
    const pathPattern = config.path.replace(/^\.\//, "");
    const fullPath = cwd ? join(cwd, pathPattern) : pathPattern;
    let currentContent = null;
    try {
      currentContent = await fileAPI.readFile(fullPath);
    } catch {
    }
    try {
      filesToPull[pathPattern] = transform.pull(translations, currentContent);
    } catch (err) {
      throw new Error(
        `Transform pull failed for "${config.path}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return filesToPull;
}

async function runCli({
  cliInput,
  allFilesByPattern,
  projectInfo,
  allServerKeys,
  getFilePatternOrPath,
  writeFile,
  pushToServer,
  appHost,
  translationFilesConfig,
  prompt,
  exit,
  emptyValueString,
  transformConfigs = [],
  transforms = /* @__PURE__ */ new Map(),
  fileAPI,
  cwd
}) {
  const languagesOnServer = new Set(projectInfo.languages.map((l) => l.code));
  const {
    languagesOnLocal,
    mergedKeysByKeyByNamespace,
    mergedKeysInLocalOrder
  } = await gatherLocalKeys({
    allFilesByPattern,
    keySeparator: projectInfo.keySeparator,
    emptyValueString
  });
  const hasTransforms = transformConfigs.length > 0 && fileAPI;
  if (hasTransforms) {
    const transformResult = await gatherTransformKeys({
      transformConfigs,
      transforms,
      fileAPI,
      emptyValueString,
      cwd
    });
    for (const [ns, keys] of Object.entries(
      transformResult.mergedKeysByKeyByNamespace
    )) {
      mergedKeysByKeyByNamespace[ns] ?? (mergedKeysByKeyByNamespace[ns] = {});
      Object.assign(mergedKeysByKeyByNamespace[ns], keys);
    }
    for (const lang of transformResult.languagesOnLocal) {
      languagesOnLocal.add(lang);
    }
  }
  async function pull(pullOptions) {
    let selectedKeys2 = pullOptions?.selectedKeys;
    if (!selectedKeys2 && (pullOptions?.keys && pullOptions.keys.length > 0 || pullOptions?.namespaces && pullOptions.namespaces.length > 0)) {
      selectedKeys2 = resolveSelectedKeys(
        pullOptions.keys ?? [],
        mergedKeysByKeyByNamespace,
        pullOptions.namespaces ?? []
      );
    }
    if (pullOptions?.onlyExisting) {
      const localKeys = /* @__PURE__ */ new Set();
      for (const keys of Object.values(mergedKeysByKeyByNamespace)) {
        for (const key of Object.values(keys)) {
          if (key.local) localKeys.add(getComparisonKey(key));
        }
      }
      selectedKeys2 = selectedKeys2 ? new Set([...selectedKeys2].filter((k) => localKeys.has(k))) : localKeys;
    }
    const filesToPull = await prepareFilesToPull(
      mergedKeysInLocalOrder,
      mergedKeysByKeyByNamespace,
      translationFilesConfig,
      projectInfo.languages,
      pullOptions?.onlyApproved ?? false,
      emptyValueString,
      selectedKeys2
    );
    for (const [file, content] of Object.entries(filesToPull)) {
      await writeFile(file, content);
    }
    if (hasTransforms) {
      const transformFiles = await pullTransformFiles({
        transformConfigs,
        transforms,
        mergedKeysByKeyByNamespace,
        allLanguages: projectInfo.languages,
        onlyApproved: pullOptions?.onlyApproved ?? false,
        selectedKeys: selectedKeys2,
        fileAPI,
        cwd
      });
      for (const [file, content] of Object.entries(transformFiles)) {
        await writeFile(file, content);
      }
    }
  }
  gatherServerKeys({
    allServerKeys,
    mergedKeysByKeyByNamespace,
    getLangCode: makeGetLangCode(projectInfo.languages),
    getFilePatternOrPath,
    mergedKeysInLocalOrder
  });
  const comparison = compareLocalAndServer(
    languagesOnServer,
    languagesOnLocal,
    mergedKeysByKeyByNamespace,
    emptyValueString
  );
  if (cliInput.action === "push" && cliInput.keysToRemove && cliInput.keysToRemove.length > 0) {
    comparison.keysToRemove = cliInput.keysToRemove;
  }
  const filterKeys = cliInput.action === "push" ? cliInput.keys : cliInput.action === "pull" ? cliInput.options.keys : void 0;
  const filterNamespaces = cliInput.action === "push" ? cliInput.namespaces : cliInput.action === "pull" ? cliInput.options.namespaces : void 0;
  const hasSelectionFilter = (filterKeys?.length ?? 0) > 0 || (filterNamespaces?.length ?? 0) > 0;
  let selectedKeys;
  let pushFilterSummary;
  let scopedComparison = comparison;
  if (hasSelectionFilter) {
    selectedKeys = resolveSelectedKeys(
      filterKeys ?? [],
      mergedKeysByKeyByNamespace,
      filterNamespaces ?? []
    );
    const keysBefore = Object.keys(
      comparison.missingOrDifferentKeysOnServer
    ).length;
    scopedComparison = filterComparisonBySelectedKeys(comparison, selectedKeys);
    if (cliInput.action === "push") {
      const pushed = Object.keys(
        scopedComparison.missingOrDifferentKeysOnServer
      ).length;
      pushFilterSummary = {
        pushed,
        withheld: keysBefore - pushed,
        patterns: [...filterKeys ?? [], ...filterNamespaces ?? []].join(
          ", "
        )
      };
    }
  }
  const statusData = computeStatus(
    scopedComparison,
    languagesOnServer,
    languagesOnLocal
  );
  let pushResult;
  if (cliInput.action === "push") {
    pushResult = await push(
      scopedComparison,
      pushToServer,
      projectInfo,
      appHost,
      prompt,
      exit,
      {
        quiet: cliInput.quiet,
        conflictResolution: cliInput.conflictResolution,
        filterSummary: pushFilterSummary
      }
    );
  }
  if (cliInput.action === "pull") {
    await pull({ ...cliInput.options, selectedKeys });
  }
  return {
    comparison: scopedComparison,
    status: statusData,
    pushResult,
    pushFilter: pushFilterSummary,
    mergedKeysByKeyByNamespace
  };
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class CliRequestError extends Error {
  constructor(input) {
    super(input.message, { cause: input.cause });
    __publicField(this, "code");
    __publicField(this, "httpStatus");
    this.name = "CliRequestError";
    this.code = input.code;
    this.httpStatus = input.httpStatus;
  }
}

function getRetryAfterMs(value, now = Date.now()) {
  if (!value) return void 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1e3;
  const date = Date.parse(value);
  if (!Number.isFinite(date) || date <= now) return void 0;
  return date - now;
}

const errorBodySchema = z.object({
  error: z.union([
    z.string(),
    z.object({
      code: z.string().optional(),
      message: z.string()
    })
  ])
});
async function readCliResponseError(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    body = void 0;
  }
  const parsed = errorBodySchema.safeParse(body);
  if (parsed.success) {
    const error = parsed.data.error;
    return new CliRequestError({
      message: typeof error === "string" ? error : error.message,
      code: typeof error === "string" ? void 0 : error.code,
      httpStatus: response.status
    });
  }
  return new CliRequestError({
    message: `Request failed. Status: ${response.statusText || response.status}`,
    code: "request_failed",
    httpStatus: response.status
  });
}

const retryDelays = [250, 750];
const retryableStatuses = /* @__PURE__ */ new Set([408, 429, 500, 502, 503, 504]);
async function requestCliJson(url, init = {}) {
  const method = (init.method ?? "GET").toUpperCase();
  const canRetry = method === "GET" || method === "HEAD";
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetch(url, init);
    } catch (cause) {
      if (!canRetry || attempt === 2) {
        throw new CliRequestError({
          message: "Request failed due to a network error",
          code: "network_error",
          cause
        });
      }
      await sleep$1(retryDelays[attempt] ?? 750);
      continue;
    }
    if (canRetry && attempt < 2 && retryableStatuses.has(response.status)) {
      await response.body?.cancel().catch(() => void 0);
      const baseDelay = retryDelays[attempt] ?? 750;
      const retryAfter = response.status === 429 || response.status === 503 ? getRetryAfterMs(response.headers.get("Retry-After")) : void 0;
      const delay = Math.max(baseDelay, Math.min(retryAfter ?? 0, 5e3));
      await sleep$1(delay);
      continue;
    }
    if (!response.ok) throw await readCliResponseError(response);
    try {
      return await response.json();
    } catch (cause) {
      throw new CliRequestError({
        message: "Server returned invalid JSON",
        code: "invalid_response",
        httpStatus: response.status,
        cause
      });
    }
  }
  throw new CliRequestError({
    message: "Request failed due to a network error",
    code: "network_error"
  });
}
function sleep$1(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchKeyInLoop(host, requestCode) {
  const res = await requestCliJson(
    `${host}/api/cli/getAuthToken?requestCode=${requestCode}`
  );
  if (res.status === "not-found") {
    await new Promise((resolve) => setTimeout(resolve, 2e3));
    return fetchKeyInLoop(host, requestCode);
  } else if (res.status === "ok") {
    return res.key;
  }
  throw new Error("Unexpected status");
}

const keyFilePath = path.join(import.meta.dirname, "babli_k");
async function loadKeyOrTokenFile() {
  const apiKey = process.env.BABLI_API_KEY;
  if (apiKey) {
    return apiKey;
  }
  const userToken = await fs__default.readFile(keyFilePath, "utf-8");
  if (!userToken) {
    throw new Error("Key file is empty");
  }
  return userToken;
}
async function performLogin(host) {
  const requestCode = crypto.randomUUID();
  console.info(
    "Please approve the request in the browser to log in to Babli CLI"
  );
  setTimeout(() => {
    open(`${host}/app/approve-access?request-code=${requestCode}`).catch(
      (err) => {
        console.error("Failed to open browser", err);
      }
    );
    console.info("Waiting for approval...");
  }, 1e3);
  const key = await fetchKeyInLoop(host, requestCode);
  await fs__default.writeFile(keyFilePath, key, "utf-8");
  console.info("Logged in successfully.");
  return key;
}

const CliFileApi = {
  async readFile(path) {
    return fs.readFile(path, "utf-8");
  },
  async fileExists(path) {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  },
  async glob(pattern, options) {
    return glob(pattern, { cwd: options?.cwd, posix: true });
  }
};

function countLanguages(missingTranslations) {
  return Object.keys(missingTranslations).length;
}
function countDistinctKeys(missingTranslations) {
  const keys = /* @__PURE__ */ new Set();
  for (const keyList of Object.values(missingTranslations)) {
    for (const key of keyList) {
      keys.add(key);
    }
  }
  return keys.size;
}
function sumTranslations(missingTranslations) {
  let total = 0;
  for (const keys of Object.values(missingTranslations)) {
    total += keys.length;
  }
  return total;
}
function plural(n, word) {
  return `${n} ${word}${n !== 1 ? "s" : ""}`;
}
function buildPushDetail(status) {
  const newKeys = status.toPush.newKeys.length;
  const changed = status.toPush.changedValues.length;
  const newLangs = status.languages.localOnly.length;
  const translationLangs = countLanguages(status.toPush.missingTranslations);
  const parts = [];
  const keyPart = newKeys > 0 && changed > 0 ? `${plural(newKeys + changed, "key")} (${newKeys} new)` : newKeys > 0 ? `${plural(newKeys, "new key")}` : `${plural(changed, "changed value")}`;
  parts.push(keyPart);
  if (newLangs > 0) {
    parts.push(`${plural(newLangs, "new language")}`);
  } else if (translationLangs > 1) {
    parts.push(`${plural(translationLangs, "language")}`);
  }
  return parts.join(" \xB7 ");
}
function buildPullDetail(status) {
  const newKeys = status.toPull.missingKeys.length;
  const translationCount = sumTranslations(status.toPull.missingTranslations);
  const langCount = countLanguages(status.toPull.missingTranslations);
  const distinctKeys = countDistinctKeys(status.toPull.missingTranslations);
  const totalKeys = distinctKeys + newKeys;
  const parts = [];
  if (totalKeys > 0) {
    const keyStr = newKeys > 0 ? `${plural(totalKeys, "key")} (${newKeys} new)` : `${plural(totalKeys, "key")}`;
    parts.push(keyStr);
  }
  if (translationCount > 0) {
    parts.push(`${plural(translationCount, "translation")}`);
  }
  if (langCount > 0) {
    parts.push(`${plural(langCount, "language")}`);
  }
  return parts.join(" \xB7 ");
}
function computeDashboard(status, questionsCount, projectName, options) {
  const pushCount = status.toPush.newKeys.length + status.toPush.changedValues.length;
  const pullCount = status.toPull.missingKeys.length + sumTranslations(status.toPull.missingTranslations);
  const badges = [];
  if (pushCount > 0) {
    badges.push({
      icon: "\u2B06",
      count: pushCount,
      label: "to push",
      detail: buildPushDetail(status)
    });
  }
  if (pullCount > 0) {
    badges.push({
      icon: "\u2B07",
      count: pullCount,
      label: "to pull",
      detail: buildPullDetail(status)
    });
  }
  if (questionsCount > 0) {
    badges.push({
      icon: "\u2753",
      count: questionsCount,
      label: "questions",
      detail: `${plural(questionsCount, "question")}`
    });
  }
  const isInSync = badges.length === 0;
  const menuItems = [];
  if (!isInSync) {
    if (status.needPush) {
      menuItems.push({
        value: "sync-and-translate",
        label: `Sync & Translate  (push ${pushCount} new, translate, pull results)`
      });
      menuItems.push({ value: "push", label: "Push" });
    }
    if (status.needPull) {
      menuItems.push({ value: "pull", label: "Pull" });
    }
    if (questionsCount > 0) {
      menuItems.push({ value: "questions", label: "Answer questions" });
    }
    menuItems.push({ value: "details", label: "View details" });
    menuItems.push({ value: "exit", label: "Exit" });
  }
  const warnings = [];
  if (options?.questionsFetchFailed) {
    warnings.push("Failed to fetch questions");
  }
  return { projectName, badges, menuItems, isInSync, warnings };
}

async function writeFile(file, content) {
  await fs__default.writeFile(file, content, "utf-8");
}

async function fetchServerKeys(host, projectId, accessToken) {
  return requestCliJson(`${host}/api/cli/${projectId}/allKeys`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}
async function fetchProjectInfo(host, projectId, accessToken) {
  const result = await requestCliJson(
    `${host}/api/cli/${projectId}/project`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );
  return result.project;
}
async function requestTranslation(host, projectId, accessToken, keys, model = "production") {
  return requestCliJson(`${host}/api/cli/${projectId}/translate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ keys, model })
  });
}
async function estimateTranslation(host, projectId, accessToken, keys, model = "production") {
  return requestCliJson(`${host}/api/cli/${projectId}/estimate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ keys, model })
  });
}
async function fetchJobStatus(host, projectId, accessToken, jobId) {
  const result = await requestCliJson(`${host}/api/cli/${projectId}/job/${jobId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  return { ...result, failures: result.failures ?? [] };
}
async function fetchQuestions(host, projectId, accessToken) {
  const json = await requestCliJson(
    `${host}/api/cli/${projectId}/questions`,
    {
      headers: { Authorization: `Bearer ${accessToken}` }
    }
  );
  return json.questions;
}
async function submitAnswers(host, projectId, accessToken, answers) {
  return requestCliJson(`${host}/api/cli/${projectId}/answers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ answers })
  });
}
async function fetchPendingReviews(host, projectId, accessToken) {
  const json = await requestCliJson(
    `${host}/api/cli/${projectId}/pendingReviews`,
    {
      headers: { Authorization: `Bearer ${accessToken}` }
    }
  );
  return json.pending;
}
async function approveTranslations(host, projectId, accessToken, translationIds) {
  return requestCliJson(`${host}/api/cli/${projectId}/approve`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ translationIds })
  });
}
async function requestProofread(host, projectId, accessToken, keyIds, languageId) {
  return requestCliJson(`${host}/api/cli/${projectId}/proofread`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ keyIds, languageId })
  });
}
async function pingServer(host, cliVersion) {
  let json;
  try {
    json = await requestCliJson(`${host}/api/cli/ping`);
  } catch (error) {
    if (error instanceof CliRequestError && error.httpStatus !== void 0) {
      console.error(`Could not connect to server at ${host}`);
      process.exit(1);
    }
    throw error;
  }
  const baseVersion = (v) => v.replace(/[-+].*$/, "");
  if (baseVersion(json.cliVersion) !== baseVersion(cliVersion)) {
    console.warn(
      `Your CLI version is different from the server version, please update. Your version is ${cliVersion}, but the server is ${json.cliVersion}.`
    );
  }
}
async function listCliKeys(host, projectId, accessToken, options) {
  const searchParams = new URLSearchParams();
  if (options.includeArchived) {
    searchParams.set("includeArchived", "true");
  }
  if (options.query) {
    searchParams.set("query", options.query);
  }
  const suffix = searchParams.size ? `?${searchParams.toString()}` : "";
  return fetchCliJson(`${host}/api/cli/${projectId}/keys${suffix}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
}
async function getCliKey(host, projectId, accessToken, input) {
  return postCliJson(`${host}/api/cli/${projectId}/keys/get`, accessToken, input);
}
async function addCliKey(host, projectId, accessToken, input) {
  return postCliJson(`${host}/api/cli/${projectId}/keys`, accessToken, input);
}
async function updateCliKey(host, projectId, accessToken, input) {
  return patchCliJson(`${host}/api/cli/${projectId}/keys/update`, accessToken, input);
}
async function renameCliKey(host, projectId, accessToken, input) {
  return patchCliJson(`${host}/api/cli/${projectId}/keys/rename`, accessToken, input);
}
async function archiveCliKey(host, projectId, accessToken, input) {
  return postCliJson(`${host}/api/cli/${projectId}/keys/archive`, accessToken, input);
}
async function unarchiveCliKey(host, projectId, accessToken, input) {
  return postCliJson(`${host}/api/cli/${projectId}/keys/unarchive`, accessToken, input);
}
async function upsertCliTranslation(host, projectId, accessToken, input) {
  return postCliJson(`${host}/api/cli/${projectId}/translations/upsert`, accessToken, input);
}
async function approveCliTranslation(host, projectId, accessToken, translationId) {
  return postCliJson(`${host}/api/cli/${projectId}/translations/approve`, accessToken, {
    translationId
  });
}
async function unapproveCliTranslation(host, projectId, accessToken, translationId) {
  return postCliJson(`${host}/api/cli/${projectId}/translations/unapprove`, accessToken, {
    translationId
  });
}
async function listCliOrganizations(host, accessToken) {
  return fetchCliJson(`${host}/api/cli/organizations`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
}
async function createCliProject(host, accessToken, input) {
  return postCliJson(`${host}/api/cli/projects`, accessToken, input);
}
async function getCliProject(host, projectId, accessToken) {
  return fetchCliJson(`${host}/api/cli/${projectId}/project`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
}
async function updateCliProject(host, projectId, accessToken, input) {
  return patchCliJson(`${host}/api/cli/${projectId}/project`, accessToken, input);
}
async function postCliJson(url, accessToken, body) {
  return fetchCliJson(url, {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    method: "POST"
  });
}
async function patchCliJson(url, accessToken, body) {
  return fetchCliJson(url, {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    method: "PATCH"
  });
}
async function fetchCliJson(url, init) {
  return requestCliJson(url, init);
}

async function initProject(host, accessToken) {
  console.info("Initializing new Babli project...\n");
  const orgs = await listCliOrganizations(host, accessToken);
  if (orgs.length === 0) {
    console.error(
      `You don't have access to any organizations. Please create one at ${host}`
    );
    process.exit(1);
  }
  let selectedOrgId;
  if (orgs.length === 1) {
    selectedOrgId = orgs[0].id;
    console.info(`Using organization: ${orgs[0].name}`);
  } else {
    selectedOrgId = await select({
      message: "Select an organization:",
      choices: orgs.map((org) => ({
        name: org.name,
        value: org.id,
        description: `${org.projects.length} project(s)`
      }))
    });
  }
  const projectName = await input({
    message: "Enter project name:",
    default: "My App",
    validate: (value) => {
      if (!value.trim()) {
        return "Project name is required";
      }
      return true;
    }
  });
  console.info("\nScanning for existing translation files...");
  const detectedFiles = await findTranslationFiles(
    CliFileApi,
    ".",
    (message) => console.info(`  ${message}`)
  );
  let translationFilesConfig;
  if (detectedFiles.length > 0) {
    console.info(`
\u2705 Found ${detectedFiles.length} translation file(s).`);
    const generatedConfig = generateTranslationConfig(detectedFiles);
    const selectedPaths = await checkbox({
      message: "Select the translation file patterns to include (unselect any wrongly detected ones):",
      choices: generatedConfig.map((entry) => ({
        name: entry.languages ? `${entry.path}  (${entry.languages.join(", ")})` : entry.path,
        value: entry.path,
        checked: true
      })),
      pageSize: 20
    });
    const selected = generatedConfig.filter(
      (entry) => selectedPaths.includes(entry.path)
    );
    if (selected.length > 0) {
      translationFilesConfig = selected;
      console.info(`
\u{1F4C1} Using ${selected.length} pattern(s)`);
    } else {
      translationFilesConfig = [{ path: "locales/{{lang}}.json" }];
      console.info("\n\u{1F4C1} No patterns selected \u2014 using default configuration");
    }
  } else {
    console.info("  No translation files found");
    translationFilesConfig = [{ path: "locales/{{lang}}.json" }];
    console.info("\n\u{1F4C1} Using default configuration");
  }
  console.info("Creating project...");
  const project = await createCliProject(host, accessToken, {
    name: projectName,
    orgId: selectedOrgId,
    type: "key"
  });
  const config = {
    projectId: project.id,
    host,
    translationFiles: translationFilesConfig
  };
  await writeFile("babli.json", JSON.stringify(config, null, 2));
  console.info(`
\u2705 Project created successfully!`);
  console.info(`\u{1F4C1} Config saved to babli.json`);
  console.info(`\u{1F310} View your project: ${host}/app/project/${project.id}`);
  if (detectedFiles.length > 0) {
    console.info(`
Next steps:`);
    console.info(`1. Run 'babli push' to upload your existing translations`);
    console.info(`2. Translate at ${host}/app/project/${project.id}/translate`);
    console.info(`3. Run 'babli pull' to download completed translations`);
  } else {
    console.info(`
Next steps:`);
    console.info(`1. Add translation files to the locales/ directory`);
    console.info(`2. Run 'babli push' to upload your translations`);
    console.info(`3. Translate at ${host}/app/project/${project.id}/translate`);
    console.info(`4. Run 'babli pull' to download completed translations`);
  }
}

async function loadTransform(transformPath, cwd) {
  const absolutePath = resolve(cwd, transformPath);
  let loaded;
  try {
    loaded = await import(pathToFileURL(absolutePath).href);
  } catch (err) {
    throw new Error(
      `Failed to load transform at "${transformPath}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (typeof loaded !== "object" || loaded === null) {
    throw new Error(
      `Transform at "${transformPath}" did not export a valid module`
    );
  }
  const mod = loaded;
  const transform = mod.default ?? loaded;
  if (typeof transform !== "object" || transform === null || typeof transform.push !== "function" || typeof transform.pull !== "function") {
    throw new Error(
      `Transform at "${transformPath}" must export "push" and "pull" functions`
    );
  }
  return transform;
}

function makePushToServer(host, accessToken) {
  return async function pushToServer({
    projectId,
    newLanguages,
    input
  }) {
    return requestCliJson(
      `${host}/api/cli/${projectId}/addKeysAndTranslations`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          newLanguages,
          input
        })
      }
    );
  };
}

function printJson(value) {
  console.info(JSON.stringify(value, null, 2));
}

async function projectListCommand(ctx, options) {
  const organizations = await listCliOrganizations(ctx.host, ctx.accessToken);
  const filtered = options.organization ? organizations.filter((org) => org.id === options.organization) : organizations;
  if (ctx.flags.json) {
    printJson({
      command: "project_list",
      organizations: filtered,
      status: "ok",
      version: 1
    });
    return;
  }
  const hasProjects = filtered.some((org) => org.projects.length > 0);
  if (!hasProjects) {
    console.info(`${FgGreen}No projects found.${Reset}`);
    return;
  }
  for (const org of filtered) {
    console.info(`${Bold}${org.name}${Reset} ${org.id}`);
    for (const project of org.projects) {
      console.info(`  ${project.name} ${project.id}`);
    }
  }
}
async function projectCreateCommand(ctx, options) {
  if (options.type !== "key" && options.type !== "document") {
    throw new Error(`Invalid --type "${options.type}". Use "key" or "document".`);
  }
  const languages = options.languages?.split(",").map((code) => code.trim()).filter((code) => code.length > 0);
  const project = await createCliProject(ctx.host, ctx.accessToken, {
    description: options.description,
    languages,
    name: options.name,
    orgId: options.organization,
    type: options.type
  });
  if (ctx.flags.json) {
    printJson({
      command: "project_create",
      project,
      status: "created",
      version: 1
    });
    return;
  }
  console.info(`${FgGreen}Created project:${Reset} ${project.name} (${project.id})`);
  console.info(`${ctx.host}/app/project/${project.id}`);
}
async function projectGetByIdCommand(ctx, projectId) {
  const result = await getCliProject(ctx.host, projectId, ctx.accessToken);
  if (ctx.flags.json) {
    printJson({
      command: "project_get",
      project: result.project,
      status: "ok",
      version: 1
    });
    return;
  }
  console.info(`${Bold}${result.project.name}${Reset}`);
  console.info(`id: ${result.project.id}`);
  console.info(`description: ${result.project.description}`);
  console.info(`instructions: ${result.project.instructions}`);
}

async function proofreadCommand(ctx) {
  const pending = await fetchPendingReviews(ctx.host, ctx.projectId, ctx.accessToken);
  const filtered = ctx.languages ? pending.filter((p) => ctx.languages?.includes(p.languageCode)) : pending;
  if (filtered.length === 0) {
    if (ctx.flags.json) {
      const output = {
        version: 1,
        command: "proofread",
        status: "no-translations",
        suggestions: []
      };
      console.info(JSON.stringify(output, null, 2));
    } else {
      console.info(`${FgGreen}No unapproved translations to proofread.${Reset}`);
    }
    return;
  }
  const byLanguage = /* @__PURE__ */ new Map();
  for (const item of filtered) {
    const existing = byLanguage.get(item.languageId) ?? [];
    if (!existing.includes(item.keyId)) {
      existing.push(item.keyId);
    }
    byLanguage.set(item.languageId, existing);
  }
  const totalKeys = new Set(filtered.map((p) => p.keyId)).size;
  if (!ctx.flags.json) {
    console.info(
      `
${Bold}Proofreading ${totalKeys} key(s) across ${byLanguage.size} language(s)...${Reset}`
    );
  }
  if (!ctx.flags.noInteraction) {
    const proceed = await confirm({ message: "Run proofreading?" });
    if (!proceed) {
      if (ctx.flags.json) {
        const output = {
          version: 1,
          command: "proofread",
          status: "skipped",
          suggestions: []
        };
        console.info(JSON.stringify(output, null, 2));
      }
      return;
    }
  }
  const allSuggestions = [];
  for (const [languageId, keyIds] of byLanguage) {
    const response = await requestProofread(
      ctx.host,
      ctx.projectId,
      ctx.accessToken,
      keyIds,
      languageId
    );
    allSuggestions.push(...response.suggestions);
  }
  if (ctx.flags.json) {
    const output = {
      version: 1,
      command: "proofread",
      status: "complete",
      suggestions: allSuggestions
    };
    console.info(JSON.stringify(output, null, 2));
  } else {
    if (allSuggestions.length === 0) {
      console.info(`${FgGreen}No issues found. Translations look good.${Reset}`);
    } else {
      console.info(
        `
${FgYellow}${allSuggestions.length} suggestion(s) found:${Reset}
`
      );
      for (const s of allSuggestions) {
        console.info(`${Dim}[${s.languageCode}]${Reset} ${s.keyName}`);
        for (const token of s.tokens) {
          console.info(
            `  ${FgYellow}${token.original}${Reset} \u2192 ${FgGreen}${token.modified}${Reset} ${Dim}(${token.description})${Reset}`
          );
        }
      }
      console.info(
        `
${Dim}Suggestions saved on server. Apply them in the Babli dashboard.${Reset}`
      );
    }
  }
}

async function questionsCommand(ctx) {
  const questions = ctx.questions ?? await fetchQuestions(ctx.host, ctx.projectId, ctx.accessToken);
  if (questions.length === 0) {
    if (ctx.flags.json) {
      const output = {
        version: 1,
        command: "questions",
        status: "none",
        summary: { total: 0, answered: 0 }
      };
      console.info(JSON.stringify(output, null, 2));
    } else {
      console.info(`${FgGreen}No unanswered questions.${Reset}`);
    }
    return;
  }
  if (ctx.flags.json && ctx.flags.noInteraction) {
    const output = {
      version: 1,
      command: "questions",
      status: "skipped",
      summary: { total: questions.length, answered: 0 }
    };
    console.info(JSON.stringify(output, null, 2));
    return;
  }
  if (!ctx.flags.json) {
    console.info(`
${Bold}${questions.length} unanswered question(s):${Reset}
`);
  }
  const answersToSubmit = [];
  for (const q of questions) {
    if (!ctx.flags.json) {
      console.info(`${Dim}[${q.languageCode}] ${q.keyName}${Reset}`);
      console.info(`  ${q.question}`);
    }
    if (ctx.flags.noInteraction) continue;
    const answer = await input({
      message: "Your answer (press Enter to skip):"
    });
    if (answer.trim()) {
      answersToSubmit.push({
        keyId: q.keyId,
        languageId: q.languageId,
        questionText: q.question,
        answer: answer.trim()
      });
    }
  }
  if (answersToSubmit.length > 0) {
    const result = await submitAnswers(
      ctx.host,
      ctx.projectId,
      ctx.accessToken,
      answersToSubmit
    );
    if (ctx.flags.json) {
      const output = {
        version: 1,
        command: "questions",
        status: "answered",
        summary: { total: questions.length, answered: result.answered }
      };
      console.info(JSON.stringify(output, null, 2));
    } else {
      console.info(`
${FgGreen}Submitted ${result.answered} answer(s). Quality scores will be recalculated.${Reset}`);
    }
  } else {
    if (ctx.flags.json) {
      const output = {
        version: 1,
        command: "questions",
        status: "skipped",
        summary: { total: questions.length, answered: 0 }
      };
      console.info(JSON.stringify(output, null, 2));
    } else if (!ctx.flags.noInteraction) {
      console.info(`${FgYellow}No answers provided.${Reset}`);
    }
  }
}

function badgeColor(icon) {
  if (icon === "\u2B06") return FgGreen;
  if (icon === "\u2B07") return FgBlue;
  return FgYellow;
}
function renderDashboardHuman(model) {
  const lines = [];
  lines.push("");
  lines.push(`${Bold}babli${Reset}  ${model.projectName}`);
  lines.push("");
  if (model.isInSync && model.warnings.length === 0) {
    lines.push(`  ${FgGreen}Everything is in sync.${Reset}`);
    lines.push("");
    return lines.join("\n");
  }
  for (const badge of model.badges) {
    if (badge.detail) {
      lines.push(`  ${badgeColor(badge.icon)}${badge.icon} ${badge.detail}${Reset}`);
    }
  }
  for (const warning of model.warnings) {
    lines.push(`  ${FgYellow}\u26A0 ${warning}${Reset}`);
  }
  lines.push("");
  return lines.join("\n");
}
function renderDashboardJson(model, status, questionsCount) {
  const toPush = {
    new_keys: status.toPush.newKeys.length,
    changed_values: status.toPush.changedValues.length
  };
  const toPull = {
    translations: Object.values(status.toPull.missingTranslations).reduce(
      (sum, keys) => sum + keys.length,
      0
    ),
    server_only_keys: status.issues.serverOnlyKeys.length
  };
  const infoLines = [];
  const pushTotal = toPush.new_keys + toPush.changed_values;
  const pullTotal = toPull.translations + toPull.server_only_keys;
  if (pushTotal > 0 && pullTotal > 0) {
    infoLines.push(
      `${pushTotal} local changes to push, ${pullTotal} translations available to pull.`
    );
  } else if (pushTotal > 0) {
    infoLines.push(`${pushTotal} local changes to push.`);
  } else if (pullTotal > 0) {
    infoLines.push(`${pullTotal} translations available to pull.`);
  } else {
    infoLines.push("Everything is in sync.");
  }
  if (!model.isInSync) {
    infoLines.push("");
    infoLines.push("Suggested next steps:");
    if (status.needPush) {
      infoLines.push(
        "- `babli sync-and-translate --json` \u2014 push your changes, translate, pull results"
      );
    }
    if (status.needPull) {
      infoLines.push(
        "- `babli pull --json` \u2014 pull all available translations"
      );
    }
    infoLines.push(
      "- `babli status --json --full` \u2014 see detailed breakdown"
    );
  }
  return JSON.stringify(
    {
      version: 1,
      status: model.isInSync ? "clean" : "has_changes",
      summary: { to_push: toPush, to_pull: toPull, questions: questionsCount },
      warnings: model.warnings,
      info: infoLines.join("\n"),
      conflicts: []
    },
    null,
    2
  );
}

function deduplicateByKey(grouped) {
  const seen = /* @__PURE__ */ new Map();
  for (const keys of Object.values(grouped)) {
    for (const key of keys) {
      if (!seen.has(key.key)) {
        seen.set(key.key, key);
      }
    }
  }
  return [...seen.values()];
}
function renderSection(lines, keys, termWidth, full, options) {
  const limit = full ? keys.length : 10;
  const { text, hiddenCount } = renderKeyCards(keys, termWidth, {
    limit,
    showDiff: options?.showDiff,
    onlyChanges: options?.onlyChanges
  });
  lines.push(text);
  if (hiddenCount > 0) {
    lines.push(`    ${Dim}... and ${hiddenCount} more. Run with --full for complete list.${Reset}`);
  }
}
function renderStatusHuman(comparison, status, opts) {
  const termWidth = process.stdout.columns ?? 80;
  const lines = [];
  const allLanguages = [
    ...status.languages.synced,
    ...status.languages.localOnly,
    ...status.languages.serverOnly
  ];
  lines.push("");
  lines.push(`${Bold}Babli Sync Status${Reset}`);
  lines.push("");
  lines.push(`  Languages: ${allLanguages.join(", ")}`);
  const newKeysOnServer = Object.values(comparison.missingKeysOnServer);
  const newKeyNamesOnServer = new Set(
    newKeysOnServer.map((key) => getComparisonKey(key))
  );
  const missingTranslationsKeys = deduplicateByKey(comparison.missingTranslationsOnServerPerLanguage).filter((k) => !newKeyNamesOnServer.has(getComparisonKey(k)));
  const changedKeys = deduplicateByKey(comparison.differentTranslationsLanguage);
  const newKeysOnLocal = Object.values(comparison.missingKeysOnLocal);
  const newKeyNamesOnLocal = new Set(
    newKeysOnLocal.map((key) => getComparisonKey(key))
  );
  const missingTranslationsLocalKeys = deduplicateByKey(comparison.missingTranslationsOnLocalPerLanguage).filter((k) => !newKeyNamesOnLocal.has(getComparisonKey(k)));
  const hasPush = newKeysOnServer.length > 0 || changedKeys.length > 0 || missingTranslationsKeys.length > 0;
  const hasPull = newKeysOnLocal.length > 0 || missingTranslationsLocalKeys.length > 0;
  if (!hasPush && !hasPull && status.languages.serverOnly.length === 0) {
    lines.push("");
    lines.push(`  ${FgGreen}Everything is in sync.${Reset}`);
    lines.push("");
    return lines.join("\n");
  }
  if (hasPush) {
    lines.push("");
    lines.push(`  ${FgGreen}${Bold}\u2B06 TO PUSH${Reset}`);
    if (newKeysOnServer.length > 0) {
      lines.push("");
      lines.push(`  ${FgGreen}${newKeysOnServer.length} new keys:${Reset}`);
      renderSection(lines, newKeysOnServer, termWidth, opts.full);
    }
    if (changedKeys.length > 0) {
      lines.push("");
      lines.push(`  ${FgYellow}${changedKeys.length} changed values:${Reset}`);
      renderSection(lines, changedKeys, termWidth, opts.full, { showDiff: true, onlyChanges: true });
    }
    if (missingTranslationsKeys.length > 0) {
      const totalCount = Object.values(comparison.missingTranslationsOnServerPerLanguage).reduce(
        (s, keys) => s + keys.filter((k) => !newKeyNamesOnServer.has(getComparisonKey(k))).length,
        0
      );
      lines.push("");
      lines.push(`  ${FgGreen}${totalCount} missing translations across ${missingTranslationsKeys.length} keys:${Reset}`);
      renderSection(lines, missingTranslationsKeys, termWidth, opts.full, { onlyChanges: true });
    }
  }
  if (hasPull) {
    lines.push("");
    lines.push(`  ${FgBlue}${Bold}\u2B07 TO PULL${Reset}`);
    if (newKeysOnLocal.length > 0) {
      lines.push("");
      lines.push(`  ${FgBlue}${newKeysOnLocal.length} new keys from server:${Reset}`);
      renderSection(lines, newKeysOnLocal, termWidth, opts.full);
    }
    if (missingTranslationsLocalKeys.length > 0) {
      const totalCount = Object.values(comparison.missingTranslationsOnLocalPerLanguage).reduce(
        (s, keys) => s + keys.filter((k) => !newKeyNamesOnLocal.has(getComparisonKey(k))).length,
        0
      );
      lines.push("");
      lines.push(`  ${FgBlue}${totalCount} translations available across ${missingTranslationsLocalKeys.length} keys:${Reset}`);
      renderSection(lines, missingTranslationsLocalKeys, termWidth, opts.full, { onlyChanges: true });
    }
  }
  if (status.languages.serverOnly.length > 0) {
    lines.push("");
    lines.push(`  ${FgYellow}Languages on server not in local files: ${status.languages.serverOnly.join(", ")}${Reset}`);
  }
  lines.push("");
  return lines.join("\n");
}
function renderStatusJson(status) {
  const totalMissingTranslationsToPush = Object.values(
    status.toPush.missingTranslations
  ).reduce((sum, keys) => sum + keys.length, 0);
  const totalMissingTranslationsToPull = Object.values(
    status.toPull.missingTranslations
  ).reduce((sum, keys) => sum + keys.length, 0);
  return JSON.stringify(
    {
      version: 1,
      status: status.needPush || status.needPull ? "has_changes" : "clean",
      summary: {
        languages: status.languages.synced.concat(
          status.languages.localOnly,
          status.languages.serverOnly
        )
      },
      to_push: {
        new_keys: status.toPush.newKeys.map((k) => ({
          key: k.key,
          namespace: k.namespace
        })),
        changed_values: status.toPush.changedValues.map((c) => ({
          key: c.key,
          language: c.language,
          local: c.localValue,
          server: c.serverValue
        })),
        missing_translations: status.toPush.missingTranslations
      },
      to_pull: {
        missing_keys: status.toPull.missingKeys.map((k) => ({
          key: k.key,
          namespace: k.namespace
        })),
        missing_translations: status.toPull.missingTranslations
      },
      issues: {
        server_only_keys: status.issues.serverOnlyKeys.map((key) => ({
          key: key.key,
          namespace: key.namespace,
          label: formatNamespacedKey(key)
        })),
        server_only_languages: status.languages.serverOnly,
        local_only_languages: status.languages.localOnly
      },
      counts: {
        new_keys: status.toPush.newKeys.length,
        changed_values: status.toPush.changedValues.length,
        missing_translations_to_push: totalMissingTranslationsToPush,
        missing_keys_to_pull: status.toPull.missingKeys.length,
        missing_translations_to_pull: totalMissingTranslationsToPull
      }
    },
    null,
    2
  );
}
function renderPushJson(pushPlan, filter) {
  const totalTranslations = Object.values(
    pushPlan.missingTranslationsPerLanguage
  ).reduce((sum, keys) => sum + keys.length, 0);
  return JSON.stringify(
    {
      version: 1,
      command: "push",
      status: pushPlan.hasChanges ? "pushed" : "nothing_to_push",
      filter: filter ? {
        applied: true,
        patterns: filter.patterns,
        selected_keys: filter.pushed,
        withheld_keys: filter.withheld
      } : { applied: false },
      summary: {
        new_languages: pushPlan.newLanguages.map((l) => l.code),
        new_keys: pushPlan.newKeys,
        translations_per_language: pushPlan.missingTranslationsPerLanguage,
        conflicts: pushPlan.conflicts
      },
      counts: {
        new_languages: pushPlan.newLanguages.length,
        new_keys: pushPlan.newKeys.length,
        translations: totalTranslations,
        conflicts: pushPlan.conflicts.length
      }
    },
    null,
    2
  );
}
function renderPullJson(status) {
  const totalPulled = Object.values(
    status.toPull.missingTranslations
  ).reduce((sum, keys) => sum + keys.length, 0);
  return JSON.stringify(
    {
      version: 1,
      command: "pull",
      status: status.needPull ? "pulled" : "nothing_to_pull",
      summary: {
        missing_keys: status.toPull.missingKeys.map((k) => ({
          key: k.key,
          namespace: k.namespace
        })),
        missing_translations: status.toPull.missingTranslations
      },
      counts: {
        missing_keys: status.toPull.missingKeys.length,
        translations: totalPulled
      }
    },
    null,
    2
  );
}

async function reviewCommand(ctx) {
  const pending = await fetchPendingReviews(ctx.host, ctx.projectId, ctx.accessToken);
  if (pending.length === 0) {
    if (ctx.flags.json) {
      const output = {
        version: 1,
        command: "review",
        status: "none",
        summary: { total: 0, approved: 0 }
      };
      console.info(JSON.stringify(output, null, 2));
    } else {
      console.info(`${FgGreen}All translations are approved.${Reset}`);
    }
    return;
  }
  const threshold = ctx.scoreThreshold ?? 80;
  const highScore = pending.filter((p) => p.score !== null && p.score >= threshold);
  const lowScore = pending.filter((p) => p.score === null || p.score < threshold);
  if (!ctx.flags.json) {
    console.info(`
${Bold}${pending.length} translation(s) pending review:${Reset}`);
    if (highScore.length > 0) {
      console.info(`  ${FgGreen}${highScore.length} with score >= ${threshold}${Reset}`);
    }
    if (lowScore.length > 0) {
      console.info(`  ${FgYellow}${lowScore.length} with score < ${threshold} (or unscored)${Reset}`);
    }
    if (ctx.flags.full) {
      console.info("");
      for (const p of pending) {
        const scoreLabel = p.score !== null ? `score: ${p.score}` : "unscored";
        console.info(`  ${Dim}[${p.languageCode}]${Reset} ${p.keyName} ${Dim}(${scoreLabel})${Reset}`);
        if (p.value) {
          console.info(`    ${Dim}${truncate(p.value, 80)}${Reset}`);
        }
      }
    }
  }
  if (ctx.flags.noInteraction) {
    if (highScore.length > 0) {
      const result = await approveTranslations(
        ctx.host,
        ctx.projectId,
        ctx.accessToken,
        highScore.map((p) => p.translationId)
      );
      if (ctx.flags.json) {
        const output = {
          version: 1,
          command: "review",
          status: "approved",
          summary: { total: pending.length, approved: result.approved },
          pending: lowScore
        };
        console.info(JSON.stringify(output, null, 2));
      } else {
        console.info(`
${FgGreen}Auto-approved ${result.approved} translation(s) with score >= ${threshold}.${Reset}`);
        if (lowScore.length > 0) {
          console.info(`${FgYellow}${lowScore.length} translation(s) need manual review.${Reset}`);
        }
      }
    } else {
      if (ctx.flags.json) {
        const output = {
          version: 1,
          command: "review",
          status: "skipped",
          summary: { total: pending.length, approved: 0 },
          pending: lowScore
        };
        console.info(JSON.stringify(output, null, 2));
      } else {
        console.info(`${FgYellow}No translations meet the auto-approve threshold.${Reset}`);
      }
    }
    return;
  }
  if (highScore.length > 0) {
    const shouldApproveHigh = await confirm({
      message: `Approve ${highScore.length} translation(s) with score >= ${threshold}?`
    });
    if (shouldApproveHigh) {
      const result = await approveTranslations(
        ctx.host,
        ctx.projectId,
        ctx.accessToken,
        highScore.map((p) => p.translationId)
      );
      console.info(`${FgGreen}Approved ${result.approved} translation(s).${Reset}`);
    }
  }
  if (lowScore.length > 0) {
    const shouldApproveLow = await confirm({
      message: `Approve remaining ${lowScore.length} translation(s) with lower scores?`,
      default: false
    });
    if (shouldApproveLow) {
      const result = await approveTranslations(
        ctx.host,
        ctx.projectId,
        ctx.accessToken,
        lowScore.map((p) => p.translationId)
      );
      console.info(`${FgGreen}Approved ${result.approved} translation(s).${Reset}`);
    }
  }
}
function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

function computeTranslationWork(params) {
  const {
    mergedKeysByKeyByNamespace,
    targetLanguages,
    strategy,
    onlyExisting,
    emptyValueString,
    languages,
    keys,
    namespaces
  } = params;
  const languageFilter = languages ? new Set(languages) : void 0;
  const selectedKeys = keys && keys.length > 0 || namespaces && namespaces.length > 0 ? resolveSelectedKeys(keys ?? [], mergedKeysByKeyByNamespace, namespaces ?? []) : void 0;
  const result = [];
  for (const keysInNamespace of Object.values(mergedKeysByKeyByNamespace)) {
    for (const key of Object.values(keysInNamespace)) {
      const serverId = key.server?.id;
      if (!serverId) continue;
      if (onlyExisting && !key.local) continue;
      if (selectedKeys && !selectedKeys.has(getComparisonKey(key))) continue;
      const hasApprovedReference = Object.values(key.translations).some(
        (translation) => translation.server?.approved === true && translation.server.currentValue != null && translation.server.currentValue !== ""
      );
      if (!hasApprovedReference) continue;
      const missingLanguages = [];
      for (const lang of targetLanguages) {
        if (languageFilter && !languageFilter.has(lang)) continue;
        const serverTranslation = key.translations[lang]?.server;
        const missing = serverTranslation?.currentValue == null || emptyValueString === "" && serverTranslation.currentValue === "";
        if (strategy === "missing") {
          if (missing) missingLanguages.push(lang);
        } else if (missing || serverTranslation?.approved !== true) {
          missingLanguages.push(lang);
        }
      }
      if (missingLanguages.length > 0) {
        result.push({ keyId: serverId, languages: missingLanguages });
      }
    }
  }
  return result;
}

async function pollTranslationJob(host, projectId, accessToken, jobId, timeoutSeconds, flags) {
  const startTime = Date.now();
  const timeoutMs = timeoutSeconds * 1e3;
  let interval = 2e3;
  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      return {
        status: "timeout",
        progress: 0,
        total: 0,
        finished: 0,
        failed: 0,
        failures: []
      };
    }
    const status = await fetchJobStatus(host, projectId, accessToken, jobId);
    if (!flags.json) {
      process.stdout.write(
        `\r  ${Dim}Progress: ${status.progress}% (${status.finished}/${status.total})${Reset}  `
      );
    }
    if (status.status === "complete" || status.status === "failed") {
      if (!flags.json) {
        process.stdout.write("\n");
      }
      return { ...status, status: status.status };
    }
    await sleep(interval);
    if (elapsed > 1e4) interval = 5e3;
    if (elapsed > 6e4) interval = 1e4;
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function syncAndTranslate(input) {
  const { host, projectId, accessToken, flags } = input;
  const json = flags.json;
  let { syncResult } = input;
  if (!json) console.info(`
${Bold}  Sync & Translate${Reset}
`);
  let pushResult;
  let pushStatus = "nothing_to_push";
  if (syncResult.status.needPush) {
    const keysToRemove = await collectKeysToRemove(input);
    if (!json) console.info(`  Pushing...`);
    syncResult = await input.doPush(keysToRemove);
    pushResult = syncResult.pushResult;
    pushStatus = "pushed";
    const created = pushResult?.createdKeyIds.length ?? 0;
    const updated = pushResult?.updatedKeyIds.length ?? 0;
    if (!json) {
      const parts = [];
      if (created > 0) parts.push(`${created} new key${created !== 1 ? "s" : ""}`);
      if (updated > 0) parts.push(`${updated} updated value${updated !== 1 ? "s" : ""}`);
      if (parts.length > 0) {
        console.info(`  ${FgGreen}\u2713 ${parts.join(", ")} pushed${Reset}`);
      } else {
        console.info(`  ${FgGreen}\u2713 Push complete${Reset}`);
      }
    }
  }
  const pushedKeyIds = [...pushResult?.createdKeyIds ?? [], ...pushResult?.updatedKeyIds ?? []];
  if (pushStatus === "pushed") {
    syncResult = await input.reFetchAndSync();
  }
  const workSet = computeTranslationWork({
    mergedKeysByKeyByNamespace: syncResult.mergedKeysByKeyByNamespace,
    targetLanguages: input.targetLanguages,
    strategy: "missing",
    onlyExisting: input.onlyExisting,
    emptyValueString: input.emptyValueString
  });
  const workKeyIds = new Set(workSet.map((w) => w.keyId));
  let translateSummary;
  if (workSet.length > 0) {
    translateSummary = await questionTranslateLoop({
      host,
      projectId,
      accessToken,
      flags,
      workSet,
      questionKeyIds: workKeyIds
    });
  } else if (!json) {
    console.info(`
  No translations needed.`);
  }
  syncResult = await input.reFetchAndSync();
  let scores;
  if (workKeyIds.size > 0 && !json) {
    try {
      const reviews = await fetchPendingReviews(host, projectId, accessToken);
      const relevantReviews = reviews.filter((r) => workKeyIds.has(r.keyId));
      if (relevantReviews.length > 0) {
        scores = buildScoreMap(relevantReviews);
      }
    } catch {
    }
  }
  const pullToPull = syncResult.status.toPull;
  const pullKeysCount = pullToPull.missingKeys.length;
  const pullTranslationsCount = Object.values(pullToPull.missingTranslations).reduce(
    (sum, keys) => sum + keys.length,
    0
  );
  let pullStatus = "nothing_to_pull";
  if (syncResult.status.needPull) {
    pullStatus = "pulled";
    if (!flags.noInteraction && pushedKeyIds.length > 0) {
      await pullWithTierPicker({
        flags,
        syncResult,
        pushedKeyIds,
        doPull: input.doPull,
        hasS2tContext: true,
        scores
      });
    } else {
      if (!json) console.info(`
  Pulling...`);
      await input.doPull(input.onlyExisting ? { onlyExisting: true } : void 0);
      if (!json) console.info(`  ${FgGreen}\u2713 Translations pulled${Reset}`);
    }
  } else if (!json) {
    console.info(`
  ${FgGreen}\u2713 Nothing new to pull.${Reset}`);
  }
  if (json) {
    const overallStatus = translateSummary?.status === "failed" ? "failed" : translateSummary?.status === "timeout" ? "timeout" : "complete";
    console.info(
      JSON.stringify(
        {
          version: 1,
          command: "sync-and-translate",
          status: overallStatus,
          job_id: translateSummary?.jobId,
          phases: {
            push: {
              status: pushStatus,
              counts: {
                new_keys: pushResult?.createdKeyIds.length ?? 0,
                updated_keys: pushResult?.updatedKeyIds.length ?? 0
              }
            },
            translate: {
              status: translateSummary?.status ?? "skipped",
              counts: {
                total: translateSummary?.total ?? 0,
                finished: translateSummary?.finished ?? 0,
                failed: translateSummary?.failed ?? 0
              },
              failures: translateSummary?.failures ?? []
            },
            pull: {
              status: pullStatus,
              counts: {
                keys: pullKeysCount,
                translations: pullTranslationsCount
              }
            }
          }
        },
        null,
        2
      )
    );
    return translateSummary?.status === "failed" ? 2 : 0;
  }
  if (translateSummary?.status === "failed") {
    console.info(`
${FgYellow}${Bold}  Translation finished with failures.${Reset}
`);
  } else {
    console.info(`
${FgGreen}${Bold}  Done \u2014 your changes are synced.${Reset}
`);
  }
  return translateSummary?.status === "failed" ? 2 : 0;
}
function buildScoreMap(reviews) {
  const map = /* @__PURE__ */ new Map();
  for (const r of reviews) {
    map.set(`${r.keyId}:${r.languageCode}`, r.score);
  }
  return map;
}
async function collectKeysToRemove(input) {
  const serverOnlyKeys = input.syncResult.status.issues.serverOnlyKeys;
  if (serverOnlyKeys.length === 0) return [];
  if (input.flags.noInteraction) return [];
  const preview = serverOnlyKeys.slice(0, 5);
  const remaining = serverOnlyKeys.length - preview.length;
  const keyList = preview.map((key) => formatNamespacedKey(key)).join(", ") + (remaining > 0 ? `, ... +${remaining} more` : "");
  console.info(
    `
  ${FgYellow}${serverOnlyKeys.length} key${serverOnlyKeys.length !== 1 ? "s" : ""} on server not in your local files:${Reset}`
  );
  console.info(`  ${Dim}${keyList}${Reset}
`);
  const action = await select({
    message: "What to do with server-only keys?",
    choices: [
      { value: "keep", name: "Keep on server (do nothing)" },
      { value: "select", name: "View and select which to remove" },
      { value: "remove-all", name: "Remove all from server" }
    ]
  });
  if (action === "keep") return [];
  if (action === "remove-all") {
    return serverOnlyKeys.map((key) => ({
      key: key.key,
      namespace: key.namespace
    }));
  }
  if (action === "select") {
    const removableKeys = new Map(
      serverOnlyKeys.map((key) => [getComparisonKey(key), key])
    );
    const selected = await checkbox({
      message: "Select keys to remove from server:",
      choices: serverOnlyKeys.map((key) => ({
        value: getComparisonKey(key),
        name: formatNamespacedKey(key),
        checked: false
      }))
    });
    if (selected.length > 0) {
      console.info(
        `
  ${Dim}${selected.length} key${selected.length !== 1 ? "s" : ""} selected for removal.${Reset}`
      );
      return selected.flatMap((comparisonKey) => {
        const key = removableKeys.get(comparisonKey);
        if (!key) return [];
        return [{ key: key.key, namespace: key.namespace }];
      });
    }
  }
  return [];
}
async function questionTranslateLoop(input) {
  const { host, projectId, accessToken, flags, workSet, questionKeyIds } = input;
  let iteration = 0;
  let summary;
  while (true) {
    iteration++;
    const label = iteration === 1 ? "Checking for questions" : "Checking for new questions";
    if (!flags.json) {
      process.stdout.write(`
  ${Dim}${label}...${Reset}`);
    }
    const questions = filterQuestionsForKeys(
      await fetchQuestions(host, projectId, accessToken),
      questionKeyIds
    );
    if (questions.length > 0) {
      if (!flags.json) {
        process.stdout.write(` ${questions.length} found.
`);
      }
      if (!flags.noInteraction) {
        await questionsCommand({
          host,
          projectId,
          accessToken,
          flags,
          questions
        });
      }
    } else {
      if (!flags.json) {
        process.stdout.write(` none.
`);
      }
    }
    const keysToTranslate = workSet;
    if (keysToTranslate.length === 0) break;
    if (!flags.json) {
      console.info(
        `
  ${Bold}Translating ${workSet.length} key${workSet.length !== 1 ? "s" : ""}...${Reset}`
      );
    }
    const response = await requestTranslation(host, projectId, accessToken, keysToTranslate);
    const finalStatus = await pollTranslationJob(
      host,
      projectId,
      accessToken,
      response.jobId,
      300,
      flags
    );
    summary = {
      jobId: response.jobId,
      status: finalStatus.status,
      total: finalStatus.total,
      finished: finalStatus.finished,
      failed: finalStatus.failed,
      failures: finalStatus.failures
    };
    if (finalStatus.status === "complete") {
      if (!flags.json) {
        console.info(
          `  ${FgGreen}\u2713 ${finalStatus.finished} translation${finalStatus.finished !== 1 ? "s" : ""} completed${Reset}`
        );
      }
    } else if (finalStatus.status === "failed") {
      if (!flags.json) {
        console.info(
          `  ${FgYellow}Translation finished with failures: ${finalStatus.failed}/${finalStatus.total} failed.${Reset}`
        );
      }
      for (const failure of finalStatus.failures) {
        if (!flags.json) {
          console.info(`  ${failure.process_id}: ${failure.message}`);
        }
      }
      break;
    } else {
      if (!flags.json) {
        console.info(
          `  ${FgYellow}Translation timed out. Your keys were pushed. Run \`babli pull\` later.${Reset}`
        );
      }
      break;
    }
    if (flags.noInteraction) break;
    if (iteration >= 3) break;
    const newQuestions = filterQuestionsForKeys(
      await fetchQuestions(host, projectId, accessToken),
      questionKeyIds
    );
    if (newQuestions.length === 0) break;
    if (!flags.json) {
      console.info(
        `
  ${FgYellow}${newQuestions.length} new question${newQuestions.length !== 1 ? "s" : ""} found after translation.${Reset}`
      );
    }
  }
  return summary;
}
function filterQuestionsForKeys(questions, keyIds) {
  return questions.filter((question) => keyIds.has(question.keyId));
}
async function pullWithTierPicker(input) {
  const { flags, pushedKeyIds, doPull, hasS2tContext, scores } = input;
  const comparison = input.syncResult.comparison;
  const uniquePullKeys = deduplicatePullKeys(comparison);
  function pushedKeysAsComparisonKeys() {
    const pushedIdSet = new Set(pushedKeyIds);
    return new Set(
      uniquePullKeys.filter((k) => k.server && pushedIdSet.has(k.server.id)).map((k) => getComparisonKey(k))
    );
  }
  if (flags.noInteraction) {
    if (!flags.json) console.info(`
  Pulling translations for pushed keys...`);
    await doPull({ selectedKeys: pushedKeysAsComparisonKeys() });
    if (!flags.json) console.info(`  ${FgGreen}\u2713 Translations pulled${Reset}`);
    return;
  }
  if (uniquePullKeys.length > 0) {
    const termWidth = process.stdout.columns ?? 80;
    console.info(`
  ${Bold}Keys to pull:${Reset}
`);
    const { text, hiddenCount } = renderKeyCards(uniquePullKeys, termWidth, {
      scores
    });
    console.info(text);
    if (hiddenCount > 0) {
      console.info(`
  ${Dim}... ${hiddenCount} more keys${Reset}`);
    }
  }
  console.info("");
  const choices = [];
  if (hasS2tContext && pushedKeyIds.length > 0) {
    choices.push({
      value: "my-keys",
      name: `Pull my translations only (${pushedKeyIds.length} just translated)`
    });
  }
  const newCount = input.syncResult.status.toPull.missingKeys.length;
  if (newCount > 0) {
    const changedCount = new Set(
      Object.values(input.syncResult.status.toPull.missingTranslations).flat()
    ).size;
    choices.push({
      value: "only-existing",
      name: `Pull only updates to existing keys (${changedCount} changed, skip ${newCount} new)`
    });
  }
  choices.push({
    value: "all",
    name: "Pull all translations"
  });
  choices.push({ value: "skip", name: "Skip pull" });
  const tier = await select({
    message: "What to pull?",
    choices
  });
  if (tier === "skip") return;
  console.info(`
  Pulling...`);
  if (tier === "my-keys") {
    await doPull({ selectedKeys: pushedKeysAsComparisonKeys() });
  } else if (tier === "only-existing") {
    await doPull({ onlyExisting: true });
  } else {
    await doPull();
  }
  console.info(`  ${FgGreen}\u2713 Translations pulled${Reset}`);
}
function deduplicatePullKeys(comparison) {
  const pullKeys = [
    ...Object.values(comparison.missingKeysOnLocal),
    ...Object.values(comparison.missingTranslationsOnLocalPerLanguage).flat()
  ];
  const seen = /* @__PURE__ */ new Set();
  return pullKeys.filter((k) => {
    const ck = getComparisonKey(k);
    if (seen.has(ck)) return false;
    seen.add(ck);
    return true;
  });
}
async function pullFromDashboard(input) {
  await pullWithTierPicker({
    ...input,
    pushedKeyIds: [],
    hasS2tContext: false
  });
}

function getTargetLanguageCodes(languages) {
  return languages.filter((language) => !language.isSource).map((language) => language.code);
}

function serializeCliError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof CliRequestError)) return { message };
  return {
    message,
    ...error.code ? { code: error.code } : {},
    ...error.httpStatus !== void 0 ? { http_status: error.httpStatus } : {}
  };
}

async function keyListCommand(ctx, options) {
  const result = await listCliKeys(ctx.host, ctx.projectId, ctx.accessToken, {
    includeArchived: options.includeArchived,
    query: options.query
  });
  if (ctx.flags.json) {
    printJson({
      command: "key_list",
      keys: result.keys,
      status: "ok",
      version: 1
    });
    return;
  }
  if (result.keys.length === 0) {
    console.info(`${FgGreen}No keys found.${Reset}`);
    return;
  }
  for (const key of result.keys) {
    console.info(formatKeyLine(key));
  }
}
async function keyGetCommand(ctx, options) {
  const result = await getCliKey(ctx.host, ctx.projectId, ctx.accessToken, {
    includeArchived: options.includeArchived,
    locator: makeLocator(options)
  });
  if (ctx.flags.json) {
    printJson({
      command: "key_get",
      key: result.key,
      status: "ok",
      version: 1
    });
    return;
  }
  console.info(formatKeyLine(result.key));
  for (const translation of result.key.translations) {
    console.info(
      `  ${translation.language?.code ?? translation.languageId}: ${translation.currentVersion.value ?? ""}`
    );
  }
}
async function keyAddCommand(ctx, options) {
  if (!options.key) {
    throw new Error("Missing --key");
  }
  const result = await addCliKey(ctx.host, ctx.projectId, ctx.accessToken, {
    description: options.description,
    key: options.key,
    namespace: options.namespace ?? "",
    source: options.source ?? "",
    translations: parseTranslations(options.translation ?? [])
  });
  if (ctx.flags.json) {
    printJson({
      command: "key_add",
      key: result.key,
      status: "created",
      version: 1
    });
    return;
  }
  console.info(`${FgGreen}Created key:${Reset} ${formatKeyLine(result.key)}`);
}
async function keyUpdateCommand(ctx, options) {
  const result = await updateCliKey(ctx.host, ctx.projectId, ctx.accessToken, {
    description: options.description,
    locator: makeLocator(options),
    namespace: options.newNamespace,
    source: options.source
  });
  if (ctx.flags.json) {
    printJson({
      command: "key_update",
      key: result.key,
      status: "updated",
      version: 1
    });
    return;
  }
  console.info(`${FgGreen}Updated key:${Reset} ${formatKeyLine(result.key)}`);
}
async function keyRenameCommand(ctx, options) {
  if (!options.to) {
    throw new Error("Missing --to");
  }
  const result = await renameCliKey(ctx.host, ctx.projectId, ctx.accessToken, {
    locator: makeLocator(options),
    to: options.to
  });
  if (ctx.flags.json) {
    printJson({
      command: "key_rename",
      key: result.key,
      status: "renamed",
      version: 1
    });
    return;
  }
  console.info(`${FgGreen}Renamed key:${Reset} ${formatKeyLine(result.key)}`);
}
async function keyArchiveCommand(ctx, options) {
  const result = await archiveCliKey(ctx.host, ctx.projectId, ctx.accessToken, {
    locator: makeLocator(options)
  });
  if (ctx.flags.json) {
    printJson({
      command: "key_archive",
      key: result.key,
      status: "archived",
      version: 1
    });
    return;
  }
  console.info(`${FgGreen}Archived key:${Reset} ${formatKeyLine(result.key)}`);
}
async function keyUnarchiveCommand(ctx, options) {
  const result = await unarchiveCliKey(ctx.host, ctx.projectId, ctx.accessToken, {
    locator: makeLocator(options)
  });
  if (ctx.flags.json) {
    printJson({
      command: "key_unarchive",
      key: result.key,
      status: "unarchived",
      version: 1
    });
    return;
  }
  console.info(`${FgGreen}Unarchived key:${Reset} ${formatKeyLine(result.key)}`);
}
async function translationUpsertCommand(ctx, options) {
  if (!options.language) {
    throw new Error("Missing --language");
  }
  const value = await readValue(options, ctx.flags);
  const result = await upsertCliTranslation(
    ctx.host,
    ctx.projectId,
    ctx.accessToken,
    {
      approve: options.approve,
      keyLocator: makeLocator(options),
      languageCode: options.language,
      value
    }
  );
  if (ctx.flags.json) {
    printJson({
      command: "translation_upsert",
      status: "upserted",
      translation: result.translation,
      version: 1
    });
    return;
  }
  console.info(
    `${FgGreen}Upserted translation:${Reset} ${result.translation.id}`
  );
}
async function translationApproveCommand(ctx, translationId) {
  const result = await approveCliTranslation(
    ctx.host,
    ctx.projectId,
    ctx.accessToken,
    translationId
  );
  if (ctx.flags.json) {
    printJson({
      command: "translation_approve",
      status: "approved",
      translation: result.translation,
      version: 1
    });
    return;
  }
  console.info(`${FgGreen}Approved translation:${Reset} ${translationId}`);
}
async function translationUnapproveCommand(ctx, translationId) {
  const result = await unapproveCliTranslation(
    ctx.host,
    ctx.projectId,
    ctx.accessToken,
    translationId
  );
  if (ctx.flags.json) {
    printJson({
      command: "translation_unapprove",
      status: "unapproved",
      translation: result.translation,
      version: 1
    });
    return;
  }
  console.info(`${FgGreen}Unapproved translation:${Reset} ${translationId}`);
}
async function projectGetCommand(ctx) {
  const result = await getCliProject(ctx.host, ctx.projectId, ctx.accessToken);
  if (ctx.flags.json) {
    printJson({
      command: "project_get",
      project: result.project,
      status: "ok",
      version: 1
    });
    return;
  }
  console.info(`${Bold}${result.project.name}${Reset}`);
  console.info(`id: ${result.project.id}`);
  console.info(`description: ${result.project.description}`);
  console.info(`instructions: ${result.project.instructions}`);
}
async function projectUpdateCommand(ctx, options) {
  const description = await readMutuallyExclusiveValue({
    direct: options.description,
    directName: "--description",
    file: options.descriptionFile,
    fileName: "--description-file",
    flags: ctx.flags
  });
  const instructions = await readMutuallyExclusiveValue({
    direct: options.instructions,
    directName: "--instructions",
    file: options.instructionsFile,
    fileName: "--instructions-file",
    flags: ctx.flags
  });
  if (options.name === void 0 && description === void 0 && instructions === void 0) {
    throw new Error("Provide at least one project field to update.");
  }
  const result = await updateCliProject(ctx.host, ctx.projectId, ctx.accessToken, {
    description,
    instructions,
    name: options.name
  });
  if (ctx.flags.json) {
    printJson({
      command: "project_update",
      project: result.project,
      status: "updated",
      version: 1
    });
    return;
  }
  console.info(`${FgGreen}Updated project:${Reset} ${result.project.name}`);
}
function makeLocator(options) {
  if (options.keyId && options.key) {
    throw new Error("Use either --key-id or --key, not both.");
  }
  if (options.keyId) {
    return { keyId: options.keyId };
  }
  if (options.key) {
    return { key: options.key, namespace: options.namespace };
  }
  throw new Error("Provide --key-id or --key.");
}
function parseTranslations(items) {
  return items.map((item) => {
    const separatorIndex = item.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error(`Invalid --translation value "${item}". Use code=value.`);
    }
    return {
      language: item.slice(0, separatorIndex),
      value: item.slice(separatorIndex + 1)
    };
  });
}
async function readValue(options, flags) {
  const value = await readMutuallyExclusiveValue({
    direct: options.value,
    directName: "--value",
    file: options.valueFile,
    fileName: "--value-file",
    flags,
    required: true
  });
  if (value === void 0) {
    throw new Error("Provide --value or --value-file.");
  }
  return value;
}
async function readMutuallyExclusiveValue(input) {
  if (input.direct !== void 0 && input.file !== void 0) {
    throw new Error(`Use either ${input.directName} or ${input.fileName}, not both.`);
  }
  if (input.direct !== void 0) {
    return input.direct;
  }
  if (input.file === void 0) {
    if (input.required) {
      throw new Error(`Provide ${input.directName} or ${input.fileName}.`);
    }
    return void 0;
  }
  if (input.file === "-") {
    if (stdin.isTTY && input.flags.noInteraction) {
      throw new Error(`${input.fileName} - would read from an interactive terminal.`);
    }
    return readStdin();
  }
  return fs__default.readFile(input.file, "utf8");
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}
function formatKeyLine(key) {
  const namespace = key.namespace ? `${key.namespace}:` : "";
  const archived = key.deleted ? " archived" : "";
  return `${namespace}${key.key} ${key.id}${archived}`;
}

async function jobCommand(ctx, options) {
  const status = options.wait ? await pollTranslationJob(
    ctx.host,
    ctx.projectId,
    ctx.accessToken,
    options.jobId,
    options.timeout,
    ctx.flags
  ) : await fetchJobStatus(ctx.host, ctx.projectId, ctx.accessToken, options.jobId);
  if (ctx.flags.json) {
    console.info(
      JSON.stringify(
        {
          version: 1,
          command: "job",
          status: status.status,
          job_id: options.jobId,
          counts: {
            total: status.total,
            finished: status.finished,
            failed: status.failed,
            progress: status.progress
          },
          failures: status.failures.length > 0 ? status.failures : void 0
        },
        null,
        2
      )
    );
    return status.status === "failed" ? 2 : 0;
  }
  if (status.status === "complete") {
    console.info(
      `${FgGreen}Job complete: ${status.finished}/${status.total} processes finished.${Reset}`
    );
  } else if (status.status === "failed") {
    console.info(
      `${FgYellow}Job finished with failures: ${status.failed}/${status.total} failed.${Reset}`
    );
    for (const failure of status.failures) {
      console.info(`  ${failure.process_id}: ${failure.message}`);
    }
  } else if (status.status === "timeout") {
    console.info(`${FgYellow}Still running. Job continues on server.${Reset}`);
    console.info(`Run ${Bold}babli job ${options.jobId}${Reset} to check again.`);
  } else {
    console.info(`Job ${status.status}: ${status.finished}/${status.total} processes finished.`);
  }
  if (status.status !== "failed") {
    for (const failure of status.failures) {
      console.info(`  ${failure.process_id}: ${failure.message}`);
    }
  }
  return status.status === "failed" ? 2 : 0;
}

function emitJson(output) {
  console.info(JSON.stringify(output, null, 2));
}
function summarize(work, strategy) {
  const languages = /* @__PURE__ */ new Set();
  let languagePairs = 0;
  for (const item of work) {
    languagePairs += item.languages.length;
    for (const lang of item.languages) languages.add(lang);
  }
  return {
    keys: work.length,
    language_pairs: languagePairs,
    languages: [...languages].sort(),
    strategy
  };
}
async function translateCommand(input) {
  try {
    validateLanguages(input);
  } catch (error) {
    return reportFailure(input, void 0, error);
  }
  const work = computeWork(input);
  const summary = summarize(work, input.strategy);
  if (work.length === 0) {
    if (input.flags.json) {
      emitJson({
        version: 1,
        command: "translate",
        status: "skipped",
        summary
      });
    } else {
      console.info(`${FgGreen}No missing translations to process.${Reset}`);
    }
    return 0;
  }
  if (input.dryRun) {
    if (input.flags.json) {
      emitJson({
        version: 1,
        command: "translate",
        status: "dry_run",
        summary
      });
    } else {
      printDryRun(work, summary, input.flags.full);
    }
    return 0;
  }
  if (input.estimate) {
    return runEstimate(input, work, summary);
  }
  if (!input.flags.json) {
    console.info(
      `
${Bold}Translating ${summary.keys} key(s), ${summary.language_pairs} language pair(s)...${Reset}`
    );
  }
  let response;
  try {
    response = await requestTranslation(
      input.host,
      input.projectId,
      input.accessToken,
      work,
      input.model
    );
  } catch (err) {
    return reportFailure(input, void 0, err);
  }
  const shouldWait = input.wait || !input.flags.noInteraction;
  if (!shouldWait) {
    if (input.flags.json) {
      emitJson({
        version: 1,
        command: "translate",
        status: "started",
        job_id: response.jobId,
        summary
      });
    } else {
      console.info(
        `${Dim}Job started: ${response.jobId} (${response.numberOfProcesses} processes)${Reset}`
      );
      console.info(`Run ${Bold}babli job ${response.jobId}${Reset} to check status.`);
    }
    return 0;
  }
  if (!input.flags.json) {
    console.info(
      `${Dim}Job started: ${response.jobId} (${response.numberOfProcesses} processes)${Reset}`
    );
  }
  let finalStatus;
  try {
    finalStatus = await pollTranslationJob(
      input.host,
      input.projectId,
      input.accessToken,
      response.jobId,
      input.timeout,
      input.flags
    );
  } catch (err) {
    return reportFailure(input, response.jobId, err);
  }
  if (input.flags.json) {
    emitJson({
      version: 1,
      command: "translate",
      status: finalStatus.status,
      job_id: response.jobId,
      counts: {
        total: finalStatus.total,
        finished: finalStatus.finished,
        failed: finalStatus.failed
      },
      failures: finalStatus.failures.length > 0 ? finalStatus.failures : void 0
    });
  } else if (finalStatus.status === "complete") {
    console.info(
      `${FgGreen}Translation complete: ${finalStatus.finished}/${finalStatus.total} processes finished.${Reset}`
    );
  } else if (finalStatus.status === "failed") {
    console.info(
      `${FgYellow}Translation finished with failures: ${finalStatus.failed}/${finalStatus.total} failed.${Reset}`
    );
    for (const failure of finalStatus.failures) {
      console.info(`  ${failure.process_id}: ${failure.message}`);
    }
  } else {
    console.info(
      `${FgYellow}Translation timed out after ${input.timeout}s. Job continues on server.${Reset}`
    );
    console.info(`Run ${Bold}babli job ${response.jobId}${Reset} to check status.`);
  }
  return finalStatus.status === "failed" ? 2 : 0;
}
async function runEstimate(input, work, summary) {
  let estimate;
  try {
    estimate = await estimateTranslation(
      input.host,
      input.projectId,
      input.accessToken,
      work,
      input.model
    );
  } catch (err) {
    return reportFailure(input, void 0, err);
  }
  const credits = {
    total: estimate.creditsToUse.total,
    monthly: estimate.creditsToUse.monthly,
    persistent: estimate.creditsToUse.persistent,
    has_enough: estimate.creditsToUse.hasEnough,
    need_to_buy: estimate.creditsToUse.needToBuy
  };
  if (input.flags.json) {
    emitJson({
      version: 1,
      command: "translate",
      status: "estimate",
      summary,
      credits
    });
  } else {
    console.info(
      `
${Bold}Estimate: ${summary.keys} key(s), ${summary.language_pairs} language pair(s).${Reset}`
    );
    console.info(
      `${Dim}Credits needed: ${credits.total} (monthly ${credits.monthly}, persistent ${credits.persistent})${Reset}`
    );
    if (credits.has_enough) {
      console.info(`${FgGreen}You have enough credits.${Reset}`);
    } else {
      console.info(
        `${FgYellow}Not enough credits \u2014 need to buy ${credits.need_to_buy} more.${Reset}`
      );
    }
  }
  return 0;
}
function reportFailure(input, jobId, err) {
  if (input.flags.json) {
    emitJson({
      version: 1,
      command: "translate",
      status: "failed",
      job_id: jobId,
      counts: { total: 0, finished: 0, failed: 0 },
      error: serializeCliError(err)
    });
  } else {
    const message = serializeCliError(err).message;
    console.error(`${FgRed}Translation failed: ${message}${Reset}`);
  }
  return 2;
}
function printDryRun(work, summary, full) {
  console.info(
    `
${Bold}Dry run \u2014 would translate ${summary.keys} key(s), ${summary.language_pairs} language pair(s).${Reset}`
  );
  console.info(
    `${Dim}Languages: ${summary.languages.join(", ")} \xB7 strategy: ${summary.strategy}${Reset}`
  );
  const limit = full ? work.length : 10;
  for (const item of work.slice(0, limit)) {
    console.info(`  ${item.keyId}: ${item.languages.join(", ")}`);
  }
  if (work.length > limit) {
    console.info(
      `  ${Dim}... and ${work.length - limit} more. Run with --full for the complete list.${Reset}`
    );
  }
}
function validateLanguages(input) {
  if (!input.languages) return;
  const allowed = new Set(input.targetLanguages);
  const unknown = input.languages.filter((lang) => !allowed.has(lang));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown language code(s): ${unknown.join(", ")}. Project target languages: ${input.targetLanguages.join(", ")}.`
    );
  }
}
function computeWork(input) {
  if (input.keyIds && input.keyIds.length > 0) {
    const languages = input.languages ?? input.targetLanguages;
    if (languages.length === 0) return [];
    return input.keyIds.map((keyId) => ({ keyId, languages }));
  }
  return computeTranslationWork({
    mergedKeysByKeyByNamespace: input.syncResult.mergedKeysByKeyByNamespace,
    targetLanguages: input.targetLanguages,
    strategy: input.strategy,
    onlyExisting: input.onlyExisting,
    emptyValueString: input.emptyValueString,
    languages: input.languages,
    keys: input.keys,
    namespaces: input.namespaces
  });
}

const packageJson = JSON.parse(
  fsSync.readFileSync(new URL("../package.json", import.meta.url), "utf8")
);
const buildInfo = readBuildInfo();
const program = new Command();
let activeCommand = program;
program.hook("preAction", (_thisCommand, actionCommand) => {
  activeCommand = actionCommand;
});
const rootHelpText = `Babli.ai translation management CLI.

Run without arguments in a terminal for the interactive workflow (or use \`babli interactive\`).

Usage:
  babli [options] [command]

Options:
  --json             Output one stable JSON object
  --no-interaction   Skip prompts and use safe defaults
  --full             Show untruncated output
  -V, --version      Show version
  -h, --help         Show help

Commands:
  init                         Initialize a new Babli project
  login                        Login to Babli.ai
  logout                       Logout from Babli.ai
  interactive | i              Interactive workflow (dashboard and menu)

  status                       Show local/remote sync status
  push                         Push local keys and translations
  pull                         Pull translations to local files
  sync-and-translate           Push, translate, and pull results

  translate                    Request AI translations for missing translations
  translate --key-id <id>      Request AI translations for one remote key
  job <jobId>                  Check the status of a translation job

  questions                    Show and answer translation questions
  review                       Review and approve translations
  proofread                    Run AI proofreading

  key list                     List remote keys
  key get                      Get one remote key
  key add                      Add a remote key
  key update                   Update key metadata/source text
  key rename                   Rename a remote key
  key archive                  Archive a remote key
  key unarchive                Unarchive a remote key

  translation upsert           Create or update a translation
  translation approve          Approve a translation
  translation unapprove        Unapprove a translation

  project get                  Show remote project metadata
  project update               Update remote project metadata

Examples:
  babli status
  babli push --no-interaction
  babli pull --only-approved
  babli translate --languages cs,de
  babli translate --key-id key_123 --languages cs,de
  babli key list --json
  babli key archive --key-id key_123
  babli translation upsert --key-id key_123 --language cs --value "Ahoj"
  babli project update --instructions-file ./babli-instructions.md

Run \`babli <command> --help\` for command-specific options and examples.
`;
program.configureOutput({
  writeErr: (str) => {
    if (!getGlobalFlags().json) {
      process.stderr.write(str);
    }
  }
});
program.configureHelp({
  formatHelp: (command, helper) => {
    if (command === program) {
      return rootHelpText;
    }
    return Help.prototype.formatHelp.call(helper, command, helper);
  }
});
program.option("--json", "Output results as JSON (stable schema for agents/CI)").option("--no-interaction", "Skip all prompts, use safe defaults").option("--full", "Show all items without truncation");
program.command("interactive").alias("i").description("Interactive workflow (dashboard and menu)").action(async () => {
  await run({ action: "workflow" });
});
program.command("login").description("Login to Babli.ai").action(async () => {
  await run({ action: "login" });
});
program.command("logout").description("Logout from Babli.ai").action(async () => {
  await run({ action: "logout" });
});
program.command("push").description("Push local keys and translations to server").option(
  "--resolve <strategy>",
  "Resolve push conflicts non-interactively: local | server"
).option(
  "--key <pattern>",
  'Only push keys matching this glob (repeatable; quote it; "namespace:key" or a glob like "auth:*")',
  collectOption,
  []
).option(
  "--namespace <pattern>",
  'Only push keys in namespaces matching this glob (repeatable; quote it; "*" matches all incl. the default namespace, "" matches only the default)',
  collectOption,
  []
).addHelpText(
  "after",
  '\nExamples:\n  babli push                          # interactive, confirm each step\n  babli push --resolve local           # overwrite server for all conflicts\n  babli push --no-interaction          # push all, no prompts\n  babli push --json --no-interaction   # for CI/agents\n  babli push --key "auth:*"            # only push keys in the auth namespace\n  babli push --namespace checkout      # only push the checkout namespace\n  babli push --key "auth:*" --json --no-interaction  # preview the scoped plan\n\n--key and --namespace combine with AND (a key must match both).'
).action(async (options) => {
  await run({
    action: "push",
    keys: options.key,
    namespaces: options.namespace
  });
});
program.command("pull").description("Pull translations from server to local files").option("--only-approved", "Only pull translations that are approved").option("--only-existing", "Only pull updates to keys that already exist locally").option(
  "--key <pattern>",
  'Only pull keys matching this glob (repeatable; quote it; "namespace:key" or a glob like "auth:*")',
  collectOption,
  []
).option(
  "--namespace <pattern>",
  'Only pull keys in namespaces matching this glob (repeatable; quote it; "*" matches all incl. the default namespace, "" matches only the default)',
  collectOption,
  []
).addHelpText(
  "after",
  `
Examples:
  babli pull                       # pull all translations
  babli pull --only-approved       # only approved translations
  babli pull --only-existing       # skip new keys, update existing only
  babli pull --key hello --key bye # only pull these keys
  babli pull --key auth:login      # pull a key in the 'auth' namespace
  babli pull --key "user.profile.*" # pull keys under a prefix
  babli pull --namespace checkout  # pull the whole checkout namespace

--key and --namespace combine with AND (a key must match both).`
).action(
  async (options) => {
    await run({
      action: "pull",
      options: {
        onlyApproved: options.onlyApproved,
        onlyExisting: options.onlyExisting,
        keys: options.key,
        namespaces: options.namespace
      }
    });
  }
);
program.command("status").description("Show sync status between local files and server").addHelpText(
  "after",
  "\nExamples:\n  babli status              # grouped summary\n  babli status --full       # show all items\n  babli status --json       # JSON output for agents"
).action(async () => {
  await run({ action: "status" });
});
program.command("translate").description("Trigger AI translation for missing translations").option(
  "--strategy <strategy>",
  "Which translations to (re)generate: missing | not-approved",
  "missing"
).option(
  "--languages <codes>",
  "Only translate these languages (comma-separated)"
).option("--only-existing", "Only translate keys that exist in your local files").option(
  "--key <pattern>",
  'Only translate keys matching this glob (repeatable; quote it; "namespace:key" or a glob like "auth:*")',
  collectOption,
  []
).option(
  "--namespace <pattern>",
  'Only translate keys in namespaces matching this glob (repeatable; quote it; "*" matches all incl. the default namespace, "" matches only the default)',
  collectOption,
  []
).option(
  "--key-id <id>",
  "Translate this key id directly, bypassing local sync status (repeatable)",
  collectOption,
  []
).option("--key-ids <ids>", "Translate these key ids (comma-separated)").option("--model <model>", "Translation model: production | preview", "production").option("--dry-run", "Print the work-set without spending credits or starting a job").option("--estimate", "Print the real credit cost without spending or starting a job").option(
  "--wait",
  "Block and poll until the job finishes (non-interactive mode returns the job id immediately by default)"
).option("--timeout <seconds>", "Max wait time when polling", "300").addHelpText(
  "after",
  '\nExamples:\n  babli translate                    # translate all missing, interactive\n  babli translate --languages cs,de  # only Czech and German\n  babli translate --strategy not-approved  # also re-translate unapproved drafts\n  babli translate --only-existing    # skip keys not in local files\n  babli translate --key "auth:*"     # only translate the auth namespace\n  babli translate --namespace checkout  # only translate the checkout namespace\n  babli translate --key-ids key_1,key_2 --no-interaction\n  babli translate --dry-run --json   # preview work-set, no spend\n  babli translate --estimate --json  # real credit cost, no spend\n  babli translate --json --no-interaction  # dispatch and return a job id\n  babli translate --json --no-interaction --wait  # dispatch and wait for the result\n\n--key and --namespace combine with AND (a key must match both).'
).action(
  async (options) => {
    const timeout = parseInt(options.timeout, 10);
    if (Number.isNaN(timeout) || timeout <= 0) {
      throw new Error(`Invalid --timeout value: "${options.timeout}"`);
    }
    if (options.dryRun && options.estimate) {
      throw new Error("Use either --dry-run or --estimate, not both.");
    }
    if (options.strategy !== "missing" && options.strategy !== "not-approved") {
      throw new Error(
        `Invalid --strategy value: "${options.strategy}". Use "missing" or "not-approved".`
      );
    }
    if (options.model !== "production" && options.model !== "preview") {
      throw new Error(
        `Invalid --model value: "${options.model}". Use "production" or "preview".`
      );
    }
    const keyIds = [
      ...options.keyId,
      ...options.keyIds ? options.keyIds.split(",").map((id) => id.trim()).filter(Boolean) : []
    ];
    if ((options.key.length > 0 || options.namespace.length > 0) && keyIds.length > 0) {
      throw new Error(
        "Use either --key/--namespace or --key-id/--key-ids, not both."
      );
    }
    await run({
      action: "translate",
      options: {
        strategy: options.strategy,
        languages: options.languages?.split(",").map((l) => l.trim()),
        onlyExisting: options.onlyExisting === true,
        keys: options.key,
        namespaces: options.namespace,
        keyIds,
        model: options.model,
        dryRun: options.dryRun === true,
        estimate: options.estimate === true,
        timeout,
        wait: options.wait === true
      }
    });
  }
);
program.command("job").description("Check the status of a translation job").argument("<jobId>", "Job id returned by translate").option("--wait", "Block and poll until the job finishes").option("--timeout <seconds>", "Max wait time when polling", "300").addHelpText(
  "after",
  "\nExamples:\n  babli job job_123             # check status once\n  babli job job_123 --wait      # poll until finished\n  babli job job_123 --json      # JSON output for agents"
).action(
  async (jobId, options) => {
    const timeout = parseInt(options.timeout, 10);
    if (Number.isNaN(timeout) || timeout <= 0) {
      throw new Error(`Invalid --timeout value: "${options.timeout}"`);
    }
    await run({
      action: "job",
      options: { jobId, timeout, wait: options.wait === true }
    });
  }
);
const keyCommand = program.command("key").description("Manage remote project keys");
withGlobalOptions(keyCommand.command("list")).description("List remote keys").option("--query <text>", "Filter by key text").option("--include-archived", "Include archived keys").action(async (options) => {
  await run({
    action: "key-list",
    options: {
      includeArchived: options.includeArchived === true,
      query: options.query
    }
  });
});
withGlobalOptions(keyCommand.command("get")).description("Get one remote key").option("--key-id <id>", "Key id").option("--key <name>", "Key name").option("--namespace <namespace>", "Key namespace").option("--include-archived", "Allow archived key lookup").action(async (options) => {
  await run({
    action: "key-get",
    options: {
      ...options,
      includeArchived: options.includeArchived === true
    }
  });
});
withGlobalOptions(keyCommand.command("add")).description("Add one remote key").requiredOption("--key <name>", "Key name").option("--namespace <namespace>", "Key namespace", "").option("--source <text>", "Source metadata", "").option("--description <text>", "Key description").option("--translation <code=value>", "Approved translation", collectOption, []).action(async (options) => {
  await run({ action: "key-add", options });
});
withGlobalOptions(keyCommand.command("update")).description("Update key metadata").option("--key-id <id>", "Key id").option("--key <name>", "Key name").option("--namespace <namespace>", "Namespace for key lookup").option("--new-namespace <namespace>", "New namespace").option("--source <text>", "Source metadata").option("--description <text>", "Key description").action(async (options) => {
  await run({ action: "key-update", options });
});
withGlobalOptions(keyCommand.command("rename")).description("Rename one key").option("--key-id <id>", "Key id").option("--key <name>", "Key name").option("--namespace <namespace>", "Key namespace").requiredOption("--to <new-key>", "New key name").action(async (options) => {
  await run({ action: "key-rename", options });
});
withGlobalOptions(keyCommand.command("archive")).description("Archive one key").option("--key-id <id>", "Key id").option("--key <name>", "Key name").option("--namespace <namespace>", "Key namespace").action(async (options) => {
  await run({ action: "key-archive", options });
});
withGlobalOptions(keyCommand.command("unarchive")).description("Unarchive one key").option("--key-id <id>", "Key id").option("--key <name>", "Key name").option("--namespace <namespace>", "Key namespace").action(async (options) => {
  await run({ action: "key-unarchive", options });
});
const translationCommand = program.command("translation").description("Manage remote translations");
withGlobalOptions(translationCommand.command("upsert")).description("Create or update one translation").option("--key-id <id>", "Key id").option("--key <name>", "Key name").option("--namespace <namespace>", "Key namespace").requiredOption("--language <code>", "Language code").option("--value <text>", "Translation value").option("--value-file <path>", "Read translation value from a file or -").option("--approve", "Approve the translation").action(async (options) => {
  await run({
    action: "translation-upsert",
    options: { ...options, approve: options.approve === true }
  });
});
withGlobalOptions(translationCommand.command("approve")).description("Approve one translation").argument("<translation-id>").action(async (translationId) => {
  await run({ action: "translation-approve", translationId });
});
withGlobalOptions(translationCommand.command("unapprove")).description("Unapprove one translation").argument("<translation-id>").action(async (translationId) => {
  await run({ action: "translation-unapprove", translationId });
});
const projectCommand = program.command("project").description("Manage remote project metadata");
withGlobalOptions(projectCommand.command("get")).description("Get remote project metadata").option("--project <id>", "Project id (defaults to babli.json project)").action(async (options) => {
  await run({ action: "project-get", options });
});
withGlobalOptions(projectCommand.command("list")).description("List projects across your organizations").option("--organization <id>", "Filter to one organization").action(async (options) => {
  await run({ action: "project-list", options });
});
withGlobalOptions(projectCommand.command("create")).description("Create a new project").requiredOption("--name <name>", "Project name").requiredOption("--organization <id>", "Organization id").option("--type <type>", "Project type: key | document", "key").option("--description <text>", "Project description").option("--languages <codes>", "Comma-separated language codes; first is the source").action(async (options) => {
  await run({ action: "project-create", options });
});
withGlobalOptions(projectCommand.command("update")).description("Update remote project metadata").option("--name <name>", "Project name").option("--description <text>", "Project description").option("--description-file <path>", "Read project description from a file or -").option("--instructions <text>", "Project translation instructions").option("--instructions-file <path>", "Read project instructions from a file or -").action(async (options) => {
  await run({ action: "project-update", options });
});
program.command("sync-and-translate").description("Push local changes, translate, and pull results").option(
  "--resolve <strategy>",
  "Resolve push conflicts non-interactively: local | server"
).option(
  "--only-existing",
  "Only translate and pull keys that exist in your local files"
).addHelpText(
  "after",
  "\nExamples:\n  babli sync-and-translate                    # interactive\n  babli sync-and-translate --no-interaction   # non-interactive\n  babli sync-and-translate --only-existing    # skip keys not in local files\n  babli sync-and-translate --json             # for AI agents"
).action(async (options) => {
  await run({
    action: "sync-and-translate",
    options: { onlyExisting: options.onlyExisting === true }
  });
});
program.command("questions").description("Show and answer unanswered translation questions").addHelpText(
  "after",
  "\nExamples:\n  babli questions                    # interactive\n  babli questions --json             # JSON output for agents"
).action(async () => {
  await run({ action: "questions" });
});
program.command("review").description("Review and approve translations").option(
  "--score-threshold <score>",
  "Min score for auto-approval in non-interactive mode",
  "80"
).addHelpText(
  "after",
  "\nExamples:\n  babli review                       # interactive review\n  babli review --no-interaction      # auto-approve high-score translations\n  babli review --score-threshold 90  # custom threshold"
).action(async (options) => {
  const scoreThreshold = parseInt(options.scoreThreshold, 10);
  if (Number.isNaN(scoreThreshold) || scoreThreshold < 0 || scoreThreshold > 100) {
    throw new Error(`Invalid --score-threshold value: "${options.scoreThreshold}"`);
  }
  await run({
    action: "review",
    options: { scoreThreshold }
  });
});
program.command("proofread").description("Run AI proofreading on unapproved translations").option(
  "--languages <codes>",
  "Only proofread these languages (comma-separated)"
).addHelpText(
  "after",
  "\nExamples:\n  babli proofread                    # proofread all unapproved\n  babli proofread --languages cs,de  # only Czech and German"
).action(async (options) => {
  await run({
    action: "proofread",
    options: {
      languages: options.languages?.split(",").map((l) => l.trim())
    }
  });
});
program.command("init").description("Initialize a new Babli project").option("--host <host>", "Babli server host URL", defaultHost).action(async (options) => {
  await run({
    action: "init",
    options: { host: options.host }
  });
});
program.description(
  "Babli.ai translation management CLI.\n\nRun without arguments in a terminal for the interactive workflow."
).action(async () => {
  if (process.stdin.isTTY && process.stdout.isTTY && !getGlobalFlags().noInteraction) {
    await run({ action: "workflow" });
  } else {
    program.outputHelp();
    process.exit(1);
  }
});
program.version(buildInfo.versionLabel, "-V, --version");
applyExitOverride(program);
runProgram();
function applyExitOverride(command) {
  command.exitOverride();
  for (const child of command.commands) {
    applyExitOverride(child);
  }
}
async function runProgram() {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    handleProgramError(err);
  }
}
function getGlobalFlags() {
  const opts = activeCommand.optsWithGlobals();
  const json = opts.json === true;
  return {
    json,
    noInteraction: opts.interaction === false || json,
    full: opts.full === true,
    resolve: opts.resolve
  };
}
function withGlobalOptions(command) {
  return command.option("--json", "Output results as JSON (stable schema for agents/CI)").option("--no-interaction", "Skip all prompts, use safe defaults").option("--full", "Show all items without truncation");
}
function collectOption(value, previous) {
  return [...previous, value];
}
function handleProgramError(err) {
  const code = err.code;
  if (code === "commander.helpDisplayed" || code === "commander.help" || code === "commander.version") {
    process.exit(0);
  }
  const error = err instanceof Error ? err : new Error(String(err));
  const isCommanderError = typeof code === "string" && code.startsWith("commander.");
  if (getGlobalFlags().json) {
    const serialized = serializeCliError(error);
    console.info(
      JSON.stringify(
        {
          error: {
            ...serialized,
            message: serialized.message.replace(/^error: /, "")
          },
          status: "error",
          version: 1
        },
        null,
        2
      )
    );
  } else if (!isCommanderError) {
    console.error(error.message);
  }
  process.exit(2);
}
async function run(cliInput) {
  try {
    const result = await runAction(cliInput, getGlobalFlags());
    if (cliInput.action === "status" && (result.needPush || result.needPull)) {
      process.exit(1);
    }
    if (result.exitCode !== void 0 && result.exitCode !== 0) {
      process.exit(result.exitCode);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("User force closed the prompt")) {
      console.info("Exiting...");
      process.exit(0);
    }
    if (getGlobalFlags().json) {
      const error = serializeCliError(err);
      console.info(
        JSON.stringify(
          {
            error,
            status: "error",
            version: 1
          },
          null,
          2
        )
      );
      process.exit(2);
    }
    console.error(`${Bold}Oops, something went wrong:${Reset}`);
    if (env.NODE_ENV === "development") {
      console.error(err);
    }
    if (err instanceof Error) {
      console.error(FgRed + err.message + Reset);
    } else {
      console.error(FgRed + String(err) + Reset);
    }
    process.exit(2);
  }
}
function readBuildInfo() {
  const buildInfoUrls = [
    new URL("./build-info.json", import.meta.url),
    new URL("../dist/build-info.json", import.meta.url)
  ];
  for (const url of buildInfoUrls) {
    try {
      return JSON.parse(fsSync.readFileSync(url, "utf8"));
    } catch {
    }
  }
  return {
    isDevBuild: false,
    versionLabel: packageJson.version
  };
}
async function performSync(ctx, cliInput, translationFilesConfig, transforms) {
  const projectInfo = await fetchProjectInfo(
    ctx.host,
    ctx.projectId,
    ctx.accessToken
  );
  const allServerKeys = await fetchServerKeys(
    ctx.host,
    ctx.projectId,
    ctx.accessToken
  );
  const standardConfigs = translationFilesConfig.filter((c) => !c.transform);
  const transformConfigs = translationFilesConfig.filter((c) => c.transform);
  const allFilesByPattern = await gatherLocalFiles(
    translationFilesConfig,
    CliFileApi
  );
  const { getFilePatternOrPath } = analyzeFilePatterns({
    translationFilesConfig: standardConfigs,
    defaultFilePattern: ctx.defaultFilePattern
  });
  const noInteractionPrompt = {
    confirm: async () => true,
    select: async ({ choices }) => choices[0]?.value ?? ""
  };
  const { resolve } = ctx.flags;
  if (resolve !== void 0 && resolve !== "local" && resolve !== "server") {
    throw new Error(`--resolve must be "local" or "server", got "${resolve}"`);
  }
  const resolvedCliInput = cliInput.action === "push" ? { ...cliInput, conflictResolution: resolve } : cliInput;
  return runCli({
    cliInput: resolvedCliInput,
    allFilesByPattern,
    projectInfo,
    allServerKeys,
    getFilePatternOrPath,
    writeFile,
    pushToServer: makePushToServer(ctx.host, ctx.accessToken),
    appHost: ctx.host,
    translationFilesConfig,
    prompt: ctx.flags.noInteraction ? noInteractionPrompt : { confirm, select },
    exit: () => process.exit(0),
    emptyValueString: ctx.emptyValueString,
    transformConfigs,
    transforms,
    fileAPI: CliFileApi,
    cwd: process.cwd()
  });
}
async function runAction(cliInput, flags) {
  if (cliInput.action === "init") {
    const host2 = cliInput.options?.host ?? defaultHost;
    let accessToken2;
    try {
      accessToken2 = await loadKeyOrTokenFile();
    } catch {
      console.info("No authentication found. Logging in automatically...");
      accessToken2 = await performLogin(host2);
    }
    await initProject(host2, accessToken2);
    process.exit(0);
  }
  const parsed = await loadConfigFile(CliFileApi);
  if (cliInput.action === "login") {
    await performLogin(parsed?.host ?? defaultHost);
    process.exit(0);
  }
  if (cliInput.action === "logout") {
    await fs__default.rm(keyFilePath);
    console.info("Logged out successfully.");
    process.exit(0);
  }
  const accessToken = await loadKeyOrTokenFile().catch(() => {
    console.info(
      "You are not logged in. Please run `babli login` for local development. Use `BABLI_API_KEY` in CI."
    );
    process.exit(2);
  });
  const host = parsed?.host ?? defaultHost;
  await pingServer(host, buildInfo.versionLabel);
  const orgCtx = { host, accessToken, flags };
  if (cliInput.action === "project-list") {
    await projectListCommand(orgCtx, cliInput.options);
    return { needPush: false, needPull: false };
  }
  if (cliInput.action === "project-create") {
    await projectCreateCommand(orgCtx, cliInput.options);
    return { needPush: false, needPull: false };
  }
  if (cliInput.action === "project-get" && cliInput.options?.project) {
    await projectGetByIdCommand(orgCtx, cliInput.options.project);
    return { needPush: false, needPull: false };
  }
  if (!parsed) {
    console.error(
      "No babli.json config file found. Run `babli init` to create a new project or ensure you're in the correct directory."
    );
    process.exit(2);
  }
  const { projectId, translationFiles: translationFilesConfig } = parsed;
  const surgicalCtx = {
    host,
    projectId,
    accessToken,
    flags
  };
  if (cliInput.action === "job") {
    const exitCode = await jobCommand(surgicalCtx, cliInput.options);
    return { needPush: false, needPull: false, exitCode };
  }
  if (cliInput.action === "key-list") {
    await keyListCommand(surgicalCtx, cliInput.options);
    return { needPush: false, needPull: false };
  }
  if (cliInput.action === "key-get") {
    await keyGetCommand(surgicalCtx, cliInput.options);
    return { needPush: false, needPull: false };
  }
  if (cliInput.action === "key-add") {
    await keyAddCommand(surgicalCtx, cliInput.options);
    return { needPush: false, needPull: false };
  }
  if (cliInput.action === "key-update") {
    await keyUpdateCommand(surgicalCtx, cliInput.options);
    return { needPush: false, needPull: false };
  }
  if (cliInput.action === "key-rename") {
    await keyRenameCommand(surgicalCtx, cliInput.options);
    return { needPush: false, needPull: false };
  }
  if (cliInput.action === "key-archive") {
    await keyArchiveCommand(surgicalCtx, cliInput.options);
    return { needPush: false, needPull: false };
  }
  if (cliInput.action === "key-unarchive") {
    await keyUnarchiveCommand(surgicalCtx, cliInput.options);
    return { needPush: false, needPull: false };
  }
  if (cliInput.action === "translation-upsert") {
    await translationUpsertCommand(surgicalCtx, cliInput.options);
    return { needPush: false, needPull: false };
  }
  if (cliInput.action === "translation-approve") {
    await translationApproveCommand(surgicalCtx, cliInput.translationId);
    return { needPush: false, needPull: false };
  }
  if (cliInput.action === "translation-unapprove") {
    await translationUnapproveCommand(surgicalCtx, cliInput.translationId);
    return { needPush: false, needPull: false };
  }
  if (cliInput.action === "project-get") {
    await projectGetCommand(surgicalCtx);
    return { needPush: false, needPull: false };
  }
  if (cliInput.action === "project-update") {
    await projectUpdateCommand(surgicalCtx, cliInput.options);
    return { needPush: false, needPull: false };
  }
  const transformConfigs = translationFilesConfig.filter((c) => c.transform);
  const transforms = /* @__PURE__ */ new Map();
  for (const config of transformConfigs) {
    const transform = await loadTransform(
      exists(config.transform, "Transform path must be defined"),
      process.cwd()
    );
    transforms.set(config.path, transform);
  }
  const syncCtx = {
    host,
    projectId,
    accessToken,
    flags,
    emptyValueString: parsed.emptyValueString,
    defaultFilePattern: parsed.defaultFilePattern
  };
  const doSync = (action) => performSync(syncCtx, action, translationFilesConfig, transforms);
  if (cliInput.action === "workflow" || cliInput.action === "sync-and-translate") {
    const projectInfo = await fetchProjectInfo(host, projectId, accessToken);
    const projectName = projectInfo.name;
    const targetLanguages = getTargetLanguageCodes(projectInfo.languages);
    let questionsFetchFailed = false;
    const [result2, questions] = await Promise.all([
      doSync({ action: "status" }),
      fetchQuestions(host, projectId, accessToken).catch(() => {
        questionsFetchFailed = true;
        return [];
      })
    ]);
    const s2tInput = {
      host,
      projectId,
      accessToken,
      flags,
      syncResult: result2,
      targetLanguages,
      emptyValueString: parsed.emptyValueString,
      onlyExisting: cliInput.action === "sync-and-translate" ? cliInput.options.onlyExisting : false,
      doPush: (keysToRemove) => doSync({ action: "push", keysToRemove, quiet: true }),
      reFetchAndSync: () => doSync({ action: "status" }),
      doPull: async (options) => {
        await doSync({
          action: "pull",
          options: { onlyApproved: false, ...options }
        });
      }
    };
    if (cliInput.action === "sync-and-translate") {
      const exitCode = await syncAndTranslate(s2tInput);
      return { needPush: false, needPull: false, exitCode };
    }
    const dashboard = computeDashboard(result2.status, questions.length, projectName, {
      questionsFetchFailed
    });
    if (flags.json) {
      console.info(renderDashboardJson(dashboard, result2.status, questions.length));
      return { needPush: result2.status.needPush, needPull: result2.status.needPull };
    }
    console.info(renderDashboardHuman(dashboard));
    if (dashboard.isInSync) {
      return { needPush: false, needPull: false };
    }
    const choice = await select({
      message: "What would you like to do?",
      choices: dashboard.menuItems.map((item) => ({
        value: item.value,
        name: item.label
      }))
    });
    if (choice === "exit") {
      return { needPush: false, needPull: false };
    }
    if (choice === "sync-and-translate") {
      await syncAndTranslate(s2tInput);
    } else if (choice === "push") {
      await doSync({ action: "push" });
    } else if (choice === "pull") {
      await pullFromDashboard({
        flags,
        syncResult: result2,
        doPull: s2tInput.doPull
      });
    } else if (choice === "questions") {
      await questionsCommand({ host, projectId, accessToken, flags });
    } else if (choice === "details") {
      console.info(renderStatusHuman(result2.comparison, result2.status, { full: false }));
    }
    return { needPush: false, needPull: false };
  }
  if (cliInput.action === "questions") {
    await questionsCommand({ host, projectId, accessToken, flags });
    return { needPush: false, needPull: false };
  }
  if (cliInput.action === "review") {
    await reviewCommand({
      host,
      projectId,
      accessToken,
      flags,
      scoreThreshold: cliInput.options.scoreThreshold
    });
    return { needPush: false, needPull: false };
  }
  if (cliInput.action === "proofread") {
    await proofreadCommand({
      host,
      projectId,
      accessToken,
      flags,
      languages: cliInput.options.languages
    });
    return { needPush: false, needPull: false };
  }
  const syncCliInput = cliInput.action === "translate" ? { action: "status" } : cliInput;
  const shouldMuteOutput = flags.json && (cliInput.action === "push" || cliInput.action === "pull");
  const originalInfo = console.info;
  if (shouldMuteOutput) {
    console.info = () => {
    };
  }
  let result;
  try {
    result = await doSync(syncCliInput);
  } finally {
    if (shouldMuteOutput) {
      console.info = originalInfo;
    }
  }
  if (cliInput.action === "status") {
    if (flags.json) {
      console.info(renderStatusJson(result.status));
    } else {
      console.info(renderStatusHuman(result.comparison, result.status, { full: flags.full }));
    }
  }
  if (cliInput.action === "push" && flags.json) {
    const pushPlan = computePushPlan(result.comparison);
    console.info(renderPushJson(pushPlan, result.pushFilter));
  }
  if (cliInput.action === "pull" && flags.json) {
    console.info(renderPullJson(result.status));
  }
  if (cliInput.action === "translate") {
    const projectInfo = await fetchProjectInfo(host, projectId, accessToken);
    const targetLanguages = getTargetLanguageCodes(projectInfo.languages);
    const exitCode = await translateCommand({
      host,
      projectId,
      accessToken,
      syncResult: result,
      flags,
      targetLanguages,
      languages: cliInput.options.languages,
      strategy: cliInput.options.strategy,
      onlyExisting: cliInput.options.onlyExisting,
      emptyValueString: parsed.emptyValueString,
      keys: cliInput.options.keys,
      namespaces: cliInput.options.namespaces,
      keyIds: cliInput.options.keyIds,
      model: cliInput.options.model,
      dryRun: cliInput.options.dryRun,
      estimate: cliInput.options.estimate,
      timeout: cliInput.options.timeout,
      wait: cliInput.options.wait
    });
    return {
      needPush: result.status.needPush,
      needPull: result.status.needPull,
      exitCode
    };
  }
  return {
    needPush: result.status.needPush,
    needPull: result.status.needPull
  };
}

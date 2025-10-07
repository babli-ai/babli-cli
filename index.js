#!/usr/bin/env node

// THIS FILE IS GENERATED:
// This project/repo is generated from Babli.ai internal monorepo. It is intended for read-only use. You can file issues here. PRs are welcome, but will need to be manually migrated to the monorepo.

import { select, input, confirm } from '@inquirer/prompts';
import { Command } from 'commander';
import fsSync from 'fs';
import * as fs from 'fs/promises';
import fs__default from 'fs/promises';
import { env } from 'process';
import open from 'open';
import path from 'path';
import { glob } from 'glob';
import { z } from 'zod';
import * as minimatch from 'minimatch';
import ignore from 'ignore';
import { parse, stringify } from 'yaml';
import { fromError } from 'zod-validation-error';
import yaml from 'js-yaml';
import PO from 'pofile';
import Parser from 'web-tree-sitter';

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

async function fetchKeyInLoop(host, requestCode) {
  const res = await fetch(
    `${host}/api/cli/getAuthToken?requestCode=${requestCode}`
  ).then((res2) => {
    if (res2.ok) {
      return res2.json();
    } else {
      console.error(res2.statusText);
      throw new Error("Failed to get auth token");
    }
  });
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
    return glob(pattern, { cwd: options?.cwd });
  }
};

const zFileFormat = z.enum([
  "json",
  "yaml",
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
For example 'NOT_TRANSLATED', You can define it here.`
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

async function writeFile(file, content) {
  await fs__default.writeFile(file, content, "utf-8");
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

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, key + "" , value);
async function gatherLocalFiles(translationFilesConfig, fileAPI, cwd) {
  const allFilesByPattern = {};
  const languagesInConfig = new AllLanguagesGatherer(translationFilesConfig);
  for (const fileConfig of translationFilesConfig) {
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
      const fullPath = filePath;
      const text = await fileAPI.readFile(fullPath);
      const fileFormat = fileConfig.format;
      if (!fileFormat) {
        throw new Error(`File format not found`);
      }
      const res = {
        lang: foundLang,
        path: filePath,
        content: text,
        pathTemplate: pathPattern,
        fileFormat,
        namespace,
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
    __publicField(this, "allLanguagesInConfig", /* @__PURE__ */ new Set());
    for (const fileConfig of this.translationFilesConfig) {
      if (fileConfig.languages) {
        for (const lang of fileConfig.languages) {
          this.allLanguagesInConfig.add(lang);
        }
      }
    }
  }
  has(lang) {
    return this.allLanguagesInConfig.has(lang);
  }
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

var contriesPerLanguage = {
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

function detectFormatFromExtension(fileName) {
  const extension = fileName.split(".").pop();
  if (extension === "json") {
    return "json";
  }
  if (extension === "yml" || extension === "yaml") {
    return "yaml";
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

const supportedExtensions = /* @__PURE__ */ new Set(["json", "arb", "po", "yml", "yaml"]);
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
function extractPattern(filePath, languageCode) {
  const pathParts = filePath.split("/");
  const fileName = pathParts[pathParts.length - 1];
  if (fileName.includes(languageCode)) {
    const newFileName = fileName.replace(languageCode, "{{lang}}");
    pathParts[pathParts.length - 1] = newFileName;
    return pathParts.join("/");
  }
  const languageIndex = pathParts.findIndex((part) => part === languageCode);
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
    case "flutterArb":
      return extension === "arb";
    case "po":
      return extension === "po";
    default:
      return false;
  }
}

async function initProject(host, accessToken) {
  console.info("Initializing new Babli project...\n");
  const orgs = await fetchOrganizations(host, accessToken);
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
\u2705 Found ${detectedFiles.length} translation file(s):`);
    for (const file of detectedFiles) {
      console.info(`  - ${file.path} (${file.detectedLanguageCode})`);
    }
    const useDetected = await confirm({
      message: "Use detected translation files?",
      default: true
    });
    if (useDetected) {
      translationFilesConfig = generateTranslationConfig(detectedFiles);
      console.info("\n\u{1F4C1} Generated configuration from detected files");
    } else {
      translationFilesConfig = [{ path: "locales/{{lang}}.json" }];
      console.info("\n\u{1F4C1} Using default configuration");
    }
  } else {
    console.info("  No translation files found");
    translationFilesConfig = [{ path: "locales/{{lang}}.json" }];
    console.info("\n\u{1F4C1} Using default configuration");
  }
  console.info("Creating project...");
  const project = await createProject(host, accessToken, {
    name: projectName,
    orgId: selectedOrgId
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
async function fetchOrganizations(host, accessToken) {
  const res = await fetch(`${host}/api/cli/organizations`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch organizations. Status: ${res.statusText}`);
  }
  return res.json();
}
async function createProject(host, accessToken, input2) {
  const res = await fetch(`${host}/api/cli/projects`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(input2)
  });
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to create project: ${error}`);
  }
  return res.json();
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
        const mods = {};
        if ("languages" in file) {
          mods.languages = file.languages;
        } else if ("language" in file && file.language) {
          mods.languages = [file.language];
        }
        if (!mods.format) {
          mods.format = detectFormatFromExtension(file.path);
        }
        return { ...file, ...mods };
      }
    )
  };
}

function makePushToServer(host, accessToken) {
  return async function pushToServer({
    projectId,
    newLanguages,
    input
  }) {
    const res = await fetch(
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
    if (res.ok) {
      return;
    } else {
      throw new Error("Failed to add keys and translations");
    }
  };
}

function compareLocalAndServer(languagesOnServer, languagesOnLocal, mergedKeysByKeyByNamespace) {
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
        missingKeysOnLocal[key.key] = key;
      }
      if (!key.server) {
        missingKeysOnServer[key.key] = key;
        missingOrDifferentKeysOnServer[key.key] = key;
      }
      for (const [lang, translation] of Object.entries(key.translations)) {
        if (translation?.local?.value == void 0 && translation?.server?.currentValue != void 0) {
          missingTranslationsOnLocalPerLanguage[lang] ?? (missingTranslationsOnLocalPerLanguage[lang] = []);
          missingTranslationsOnLocalPerLanguage[lang].push(key);
        }
        if (translation?.server?.currentValue == void 0 && translation?.local?.value != void 0) {
          missingTranslationsOnServerPerLanguage[lang] ?? (missingTranslationsOnServerPerLanguage[lang] = []);
          missingTranslationsOnServerPerLanguage[lang].push(key);
          missingOrDifferentKeysOnServer[key.key] = key;
        }
        if (translation?.local?.value && translation?.server?.currentValue && translation.local.value !== translation.server.currentValue) {
          differentTranslationsLanguage[lang] ?? (differentTranslationsLanguage[lang] = []);
          differentTranslationsLanguage[lang].push(key);
          missingOrDifferentKeysOnServer[key.key] = key;
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

function assertNever(x) {
  throw new Error(`Unexpected value: ${x}`);
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
    const JavaScript2 = await Parser.Language.load(
      "/parsers/tree-sitter-tsx.wasm"
    );
    parser2.setLanguage(JavaScript2);
    initialized = { parser: parser2, JavaScript: JavaScript2 };
  }
  const { parser, JavaScript } = initialized;
  const tree = parser.parse(fileContent);
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
  let query = JavaScript.query(queryStr);
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
  query = JavaScript.query(queryStr);
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
    if (child.type === "pair") {
      const keyNode = child.namedChildren.find(
        (n) => n.type === "property_identifier" || n.type === "string"
      );
      const valueNode = child.namedChildren.find(
        (n) => n.type !== "property_identifier" && (n.type === "string" || n.type === "object")
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
    case "po": {
      const processor = fileProcessors.po;
      return processor(content, projectSeparator, fileOptions, langCode);
    }
    default:
      return assertNever(format);
  }
}

function processLocalValue(value, emptyValueString) {
  if (emptyValueString && value === emptyValueString) {
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
    case "flutterArb":
      return generateFlutterArb(keys, localeCode);
    case "typescript":
      throw new Error("Not implemented");
    case "po":
      return generatePO(keys, localeCode);
  }
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

async function prepareFilesToPull(mergedKeysInLocalOrder, mergedKeysByKeyByNamespace, translationFilesConfig, allLanguages, onlyApproved, emptyValueString) {
  const keysToPullByFile = {};
  translationFilesConfig.forEach((fileConfig) => {
    const languages = fileConfig.languages ?? allLanguages.map((l) => l.code);
    languages.forEach((lang) => {
      const pathWithLang = fileConfig.path.replace("{{lang}}", lang);
      const fileFormat = fileConfig.format;
      function insertKeys(path, keys) {
        const keysInLocalOrder = mergedKeysInLocalOrder[path]?.keys;
        if (keysInLocalOrder) {
          console.info("Using local sorting for: ", path);
        } else {
          console.info("Using default sorting for: ", path);
        }
        for (const key of keysInLocalOrder ? uniq([...keysInLocalOrder, ...Object.values(keys)]) : Object.values(keys)) {
          const translation = key.translations[lang];
          const value = onlyApproved ? translation?.server?.approved ? translation?.server?.currentValue : null : translation?.server?.currentValue;
          if (value != void 0 || fileConfig.pullWithEmptyValues) {
            if (!fileFormat) {
              throw new Error("Could not determine file format");
            }
            keysToPullByFile[path] ?? (keysToPullByFile[path] = {
              keys: [],
              lang,
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
      for (const [namespace, mergedKeysByKey] of Object.entries(
        mergedKeysByKeyByNamespace
      )) {
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
              Object.values(sourceKeys)
            );
          }
        } else {
          insertKeys(pathWithNamespace, Object.values(mergedKeysByKey));
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

function printLimitedItems(items, toPrint = 20) {
  if (items.length == 0) {
    return;
  }
  const itemsToPrint = items.slice(0, toPrint);
  console.info(
    `${Reset}${itemsToPrint.join(", ")}${items.length > toPrint ? "..." : ""}`
  );
}

function printStatus({
  missingLanguagesOnServer,
  missingKeysOnServer,
  missingTranslationsOnServerPerLanguage,
  differentTranslationsLanguage,
  missingKeysOnLocal,
  missingTranslationsOnLocalPerLanguage
}) {
  console.info("\nDetailed status: \n");
  boldInfo(`To push:`);
  greenInfo(
    `${Array.from(missingLanguagesOnServer).length} missing languages on server:`
  );
  printLimitedItems(Array.from(missingLanguagesOnServer));
  greenInfo(
    `${Object.keys(missingKeysOnServer).length} missing keys on server:`
  );
  printLimitedItems(Object.keys(missingKeysOnServer));
  Object.entries(missingTranslationsOnServerPerLanguage).forEach(
    ([lang, keys]) => {
      greenInfo(`missing translations on server for ${lang}:`);
      printLimitedItems(Object.values(keys).map((keys2) => keys2.key));
    }
  );
  greenInfo(
    `${Object.keys(differentTranslationsLanguage).length} different translations on server:`
  );
  printLimitedItems(Object.keys(differentTranslationsLanguage));
  console.info("\n");
  boldInfo(`To pull:`);
  greenInfo(`${Object.keys(missingKeysOnLocal).length} missing keys locally:`);
  printLimitedItems(Object.keys(missingKeysOnLocal));
  Object.entries(missingTranslationsOnLocalPerLanguage).forEach(
    ([lang, keys]) => {
      greenInfo(`missing translations locally for ${lang}:`);
      printLimitedItems(Object.values(keys).map((keys2) => keys2.key));
    }
  );
  greenInfo(
    `${Object.keys(differentTranslationsLanguage).length} different translations locally:`
  );
  printLimitedItems(Object.keys(differentTranslationsLanguage));
}
function boldInfo(text) {
  console.info(Bold + text + Reset);
}
function greenInfo(text) {
  console.info(FgGreen + text + Reset);
}

function nonNullable(value) {
  return value !== null && value !== void 0;
}

async function push(comparison, pushToServer, projectInfo, appHost, prompt, exit) {
  const {
    missingLanguagesOnServer,
    missingKeysOnServer,
    missingTranslationsOnServerPerLanguage,
    differentTranslationsLanguage,
    missingOrDifferentKeysOnServer
  } = comparison;
  const langs = [...missingLanguagesOnServer];
  greenInfo(`${langs.length} languages will be pushed:`);
  printLimitedItems(langs);
  if (langs.length > 0) {
    const answer = await prompt.confirm({ message: "Continue?" });
    if (!answer) {
      console.info("Aborting");
      exit();
    }
  }
  const keys = Object.keys(missingKeysOnServer);
  greenInfo(`${keys.length} keys will be pushed:`);
  printLimitedItems(keys);
  if (keys.length > 0) {
    const answer2 = await prompt.confirm({ message: "Continue?" });
    if (!answer2) {
      console.info("Aborting");
      exit();
    }
  }
  Object.entries(missingTranslationsOnServerPerLanguage).forEach(
    ([lang, keys2]) => {
      greenInfo(`${keys2.length} translations will be pushed for ${lang}:`);
      printLimitedItems(Object.values(keys2).map((keys3) => keys3.key));
    }
  );
  if (Object.keys(missingTranslationsOnServerPerLanguage).length > 0) {
    const answer3 = await prompt.confirm({ message: "Continue?" });
    if (!answer3) {
      console.info("Aborting");
      exit();
    }
  }
  const keysWithDifferentTranslations = Object.keys(
    differentTranslationsLanguage
  );
  greenInfo(
    `${keysWithDifferentTranslations.length} keys with different translations on server:`
  );
  for (const [lang, keys2] of Object.entries(differentTranslationsLanguage)) {
    for (const key of keys2) {
      const local = key.translations[lang]?.local;
      const server = key.translations[lang]?.server;
      if (!local || !server) {
        console.error("Unexpected error: local or server is null");
        process.exit(1);
      }
      boldInfo(`

Different translations were found on server and local:`);
      console.info(`Key: ${key.key}`);
      console.info(`Language: ${lang}`);
      console.info(`${FgBlue}Local:${Reset} ${local.value}`);
      console.info(`${FgBlue}Server:${Reset} ${server.currentValue}`);
      const answer = await prompt.select({
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
          }
        ]
      });
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
  console.info("PUSHING");
  await pushToServer({
    projectId: projectInfo.id,
    newLanguages: Array.from(missingLanguagesOnServer).map((lang) => ({
      code: lang,
      instructions: null,
      name: null
    })),
    input: {
      markAllAsPreferred: false,
      keysToRemove: [],
      keys: Object.values(missingOrDifferentKeysOnServer).map((key) => {
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
            return {
              language: lang,
              value
            };
          }).filter(nonNullable)
        };
      })
    }
  });
  console.info("PUSHING DONE");
  console.info(
    "Check all keys:",
    `${FgBlue} ${appHost}/app/project/${projectInfo.id}${Reset}`
  );
  console.info(
    "Translate: ",
    `${FgBlue}${appHost}/app/project/${projectInfo.id}/translate${Reset}`
  );
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
  emptyValueString
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
  async function pull(pullOptions) {
    console.info("PULLING");
    const filesToPull = await prepareFilesToPull(
      mergedKeysInLocalOrder,
      mergedKeysByKeyByNamespace,
      translationFilesConfig,
      projectInfo.languages,
      pullOptions?.onlyApproved ?? false,
      emptyValueString
    );
    for (const [file, content] of Object.entries(filesToPull)) {
      await writeFile(file, content);
    }
    console.info("PULLING DONE");
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
    mergedKeysByKeyByNamespace
  );
  if (cliInput.action === "status") {
    printStatus(comparison);
  }
  if (cliInput.action === "translate") {
    console.info("TRANSLATING");
    await push(comparison, pushToServer, projectInfo, appHost, prompt, exit);
    await pull();
  }
  if (cliInput.action === "push") {
    await push(comparison, pushToServer, projectInfo, appHost, prompt, exit);
  }
  if (cliInput.action === "pull") {
    await pull(cliInput.options);
  }
}

const packageJson$1 = JSON.parse(
  fsSync.readFileSync(new URL("./package.json", import.meta.url), "utf8")
);
async function fetchServerKeys(host, projectId, accessToken) {
  const res = await fetch(`${host}/api/cli/${projectId}/allKeys`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  }).then((res2) => {
    if (res2.ok) {
      return res2.json();
    } else {
      throw new Error(
        `Failed to fetch project info. Status: ${res2.statusText}`
      );
    }
  });
  return res;
}
async function fetchProjectInfo(host, projectId, accessToken) {
  return await fetch(`${host}/api/cli/${projectId}/projectInfo`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  }).then((res) => {
    if (res.ok) {
      return res.json();
    } else {
      throw new Error(
        `Failed to fetch project info. Status: ${res.statusText}`
      );
    }
  });
}
async function pingServer(host) {
  const res = await fetch(`${host}/api/cli/ping`);
  if (!res.ok) {
    console.error(`Could not connect to server at ${host}`);
    process.exit(1);
  }
  const json = await res.json();
  if (json.cliVersion !== packageJson$1.version) {
    console.warn(
      `Your CLI version is different from the server version, please update. Your version is ${packageJson$1.version}, but the server is ${json.cliVersion}.`
    );
  }
}

const packageJson = JSON.parse(
  fsSync.readFileSync(new URL("./package.json", import.meta.url), "utf8")
);
const program = new Command();
program.command("login").description("Login to Babli.ai").action(async () => {
  await run({ action: "login" });
});
program.command("logout").description("Logout from Babli.ai").action(async () => {
  await run({ action: "logout" });
});
program.command("push").description(
  "Push translations to Babli.ai. Pushes to server new languages, new keys, new translations. In case of different translations, it will ask you to choose which one to keep."
).action(async (options) => {
  await run({
    action: "push",
    options: {
      dryRun: options.dryRun,
      archiveMissingKeys: options.archiveMissingKeys
    }
  });
});
program.command("pull").description("Pull translations from Babli.ai").option(
  "--only-approved",
  "Only pull languages that are approved in the project settings"
).action(async (options) => {
  await run({
    action: "pull",
    options: {
      onlyApproved: options.onlyApproved
    }
  });
});
program.command("status").description("Check status of translations").action(async () => {
  await run({
    action: "status"
  });
});
program.command("init").description("Initialize a new Babli project").option("--host <host>", "Babli server host URL", defaultHost).action(async (options) => {
  await run({
    action: "init",
    options: {
      host: options.host
    }
  });
});
program.version(packageJson.version, "-V, -v, --version");
program.parse(process.argv);
async function run(cliInput) {
  try {
    await runAction(cliInput);
  } catch (err) {
    if (err instanceof Error && err.message.includes("User force closed the prompt")) {
      console.info("Exiting...");
      process.exit(0);
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
    process.exit(1);
  }
}
async function runAction(cliInput) {
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
    process.exit(1);
  });
  if (!parsed) {
    console.error(
      "No babli.json config file found. Run `babli init` to create a new project or ensure you're in the correct directory."
    );
    process.exit(1);
  }
  const { projectId, translationFiles: translationFilesConfig, host } = parsed;
  const projectInfo = await fetchProjectInfo(host, projectId, accessToken);
  const allServerKeys = await fetchServerKeys(host, projectId, accessToken);
  await pingServer(host);
  const allFilesByPattern = await gatherLocalFiles(
    translationFilesConfig,
    CliFileApi
  );
  const { getFilePatternOrPath } = analyzeFilePatterns({
    translationFilesConfig,
    defaultFilePattern: parsed.defaultFilePattern
  });
  await runCli({
    cliInput,
    allFilesByPattern,
    projectInfo,
    allServerKeys,
    getFilePatternOrPath,
    writeFile,
    pushToServer: makePushToServer(host, accessToken),
    appHost: host,
    translationFilesConfig,
    prompt: {
      confirm,
      select
    },
    exit: () => process.exit(0),
    emptyValueString: parsed.emptyValueString
  });
}

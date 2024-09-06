#!/usr/bin/env node

// THIS FILE IS GENERATED:
// This project/repo is generated from Babli.ai internal monorepo. It is intended for read-only use. You can file issues here. PRs are welcome, but will need to be manually migrated to the monorepo.

import fs from 'fs/promises';
import Parser from 'web-tree-sitter';
import yaml from 'js-yaml';
import { stringify, parse } from 'yaml';
import { confirm, select } from '@inquirer/prompts';
import { Command } from 'commander';
import { glob } from 'glob';
import path from 'path';
import * as minimatch from 'minimatch';
import open from 'open';
import { z } from 'zod';
import { fromError } from 'zod-validation-error';
import { env } from 'process';

const Reset = "\x1B[0m";
const Bold = "\x1B[1m";
const FgRed = "\x1B[31m";
const FgGreen = "\x1B[32m";
const FgYellow = "\x1B[33m";
const FgBlue = "\x1B[34m";

function gatherTranslationsFromMaybeNestedObject(source, projectSeparator) {
  const translations = /* @__PURE__ */ new Map();
  if (typeof source !== "object")
    return translations;
  if (Array.isArray(source))
    return translations;
  if (source == null)
    return translations;
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
        return "/" + scriptName;
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
  flutterArb: async (fileContent) => {
    const translations = /* @__PURE__ */ new Map();
    const parsed = JSON.parse(fileContent);
    for (const [key, value] of Object.entries(parsed)) {
      if (key.startsWith("@"))
        continue;
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
  if (format === "json") {
    const processor = fileProcessors.json;
    return processor(content, projectSeparator, fileOptions, langCode);
  }
  if (format === "flutterArb") {
    const processor = fileProcessors.flutterArb;
    return processor(content, projectSeparator);
  }
  if (format === "typescript") {
    const processor = fileProcessors.typescript;
    return processor(content, projectSeparator);
  }
  if (format === "yaml") {
    const processor = fileProcessors.yaml;
    return processor(content, projectSeparator, fileOptions, langCode);
  }
  throw new Error(`Unsupported file format`);
}

async function gatherLocalKeys({
  allFilesByPattern,
  keySeparator
}) {
  var _a, _b;
  const localAllFiles = [];
  const mergedKeysByKeyByNamespace = {};
  const mergedKeysInLocalOrder = {};
  const languagesOnLocal = /* @__PURE__ */ new Set();
  for (const [pathTemplate, allFilesForTemplate] of Object.entries(
    allFilesByPattern
  )) {
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
              value: val.value
            }
          };
        } else {
          mergedKeysByKey[key] = {
            key,
            translations: {
              [file.lang]: {
                local: {
                  value: val.value
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

function generateTranslationFile(keys, format, localeCode, fileOptions) {
  switch (format) {
    case "json":
      let jsonObject = fileOptions.nested ? makeNestedObject(keys) : makeFlatObject(keys);
      if (fileOptions.topLevelLanguageCode) {
        jsonObject = {
          [localeCode]: jsonObject
        };
      }
      return JSON.stringify(jsonObject, null, 2);
    case "yaml":
      let yamlObject = fileOptions.nested ? makeNestedObject(keys) : makeFlatObject(keys);
      if (fileOptions?.topLevelLanguageCode) {
        yamlObject = {
          [localeCode]: yamlObject
        };
      }
      return stringify(yamlObject, {
        version: "1.1",
        nullStr: "",
        singleQuote: true
      });
    case "flutterArb":
      return generateFlutterArb(keys, localeCode);
    case "typescript":
      throw new Error("Not implemented");
  }
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

async function prepareFilesToPull(mergedKeysInLocalOrder, mergedKeysByKeyByNamespace, translationFilesConfig, allLanguages) {
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
          console.info(mergedKeysInLocalOrder[path]?.keys.length);
        } else {
          console.info("Using default sorting for: ", path);
        }
        for (const key of keysInLocalOrder ?? Object.values(keys)) {
          const translation = key.translations[lang];
          const value = translation?.server?.currentValue;
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
              value: value ?? null,
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
    const res = generateTranslationFile(
      keys.map(({ key, value, description, meta }) => {
        console.log("META", meta);
        return [
          key,
          {
            value,
            description,
            meta
          }
        ];
      }),
      fileFormat,
      lang,
      usedConfig
    );
    filesToPull[file] = res;
  }
  return filesToPull;
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
  for (const [namespace, mergedKeysByKey] of Object.entries(
    mergedKeysByKeyByNamespace
  )) {
    for (const [keyKey, key] of Object.entries(mergedKeysByKey)) {
      if (!key.local) {
        missingKeysOnLocal[key.key] = key;
      }
      if (!key.server) {
        missingKeysOnServer[key.key] = key;
        missingOrDifferentKeysOnServer[key.key] = key;
      }
      for (const [lang, translation] of Object.entries(key.translations)) {
        if (translation?.local?.value == void 0) {
          missingTranslationsOnLocalPerLanguage[lang] ?? (missingTranslationsOnLocalPerLanguage[lang] = []);
          missingTranslationsOnLocalPerLanguage[lang].push(key);
        }
        if (translation?.server?.currentValue == void 0) {
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

function printLimitedItems(items, toPrint = 20) {
  if (items.length == 0) {
    return;
  }
  const itemsToPrint = items.slice(0, toPrint);
  console.info(
    `${Reset}` + itemsToPrint.join(", ") + (items.length > toPrint ? "..." : "")
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

async function push(comparison, pushToServer, projectInfo, appHost) {
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
    const answer = await confirm({ message: "Continue?" });
    if (!answer) {
      console.info("Aborting");
      process.exit(0);
    }
  }
  const keys = Object.keys(missingKeysOnServer);
  greenInfo(`${keys.length} keys will be pushed:`);
  printLimitedItems(keys);
  if (keys.length > 0) {
    const answer2 = await confirm({ message: "Continue?" });
    if (!answer2) {
      console.info("Aborting");
      process.exit(0);
    }
  }
  Object.entries(missingTranslationsOnServerPerLanguage).forEach(
    ([lang, keys2]) => {
      greenInfo(`${keys2.length} translations will be pushed for ${lang}:`);
      printLimitedItems(Object.values(keys2).map((keys3) => keys3.key));
    }
  );
  if (Object.keys(missingTranslationsOnServerPerLanguage).length > 0) {
    const answer3 = await confirm({ message: "Continue?" });
    if (!answer3) {
      console.info("Aborting");
      process.exit(0);
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
      const answer = await select({
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
  const answer4 = await confirm({ message: "Ready to push?" });
  if (!answer4) {
    console.info("Aborting");
    process.exit(0);
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
      removeMissingKeys: false,
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
  action,
  allFilesByPattern,
  projectInfo,
  allServerKeys,
  getFilePatternOrPath,
  writeFile,
  pushToServer,
  appHost,
  fileOptions,
  translationFilesConfig
}) {
  const langById = projectInfo.languages.reduce(
    (acc, lang) => {
      acc[lang.id] = lang.code;
      return acc;
    },
    {}
  );
  function getLangCode(id) {
    const code = langById[id];
    if (!code) {
      throw new Error("Language not found");
    }
    return code;
  }
  const languagesOnServer = new Set(projectInfo.languages.map((l) => l.code));
  const {
    languagesOnLocal,
    mergedKeysByKeyByNamespace,
    mergedKeysInLocalOrder
  } = await gatherLocalKeys({
    allFilesByPattern,
    keySeparator: projectInfo.keySeparator
  });
  gatherServerKeys({
    allServerKeys,
    mergedKeysByKeyByNamespace,
    getLangCode,
    getFilePatternOrPath,
    mergedKeysInLocalOrder
  });
  const comparison = compareLocalAndServer(
    languagesOnServer,
    languagesOnLocal,
    mergedKeysByKeyByNamespace
  );
  if (!comparison.needPull && !comparison.needPush) {
    console.info(`${Bold}Everything is up to date. ${Reset}`);
  }
  if (action === "status") {
    printStatus(comparison);
  }
  if (action === "push") {
    await push(comparison, pushToServer, projectInfo, appHost);
  }
  if (action === "pull") {
    console.info("PULLING");
    const filesToPull = await prepareFilesToPull(
      mergedKeysInLocalOrder,
      mergedKeysByKeyByNamespace,
      translationFilesConfig,
      projectInfo.languages
    );
    for (const [file, content] of Object.entries(filesToPull)) {
      await writeFile(file, content);
    }
    console.info("PULLING DONE");
  }
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
var __publicField = (obj, key, value) => {
  __defNormalProp(obj, key + "" , value);
  return value;
};
async function gatherLocalFiles(translationFilesConfig, cwd) {
  const allFilesByPattern = {};
  const languagesInConfig = new AllLanguagesGatherer(translationFilesConfig);
  for (const fileConfig of translationFilesConfig) {
    const files = [];
    const pathPattern = fileConfig.path;
    const globPath = pathPattern.replace("{{lang}}", "*").replace("{{namespace}}", "**/*").replace("{{source}}", "**/*");
    const foundFilePaths = await glob(globPath, {
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
            "Failed to match file path: " + filePath + " with " + langRegex
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
          "Failed to match lang for file: " + filePath + " use either {{lang}} placeholder or define exactly one language"
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
            "Failed to match file path: " + filePath + " with " + namespaceRegex
          );
        }
        if (type === "namespace") {
          namespace = match[1];
        } else if (type === "source") {
          source = match[1];
        }
      }
      const fullPath = filePath;
      const text = await fs.readFile(fullPath, "utf-8");
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

var name = "babli";
var version = "0.0.10";
var type = "module";
var license = "MIT";
var repository = {
	type: "git",
	url: "https://github.com/babli-ai/babli-cli.git"
};
var bin = {
	babli: "./dist/index.js"
};
var scripts = {
	start: "node dist/index.js"
};
var dependencies = {
	"@inquirer/prompts": "^5.3.2",
	commander: "^12.1.0",
	glob: "^10.4.1",
	yaml: "^2.5.0",
	"js-yaml": "^4.1.0",
	lodash: "^4.17.21",
	open: "^10.1.0",
	"web-tree-sitter": "^0.22.6",
	zod: "^3.23.8",
	"zod-validation-error": "^3.3.1"
};
var packageJson = {
	name: name,
	version: version,
	type: type,
	license: license,
	repository: repository,
	bin: bin,
	scripts: scripts,
	dependencies: dependencies
};

const zFileFormat = z.enum(["json", "yaml", "flutterArb", "typescript"]);
const zYamlOptions = z.object({
  version: z.string().optional()
});
z.object({});
const zFileOptions = z.object({
  nested: z.boolean().default(true),
  topLevelLanguageCode: z.boolean().default(false),
  pullWithEmptyValues: z.boolean().default(false),
  yaml: zYamlOptions.default({})
});
const zTranslationFileConfig = z.object({
  path: z.string(),
  /**
   * when not provided, we will use all languages found by the pattern for push, and all languages not included in other patterns for pull
   */
  languages: z.array(z.string()).optional(),
  format: zFileFormat.optional()
}).merge(zFileOptions);
const zConfigFileInternal = z.object({
  projectId: z.string(),
  sortBy: z.union([z.literal("key"), z.literal("value"), z.literal("original")]).default("original"),
  /**
   * this is needed for the case when we have multiple files with pattern
   */
  defaultFilePattern: z.string().optional(),
  translationFiles: z.array(zTranslationFileConfig),
  // defaultFormat: zFileFormat.optional(),
  // defaultOptions: zFileOptions.optional(),
  defaultFile: z.string().optional(),
  /**
   * for development only
   */
  host: z.string().default("https://www.babli.ai")
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
}

async function loadConfigFile() {
  let obj;
  const jsonFileExists = await fs.access("babli.json").then(() => true).catch(() => false);
  const ymlFileExists = await fs.access("babli.yml").then(() => true).catch(() => false);
  const yamlFileExists = await fs.access("babli.yaml").then(() => true).catch(() => false);
  if (!jsonFileExists && !ymlFileExists && !yamlFileExists) {
    throw new Error("No config file found");
  }
  if (ymlFileExists || yamlFileExists) {
    const text = await fs.readFile(
      ymlFileExists ? "babli.yml" : "babli.yaml",
      "utf-8"
    );
    obj = parse(text);
  }
  if (jsonFileExists) {
    const text = await fs.readFile("babli.json", "utf-8");
    obj = JSON.parse(text);
  }
  if (!obj) {
    throw new Error("Failed to parse config file");
  }
  try {
    return parseAndExtendCliConfig(obj);
  } catch (err) {
    console.error("Failed to parse config file (babli.json or babli.yml)");
    console.error(fromError(err).message);
    process.exit(1);
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
const program = new Command();
program.command("login").description("Login to Babli.ai").action(async () => {
  await run("login");
});
program.command("logout").description("Logout from Babli.ai").action(async () => {
  await run("logout");
});
program.command("push").description(
  "Push translations to Babli.ai. Pushes to server new languages, new keys, new translations. In case of different translations, it will ask you to choose which one to keep."
).action(async () => {
  await run("push");
});
program.command("pull").description("Pull translations from Babli.ai").action(async () => {
  await run("pull");
});
program.command("status").description("Check status of translations").action(async () => {
  await run("status");
});
program.version(packageJson.version);
program.parse(process.argv);
async function loadKeyOrTokenFile() {
  const apiKey = process.env.BABLI_API_KEY;
  if (apiKey) {
    return apiKey;
  }
  const userToken = await fs.readFile(keyFilePath, "utf-8");
  if (!userToken) {
    throw new Error("Key file is empty");
  }
  return userToken;
}
async function run(action) {
  try {
    await runAction(action);
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
async function runAction(action) {
  const parsed = await loadConfigFile();
  const { projectId, translationFiles: translationFilesConfig, host } = parsed;
  if (action === "login") {
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
    await fs.writeFile(keyFilePath, key, "utf-8");
    console.info("Logged in successfully.");
    process.exit(0);
  }
  if (action === "logout") {
    await fs.rm(keyFilePath);
    console.info("Logged out successfully.");
    process.exit(0);
  }
  const accessToken = await loadKeyOrTokenFile().catch((err) => {
    console.info(
      "You are not logged in. Please run `babli login` for local development. Use `BABLI_API_KEY` in CI."
    );
    process.exit(1);
  });
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
      const defaultPath = parsed.defaultFilePattern ?? firstFilePatternWithoutLanguage();
      if (defaultPath) {
        return defaultPath;
      } else {
        warnMissingPatternForLanguage(lang);
        return void 0;
      }
    }
  }
  const projectInfo = await fetchProjectInfo(host, projectId, accessToken);
  const allServerKeys = await fetchServerKeys(host, projectId, accessToken);
  await pingServer(host);
  const allFilesByPattern = await gatherLocalFiles(translationFilesConfig);
  await runCli({
    action,
    allFilesByPattern,
    projectInfo,
    allServerKeys,
    getFilePatternOrPath,
    writeFile,
    pushToServer: makePushToServer(host, accessToken),
    appHost: host,
    translationFilesConfig
  });
}
async function fetchServerKeys(host, projectId, accessToken) {
  return await fetch(`${host}/api/cli/${projectId}/allKeys`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  }).then((res) => {
    if (res.ok) {
      return res.json();
    } else {
      throw new Error(
        "Failed to fetch project info. Status: " + res.statusText
      );
    }
  });
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
        "Failed to fetch project info. Status: " + res.statusText
      );
    }
  });
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
      return res.json();
    } else {
      throw new Error("Failed to add keys and translations");
    }
  };
}
async function pingServer(host) {
  const res = await fetch(`${host}/api/cli/ping`);
  if (!res.ok) {
    console.error(`Could not connect to server at ${host}`);
    process.exit(1);
  }
  const json = await res.json();
  if (json.cliVersion !== packageJson.version) {
    console.warn(
      `Your CLI version is different from the server version, please update. Your version is ${packageJson.version}, but the server is ${json.cliVersion}.`
    );
  }
}
async function writeFile(file, content) {
  await fs.writeFile(file, content, "utf-8");
}

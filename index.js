#!/usr/bin/env node

// THIS FILE IS GENERATED:
// This project/repo is generated from Babli.ai internal monorepo. It is intended for read-only use. You can file issues here. PRs are welcome, but will need to be manually migrated to the monorepo.

import fs from 'fs/promises';
import { z } from 'zod';
import Parser from 'web-tree-sitter';
import { confirm, select } from '@inquirer/prompts';
import { glob } from 'glob';
import yaml from 'js-yaml';
import { Command } from 'commander';
import escapeRegExp from 'lodash/escapeRegExp.js';
import open from 'open';
import path from 'path';

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
  "json-nested": async (fileContent, projectSeparator) => {
    const parsed = JSON.parse(fileContent);
    return {
      keys: gatherTranslationsFromMaybeNestedObject(parsed, projectSeparator),
      fileFormat: "json-nested"
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
  name,
  content,
  projectSeparator
}) {
  const extension = name.split(".").pop();
  if (extension === "json") {
    const processor = fileProcessors.json;
    return processor(content, projectSeparator);
  }
  if (extension === "arb") {
    const processor = fileProcessors.flutterArb;
    return processor(content, projectSeparator);
  }
  if (extension === "ts" || extension === "tsx" || extension === "js" || extension === "jsx") {
    const processor = fileProcessors.typescript;
    return processor(content, projectSeparator);
  }
  throw new Error(`Unsupported file extension: ${extension}`);
}

function generateTranslationFile(keys, format, localeCode) {
  switch (format) {
    case "json":
      const simpleJson = {};
      for (const [key, value] of keys) {
        simpleJson[key] = value.value;
      }
      return JSON.stringify(simpleJson, null, 2);
    case "json-nested":
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
      return JSON.stringify(nested, null, 2);
    case "flutterArb":
      return generateFlutterArb(keys, localeCode);
    case "typescript":
      throw new Error("Not implemented");
  }
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

function nonNullable(value) {
  return value !== null && value !== void 0;
}

const Reset = "\x1B[0m";
const Bold = "\x1B[1m";
const FgBlue = "\x1B[34m";

async function runCli({
  action,
  allFilesByPattern,
  projectInfo,
  allServerKeys,
  getFilePatternOrPath,
  writeFile,
  pushToServer,
  appHost,
  preferredFileFormat
}) {
  var _a;
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
  const localAllFiles = [];
  const mergedKeysByKey = {};
  const mergedKeysInLocalOrder = {};
  const languagesOnServer = new Set(projectInfo.languages.map((l) => l.code));
  const languagesOnLocal = /* @__PURE__ */ new Set();
  let anyFileDetectedFileFormat = null;
  for (const [pathTemplate, allFilesForTemplate] of Object.entries(
    allFilesByPattern
  )) {
    for (const file of allFilesForTemplate) {
      languagesOnLocal.add(file.lang);
      const { fileFormat, keys } = await detectAndProcessTranslationFile({
        content: file.content,
        name: file.path,
        projectSeparator: projectInfo.keySeparator
        // TODO get from project info
      });
      if (!anyFileDetectedFileFormat) {
        anyFileDetectedFileFormat = fileFormat;
      } else if (anyFileDetectedFileFormat !== fileFormat) {
        console.log(
          `Warning: could not determine default file format. Using ${anyFileDetectedFileFormat}.`
        );
      }
      file.fileFormat = fileFormat;
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
              filePathTemplate: pathTemplate,
              fileFormat,
              description: val.description,
              meta: val.meta
            }
          };
        }
        mergedKeysInLocalOrder[_a = file.path] ?? (mergedKeysInLocalOrder[_a] = { lang: file.lang, keys: [] });
        mergedKeysInLocalOrder[file.path].keys.push(mergedKeysByKey[key]);
      }
    }
    localAllFiles.push(...allFilesForTemplate);
  }
  for (const serverKey of allServerKeys) {
    if (mergedKeysByKey[serverKey.key]) {
      mergedKeysByKey[serverKey.key].server = {
        id: serverKey.id,
        description: serverKey.description ?? void 0
      };
    } else {
      mergedKeysByKey[serverKey.key] = {
        key: serverKey.key,
        translations: mergedKeysByKey[serverKey.key]?.translations ?? {},
        server: {
          id: serverKey.id,
          description: serverKey.description ?? void 0
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
      const pattern = (
        // mergedKeysByKey[serverKey.key]?.local?.filePathTemplate ??
        getFilePatternOrPath({ lang })
      );
      if (!pattern) {
        throw new Error(
          `Could not determine file path pattern for key: "${serverKey.key}"; language: "${lang}"`
        );
      }
      const filePath = pattern.replace("{{lang}}", lang);
      mergedKeysInLocalOrder[filePath] ?? (mergedKeysInLocalOrder[filePath] = { lang, keys: [] });
      mergedKeysInLocalOrder[filePath].keys.push(
        mergedKeysByKey[serverKey.key]
      );
    }
  }
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
      if (!translation?.server?.currentValue == void 0) {
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
  let needPull = false;
  let needPush = false;
  if (missingLanguagesOnLocal.size !== 0) {
    console.info(
      `${Bold}${missingLanguagesOnLocal.size} missing languages locally:${Reset}`,
      Array.from(missingLanguagesOnLocal).join(", ")
    );
    needPull = true;
  }
  if (missingLanguagesOnServer.size !== 0) {
    console.info(
      `${Bold}${missingLanguagesOnServer.size} missing languages on server:${Reset}`,
      Array.from(missingLanguagesOnServer).join(", ")
    );
    needPush = true;
  }
  if (Object.keys(missingKeysOnLocal).length !== 0) {
    const len = Object.keys(missingKeysOnLocal).length;
    const part = Object.keys(missingKeysOnLocal).slice(0, 10);
    console.info(
      `${Bold}${len} missing keys locally:${Reset}`,
      part.join(", "),
      len > 10 ? "..." : ""
    );
    needPull = true;
  }
  if (Object.keys(missingKeysOnServer).length !== 0) {
    const len = Object.keys(missingKeysOnServer).length;
    const part = Object.keys(missingKeysOnServer).slice(0, 10);
    console.info(
      `${Bold}${len} missing keys on server:${Reset}`,
      part.join(", "),
      len > 10 ? "..." : ""
    );
    needPush = true;
  }
  if (Object.keys(missingTranslationsOnLocalPerLanguage).length !== 0) {
    for (const [lang, keys] of Object.entries(
      missingTranslationsOnLocalPerLanguage
    )) {
      console.info(
        `${Bold}${keys.length} missing translations locally for ${lang}:${Reset}`,
        keys.map((k) => k.key).join(", ")
      );
    }
    needPull = true;
  }
  if (Object.keys(missingTranslationsOnServerPerLanguage).length !== 0) {
    for (const [lang, keys] of Object.entries(
      missingTranslationsOnServerPerLanguage
    )) {
      console.info(
        `${Bold}${keys.length} missing translations on server for ${lang}:${Reset}`,
        keys.map((k) => k.key).join(", ")
      );
    }
    needPush = true;
  }
  if (Object.keys(differentTranslationsLanguage).length !== 0) {
    for (const [lang, keys] of Object.entries(differentTranslationsLanguage)) {
      for (const key of keys) {
        const translation = key.translations[lang];
        console.info(
          `${Bold}Different translation for ${key.key} in ${lang}:${Reset}`,
          translation?.local?.value,
          "(local) vs. ",
          translation?.server?.currentValue,
          "(server)"
        );
      }
    }
    needPush = true;
  }
  if (!needPull && !needPush) {
    console.info(`${Bold}Everything is up to date. ${Reset}`);
  }
  if (action === "status") {
    console.info("\nDetailed status: \n");
    console.info("To push: ");
    console.info(
      `${Array.from(missingLanguagesOnServer).length} missing languages on server:`,
      Array.from(missingLanguagesOnServer).join(", ")
    );
    console.info(
      `${Object.keys(missingKeysOnServer).length} missing keys on server:`,
      Object.keys(missingKeysOnServer).join(", ")
    );
    console.info(
      `${Object.keys(missingTranslationsOnServerPerLanguage).length} missing translations on server:`,
      Object.keys(missingTranslationsOnServerPerLanguage).join(", ")
    );
    console.info(
      `${Object.keys(differentTranslationsLanguage).length} different translations on server:`,
      Object.keys(differentTranslationsLanguage).join(", ")
    );
    console.info("\n");
    console.info("To pull: ");
    console.info(
      `${Object.keys(missingKeysOnLocal).length} missing keys locally:`,
      Object.keys(missingKeysOnLocal).join(", ")
    );
    console.info(
      `${Object.keys(missingTranslationsOnLocalPerLanguage).length} missing translations locally:`,
      Object.keys(missingTranslationsOnLocalPerLanguage).join(", ")
    );
    console.info(
      `${Object.keys(differentTranslationsLanguage).length} different translations locally:`,
      Object.keys(differentTranslationsLanguage).join(", ")
    );
  }
  if (action === "push") {
    console.info(
      `${Array.from(missingLanguagesOnServer).length} languages will be pushed:`,
      Array.from(missingLanguagesOnServer).join(", ")
    );
    if (Array.from(missingLanguagesOnServer).length > 0) {
      const answer = await confirm({ message: "Continue?" });
      if (!answer) {
        console.info("Aborting");
        process.exit(0);
      }
    }
    console.info(
      `${Object.keys(missingKeysOnServer).length} keys will be pushed:`,
      Object.keys(missingKeysOnServer).join(", ")
    );
    if (Object.keys(missingKeysOnServer).length > 0) {
      const answer2 = await confirm({ message: "Continue?" });
      if (!answer2) {
        console.info("Aborting");
        process.exit(0);
      }
    }
    console.info(
      `${Object.keys(missingTranslationsOnServerPerLanguage).length} translations will be pushed:`,
      Object.keys(missingTranslationsOnServerPerLanguage).join(", ")
    );
    if (Object.keys(missingTranslationsOnServerPerLanguage).length > 0) {
      const answer3 = await confirm({ message: "Continue?" });
      if (!answer3) {
        console.info("Aborting");
        process.exit(0);
      }
    }
    console.info(
      `${Object.keys(differentTranslationsLanguage).length} different translations on server:`,
      Object.keys(differentTranslationsLanguage).join(", ")
    );
    for (const [lang, keys] of Object.entries(differentTranslationsLanguage)) {
      for (const key of keys) {
        const local = key.translations[lang]?.local;
        const server = key.translations[lang]?.server;
        if (!local || !server) {
          console.error("Unexpected error: local or server is null");
          process.exit(1);
        }
        console.info(
          `

${Bold}Different translations were found on server and local:${Reset}`
        );
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
            translations: Object.entries(key.translations).map(([lang, translation]) => {
              const value = translation.local?.value;
              if (value === void 0) {
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
  if (action === "pull") {
    console.info("PULLING");
    const keysToPullByFile = {};
    for (const [filePath, { lang, keys }] of Object.entries(
      mergedKeysInLocalOrder
    )) {
      for (const key of keys) {
        const description = key.server?.description;
        const translation = key.translations[lang];
        const value = translation?.server?.currentValue;
        if (value !== void 0) {
          const fileFormat = key.local?.fileFormat ?? preferredFileFormat ?? anyFileDetectedFileFormat;
          if (!fileFormat) {
            throw new Error("Could not determine file format");
          }
          keysToPullByFile[filePath] ?? (keysToPullByFile[filePath] = {
            keys: [],
            lang,
            fileFormat
          });
          keysToPullByFile[filePath].keys.push({
            key: key.key,
            value,
            description,
            meta: key.local?.meta ?? {}
          });
        }
      }
    }
    for (const [
      file,
      { keys, lang, fileFormat: fileDetectedFileFormat }
    ] of Object.entries(keysToPullByFile)) {
      const res = generateTranslationFile(
        keys.map(({ key, value, description, meta }) => [
          key,
          {
            value,
            description,
            meta
          }
        ]),
        preferredFileFormat ?? fileDetectedFileFormat,
        lang
      );
      await writeFile(file, res);
    }
    console.info("PULLING DONE");
  }
}

var name = "babli";
var version = "0.0.7";
var type = "module";
var license = "MIT";
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
	"js-yaml": "^4.1.0",
	lodash: "^4.17.21",
	open: "^10.1.0",
	"web-tree-sitter": "^0.22.6",
	zod: "^3.23.8"
};
var packageJson = {
	name: name,
	version: version,
	type: type,
	license: license,
	bin: bin,
	scripts: scripts,
	dependencies: dependencies
};

const keyFilePath = path.join(import.meta.dirname, "babli_k");
const zTranslationFileConfig = z.union([
  z.object({
    pattern: z.string(),
    /**
     * when not provided, we will use all languages found by the pattern for push, and all languages not included in other patterns for pull
     */
    languages: z.array(z.string()).optional()
  }),
  z.object({
    path: z.string(),
    language: z.string()
  })
]);
const zFileFormat = z.enum(["json", "json-nested", "flutterArb", "typescript"]);
const zConfigFile = z.object({
  projectId: z.string(),
  sortBy: z.union([z.literal("key"), z.literal("value"), z.literal("original")]).default("original"),
  /**
   * this is needed for the case when we have multiple files with pattern
   */
  defaultFilePattern: z.string().optional(),
  translationFiles: z.array(zTranslationFileConfig),
  fileFormat: zFileFormat.optional(),
  defaultFile: z.string().optional(),
  host: z.string().default("https://www.babli.ai")
});
const program = new Command();
program.command("login").description("Login to Babli.ai").action(async () => {
  await run("login");
});
program.command("logout").description("Logout from Babli.ai").action(async () => {
  await run("logout");
});
program.command("push").description("Push translations to Babli.ai").action(async () => {
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
    obj = yaml.load(text);
  }
  if (jsonFileExists) {
    const text = await fs.readFile("babli.json", "utf-8");
    obj = JSON.parse(text);
  }
  if (!obj) {
    throw new Error("Failed to parse config file");
  }
  const parsed = zConfigFile.parse(obj);
  return parsed;
}
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
  const parsed = await loadConfigFile();
  const {
    projectId,
    translationFiles: translationFilesConfig,
    host,
    fileFormat
  } = parsed;
  if (action === "login") {
    const requestCode = crypto.randomUUID();
    async function fetchKeyInLoop() {
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
        return fetchKeyInLoop();
      } else if (res.status === "ok") {
        return res.key;
      }
      throw new Error("Unexpected status");
    }
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
    const key = await fetchKeyInLoop();
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
  async function pushToServer({
    projectId: projectId2,
    newLanguages,
    input
  }) {
    const res = await fetch(
      `${host}/api/cli/${projectId2}/addKeysAndTranslations`,
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
  }
  const translationFilesConfigsByLang = /* @__PURE__ */ new Map();
  for (const file of translationFilesConfig) {
    if ("language" in file) {
      translationFilesConfigsByLang.set(file.language, file);
    }
    if ("languages" in file && file.languages) {
      for (const lang of file.languages) {
        translationFilesConfigsByLang.set(lang, file);
      }
    }
  }
  function firstFilePatternWithoutLanguage() {
    for (const file of translationFilesConfig) {
      if ("pattern" in file && !("languages" in file)) {
        return file.pattern;
      }
    }
  }
  function getFilePatternOrPath({
    lang
  }) {
    const file = translationFilesConfigsByLang.get(lang);
    if (file) {
      return "pattern" in file ? file.pattern : file.path;
    } else {
      return parsed.defaultFilePattern ?? firstFilePatternWithoutLanguage();
    }
  }
  const projectInfo = await fetch(`${host}/api/cli/${projectId}/projectInfo`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  }).then((res) => {
    if (res.ok) {
      return res.json();
    } else {
      throw new Error("Failed to fetch project info");
    }
  });
  const allServerKeys = await fetch(`${host}/api/cli/${projectId}/allKeys`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  }).then((res) => {
    if (res.ok) {
      return res.json();
    } else {
      throw new Error("Failed to fetch project info");
    }
  });
  const allFilesByPattern = {};
  for (const file of translationFilesConfig) {
    const files = [];
    const pathTemplate = "pattern" in file ? file.pattern : file.path;
    if ("pattern" in file) {
      if (file.languages) {
        for (const lang of file.languages) {
          const path2 = file.pattern.replace("{{lang}}", lang);
          files.push({ path: path2, lang });
        }
      } else {
        const foundFilePaths = await glob(
          file.pattern.replace("{{lang}}", "*")
        );
        const [prefix, postfix] = file.pattern.split("{{lang}}");
        if (!prefix || !postfix) {
          throw new Error("Invalid file path: " + file.pattern);
        }
        const plainPrefix = prefix.replace("./", "");
        for (const filePath of foundFilePaths) {
          const langPart = filePath.replace(
            new RegExp("^" + escapeRegExp(plainPrefix)),
            ""
          );
          const lang = langPart.replace(
            new RegExp(escapeRegExp(postfix) + "$"),
            ""
          );
          files.push({ path: filePath, lang });
        }
      }
    } else {
      files.push({ path: file.path, lang: file.language });
    }
    const allFilesForTemplate = await Promise.all(
      files.map(async ({ lang, path: path2 }) => {
        const text = await fs.readFile(path2, "utf-8");
        return {
          lang,
          path: path2,
          content: text,
          pathTemplate,
          fileFormat: null
          // will be filled later
        };
      })
    );
    allFilesByPattern[pathTemplate] = allFilesForTemplate;
  }
  async function writeFile(file, content) {
    await fs.writeFile(file, content, "utf-8");
  }
  async function pingServer() {
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
  await pingServer();
  await runCli({
    action,
    allFilesByPattern,
    projectInfo,
    allServerKeys,
    getFilePatternOrPath,
    writeFile,
    pushToServer,
    appHost: host,
    preferredFileFormat: fileFormat
  });
}

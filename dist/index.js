#!/usr/bin/env node
import yaml from 'js-yaml';
import PO from 'pofile';
import { Parser, Language, Query } from 'web-tree-sitter';
import path$2, { join, resolve } from 'path';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'fs/promises';
import fs__default from 'fs/promises';
import { stdin, env } from 'process';
import fs$1, { readFile } from 'node:fs/promises';
import path$1 from 'node:path';
import open from 'open';
import { glob } from 'glob';
import { parse, stringify } from 'yaml';
import { setTimeout as setTimeout$1 } from 'node:timers/promises';
import { Option, Command, Help } from 'commander';
import { select, input, checkbox, confirm } from '@inquirer/prompts';
import fsSync from 'fs';
import ignore from 'ignore';
import { stdin as stdin$1 } from 'node:process';
import { pathToFileURL } from 'url';

function exists(value, message) {
  if (value === null || value === void 0) {
    throw new Error(message ?? "Assertion failed: Value is null or undefined");
  }
  return value;
}
function assertNever$1(x) {
  throw new Error(`Unexpected value: ${x}`);
}

function nonNullable(value) {
  return value !== null && value !== void 0;
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
      return assertNever$1(format);
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

async function gatherSyncLocalKeys({
  allFilesByPattern,
  keySeparator,
  emptyValueString,
  transformConfigs = [],
  transforms = /* @__PURE__ */ new Map(),
  fileAPI,
  cwd
}) {
  const result = await gatherLocalKeys({
    allFilesByPattern,
    keySeparator,
    emptyValueString
  });
  const { languagesOnLocal, mergedKeysByKeyByNamespace } = result;
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
  return result;
}

function assertNever(x) {
  throw new Error(`Unexpected value: ${x}`);
}

function unwrap(value, message) {
  if (value === null || value === void 0) {
    throw new Error("Unwrap failed: value is null or undefined");
  }
  return value;
}

var util;
(function (util) {
    util.assertEqual = (_) => { };
    function assertIs(_arg) { }
    util.assertIs = assertIs;
    function assertNever(_x) {
        throw new Error();
    }
    util.assertNever = assertNever;
    util.arrayToEnum = (items) => {
        const obj = {};
        for (const item of items) {
            obj[item] = item;
        }
        return obj;
    };
    util.getValidEnumValues = (obj) => {
        const validKeys = util.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
        const filtered = {};
        for (const k of validKeys) {
            filtered[k] = obj[k];
        }
        return util.objectValues(filtered);
    };
    util.objectValues = (obj) => {
        return util.objectKeys(obj).map(function (e) {
            return obj[e];
        });
    };
    util.objectKeys = typeof Object.keys === "function" // eslint-disable-line ban/ban
        ? (obj) => Object.keys(obj) // eslint-disable-line ban/ban
        : (object) => {
            const keys = [];
            for (const key in object) {
                if (Object.prototype.hasOwnProperty.call(object, key)) {
                    keys.push(key);
                }
            }
            return keys;
        };
    util.find = (arr, checker) => {
        for (const item of arr) {
            if (checker(item))
                return item;
        }
        return undefined;
    };
    util.isInteger = typeof Number.isInteger === "function"
        ? (val) => Number.isInteger(val) // eslint-disable-line ban/ban
        : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
    function joinValues(array, separator = " | ") {
        return array.map((val) => (typeof val === "string" ? `'${val}'` : val)).join(separator);
    }
    util.joinValues = joinValues;
    util.jsonStringifyReplacer = (_, value) => {
        if (typeof value === "bigint") {
            return value.toString();
        }
        return value;
    };
})(util || (util = {}));
var objectUtil;
(function (objectUtil) {
    objectUtil.mergeShapes = (first, second) => {
        return {
            ...first,
            ...second, // second overwrites first
        };
    };
})(objectUtil || (objectUtil = {}));
const ZodParsedType = util.arrayToEnum([
    "string",
    "nan",
    "number",
    "integer",
    "float",
    "boolean",
    "date",
    "bigint",
    "symbol",
    "function",
    "undefined",
    "null",
    "array",
    "object",
    "unknown",
    "promise",
    "void",
    "never",
    "map",
    "set",
]);
const getParsedType = (data) => {
    const t = typeof data;
    switch (t) {
        case "undefined":
            return ZodParsedType.undefined;
        case "string":
            return ZodParsedType.string;
        case "number":
            return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
        case "boolean":
            return ZodParsedType.boolean;
        case "function":
            return ZodParsedType.function;
        case "bigint":
            return ZodParsedType.bigint;
        case "symbol":
            return ZodParsedType.symbol;
        case "object":
            if (Array.isArray(data)) {
                return ZodParsedType.array;
            }
            if (data === null) {
                return ZodParsedType.null;
            }
            if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
                return ZodParsedType.promise;
            }
            if (typeof Map !== "undefined" && data instanceof Map) {
                return ZodParsedType.map;
            }
            if (typeof Set !== "undefined" && data instanceof Set) {
                return ZodParsedType.set;
            }
            if (typeof Date !== "undefined" && data instanceof Date) {
                return ZodParsedType.date;
            }
            return ZodParsedType.object;
        default:
            return ZodParsedType.unknown;
    }
};

const ZodIssueCode = util.arrayToEnum([
    "invalid_type",
    "invalid_literal",
    "custom",
    "invalid_union",
    "invalid_union_discriminator",
    "invalid_enum_value",
    "unrecognized_keys",
    "invalid_arguments",
    "invalid_return_type",
    "invalid_date",
    "invalid_string",
    "too_small",
    "too_big",
    "invalid_intersection_types",
    "not_multiple_of",
    "not_finite",
]);
class ZodError extends Error {
    get errors() {
        return this.issues;
    }
    constructor(issues) {
        super();
        this.issues = [];
        this.addIssue = (sub) => {
            this.issues = [...this.issues, sub];
        };
        this.addIssues = (subs = []) => {
            this.issues = [...this.issues, ...subs];
        };
        const actualProto = new.target.prototype;
        if (Object.setPrototypeOf) {
            // eslint-disable-next-line ban/ban
            Object.setPrototypeOf(this, actualProto);
        }
        else {
            this.__proto__ = actualProto;
        }
        this.name = "ZodError";
        this.issues = issues;
    }
    format(_mapper) {
        const mapper = _mapper ||
            function (issue) {
                return issue.message;
            };
        const fieldErrors = { _errors: [] };
        const processError = (error) => {
            for (const issue of error.issues) {
                if (issue.code === "invalid_union") {
                    issue.unionErrors.map(processError);
                }
                else if (issue.code === "invalid_return_type") {
                    processError(issue.returnTypeError);
                }
                else if (issue.code === "invalid_arguments") {
                    processError(issue.argumentsError);
                }
                else if (issue.path.length === 0) {
                    fieldErrors._errors.push(mapper(issue));
                }
                else {
                    let curr = fieldErrors;
                    let i = 0;
                    while (i < issue.path.length) {
                        const el = issue.path[i];
                        const terminal = i === issue.path.length - 1;
                        if (!terminal) {
                            curr[el] = curr[el] || { _errors: [] };
                            // if (typeof el === "string") {
                            //   curr[el] = curr[el] || { _errors: [] };
                            // } else if (typeof el === "number") {
                            //   const errorArray: any = [];
                            //   errorArray._errors = [];
                            //   curr[el] = curr[el] || errorArray;
                            // }
                        }
                        else {
                            curr[el] = curr[el] || { _errors: [] };
                            curr[el]._errors.push(mapper(issue));
                        }
                        curr = curr[el];
                        i++;
                    }
                }
            }
        };
        processError(this);
        return fieldErrors;
    }
    static assert(value) {
        if (!(value instanceof ZodError)) {
            throw new Error(`Not a ZodError: ${value}`);
        }
    }
    toString() {
        return this.message;
    }
    get message() {
        return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
    }
    get isEmpty() {
        return this.issues.length === 0;
    }
    flatten(mapper = (issue) => issue.message) {
        const fieldErrors = {};
        const formErrors = [];
        for (const sub of this.issues) {
            if (sub.path.length > 0) {
                const firstEl = sub.path[0];
                fieldErrors[firstEl] = fieldErrors[firstEl] || [];
                fieldErrors[firstEl].push(mapper(sub));
            }
            else {
                formErrors.push(mapper(sub));
            }
        }
        return { formErrors, fieldErrors };
    }
    get formErrors() {
        return this.flatten();
    }
}
ZodError.create = (issues) => {
    const error = new ZodError(issues);
    return error;
};

const errorMap = (issue, _ctx) => {
    let message;
    switch (issue.code) {
        case ZodIssueCode.invalid_type:
            if (issue.received === ZodParsedType.undefined) {
                message = "Required";
            }
            else {
                message = `Expected ${issue.expected}, received ${issue.received}`;
            }
            break;
        case ZodIssueCode.invalid_literal:
            message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
            break;
        case ZodIssueCode.unrecognized_keys:
            message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
            break;
        case ZodIssueCode.invalid_union:
            message = `Invalid input`;
            break;
        case ZodIssueCode.invalid_union_discriminator:
            message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
            break;
        case ZodIssueCode.invalid_enum_value:
            message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
            break;
        case ZodIssueCode.invalid_arguments:
            message = `Invalid function arguments`;
            break;
        case ZodIssueCode.invalid_return_type:
            message = `Invalid function return type`;
            break;
        case ZodIssueCode.invalid_date:
            message = `Invalid date`;
            break;
        case ZodIssueCode.invalid_string:
            if (typeof issue.validation === "object") {
                if ("includes" in issue.validation) {
                    message = `Invalid input: must include "${issue.validation.includes}"`;
                    if (typeof issue.validation.position === "number") {
                        message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
                    }
                }
                else if ("startsWith" in issue.validation) {
                    message = `Invalid input: must start with "${issue.validation.startsWith}"`;
                }
                else if ("endsWith" in issue.validation) {
                    message = `Invalid input: must end with "${issue.validation.endsWith}"`;
                }
                else {
                    util.assertNever(issue.validation);
                }
            }
            else if (issue.validation !== "regex") {
                message = `Invalid ${issue.validation}`;
            }
            else {
                message = "Invalid";
            }
            break;
        case ZodIssueCode.too_small:
            if (issue.type === "array")
                message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
            else if (issue.type === "string")
                message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
            else if (issue.type === "number")
                message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
            else if (issue.type === "bigint")
                message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
            else if (issue.type === "date")
                message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
            else
                message = "Invalid input";
            break;
        case ZodIssueCode.too_big:
            if (issue.type === "array")
                message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
            else if (issue.type === "string")
                message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
            else if (issue.type === "number")
                message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
            else if (issue.type === "bigint")
                message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
            else if (issue.type === "date")
                message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
            else
                message = "Invalid input";
            break;
        case ZodIssueCode.custom:
            message = `Invalid input`;
            break;
        case ZodIssueCode.invalid_intersection_types:
            message = `Intersection results could not be merged`;
            break;
        case ZodIssueCode.not_multiple_of:
            message = `Number must be a multiple of ${issue.multipleOf}`;
            break;
        case ZodIssueCode.not_finite:
            message = "Number must be finite";
            break;
        default:
            message = _ctx.defaultError;
            util.assertNever(issue);
    }
    return { message };
};

let overrideErrorMap = errorMap;
function getErrorMap() {
    return overrideErrorMap;
}

const makeIssue = (params) => {
    const { data, path, errorMaps, issueData } = params;
    const fullPath = [...path, ...(issueData.path || [])];
    const fullIssue = {
        ...issueData,
        path: fullPath,
    };
    if (issueData.message !== undefined) {
        return {
            ...issueData,
            path: fullPath,
            message: issueData.message,
        };
    }
    let errorMessage = "";
    const maps = errorMaps
        .filter((m) => !!m)
        .slice()
        .reverse();
    for (const map of maps) {
        errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
    }
    return {
        ...issueData,
        path: fullPath,
        message: errorMessage,
    };
};
function addIssueToContext(ctx, issueData) {
    const overrideMap = getErrorMap();
    const issue = makeIssue({
        issueData: issueData,
        data: ctx.data,
        path: ctx.path,
        errorMaps: [
            ctx.common.contextualErrorMap, // contextual error map is first priority
            ctx.schemaErrorMap, // then schema-bound map if available
            overrideMap, // then global override map
            overrideMap === errorMap ? undefined : errorMap, // then global default map
        ].filter((x) => !!x),
    });
    ctx.common.issues.push(issue);
}
class ParseStatus {
    constructor() {
        this.value = "valid";
    }
    dirty() {
        if (this.value === "valid")
            this.value = "dirty";
    }
    abort() {
        if (this.value !== "aborted")
            this.value = "aborted";
    }
    static mergeArray(status, results) {
        const arrayValue = [];
        for (const s of results) {
            if (s.status === "aborted")
                return INVALID;
            if (s.status === "dirty")
                status.dirty();
            arrayValue.push(s.value);
        }
        return { status: status.value, value: arrayValue };
    }
    static async mergeObjectAsync(status, pairs) {
        const syncPairs = [];
        for (const pair of pairs) {
            const key = await pair.key;
            const value = await pair.value;
            syncPairs.push({
                key,
                value,
            });
        }
        return ParseStatus.mergeObjectSync(status, syncPairs);
    }
    static mergeObjectSync(status, pairs) {
        const finalObject = {};
        for (const pair of pairs) {
            const { key, value } = pair;
            if (key.status === "aborted")
                return INVALID;
            if (value.status === "aborted")
                return INVALID;
            if (key.status === "dirty")
                status.dirty();
            if (value.status === "dirty")
                status.dirty();
            if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
                finalObject[key.value] = value.value;
            }
        }
        return { status: status.value, value: finalObject };
    }
}
const INVALID = Object.freeze({
    status: "aborted",
});
const DIRTY = (value) => ({ status: "dirty", value });
const OK = (value) => ({ status: "valid", value });
const isAborted = (x) => x.status === "aborted";
const isDirty = (x) => x.status === "dirty";
const isValid = (x) => x.status === "valid";
const isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

var errorUtil;
(function (errorUtil) {
    errorUtil.errToObj = (message) => typeof message === "string" ? { message } : message || {};
    // biome-ignore lint:
    errorUtil.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

class ParseInputLazyPath {
    constructor(parent, value, path, key) {
        this._cachedPath = [];
        this.parent = parent;
        this.data = value;
        this._path = path;
        this._key = key;
    }
    get path() {
        if (!this._cachedPath.length) {
            if (Array.isArray(this._key)) {
                this._cachedPath.push(...this._path, ...this._key);
            }
            else {
                this._cachedPath.push(...this._path, this._key);
            }
        }
        return this._cachedPath;
    }
}
const handleResult = (ctx, result) => {
    if (isValid(result)) {
        return { success: true, data: result.value };
    }
    else {
        if (!ctx.common.issues.length) {
            throw new Error("Validation failed but no issues detected.");
        }
        return {
            success: false,
            get error() {
                if (this._error)
                    return this._error;
                const error = new ZodError(ctx.common.issues);
                this._error = error;
                return this._error;
            },
        };
    }
};
function processCreateParams(params) {
    if (!params)
        return {};
    const { errorMap, invalid_type_error, required_error, description } = params;
    if (errorMap && (invalid_type_error || required_error)) {
        throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
    }
    if (errorMap)
        return { errorMap: errorMap, description };
    const customMap = (iss, ctx) => {
        const { message } = params;
        if (iss.code === "invalid_enum_value") {
            return { message: message ?? ctx.defaultError };
        }
        if (typeof ctx.data === "undefined") {
            return { message: message ?? required_error ?? ctx.defaultError };
        }
        if (iss.code !== "invalid_type")
            return { message: ctx.defaultError };
        return { message: message ?? invalid_type_error ?? ctx.defaultError };
    };
    return { errorMap: customMap, description };
}
class ZodType {
    get description() {
        return this._def.description;
    }
    _getType(input) {
        return getParsedType(input.data);
    }
    _getOrReturnCtx(input, ctx) {
        return (ctx || {
            common: input.parent.common,
            data: input.data,
            parsedType: getParsedType(input.data),
            schemaErrorMap: this._def.errorMap,
            path: input.path,
            parent: input.parent,
        });
    }
    _processInputParams(input) {
        return {
            status: new ParseStatus(),
            ctx: {
                common: input.parent.common,
                data: input.data,
                parsedType: getParsedType(input.data),
                schemaErrorMap: this._def.errorMap,
                path: input.path,
                parent: input.parent,
            },
        };
    }
    _parseSync(input) {
        const result = this._parse(input);
        if (isAsync(result)) {
            throw new Error("Synchronous parse encountered promise.");
        }
        return result;
    }
    _parseAsync(input) {
        const result = this._parse(input);
        return Promise.resolve(result);
    }
    parse(data, params) {
        const result = this.safeParse(data, params);
        if (result.success)
            return result.data;
        throw result.error;
    }
    safeParse(data, params) {
        const ctx = {
            common: {
                issues: [],
                async: params?.async ?? false,
                contextualErrorMap: params?.errorMap,
            },
            path: params?.path || [],
            schemaErrorMap: this._def.errorMap,
            parent: null,
            data,
            parsedType: getParsedType(data),
        };
        const result = this._parseSync({ data, path: ctx.path, parent: ctx });
        return handleResult(ctx, result);
    }
    "~validate"(data) {
        const ctx = {
            common: {
                issues: [],
                async: !!this["~standard"].async,
            },
            path: [],
            schemaErrorMap: this._def.errorMap,
            parent: null,
            data,
            parsedType: getParsedType(data),
        };
        if (!this["~standard"].async) {
            try {
                const result = this._parseSync({ data, path: [], parent: ctx });
                return isValid(result)
                    ? {
                        value: result.value,
                    }
                    : {
                        issues: ctx.common.issues,
                    };
            }
            catch (err) {
                if (err?.message?.toLowerCase()?.includes("encountered")) {
                    this["~standard"].async = true;
                }
                ctx.common = {
                    issues: [],
                    async: true,
                };
            }
        }
        return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result)
            ? {
                value: result.value,
            }
            : {
                issues: ctx.common.issues,
            });
    }
    async parseAsync(data, params) {
        const result = await this.safeParseAsync(data, params);
        if (result.success)
            return result.data;
        throw result.error;
    }
    async safeParseAsync(data, params) {
        const ctx = {
            common: {
                issues: [],
                contextualErrorMap: params?.errorMap,
                async: true,
            },
            path: params?.path || [],
            schemaErrorMap: this._def.errorMap,
            parent: null,
            data,
            parsedType: getParsedType(data),
        };
        const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
        const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
        return handleResult(ctx, result);
    }
    refine(check, message) {
        const getIssueProperties = (val) => {
            if (typeof message === "string" || typeof message === "undefined") {
                return { message };
            }
            else if (typeof message === "function") {
                return message(val);
            }
            else {
                return message;
            }
        };
        return this._refinement((val, ctx) => {
            const result = check(val);
            const setError = () => ctx.addIssue({
                code: ZodIssueCode.custom,
                ...getIssueProperties(val),
            });
            if (typeof Promise !== "undefined" && result instanceof Promise) {
                return result.then((data) => {
                    if (!data) {
                        setError();
                        return false;
                    }
                    else {
                        return true;
                    }
                });
            }
            if (!result) {
                setError();
                return false;
            }
            else {
                return true;
            }
        });
    }
    refinement(check, refinementData) {
        return this._refinement((val, ctx) => {
            if (!check(val)) {
                ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
                return false;
            }
            else {
                return true;
            }
        });
    }
    _refinement(refinement) {
        return new ZodEffects({
            schema: this,
            typeName: ZodFirstPartyTypeKind.ZodEffects,
            effect: { type: "refinement", refinement },
        });
    }
    superRefine(refinement) {
        return this._refinement(refinement);
    }
    constructor(def) {
        /** Alias of safeParseAsync */
        this.spa = this.safeParseAsync;
        this._def = def;
        this.parse = this.parse.bind(this);
        this.safeParse = this.safeParse.bind(this);
        this.parseAsync = this.parseAsync.bind(this);
        this.safeParseAsync = this.safeParseAsync.bind(this);
        this.spa = this.spa.bind(this);
        this.refine = this.refine.bind(this);
        this.refinement = this.refinement.bind(this);
        this.superRefine = this.superRefine.bind(this);
        this.optional = this.optional.bind(this);
        this.nullable = this.nullable.bind(this);
        this.nullish = this.nullish.bind(this);
        this.array = this.array.bind(this);
        this.promise = this.promise.bind(this);
        this.or = this.or.bind(this);
        this.and = this.and.bind(this);
        this.transform = this.transform.bind(this);
        this.brand = this.brand.bind(this);
        this.default = this.default.bind(this);
        this.catch = this.catch.bind(this);
        this.describe = this.describe.bind(this);
        this.pipe = this.pipe.bind(this);
        this.readonly = this.readonly.bind(this);
        this.isNullable = this.isNullable.bind(this);
        this.isOptional = this.isOptional.bind(this);
        this["~standard"] = {
            version: 1,
            vendor: "zod",
            validate: (data) => this["~validate"](data),
        };
    }
    optional() {
        return ZodOptional.create(this, this._def);
    }
    nullable() {
        return ZodNullable.create(this, this._def);
    }
    nullish() {
        return this.nullable().optional();
    }
    array() {
        return ZodArray.create(this);
    }
    promise() {
        return ZodPromise.create(this, this._def);
    }
    or(option) {
        return ZodUnion.create([this, option], this._def);
    }
    and(incoming) {
        return ZodIntersection.create(this, incoming, this._def);
    }
    transform(transform) {
        return new ZodEffects({
            ...processCreateParams(this._def),
            schema: this,
            typeName: ZodFirstPartyTypeKind.ZodEffects,
            effect: { type: "transform", transform },
        });
    }
    default(def) {
        const defaultValueFunc = typeof def === "function" ? def : () => def;
        return new ZodDefault({
            ...processCreateParams(this._def),
            innerType: this,
            defaultValue: defaultValueFunc,
            typeName: ZodFirstPartyTypeKind.ZodDefault,
        });
    }
    brand() {
        return new ZodBranded({
            typeName: ZodFirstPartyTypeKind.ZodBranded,
            type: this,
            ...processCreateParams(this._def),
        });
    }
    catch(def) {
        const catchValueFunc = typeof def === "function" ? def : () => def;
        return new ZodCatch({
            ...processCreateParams(this._def),
            innerType: this,
            catchValue: catchValueFunc,
            typeName: ZodFirstPartyTypeKind.ZodCatch,
        });
    }
    describe(description) {
        const This = this.constructor;
        return new This({
            ...this._def,
            description,
        });
    }
    pipe(target) {
        return ZodPipeline.create(this, target);
    }
    readonly() {
        return ZodReadonly.create(this);
    }
    isOptional() {
        return this.safeParse(undefined).success;
    }
    isNullable() {
        return this.safeParse(null).success;
    }
}
const cuidRegex = /^c[^\s-]{8,}$/i;
const cuid2Regex = /^[0-9a-z]+$/;
const ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
// const uuidRegex =
//   /^([a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[a-f0-9]{4}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000)$/i;
const uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
const nanoidRegex = /^[a-z0-9_-]{21}$/i;
const jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
const durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
// from https://stackoverflow.com/a/46181/1550155
// old version: too slow, didn't support unicode
// const emailRegex = /^((([a-z]|\d|[!#\$%&'\*\+\-\/=\?\^_`{\|}~]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])+(\.([a-z]|\d|[!#\$%&'\*\+\-\/=\?\^_`{\|}~]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])+)*)|((\x22)((((\x20|\x09)*(\x0d\x0a))?(\x20|\x09)+)?(([\x01-\x08\x0b\x0c\x0e-\x1f\x7f]|\x21|[\x23-\x5b]|[\x5d-\x7e]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(\\([\x01-\x09\x0b\x0c\x0d-\x7f]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]))))*(((\x20|\x09)*(\x0d\x0a))?(\x20|\x09)+)?(\x22)))@((([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])*([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])))\.)+(([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])*([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])))$/i;
//old email regex
// const emailRegex = /^(([^<>()[\].,;:\s@"]+(\.[^<>()[\].,;:\s@"]+)*)|(".+"))@((?!-)([^<>()[\].,;:\s@"]+\.)+[^<>()[\].,;:\s@"]{1,})[^-<>()[\].,;:\s@"]$/i;
// eslint-disable-next-line
// const emailRegex =
//   /^(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[(((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\.){3}((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\])|(\[IPv6:(([a-f0-9]{1,4}:){7}|::([a-f0-9]{1,4}:){0,6}|([a-f0-9]{1,4}:){1}:([a-f0-9]{1,4}:){0,5}|([a-f0-9]{1,4}:){2}:([a-f0-9]{1,4}:){0,4}|([a-f0-9]{1,4}:){3}:([a-f0-9]{1,4}:){0,3}|([a-f0-9]{1,4}:){4}:([a-f0-9]{1,4}:){0,2}|([a-f0-9]{1,4}:){5}:([a-f0-9]{1,4}:){0,1})([a-f0-9]{1,4}|(((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\.){3}((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2})))\])|([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])*(\.[A-Za-z]{2,})+))$/;
// const emailRegex =
//   /^[a-zA-Z0-9\.\!\#\$\%\&\'\*\+\/\=\?\^\_\`\{\|\}\~\-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
// const emailRegex =
//   /^(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")@(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|\[(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?|[a-z0-9-]*[a-z0-9]:(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21-\x5a\x53-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])+)\])$/i;
const emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
// const emailRegex =
//   /^[a-z0-9.!#$%&’*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9\-]+)*$/i;
// from https://thekevinscott.com/emojis-in-javascript/#writing-a-regular-expression
const _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
let emojiRegex;
// faster, simpler, safer
const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
const ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
// const ipv6Regex =
// /^(([a-f0-9]{1,4}:){7}|::([a-f0-9]{1,4}:){0,6}|([a-f0-9]{1,4}:){1}:([a-f0-9]{1,4}:){0,5}|([a-f0-9]{1,4}:){2}:([a-f0-9]{1,4}:){0,4}|([a-f0-9]{1,4}:){3}:([a-f0-9]{1,4}:){0,3}|([a-f0-9]{1,4}:){4}:([a-f0-9]{1,4}:){0,2}|([a-f0-9]{1,4}:){5}:([a-f0-9]{1,4}:){0,1})([a-f0-9]{1,4}|(((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\.){3}((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2})))$/;
const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
const ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
// https://stackoverflow.com/questions/7860392/determine-if-string-is-in-base64-using-javascript
const base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
// https://base64.guru/standards/base64url
const base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
// simple
// const dateRegexSource = `\\d{4}-\\d{2}-\\d{2}`;
// no leap year validation
// const dateRegexSource = `\\d{4}-((0[13578]|10|12)-31|(0[13-9]|1[0-2])-30|(0[1-9]|1[0-2])-(0[1-9]|1\\d|2\\d))`;
// with leap year validation
const dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
const dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
    let secondsRegexSource = `[0-5]\\d`;
    if (args.precision) {
        secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
    }
    else if (args.precision == null) {
        secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
    }
    const secondsQuantifier = args.precision ? "+" : "?"; // require seconds if precision is nonzero
    return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
    return new RegExp(`^${timeRegexSource(args)}$`);
}
// Adapted from https://stackoverflow.com/a/3143231
function datetimeRegex(args) {
    let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
    const opts = [];
    opts.push(args.local ? `Z?` : `Z`);
    if (args.offset)
        opts.push(`([+-]\\d{2}:?\\d{2})`);
    regex = `${regex}(${opts.join("|")})`;
    return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
    if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
        return true;
    }
    if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
        return true;
    }
    return false;
}
function isValidJWT(jwt, alg) {
    if (!jwtRegex.test(jwt))
        return false;
    try {
        const [header] = jwt.split(".");
        if (!header)
            return false;
        // Convert base64url to base64
        const base64 = header
            .replace(/-/g, "+")
            .replace(/_/g, "/")
            .padEnd(header.length + ((4 - (header.length % 4)) % 4), "=");
        const decoded = JSON.parse(atob(base64));
        if (typeof decoded !== "object" || decoded === null)
            return false;
        if ("typ" in decoded && decoded?.typ !== "JWT")
            return false;
        if (!decoded.alg)
            return false;
        if (alg && decoded.alg !== alg)
            return false;
        return true;
    }
    catch {
        return false;
    }
}
function isValidCidr(ip, version) {
    if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
        return true;
    }
    if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
        return true;
    }
    return false;
}
class ZodString extends ZodType {
    _parse(input) {
        if (this._def.coerce) {
            input.data = String(input.data);
        }
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.string) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.string,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        const status = new ParseStatus();
        let ctx = undefined;
        for (const check of this._def.checks) {
            if (check.kind === "min") {
                if (input.data.length < check.value) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.too_small,
                        minimum: check.value,
                        type: "string",
                        inclusive: true,
                        exact: false,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "max") {
                if (input.data.length > check.value) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.too_big,
                        maximum: check.value,
                        type: "string",
                        inclusive: true,
                        exact: false,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "length") {
                const tooBig = input.data.length > check.value;
                const tooSmall = input.data.length < check.value;
                if (tooBig || tooSmall) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    if (tooBig) {
                        addIssueToContext(ctx, {
                            code: ZodIssueCode.too_big,
                            maximum: check.value,
                            type: "string",
                            inclusive: true,
                            exact: true,
                            message: check.message,
                        });
                    }
                    else if (tooSmall) {
                        addIssueToContext(ctx, {
                            code: ZodIssueCode.too_small,
                            minimum: check.value,
                            type: "string",
                            inclusive: true,
                            exact: true,
                            message: check.message,
                        });
                    }
                    status.dirty();
                }
            }
            else if (check.kind === "email") {
                if (!emailRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "email",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "emoji") {
                if (!emojiRegex) {
                    emojiRegex = new RegExp(_emojiRegex, "u");
                }
                if (!emojiRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "emoji",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "uuid") {
                if (!uuidRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "uuid",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "nanoid") {
                if (!nanoidRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "nanoid",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "cuid") {
                if (!cuidRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "cuid",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "cuid2") {
                if (!cuid2Regex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "cuid2",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "ulid") {
                if (!ulidRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "ulid",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "url") {
                try {
                    new URL(input.data);
                }
                catch {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "url",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "regex") {
                check.regex.lastIndex = 0;
                const testResult = check.regex.test(input.data);
                if (!testResult) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "regex",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "trim") {
                input.data = input.data.trim();
            }
            else if (check.kind === "includes") {
                if (!input.data.includes(check.value, check.position)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.invalid_string,
                        validation: { includes: check.value, position: check.position },
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "toLowerCase") {
                input.data = input.data.toLowerCase();
            }
            else if (check.kind === "toUpperCase") {
                input.data = input.data.toUpperCase();
            }
            else if (check.kind === "startsWith") {
                if (!input.data.startsWith(check.value)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.invalid_string,
                        validation: { startsWith: check.value },
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "endsWith") {
                if (!input.data.endsWith(check.value)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.invalid_string,
                        validation: { endsWith: check.value },
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "datetime") {
                const regex = datetimeRegex(check);
                if (!regex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.invalid_string,
                        validation: "datetime",
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "date") {
                const regex = dateRegex;
                if (!regex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.invalid_string,
                        validation: "date",
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "time") {
                const regex = timeRegex(check);
                if (!regex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.invalid_string,
                        validation: "time",
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "duration") {
                if (!durationRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "duration",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "ip") {
                if (!isValidIP(input.data, check.version)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "ip",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "jwt") {
                if (!isValidJWT(input.data, check.alg)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "jwt",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "cidr") {
                if (!isValidCidr(input.data, check.version)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "cidr",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "base64") {
                if (!base64Regex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "base64",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "base64url") {
                if (!base64urlRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "base64url",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else {
                util.assertNever(check);
            }
        }
        return { status: status.value, value: input.data };
    }
    _regex(regex, validation, message) {
        return this.refinement((data) => regex.test(data), {
            validation,
            code: ZodIssueCode.invalid_string,
            ...errorUtil.errToObj(message),
        });
    }
    _addCheck(check) {
        return new ZodString({
            ...this._def,
            checks: [...this._def.checks, check],
        });
    }
    email(message) {
        return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
    }
    url(message) {
        return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
    }
    emoji(message) {
        return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
    }
    uuid(message) {
        return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
    }
    nanoid(message) {
        return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
    }
    cuid(message) {
        return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
    }
    cuid2(message) {
        return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
    }
    ulid(message) {
        return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
    }
    base64(message) {
        return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
    }
    base64url(message) {
        // base64url encoding is a modification of base64 that can safely be used in URLs and filenames
        return this._addCheck({
            kind: "base64url",
            ...errorUtil.errToObj(message),
        });
    }
    jwt(options) {
        return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
    }
    ip(options) {
        return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
    }
    cidr(options) {
        return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
    }
    datetime(options) {
        if (typeof options === "string") {
            return this._addCheck({
                kind: "datetime",
                precision: null,
                offset: false,
                local: false,
                message: options,
            });
        }
        return this._addCheck({
            kind: "datetime",
            precision: typeof options?.precision === "undefined" ? null : options?.precision,
            offset: options?.offset ?? false,
            local: options?.local ?? false,
            ...errorUtil.errToObj(options?.message),
        });
    }
    date(message) {
        return this._addCheck({ kind: "date", message });
    }
    time(options) {
        if (typeof options === "string") {
            return this._addCheck({
                kind: "time",
                precision: null,
                message: options,
            });
        }
        return this._addCheck({
            kind: "time",
            precision: typeof options?.precision === "undefined" ? null : options?.precision,
            ...errorUtil.errToObj(options?.message),
        });
    }
    duration(message) {
        return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
    }
    regex(regex, message) {
        return this._addCheck({
            kind: "regex",
            regex: regex,
            ...errorUtil.errToObj(message),
        });
    }
    includes(value, options) {
        return this._addCheck({
            kind: "includes",
            value: value,
            position: options?.position,
            ...errorUtil.errToObj(options?.message),
        });
    }
    startsWith(value, message) {
        return this._addCheck({
            kind: "startsWith",
            value: value,
            ...errorUtil.errToObj(message),
        });
    }
    endsWith(value, message) {
        return this._addCheck({
            kind: "endsWith",
            value: value,
            ...errorUtil.errToObj(message),
        });
    }
    min(minLength, message) {
        return this._addCheck({
            kind: "min",
            value: minLength,
            ...errorUtil.errToObj(message),
        });
    }
    max(maxLength, message) {
        return this._addCheck({
            kind: "max",
            value: maxLength,
            ...errorUtil.errToObj(message),
        });
    }
    length(len, message) {
        return this._addCheck({
            kind: "length",
            value: len,
            ...errorUtil.errToObj(message),
        });
    }
    /**
     * Equivalent to `.min(1)`
     */
    nonempty(message) {
        return this.min(1, errorUtil.errToObj(message));
    }
    trim() {
        return new ZodString({
            ...this._def,
            checks: [...this._def.checks, { kind: "trim" }],
        });
    }
    toLowerCase() {
        return new ZodString({
            ...this._def,
            checks: [...this._def.checks, { kind: "toLowerCase" }],
        });
    }
    toUpperCase() {
        return new ZodString({
            ...this._def,
            checks: [...this._def.checks, { kind: "toUpperCase" }],
        });
    }
    get isDatetime() {
        return !!this._def.checks.find((ch) => ch.kind === "datetime");
    }
    get isDate() {
        return !!this._def.checks.find((ch) => ch.kind === "date");
    }
    get isTime() {
        return !!this._def.checks.find((ch) => ch.kind === "time");
    }
    get isDuration() {
        return !!this._def.checks.find((ch) => ch.kind === "duration");
    }
    get isEmail() {
        return !!this._def.checks.find((ch) => ch.kind === "email");
    }
    get isURL() {
        return !!this._def.checks.find((ch) => ch.kind === "url");
    }
    get isEmoji() {
        return !!this._def.checks.find((ch) => ch.kind === "emoji");
    }
    get isUUID() {
        return !!this._def.checks.find((ch) => ch.kind === "uuid");
    }
    get isNANOID() {
        return !!this._def.checks.find((ch) => ch.kind === "nanoid");
    }
    get isCUID() {
        return !!this._def.checks.find((ch) => ch.kind === "cuid");
    }
    get isCUID2() {
        return !!this._def.checks.find((ch) => ch.kind === "cuid2");
    }
    get isULID() {
        return !!this._def.checks.find((ch) => ch.kind === "ulid");
    }
    get isIP() {
        return !!this._def.checks.find((ch) => ch.kind === "ip");
    }
    get isCIDR() {
        return !!this._def.checks.find((ch) => ch.kind === "cidr");
    }
    get isBase64() {
        return !!this._def.checks.find((ch) => ch.kind === "base64");
    }
    get isBase64url() {
        // base64url encoding is a modification of base64 that can safely be used in URLs and filenames
        return !!this._def.checks.find((ch) => ch.kind === "base64url");
    }
    get minLength() {
        let min = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "min") {
                if (min === null || ch.value > min)
                    min = ch.value;
            }
        }
        return min;
    }
    get maxLength() {
        let max = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "max") {
                if (max === null || ch.value < max)
                    max = ch.value;
            }
        }
        return max;
    }
}
ZodString.create = (params) => {
    return new ZodString({
        checks: [],
        typeName: ZodFirstPartyTypeKind.ZodString,
        coerce: params?.coerce ?? false,
        ...processCreateParams(params),
    });
};
// https://stackoverflow.com/questions/3966484/why-does-modulus-operator-return-fractional-number-in-javascript/31711034#31711034
function floatSafeRemainder(val, step) {
    const valDecCount = (val.toString().split(".")[1] || "").length;
    const stepDecCount = (step.toString().split(".")[1] || "").length;
    const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
    const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
    const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
    return (valInt % stepInt) / 10 ** decCount;
}
class ZodNumber extends ZodType {
    constructor() {
        super(...arguments);
        this.min = this.gte;
        this.max = this.lte;
        this.step = this.multipleOf;
    }
    _parse(input) {
        if (this._def.coerce) {
            input.data = Number(input.data);
        }
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.number) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.number,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        let ctx = undefined;
        const status = new ParseStatus();
        for (const check of this._def.checks) {
            if (check.kind === "int") {
                if (!util.isInteger(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.invalid_type,
                        expected: "integer",
                        received: "float",
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "min") {
                const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
                if (tooSmall) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.too_small,
                        minimum: check.value,
                        type: "number",
                        inclusive: check.inclusive,
                        exact: false,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "max") {
                const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
                if (tooBig) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.too_big,
                        maximum: check.value,
                        type: "number",
                        inclusive: check.inclusive,
                        exact: false,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "multipleOf") {
                if (floatSafeRemainder(input.data, check.value) !== 0) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.not_multiple_of,
                        multipleOf: check.value,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "finite") {
                if (!Number.isFinite(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.not_finite,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else {
                util.assertNever(check);
            }
        }
        return { status: status.value, value: input.data };
    }
    gte(value, message) {
        return this.setLimit("min", value, true, errorUtil.toString(message));
    }
    gt(value, message) {
        return this.setLimit("min", value, false, errorUtil.toString(message));
    }
    lte(value, message) {
        return this.setLimit("max", value, true, errorUtil.toString(message));
    }
    lt(value, message) {
        return this.setLimit("max", value, false, errorUtil.toString(message));
    }
    setLimit(kind, value, inclusive, message) {
        return new ZodNumber({
            ...this._def,
            checks: [
                ...this._def.checks,
                {
                    kind,
                    value,
                    inclusive,
                    message: errorUtil.toString(message),
                },
            ],
        });
    }
    _addCheck(check) {
        return new ZodNumber({
            ...this._def,
            checks: [...this._def.checks, check],
        });
    }
    int(message) {
        return this._addCheck({
            kind: "int",
            message: errorUtil.toString(message),
        });
    }
    positive(message) {
        return this._addCheck({
            kind: "min",
            value: 0,
            inclusive: false,
            message: errorUtil.toString(message),
        });
    }
    negative(message) {
        return this._addCheck({
            kind: "max",
            value: 0,
            inclusive: false,
            message: errorUtil.toString(message),
        });
    }
    nonpositive(message) {
        return this._addCheck({
            kind: "max",
            value: 0,
            inclusive: true,
            message: errorUtil.toString(message),
        });
    }
    nonnegative(message) {
        return this._addCheck({
            kind: "min",
            value: 0,
            inclusive: true,
            message: errorUtil.toString(message),
        });
    }
    multipleOf(value, message) {
        return this._addCheck({
            kind: "multipleOf",
            value: value,
            message: errorUtil.toString(message),
        });
    }
    finite(message) {
        return this._addCheck({
            kind: "finite",
            message: errorUtil.toString(message),
        });
    }
    safe(message) {
        return this._addCheck({
            kind: "min",
            inclusive: true,
            value: Number.MIN_SAFE_INTEGER,
            message: errorUtil.toString(message),
        })._addCheck({
            kind: "max",
            inclusive: true,
            value: Number.MAX_SAFE_INTEGER,
            message: errorUtil.toString(message),
        });
    }
    get minValue() {
        let min = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "min") {
                if (min === null || ch.value > min)
                    min = ch.value;
            }
        }
        return min;
    }
    get maxValue() {
        let max = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "max") {
                if (max === null || ch.value < max)
                    max = ch.value;
            }
        }
        return max;
    }
    get isInt() {
        return !!this._def.checks.find((ch) => ch.kind === "int" || (ch.kind === "multipleOf" && util.isInteger(ch.value)));
    }
    get isFinite() {
        let max = null;
        let min = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
                return true;
            }
            else if (ch.kind === "min") {
                if (min === null || ch.value > min)
                    min = ch.value;
            }
            else if (ch.kind === "max") {
                if (max === null || ch.value < max)
                    max = ch.value;
            }
        }
        return Number.isFinite(min) && Number.isFinite(max);
    }
}
ZodNumber.create = (params) => {
    return new ZodNumber({
        checks: [],
        typeName: ZodFirstPartyTypeKind.ZodNumber,
        coerce: params?.coerce || false,
        ...processCreateParams(params),
    });
};
class ZodBigInt extends ZodType {
    constructor() {
        super(...arguments);
        this.min = this.gte;
        this.max = this.lte;
    }
    _parse(input) {
        if (this._def.coerce) {
            try {
                input.data = BigInt(input.data);
            }
            catch {
                return this._getInvalidInput(input);
            }
        }
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.bigint) {
            return this._getInvalidInput(input);
        }
        let ctx = undefined;
        const status = new ParseStatus();
        for (const check of this._def.checks) {
            if (check.kind === "min") {
                const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
                if (tooSmall) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.too_small,
                        type: "bigint",
                        minimum: check.value,
                        inclusive: check.inclusive,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "max") {
                const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
                if (tooBig) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.too_big,
                        type: "bigint",
                        maximum: check.value,
                        inclusive: check.inclusive,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "multipleOf") {
                if (input.data % check.value !== BigInt(0)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.not_multiple_of,
                        multipleOf: check.value,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else {
                util.assertNever(check);
            }
        }
        return { status: status.value, value: input.data };
    }
    _getInvalidInput(input) {
        const ctx = this._getOrReturnCtx(input);
        addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: ZodParsedType.bigint,
            received: ctx.parsedType,
        });
        return INVALID;
    }
    gte(value, message) {
        return this.setLimit("min", value, true, errorUtil.toString(message));
    }
    gt(value, message) {
        return this.setLimit("min", value, false, errorUtil.toString(message));
    }
    lte(value, message) {
        return this.setLimit("max", value, true, errorUtil.toString(message));
    }
    lt(value, message) {
        return this.setLimit("max", value, false, errorUtil.toString(message));
    }
    setLimit(kind, value, inclusive, message) {
        return new ZodBigInt({
            ...this._def,
            checks: [
                ...this._def.checks,
                {
                    kind,
                    value,
                    inclusive,
                    message: errorUtil.toString(message),
                },
            ],
        });
    }
    _addCheck(check) {
        return new ZodBigInt({
            ...this._def,
            checks: [...this._def.checks, check],
        });
    }
    positive(message) {
        return this._addCheck({
            kind: "min",
            value: BigInt(0),
            inclusive: false,
            message: errorUtil.toString(message),
        });
    }
    negative(message) {
        return this._addCheck({
            kind: "max",
            value: BigInt(0),
            inclusive: false,
            message: errorUtil.toString(message),
        });
    }
    nonpositive(message) {
        return this._addCheck({
            kind: "max",
            value: BigInt(0),
            inclusive: true,
            message: errorUtil.toString(message),
        });
    }
    nonnegative(message) {
        return this._addCheck({
            kind: "min",
            value: BigInt(0),
            inclusive: true,
            message: errorUtil.toString(message),
        });
    }
    multipleOf(value, message) {
        return this._addCheck({
            kind: "multipleOf",
            value,
            message: errorUtil.toString(message),
        });
    }
    get minValue() {
        let min = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "min") {
                if (min === null || ch.value > min)
                    min = ch.value;
            }
        }
        return min;
    }
    get maxValue() {
        let max = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "max") {
                if (max === null || ch.value < max)
                    max = ch.value;
            }
        }
        return max;
    }
}
ZodBigInt.create = (params) => {
    return new ZodBigInt({
        checks: [],
        typeName: ZodFirstPartyTypeKind.ZodBigInt,
        coerce: params?.coerce ?? false,
        ...processCreateParams(params),
    });
};
class ZodBoolean extends ZodType {
    _parse(input) {
        if (this._def.coerce) {
            input.data = Boolean(input.data);
        }
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.boolean) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.boolean,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        return OK(input.data);
    }
}
ZodBoolean.create = (params) => {
    return new ZodBoolean({
        typeName: ZodFirstPartyTypeKind.ZodBoolean,
        coerce: params?.coerce || false,
        ...processCreateParams(params),
    });
};
class ZodDate extends ZodType {
    _parse(input) {
        if (this._def.coerce) {
            input.data = new Date(input.data);
        }
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.date) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.date,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        if (Number.isNaN(input.data.getTime())) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_date,
            });
            return INVALID;
        }
        const status = new ParseStatus();
        let ctx = undefined;
        for (const check of this._def.checks) {
            if (check.kind === "min") {
                if (input.data.getTime() < check.value) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.too_small,
                        message: check.message,
                        inclusive: true,
                        exact: false,
                        minimum: check.value,
                        type: "date",
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "max") {
                if (input.data.getTime() > check.value) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.too_big,
                        message: check.message,
                        inclusive: true,
                        exact: false,
                        maximum: check.value,
                        type: "date",
                    });
                    status.dirty();
                }
            }
            else {
                util.assertNever(check);
            }
        }
        return {
            status: status.value,
            value: new Date(input.data.getTime()),
        };
    }
    _addCheck(check) {
        return new ZodDate({
            ...this._def,
            checks: [...this._def.checks, check],
        });
    }
    min(minDate, message) {
        return this._addCheck({
            kind: "min",
            value: minDate.getTime(),
            message: errorUtil.toString(message),
        });
    }
    max(maxDate, message) {
        return this._addCheck({
            kind: "max",
            value: maxDate.getTime(),
            message: errorUtil.toString(message),
        });
    }
    get minDate() {
        let min = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "min") {
                if (min === null || ch.value > min)
                    min = ch.value;
            }
        }
        return min != null ? new Date(min) : null;
    }
    get maxDate() {
        let max = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "max") {
                if (max === null || ch.value < max)
                    max = ch.value;
            }
        }
        return max != null ? new Date(max) : null;
    }
}
ZodDate.create = (params) => {
    return new ZodDate({
        checks: [],
        coerce: params?.coerce || false,
        typeName: ZodFirstPartyTypeKind.ZodDate,
        ...processCreateParams(params),
    });
};
class ZodSymbol extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.symbol) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.symbol,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        return OK(input.data);
    }
}
ZodSymbol.create = (params) => {
    return new ZodSymbol({
        typeName: ZodFirstPartyTypeKind.ZodSymbol,
        ...processCreateParams(params),
    });
};
class ZodUndefined extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.undefined) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.undefined,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        return OK(input.data);
    }
}
ZodUndefined.create = (params) => {
    return new ZodUndefined({
        typeName: ZodFirstPartyTypeKind.ZodUndefined,
        ...processCreateParams(params),
    });
};
class ZodNull extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.null) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.null,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        return OK(input.data);
    }
}
ZodNull.create = (params) => {
    return new ZodNull({
        typeName: ZodFirstPartyTypeKind.ZodNull,
        ...processCreateParams(params),
    });
};
class ZodAny extends ZodType {
    constructor() {
        super(...arguments);
        // to prevent instances of other classes from extending ZodAny. this causes issues with catchall in ZodObject.
        this._any = true;
    }
    _parse(input) {
        return OK(input.data);
    }
}
ZodAny.create = (params) => {
    return new ZodAny({
        typeName: ZodFirstPartyTypeKind.ZodAny,
        ...processCreateParams(params),
    });
};
class ZodUnknown extends ZodType {
    constructor() {
        super(...arguments);
        // required
        this._unknown = true;
    }
    _parse(input) {
        return OK(input.data);
    }
}
ZodUnknown.create = (params) => {
    return new ZodUnknown({
        typeName: ZodFirstPartyTypeKind.ZodUnknown,
        ...processCreateParams(params),
    });
};
class ZodNever extends ZodType {
    _parse(input) {
        const ctx = this._getOrReturnCtx(input);
        addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: ZodParsedType.never,
            received: ctx.parsedType,
        });
        return INVALID;
    }
}
ZodNever.create = (params) => {
    return new ZodNever({
        typeName: ZodFirstPartyTypeKind.ZodNever,
        ...processCreateParams(params),
    });
};
class ZodVoid extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.undefined) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.void,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        return OK(input.data);
    }
}
ZodVoid.create = (params) => {
    return new ZodVoid({
        typeName: ZodFirstPartyTypeKind.ZodVoid,
        ...processCreateParams(params),
    });
};
class ZodArray extends ZodType {
    _parse(input) {
        const { ctx, status } = this._processInputParams(input);
        const def = this._def;
        if (ctx.parsedType !== ZodParsedType.array) {
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.array,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        if (def.exactLength !== null) {
            const tooBig = ctx.data.length > def.exactLength.value;
            const tooSmall = ctx.data.length < def.exactLength.value;
            if (tooBig || tooSmall) {
                addIssueToContext(ctx, {
                    code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
                    minimum: (tooSmall ? def.exactLength.value : undefined),
                    maximum: (tooBig ? def.exactLength.value : undefined),
                    type: "array",
                    inclusive: true,
                    exact: true,
                    message: def.exactLength.message,
                });
                if (tooBig) return INVALID;
                status.dirty();
            }
        }
        if (def.minLength !== null) {
            if (ctx.data.length < def.minLength.value) {
                addIssueToContext(ctx, {
                    code: ZodIssueCode.too_small,
                    minimum: def.minLength.value,
                    type: "array",
                    inclusive: true,
                    exact: false,
                    message: def.minLength.message,
                });
                status.dirty();
            }
        }
        if (def.maxLength !== null) {
            if (ctx.data.length > def.maxLength.value) {
                addIssueToContext(ctx, {
                    code: ZodIssueCode.too_big,
                    maximum: def.maxLength.value,
                    type: "array",
                    inclusive: true,
                    exact: false,
                    message: def.maxLength.message,
                });
                return INVALID;
            }
        }
        if (ctx.common.async) {
            return Promise.all([...ctx.data].map((item, i) => {
                return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
            })).then((result) => {
                return ParseStatus.mergeArray(status, result);
            });
        }
        const result = [...ctx.data].map((item, i) => {
            return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
        });
        return ParseStatus.mergeArray(status, result);
    }
    get element() {
        return this._def.type;
    }
    min(minLength, message) {
        return new ZodArray({
            ...this._def,
            minLength: { value: minLength, message: errorUtil.toString(message) },
        });
    }
    max(maxLength, message) {
        return new ZodArray({
            ...this._def,
            maxLength: { value: maxLength, message: errorUtil.toString(message) },
        });
    }
    length(len, message) {
        return new ZodArray({
            ...this._def,
            exactLength: { value: len, message: errorUtil.toString(message) },
        });
    }
    nonempty(message) {
        return this.min(1, message);
    }
}
ZodArray.create = (schema, params) => {
    return new ZodArray({
        type: schema,
        minLength: null,
        maxLength: null,
        exactLength: null,
        typeName: ZodFirstPartyTypeKind.ZodArray,
        ...processCreateParams(params),
    });
};
function deepPartialify(schema) {
    if (schema instanceof ZodObject) {
        const newShape = {};
        for (const key in schema.shape) {
            const fieldSchema = schema.shape[key];
            newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
        }
        return new ZodObject({
            ...schema._def,
            shape: () => newShape,
        });
    }
    else if (schema instanceof ZodArray) {
        return new ZodArray({
            ...schema._def,
            type: deepPartialify(schema.element),
        });
    }
    else if (schema instanceof ZodOptional) {
        return ZodOptional.create(deepPartialify(schema.unwrap()));
    }
    else if (schema instanceof ZodNullable) {
        return ZodNullable.create(deepPartialify(schema.unwrap()));
    }
    else if (schema instanceof ZodTuple) {
        return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
    }
    else {
        return schema;
    }
}
class ZodObject extends ZodType {
    constructor() {
        super(...arguments);
        this._cached = null;
        /**
         * @deprecated In most cases, this is no longer needed - unknown properties are now silently stripped.
         * If you want to pass through unknown properties, use `.passthrough()` instead.
         */
        this.nonstrict = this.passthrough;
        // extend<
        //   Augmentation extends ZodRawShape,
        //   NewOutput extends util.flatten<{
        //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
        //       ? Augmentation[k]["_output"]
        //       : k extends keyof Output
        //       ? Output[k]
        //       : never;
        //   }>,
        //   NewInput extends util.flatten<{
        //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
        //       ? Augmentation[k]["_input"]
        //       : k extends keyof Input
        //       ? Input[k]
        //       : never;
        //   }>
        // >(
        //   augmentation: Augmentation
        // ): ZodObject<
        //   extendShape<T, Augmentation>,
        //   UnknownKeys,
        //   Catchall,
        //   NewOutput,
        //   NewInput
        // > {
        //   return new ZodObject({
        //     ...this._def,
        //     shape: () => ({
        //       ...this._def.shape(),
        //       ...augmentation,
        //     }),
        //   }) as any;
        // }
        /**
         * @deprecated Use `.extend` instead
         *  */
        this.augment = this.extend;
    }
    _getCached() {
        if (this._cached !== null)
            return this._cached;
        const shape = this._def.shape();
        const keys = util.objectKeys(shape);
        this._cached = { shape, keys };
        return this._cached;
    }
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.object) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.object,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        const { status, ctx } = this._processInputParams(input);
        const { shape, keys: shapeKeys } = this._getCached();
        const extraKeys = [];
        if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
            for (const key in ctx.data) {
                if (!shapeKeys.includes(key)) {
                    extraKeys.push(key);
                }
            }
        }
        const pairs = [];
        for (const key of shapeKeys) {
            const keyValidator = shape[key];
            const value = ctx.data[key];
            pairs.push({
                key: { status: "valid", value: key },
                value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
                alwaysSet: key in ctx.data,
            });
        }
        if (this._def.catchall instanceof ZodNever) {
            const unknownKeys = this._def.unknownKeys;
            if (unknownKeys === "passthrough") {
                for (const key of extraKeys) {
                    pairs.push({
                        key: { status: "valid", value: key },
                        value: { status: "valid", value: ctx.data[key] },
                    });
                }
            }
            else if (unknownKeys === "strict") {
                if (extraKeys.length > 0) {
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.unrecognized_keys,
                        keys: extraKeys,
                    });
                    status.dirty();
                }
            }
            else if (unknownKeys === "strip") ;
            else {
                throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
            }
        }
        else {
            // run catchall validation
            const catchall = this._def.catchall;
            for (const key of extraKeys) {
                const value = ctx.data[key];
                pairs.push({
                    key: { status: "valid", value: key },
                    value: catchall._parse(new ParseInputLazyPath(ctx, value, ctx.path, key) //, ctx.child(key), value, getParsedType(value)
                    ),
                    alwaysSet: key in ctx.data,
                });
            }
        }
        if (ctx.common.async) {
            return Promise.resolve()
                .then(async () => {
                const syncPairs = [];
                for (const pair of pairs) {
                    const key = await pair.key;
                    const value = await pair.value;
                    syncPairs.push({
                        key,
                        value,
                        alwaysSet: pair.alwaysSet,
                    });
                }
                return syncPairs;
            })
                .then((syncPairs) => {
                return ParseStatus.mergeObjectSync(status, syncPairs);
            });
        }
        else {
            return ParseStatus.mergeObjectSync(status, pairs);
        }
    }
    get shape() {
        return this._def.shape();
    }
    strict(message) {
        errorUtil.errToObj;
        return new ZodObject({
            ...this._def,
            unknownKeys: "strict",
            ...(message !== undefined
                ? {
                    errorMap: (issue, ctx) => {
                        const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
                        if (issue.code === "unrecognized_keys")
                            return {
                                message: errorUtil.errToObj(message).message ?? defaultError,
                            };
                        return {
                            message: defaultError,
                        };
                    },
                }
                : {}),
        });
    }
    strip() {
        return new ZodObject({
            ...this._def,
            unknownKeys: "strip",
        });
    }
    passthrough() {
        return new ZodObject({
            ...this._def,
            unknownKeys: "passthrough",
        });
    }
    // const AugmentFactory =
    //   <Def extends ZodObjectDef>(def: Def) =>
    //   <Augmentation extends ZodRawShape>(
    //     augmentation: Augmentation
    //   ): ZodObject<
    //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
    //     Def["unknownKeys"],
    //     Def["catchall"]
    //   > => {
    //     return new ZodObject({
    //       ...def,
    //       shape: () => ({
    //         ...def.shape(),
    //         ...augmentation,
    //       }),
    //     }) as any;
    //   };
    extend(augmentation) {
        return new ZodObject({
            ...this._def,
            shape: () => ({
                ...this._def.shape(),
                ...augmentation,
            }),
        });
    }
    /**
     * Prior to zod@1.0.12 there was a bug in the
     * inferred type of merged objects. Please
     * upgrade if you are experiencing issues.
     */
    merge(merging) {
        const merged = new ZodObject({
            unknownKeys: merging._def.unknownKeys,
            catchall: merging._def.catchall,
            shape: () => ({
                ...this._def.shape(),
                ...merging._def.shape(),
            }),
            typeName: ZodFirstPartyTypeKind.ZodObject,
        });
        return merged;
    }
    // merge<
    //   Incoming extends AnyZodObject,
    //   Augmentation extends Incoming["shape"],
    //   NewOutput extends {
    //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
    //       ? Augmentation[k]["_output"]
    //       : k extends keyof Output
    //       ? Output[k]
    //       : never;
    //   },
    //   NewInput extends {
    //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
    //       ? Augmentation[k]["_input"]
    //       : k extends keyof Input
    //       ? Input[k]
    //       : never;
    //   }
    // >(
    //   merging: Incoming
    // ): ZodObject<
    //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
    //   Incoming["_def"]["unknownKeys"],
    //   Incoming["_def"]["catchall"],
    //   NewOutput,
    //   NewInput
    // > {
    //   const merged: any = new ZodObject({
    //     unknownKeys: merging._def.unknownKeys,
    //     catchall: merging._def.catchall,
    //     shape: () =>
    //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
    //     typeName: ZodFirstPartyTypeKind.ZodObject,
    //   }) as any;
    //   return merged;
    // }
    setKey(key, schema) {
        return this.augment({ [key]: schema });
    }
    // merge<Incoming extends AnyZodObject>(
    //   merging: Incoming
    // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
    // ZodObject<
    //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
    //   Incoming["_def"]["unknownKeys"],
    //   Incoming["_def"]["catchall"]
    // > {
    //   // const mergedShape = objectUtil.mergeShapes(
    //   //   this._def.shape(),
    //   //   merging._def.shape()
    //   // );
    //   const merged: any = new ZodObject({
    //     unknownKeys: merging._def.unknownKeys,
    //     catchall: merging._def.catchall,
    //     shape: () =>
    //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
    //     typeName: ZodFirstPartyTypeKind.ZodObject,
    //   }) as any;
    //   return merged;
    // }
    catchall(index) {
        return new ZodObject({
            ...this._def,
            catchall: index,
        });
    }
    pick(mask) {
        const shape = {};
        for (const key of util.objectKeys(mask)) {
            if (mask[key] && this.shape[key]) {
                shape[key] = this.shape[key];
            }
        }
        return new ZodObject({
            ...this._def,
            shape: () => shape,
        });
    }
    omit(mask) {
        const shape = {};
        for (const key of util.objectKeys(this.shape)) {
            if (!mask[key]) {
                shape[key] = this.shape[key];
            }
        }
        return new ZodObject({
            ...this._def,
            shape: () => shape,
        });
    }
    /**
     * @deprecated
     */
    deepPartial() {
        return deepPartialify(this);
    }
    partial(mask) {
        const newShape = {};
        for (const key of util.objectKeys(this.shape)) {
            const fieldSchema = this.shape[key];
            if (mask && !mask[key]) {
                newShape[key] = fieldSchema;
            }
            else {
                newShape[key] = fieldSchema.optional();
            }
        }
        return new ZodObject({
            ...this._def,
            shape: () => newShape,
        });
    }
    required(mask) {
        const newShape = {};
        for (const key of util.objectKeys(this.shape)) {
            if (mask && !mask[key]) {
                newShape[key] = this.shape[key];
            }
            else {
                const fieldSchema = this.shape[key];
                let newField = fieldSchema;
                while (newField instanceof ZodOptional) {
                    newField = newField._def.innerType;
                }
                newShape[key] = newField;
            }
        }
        return new ZodObject({
            ...this._def,
            shape: () => newShape,
        });
    }
    keyof() {
        return createZodEnum(util.objectKeys(this.shape));
    }
}
ZodObject.create = (shape, params) => {
    return new ZodObject({
        shape: () => shape,
        unknownKeys: "strip",
        catchall: ZodNever.create(),
        typeName: ZodFirstPartyTypeKind.ZodObject,
        ...processCreateParams(params),
    });
};
ZodObject.strictCreate = (shape, params) => {
    return new ZodObject({
        shape: () => shape,
        unknownKeys: "strict",
        catchall: ZodNever.create(),
        typeName: ZodFirstPartyTypeKind.ZodObject,
        ...processCreateParams(params),
    });
};
ZodObject.lazycreate = (shape, params) => {
    return new ZodObject({
        shape,
        unknownKeys: "strip",
        catchall: ZodNever.create(),
        typeName: ZodFirstPartyTypeKind.ZodObject,
        ...processCreateParams(params),
    });
};
class ZodUnion extends ZodType {
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        const options = this._def.options;
        function handleResults(results) {
            // return first issue-free validation if it exists
            for (const result of results) {
                if (result.result.status === "valid") {
                    return result.result;
                }
            }
            for (const result of results) {
                if (result.result.status === "dirty") {
                    // add issues from dirty option
                    ctx.common.issues.push(...result.ctx.common.issues);
                    return result.result;
                }
            }
            // return invalid
            const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_union,
                unionErrors,
            });
            return INVALID;
        }
        if (ctx.common.async) {
            return Promise.all(options.map(async (option) => {
                const childCtx = {
                    ...ctx,
                    common: {
                        ...ctx.common,
                        issues: [],
                    },
                    parent: null,
                };
                return {
                    result: await option._parseAsync({
                        data: ctx.data,
                        path: ctx.path,
                        parent: childCtx,
                    }),
                    ctx: childCtx,
                };
            })).then(handleResults);
        }
        else {
            let dirty = undefined;
            const issues = [];
            for (const option of options) {
                const childCtx = {
                    ...ctx,
                    common: {
                        ...ctx.common,
                        issues: [],
                    },
                    parent: null,
                };
                const result = option._parseSync({
                    data: ctx.data,
                    path: ctx.path,
                    parent: childCtx,
                });
                if (result.status === "valid") {
                    return result;
                }
                else if (result.status === "dirty" && !dirty) {
                    dirty = { result, ctx: childCtx };
                }
                if (childCtx.common.issues.length) {
                    issues.push(childCtx.common.issues);
                }
            }
            if (dirty) {
                ctx.common.issues.push(...dirty.ctx.common.issues);
                return dirty.result;
            }
            const unionErrors = issues.map((issues) => new ZodError(issues));
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_union,
                unionErrors,
            });
            return INVALID;
        }
    }
    get options() {
        return this._def.options;
    }
}
ZodUnion.create = (types, params) => {
    return new ZodUnion({
        options: types,
        typeName: ZodFirstPartyTypeKind.ZodUnion,
        ...processCreateParams(params),
    });
};
function mergeValues(a, b) {
    const aType = getParsedType(a);
    const bType = getParsedType(b);
    if (a === b) {
        return { valid: true, data: a };
    }
    else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
        const bKeys = util.objectKeys(b);
        const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
        const newObj = { ...a, ...b };
        for (const key of sharedKeys) {
            const sharedValue = mergeValues(a[key], b[key]);
            if (!sharedValue.valid) {
                return { valid: false };
            }
            newObj[key] = sharedValue.data;
        }
        return { valid: true, data: newObj };
    }
    else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
        if (a.length !== b.length) {
            return { valid: false };
        }
        const newArray = [];
        for (let index = 0; index < a.length; index++) {
            const itemA = a[index];
            const itemB = b[index];
            const sharedValue = mergeValues(itemA, itemB);
            if (!sharedValue.valid) {
                return { valid: false };
            }
            newArray.push(sharedValue.data);
        }
        return { valid: true, data: newArray };
    }
    else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
        return { valid: true, data: a };
    }
    else {
        return { valid: false };
    }
}
class ZodIntersection extends ZodType {
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        const handleParsed = (parsedLeft, parsedRight) => {
            if (isAborted(parsedLeft) || isAborted(parsedRight)) {
                return INVALID;
            }
            const merged = mergeValues(parsedLeft.value, parsedRight.value);
            if (!merged.valid) {
                addIssueToContext(ctx, {
                    code: ZodIssueCode.invalid_intersection_types,
                });
                return INVALID;
            }
            if (isDirty(parsedLeft) || isDirty(parsedRight)) {
                status.dirty();
            }
            return { status: status.value, value: merged.data };
        };
        if (ctx.common.async) {
            return Promise.all([
                this._def.left._parseAsync({
                    data: ctx.data,
                    path: ctx.path,
                    parent: ctx,
                }),
                this._def.right._parseAsync({
                    data: ctx.data,
                    path: ctx.path,
                    parent: ctx,
                }),
            ]).then(([left, right]) => handleParsed(left, right));
        }
        else {
            return handleParsed(this._def.left._parseSync({
                data: ctx.data,
                path: ctx.path,
                parent: ctx,
            }), this._def.right._parseSync({
                data: ctx.data,
                path: ctx.path,
                parent: ctx,
            }));
        }
    }
}
ZodIntersection.create = (left, right, params) => {
    return new ZodIntersection({
        left: left,
        right: right,
        typeName: ZodFirstPartyTypeKind.ZodIntersection,
        ...processCreateParams(params),
    });
};
// type ZodTupleItems = [ZodTypeAny, ...ZodTypeAny[]];
class ZodTuple extends ZodType {
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType.array) {
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.array,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        if (ctx.data.length < this._def.items.length) {
            addIssueToContext(ctx, {
                code: ZodIssueCode.too_small,
                minimum: this._def.items.length,
                inclusive: true,
                exact: false,
                type: "array",
            });
            return INVALID;
        }
        const rest = this._def.rest;
        if (!rest && ctx.data.length > this._def.items.length) {
            addIssueToContext(ctx, {
                code: ZodIssueCode.too_big,
                maximum: this._def.items.length,
                inclusive: true,
                exact: false,
                type: "array",
            });
            status.dirty();
        }
        const items = [...ctx.data]
            .map((item, itemIndex) => {
            const schema = this._def.items[itemIndex] || this._def.rest;
            if (!schema)
                return null;
            return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
        })
            .filter((x) => !!x); // filter nulls
        if (ctx.common.async) {
            return Promise.all(items).then((results) => {
                return ParseStatus.mergeArray(status, results);
            });
        }
        else {
            return ParseStatus.mergeArray(status, items);
        }
    }
    get items() {
        return this._def.items;
    }
    rest(rest) {
        return new ZodTuple({
            ...this._def,
            rest,
        });
    }
}
ZodTuple.create = (schemas, params) => {
    if (!Array.isArray(schemas)) {
        throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
    }
    return new ZodTuple({
        items: schemas,
        typeName: ZodFirstPartyTypeKind.ZodTuple,
        rest: null,
        ...processCreateParams(params),
    });
};
class ZodRecord extends ZodType {
    get keySchema() {
        return this._def.keyType;
    }
    get valueSchema() {
        return this._def.valueType;
    }
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType.object) {
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.object,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        const pairs = [];
        const keyType = this._def.keyType;
        const valueType = this._def.valueType;
        for (const key in ctx.data) {
            pairs.push({
                key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
                value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
                alwaysSet: key in ctx.data,
            });
        }
        if (ctx.common.async) {
            return ParseStatus.mergeObjectAsync(status, pairs);
        }
        else {
            return ParseStatus.mergeObjectSync(status, pairs);
        }
    }
    get element() {
        return this._def.valueType;
    }
    static create(first, second, third) {
        if (second instanceof ZodType) {
            return new ZodRecord({
                keyType: first,
                valueType: second,
                typeName: ZodFirstPartyTypeKind.ZodRecord,
                ...processCreateParams(third),
            });
        }
        return new ZodRecord({
            keyType: ZodString.create(),
            valueType: first,
            typeName: ZodFirstPartyTypeKind.ZodRecord,
            ...processCreateParams(second),
        });
    }
}
class ZodMap extends ZodType {
    get keySchema() {
        return this._def.keyType;
    }
    get valueSchema() {
        return this._def.valueType;
    }
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType.map) {
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.map,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        const keyType = this._def.keyType;
        const valueType = this._def.valueType;
        const pairs = [...ctx.data.entries()].map(([key, value], index) => {
            return {
                key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
                value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"])),
            };
        });
        if (ctx.common.async) {
            const finalMap = new Map();
            return Promise.resolve().then(async () => {
                for (const pair of pairs) {
                    const key = await pair.key;
                    const value = await pair.value;
                    if (key.status === "aborted" || value.status === "aborted") {
                        return INVALID;
                    }
                    if (key.status === "dirty" || value.status === "dirty") {
                        status.dirty();
                    }
                    finalMap.set(key.value, value.value);
                }
                return { status: status.value, value: finalMap };
            });
        }
        else {
            const finalMap = new Map();
            for (const pair of pairs) {
                const key = pair.key;
                const value = pair.value;
                if (key.status === "aborted" || value.status === "aborted") {
                    return INVALID;
                }
                if (key.status === "dirty" || value.status === "dirty") {
                    status.dirty();
                }
                finalMap.set(key.value, value.value);
            }
            return { status: status.value, value: finalMap };
        }
    }
}
ZodMap.create = (keyType, valueType, params) => {
    return new ZodMap({
        valueType,
        keyType,
        typeName: ZodFirstPartyTypeKind.ZodMap,
        ...processCreateParams(params),
    });
};
class ZodSet extends ZodType {
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType.set) {
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.set,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        const def = this._def;
        if (def.minSize !== null) {
            if (ctx.data.size < def.minSize.value) {
                addIssueToContext(ctx, {
                    code: ZodIssueCode.too_small,
                    minimum: def.minSize.value,
                    type: "set",
                    inclusive: true,
                    exact: false,
                    message: def.minSize.message,
                });
                status.dirty();
            }
        }
        if (def.maxSize !== null) {
            if (ctx.data.size > def.maxSize.value) {
                addIssueToContext(ctx, {
                    code: ZodIssueCode.too_big,
                    maximum: def.maxSize.value,
                    type: "set",
                    inclusive: true,
                    exact: false,
                    message: def.maxSize.message,
                });
                return INVALID;
            }
        }
        const valueType = this._def.valueType;
        function finalizeSet(elements) {
            const parsedSet = new Set();
            for (const element of elements) {
                if (element.status === "aborted")
                    return INVALID;
                if (element.status === "dirty")
                    status.dirty();
                parsedSet.add(element.value);
            }
            return { status: status.value, value: parsedSet };
        }
        const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
        if (ctx.common.async) {
            return Promise.all(elements).then((elements) => finalizeSet(elements));
        }
        else {
            return finalizeSet(elements);
        }
    }
    min(minSize, message) {
        return new ZodSet({
            ...this._def,
            minSize: { value: minSize, message: errorUtil.toString(message) },
        });
    }
    max(maxSize, message) {
        return new ZodSet({
            ...this._def,
            maxSize: { value: maxSize, message: errorUtil.toString(message) },
        });
    }
    size(size, message) {
        return this.min(size, message).max(size, message);
    }
    nonempty(message) {
        return this.min(1, message);
    }
}
ZodSet.create = (valueType, params) => {
    return new ZodSet({
        valueType,
        minSize: null,
        maxSize: null,
        typeName: ZodFirstPartyTypeKind.ZodSet,
        ...processCreateParams(params),
    });
};
class ZodLazy extends ZodType {
    get schema() {
        return this._def.getter();
    }
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        const lazySchema = this._def.getter();
        return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
    }
}
ZodLazy.create = (getter, params) => {
    return new ZodLazy({
        getter: getter,
        typeName: ZodFirstPartyTypeKind.ZodLazy,
        ...processCreateParams(params),
    });
};
class ZodLiteral extends ZodType {
    _parse(input) {
        if (input.data !== this._def.value) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                received: ctx.data,
                code: ZodIssueCode.invalid_literal,
                expected: this._def.value,
            });
            return INVALID;
        }
        return { status: "valid", value: input.data };
    }
    get value() {
        return this._def.value;
    }
}
ZodLiteral.create = (value, params) => {
    return new ZodLiteral({
        value: value,
        typeName: ZodFirstPartyTypeKind.ZodLiteral,
        ...processCreateParams(params),
    });
};
function createZodEnum(values, params) {
    return new ZodEnum({
        values,
        typeName: ZodFirstPartyTypeKind.ZodEnum,
        ...processCreateParams(params),
    });
}
class ZodEnum extends ZodType {
    _parse(input) {
        if (typeof input.data !== "string") {
            const ctx = this._getOrReturnCtx(input);
            const expectedValues = this._def.values;
            addIssueToContext(ctx, {
                expected: util.joinValues(expectedValues),
                received: ctx.parsedType,
                code: ZodIssueCode.invalid_type,
            });
            return INVALID;
        }
        if (!this._cache) {
            this._cache = new Set(this._def.values);
        }
        if (!this._cache.has(input.data)) {
            const ctx = this._getOrReturnCtx(input);
            const expectedValues = this._def.values;
            addIssueToContext(ctx, {
                received: ctx.data,
                code: ZodIssueCode.invalid_enum_value,
                options: expectedValues,
            });
            return INVALID;
        }
        return OK(input.data);
    }
    get options() {
        return this._def.values;
    }
    get enum() {
        const enumValues = {};
        for (const val of this._def.values) {
            enumValues[val] = val;
        }
        return enumValues;
    }
    get Values() {
        const enumValues = {};
        for (const val of this._def.values) {
            enumValues[val] = val;
        }
        return enumValues;
    }
    get Enum() {
        const enumValues = {};
        for (const val of this._def.values) {
            enumValues[val] = val;
        }
        return enumValues;
    }
    extract(values, newDef = this._def) {
        return ZodEnum.create(values, {
            ...this._def,
            ...newDef,
        });
    }
    exclude(values, newDef = this._def) {
        return ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
            ...this._def,
            ...newDef,
        });
    }
}
ZodEnum.create = createZodEnum;
class ZodNativeEnum extends ZodType {
    _parse(input) {
        const nativeEnumValues = util.getValidEnumValues(this._def.values);
        const ctx = this._getOrReturnCtx(input);
        if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
            const expectedValues = util.objectValues(nativeEnumValues);
            addIssueToContext(ctx, {
                expected: util.joinValues(expectedValues),
                received: ctx.parsedType,
                code: ZodIssueCode.invalid_type,
            });
            return INVALID;
        }
        if (!this._cache) {
            this._cache = new Set(util.getValidEnumValues(this._def.values));
        }
        if (!this._cache.has(input.data)) {
            const expectedValues = util.objectValues(nativeEnumValues);
            addIssueToContext(ctx, {
                received: ctx.data,
                code: ZodIssueCode.invalid_enum_value,
                options: expectedValues,
            });
            return INVALID;
        }
        return OK(input.data);
    }
    get enum() {
        return this._def.values;
    }
}
ZodNativeEnum.create = (values, params) => {
    return new ZodNativeEnum({
        values: values,
        typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
        ...processCreateParams(params),
    });
};
class ZodPromise extends ZodType {
    unwrap() {
        return this._def.type;
    }
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.promise,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
        return OK(promisified.then((data) => {
            return this._def.type.parseAsync(data, {
                path: ctx.path,
                errorMap: ctx.common.contextualErrorMap,
            });
        }));
    }
}
ZodPromise.create = (schema, params) => {
    return new ZodPromise({
        type: schema,
        typeName: ZodFirstPartyTypeKind.ZodPromise,
        ...processCreateParams(params),
    });
};
class ZodEffects extends ZodType {
    innerType() {
        return this._def.schema;
    }
    sourceType() {
        return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects
            ? this._def.schema.sourceType()
            : this._def.schema;
    }
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        const effect = this._def.effect || null;
        const checkCtx = {
            addIssue: (arg) => {
                addIssueToContext(ctx, arg);
                if (arg.fatal) {
                    status.abort();
                }
                else {
                    status.dirty();
                }
            },
            get path() {
                return ctx.path;
            },
        };
        checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
        if (effect.type === "preprocess") {
            const processed = effect.transform(ctx.data, checkCtx);
            if (ctx.common.async) {
                return Promise.resolve(processed).then(async (processed) => {
                    if (status.value === "aborted")
                        return INVALID;
                    const result = await this._def.schema._parseAsync({
                        data: processed,
                        path: ctx.path,
                        parent: ctx,
                    });
                    if (result.status === "aborted")
                        return INVALID;
                    if (result.status === "dirty")
                        return DIRTY(result.value);
                    if (status.value === "dirty")
                        return DIRTY(result.value);
                    return result;
                });
            }
            else {
                if (status.value === "aborted")
                    return INVALID;
                const result = this._def.schema._parseSync({
                    data: processed,
                    path: ctx.path,
                    parent: ctx,
                });
                if (result.status === "aborted")
                    return INVALID;
                if (result.status === "dirty")
                    return DIRTY(result.value);
                if (status.value === "dirty")
                    return DIRTY(result.value);
                return result;
            }
        }
        if (effect.type === "refinement") {
            const executeRefinement = (acc) => {
                const result = effect.refinement(acc, checkCtx);
                if (ctx.common.async) {
                    return Promise.resolve(result);
                }
                if (result instanceof Promise) {
                    throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
                }
                return acc;
            };
            if (ctx.common.async === false) {
                const inner = this._def.schema._parseSync({
                    data: ctx.data,
                    path: ctx.path,
                    parent: ctx,
                });
                if (inner.status === "aborted")
                    return INVALID;
                if (inner.status === "dirty")
                    status.dirty();
                // return value is ignored
                executeRefinement(inner.value);
                return { status: status.value, value: inner.value };
            }
            else {
                return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
                    if (inner.status === "aborted")
                        return INVALID;
                    if (inner.status === "dirty")
                        status.dirty();
                    return executeRefinement(inner.value).then(() => {
                        return { status: status.value, value: inner.value };
                    });
                });
            }
        }
        if (effect.type === "transform") {
            if (ctx.common.async === false) {
                const base = this._def.schema._parseSync({
                    data: ctx.data,
                    path: ctx.path,
                    parent: ctx,
                });
                if (!isValid(base))
                    return INVALID;
                const result = effect.transform(base.value, checkCtx);
                if (result instanceof Promise) {
                    throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
                }
                return { status: status.value, value: result };
            }
            else {
                return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
                    if (!isValid(base))
                        return INVALID;
                    return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
                        status: status.value,
                        value: result,
                    }));
                });
            }
        }
        util.assertNever(effect);
    }
}
ZodEffects.create = (schema, effect, params) => {
    return new ZodEffects({
        schema,
        typeName: ZodFirstPartyTypeKind.ZodEffects,
        effect,
        ...processCreateParams(params),
    });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
    return new ZodEffects({
        schema,
        effect: { type: "preprocess", transform: preprocess },
        typeName: ZodFirstPartyTypeKind.ZodEffects,
        ...processCreateParams(params),
    });
};
class ZodOptional extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType === ZodParsedType.undefined) {
            return OK(undefined);
        }
        return this._def.innerType._parse(input);
    }
    unwrap() {
        return this._def.innerType;
    }
}
ZodOptional.create = (type, params) => {
    return new ZodOptional({
        innerType: type,
        typeName: ZodFirstPartyTypeKind.ZodOptional,
        ...processCreateParams(params),
    });
};
class ZodNullable extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType === ZodParsedType.null) {
            return OK(null);
        }
        return this._def.innerType._parse(input);
    }
    unwrap() {
        return this._def.innerType;
    }
}
ZodNullable.create = (type, params) => {
    return new ZodNullable({
        innerType: type,
        typeName: ZodFirstPartyTypeKind.ZodNullable,
        ...processCreateParams(params),
    });
};
class ZodDefault extends ZodType {
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        let data = ctx.data;
        if (ctx.parsedType === ZodParsedType.undefined) {
            data = this._def.defaultValue();
        }
        return this._def.innerType._parse({
            data,
            path: ctx.path,
            parent: ctx,
        });
    }
    removeDefault() {
        return this._def.innerType;
    }
}
ZodDefault.create = (type, params) => {
    return new ZodDefault({
        innerType: type,
        typeName: ZodFirstPartyTypeKind.ZodDefault,
        defaultValue: typeof params.default === "function" ? params.default : () => params.default,
        ...processCreateParams(params),
    });
};
class ZodCatch extends ZodType {
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        // newCtx is used to not collect issues from inner types in ctx
        const newCtx = {
            ...ctx,
            common: {
                ...ctx.common,
                issues: [],
            },
        };
        const result = this._def.innerType._parse({
            data: newCtx.data,
            path: newCtx.path,
            parent: {
                ...newCtx,
            },
        });
        if (isAsync(result)) {
            return result.then((result) => {
                return {
                    status: "valid",
                    value: result.status === "valid"
                        ? result.value
                        : this._def.catchValue({
                            get error() {
                                return new ZodError(newCtx.common.issues);
                            },
                            input: newCtx.data,
                        }),
                };
            });
        }
        else {
            return {
                status: "valid",
                value: result.status === "valid"
                    ? result.value
                    : this._def.catchValue({
                        get error() {
                            return new ZodError(newCtx.common.issues);
                        },
                        input: newCtx.data,
                    }),
            };
        }
    }
    removeCatch() {
        return this._def.innerType;
    }
}
ZodCatch.create = (type, params) => {
    return new ZodCatch({
        innerType: type,
        typeName: ZodFirstPartyTypeKind.ZodCatch,
        catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
        ...processCreateParams(params),
    });
};
class ZodNaN extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.nan) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.nan,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        return { status: "valid", value: input.data };
    }
}
ZodNaN.create = (params) => {
    return new ZodNaN({
        typeName: ZodFirstPartyTypeKind.ZodNaN,
        ...processCreateParams(params),
    });
};
class ZodBranded extends ZodType {
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        const data = ctx.data;
        return this._def.type._parse({
            data,
            path: ctx.path,
            parent: ctx,
        });
    }
    unwrap() {
        return this._def.type;
    }
}
class ZodPipeline extends ZodType {
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.common.async) {
            const handleAsync = async () => {
                const inResult = await this._def.in._parseAsync({
                    data: ctx.data,
                    path: ctx.path,
                    parent: ctx,
                });
                if (inResult.status === "aborted")
                    return INVALID;
                if (inResult.status === "dirty") {
                    status.dirty();
                    return DIRTY(inResult.value);
                }
                else {
                    return this._def.out._parseAsync({
                        data: inResult.value,
                        path: ctx.path,
                        parent: ctx,
                    });
                }
            };
            return handleAsync();
        }
        else {
            const inResult = this._def.in._parseSync({
                data: ctx.data,
                path: ctx.path,
                parent: ctx,
            });
            if (inResult.status === "aborted")
                return INVALID;
            if (inResult.status === "dirty") {
                status.dirty();
                return {
                    status: "dirty",
                    value: inResult.value,
                };
            }
            else {
                return this._def.out._parseSync({
                    data: inResult.value,
                    path: ctx.path,
                    parent: ctx,
                });
            }
        }
    }
    static create(a, b) {
        return new ZodPipeline({
            in: a,
            out: b,
            typeName: ZodFirstPartyTypeKind.ZodPipeline,
        });
    }
}
class ZodReadonly extends ZodType {
    _parse(input) {
        const result = this._def.innerType._parse(input);
        const freeze = (data) => {
            if (isValid(data)) {
                data.value = Object.freeze(data.value);
            }
            return data;
        };
        return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
    }
    unwrap() {
        return this._def.innerType;
    }
}
ZodReadonly.create = (type, params) => {
    return new ZodReadonly({
        innerType: type,
        typeName: ZodFirstPartyTypeKind.ZodReadonly,
        ...processCreateParams(params),
    });
};
var ZodFirstPartyTypeKind;
(function (ZodFirstPartyTypeKind) {
    ZodFirstPartyTypeKind["ZodString"] = "ZodString";
    ZodFirstPartyTypeKind["ZodNumber"] = "ZodNumber";
    ZodFirstPartyTypeKind["ZodNaN"] = "ZodNaN";
    ZodFirstPartyTypeKind["ZodBigInt"] = "ZodBigInt";
    ZodFirstPartyTypeKind["ZodBoolean"] = "ZodBoolean";
    ZodFirstPartyTypeKind["ZodDate"] = "ZodDate";
    ZodFirstPartyTypeKind["ZodSymbol"] = "ZodSymbol";
    ZodFirstPartyTypeKind["ZodUndefined"] = "ZodUndefined";
    ZodFirstPartyTypeKind["ZodNull"] = "ZodNull";
    ZodFirstPartyTypeKind["ZodAny"] = "ZodAny";
    ZodFirstPartyTypeKind["ZodUnknown"] = "ZodUnknown";
    ZodFirstPartyTypeKind["ZodNever"] = "ZodNever";
    ZodFirstPartyTypeKind["ZodVoid"] = "ZodVoid";
    ZodFirstPartyTypeKind["ZodArray"] = "ZodArray";
    ZodFirstPartyTypeKind["ZodObject"] = "ZodObject";
    ZodFirstPartyTypeKind["ZodUnion"] = "ZodUnion";
    ZodFirstPartyTypeKind["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
    ZodFirstPartyTypeKind["ZodIntersection"] = "ZodIntersection";
    ZodFirstPartyTypeKind["ZodTuple"] = "ZodTuple";
    ZodFirstPartyTypeKind["ZodRecord"] = "ZodRecord";
    ZodFirstPartyTypeKind["ZodMap"] = "ZodMap";
    ZodFirstPartyTypeKind["ZodSet"] = "ZodSet";
    ZodFirstPartyTypeKind["ZodFunction"] = "ZodFunction";
    ZodFirstPartyTypeKind["ZodLazy"] = "ZodLazy";
    ZodFirstPartyTypeKind["ZodLiteral"] = "ZodLiteral";
    ZodFirstPartyTypeKind["ZodEnum"] = "ZodEnum";
    ZodFirstPartyTypeKind["ZodEffects"] = "ZodEffects";
    ZodFirstPartyTypeKind["ZodNativeEnum"] = "ZodNativeEnum";
    ZodFirstPartyTypeKind["ZodOptional"] = "ZodOptional";
    ZodFirstPartyTypeKind["ZodNullable"] = "ZodNullable";
    ZodFirstPartyTypeKind["ZodDefault"] = "ZodDefault";
    ZodFirstPartyTypeKind["ZodCatch"] = "ZodCatch";
    ZodFirstPartyTypeKind["ZodPromise"] = "ZodPromise";
    ZodFirstPartyTypeKind["ZodBranded"] = "ZodBranded";
    ZodFirstPartyTypeKind["ZodPipeline"] = "ZodPipeline";
    ZodFirstPartyTypeKind["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
const stringType = ZodString.create;
const numberType = ZodNumber.create;
ZodBigInt.create;
const booleanType = ZodBoolean.create;
ZodDate.create;
const unknownType = ZodUnknown.create;
const neverType = ZodNever.create;
const arrayType = ZodArray.create;
const objectType = ZodObject.create;
const unionType = ZodUnion.create;
ZodIntersection.create;
ZodTuple.create;
const recordType = ZodRecord.create;
const literalType = ZodLiteral.create;
const enumType = ZodEnum.create;
ZodPromise.create;
ZodOptional.create;
ZodNullable.create;
const coerce = {
    string: ((arg) => ZodString.create({ ...arg, coerce: true })),
    number: ((arg) => ZodNumber.create({ ...arg, coerce: true })),
    boolean: ((arg) => ZodBoolean.create({
        ...arg,
        coerce: true,
    })),
    bigint: ((arg) => ZodBigInt.create({ ...arg, coerce: true })),
    date: ((arg) => ZodDate.create({ ...arg, coerce: true })),
};

function keyIdentity(key) {
  return JSON.stringify([key.namespace, key.key]);
}

const SCOPED_PUSH_PREVIEW_CAPABILITY = "scoped-push-preview-v1";
const pushPreviewSelection = objectType({
  keys: arrayType(stringType().min(1).max(1e3)).max(1e3),
  namespaces: arrayType(stringType().min(1).max(1e3)).max(1e3),
  prune: booleanType(),
  localKeys: arrayType(
    objectType({
      key: stringType().min(1),
      namespace: stringType(),
      translations: recordType(
        stringType().min(1).max(50),
        stringType().regex(/^[a-f0-9]{64}$/).nullable()
      )
    })
  ).max(25e4)
}).strict().refine(
  (input) => {
    const patterns = [...input.keys, ...input.namespaces];
    return patterns.length <= 64 && patterns.reduce((sum, pattern) => sum + pattern.length, 0) <= 4096 && patterns.every((pattern) => !/[{}]/.test(pattern));
  },
  { message: "Selection requires the complete lookup" }
).refine((input) => input.keys.length + input.namespaces.length > 0, {
  message: "A key or namespace selection is required"
}).refine(
  (input) => new Set(input.localKeys.map(keyIdentity)).size === input.localKeys.length,
  {
    message: "Local key identities must be unique"
  }
);

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

function createPushPreviewManifest(local) {
  return Object.values(local.mergedKeysByKeyByNamespace).flatMap(
    (keys) => Object.values(keys).map((key) => ({
      key: key.key,
      namespace: getNamespace$1(key),
      translations: Object.fromEntries(
        Object.entries(key.translations).map(([language, translation]) => [
          language,
          translation.local?.value == null ? null : createHash("sha256").update(translation.local.value).digest("hex")
        ])
      )
    }))
  );
}

function hasCurrentApproval(summary) {
  if (!summary) return false;
  return summary.ai.outcome === "no_issues_found" && summary.ai.freshness === "current" || summary.human.outcome === "approved" && summary.human.freshness === "current";
}

const humanReviewOutcome = enumType(["approved", "changes_requested"]);
enumType(["either", "ai", "human"]);
const reviewSubjectKind = enumType(["translation", "source_wording"]);
const QUALITY_CONTRACT_CAPABILITY = "quality-contract-v2";
objectType({
  requestId: stringType().uuid(),
  translationId: stringType().uuid(),
  expectedTargetVersionId: stringType().uuid(),
  expectedSourceVersionId: stringType().uuid().nullable(),
  expectedHeadId: stringType().uuid().nullable(),
  expectedContextGeneration: numberType().int().nonnegative(),
  expectedContextHash: stringType().length(64),
  create: objectType({ keyId: stringType().uuid(), languageId: stringType().uuid() }).optional(),
  expectedConcernIds: arrayType(stringType().uuid()).max(50),
  outcome: humanReviewOutcome,
  note: stringType().trim().max(4e3).default(""),
  translation: stringType().max(32e3).optional(),
  acknowledgedConcernIds: arrayType(stringType().uuid()).max(50).default([]),
  sourceLanguageCode: stringType().max(32).default(""),
  subjectKind: reviewSubjectKind.default("translation")
}).strict();
objectType({
  requestId: stringType().uuid(),
  questionId: stringType().uuid(),
  text: stringType().trim().min(1).max(4e3),
  scope: enumType(["key_language", "project", "recheck"]),
  recheckResultId: stringType().uuid().optional(),
  keyId: stringType().uuid().nullable(),
  languageCode: stringType().max(32).nullable()
}).strict();
objectType({
  requestId: stringType().uuid(),
  reason: stringType().trim().max(2e3).default(""),
  translationIds: arrayType(stringType().uuid()).min(1).max(500),
  sourceLanguageCode: stringType().min(1).max(32).optional()
}).strict();
objectType({
  requestId: stringType().uuid(),
  sourceLanguageCode: stringType().min(1).max(32).optional(),
  action: enumType(["save_only", "request_review", "mark_stale"]),
  scope: enumType(["listed", "project"]).default("listed"),
  translationIds: arrayType(stringType().uuid()).max(500).default([]),
  keyIds: arrayType(stringType().uuid()).max(200).default([]),
  reviewKinds: arrayType(enumType(["ai", "human"])).min(1),
  reason: stringType().trim().max(2e3).default("")
}).strict();

var __defProp$2 = Object.defineProperty;
var __defNormalProp$2 = (obj, key, value) => key in obj ? __defProp$2(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField$2 = (obj, key, value) => __defNormalProp$2(obj, typeof key !== "symbol" ? key + "" : key, value);
class CliRequestError extends Error {
  constructor(input) {
    super(input.message, { cause: input.cause });
    __publicField$2(this, "code");
    __publicField$2(this, "httpStatus");
    __publicField$2(this, "details");
    this.name = "CliRequestError";
    this.code = input.code;
    this.httpStatus = input.httpStatus;
    this.details = input.details;
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

const errorBodySchema = objectType({
  error: unionType([
    stringType(),
    objectType({
      code: stringType().optional(),
      message: stringType(),
      details: unknownType().optional()
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
      httpStatus: response.status,
      details: typeof error === "string" ? void 0 : error.details
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
      response = await fetch(url, withReviewCapability(init));
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
function withReviewCapability(init) {
  const headers = new Headers(init.headers);
  const existing = headers.get("x-babli-client-capabilities");
  const values = new Set(
    (existing ?? "").split(",").map((item) => item.trim()).filter(Boolean)
  );
  values.add(QUALITY_CONTRACT_CAPABILITY);
  headers.set("x-babli-client-capabilities", [...values].join(", "));
  return { ...init, headers };
}
function sleep$1(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
async function getCliProject(host, projectId, accessToken) {
  return fetchCliJson(`${host}/api/cli/${projectId}/project`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
}
async function requestTranslation(host, projectId, accessToken, keys, model = "production", maxCreditUnits, quality) {
  return requestCliJson(
    `${host}/api/cli/${projectId}/translate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        keys,
        model,
        maxCreditUnits,
        ...qualityFields(quality)
      })
    }
  );
}
async function estimateTranslation(host, projectId, accessToken, keys, model = "production", quality) {
  return requestCliJson(
    `${host}/api/cli/${projectId}/estimate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ keys, model, ...qualityFields(quality) })
    }
  );
}
function qualityFields(quality) {
  return {
    ...quality?.primaryLanguage ? { primaryLanguage: quality.primaryLanguage } : {},
    ...quality?.referenceMode ? { referenceMode: quality.referenceMode } : {},
    ...quality?.replaceExisting ? { replaceExisting: true } : {},
    ...quality?.allowUnapprovedSources ? { allowUnapprovedSources: true } : {}
  };
}
async function fetchJobStatus(host, projectId, accessToken, jobId) {
  const result = await requestCliJson(`${host}/api/cli/${projectId}/job/${jobId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  return { ...result, failures: result.failures ?? [] };
}
async function fetchQuestions(host, projectId, accessToken, scope) {
  const json = await requestCliJson(
    `${host}/api/cli/${projectId}/questions${scope ? `?scope=${encodeURIComponent(JSON.stringify(scope))}` : ""}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` }
    }
  );
  if (scope && json.scopeVersion !== 1)
    throw new CliRequestError({
      code: "unsupported_question_scope",
      message: "This server does not support scoped question inspection. Update the server before trusting job-scoped follow-up."
    });
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
  return json;
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
  return postCliJson(
    `${host}/api/cli/${projectId}/keys/get`,
    accessToken,
    input
  );
}
async function addCliKey(host, projectId, accessToken, input) {
  return postCliJson(`${host}/api/cli/${projectId}/keys`, accessToken, input);
}
async function updateCliKey(host, projectId, accessToken, input) {
  return patchCliJson(
    `${host}/api/cli/${projectId}/keys/update`,
    accessToken,
    input
  );
}
async function renameCliKey(host, projectId, accessToken, input) {
  return patchCliJson(
    `${host}/api/cli/${projectId}/keys/rename`,
    accessToken,
    input
  );
}
async function archiveCliKey(host, projectId, accessToken, input) {
  return postCliJson(
    `${host}/api/cli/${projectId}/keys/archive`,
    accessToken,
    input
  );
}
async function unarchiveCliKey(host, projectId, accessToken, input) {
  return postCliJson(
    `${host}/api/cli/${projectId}/keys/unarchive`,
    accessToken,
    input
  );
}
async function upsertCliTranslation(host, projectId, accessToken, input) {
  return postCliJson(
    `${host}/api/cli/${projectId}/translations/upsert`,
    accessToken,
    input
  );
}
async function listCliOrganizations(host, accessToken) {
  return fetchCliJson(`${host}/api/cli/organizations`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
}
async function createCliProject(host, accessToken, input) {
  return postCliJson(`${host}/api/cli/projects`, accessToken, input);
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

async function fetchSyncKeys(context, input, localKeys) {
  const selection = input.action === "push" && input.dryRun && !input.keysToRemove?.length && (input.keys?.length ?? 0) + (input.namespaces?.length ?? 0) > 0 && context.capabilities.includes(SCOPED_PUSH_PREVIEW_CAPABILITY);
  const request = selection ? pushPreviewSelection.safeParse({
    keys: input.keys ?? [],
    namespaces: input.namespaces ?? [],
    prune: input.prune === true,
    localKeys: createPushPreviewManifest(localKeys)
  }) : null;
  if (!request?.success)
    return {
      keys: await fetchServerKeys(
        context.host,
        context.projectId,
        context.accessToken
      )
    };
  return requestCliJson(
    `${context.host}/api/cli/${context.projectId}/pushPreview`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${context.accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(request.data)
    }
  );
}

const languageCode = stringType().min(1);
const fields = {
  term: stringType().min(1),
  sourceLanguageCode: languageCode,
  description: stringType().nullable().optional(),
  translations: recordType(languageCode, stringType()).optional()
};
const glossaryUpsertSchema = objectType(fields).strict();
const glossaryUpdateSchema = objectType({
  ...fields,
  term: fields.term.optional(),
  sourceLanguageCode: fields.sourceLanguageCode.optional(),
  removeTranslations: arrayType(languageCode).optional()
}).strict().refine(
  (input) => Object.values(input).some((value) => value !== void 0),
  {
    message: "Provide at least one field to update."
  }
).refine(
  (input) => !input.removeTranslations?.some(
    (code) => input.translations?.[code] !== void 0
  ),
  { message: "Cannot set and remove the same translation." }
);
const glossaryFileSchema = objectType({
  version: literalType(1),
  terms: arrayType(glossaryUpsertSchema).max(1e4)
}).strict().superRefine((file, ctx) => {
  const seen = /* @__PURE__ */ new Set();
  file.terms.forEach((term, index) => {
    const identity = JSON.stringify([term.term, term.sourceLanguageCode]);
    if (seen.has(identity)) {
      ctx.addIssue({
        code: ZodIssueCode.custom,
        path: ["terms", index],
        message: "Duplicate term and source language."
      });
    }
    seen.add(identity);
  });
});

function administrationRequest(ctx, path, method = "GET", body) {
  return requestCliJson(`${ctx.host}/api/cli/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ctx.accessToken}`,
      "Content-Type": "application/json"
    },
    ...body === void 0 ? {} : { body: JSON.stringify(body) }
  });
}

function parseGlossaryTranslations(items) {
  const translations = {};
  for (const item of items) {
    const separator = item.indexOf("=");
    if (separator < 1 || !item.slice(0, separator).trim())
      throw new Error("Use --translation language=value.");
    const code = item.slice(0, separator).trim();
    if (Object.hasOwn(translations, code))
      throw new Error(`Duplicate --translation for ${code}.`);
    Object.defineProperty(translations, code, {
      value: item.slice(separator + 1),
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return translations;
}

function printJson(value) {
  console.info(JSON.stringify(value, null, 2));
}

async function readMutuallyExclusiveValue(input) {
  if (input.direct !== void 0 && input.file !== void 0) {
    throw new Error(
      `Use either ${input.directName} or ${input.fileName}, not both.`
    );
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
      throw new Error(
        `${input.fileName} - would read from an interactive terminal.`
      );
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

function resolveGlossaryScope(ctx, options) {
  if (options.project !== void 0 && options.organization !== void 0)
    throw new Error("Use either --project or --organization, not both.");
  if (options.organization !== void 0) {
    if (!options.organization.trim())
      throw new Error("Organization id cannot be blank.");
    return new URLSearchParams({ organizationId: options.organization });
  }
  const projectId = options.project ?? ctx.projectId;
  if (!projectId?.trim())
    throw new Error(
      "Provide --project, --organization, or a babli.json project."
    );
  return new URLSearchParams({ projectId });
}

async function writeJsonFile(filename, value) {
  const output = path$1.resolve(filename);
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await fs$1.writeFile(temporary, `${JSON.stringify(value, null, 2)}
`, {
      flag: "wx"
    });
    await fs$1.rename(temporary, output);
  } finally {
    await fs$1.rm(temporary, { force: true });
  }
  return output;
}

async function glossaryCommand(ctx, input) {
  const { action, options } = input;
  const query = resolveGlossaryScope(ctx, options);
  const base = `glossary?${query}`;
  let result;
  let status = "ok";
  switch (action) {
    case "list": {
      if (options.includeInherited) query.set("includeInherited", "true");
      result = await administrationRequest(
        ctx,
        `glossary?${query}`
      );
      break;
    }
    case "get": {
      result = await administrationRequest(
        ctx,
        `glossary/${encodeURIComponent(unwrap(input.id))}?${query}`
      );
      break;
    }
    case "upsert":
    case "update": {
      const fields = {
        term: options.term,
        sourceLanguageCode: options.sourceLanguage,
        description: options.description,
        translations: options.translation === void 0 ? void 0 : parseGlossaryTranslations(options.translation),
        ...action === "update" ? { removeTranslations: options.removeTranslation } : {}
      };
      const body = action === "upsert" ? glossaryUpsertSchema.parse(fields) : glossaryUpdateSchema.parse(fields);
      const path = action === "upsert" ? base : `glossary/${encodeURIComponent(unwrap(input.id))}?${query}`;
      result = await administrationRequest(
        ctx,
        path,
        action === "upsert" ? "PUT" : "PATCH",
        body
      );
      status = "updated";
      break;
    }
    case "remove": {
      result = await administrationRequest(
        ctx,
        `glossary/${encodeURIComponent(unwrap(input.id))}?${query}`,
        "DELETE"
      );
      status = "removed";
      break;
    }
    case "move-to-organization": {
      if (!query.has("projectId"))
        throw new Error(
          "Moving a term requires --project or a babli.json project."
        );
      result = await administrationRequest(
        ctx,
        `glossary/${encodeURIComponent(unwrap(input.id))}/move-to-organization?${query}`,
        "POST"
      );
      status = "moved";
      break;
    }
    case "export": {
      const { terms } = await administrationRequest(
        ctx,
        base
      );
      const file = glossaryFileSchema.parse({
        version: 1,
        terms: terms.map(
          ({ term, sourceLanguageCode, description, translations }) => ({
            term,
            sourceLanguageCode,
            description,
            translations
          })
        )
      });
      const output = await writeJsonFile(unwrap(options.output), file);
      result = { output, count: terms.length };
      status = "exported";
      break;
    }
    case "import": {
      const text = await readMutuallyExclusiveValue({
        file: unwrap(options.file),
        directName: "--file",
        fileName: "--file",
        flags: ctx.flags,
        required: true
      });
      const file = glossaryFileSchema.parse(
        JSON.parse(unwrap(text))
      );
      result = await administrationRequest(
        ctx,
        `glossary/import?${query}`,
        "POST",
        { file, dryRun: options.dryRun === true }
      );
      status = options.dryRun ? "dry_run" : "imported";
      break;
    }
    default:
      assertNever(action);
  }
  if (ctx.flags.json) {
    printJson({
      version: 1,
      command: `glossary_${action.replaceAll("-", "_")}`,
      status,
      ...result
    });
  } else if ("terms" in result) {
    const terms = result.terms;
    if (!terms.length) console.info("No glossary terms found.");
    for (const term of terms)
      console.info(
        `${term.id} [${term.projectId ? `project:${term.projectId}` : `organization:${term.organizationId}`}] ${term.term} (${term.sourceLanguageCode}) ${JSON.stringify(term.translations)}${term.description ? ` \u2014 ${term.description}` : ""}`
      );
  } else console.info(JSON.stringify(result, null, 2));
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

const zFileFormat = enumType([
  "json",
  "yaml",
  "neon",
  "flutterArb",
  "typescript",
  "po"
]);
const defaultHost = "https://www.babli.ai";
const zYamlOptions = objectType({
  version: stringType().optional()
});
const zFileOptions = objectType({
  nested: booleanType().default(true).describe(
    `Define if keys should be exported as nested values \`{ "a": { "b": "x"}}\` or not nested \`{ "a.b": "x" }\``
  ),
  topLevelLanguageCode: booleanType().default(false),
  pullWithEmptyValues: booleanType().default(false),
  yaml: zYamlOptions.default({}),
  sortBy: unionType([literalType("key"), literalType("value"), literalType("original")]).default("original")
});
const zTranslationFileConfig = objectType({
  path: stringType().describe(
    "The path to the translation file. Use {{lang}} placeholder to define the language code."
  ),
  /**
   * when not provided, we will use all languages found by the pattern for push, and all languages not included in other patterns for pull
   */
  languages: arrayType(stringType()).describe(
    "Babli will autodetect languages by default, but in case you need different languages with different languages, you can define the languages here."
  ).optional(),
  format: zFileFormat.optional().describe(
    "Babli will autodetect format from file extensions. But if using non-standard extensions, you can change format here."
  ),
  namespace: stringType().optional().describe(
    "Fixed namespace for all keys from this file entry. Mutually exclusive with {{namespace}} in path."
  ),
  mapLocalToRemote: recordType(stringType(), stringType()).optional().describe(
    'Maps local file language codes to remote Babli language codes. E.g. { "en": "en-US", "de": "de-DE" }. Unmapped codes pass through as-is.'
  ),
  transform: stringType().optional().describe(
    "Path to a custom transform file (.ts/.js) for non-standard file formats. The transform handles push/pull for all languages in a single file."
  )
}).merge(zFileOptions);
const zConfigFileInternal = objectType({
  projectId: stringType().describe("The project ID. You can find it in the project settings."),
  sortBy: unionType([literalType("key"), literalType("value"), literalType("original")]).default("original").describe("How to sort the keys in the file"),
  /**
   * this is needed for the case when we have multiple files with pattern
   */
  defaultFilePattern: stringType().optional().describe("HIDDEN"),
  translationFiles: arrayType(zTranslationFileConfig).describe("Source files for the translations."),
  // defaultFormat: zFileFormat.optional(),
  // defaultOptions: zFileOptions.optional(),
  defaultFile: stringType().optional().describe("HIDDEN"),
  /**
   * for development only
   */
  host: stringType().default(defaultHost).describe("HIDDEN"),
  emptyValueString: stringType().nullable().default(null).describe(
    `In case you use some specific value to mark the value is not translated yet,
For example 'NOT_TRANSLATED' or an empty string, You can define it here.`
  )
});
const zTranslationFileConfigInput = zTranslationFileConfig.extend({
  /**
   * the same as languages with only one language
   */
  language: stringType().optional()
});
const zConfigFileInput = zConfigFileInternal.extend({
  translationFiles: arrayType(zTranslationFileConfigInput)
});

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
  const hasChanges = (comparison.keysToRemove?.length ?? 0) > 0 || newLanguages.length > 0 || newKeys.length > 0 || Object.keys(missingTranslationsPerLanguage).length > 0 || conflicts.length > 0;
  return {
    newLanguages,
    newKeys,
    missingTranslationsPerLanguage,
    conflicts,
    keysToRemove: comparison.keysToRemove ?? [],
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

const balanced = (a, b, str) => {
    const ma = a instanceof RegExp ? maybeMatch(a, str) : a;
    const mb = b instanceof RegExp ? maybeMatch(b, str) : b;
    const r = ma !== null && mb != null && range(ma, mb, str);
    return (r && {
        start: r[0],
        end: r[1],
        pre: str.slice(0, r[0]),
        body: str.slice(r[0] + ma.length, r[1]),
        post: str.slice(r[1] + mb.length),
    });
};
const maybeMatch = (reg, str) => {
    const m = str.match(reg);
    return m ? m[0] : null;
};
const range = (a, b, str) => {
    let begs, beg, left, right = undefined, result;
    let ai = str.indexOf(a);
    let bi = str.indexOf(b, ai + 1);
    let i = ai;
    if (ai >= 0 && bi > 0) {
        if (a === b) {
            return [ai, bi];
        }
        begs = [];
        left = str.length;
        while (i >= 0 && !result) {
            if (i === ai) {
                begs.push(i);
                ai = str.indexOf(a, i + 1);
            }
            else if (begs.length === 1) {
                const r = begs.pop();
                if (r !== undefined)
                    result = [r, bi];
            }
            else {
                beg = begs.pop();
                if (beg !== undefined && beg < left) {
                    left = beg;
                    right = bi;
                }
                bi = str.indexOf(b, i + 1);
            }
            i = ai < bi && ai >= 0 ? ai : bi;
        }
        if (begs.length && right !== undefined) {
            result = [left, right];
        }
    }
    return result;
};

const escSlash = '\0SLASH' + Math.random() + '\0';
const escOpen = '\0OPEN' + Math.random() + '\0';
const escClose = '\0CLOSE' + Math.random() + '\0';
const escComma = '\0COMMA' + Math.random() + '\0';
const escPeriod = '\0PERIOD' + Math.random() + '\0';
const escSlashPattern = new RegExp(escSlash, 'g');
const escOpenPattern = new RegExp(escOpen, 'g');
const escClosePattern = new RegExp(escClose, 'g');
const escCommaPattern = new RegExp(escComma, 'g');
const escPeriodPattern = new RegExp(escPeriod, 'g');
const slashPattern = /\\\\/g;
const openPattern = /\\{/g;
const closePattern = /\\}/g;
const commaPattern = /\\,/g;
const periodPattern = /\\\./g;
const EXPANSION_MAX = 100_000;
// `EXPANSION_MAX` caps the *number* of expansions, but not their length. An
// input like `'{a,b}'.repeat(1500)` stays under that count - its output is
// truncated to 100k results - while making every result ~1500 characters
// long. The result set, and the intermediate arrays built while combining
// brace sets, then grow large enough to exhaust memory and crash the process
// (CVE-2026-14257). `EXPANSION_MAX_LENGTH` bounds the total number of
// characters the accumulator may hold at any point, so memory stays flat no
// matter how many brace groups are chained. The limit sits well above any
// realistic expansion (100k results hitting `EXPANSION_MAX` measure ~1M
// characters) so legitimate input is unaffected.
const EXPANSION_MAX_LENGTH = 4_000_000;
// `expand_` recurses once per level of brace *nesting* - both when expanding a
// set's comma members and when re-wrapping a set whose body is a single part.
// The CVE-2026-14257 fix made the *tail* iterative (recursion on `m.post`, one
// level per chained group), which left nesting depth unbounded: about 3,100
// levels of `{{{...a,b...}}}` - only ~6KB of input - exhausted the native stack
// and crashed the process. `EXPANSION_MAX_DEPTH` bounds how deep the parser
// will follow nesting. It sits far above any realistic pattern and well below
// the depth at which the stack runs out.
const EXPANSION_MAX_DEPTH = 1_000;
// Bash keeps a quirk where a brace group followed by a comma set still expands
// (`{a},b}`). The parser implements it by rewriting the string and restarting
// the scan, absorbing one `}` per pass. `n` trailing braces therefore cost `n`
// full passes over a string that itself grows by one `escClose` sentinel each
// time - quadratic in `n`, with a ~26x constant from the sentinel's length.
// 128KB of `'{a}' + '}'.repeat(n) + ',z}'` blocked the event loop for 27
// seconds to produce two results. `EXPANSION_MAX_REWRITES` bounds how many
// times the scan may restart. Real `{a},b}` input needs a handful.
const EXPANSION_MAX_REWRITES = 1_000;
function numeric(str) {
    return !isNaN(str) ? parseInt(str, 10) : str.charCodeAt(0);
}
function escapeBraces(str) {
    return str
        .replace(slashPattern, escSlash)
        .replace(openPattern, escOpen)
        .replace(closePattern, escClose)
        .replace(commaPattern, escComma)
        .replace(periodPattern, escPeriod);
}
function unescapeBraces(str) {
    return str
        .replace(escSlashPattern, '\\')
        .replace(escOpenPattern, '{')
        .replace(escClosePattern, '}')
        .replace(escCommaPattern, ',')
        .replace(escPeriodPattern, '.');
}
// Like `target.push(...items)` but doesn't overflow the stack
function pushAll(target, items) {
    for (let i = 0; i < items.length; i++) {
        target.push(items[i]);
    }
}
/**
 * Basically just str.split(","), but handling cases
 * where we have nested braced sections, which should be
 * treated as individual members, like {a,{b,c},d}
 */
function parseCommaParts(str) {
    const parts = [];
    // Walk the brace groups iteratively. Recursing on `post` once per group let a
    // chain of them exhaust the stack - the parsing-side counterpart to
    // the `expand_` overflow fixed for CVE-2026-14257, and not something `max` or
    // `maxLength` can bound, since it happens before expansion.
    //
    // The part the next chunk continues
    let carry = '';
    for (;;) {
        const m = balanced('{', '}', str);
        if (!m) {
            const tail = str.split(',');
            tail[0] = carry + tail[0];
            pushAll(parts, tail);
            return parts;
        }
        const { pre, body, post } = m;
        const p = pre.split(',');
        p[0] = carry + p[0];
        p[p.length - 1] += '{' + body + '}';
        if (!post.length) {
            pushAll(parts, p);
            return parts;
        }
        carry = p.pop();
        pushAll(parts, p);
        str = post;
    }
}
function expand(str, options = {}) {
    if (!str) {
        return [];
    }
    const { max = EXPANSION_MAX, maxLength = EXPANSION_MAX_LENGTH, maxDepth = EXPANSION_MAX_DEPTH, maxRewrites = EXPANSION_MAX_REWRITES, } = options;
    // I don't know why Bash 4.3 does this, but it does.
    // Anything starting with {} will have the first two bytes preserved
    // but *only* at the top level, so {},a}b will not expand to anything,
    // but a{},b}c will be expanded to [a}c,abc].
    // One could argue that this is a bug in Bash, but since the goal of
    // this module is to match Bash's rules, we escape a leading {}
    if (str.slice(0, 2) === '{}') {
        str = '\\{\\}' + str.slice(2);
    }
    return expand_(escapeBraces(str), max, maxLength, maxDepth, 0, maxRewrites, true).map(unescapeBraces);
}
function embrace(str) {
    return '{' + str + '}';
}
function isPadded(el) {
    return /^-?0\d/.test(el);
}
function lte(i, y) {
    return i <= y;
}
function gte(i, y) {
    return i >= y;
}
// Build `{ acc[a] + pre + values[v] }` for every combination, capping the
// number of results at `max` and the total number of characters at `maxLength`.
// This is the one place output grows, so bounding it here keeps the single
// accumulator - and therefore memory - flat regardless of how many brace groups
// are combined (CVE-2026-14257).
function combine(acc, pre, values, max, maxLength, dropEmpties) {
    const out = [];
    let length = 0;
    for (let a = 0; a < acc.length; a++) {
        for (let v = 0; v < values.length; v++) {
            if (out.length >= max)
                return out;
            const expansion = acc[a] + pre + values[v];
            // Bash drops empty results at the top level. Skip them before they count
            // against `max`, so `max` bounds the number of *kept* results.
            if (dropEmpties && !expansion)
                continue;
            if (length + expansion.length > maxLength)
                return out;
            out.push(expansion);
            length += expansion.length;
        }
    }
    return out;
}
// The expansion values of a single numeric (`1..5`) or alphabetic (`a..e..2`)
// sequence body.
function expandSequence(body, isAlphaSequence, max, maxLength) {
    const n = body.split(/\.\./);
    const N = [];
    // A sequence body always splits into two or three parts, but the compiler
    // can't know that.
    /* c8 ignore start */
    if (n[0] === undefined || n[1] === undefined) {
        return N;
    }
    /* c8 ignore stop */
    const x = numeric(n[0]);
    const y = numeric(n[1]);
    const width = Math.max(n[0].length, n[1].length);
    let incr = n.length === 3 && n[2] !== undefined ?
        Math.max(Math.abs(numeric(n[2])), 1)
        : 1;
    let test = lte;
    const reverse = y < x;
    if (reverse) {
        incr *= -1;
        test = gte;
    }
    const pad = n.some(isPadded);
    let length = 0;
    for (let i = x; test(i, y) && N.length < max; i += incr) {
        let c;
        if (isAlphaSequence) {
            c = String.fromCharCode(i);
            if (c === '\\') {
                c = '';
            }
        }
        else {
            c = String(i);
            if (pad) {
                const need = width - c.length;
                if (need > 0) {
                    const z = new Array(need + 1).join('0');
                    if (i < 0) {
                        c = '-' + z + c.slice(1);
                    }
                    else {
                        c = z + c;
                    }
                }
            }
        }
        if (length + c.length > maxLength)
            break;
        N.push(c);
        length += c.length;
    }
    return N;
}
function expand_(str, max, maxLength, maxDepth, depth, maxRewrites, isTop) {
    // Too deeply nested to keep following: treat the rest as literal, the same
    // way a group that cannot expand is already handled. Truncating rather than
    // throwing keeps `expand` total, matching `max` and `maxLength`.
    if (depth > maxDepth) {
        return [str];
    }
    // Consume the string's top-level brace groups left to right, threading a
    // running set of combined prefixes (`acc`). Expanding the tail iteratively -
    // rather than recursing on `m.post` once per group - keeps the native stack
    // depth constant, so deeply chained input (`'{a,b}'.repeat(3000)`) can no
    // longer overflow the stack, and leaves a single accumulator whose size
    // `maxLength` bounds directly (CVE-2026-14257).
    let acc = [''];
    // Bash drops empty results, but only when the *first* top-level group is a
    // comma set - a sequence like `{a..\}` may legitimately yield ''. The drop
    // is on the final strings, so it is applied to whichever `combine` produces
    // them (the one with no brace set left in the tail).
    // How many times the `{a},b}` rewrite below has restarted the scan. Each pass
    // re-reads the whole string, so leaving this unbounded is quadratic.
    let rewrites = 0;
    let dropEmpties = false;
    let firstGroup = true;
    for (;;) {
        const m = balanced('{', '}', str);
        // No brace set left: the rest of the string is literal.
        if (!m) {
            return combine(acc, str, [''], max, maxLength, dropEmpties);
        }
        // no need to expand pre, since it is guaranteed to be free of brace-sets
        const pre = m.pre;
        if (/\$$/.test(pre)) {
            acc = combine(acc, pre + '{' + m.body + '}', [''], max, maxLength, dropEmpties && !m.post.length);
            firstGroup = false;
            if (!m.post.length)
                break;
            str = m.post;
            continue;
        }
        const isNumericSequence = /^-?\d+\.\.-?\d+(?:\.\.-?\d+)?$/.test(m.body);
        const isAlphaSequence = /^[a-zA-Z]\.\.[a-zA-Z](?:\.\.-?\d+)?$/.test(m.body);
        const isSequence = isNumericSequence || isAlphaSequence;
        const isOptions = m.body.indexOf(',') >= 0;
        if (!isSequence && !isOptions) {
            // {a},b}
            if (rewrites < maxRewrites && m.post.match(/,(?!,).*\}/)) {
                rewrites++;
                str = m.pre + '{' + m.body + escClose + m.post;
                isTop = true;
                continue;
            }
            // Nothing here expands, so the whole remaining string is literal.
            return combine(acc, pre + '{' + m.body + '}' + m.post, [''], max, maxLength, dropEmpties);
        }
        if (firstGroup) {
            dropEmpties = isTop && !isSequence;
            firstGroup = false;
        }
        let values;
        if (isSequence) {
            values = expandSequence(m.body, isAlphaSequence, max, maxLength);
        }
        else {
            let n = parseCommaParts(m.body);
            if (n.length === 1 && n[0] !== undefined) {
                // x{{a,b}}y ==> x{a}y x{b}y
                n = expand_(n[0], max, maxLength, maxDepth, depth + 1, maxRewrites, false).map(embrace);
                //XXX is this necessary? Can't seem to hit it in tests.
                /* c8 ignore start */
                if (n.length === 1) {
                    acc = combine(acc, pre + n[0], [''], max, maxLength, dropEmpties && !m.post.length);
                    if (!m.post.length)
                        break;
                    str = m.post;
                    continue;
                }
                /* c8 ignore stop */
            }
            // Values that `combine` is going to drop as empty produce no result, so
            // they must not count against `max` - otherwise `{a,,b}` with `max: 2`
            // would stop at `['a', '']` and yield one result instead of two. Skipping
            // them outright keeps `values` bounded while leaving `max` a bound on
            // *kept* results.
            let dropsEmpties = dropEmpties && !m.post.length && !pre;
            for (let d = 0; dropsEmpties && d < acc.length; d++) {
                if (acc[d]) {
                    dropsEmpties = false;
                }
            }
            values = [];
            let valuesLength = 0;
            outer: for (let j = 0; j < n.length; j++) {
                const expanded = expand_(n[j], max, maxLength, maxDepth, depth + 1, maxRewrites, false);
                for (let k = 0; k < expanded.length; k++) {
                    const v = expanded[k];
                    if (dropsEmpties && !v)
                        continue;
                    if (values.length >= max ||
                        valuesLength + v.length > maxLength) {
                        break outer;
                    }
                    values.push(v);
                    valuesLength += v.length;
                }
            }
        }
        acc = combine(acc, pre, values, max, maxLength, dropEmpties && !m.post.length);
        if (!m.post.length)
            break;
        str = m.post;
    }
    return acc;
}

const MAX_PATTERN_LENGTH = 1024 * 64;
const assertValidPattern = (pattern) => {
    if (typeof pattern !== 'string') {
        throw new TypeError('invalid pattern');
    }
    if (pattern.length > MAX_PATTERN_LENGTH) {
        throw new TypeError('pattern is too long');
    }
};

// translate the various posix character classes into unicode properties
// this works across all unicode locales
// { <posix class>: [<translation>, /u flag required, negated]
const posixClasses = {
    '[:alnum:]': ['\\p{L}\\p{Nl}\\p{Nd}', true],
    '[:alpha:]': ['\\p{L}\\p{Nl}', true],
    '[:ascii:]': ['\\x' + '00-\\x' + '7f', false],
    '[:blank:]': ['\\p{Zs}\\t', true],
    '[:cntrl:]': ['\\p{Cc}', true],
    '[:digit:]': ['\\p{Nd}', true],
    '[:graph:]': ['\\p{Z}\\p{C}', true, true],
    '[:lower:]': ['\\p{Ll}', true],
    '[:print:]': ['\\p{C}', true],
    '[:punct:]': ['\\p{P}', true],
    '[:space:]': ['\\p{Z}\\t\\r\\n\\v\\f', true],
    '[:upper:]': ['\\p{Lu}', true],
    '[:word:]': ['\\p{L}\\p{Nl}\\p{Nd}\\p{Pc}', true],
    '[:xdigit:]': ['A-Fa-f0-9', false],
};
// only need to escape a few things inside of brace expressions
// escapes: [ \ ] -
const braceEscape = (s) => s.replace(/[[\]\\-]/g, '\\$&');
// escape all regexp magic characters
const regexpEscape = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
// everything has already been escaped, we just have to join
const rangesToString = (ranges) => ranges.join('');
// takes a glob string at a posix brace expression, and returns
// an equivalent regular expression source, and boolean indicating
// whether the /u flag needs to be applied, and the number of chars
// consumed to parse the character class.
// This also removes out of order ranges, and returns ($.) if the
// entire class just no good.
const parseClass = (glob, position) => {
    const pos = position;
    /* c8 ignore start */
    if (glob.charAt(pos) !== '[') {
        throw new Error('not in a brace expression');
    }
    /* c8 ignore stop */
    const ranges = [];
    const negs = [];
    let i = pos + 1;
    let sawStart = false;
    let uflag = false;
    let escaping = false;
    let negate = false;
    let endPos = pos;
    let rangeStart = '';
    WHILE: while (i < glob.length) {
        const c = glob.charAt(i);
        if ((c === '!' || c === '^') && i === pos + 1) {
            negate = true;
            i++;
            continue;
        }
        if (c === ']' && sawStart && !escaping) {
            endPos = i + 1;
            break;
        }
        sawStart = true;
        if (c === '\\') {
            if (!escaping) {
                escaping = true;
                i++;
                continue;
            }
            // escaped \ char, fall through and treat like normal char
        }
        if (c === '[' && !escaping) {
            // either a posix class, a collation equivalent, or just a [
            for (const [cls, [unip, u, neg]] of Object.entries(posixClasses)) {
                if (glob.startsWith(cls, i)) {
                    // invalid, [a-[] is fine, but not [a-[:alpha]]
                    if (rangeStart) {
                        return ['$.', false, glob.length - pos, true];
                    }
                    i += cls.length;
                    if (neg)
                        negs.push(unip);
                    else
                        ranges.push(unip);
                    uflag = uflag || u;
                    continue WHILE;
                }
            }
        }
        // now it's just a normal character, effectively
        escaping = false;
        if (rangeStart) {
            // throw this range away if it's not valid, but others
            // can still match.
            if (c > rangeStart) {
                ranges.push(braceEscape(rangeStart) + '-' + braceEscape(c));
            }
            else if (c === rangeStart) {
                ranges.push(braceEscape(c));
            }
            rangeStart = '';
            i++;
            continue;
        }
        // now might be the start of a range.
        // can be either c-d or c-] or c<more...>] or c] at this point
        if (glob.startsWith('-]', i + 1)) {
            ranges.push(braceEscape(c + '-'));
            i += 2;
            continue;
        }
        if (glob.startsWith('-', i + 1)) {
            rangeStart = c;
            i += 2;
            continue;
        }
        // not the start of a range, just a single character
        ranges.push(braceEscape(c));
        i++;
    }
    if (endPos < i) {
        // didn't see the end of the class, not a valid class,
        // but might still be valid as a literal match.
        return ['', false, 0, false];
    }
    // if we got no ranges and no negates, then we have a range that
    // cannot possibly match anything, and that poisons the whole glob
    if (!ranges.length && !negs.length) {
        return ['$.', false, glob.length - pos, true];
    }
    // if we got one positive range, and it's a single character, then that's
    // not actually a magic pattern, it's just that one literal character.
    // we should not treat that as "magic", we should just return the literal
    // character. [_] is a perfectly valid way to escape glob magic chars.
    if (negs.length === 0 &&
        ranges.length === 1 &&
        /^\\?.$/.test(ranges[0]) &&
        !negate) {
        const r = ranges[0].length === 2 ? ranges[0].slice(-1) : ranges[0];
        return [regexpEscape(r), false, endPos - pos, false];
    }
    const sranges = '[' + (negate ? '^' : '') + rangesToString(ranges) + ']';
    const snegs = '[' + (negate ? '' : '^') + rangesToString(negs) + ']';
    const comb = ranges.length && negs.length ? '(' + sranges + '|' + snegs + ')'
        : ranges.length ? sranges
            : snegs;
    return [comb, uflag, endPos - pos, true];
};

/**
 * Un-escape a string that has been escaped with {@link escape}.
 *
 * If the {@link MinimatchOptions.windowsPathsNoEscape} option is used, then
 * square-bracket escapes are removed, but not backslash escapes.
 *
 * For example, it will turn the string `'[*]'` into `*`, but it will not
 * turn `'\\*'` into `'*'`, because `\` is a path separator in
 * `windowsPathsNoEscape` mode.
 *
 * When `windowsPathsNoEscape` is not set, then both square-bracket escapes and
 * backslash escapes are removed.
 *
 * Slashes (and backslashes in `windowsPathsNoEscape` mode) cannot be escaped
 * or unescaped.
 *
 * When `magicalBraces` is not set, escapes of braces (`{` and `}`) will not be
 * unescaped.
 */
const unescape = (s, { windowsPathsNoEscape = false, magicalBraces = true, } = {}) => {
    if (magicalBraces) {
        return windowsPathsNoEscape ?
            s.replace(/\[([^/\\])\]/g, '$1')
            : s
                .replace(/((?!\\).|^)\[([^/\\])\]/g, '$1$2')
                .replace(/\\([^/])/g, '$1');
    }
    return windowsPathsNoEscape ?
        s.replace(/\[([^/\\{}])\]/g, '$1')
        : s
            .replace(/((?!\\).|^)\[([^/\\{}])\]/g, '$1$2')
            .replace(/\\([^/{}])/g, '$1');
};

// parse a single path portion
var _a;
const types = new Set(['!', '?', '+', '*', '@']);
const isExtglobType = (c) => types.has(c);
const isExtglobAST = (c) => isExtglobType(c.type);
// Map of which extglob types can adopt the children of a nested extglob
//
// anything but ! can adopt a matching type:
// +(a|+(b|c)|d) => +(a|b|c|d)
// *(a|*(b|c)|d) => *(a|b|c|d)
// @(a|@(b|c)|d) => @(a|b|c|d)
// ?(a|?(b|c)|d) => ?(a|b|c|d)
//
// * can adopt anything, because 0 or repetition is allowed
// *(a|?(b|c)|d) => *(a|b|c|d)
// *(a|+(b|c)|d) => *(a|b|c|d)
// *(a|@(b|c)|d) => *(a|b|c|d)
//
// + can adopt @, because 1 or repetition is allowed
// +(a|@(b|c)|d) => +(a|b|c|d)
//
// + and @ CANNOT adopt *, because 0 would be allowed
// +(a|*(b|c)|d) => would match "", on *(b|c)
// @(a|*(b|c)|d) => would match "", on *(b|c)
//
// + and @ CANNOT adopt ?, because 0 would be allowed
// +(a|?(b|c)|d) => would match "", on ?(b|c)
// @(a|?(b|c)|d) => would match "", on ?(b|c)
//
// ? can adopt @, because 0 or 1 is allowed
// ?(a|@(b|c)|d) => ?(a|b|c|d)
//
// ? and @ CANNOT adopt * or +, because >1 would be allowed
// ?(a|*(b|c)|d) => would match bbb on *(b|c)
// @(a|*(b|c)|d) => would match bbb on *(b|c)
// ?(a|+(b|c)|d) => would match bbb on +(b|c)
// @(a|+(b|c)|d) => would match bbb on +(b|c)
//
// ! CANNOT adopt ! (nothing else can either)
// !(a|!(b|c)|d) => !(a|b|c|d) would fail to match on b (not not b|c)
//
// ! can adopt @
// !(a|@(b|c)|d) => !(a|b|c|d)
//
// ! CANNOT adopt *
// !(a|*(b|c)|d) => !(a|b|c|d) would match on bbb, not allowed
//
// ! CANNOT adopt +
// !(a|+(b|c)|d) => !(a|b|c|d) would match on bbb, not allowed
//
// ! CANNOT adopt ?
// x!(a|?(b|c)|d) => x!(a|b|c|d) would fail to match "x"
const adoptionMap = new Map([
    ['!', ['@']],
    ['?', ['?', '@']],
    ['@', ['@']],
    ['*', ['*', '+', '?', '@']],
    ['+', ['+', '@']],
]);
// nested extglobs that can be adopted in, but with the addition of
// a blank '' element.
const adoptionWithSpaceMap = new Map([
    ['!', ['?']],
    ['@', ['?']],
    ['+', ['?', '*']],
]);
// union of the previous two maps
const adoptionAnyMap = new Map([
    ['!', ['?', '@']],
    ['?', ['?', '@']],
    ['@', ['?', '@']],
    ['*', ['*', '+', '?', '@']],
    ['+', ['+', '@', '?', '*']],
]);
// Extglobs that can take over their parent if they are the only child
// the key is parent, value maps child to resulting extglob parent type
// '@' is omitted because it's a special case. An `@` extglob with a single
// member can always be usurped by that subpattern.
const usurpMap = new Map([
    ['!', new Map([['!', '@']])],
    [
        '?',
        new Map([
            ['*', '*'],
            ['+', '*'],
        ]),
    ],
    [
        '@',
        new Map([
            ['!', '!'],
            ['?', '?'],
            ['@', '@'],
            ['*', '*'],
            ['+', '+'],
        ]),
    ],
    [
        '+',
        new Map([
            ['?', '*'],
            ['*', '*'],
        ]),
    ],
]);
// Patterns that get prepended to bind to the start of either the
// entire string, or just a single path portion, to prevent dots
// and/or traversal patterns, when needed.
// Exts don't need the ^ or / bit, because the root binds that already.
const startNoTraversal = '(?!(?:^|/)\\.\\.?(?:$|/))';
const startNoDot = '(?!\\.)';
// characters that indicate a start of pattern needs the "no dots" bit,
// because a dot *might* be matched. ( is not in the list, because in
// the case of a child extglob, it will handle the prevention itself.
const addPatternStart = new Set(['[', '.']);
// cases where traversal is A-OK, no dot prevention needed
const justDots = new Set(['..', '.']);
const reSpecials = new Set('().*{}+?[]^$\\!');
const regExpEscape$1 = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
// any single thing other than /
const qmark$1 = '[^/]';
// * => any number of characters
const star$1 = qmark$1 + '*?';
// use + when we need to ensure that *something* matches, because the * is
// the only thing in the path portion.
const starNoEmpty = qmark$1 + '+?';
// remove the \ chars that we added if we end up doing a nonmagic compare
// const deslash = (s: string) => s.replace(/\\(.)/g, '$1')
let ID = 0;
class AST {
    type;
    #root;
    #hasMagic;
    #uflag = false;
    #parts = [];
    #parent;
    #parentIndex;
    #negs;
    #filledNegs = false;
    #options;
    #toString;
    // set to true if it's an extglob with no children
    // (which really means one child of '')
    #emptyExt = false;
    id = ++ID;
    get depth() {
        return (this.#parent?.depth ?? -1) + 1;
    }
    [Symbol.for('nodejs.util.inspect.custom')]() {
        return {
            '@@type': 'AST',
            id: this.id,
            type: this.type,
            root: this.#root.id,
            parent: this.#parent?.id,
            depth: this.depth,
            partsLength: this.#parts.length,
            parts: this.#parts,
        };
    }
    constructor(type, parent, options = {}) {
        this.type = type;
        // extglobs are inherently magical
        if (type)
            this.#hasMagic = true;
        this.#parent = parent;
        this.#root = this.#parent ? this.#parent.#root : this;
        this.#options = this.#root === this ? options : this.#root.#options;
        this.#negs = this.#root === this ? [] : this.#root.#negs;
        if (type === '!' && !this.#root.#filledNegs)
            this.#negs.push(this);
        this.#parentIndex = this.#parent ? this.#parent.#parts.length : 0;
    }
    get hasMagic() {
        /* c8 ignore start */
        if (this.#hasMagic !== undefined)
            return this.#hasMagic;
        /* c8 ignore stop */
        for (const p of this.#parts) {
            if (typeof p === 'string')
                continue;
            if (p.type || p.hasMagic)
                return (this.#hasMagic = true);
        }
        // note: will be undefined until we generate the regexp src and find out
        return this.#hasMagic;
    }
    // reconstructs the pattern
    toString() {
        return (this.#toString !== undefined ? this.#toString
            : !this.type ?
                (this.#toString = this.#parts.map(p => String(p)).join(''))
                : (this.#toString =
                    this.type +
                        '(' +
                        this.#parts.map(p => String(p)).join('|') +
                        ')'));
    }
    #fillNegs() {
        /* c8 ignore start */
        if (this !== this.#root)
            throw new Error('should only call on root');
        if (this.#filledNegs)
            return this;
        /* c8 ignore stop */
        // call toString() once to fill this out
        this.toString();
        this.#filledNegs = true;
        let n;
        while ((n = this.#negs.pop())) {
            if (n.type !== '!')
                continue;
            // walk up the tree, appending everthing that comes AFTER parentIndex
            let p = n;
            let pp = p.#parent;
            while (pp) {
                for (let i = p.#parentIndex + 1; !pp.type && i < pp.#parts.length; i++) {
                    for (const part of n.#parts) {
                        /* c8 ignore start */
                        if (typeof part === 'string') {
                            throw new Error('string part in extglob AST??');
                        }
                        /* c8 ignore stop */
                        part.copyIn(pp.#parts[i]);
                    }
                }
                p = pp;
                pp = p.#parent;
            }
        }
        return this;
    }
    push(...parts) {
        for (const p of parts) {
            if (p === '')
                continue;
            /* c8 ignore start */
            if (typeof p !== 'string' &&
                !(p instanceof _a && p.#parent === this)) {
                throw new Error('invalid part: ' + p);
            }
            /* c8 ignore stop */
            this.#parts.push(p);
        }
    }
    toJSON() {
        const ret = this.type === null ?
            this.#parts
                .slice()
                .map(p => (typeof p === 'string' ? p : p.toJSON()))
            : [this.type, ...this.#parts.map(p => p.toJSON())];
        if (this.isStart() && !this.type)
            ret.unshift([]);
        if (this.isEnd() &&
            (this === this.#root ||
                (this.#root.#filledNegs && this.#parent?.type === '!'))) {
            ret.push({});
        }
        return ret;
    }
    isStart() {
        if (this.#root === this)
            return true;
        // if (this.type) return !!this.#parent?.isStart()
        if (!this.#parent?.isStart())
            return false;
        if (this.#parentIndex === 0)
            return true;
        // if everything AHEAD of this is a negation, then it's still the "start"
        const p = this.#parent;
        for (let i = 0; i < this.#parentIndex; i++) {
            const pp = p.#parts[i];
            if (!(pp instanceof _a && pp.type === '!')) {
                return false;
            }
        }
        return true;
    }
    isEnd() {
        if (this.#root === this)
            return true;
        if (this.#parent?.type === '!')
            return true;
        if (!this.#parent?.isEnd())
            return false;
        if (!this.type)
            return this.#parent?.isEnd();
        // if not root, it'll always have a parent
        /* c8 ignore start */
        const pl = this.#parent ? this.#parent.#parts.length : 0;
        /* c8 ignore stop */
        return this.#parentIndex === pl - 1;
    }
    copyIn(part) {
        if (typeof part === 'string')
            this.push(part);
        else
            this.push(part.clone(this));
    }
    clone(parent) {
        const c = new _a(this.type, parent);
        for (const p of this.#parts) {
            c.copyIn(p);
        }
        return c;
    }
    static #parseAST(str, ast, pos, opt, extDepth) {
        const maxDepth = opt.maxExtglobRecursion ?? 2;
        let escaping = false;
        let inBrace = false;
        let braceStart = -1;
        let braceNeg = false;
        if (ast.type === null) {
            // outside of a extglob, append until we find a start
            let i = pos;
            let acc = '';
            while (i < str.length) {
                const c = str.charAt(i++);
                // still accumulate escapes at this point, but we do ignore
                // starts that are escaped
                if (escaping || c === '\\') {
                    escaping = !escaping;
                    acc += c;
                    continue;
                }
                if (inBrace) {
                    if (i === braceStart + 1) {
                        if (c === '^' || c === '!') {
                            braceNeg = true;
                        }
                    }
                    else if (c === ']' && !(i === braceStart + 2 && braceNeg)) {
                        inBrace = false;
                    }
                    acc += c;
                    continue;
                }
                else if (c === '[') {
                    inBrace = true;
                    braceStart = i;
                    braceNeg = false;
                    acc += c;
                    continue;
                }
                // we don't have to check for adoption here, because that's
                // done at the other recursion point.
                const doRecurse = !opt.noext &&
                    isExtglobType(c) &&
                    str.charAt(i) === '(' &&
                    extDepth <= maxDepth;
                if (doRecurse) {
                    ast.push(acc);
                    acc = '';
                    const ext = new _a(c, ast);
                    i = _a.#parseAST(str, ext, i, opt, extDepth + 1);
                    ast.push(ext);
                    continue;
                }
                acc += c;
            }
            ast.push(acc);
            return i;
        }
        // some kind of extglob, pos is at the (
        // find the next | or )
        let i = pos + 1;
        let part = new _a(null, ast);
        const parts = [];
        let acc = '';
        while (i < str.length) {
            const c = str.charAt(i++);
            // still accumulate escapes at this point, but we do ignore
            // starts that are escaped
            if (escaping || c === '\\') {
                escaping = !escaping;
                acc += c;
                continue;
            }
            if (inBrace) {
                if (i === braceStart + 1) {
                    if (c === '^' || c === '!') {
                        braceNeg = true;
                    }
                }
                else if (c === ']' && !(i === braceStart + 2 && braceNeg)) {
                    inBrace = false;
                }
                acc += c;
                continue;
            }
            else if (c === '[') {
                inBrace = true;
                braceStart = i;
                braceNeg = false;
                acc += c;
                continue;
            }
            const doRecurse = !opt.noext &&
                isExtglobType(c) &&
                str.charAt(i) === '(' &&
                /* c8 ignore start - the maxDepth is sufficient here */
                (extDepth <= maxDepth || (ast && ast.#canAdoptType(c)));
            /* c8 ignore stop */
            if (doRecurse) {
                const depthAdd = ast && ast.#canAdoptType(c) ? 0 : 1;
                part.push(acc);
                acc = '';
                const ext = new _a(c, part);
                part.push(ext);
                i = _a.#parseAST(str, ext, i, opt, extDepth + depthAdd);
                continue;
            }
            if (c === '|') {
                part.push(acc);
                acc = '';
                parts.push(part);
                part = new _a(null, ast);
                continue;
            }
            if (c === ')') {
                if (acc === '' && ast.#parts.length === 0) {
                    ast.#emptyExt = true;
                }
                part.push(acc);
                acc = '';
                ast.push(...parts, part);
                return i;
            }
            acc += c;
        }
        // unfinished extglob
        // if we got here, it was a malformed extglob! not an extglob, but
        // maybe something else in there.
        ast.type = null;
        ast.#hasMagic = undefined;
        ast.#parts = [str.substring(pos - 1)];
        return i;
    }
    #canAdoptWithSpace(child) {
        return this.#canAdopt(child, adoptionWithSpaceMap);
    }
    #canAdopt(child, map = adoptionMap) {
        if (!child ||
            typeof child !== 'object' ||
            child.type !== null ||
            child.#parts.length !== 1 ||
            this.type === null) {
            return false;
        }
        const gc = child.#parts[0];
        if (!gc || typeof gc !== 'object' || gc.type === null) {
            return false;
        }
        return this.#canAdoptType(gc.type, map);
    }
    #canAdoptType(c, map = adoptionAnyMap) {
        return !!map.get(this.type)?.includes(c);
    }
    #adoptWithSpace(child, index) {
        const gc = child.#parts[0];
        const blank = new _a(null, gc, this.options);
        blank.#parts.push('');
        gc.push(blank);
        this.#adopt(child, index);
    }
    #adopt(child, index) {
        const gc = child.#parts[0];
        this.#parts.splice(index, 1, ...gc.#parts);
        for (const p of gc.#parts) {
            if (typeof p === 'object')
                p.#parent = this;
        }
        this.#toString = undefined;
    }
    #canUsurpType(c) {
        const m = usurpMap.get(this.type);
        return !!m?.has(c);
    }
    #canUsurp(child) {
        if (!child ||
            typeof child !== 'object' ||
            child.type !== null ||
            child.#parts.length !== 1 ||
            this.type === null ||
            this.#parts.length !== 1) {
            return false;
        }
        const gc = child.#parts[0];
        if (!gc || typeof gc !== 'object' || gc.type === null) {
            return false;
        }
        return this.#canUsurpType(gc.type);
    }
    #usurp(child) {
        const m = usurpMap.get(this.type);
        const gc = child.#parts[0];
        const nt = m?.get(gc.type);
        /* c8 ignore start - impossible */
        if (!nt)
            return false;
        /* c8 ignore stop */
        this.#parts = gc.#parts;
        for (const p of this.#parts) {
            if (typeof p === 'object') {
                p.#parent = this;
            }
        }
        this.type = nt;
        this.#toString = undefined;
        this.#emptyExt = false;
    }
    static fromGlob(pattern, options = {}) {
        const ast = new _a(null, undefined, options);
        _a.#parseAST(pattern, ast, 0, options, 0);
        return ast;
    }
    // returns the regular expression if there's magic, or the unescaped
    // string if not.
    toMMPattern() {
        // should only be called on root
        /* c8 ignore start */
        if (this !== this.#root)
            return this.#root.toMMPattern();
        /* c8 ignore stop */
        const glob = this.toString();
        const [re, body, hasMagic, uflag] = this.toRegExpSource();
        // if we're in nocase mode, and not nocaseMagicOnly, then we do
        // still need a regular expression if we have to case-insensitively
        // match capital/lowercase characters.
        const anyMagic = hasMagic ||
            this.#hasMagic ||
            (this.#options.nocase &&
                !this.#options.nocaseMagicOnly &&
                glob.toUpperCase() !== glob.toLowerCase());
        if (!anyMagic) {
            return body;
        }
        const flags = (this.#options.nocase ? 'i' : '') + (uflag ? 'u' : '');
        return Object.assign(new RegExp(`^${re}$`, flags), {
            _src: re,
            _glob: glob,
        });
    }
    get options() {
        return this.#options;
    }
    // returns the string match, the regexp source, whether there's magic
    // in the regexp (so a regular expression is required) and whether or
    // not the uflag is needed for the regular expression (for posix classes)
    // TODO: instead of injecting the start/end at this point, just return
    // the BODY of the regexp, along with the start/end portions suitable
    // for binding the start/end in either a joined full-path makeRe context
    // (where we bind to (^|/), or a standalone matchPart context (where
    // we bind to ^, and not /).  Otherwise slashes get duped!
    //
    // In part-matching mode, the start is:
    // - if not isStart: nothing
    // - if traversal possible, but not allowed: ^(?!\.\.?$)
    // - if dots allowed or not possible: ^
    // - if dots possible and not allowed: ^(?!\.)
    // end is:
    // - if not isEnd(): nothing
    // - else: $
    //
    // In full-path matching mode, we put the slash at the START of the
    // pattern, so start is:
    // - if first pattern: same as part-matching mode
    // - if not isStart(): nothing
    // - if traversal possible, but not allowed: /(?!\.\.?(?:$|/))
    // - if dots allowed or not possible: /
    // - if dots possible and not allowed: /(?!\.)
    // end is:
    // - if last pattern, same as part-matching mode
    // - else nothing
    //
    // Always put the (?:$|/) on negated tails, though, because that has to be
    // there to bind the end of the negated pattern portion, and it's easier to
    // just stick it in now rather than try to inject it later in the middle of
    // the pattern.
    //
    // We can just always return the same end, and leave it up to the caller
    // to know whether it's going to be used joined or in parts.
    // And, if the start is adjusted slightly, can do the same there:
    // - if not isStart: nothing
    // - if traversal possible, but not allowed: (?:/|^)(?!\.\.?$)
    // - if dots allowed or not possible: (?:/|^)
    // - if dots possible and not allowed: (?:/|^)(?!\.)
    //
    // But it's better to have a simpler binding without a conditional, for
    // performance, so probably better to return both start options.
    //
    // Then the caller just ignores the end if it's not the first pattern,
    // and the start always gets applied.
    //
    // But that's always going to be $ if it's the ending pattern, or nothing,
    // so the caller can just attach $ at the end of the pattern when building.
    //
    // So the todo is:
    // - better detect what kind of start is needed
    // - return both flavors of starting pattern
    // - attach $ at the end of the pattern when creating the actual RegExp
    //
    // Ah, but wait, no, that all only applies to the root when the first pattern
    // is not an extglob. If the first pattern IS an extglob, then we need all
    // that dot prevention biz to live in the extglob portions, because eg
    // +(*|.x*) can match .xy but not .yx.
    //
    // So, return the two flavors if it's #root and the first child is not an
    // AST, otherwise leave it to the child AST to handle it, and there,
    // use the (?:^|/) style of start binding.
    //
    // Even simplified further:
    // - Since the start for a join is eg /(?!\.) and the start for a part
    // is ^(?!\.), we can just prepend (?!\.) to the pattern (either root
    // or start or whatever) and prepend ^ or / at the Regexp construction.
    toRegExpSource(allowDot) {
        const dot = allowDot ?? !!this.#options.dot;
        if (this.#root === this) {
            this.#flatten();
            this.#fillNegs();
        }
        if (!isExtglobAST(this)) {
            const noEmpty = this.isStart() &&
                this.isEnd() &&
                !this.#parts.some(s => typeof s !== 'string');
            const src = this.#parts
                .map(p => {
                const [re, _, hasMagic, uflag] = typeof p === 'string' ?
                    _a.#parseGlob(p, this.#hasMagic, noEmpty)
                    : p.toRegExpSource(allowDot);
                this.#hasMagic = this.#hasMagic || hasMagic;
                this.#uflag = this.#uflag || uflag;
                return re;
            })
                .join('');
            let start = '';
            if (this.isStart()) {
                if (typeof this.#parts[0] === 'string') {
                    // this is the string that will match the start of the pattern,
                    // so we need to protect against dots and such.
                    // '.' and '..' cannot match unless the pattern is that exactly,
                    // even if it starts with . or dot:true is set.
                    const dotTravAllowed = this.#parts.length === 1 && justDots.has(this.#parts[0]);
                    if (!dotTravAllowed) {
                        const aps = addPatternStart;
                        // check if we have a possibility of matching . or ..,
                        // and prevent that.
                        const needNoTrav = 
                        // dots are allowed, and the pattern starts with [ or .
                        (dot && aps.has(src.charAt(0))) ||
                            // the pattern starts with \., and then [ or .
                            (src.startsWith('\\.') && aps.has(src.charAt(2))) ||
                            // the pattern starts with \.\., and then [ or .
                            (src.startsWith('\\.\\.') && aps.has(src.charAt(4)));
                        // no need to prevent dots if it can't match a dot, or if a
                        // sub-pattern will be preventing it anyway.
                        const needNoDot = !dot && !allowDot && aps.has(src.charAt(0));
                        start =
                            needNoTrav ? startNoTraversal
                                : needNoDot ? startNoDot
                                    : '';
                    }
                }
            }
            // append the "end of path portion" pattern to negation tails
            let end = '';
            if (this.isEnd() &&
                this.#root.#filledNegs &&
                this.#parent?.type === '!') {
                end = '(?:$|\\/)';
            }
            const final = start + src + end;
            return [
                final,
                unescape(src),
                (this.#hasMagic = !!this.#hasMagic),
                this.#uflag,
            ];
        }
        // We need to calculate the body *twice* if it's a repeat pattern
        // at the start, once in nodot mode, then again in dot mode, so a
        // pattern like *(?) can match 'x.y'
        const repeated = this.type === '*' || this.type === '+';
        // some kind of extglob
        const start = this.type === '!' ? '(?:(?!(?:' : '(?:';
        let body = this.#partsToRegExp(dot);
        if (this.isStart() && this.isEnd() && !body && this.type !== '!') {
            // invalid extglob, has to at least be *something* present, if it's
            // the entire path portion.
            const s = this.toString();
            const me = this;
            me.#parts = [s];
            me.type = null;
            me.#hasMagic = undefined;
            return [s, unescape(this.toString()), false, false];
        }
        let bodyDotAllowed = !repeated || allowDot || dot || !startNoDot ?
            ''
            : this.#partsToRegExp(true);
        if (bodyDotAllowed === body) {
            bodyDotAllowed = '';
        }
        if (bodyDotAllowed) {
            body = `(?:${body})(?:${bodyDotAllowed})*?`;
        }
        // an empty !() is exactly equivalent to a starNoEmpty
        let final = '';
        if (this.type === '!' && this.#emptyExt) {
            final = (this.isStart() && !dot ? startNoDot : '') + starNoEmpty;
        }
        else {
            const close = this.type === '!' ?
                // !() must match something,but !(x) can match ''
                '))' +
                    (this.isStart() && !dot && !allowDot ? startNoDot : '') +
                    star$1 +
                    ')'
                : this.type === '@' ? ')'
                    : this.type === '?' ? ')?'
                        : this.type === '+' && bodyDotAllowed ? ')'
                            : this.type === '*' && bodyDotAllowed ? `)?`
                                : `)${this.type}`;
            final = start + body + close;
        }
        return [
            final,
            unescape(body),
            (this.#hasMagic = !!this.#hasMagic),
            this.#uflag,
        ];
    }
    #flatten() {
        if (!isExtglobAST(this)) {
            for (const p of this.#parts) {
                if (typeof p === 'object') {
                    p.#flatten();
                }
            }
        }
        else {
            // do up to 10 passes to flatten as much as possible
            let iterations = 0;
            let done = false;
            do {
                done = true;
                for (let i = 0; i < this.#parts.length; i++) {
                    const c = this.#parts[i];
                    if (typeof c === 'object') {
                        c.#flatten();
                        if (this.#canAdopt(c)) {
                            done = false;
                            this.#adopt(c, i);
                        }
                        else if (this.#canAdoptWithSpace(c)) {
                            done = false;
                            this.#adoptWithSpace(c, i);
                        }
                        else if (this.#canUsurp(c)) {
                            done = false;
                            this.#usurp(c);
                        }
                    }
                }
            } while (!done && ++iterations < 10);
        }
        this.#toString = undefined;
    }
    #partsToRegExp(dot) {
        return this.#parts
            .map(p => {
            // extglob ASTs should only contain parent ASTs
            /* c8 ignore start */
            if (typeof p === 'string') {
                throw new Error('string type in extglob ast??');
            }
            /* c8 ignore stop */
            // can ignore hasMagic, because extglobs are already always magic
            const [re, _, _hasMagic, uflag] = p.toRegExpSource(dot);
            this.#uflag = this.#uflag || uflag;
            return re;
        })
            .filter(p => !(this.isStart() && this.isEnd()) || !!p)
            .join('|');
    }
    static #parseGlob(glob, hasMagic, noEmpty = false) {
        let escaping = false;
        let re = '';
        let uflag = false;
        // multiple stars that aren't globstars coalesce into one *
        let inStar = false;
        for (let i = 0; i < glob.length; i++) {
            const c = glob.charAt(i);
            if (escaping) {
                escaping = false;
                re += (reSpecials.has(c) ? '\\' : '') + c;
                continue;
            }
            if (c === '*') {
                if (inStar)
                    continue;
                inStar = true;
                re += noEmpty && /^[*]+$/.test(glob) ? starNoEmpty : star$1;
                hasMagic = true;
                continue;
            }
            else {
                inStar = false;
            }
            if (c === '\\') {
                if (i === glob.length - 1) {
                    re += '\\\\';
                }
                else {
                    escaping = true;
                }
                continue;
            }
            if (c === '[') {
                const [src, needUflag, consumed, magic] = parseClass(glob, i);
                if (consumed) {
                    re += src;
                    uflag = uflag || needUflag;
                    i += consumed - 1;
                    hasMagic = hasMagic || magic;
                    continue;
                }
            }
            if (c === '?') {
                re += qmark$1;
                hasMagic = true;
                continue;
            }
            re += regExpEscape$1(c);
        }
        return [re, unescape(glob), !!hasMagic, uflag];
    }
}
_a = AST;

/**
 * Escape all magic characters in a glob pattern.
 *
 * If the {@link MinimatchOptions.windowsPathsNoEscape}
 * option is used, then characters are escaped by wrapping in `[]`, because
 * a magic character wrapped in a character class can only be satisfied by
 * that exact character.  In this mode, `\` is _not_ escaped, because it is
 * not interpreted as a magic character, but instead as a path separator.
 *
 * If the {@link MinimatchOptions.magicalBraces} option is used,
 * then braces (`{` and `}`) will be escaped.
 */
const escape = (s, { windowsPathsNoEscape = false, magicalBraces = false, } = {}) => {
    // don't need to escape +@! because we escape the parens
    // that make those magic, and escaping ! as [!] isn't valid,
    // because [!]] is a valid glob class meaning not ']'.
    if (magicalBraces) {
        return windowsPathsNoEscape ?
            s.replace(/[?*()[\]{}]/g, '[$&]')
            : s.replace(/[?*()[\]\\{}]/g, '\\$&');
    }
    return windowsPathsNoEscape ?
        s.replace(/[?*()[\]]/g, '[$&]')
        : s.replace(/[?*()[\]\\]/g, '\\$&');
};

const minimatch = (p, pattern, options = {}) => {
    assertValidPattern(pattern);
    // shortcut: comments match nothing.
    if (!options.nocomment && pattern.charAt(0) === '#') {
        return false;
    }
    return new Minimatch(pattern, options).match(p);
};
// Optimized checking for the most common glob patterns.
const starDotExtRE = /^\*+([^+@!?*[(]*)$/;
const starDotExtTest = (ext) => (f) => !f.startsWith('.') && f.endsWith(ext);
const starDotExtTestDot = (ext) => (f) => f.endsWith(ext);
const starDotExtTestNocase = (ext) => {
    ext = ext.toLowerCase();
    return (f) => !f.startsWith('.') && f.toLowerCase().endsWith(ext);
};
const starDotExtTestNocaseDot = (ext) => {
    ext = ext.toLowerCase();
    return (f) => f.toLowerCase().endsWith(ext);
};
const starDotStarRE = /^\*+\.\*+$/;
const starDotStarTest = (f) => !f.startsWith('.') && f.includes('.');
const starDotStarTestDot = (f) => f !== '.' && f !== '..' && f.includes('.');
const dotStarRE = /^\.\*+$/;
const dotStarTest = (f) => f !== '.' && f !== '..' && f.startsWith('.');
const starRE = /^\*+$/;
const starTest = (f) => f.length !== 0 && !f.startsWith('.');
const starTestDot = (f) => f.length !== 0 && f !== '.' && f !== '..';
const qmarksRE = /^\?+([^+@!?*[(]*)?$/;
const qmarksTestNocase = ([$0, ext = '']) => {
    const noext = qmarksTestNoExt([$0]);
    if (!ext)
        return noext;
    ext = ext.toLowerCase();
    return (f) => noext(f) && f.toLowerCase().endsWith(ext);
};
const qmarksTestNocaseDot = ([$0, ext = '']) => {
    const noext = qmarksTestNoExtDot([$0]);
    if (!ext)
        return noext;
    ext = ext.toLowerCase();
    return (f) => noext(f) && f.toLowerCase().endsWith(ext);
};
const qmarksTestDot = ([$0, ext = '']) => {
    const noext = qmarksTestNoExtDot([$0]);
    return !ext ? noext : (f) => noext(f) && f.endsWith(ext);
};
const qmarksTest = ([$0, ext = '']) => {
    const noext = qmarksTestNoExt([$0]);
    return !ext ? noext : (f) => noext(f) && f.endsWith(ext);
};
const qmarksTestNoExt = ([$0]) => {
    const len = $0.length;
    return (f) => f.length === len && !f.startsWith('.');
};
const qmarksTestNoExtDot = ([$0]) => {
    const len = $0.length;
    return (f) => f.length === len && f !== '.' && f !== '..';
};
/* c8 ignore start */
const defaultPlatform = (typeof process === 'object' && process ?
    (typeof process.env === 'object' &&
        process.env &&
        process.env.__MINIMATCH_TESTING_PLATFORM__) ||
        process.platform
    : 'posix');
const path = {
    win32: { sep: '\\' },
    posix: { sep: '/' },
};
/* c8 ignore stop */
const sep = defaultPlatform === 'win32' ? path.win32.sep : path.posix.sep;
minimatch.sep = sep;
const GLOBSTAR = Symbol('globstar **');
minimatch.GLOBSTAR = GLOBSTAR;
// any single thing other than /
// don't need to escape / when using new RegExp()
const qmark = '[^/]';
// * => any number of characters
const star = qmark + '*?';
// ** when dots are allowed.  Anything goes, except .. and .
// not (^ or / followed by one or two dots followed by $ or /),
// followed by anything, any number of times.
const twoStarDot = '(?:(?!(?:\\/|^)(?:\\.{1,2})($|\\/)).)*?';
// not a ^ or / followed by a dot,
// followed by anything, any number of times.
const twoStarNoDot = '(?:(?!(?:\\/|^)\\.).)*?';
const filter = (pattern, options = {}) => (p) => minimatch(p, pattern, options);
minimatch.filter = filter;
const ext = (a, b = {}) => Object.assign({}, a, b);
const defaults = (def) => {
    if (!def || typeof def !== 'object' || !Object.keys(def).length) {
        return minimatch;
    }
    const orig = minimatch;
    const m = (p, pattern, options = {}) => orig(p, pattern, ext(def, options));
    return Object.assign(m, {
        Minimatch: class Minimatch extends orig.Minimatch {
            constructor(pattern, options = {}) {
                super(pattern, ext(def, options));
            }
            static defaults(options) {
                return orig.defaults(ext(def, options)).Minimatch;
            }
        },
        AST: class AST extends orig.AST {
            /* c8 ignore start */
            constructor(type, parent, options = {}) {
                super(type, parent, ext(def, options));
            }
            /* c8 ignore stop */
            static fromGlob(pattern, options = {}) {
                return orig.AST.fromGlob(pattern, ext(def, options));
            }
        },
        unescape: (s, options = {}) => orig.unescape(s, ext(def, options)),
        escape: (s, options = {}) => orig.escape(s, ext(def, options)),
        filter: (pattern, options = {}) => orig.filter(pattern, ext(def, options)),
        defaults: (options) => orig.defaults(ext(def, options)),
        makeRe: (pattern, options = {}) => orig.makeRe(pattern, ext(def, options)),
        braceExpand: (pattern, options = {}) => orig.braceExpand(pattern, ext(def, options)),
        match: (list, pattern, options = {}) => orig.match(list, pattern, ext(def, options)),
        sep: orig.sep,
        GLOBSTAR: GLOBSTAR,
    });
};
minimatch.defaults = defaults;
// Brace expansion:
// a{b,c}d -> abd acd
// a{b,}c -> abc ac
// a{0..3}d -> a0d a1d a2d a3d
// a{b,c{d,e}f}g -> abg acdfg acefg
// a{b,c}d{e,f}g -> abdeg acdeg abdeg abdfg
//
// Invalid sets are not expanded.
// a{2..}b -> a{2..}b
// a{b}c -> a{b}c
const braceExpand = (pattern, options = {}) => {
    assertValidPattern(pattern);
    // Thanks to Yeting Li <https://github.com/yetingli> for
    // improving this regexp to avoid a ReDOS vulnerability.
    if (options.nobrace || !/\{(?:(?!\{).)*\}/.test(pattern)) {
        // shortcut. no need to expand.
        return [pattern];
    }
    return expand(pattern, { max: options.braceExpandMax });
};
minimatch.braceExpand = braceExpand;
// parse a component of the expanded set.
// At this point, no pattern may contain "/" in it
// so we're going to return a 2d array, where each entry is the full
// pattern, split on '/', and then turned into a regular expression.
// A regexp is made at the end which joins each array with an
// escaped /, and another full one which joins each regexp with |.
//
// Following the lead of Bash 4.1, note that "**" only has special meaning
// when it is the *only* thing in a path portion.  Otherwise, any series
// of * is equivalent to a single *.  Globstar behavior is enabled by
// default, and can be disabled by setting options.noglobstar.
const makeRe = (pattern, options = {}) => new Minimatch(pattern, options).makeRe();
minimatch.makeRe = makeRe;
const match = (list, pattern, options = {}) => {
    const mm = new Minimatch(pattern, options);
    list = list.filter(f => mm.match(f));
    if (mm.options.nonull && !list.length) {
        list.push(pattern);
    }
    return list;
};
minimatch.match = match;
// replace stuff like \* with *
const globMagic = /[?*]|[+@!]\(.*?\)|\[|\]/;
const regExpEscape = (s) => s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
class Minimatch {
    options;
    set;
    pattern;
    windowsPathsNoEscape;
    nonegate;
    negate;
    comment;
    empty;
    preserveMultipleSlashes;
    partial;
    globSet;
    globParts;
    nocase;
    isWindows;
    platform;
    windowsNoMagicRoot;
    maxGlobstarRecursion;
    regexp;
    constructor(pattern, options = {}) {
        assertValidPattern(pattern);
        options = options || {};
        this.options = options;
        this.maxGlobstarRecursion = options.maxGlobstarRecursion ?? 200;
        this.pattern = pattern;
        this.platform = options.platform || defaultPlatform;
        this.isWindows = this.platform === 'win32';
        // avoid the annoying deprecation flag lol
        const awe = ('allowWindow' + 'sEscape');
        this.windowsPathsNoEscape =
            !!options.windowsPathsNoEscape || options[awe] === false;
        if (this.windowsPathsNoEscape) {
            this.pattern = this.pattern.replace(/\\/g, '/');
        }
        this.preserveMultipleSlashes = !!options.preserveMultipleSlashes;
        this.regexp = null;
        this.negate = false;
        this.nonegate = !!options.nonegate;
        this.comment = false;
        this.empty = false;
        this.partial = !!options.partial;
        this.nocase = !!this.options.nocase;
        this.windowsNoMagicRoot =
            options.windowsNoMagicRoot !== undefined ?
                options.windowsNoMagicRoot
                : !!(this.isWindows && this.nocase);
        this.globSet = [];
        this.globParts = [];
        this.set = [];
        // make the set of regexps etc.
        this.make();
    }
    hasMagic() {
        if (this.options.magicalBraces && this.set.length > 1) {
            return true;
        }
        for (const pattern of this.set) {
            for (const part of pattern) {
                if (typeof part !== 'string')
                    return true;
            }
        }
        return false;
    }
    debug(..._) { }
    make() {
        const pattern = this.pattern;
        const options = this.options;
        // empty patterns and comments match nothing.
        if (!options.nocomment && pattern.charAt(0) === '#') {
            this.comment = true;
            return;
        }
        if (!pattern) {
            this.empty = true;
            return;
        }
        // step 1: figure out negation, etc.
        this.parseNegate();
        // step 2: expand braces
        this.globSet = [...new Set(this.braceExpand())];
        if (options.debug) {
            //oxlint-disable-next-line no-console
            this.debug = (...args) => console.error(...args);
        }
        this.debug(this.pattern, this.globSet);
        // step 3: now we have a set, so turn each one into a series of
        // path-portion matching patterns.
        // These will be regexps, except in the case of "**", which is
        // set to the GLOBSTAR object for globstar behavior,
        // and will not contain any / characters
        //
        // First, we preprocess to make the glob pattern sets a bit simpler
        // and deduped.  There are some perf-killing patterns that can cause
        // problems with a glob walk, but we can simplify them down a bit.
        const rawGlobParts = this.globSet.map(s => this.slashSplit(s));
        this.globParts = this.preprocess(rawGlobParts);
        this.debug(this.pattern, this.globParts);
        // glob --> regexps
        let set = this.globParts.map((s, _, __) => {
            if (this.isWindows && this.windowsNoMagicRoot) {
                // check if it's a drive or unc path.
                const isUNC = s[0] === '' &&
                    s[1] === '' &&
                    (s[2] === '?' || !globMagic.test(s[2])) &&
                    !globMagic.test(s[3]);
                const isDrive = /^[a-z]:/i.test(s[0]);
                if (isUNC) {
                    return [
                        ...s.slice(0, 4),
                        ...s.slice(4).map(ss => this.parse(ss)),
                    ];
                }
                else if (isDrive) {
                    return [s[0], ...s.slice(1).map(ss => this.parse(ss))];
                }
            }
            return s.map(ss => this.parse(ss));
        });
        this.debug(this.pattern, set);
        // filter out everything that didn't compile properly.
        this.set = set.filter(s => s.indexOf(false) === -1);
        // do not treat the ? in UNC paths as magic
        if (this.isWindows) {
            for (let i = 0; i < this.set.length; i++) {
                const p = this.set[i];
                if (p[0] === '' &&
                    p[1] === '' &&
                    this.globParts[i][2] === '?' &&
                    typeof p[3] === 'string' &&
                    /^[a-z]:$/i.test(p[3])) {
                    p[2] = '?';
                }
            }
        }
        this.debug(this.pattern, this.set);
    }
    // various transforms to equivalent pattern sets that are
    // faster to process in a filesystem walk.  The goal is to
    // eliminate what we can, and push all ** patterns as far
    // to the right as possible, even if it increases the number
    // of patterns that we have to process.
    preprocess(globParts) {
        // if we're not in globstar mode, then turn ** into *
        if (this.options.noglobstar) {
            for (const partset of globParts) {
                for (let j = 0; j < partset.length; j++) {
                    if (partset[j] === '**') {
                        partset[j] = '*';
                    }
                }
            }
        }
        const { optimizationLevel = 1 } = this.options;
        if (optimizationLevel >= 2) {
            // aggressive optimization for the purpose of fs walking
            globParts = this.firstPhasePreProcess(globParts);
            globParts = this.secondPhasePreProcess(globParts);
        }
        else if (optimizationLevel >= 1) {
            // just basic optimizations to remove some .. parts
            globParts = this.levelOneOptimize(globParts);
        }
        else {
            // just collapse multiple ** portions into one
            globParts = this.adjascentGlobstarOptimize(globParts);
        }
        return globParts;
    }
    // just get rid of adjascent ** portions
    adjascentGlobstarOptimize(globParts) {
        return globParts.map(parts => {
            let gs = -1;
            while (-1 !== (gs = parts.indexOf('**', gs + 1))) {
                let i = gs;
                while (parts[i + 1] === '**') {
                    i++;
                }
                if (i !== gs) {
                    parts.splice(gs, i - gs);
                }
            }
            return parts;
        });
    }
    // get rid of adjascent ** and resolve .. portions
    levelOneOptimize(globParts) {
        return globParts.map(parts => {
            parts = parts.reduce((set, part) => {
                const prev = set[set.length - 1];
                if (part === '**' && prev === '**') {
                    return set;
                }
                if (part === '..') {
                    if (prev && prev !== '..' && prev !== '.' && prev !== '**') {
                        set.pop();
                        return set;
                    }
                }
                set.push(part);
                return set;
            }, []);
            return parts.length === 0 ? [''] : parts;
        });
    }
    levelTwoFileOptimize(parts) {
        if (!Array.isArray(parts)) {
            parts = this.slashSplit(parts);
        }
        let didSomething = false;
        do {
            didSomething = false;
            // <pre>/<e>/<rest> -> <pre>/<rest>
            if (!this.preserveMultipleSlashes) {
                for (let i = 1; i < parts.length - 1; i++) {
                    const p = parts[i];
                    // don't squeeze out UNC patterns
                    if (i === 1 && p === '' && parts[0] === '')
                        continue;
                    if (p === '.' || p === '') {
                        didSomething = true;
                        parts.splice(i, 1);
                        i--;
                    }
                }
                if (parts[0] === '.' &&
                    parts.length === 2 &&
                    (parts[1] === '.' || parts[1] === '')) {
                    didSomething = true;
                    parts.pop();
                }
            }
            // <pre>/<p>/../<rest> -> <pre>/<rest>
            let dd = 0;
            while (-1 !== (dd = parts.indexOf('..', dd + 1))) {
                const p = parts[dd - 1];
                if (p &&
                    p !== '.' &&
                    p !== '..' &&
                    p !== '**' &&
                    !(this.isWindows && /^[a-z]:$/i.test(p))) {
                    didSomething = true;
                    parts.splice(dd - 1, 2);
                    dd -= 2;
                }
            }
        } while (didSomething);
        return parts.length === 0 ? [''] : parts;
    }
    // First phase: single-pattern processing
    // <pre> is 1 or more portions
    // <rest> is 1 or more portions
    // <p> is any portion other than ., .., '', or **
    // <e> is . or ''
    //
    // **/.. is *brutal* for filesystem walking performance, because
    // it effectively resets the recursive walk each time it occurs,
    // and ** cannot be reduced out by a .. pattern part like a regexp
    // or most strings (other than .., ., and '') can be.
    //
    // <pre>/**/../<p>/<p>/<rest> -> {<pre>/../<p>/<p>/<rest>,<pre>/**/<p>/<p>/<rest>}
    // <pre>/<e>/<rest> -> <pre>/<rest>
    // <pre>/<p>/../<rest> -> <pre>/<rest>
    // **/**/<rest> -> **/<rest>
    //
    // **/*/<rest> -> */**/<rest> <== not valid because ** doesn't follow
    // this WOULD be allowed if ** did follow symlinks, or * didn't
    firstPhasePreProcess(globParts) {
        const { braceExpandMax = 100_000 } = this.options;
        let didSomething = false;
        do {
            didSomething = false;
            // <pre>/**/../<p>/<p>/<rest> -> {<pre>/../<p>/<p>/<rest>,<pre>/**/<p>/<p>/<rest>}
            for (let parts of globParts) {
                let gs = -1;
                while (-1 !== (gs = parts.indexOf('**', gs + 1))) {
                    let gss = gs;
                    while (parts[gss + 1] === '**') {
                        // <pre>/**/**/<rest> -> <pre>/**/<rest>
                        gss++;
                    }
                    // eg, if gs is 2 and gss is 4, that means we have 3 **
                    // parts, and can remove 2 of them.
                    if (gss > gs) {
                        parts.splice(gs + 1, gss - gs);
                    }
                    let next = parts[gs + 1];
                    const p = parts[gs + 2];
                    const p2 = parts[gs + 3];
                    if (next !== '..')
                        continue;
                    if (!p ||
                        p === '.' ||
                        p === '..' ||
                        !p2 ||
                        p2 === '.' ||
                        p2 === '..' ||
                        globParts.length >= braceExpandMax) {
                        continue;
                    }
                    didSomething = true;
                    // edit parts in place, and push the new one
                    parts.splice(gs, 1);
                    const other = parts.slice(0);
                    other[gs] = '**';
                    globParts.push(other);
                    gs--;
                }
                // <pre>/<e>/<rest> -> <pre>/<rest>
                if (!this.preserveMultipleSlashes) {
                    for (let i = 1; i < parts.length - 1; i++) {
                        const p = parts[i];
                        // don't squeeze out UNC patterns
                        if (i === 1 && p === '' && parts[0] === '')
                            continue;
                        if (p === '.' || p === '') {
                            didSomething = true;
                            parts.splice(i, 1);
                            i--;
                        }
                    }
                    if (parts[0] === '.' &&
                        parts.length === 2 &&
                        (parts[1] === '.' || parts[1] === '')) {
                        didSomething = true;
                        parts.pop();
                    }
                }
                // <pre>/<p>/../<rest> -> <pre>/<rest>
                let dd = 0;
                while (-1 !== (dd = parts.indexOf('..', dd + 1))) {
                    const p = parts[dd - 1];
                    if (p && p !== '.' && p !== '..' && p !== '**') {
                        didSomething = true;
                        const needDot = dd === 1 && parts[dd + 1] === '**';
                        const splin = needDot ? ['.'] : [];
                        parts.splice(dd - 1, 2, ...splin);
                        if (parts.length === 0)
                            parts.push('');
                        dd -= 2;
                    }
                }
            }
        } while (didSomething);
        return globParts;
    }
    // second phase: multi-pattern dedupes
    // {<pre>/*/<rest>,<pre>/<p>/<rest>} -> <pre>/*/<rest>
    // {<pre>/<rest>,<pre>/<rest>} -> <pre>/<rest>
    // {<pre>/**/<rest>,<pre>/<rest>} -> <pre>/**/<rest>
    //
    // {<pre>/**/<rest>,<pre>/**/<p>/<rest>} -> <pre>/**/<rest>
    // ^-- not valid because ** doens't follow symlinks
    secondPhasePreProcess(globParts) {
        if (globParts.length > 1000) return globParts;
        for (let i = 0; i < globParts.length - 1; i++) {
            for (let j = i + 1; j < globParts.length; j++) {
                const matched = this.partsMatch(globParts[i], globParts[j], !this.preserveMultipleSlashes);
                if (matched) {
                    globParts[i] = [];
                    globParts[j] = matched;
                    break;
                }
            }
        }
        return globParts.filter(gs => gs.length);
    }
    partsMatch(a, b, emptyGSMatch = false) {
        let ai = 0;
        let bi = 0;
        let result = [];
        let which = '';
        while (ai < a.length && bi < b.length) {
            if (a[ai] === b[bi]) {
                result.push(which === 'b' ? b[bi] : a[ai]);
                ai++;
                bi++;
            }
            else if (emptyGSMatch && a[ai] === '**' && b[bi] === a[ai + 1]) {
                result.push(a[ai]);
                ai++;
            }
            else if (emptyGSMatch && b[bi] === '**' && a[ai] === b[bi + 1]) {
                result.push(b[bi]);
                bi++;
            }
            else if (a[ai] === '*' &&
                b[bi] &&
                (this.options.dot || !b[bi].startsWith('.')) &&
                b[bi] !== '**') {
                if (which === 'b')
                    return false;
                which = 'a';
                result.push(a[ai]);
                ai++;
                bi++;
            }
            else if (b[bi] === '*' &&
                a[ai] &&
                (this.options.dot || !a[ai].startsWith('.')) &&
                a[ai] !== '**') {
                if (which === 'a')
                    return false;
                which = 'b';
                result.push(b[bi]);
                ai++;
                bi++;
            }
            else {
                return false;
            }
        }
        // if we fall out of the loop, it means they two are identical
        // as long as their lengths match
        return a.length === b.length && result;
    }
    parseNegate() {
        if (this.nonegate)
            return;
        const pattern = this.pattern;
        let negate = false;
        let negateOffset = 0;
        for (let i = 0; i < pattern.length && pattern.charAt(i) === '!'; i++) {
            negate = !negate;
            negateOffset++;
        }
        if (negateOffset)
            this.pattern = pattern.slice(negateOffset);
        this.negate = negate;
    }
    // set partial to true to test if, for example,
    // "/a/b" matches the start of "/*/b/*/d"
    // Partial means, if you run out of file before you run
    // out of pattern, then that's fine, as long as all
    // the parts match.
    matchOne(file, pattern, partial = false) {
        let fileStartIndex = 0;
        let patternStartIndex = 0;
        // UNC paths like //?/X:/... can match X:/... and vice versa
        // Drive letters in absolute drive or unc paths are always compared
        // case-insensitively.
        if (this.isWindows) {
            const fileDrive = typeof file[0] === 'string' && /^[a-z]:$/i.test(file[0]);
            const fileUNC = !fileDrive &&
                file[0] === '' &&
                file[1] === '' &&
                file[2] === '?' &&
                /^[a-z]:$/i.test(file[3]);
            const patternDrive = typeof pattern[0] === 'string' && /^[a-z]:$/i.test(pattern[0]);
            const patternUNC = !patternDrive &&
                pattern[0] === '' &&
                pattern[1] === '' &&
                pattern[2] === '?' &&
                typeof pattern[3] === 'string' &&
                /^[a-z]:$/i.test(pattern[3]);
            const fdi = fileUNC ? 3
                : fileDrive ? 0
                    : undefined;
            const pdi = patternUNC ? 3
                : patternDrive ? 0
                    : undefined;
            if (typeof fdi === 'number' && typeof pdi === 'number') {
                const [fd, pd] = [
                    file[fdi],
                    pattern[pdi],
                ];
                // start matching at the drive letter index of each
                if (fd.toLowerCase() === pd.toLowerCase()) {
                    pattern[pdi] = fd;
                    patternStartIndex = pdi;
                    fileStartIndex = fdi;
                }
            }
        }
        // resolve and reduce . and .. portions in the file as well.
        // don't need to do the second phase, because it's only one string[]
        const { optimizationLevel = 1 } = this.options;
        if (optimizationLevel >= 2) {
            file = this.levelTwoFileOptimize(file);
        }
        if (pattern.includes(GLOBSTAR)) {
            return this.#matchGlobstar(file, pattern, partial, fileStartIndex, patternStartIndex);
        }
        return this.#matchOne(file, pattern, partial, fileStartIndex, patternStartIndex);
    }
    #matchGlobstar(file, pattern, partial, fileIndex, patternIndex) {
        // split the pattern into head, tail, and middle of ** delimited parts
        const firstgs = pattern.indexOf(GLOBSTAR, patternIndex);
        const lastgs = pattern.lastIndexOf(GLOBSTAR);
        // split the pattern up into globstar-delimited sections
        // the tail has to be at the end, and the others just have
        // to be found in order from the head.
        const [head, body, tail] = partial ?
            [
                pattern.slice(patternIndex, firstgs),
                pattern.slice(firstgs + 1),
                [],
            ]
            : [
                pattern.slice(patternIndex, firstgs),
                pattern.slice(firstgs + 1, lastgs),
                pattern.slice(lastgs + 1),
            ];
        // check the head, from the current file/pattern index.
        if (head.length) {
            const fileHead = file.slice(fileIndex, fileIndex + head.length);
            if (!this.#matchOne(fileHead, head, partial, 0, 0)) {
                return false;
            }
            fileIndex += head.length;
            patternIndex += head.length;
        }
        // now we know the head matches!
        // if the last portion is not empty, it MUST match the end
        // check the tail
        let fileTailMatch = 0;
        if (tail.length) {
            // if head + tail > file, then we cannot possibly match
            if (tail.length + fileIndex > file.length)
                return false;
            // try to match the tail
            let tailStart = file.length - tail.length;
            if (this.#matchOne(file, tail, partial, tailStart, 0)) {
                fileTailMatch = tail.length;
            }
            else {
                // affordance for stuff like a/**/* matching a/b/
                // if the last file portion is '', and there's more to the pattern
                // then try without the '' bit.
                if (file[file.length - 1] !== '' ||
                    fileIndex + tail.length === file.length) {
                    return false;
                }
                tailStart--;
                if (!this.#matchOne(file, tail, partial, tailStart, 0)) {
                    return false;
                }
                fileTailMatch = tail.length + 1;
            }
        }
        // now we know the tail matches!
        // the middle is zero or more portions wrapped in **, possibly
        // containing more ** sections.
        // so a/**/b/**/c/**/d has become **/b/**/c/**
        // if it's empty, it means a/**/b, just verify we have no bad dots
        // if there's no tail, so it ends on /**, then we must have *something*
        // after the head, or it's not a matc
        if (!body.length) {
            let sawSome = !!fileTailMatch;
            for (let i = fileIndex; i < file.length - fileTailMatch; i++) {
                const f = String(file[i]);
                sawSome = true;
                if (f === '.' ||
                    f === '..' ||
                    (!this.options.dot && f.startsWith('.'))) {
                    return false;
                }
            }
            // in partial mode, we just need to get past all file parts
            return partial || sawSome;
        }
        // now we know that there's one or more body sections, which can
        // be matched anywhere from the 0 index (because the head was pruned)
        // through to the length-fileTailMatch index.
        // split the body up into sections, and note the minimum index it can
        // be found at (start with the length of all previous segments)
        // [section, before, after]
        const bodySegments = [[[], 0]];
        let currentBody = bodySegments[0];
        let nonGsParts = 0;
        const nonGsPartsSums = [0];
        for (const b of body) {
            if (b === GLOBSTAR) {
                nonGsPartsSums.push(nonGsParts);
                currentBody = [[], 0];
                bodySegments.push(currentBody);
            }
            else {
                currentBody[0].push(b);
                nonGsParts++;
            }
        }
        let i = bodySegments.length - 1;
        const fileLength = file.length - fileTailMatch;
        for (const b of bodySegments) {
            b[1] = fileLength - (nonGsPartsSums[i--] + b[0].length);
        }
        return !!this.#matchGlobStarBodySections(file, bodySegments, fileIndex, 0, partial, 0, !!fileTailMatch);
    }
    // return false for "nope, not matching"
    // return null for "not matching, cannot keep trying"
    #matchGlobStarBodySections(file, 
    // pattern section, last possible position for it
    bodySegments, fileIndex, bodyIndex, partial, globStarDepth, sawTail) {
        // take the first body segment, and walk from fileIndex to its "after"
        // value at the end
        // If it doesn't match at that position, we increment, until we hit
        // that final possible position, and give up.
        // If it does match, then advance and try to rest.
        // If any of them fail we keep walking forward.
        // this is still a bit recursively painful, but it's more constrained
        // than previous implementations, because we never test something that
        // can't possibly be a valid matching condition.
        const bs = bodySegments[bodyIndex];
        if (!bs) {
            // just make sure that there's no bad dots
            for (let i = fileIndex; i < file.length; i++) {
                sawTail = true;
                const f = file[i];
                if (f === '.' ||
                    f === '..' ||
                    (!this.options.dot && f.startsWith('.'))) {
                    return false;
                }
            }
            return sawTail;
        }
        // have a non-globstar body section to test
        const [body, after] = bs;
        while (fileIndex <= after) {
            const m = this.#matchOne(file.slice(0, fileIndex + body.length), body, partial, fileIndex, 0);
            // if limit exceeded, no match. intentional false negative,
            // acceptable break in correctness for security.
            if (m && globStarDepth < this.maxGlobstarRecursion) {
                // match! see if the rest match. if so, we're done!
                const sub = this.#matchGlobStarBodySections(file, bodySegments, fileIndex + body.length, bodyIndex + 1, partial, globStarDepth + 1, sawTail);
                if (sub !== false) {
                    return sub;
                }
            }
            const f = file[fileIndex];
            if (f === '.' ||
                f === '..' ||
                (!this.options.dot && f.startsWith('.'))) {
                return false;
            }
            fileIndex++;
        }
        // walked off. no point continuing
        return partial || null;
    }
    #matchOne(file, pattern, partial, fileIndex, patternIndex) {
        let fi;
        let pi;
        let pl;
        let fl;
        for (fi = fileIndex,
            pi = patternIndex,
            fl = file.length,
            pl = pattern.length; fi < fl && pi < pl; fi++, pi++) {
            this.debug('matchOne loop');
            let p = pattern[pi];
            let f = file[fi];
            this.debug(pattern, p, f);
            // should be impossible.
            // some invalid regexp stuff in the set.
            /* c8 ignore start */
            if (p === false || p === GLOBSTAR) {
                return false;
            }
            /* c8 ignore stop */
            // something other than **
            // non-magic patterns just have to match exactly
            // patterns with magic have been turned into regexps.
            let hit;
            if (typeof p === 'string') {
                hit = f === p;
                this.debug('string match', p, f, hit);
            }
            else {
                hit = p.test(f);
                this.debug('pattern match', p, f, hit);
            }
            if (!hit)
                return false;
        }
        // Note: ending in / means that we'll get a final ""
        // at the end of the pattern.  This can only match a
        // corresponding "" at the end of the file.
        // If the file ends in /, then it can only match a
        // a pattern that ends in /, unless the pattern just
        // doesn't have any more for it. But, a/b/ should *not*
        // match "a/b/*", even though "" matches against the
        // [^/]*? pattern, except in partial mode, where it might
        // simply not be reached yet.
        // However, a/b/ should still satisfy a/*
        // now either we fell off the end of the pattern, or we're done.
        if (fi === fl && pi === pl) {
            // ran out of pattern and filename at the same time.
            // an exact hit!
            return true;
        }
        else if (fi === fl) {
            // ran out of file, but still had pattern left.
            // this is ok if we're doing the match as part of
            // a glob fs traversal.
            return partial;
        }
        else if (pi === pl) {
            // ran out of pattern, still have file left.
            // this is only acceptable if we're on the very last
            // empty segment of a file with a trailing slash.
            // a/* should match a/b/
            return fi === fl - 1 && file[fi] === '';
            /* c8 ignore start */
        }
        else {
            // should be unreachable.
            throw new Error('wtf?');
        }
        /* c8 ignore stop */
    }
    braceExpand() {
        return braceExpand(this.pattern, this.options);
    }
    parse(pattern) {
        assertValidPattern(pattern);
        const options = this.options;
        // shortcuts
        if (pattern === '**')
            return GLOBSTAR;
        if (pattern === '')
            return '';
        // far and away, the most common glob pattern parts are
        // *, *.*, and *.<ext>  Add a fast check method for those.
        let m;
        let fastTest = null;
        if ((m = pattern.match(starRE))) {
            fastTest = options.dot ? starTestDot : starTest;
        }
        else if ((m = pattern.match(starDotExtRE))) {
            fastTest = (options.nocase ?
                options.dot ?
                    starDotExtTestNocaseDot
                    : starDotExtTestNocase
                : options.dot ? starDotExtTestDot
                    : starDotExtTest)(m[1]);
        }
        else if ((m = pattern.match(qmarksRE))) {
            fastTest = (options.nocase ?
                options.dot ?
                    qmarksTestNocaseDot
                    : qmarksTestNocase
                : options.dot ? qmarksTestDot
                    : qmarksTest)(m);
        }
        else if ((m = pattern.match(starDotStarRE))) {
            fastTest = options.dot ? starDotStarTestDot : starDotStarTest;
        }
        else if ((m = pattern.match(dotStarRE))) {
            fastTest = dotStarTest;
        }
        const re = AST.fromGlob(pattern, this.options).toMMPattern();
        if (fastTest && typeof re === 'object') {
            // Avoids overriding in frozen environments
            Reflect.defineProperty(re, 'test', { value: fastTest });
        }
        return re;
    }
    makeRe() {
        if (this.regexp || this.regexp === false)
            return this.regexp;
        // at this point, this.set is a 2d array of partial
        // pattern strings, or "**".
        //
        // It's better to use .match().  This function shouldn't
        // be used, really, but it's pretty convenient sometimes,
        // when you just want to work with a regex.
        const set = this.set;
        if (!set.length) {
            this.regexp = false;
            return this.regexp;
        }
        const options = this.options;
        const twoStar = options.noglobstar ? star
            : options.dot ? twoStarDot
                : twoStarNoDot;
        const flags = new Set(options.nocase ? ['i'] : []);
        // regexpify non-globstar patterns
        // if ** is only item, then we just do one twoStar
        // if ** is first, and there are more, prepend (\/|twoStar\/)? to next
        // if ** is last, append (\/twoStar|) to previous
        // if ** is in the middle, append (\/|\/twoStar\/) to previous
        // then filter out GLOBSTAR symbols
        let re = set
            .map(pattern => {
            const pp = pattern.map(p => {
                if (p instanceof RegExp) {
                    for (const f of p.flags.split(''))
                        flags.add(f);
                }
                return (typeof p === 'string' ? regExpEscape(p)
                    : p === GLOBSTAR ? GLOBSTAR
                        : p._src);
            });
            pp.forEach((p, i) => {
                const next = pp[i + 1];
                const prev = pp[i - 1];
                if (p !== GLOBSTAR || prev === GLOBSTAR) {
                    return;
                }
                if (prev === undefined) {
                    if (next !== undefined && next !== GLOBSTAR) {
                        pp[i + 1] = '(?:\\/|' + twoStar + '\\/)?' + next;
                    }
                    else {
                        pp[i] = twoStar;
                    }
                }
                else if (next === undefined) {
                    pp[i - 1] = prev + '(?:\\/|\\/' + twoStar + ')?';
                }
                else if (next !== GLOBSTAR) {
                    pp[i - 1] = prev + '(?:\\/|\\/' + twoStar + '\\/)' + next;
                    pp[i + 1] = GLOBSTAR;
                }
            });
            const filtered = pp.filter(p => p !== GLOBSTAR);
            // For partial matches, we need to make the pattern match
            // any prefix of the full path. We do this by generating
            // alternative patterns that match progressively longer prefixes.
            if (this.partial && filtered.length >= 1) {
                const prefixes = [];
                for (let i = 1; i <= filtered.length; i++) {
                    prefixes.push(filtered.slice(0, i).join('/'));
                }
                return '(?:' + prefixes.join('|') + ')';
            }
            return filtered.join('/');
        })
            .join('|');
        // need to wrap in parens if we had more than one thing with |,
        // otherwise only the first will be anchored to ^ and the last to $
        const [open, close] = set.length > 1 ? ['(?:', ')'] : ['', ''];
        // must match entire pattern
        // ending in a * or ** will make it less strict.
        re = '^' + open + re + close + '$';
        // In partial mode, '/' should always match as it's a valid prefix for any pattern
        if (this.partial) {
            re = '^(?:\\/|' + open + re.slice(1, -1) + close + ')$';
        }
        // can match anything, as long as it's not this.
        if (this.negate)
            re = '^(?!' + re + ').+$';
        try {
            this.regexp = new RegExp(re, [...flags].join(''));
            /* c8 ignore start */
        }
        catch {
            // should be impossible
            this.regexp = false;
        }
        /* c8 ignore stop */
        return this.regexp;
    }
    slashSplit(p) {
        // if p starts with // on windows, we preserve that
        // so that UNC paths aren't broken.  Otherwise, any number of
        // / characters are coalesced into one, unless
        // preserveMultipleSlashes is set to true.
        if (this.preserveMultipleSlashes) {
            return p.split('/');
        }
        else if (this.isWindows && /^\/\/[^/]+/.test(p)) {
            // add an extra '' for the one we lose
            return ['', ...p.split(/\/+/)];
        }
        else {
            return p.split(/\/+/);
        }
    }
    match(f, partial = this.partial) {
        this.debug('match', f, this.pattern);
        // short-circuit in the case of busted things.
        // comments, etc.
        if (this.comment) {
            return false;
        }
        if (this.empty) {
            return f === '';
        }
        if (f === '/' && partial) {
            return true;
        }
        const options = this.options;
        // windows: need to use /, not \
        if (this.isWindows) {
            f = f.split('\\').join('/');
        }
        // treat the test path as a set of pathparts.
        const ff = this.slashSplit(f);
        this.debug(this.pattern, 'split', ff);
        // just ONE of the pattern sets in this.set needs to match
        // in order for it to be valid.  If negating, then just one
        // match means that we have failed.
        // Either way, return on the first hit.
        const set = this.set;
        this.debug(this.pattern, 'set', set);
        // Find the basename of the path by looking for the last non-empty segment
        let filename = ff[ff.length - 1];
        if (!filename) {
            for (let i = ff.length - 2; !filename && i >= 0; i--) {
                filename = ff[i];
            }
        }
        for (const pattern of set) {
            let file = ff;
            if (options.matchBase && pattern.length === 1) {
                file = [filename];
            }
            const hit = this.matchOne(file, pattern, partial);
            if (hit) {
                if (options.flipNegate) {
                    return true;
                }
                return !this.negate;
            }
        }
        // didn't get any hits.  this is success if it's a negative
        // pattern, failure otherwise.
        if (options.flipNegate) {
            return false;
        }
        return this.negate;
    }
    static defaults(def) {
        return minimatch.defaults(def).Minimatch;
    }
}
/* c8 ignore stop */
minimatch.AST = AST;
minimatch.Minimatch = Minimatch;
minimatch.escape = escape;
minimatch.unescape = unescape;

function langFilePathToRegex(langFilePath) {
  const re = makeRe(langFilePath, {
    matchBase: true
  });
  const reString = re.source;
  const modified = reString.replace("\\{\\{lang\\}\\}", "([a-zA-Z_-]+)");
  return new RegExp(modified);
}
function namespaceFilePathToRegex(namespaceFilePath) {
  const re = makeRe(namespaceFilePath, {
    matchBase: true
  });
  const reString = re.source;
  const modified = reString.replace("\\{\\{namespace\\}\\}", "(.+)").replace("\\{\\{source\\}\\}", "(.+)");
  return new RegExp(modified);
}

var __defProp$1 = Object.defineProperty;
var __defNormalProp$1 = (obj, key, value) => key in obj ? __defProp$1(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField$1 = (obj, key, value) => __defNormalProp$1(obj, typeof key !== "symbol" ? key + "" : key, value);
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
    __publicField$1(this, "translationFilesConfig", translationFilesConfig);
    __publicField$1(this, "allLanguagesInConfig", /* @__PURE__ */ new Set());
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
          quality: translation.quality,
          currentValue: translation.currentVersion.value
        };
      } else {
        mergedKeysByKey[serverKey.key].translations[lang] = {
          server: {
            id: translation.id,
            quality: translation.quality,
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

// lib/v3/isZodErrorLike.ts
function isZodErrorLike(err) {
  return err instanceof Error && err.name === "ZodError" && "issues" in err && Array.isArray(err.issues);
}

// lib/v3/ValidationError.ts
var ValidationError = class extends Error {
  name;
  details;
  constructor(message, options) {
    super(message, options);
    this.name = "ZodValidationError";
    this.details = getIssuesFromErrorOptions(options);
  }
  toString() {
    return this.message;
  }
};
function getIssuesFromErrorOptions(options) {
  if (options) {
    const cause = options.cause;
    if (isZodErrorLike(cause)) {
      return cause.issues;
    }
  }
  return [];
}

// lib/utils/NonEmptyArray.ts
function isNonEmptyArray(value) {
  return value.length !== 0;
}

// lib/utils/stringify.ts
function stringifySymbol(symbol) {
  return symbol.description ?? "";
}

// lib/utils/joinPath.ts
var identifierRegex = /[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*/u;
function joinPath(path) {
  if (path.length === 1) {
    let propertyKey = path[0];
    if (typeof propertyKey === "symbol") {
      propertyKey = stringifySymbol(propertyKey);
    }
    return propertyKey.toString() || '""';
  }
  return path.reduce((acc, propertyKey) => {
    if (typeof propertyKey === "number") {
      return acc + "[" + propertyKey.toString() + "]";
    }
    if (typeof propertyKey === "symbol") {
      propertyKey = stringifySymbol(propertyKey);
    }
    if (propertyKey.includes('"')) {
      return acc + '["' + escapeQuotes(propertyKey) + '"]';
    }
    if (!identifierRegex.test(propertyKey)) {
      return acc + '["' + propertyKey + '"]';
    }
    const separator = acc.length === 0 ? "" : ".";
    return acc + separator + propertyKey;
  }, "");
}
function escapeQuotes(str) {
  return str.replace(/"/g, '\\"');
}

// lib/v3/config.ts
var ISSUE_SEPARATOR = "; ";
var MAX_ISSUES_IN_MESSAGE = 99;
var PREFIX = "Validation error";
var PREFIX_SEPARATOR = ": ";
var UNION_SEPARATOR = ", or ";

// lib/v3/MessageBuilder.ts
function createMessageBuilder(props = {}) {
  const {
    issueSeparator = ISSUE_SEPARATOR,
    unionSeparator = UNION_SEPARATOR,
    prefixSeparator = PREFIX_SEPARATOR,
    prefix = PREFIX,
    includePath = true,
    maxIssuesInMessage = MAX_ISSUES_IN_MESSAGE
  } = props;
  return (issues) => {
    const message = issues.slice(0, maxIssuesInMessage).map(
      (issue) => getMessageFromZodIssue({
        issue,
        issueSeparator,
        unionSeparator,
        includePath
      })
    ).join(issueSeparator);
    return prefixMessage(message, prefix, prefixSeparator);
  };
}
function getMessageFromZodIssue(props) {
  const { issue, issueSeparator, unionSeparator, includePath } = props;
  if (issue.code === ZodIssueCode.invalid_union) {
    return issue.unionErrors.reduce((acc, zodError) => {
      const newIssues = zodError.issues.map(
        (issue2) => getMessageFromZodIssue({
          issue: issue2,
          issueSeparator,
          unionSeparator,
          includePath
        })
      ).join(issueSeparator);
      if (!acc.includes(newIssues)) {
        acc.push(newIssues);
      }
      return acc;
    }, []).join(unionSeparator);
  }
  if (issue.code === ZodIssueCode.invalid_arguments) {
    return [
      issue.message,
      ...issue.argumentsError.issues.map(
        (issue2) => getMessageFromZodIssue({
          issue: issue2,
          issueSeparator,
          unionSeparator,
          includePath
        })
      )
    ].join(issueSeparator);
  }
  if (issue.code === ZodIssueCode.invalid_return_type) {
    return [
      issue.message,
      ...issue.returnTypeError.issues.map(
        (issue2) => getMessageFromZodIssue({
          issue: issue2,
          issueSeparator,
          unionSeparator,
          includePath
        })
      )
    ].join(issueSeparator);
  }
  if (includePath && isNonEmptyArray(issue.path)) {
    if (issue.path.length === 1) {
      const identifier = issue.path[0];
      if (typeof identifier === "number") {
        return `${issue.message} at index ${identifier}`;
      }
    }
    return `${issue.message} at "${joinPath(issue.path)}"`;
  }
  return issue.message;
}
function prefixMessage(message, prefix, prefixSeparator) {
  if (prefix !== null) {
    if (message.length > 0) {
      return [prefix, message].join(prefixSeparator);
    }
    return prefix;
  }
  if (message.length > 0) {
    return message;
  }
  return PREFIX;
}
function fromZodErrorWithoutRuntimeCheck(zodError, options = {}) {
  const zodIssues = zodError.errors;
  let message;
  if (isNonEmptyArray(zodIssues)) {
    const messageBuilder = createMessageBuilderFromOptions2(options);
    message = messageBuilder(zodIssues);
  } else {
    message = zodError.message;
  }
  return new ValidationError(message, { cause: zodError });
}
function createMessageBuilderFromOptions2(options) {
  if ("messageBuilder" in options) {
    return options.messageBuilder;
  }
  return createMessageBuilder(options);
}

// lib/v3/toValidationError.ts
var toValidationError = (options = {}) => (err) => {
  if (isZodErrorLike(err)) {
    return fromZodErrorWithoutRuntimeCheck(err, options);
  }
  if (err instanceof Error) {
    return new ValidationError(err.message, { cause: err });
  }
  return new ValidationError("Unknown error");
};

// lib/v3/fromError.ts
function fromError(err, options = {}) {
  return toValidationError(options)(err);
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

function assertNoNestedKeyCollisions(keys) {
  const names = new Set(keys);
  for (const key of keys) {
    const parts = key.split(".");
    while (parts.length > 1) {
      parts.pop();
      const parent = parts.join(".");
      if (names.has(parent)) {
        throw new Error(
          `Keys "${parent}" and "${key}" cannot share nested translation output. Choose different keys or configure nested: false.`
        );
      }
    }
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
  assertNoNestedKeyCollisions([...keys].map(([key]) => key));
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

function normalizePullPath(path) {
  return path.normalize("NFC").toLowerCase();
}

function assertNoPullPathCollisions(files) {
  const paths = /* @__PURE__ */ new Map();
  for (const [path, content] of Object.entries(files)) {
    if (content === null) continue;
    const normalized = normalizePullPath(path);
    const previous = paths.get(normalized);
    if (previous !== void 0 && previous !== path) {
      throw new Error(
        `Translation paths "${previous}" and "${path}" differ only by case or Unicode normalization. Use distinct destination paths.`
      );
    }
    paths.set(normalized, path);
  }
}

function invertMap(map) {
  if (!map) return {};
  return Object.fromEntries(
    Object.entries(map).map(([local, remote]) => [remote, local])
  );
}

function resolveTranslationPath(config, state, language) {
  if (config.namespace !== void 0 ? state.namespace !== config.namespace : !config.path.includes("{{namespace}}") && state.namespace !== "")
    return null;
  let path = config.path.replace(/^\.\//, "");
  for (const [name, value] of [
    ["lang", language],
    ["namespace", state.namespace],
    ["source", state.source]
  ]) {
    if (name === void 0 || value === void 0 || !path.includes(`{{${name}}}`))
      continue;
    if (!value.trim()) return null;
    if (/[\\\u0000-\u001f*?\[\]{}]/.test(value) || /^[a-z]:/i.test(value) || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(
        `Invalid ${name} substitution ${JSON.stringify(value)} for ${config.path}`
      );
    }
    path = path.replaceAll(`{{${name}}}`, () => value);
  }
  return path;
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

async function prepareFilesToPull({
  mergedKeysInLocalOrder,
  mergedKeysByKeyByNamespace,
  translationFilesConfig,
  allLanguages,
  emptyValueString,
  selectedKeys,
  allFilesByPattern,
  keepLocalOnly
}) {
  const files = /* @__PURE__ */ new Map();
  const serverKeys = Object.values(mergedKeysByKeyByNamespace).flatMap(
    Object.values
  );
  const useServer = (key) => !selectedKeys || key.server !== void 0 && selectedKeys.has(getComparisonKey(key));
  const countedPaths = /* @__PURE__ */ new Set();
  const localLanguageFor = (config, remoteLanguage) => {
    const remoteToLocal = invertMap(config.mapLocalToRemote);
    const languages = config.languages ?? allLanguages.map(
      (language) => remoteToLocal[language.code] ?? language.code
    );
    for (const localLanguage of languages) {
      if ((config.mapLocalToRemote?.[localLanguage] ?? localLanguage) === remoteLanguage)
        return localLanguage;
    }
    return null;
  };
  const destinationsFor = (key, remoteLanguage, current) => {
    if (!key.server || !useServer(key)) return [];
    const state = {
      key: key.key,
      namespace: key.server.namespace,
      source: key.server.source
    };
    const paths = [];
    for (const candidate of translationFilesConfig) {
      if (candidate.transform) continue;
      const language = candidate === current.config ? current.localLanguage : localLanguageFor(candidate, remoteLanguage);
      if (language === null) continue;
      const path = resolveTranslationPath(candidate, state, language);
      if (path !== null) paths.push(path);
    }
    return paths;
  };
  for (const config of translationFilesConfig) {
    if (config.transform) continue;
    const localFiles = allFilesByPattern[config.path.replace(/^\.\//, "")] ?? [];
    const remoteToLocal = invertMap(config.mapLocalToRemote);
    const languages = config.languages ?? allLanguages.map(
      (language) => remoteToLocal[language.code] ?? language.code
    );
    for (const localLanguage of languages) {
      const remoteLanguage = config.mapLocalToRemote?.[localLanguage] ?? localLanguage;
      const ensureFile = (path) => {
        let file = files.get(path);
        if (!file) {
          file = {
            config,
            language: remoteLanguage,
            keys: /* @__PURE__ */ new Map(),
            localOnly: [],
            relocated: false,
            serverWrote: false
          };
          files.set(path, file);
        }
        return file;
      };
      for (const localFile of localFiles.filter(
        (file) => file.lang === remoteLanguage
      )) {
        if (countedPaths.has(localFile.path)) continue;
        countedPaths.add(localFile.path);
        const originalKeys = mergedKeysInLocalOrder[localFile.path]?.keys ?? [];
        const output = ensureFile(localFile.path);
        for (const key of originalKeys) {
          const destinations = destinationsFor(key, remoteLanguage, {
            config,
            localLanguage
          });
          if (destinations.includes(localFile.path)) continue;
          if (destinations.length > 0) {
            output.relocated = true;
            continue;
          }
          if (!key.server && !selectedKeys && !keepLocalOnly) {
            output.localOnly.push(key);
            continue;
          }
          const value = key.translations[remoteLanguage]?.local?.value;
          if (value != null || config.pullWithEmptyValues) {
            output.keys.set(key.key, {
              value: value ?? emptyValueString,
              description: key.local?.description,
              meta: key.local?.meta ?? {}
            });
          }
        }
      }
      for (const key of serverKeys) {
        if (!key.server || !useServer(key)) continue;
        const path = resolveTranslationPath(
          config,
          { key: key.key, ...key.server },
          localLanguage
        );
        if (path === null) continue;
        const translation = key.translations[remoteLanguage]?.server;
        const value = translation?.currentValue;
        if (value === void 0 && !config.pullWithEmptyValues) continue;
        const output = ensureFile(path);
        output.serverWrote = true;
        output.keys.set(key.key, {
          value: value ?? emptyValueString,
          description: key.server.description,
          meta: key.local?.meta ?? {}
        });
      }
    }
  }
  const result = {};
  const removed = /* @__PURE__ */ new Map();
  for (const [path, file] of files) {
    if (!file.serverWrote && !file.relocated && file.localOnly.length === 0)
      continue;
    for (const key of file.localOnly) {
      const entry = removed.get(getComparisonKey(key)) ?? {
        key: key.key,
        namespace: key.local?.namespace ?? "",
        paths: []
      };
      entry.paths.push(path);
      removed.set(getComparisonKey(key), entry);
    }
    const placementPattern = file.config.path.includes("{{source}}") || file.config.path.includes("{{namespace}}");
    if (file.keys.size === 0 && placementPattern) {
      result[path] = null;
      continue;
    }
    const format = file.config.format;
    if (!format) throw new Error(`Could not determine file format for ${path}`);
    const ordered = /* @__PURE__ */ new Map();
    for (const key of mergedKeysInLocalOrder[path]?.keys ?? []) {
      const value = file.keys.get(key.key);
      if (value) ordered.set(key.key, value);
    }
    for (const [key, value] of file.keys) ordered.set(key, value);
    result[path] = generateTranslationFile(
      sortKeys({ sortBy: file.config.sortBy, keys: [...ordered] }),
      format,
      file.language,
      file.config
    );
  }
  assertNoPullPathCollisions(result);
  return { files: result, removedKeys: [...removed.values()] };
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
  const keysToRemove = comparison.keysToRemove ?? [];
  if (keysToRemove.length > 0 && !options?.quiet) {
    console.info(`
${keysToRemove.length} server-only keys will be archived:`);
    for (const key of keysToRemove.slice(0, 10)) {
      console.info(`    ${formatNamespacedKey(key)}`);
    }
    if (keysToRemove.length > 10) {
      console.info(`    ... and ${keysToRemove.length - 10} more`);
    }
  }
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
    const allResult = renderKeyCards(newKeys, termWidth, {
      limit: newKeys.length
    });
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
    if (newKeyNames.has(comparisonKey) || seen.has(comparisonKey))
      return false;
    seen.add(comparisonKey);
    return true;
  });
  if (translationKeys.length > 0) {
    const langCount = Object.keys(
      missingTranslationsOnServerPerLanguage
    ).length;
    greenInfo(
      `
${Bold}${translationKeys.length} missing translations across ${langCount} languages:${Reset}`
    );
    const { text, hiddenCount } = renderKeyCards(translationKeys, termWidth, {
      onlyChanges: true
    });
    console.info(text);
    const allResult = renderKeyCards(translationKeys, termWidth, {
      limit: translationKeys.length,
      onlyChanges: true
    });
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
        throw new Error(
          `Expected both local and server translation for key "${key.key}" lang "${lang}"`
        );
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
    console.info(
      `  ${Dim}Project:${Reset}   ${FgBlue}${appHost}/app/project/${projectInfo.id}${Reset}`
    );
    console.info(
      `  ${Dim}Translate:${Reset} ${FgBlue}${appHost}/app/project/${projectInfo.id}/translate${Reset}
`
    );
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
  const keysToRemove = comparison.keysToRemove?.filter(
    (key) => selectedKeys.has(getComparisonKey(key))
  );
  const needPush = (keysToRemove?.length ?? 0) > 0 || Object.keys(missingKeysOnServer).length > 0 || Object.keys(missingTranslationsOnServerPerLanguage).length > 0 || Object.keys(differentTranslationsLanguage).length > 0 || missingLanguagesOnServer.size > 0;
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
    keysToRemove
  };
}

async function applyPullPlan(files, writeFile, removeFile) {
  assertNoPullPathCollisions(files);
  const written = /* @__PURE__ */ new Set();
  for (const [file, content] of Object.entries(files)) {
    if (content !== null) {
      await writeFile(file, content);
      written.add(normalizePullPath(file));
    }
  }
  for (const [file, content] of Object.entries(files)) {
    if (content === null && !written.has(normalizePullPath(file))) {
      await removeFile(file);
    }
  }
}

function computePullResult(input) {
  const result = {
    addedTranslations: [],
    updatedTranslations: [],
    removedTranslations: [],
    remainingMissingTranslations: [],
    removedKeys: input.removedKeys,
    changedFiles: input.changedFiles
  };
  const namespaces = /* @__PURE__ */ new Set([
    ...Object.keys(input.before),
    ...Object.keys(input.after)
  ]);
  for (const namespace of namespaces) {
    const before = input.before[namespace] ?? {};
    const after = input.after[namespace] ?? {};
    for (const key of /* @__PURE__ */ new Set([
      ...Object.keys(before),
      ...Object.keys(after)
    ])) {
      const original = before[key];
      const pulled = after[key];
      const languages = /* @__PURE__ */ new Set([
        ...Object.keys(original?.translations ?? {}),
        ...Object.keys(pulled?.translations ?? {})
      ]);
      for (const language of languages) {
        const previous = original?.translations[language]?.local?.value;
        const current = pulled?.translations[language]?.local?.value;
        const translation = { key, namespace, language };
        if (previous == null && current != null)
          result.addedTranslations.push(translation);
        else if (previous != null && current == null)
          result.removedTranslations.push(translation);
        else if (previous !== current && current != null)
          result.updatedTranslations.push(translation);
      }
      if (!original?.server || input.selectedKeys && !input.selectedKeys.has(getComparisonKey({ key, namespace })))
        continue;
      const expectedLanguages = /* @__PURE__ */ new Set();
      for (const config of input.translationFilesConfig) {
        const remoteToLocal = invertMap(config.mapLocalToRemote);
        const localLanguages = config.languages ?? input.languages.map(
          (language) => remoteToLocal[language] ?? language
        );
        for (const localLanguage of localLanguages) {
          const matches = config.transform ? config.namespace === namespace : resolveTranslationPath(
            config,
            { ...original.server },
            localLanguage
          ) !== null;
          if (matches)
            expectedLanguages.add(
              config.mapLocalToRemote?.[localLanguage] ?? localLanguage
            );
        }
      }
      for (const language of expectedLanguages) {
        if (pulled?.translations[language]?.local?.value == null) {
          result.remainingMissingTranslations.push({
            key,
            namespace,
            language
          });
        }
      }
    }
  }
  return result;
}

async function confirmLocalOnlyRemoval(removedKeys, prompt) {
  const preview = removedKeys.slice(0, 5);
  const remaining = removedKeys.length - preview.length;
  const keyList = preview.map((key) => formatNamespacedKey(key)).join(", ") + (remaining > 0 ? `, ... +${remaining} more` : "");
  console.info(
    `
  ${FgYellow}${removedKeys.length} local key${removedKeys.length !== 1 ? "s" : ""} not on the server will be removed from local files:${Reset}`
  );
  console.info(`  ${Dim}${keyList}${Reset}
`);
  return prompt.confirm({
    message: "Remove them from local files? (No keeps them in place)"
  });
}

async function pullTransformFiles({
  transformConfigs,
  transforms,
  mergedKeysByKeyByNamespace,
  allLanguages,
  selectedKeys,
  fileAPI,
  cwd
}) {
  const filesToPull = {};
  const previousContents = {};
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
        const serverValue = translation?.server?.currentValue;
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
    previousContents[pathPattern] = currentContent;
    try {
      filesToPull[pathPattern] = transform.pull(translations, currentContent);
    } catch (err) {
      throw new Error(
        `Transform pull failed for "${config.path}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return { files: filesToPull, previousContents };
}

async function readPullOutput(input) {
  const contents = new Map(
    Object.values(input.allFilesByPattern).flatMap(
      (files) => files.map((file) => [file.path, file.content])
    )
  );
  for (const [path, content] of Object.entries(input.previousContents)) {
    if (content !== null) contents.set(path, content);
  }
  const changedFiles = [];
  for (const [path, content] of Object.entries(input.files)) {
    if (content === null) {
      if (contents.delete(path)) changedFiles.push(path);
    } else {
      if (contents.get(path) !== content) changedFiles.push(path);
      contents.set(path, content);
    }
  }
  const fileAPI = {
    async readFile(path) {
      const content = contents.get(path);
      if (content === void 0)
        throw new Error(`Pull output not found: ${path}`);
      return content;
    },
    async fileExists(path) {
      return contents.has(path);
    },
    async glob(pattern) {
      return [...contents.keys()].filter((path) => minimatch(path, pattern));
    }
  };
  const { mergedKeysByKeyByNamespace } = await gatherLocalKeys({
    allFilesByPattern: await gatherLocalFiles(
      input.translationFilesConfig,
      fileAPI
    ),
    keySeparator: input.keySeparator,
    emptyValueString: input.emptyValueString
  });
  const transformConfigs = input.translationFilesConfig.filter(
    (config) => config.transform
  );
  if (transformConfigs.length > 0) {
    const transformed = await gatherTransformKeys({
      transformConfigs,
      transforms: input.transforms,
      fileAPI,
      emptyValueString: input.emptyValueString
    });
    for (const [namespace, keys] of Object.entries(
      transformed.mergedKeysByKeyByNamespace
    )) {
      mergedKeysByKeyByNamespace[namespace] ?? (mergedKeysByKeyByNamespace[namespace] = {});
      Object.assign(mergedKeysByKeyByNamespace[namespace], keys);
    }
  }
  return { keys: mergedKeysByKeyByNamespace, changedFiles };
}

function createKeySelectionMatcher(keys, namespaces) {
  const compiled = /* @__PURE__ */ new Map();
  const match = (value, pattern) => {
    let matcher = compiled.get(pattern);
    if (!matcher) {
      matcher = new Minimatch(pattern, { nocomment: true, dot: true });
      compiled.set(pattern, matcher);
    }
    return matcher.match(value);
  };
  const matchNamespace = (namespace, pattern) => namespace === "" && (pattern === "*" || pattern === "**") || match(namespace, pattern);
  const keyPatterns = [...new Set(keys)];
  const namespacePatterns = [...new Set(namespaces)];
  return (key) => {
    const namespace = getNamespace$1(key);
    const matchedKeys = keyPatterns.filter((pattern) => {
      if (getComparisonKey(key) === pattern || namespace === "" && key.key === pattern)
        return true;
      const colon = pattern.indexOf(":");
      if (colon !== -1)
        return matchNamespace(namespace, pattern.slice(0, colon)) && match(key.key, pattern.slice(colon + 1));
      return (pattern === "*" || pattern === "**" || namespaces.length > 0 || namespace === "") && match(key.key, pattern);
    });
    const matchedNamespaces = namespacePatterns.filter(
      (pattern) => matchNamespace(namespace, pattern)
    );
    return {
      matchedKeys,
      matchedNamespaces,
      matches: (!keys.length || matchedKeys.length > 0) && (!namespaces.length || matchedNamespaces.length > 0)
    };
  };
}

function isGlob(pattern) {
  return /[*?[\]{}!]/.test(pattern);
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
  const match = createKeySelectionMatcher(requestedKeys, requestedNamespaces);
  for (const key of allKeys) {
    const {
      matchedKeys: matchedKeyPatterns,
      matchedNamespaces: matchedNamespacePatterns,
      matches
    } = match(key);
    for (const p of matchedKeyPatterns)
      keyHits.set(p, (keyHits.get(p) ?? 0) + 1);
    for (const p of matchedNamespacePatterns)
      namespaceHits.set(p, (namespaceHits.get(p) ?? 0) + 1);
    if (matches) {
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

async function pullTranslations(input) {
  const { options, mergedKeysByKeyByNamespace } = input;
  let selectedKeys = options.selectedKeys;
  if (!selectedKeys && ((options.keys?.length ?? 0) > 0 || (options.namespaces?.length ?? 0) > 0)) {
    selectedKeys = resolveSelectedKeys(
      options.keys ?? [],
      mergedKeysByKeyByNamespace,
      options.namespaces ?? []
    );
  }
  if (options.onlyExisting) {
    const localKeys = /* @__PURE__ */ new Set();
    for (const keys of Object.values(mergedKeysByKeyByNamespace)) {
      for (const key of Object.values(keys)) {
        if (key.local) localKeys.add(getComparisonKey(key));
      }
    }
    selectedKeys = selectedKeys ? new Set([...selectedKeys].filter((key) => localKeys.has(key))) : localKeys;
  }
  const preparePull = (keepLocalOnly) => prepareFilesToPull({
    mergedKeysInLocalOrder: input.mergedKeysInLocalOrder,
    mergedKeysByKeyByNamespace,
    translationFilesConfig: input.translationFilesConfig,
    allLanguages: input.projectInfo.languages,
    emptyValueString: input.emptyValueString,
    selectedKeys,
    allFilesByPattern: input.allFilesByPattern,
    keepLocalOnly
  });
  let plan = await preparePull(options.keepLocalOnly ?? false);
  if (plan.removedKeys.length > 0 && !await confirmLocalOnlyRemoval(plan.removedKeys, input.prompt)) {
    plan = await preparePull(true);
  }
  const transformed = input.transformConfigs.length > 0 && input.fileAPI ? await pullTransformFiles({
    transformConfigs: input.transformConfigs,
    transforms: input.transforms,
    mergedKeysByKeyByNamespace,
    allLanguages: input.projectInfo.languages,
    selectedKeys,
    fileAPI: input.fileAPI,
    cwd: input.cwd
  }) : { files: {}, previousContents: {} };
  const files = { ...plan.files, ...transformed.files };
  const reportConfigs = [
    ...input.translationFilesConfig.filter(
      (config) => !config.transform && !input.transformConfigs.some(
        (transform) => transform.path === config.path
      )
    ),
    ...input.transformConfigs.map((config) => ({
      ...config,
      transform: config.transform ?? config.path
    }))
  ];
  const output = await readPullOutput({
    files,
    previousContents: transformed.previousContents,
    allFilesByPattern: input.allFilesByPattern,
    translationFilesConfig: reportConfigs,
    transforms: input.transforms,
    keySeparator: input.projectInfo.keySeparator,
    emptyValueString: input.emptyValueString
  });
  const result = computePullResult({
    before: mergedKeysByKeyByNamespace,
    after: output.keys,
    translationFilesConfig: reportConfigs,
    languages: input.projectInfo.languages.map((language) => language.code),
    selectedKeys,
    removedKeys: plan.removedKeys,
    changedFiles: output.changedFiles
  });
  await applyPullPlan(files, input.writeFile, input.removeFile);
  if (plan.removedKeys.length > 0) {
    greenInfo(
      `\u2713 Removed ${plan.removedKeys.length} local key${plan.removedKeys.length !== 1 ? "s" : ""} not on the server`
    );
  }
  return result;
}

async function runCli({
  cliInput,
  allFilesByPattern,
  projectInfo,
  allServerKeys,
  withheldChanges,
  localKeys,
  getFilePatternOrPath,
  writeFile,
  removeFile,
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
  } = localKeys ?? await gatherSyncLocalKeys({
    allFilesByPattern,
    keySeparator: projectInfo.keySeparator,
    emptyValueString,
    transformConfigs,
    transforms,
    fileAPI,
    cwd
  });
  const hasTransforms = transformConfigs.length > 0 && fileAPI;
  let pullResult;
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
  if (cliInput.action === "push") {
    if (cliInput.keysToRemove && cliInput.keysToRemove.length > 0) {
      comparison.keysToRemove = cliInput.keysToRemove;
    } else if (cliInput.prune) {
      comparison.keysToRemove = Object.values(
        comparison.missingKeysOnLocal
      ).map((key) => ({
        key: key.key,
        namespace: key.server?.namespace ?? ""
      }));
    }
    if (comparison.keysToRemove?.length) comparison.needPush = true;
  }
  const filterKeys = cliInput.action === "push" ? cliInput.keys : cliInput.action === "pull" ? cliInput.options.keys : cliInput.action === "status" ? cliInput.keys : void 0;
  const filterNamespaces = cliInput.action === "push" ? cliInput.namespaces : cliInput.action === "pull" ? cliInput.options.namespaces : cliInput.action === "status" ? cliInput.namespaces : void 0;
  const hasSelectionFilter = (filterKeys?.length ?? 0) > 0 || (filterNamespaces?.length ?? 0) > 0;
  let selectedKeys = cliInput.action === "status" ? cliInput.selectedKeys : cliInput.action === "pull" ? cliInput.options.selectedKeys : void 0;
  let pushFilterSummary;
  let scopedComparison = comparison;
  if (hasSelectionFilter || selectedKeys) {
    selectedKeys ?? (selectedKeys = resolveSelectedKeys(
      filterKeys ?? [],
      mergedKeysByKeyByNamespace,
      filterNamespaces ?? []
    ));
    const keysBefore = Object.keys(comparison.missingOrDifferentKeysOnServer).length + (comparison.keysToRemove?.length ?? 0);
    scopedComparison = filterComparisonBySelectedKeys(comparison, selectedKeys);
    if (cliInput.action === "push") {
      const pushed = Object.keys(scopedComparison.missingOrDifferentKeysOnServer).length + (scopedComparison.keysToRemove?.length ?? 0);
      pushFilterSummary = {
        pushed,
        withheld: withheldChanges ?? keysBefore - pushed,
        patterns: [...filterKeys ?? [], ...filterNamespaces ?? []].join(
          ", "
        )
      };
    }
  }
  if (cliInput.action === "push" && scopedComparison.keysToRemove?.length && !cliInput.allowEmptyPrune && !Object.values(allFilesByPattern).some((files) => files.length > 0) && !hasTransforms) {
    throw new Error(
      "No configured local translation files were found. Refusing to archive server keys. Check your file paths or use --allow-empty-prune to intentionally prune without local files."
    );
  }
  const statusData = computeStatus(
    scopedComparison,
    languagesOnServer,
    languagesOnLocal
  );
  let pushResult;
  if (cliInput.action === "push" && !cliInput.dryRun) {
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
    pullResult = await pullTranslations({
      options: { ...cliInput.options, selectedKeys },
      mergedKeysInLocalOrder,
      mergedKeysByKeyByNamespace,
      translationFilesConfig,
      projectInfo,
      emptyValueString,
      allFilesByPattern,
      prompt,
      writeFile,
      removeFile,
      transformConfigs,
      transforms,
      fileAPI,
      cwd
    });
  }
  return {
    comparison: scopedComparison,
    status: statusData,
    pushResult,
    pullResult,
    pushFilter: pushFilterSummary,
    mergedKeysByKeyByNamespace
  };
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

const keyFilePath = path$2.join(import.meta.dirname, "babli_k");
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

async function humanReviewCommand(input) {
  const parsed = await loadConfigFile(CliFileApi);
  if (!parsed) throw new Error("No babli.json in this directory.");
  const accessToken = await loadKeyOrTokenFile();
  const host = parsed.host ?? defaultHost;
  const projectId = parsed.projectId;
  if (input.action === "status") {
    const result2 = await requestCliJson(
      `${host}/api/cli/${projectId}/human-review/status?invitationId=${encodeURIComponent(input.invitationId)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    console.info(JSON.stringify(result2, null, 2));
    return 0;
  }
  const translationIds = await resolveTranslationIds(
    host,
    projectId,
    accessToken,
    input.options
  );
  const requestId = input.options.requestId ?? randomUUID();
  const result = await requestCliJson(
    `${host}/api/cli/${projectId}/human-review/request`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        requestId,
        reason: input.options.reason,
        translationIds,
        sourceLanguageCode: input.options.source
      })
    }
  );
  if (input.options.json) console.info(JSON.stringify(result, null, 2));
  else {
    const receipt = result;
    console.info(`Review link: ${receipt.url ?? ""}`);
    console.info(
      `Subscribers: ${receipt.subscriber_count ?? 0}. Emails queued: ${receipt.notified_count ?? 0}. Languages: ${(receipt.languages ?? []).join(", ")}`
    );
    console.info(`Request ID: ${requestId}`);
  }
  return 0;
}
async function resolveTranslationIds(host, projectId, accessToken, options) {
  if (options.translationId.length) return options.translationId;
  if (!options.key.length) {
    throw new Error(
      "Pass --translation-id or --key for the wording to review."
    );
  }
  const { keys } = await listCliKeys(host, projectId, accessToken, {
    includeArchived: false
  });
  const wanted = new Set(options.key);
  const languages = new Set(options.language);
  const ids = keys.flatMap((key) => {
    const names = [
      key.key,
      key.namespace ? `${key.namespace}:${key.key}` : key.key
    ];
    if (!names.some((name) => wanted.has(name))) return [];
    return key.translations.flatMap((translation) => {
      const code = translation.language?.code;
      if (languages.size && (!code || !languages.has(code))) return [];
      return [translation.id];
    });
  });
  if (!ids.length) {
    throw new Error(
      "No matching translations. Check the key name and language code."
    );
  }
  return ids;
}

async function readMetadataUpdate(options, flags) {
  if (options.descriptionFile === "-" && options.instructionsFile === "-") {
    throw new Error("Only one field can read from stdin.");
  }
  const fields = {
    name: options.name,
    description: options.description,
    instructions: options.instructions
  };
  for (const field of ["description", "instructions"]) {
    fields[field] = await readMutuallyExclusiveValue({
      direct: options[field],
      directName: `--${field}`,
      file: options[`${field}File`],
      fileName: `--${field}-file`,
      flags
    });
  }
  if (fields.name !== void 0 && !fields.name.trim())
    throw new Error("Name cannot be blank.");
  if (Object.values(fields).every((value) => value === void 0))
    throw new Error("Provide at least one field to update.");
  return fields;
}

async function organizationCommand(ctx, input) {
  if (input.action === "list") {
    const organizations = await listCliOrganizations(ctx.host, ctx.accessToken);
    if (ctx.flags.json)
      printJson({
        version: 1,
        command: "organization_list",
        status: "ok",
        organizations
      });
    else
      for (const org of organizations)
        console.info(`${org.id} ${org.name} (${org.role})`);
    return;
  }
  const id = input.options.organization;
  if (!id) throw new Error("Provide --organization.");
  const body = input.action === "update" ? await readMetadataUpdate(input.options, ctx.flags) : void 0;
  const result = await administrationRequest(
    ctx,
    `organizations/${encodeURIComponent(id)}`,
    input.action === "get" ? "GET" : "PATCH",
    body
  );
  if (ctx.flags.json)
    printJson({
      version: 1,
      command: `organization_${input.action}`,
      status: input.action === "get" ? "ok" : "updated",
      ...result
    });
  else
    console.info(
      `${result.organization.name}
id: ${result.organization.id}
instructions: ${result.organization.instructions}`
    );
}

async function projectMetadataCommand(ctx, action, options) {
  const projectId = options.project ?? ctx.projectId;
  if (!projectId)
    throw new Error(
      "Provide --project or run from a directory with babli.json."
    );
  const path = `${encodeURIComponent(projectId)}/project${options.includeInherited ? "?includeInherited=true" : ""}`;
  const body = action === "update" ? await readMetadataUpdate(options, ctx.flags) : void 0;
  const result = await administrationRequest(ctx, path, action === "get" ? "GET" : "PATCH", body);
  if (ctx.flags.json) {
    printJson({
      version: 1,
      command: `project_${action}`,
      status: action === "get" ? "ok" : "updated",
      project: result.project
    });
    return;
  }
  const project = result.project;
  console.info(
    `${project.name}
id: ${project.id}
description: ${project.description}
instructions: ${project.instructions}`
  );
  if (project.organization) {
    console.info(
      `company: ${project.organization.name} (${project.organization.id})
company instructions: ${project.organization.instructions}
Project instructions take precedence where they conflict.`
    );
  }
}

const defaultReviewModel = "gemini-4-argon";
const reviewModel = literalType(defaultReviewModel);

const reviewSelection = objectType({
  jobId: stringType().uuid().optional(),
  keys: arrayType(stringType().min(1)).default([]),
  namespaces: arrayType(stringType()).default([]),
  keyIds: arrayType(stringType().uuid()).optional(),
  translationIds: arrayType(stringType().uuid()).optional(),
  languages: arrayType(stringType().min(1)).max(200).optional(),
  source: stringType().min(1).optional(),
  type: literalType("").default(""),
  model: reviewModel.default(defaultReviewModel),
  recheck: stringType().uuid().optional()
}).strict();
reviewSelection.extend({
  requestId: stringType().uuid(),
  maxCreditUnits: numberType().int().nonnegative()
});
const reviewFinding = objectType({
  id: stringType().min(1).max(100),
  category: enumType([
    "format",
    "meaning",
    "omission",
    "addition",
    "terminology",
    "grammar",
    "locale",
    "style",
    "ambiguity",
    "context_conflict"
  ]),
  importance: enumType(["defect", "question", "suggestion"]),
  explanation: stringType().min(1).max(4e3),
  evidence: arrayType(objectType({ path: stringType().min(1), quote: stringType().min(1) })).min(1).max(12),
  replacement: stringType().max(32e3).nullable(),
  question: stringType().max(2e3).nullable()
}).strict();
const reviewChecks = enumType([
  "meaning",
  "completeness",
  "terminology",
  "fluency",
  "locale",
  "requirements"
]);
const concernResolution = objectType({
  concernId: stringType().uuid(),
  status: enumType(["resolved", "remains", "needs_context"]),
  reason: stringType().trim().min(1).max(2e3)
}).strict();
const legacyReviewerReport = objectType({
  resultId: stringType().uuid(),
  checks: arrayType(
    objectType({
      check: reviewChecks,
      result: enumType(["pass", "finding", "needs_context"]),
      explanation: stringType().min(1).max(2e3)
    })
  ).length(6),
  findings: arrayType(reviewFinding).max(20),
  concernResolutions: arrayType(concernResolution).max(50).optional()
}).strict();
unionType([
  legacyReviewerReport,
  objectType({
    resultId: stringType().uuid(),
    checksCompleted: literalType(true),
    findings: arrayType(reviewFinding).max(20),
    concernResolutions: arrayType(concernResolution).max(50).optional()
  }).strict()
]);
const reviewDecisionInput = objectType({
  requestId: stringType().uuid(),
  resultId: stringType().uuid(),
  expectedRevision: numberType().int().nonnegative(),
  inputHash: stringType().length(64),
  findingIds: arrayType(stringType().min(1)).min(1).max(20),
  action: enumType(["apply", "dismiss", "clarify", "defer"]),
  reason: stringType().trim().min(1).max(4e3),
  evidence: arrayType(stringType().min(1).max(2e3)).max(12).default([]),
  value: stringType().max(32e3).optional(),
  answer: stringType().trim().min(1).max(4e3).optional()
}).strict().superRefine((decision, ctx) => {
  if (decision.action === "apply" && decision.value === void 0)
    ctx.addIssue({
      code: "custom",
      message: "Applying a correction requires the final value."
    });
  if (decision.action === "clarify" && !decision.answer)
    ctx.addIssue({
      code: "custom",
      message: "Clarification requires an answer."
    });
  if (decision.action !== "apply" && decision.value !== void 0)
    ctx.addIssue({
      code: "custom",
      message: "Only apply accepts replacement wording."
    });
  if (decision.action !== "clarify" && decision.answer !== void 0)
    ctx.addIssue({
      code: "custom",
      message: "Only clarify accepts an answer."
    });
  if (new Set(decision.findingIds).size !== decision.findingIds.length)
    ctx.addIssue({ code: "custom", message: "Duplicate finding IDs." });
});

async function inspectQualityRun(context, runId, wait, timeout) {
  const id = stringType().uuid().parse(runId);
  const deadline = Date.now() + numberType().int().min(1).max(3600).parse(timeout) * 1e3;
  while (true) {
    const raw = await requestCliJson(
      `${context.host}/api/cli/${context.projectId}/quality/runs/${id}`,
      { headers: { Authorization: `Bearer ${context.accessToken}` } }
    );
    const result = objectType({ status: enumType(["running", "complete", "failed"]) }).passthrough().parse(raw);
    if (!wait || result.status !== "running") return result;
    if (Date.now() >= deadline) return { ...result, status: "timeout" };
    await setTimeout$1(1e3);
  }
}

function parseCreditUnits(value) {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) {
    throw new Error(
      `Invalid credit limit: "${value}". Use a non-negative amount with at most two decimals.`
    );
  }
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const units = whole * 100 + fraction;
  if (!Number.isSafeInteger(units)) {
    throw new Error(`Credit limit is too large: "${value}".`);
  }
  return units;
}

async function qualityCommand(context, input) {
  const timeout = input.action === "decide" ? 300 : coerce.number().int().min(1).max(3600).parse(input.options.timeout);
  const url = `${context.host}/api/cli/${context.projectId}/quality`;
  const post = (path, body) => requestCliJson(`${url}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${context.accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  let result;
  if (input.action === "decide") {
    const body = objectType({ decisions: arrayType(reviewDecisionInput).min(1).max(100) }).strict().parse(JSON.parse(await readFile(input.file, "utf8")));
    result = objectType({
      results: arrayType(
        objectType({ status: enumType(["saved", "error"]) }).passthrough()
      )
    }).passthrough().parse(await post("decisions", body));
  } else if (input.action === "show" || input.action === "retry") {
    if (input.action === "retry")
      await post(`runs/${stringType().uuid().parse(input.runId)}/retry`, {});
    result = await inspectQualityRun(
      context,
      input.runId,
      input.options.wait ?? false,
      timeout
    );
  } else {
    const options = input.options;
    const selection = reviewSelection.parse({
      jobId: options.job,
      keys: options.key,
      namespaces: options.namespace,
      keyIds: options.keyId.length ? options.keyId : void 0,
      translationIds: options.translationId.length ? options.translationId : void 0,
      languages: options.languages?.split(",").map((code) => code.trim()),
      source: options.source,
      model: options.model,
      recheck: options.recheck
    });
    if (options.estimate)
      result = recordType(unknownType()).parse(await post("estimate", selection));
    else {
      if (options.maxCredits === void 0)
        throw new Error(
          "Review submission requires --max-credits. Use --estimate first; review does not apply corrections or approve text."
        );
      const requestId = stringType().uuid().parse(options.requestId ?? randomUUID());
      process.stderr.write(
        `Review request ID: ${requestId}. Reuse --request-id with identical arguments if submission is interrupted.
`
      );
      const receipt = objectType({
        runId: stringType().uuid(),
        requestId: stringType().uuid(),
        creditUnits: numberType()
      }).parse(
        await post("runs", {
          ...selection,
          requestId,
          maxCreditUnits: parseCreditUnits(options.maxCredits)
        })
      );
      result = options.wait ? await inspectQualityRun(context, receipt.runId, true, timeout) : {
        version: 1,
        command: "quality",
        status: "started",
        run_id: receipt.runId,
        request_id: receipt.requestId,
        credit_units: receipt.creditUnits,
        next_actions: [
          {
            command: [
              "babli",
              "quality",
              "show",
              receipt.runId,
              "--wait",
              "--json"
            ],
            paid: false
          }
        ]
      };
    }
  }
  console.info(JSON.stringify(result, null, 2));
  const decisions = arrayType(objectType({ status: stringType() })).safeParse(result.results);
  return result.status === "failed" || result.status === "timeout" || decisions.success && decisions.data.some((item) => item.status === "error") ? 2 : 0;
}

function registerAdministrationCommands(program, run, withGlobalOptions) {
  const organization = program.command("organization").description(
    "Manage organization metadata and shared translation instructions"
  );
  for (const action of ["list", "get", "update"]) {
    const command = withGlobalOptions(organization.command(action));
    if (action !== "list")
      command.requiredOption("--organization <id>", "Organization id");
    if (action === "update")
      command.option("--name <name>", "Organization name").option("--instructions <text>", "Shared translation instructions").option(
        "--instructions-file <path>",
        "Read shared instructions from a file or - for stdin"
      );
    command.action(
      async (options) => run({ kind: "organization", action, options })
    );
  }
  const glossary = program.command("glossary").description(
    "Manage project and organization glossary terms; project scope defaults to babli.json"
  );
  const collect = (value, values = []) => [...values, value];
  const withScope = (command) => withGlobalOptions(command).option("--project <id>", "Project id (defaults to babli.json)").option(
    "--organization <id>",
    "Organization scope; cannot be combined with --project"
  );
  withScope(glossary.command("list")).description("List glossary terms owned by the selected scope").option(
    "--include-inherited",
    "Also show organization terms, labeled by scope"
  ).action(
    async (options) => run({ kind: "glossary", action: "list", options })
  );
  for (const action of ["get", "remove", "move-to-organization"]) {
    withScope(glossary.command(action)).argument("<term-id>").description(
      action === "move-to-organization" ? "Move a project term to its organization; fails on conflicts" : `${action === "get" ? "Read" : "Delete"} a term owned by the selected scope`
    ).action(
      async (id, options) => run({ kind: "glossary", action, id, options })
    );
  }
  for (const action of ["upsert", "update"]) {
    const command = withScope(glossary.command(action)).description(
      action === "upsert" ? "Create or merge a term by term text and source language" : "Patch a term by id; preserves omitted translations"
    );
    if (action === "update")
      command.argument("<term-id>").option("--term <text>", "New term text").option("--source-language <code>", "New source language");
    else
      command.requiredOption("--term <text>", "Term text").requiredOption("--source-language <code>", "Source language code");
    command.option(
      "--description <text>",
      "Note for translator; empty string clears it"
    ).option(
      "--translation <code=value>",
      "Set a target translation (repeatable)",
      collect
    );
    if (action === "update") {
      command.option(
        "--remove-translation <code>",
        "Remove a target translation (repeatable)",
        collect
      ).action(
        async (id, options) => run({ kind: "glossary", action, id, options })
      );
    } else
      command.action(
        async (options) => run({ kind: "glossary", action, options })
      );
  }
  withScope(glossary.command("export")).description("Export owned terms as portable versioned JSON").requiredOption("--output <path>", "Destination JSON file").action(
    async (options) => run({ kind: "glossary", action: "export", options })
  );
  withScope(glossary.command("import")).description(
    "Atomically merge JSON terms; preserves unrelated terms and translations"
  ).requiredOption("--file <path>", "JSON file or - for stdin").option("--dry-run", "Validate permissions and file without writing").action(
    async (options) => run({ kind: "glossary", action: "import", options })
  );
}

function registerQualityCommands(program, run, withGlobalOptions) {
  const quality = program.command("quality").description(
    "Review existing translations and record agent decisions; a current AI pass approves wording"
  );
  const collect = (value, values) => [...values, value];
  withGlobalOptions(quality.command("check")).description(
    "Estimate or submit one-model review; never generates missing text"
  ).option(
    "--job <id>",
    "Review the exact key/language pairs from a translation job"
  ).option("--key <pattern>", "Namespaced key glob (repeatable)", collect, []).option("--namespace <pattern>", "Namespace glob (repeatable)", collect, []).option("--key-id <id>", "Key UUID (repeatable)", collect, []).option(
    "--translation-id <id>",
    "Exact translation UUID (repeatable)",
    collect,
    []
  ).option("--languages <codes>", "Target language codes (comma-separated)").option("--source <code>", "Declared source language").addOption(
    new Option("--model <model>", "Reviewer; 1 credit per batch").choices([defaultReviewModel]).default(defaultReviewModel)
  ).option(
    "--recheck <result-id>",
    "Recheck one result with current inputs and saved clarifications"
  ).option("--estimate", "Inspect scope and price without spending").option(
    "--request-id <uuid>",
    "Reuse the original request ID after an uncertain submission"
  ).option(
    "--max-credits <amount>",
    "Maximum authorized charge; required to submit"
  ).option("--wait", "Wait for review completion").option("--timeout <seconds>", "Maximum wait time", "300").action(
    async (options) => run({ action: "check", options })
  );
  for (const action of ["show", "retry"])
    withGlobalOptions(quality.command(action)).argument("<run-id>").description(
      action === "show" ? "Inspect reports, coverage, decisions and freshness" : "Retry failed execution once without another customer charge"
    ).option("--wait", "Wait for completion").option("--timeout <seconds>", "Maximum wait time", "300").action(
      async (runId, options) => run({ action, runId, options })
    );
  withGlobalOptions(quality.command("decide")).description(
    "Record apply/dismiss/clarify/defer actions; never starts a paid recheck"
  ).requiredOption(
    "--file <path>",
    "JSON file containing decisions with request IDs and expected revisions"
  ).action(
    async (options) => run({ action: "decide", file: options.file })
  );
}

function renderPullJson(result) {
  const translations = result.addedTranslations.length + result.updatedTranslations.length;
  const changed = translations + result.removedTranslations.length + result.removedKeys.length + result.changedFiles.length;
  return JSON.stringify(
    {
      version: 2,
      command: "pull",
      status: changed > 0 ? "pulled" : "nothing_to_pull",
      summary: {
        added_translations: result.addedTranslations,
        updated_translations: result.updatedTranslations,
        removed_translations: result.removedTranslations,
        remaining_missing_translations: result.remainingMissingTranslations
      },
      removed_keys: result.removedKeys.map((key) => ({
        key: key.key,
        namespace: key.namespace,
        files: key.paths
      })),
      changed_files: result.changedFiles,
      counts: {
        added_translations: result.addedTranslations.length,
        updated_translations: result.updatedTranslations.length,
        removed_translations: result.removedTranslations.length,
        remaining_missing_translations: result.remainingMissingTranslations.length,
        translations,
        removed_keys: result.removedKeys.length,
        changed_files: result.changedFiles.length
      }
    },
    null,
    2
  );
}

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

const agentTranslationGuidance = `Agents must prepare descriptions before translation.
1. Push new keys and source changes first: babli push --json --no-interaction.
2. Export current context: babli key export --language <source-code> --output keys.json.
3. Inspect code usages for the keys you will translate. Keep useful descriptions;
   draft missing or outdated descriptions with meaning and placeholder context.
4. Check and save drafts: babli key update --file descriptions.json --dry-run,
   then babli key update --file descriptions.json. Resolve conflicts first.
5. Estimate, translate, and pull only keys with prepared descriptions.
Record unclear keys as unresolved; leave them out of translation until clarified.
Use sync-and-translate only after descriptions cover its selected keys and source changes.`;

function count(amount, noun) {
  return amount > 0 ? `${amount} ${noun}${amount === 1 ? "" : "s"}` : null;
}
function assertNoUnpushedChanges(status) {
  if (!status.needPush) return;
  const missingTranslations = Object.values(
    status.toPush.missingTranslations
  ).reduce((sum, keys) => sum + keys.length, 0);
  const parts = [
    count(status.toPush.newKeys.length, "new key"),
    count(status.toPush.changedValues.length, "changed translation"),
    count(missingTranslations, "missing translation"),
    count(status.languages.localOnly.length, "local-only language")
  ].filter((part) => part !== null);
  const summary = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  throw new CliRequestError({
    code: "unpushed_changes",
    message: `Local files have changes that are not pushed${summary}. Run "babli push" first so the pull after renaming does not discard them, or pass --allow-unpushed.`
  });
}

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
    if (status.needPush || status.issues.serverOnlyKeys.length > 0) {
      menuItems.push({
        value: "sync-and-translate",
        label: status.issues.serverOnlyKeys.length > 0 ? `Sync & Translate  (review ${plural(status.issues.serverOnlyKeys.length, "server-only key")}, push, translate, pull)` : `Sync & Translate  (push ${pushCount} new, translate, pull results)`
      });
    }
    if (status.needPush) {
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
  const selectedKeys = params.selectedKeys ?? (keys && keys.length > 0 || namespaces && namespaces.length > 0 ? resolveSelectedKeys(
    keys ?? [],
    mergedKeysByKeyByNamespace,
    namespaces ?? []
  ) : void 0);
  const result = [];
  for (const keysInNamespace of Object.values(mergedKeysByKeyByNamespace)) {
    for (const key of Object.values(keysInNamespace)) {
      const serverId = key.server?.id;
      if (!serverId) continue;
      if (onlyExisting && !key.local) continue;
      if (selectedKeys && !selectedKeys.has(getComparisonKey(key))) continue;
      const hasUsableSource = Object.entries(key.translations).some(
        ([code, translation]) => !targetLanguages.includes(code) && (params.allowUnapprovedSources || hasCurrentApproval(translation.server?.quality)) && !translation.server?.quality?.unresolvedConcernIds.length && Boolean(translation.server?.currentValue?.trim())
      );
      if (!hasUsableSource) continue;
      const missingLanguages = [];
      for (const lang of targetLanguages) {
        if (languageFilter && !languageFilter.has(lang)) continue;
        const serverTranslation = key.translations[lang]?.server;
        const missing = serverTranslation?.currentValue == null || emptyValueString === "" && serverTranslation.currentValue === "";
        if (strategy === "missing") {
          if (missing) missingLanguages.push(lang);
        } else if (strategy === "replace" || missing || !hasCurrentApproval(serverTranslation?.quality)) {
          missingLanguages.push(lang);
        }
      }
      if (missingLanguages.length > 0) {
        result.push({
          keyId: serverId,
          key: key.key,
          namespace: key.server?.namespace ?? key.local?.namespace ?? "",
          languages: missingLanguages
        });
      }
    }
  }
  return result;
}

function computeTranslationCoverage(input) {
  const selected = (input.keys?.length ?? 0) > 0 || (input.namespaces?.length ?? 0) > 0 ? resolveSelectedKeys(
    input.keys ?? [],
    input.syncResult.mergedKeysByKeyByNamespace,
    input.namespaces ?? []
  ) : void 0;
  const workItems = computeTranslationWork({
    mergedKeysByKeyByNamespace: input.syncResult.mergedKeysByKeyByNamespace,
    targetLanguages: input.targetLanguages,
    strategy: "missing",
    onlyExisting: false,
    emptyValueString: input.emptyValueString,
    keys: input.keys,
    namespaces: input.namespaces
  });
  const workIds = new Set(workItems.map((item) => item.keyId));
  const blockedItems = [];
  let keysWithMissingTranslations = 0;
  let missingLanguagePairs = 0;
  for (const keysInNamespace of Object.values(
    input.syncResult.mergedKeysByKeyByNamespace
  )) {
    for (const key of Object.values(keysInNamespace)) {
      const keyId = key.server?.id;
      if (!keyId || selected && !selected.has(getComparisonKey(key)))
        continue;
      const missingLanguages = input.targetLanguages.filter((language) => {
        const value = key.translations[language]?.server?.currentValue;
        return value == null || input.emptyValueString === "" && value === "";
      });
      if (missingLanguages.length === 0) continue;
      keysWithMissingTranslations += 1;
      missingLanguagePairs += missingLanguages.length;
      if (!workIds.has(keyId)) {
        blockedItems.push({
          keyId,
          key: key.key,
          namespace: key.server?.namespace ?? key.local?.namespace ?? "",
          missingLanguages,
          reason: "no_approved_reference"
        });
      }
    }
  }
  return {
    strategy: "missing",
    status: workItems.length > 0 ? "needs_translation" : blockedItems.length > 0 ? "blocked" : "complete",
    keysWithMissingTranslations,
    missingLanguagePairs,
    translatableKeys: workItems.length,
    translatableLanguagePairs: workItems.reduce(
      (total, item) => total + item.languages.length,
      0
    ),
    blockedKeys: blockedItems.length,
    workItems,
    blockedItems
  };
}

function exitAfterFlush(code) {
  return new Promise(() => {
    process.stdout.write("", () => process.exit(code));
  });
}

async function writeFile(file, content) {
  await fs__default.mkdir(path$1.dirname(file), { recursive: true });
  await fs__default.writeFile(file, content, "utf-8");
}

function getTargetLanguageCodes(languages) {
  return languages.filter((language) => !language.isSource).map((language) => language.code);
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
    console.info(`2. Prepare and save key descriptions from code usages`);
    console.info(`3. Translate at ${host}/app/project/${project.id}/translate`);
    console.info(`4. Run 'babli pull' to download completed translations`);
  } else {
    console.info(`
Next steps:`);
    console.info(`1. Add translation files to the locales/ directory`);
    console.info(`2. Run 'babli push' to upload your translations`);
    console.info(`3. Prepare and save key descriptions from code usages`);
    console.info(`4. Translate at ${host}/app/project/${project.id}/translate`);
    console.info(`5. Run 'babli pull' to download completed translations`);
  }
  console.info(`
${agentTranslationGuidance}`);
}

async function pollTranslationJob(host, projectId, accessToken, jobId, timeoutSeconds, flags) {
  const startTime = Date.now();
  const timeoutMs = timeoutSeconds * 1e3;
  let interval = 2e3;
  let lastStatus;
  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      return {
        status: "timeout",
        progress: lastStatus?.progress ?? 0,
        total: lastStatus?.total ?? 0,
        finished: lastStatus?.finished ?? 0,
        failed: lastStatus?.failed ?? 0,
        failures: lastStatus?.failures ?? [],
        formatWarningCount: lastStatus?.formatWarningCount,
        creditsCharged: lastStatus?.creditsCharged
      };
    }
    const status = await fetchJobStatus(host, projectId, accessToken, jobId);
    lastStatus = status;
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

function printTranslationFollowUp(followUp) {
  console.info(
    `Question follow-up: ${followUp.questions_status}; ${followUp.questions.length} unanswered. Linguistic review: not requested.`
  );
  for (const question of followUp.questions) {
    console.info(
      `[${question.languageCode}] ${question.namespace ? `${question.namespace}:` : ""}${question.keyName}: ${question.question}${question.relevance === "earlier" ? " (earlier run; check relevance)" : ""}`
    );
  }
  for (const action of followUp.next_actions) console.info(action.reason);
}

function buildTranslationFollowUp(questions, scope = {}) {
  const selections = scope.jobId ? [["--job", scope.jobId]] : scope.pairs ? scope.pairs.map((pair) => [
    "--key-id",
    pair.keyId,
    "--languages",
    pair.languages.join(",")
  ]) : scope.keyIds?.length === 0 ? [] : [
    [
      ...(scope.keyIds ?? []).flatMap((id) => ["--key-id", id]),
      ...(scope.keys ?? []).flatMap((key) => ["--key", key]),
      ...(scope.namespaces ?? []).flatMap((namespace) => [
        "--namespace",
        namespace
      ]),
      ...scope.languages?.length ? ["--languages", scope.languages.join(",")] : []
    ]
  ];
  return {
    questions_status: "checked",
    questions,
    review_status: "not_requested",
    next_actions: [
      ...questions.length ? [
        {
          command: [
            "babli",
            "questions",
            "--answers-file",
            "answers.json",
            "--json",
            "--no-interaction"
          ],
          reason: "Inspect each question against repository evidence. Save supported answers using the listed identifiers; ask the user about unknown product facts. Earlier questions may no longer apply. Saving answers does not verify wording or authorize paid work.",
          paid: false
        }
      ] : [],
      ...selections.map((args) => ({
        command: ["babli", "quality", "check", ...args, "--estimate", "--json"],
        reason: "The complete agent workflow includes linguistic review. Estimate the selected scope, then submit only within the remaining authorized --max-credits budget. Evaluate each finding against evidence; report unresolved judgments instead of applying every suggestion.",
        paid: false
      }))
    ]
  };
}

async function readTranslationFollowUp(context, scope, pending = false) {
  if (pending)
    return {
      questions_status: "pending",
      questions: [],
      review_status: "not_requested",
      next_actions: scope.jobId ? [
        {
          command: ["babli", "job", scope.jobId, "--wait", "--json"],
          reason: "Wait for the existing job before evaluating its final questions. Do not resubmit translation.",
          paid: false
        }
      ] : []
    };
  try {
    return buildTranslationFollowUp(
      await fetchQuestions(
        context.host,
        context.projectId,
        context.accessToken,
        scope
      ),
      scope
    );
  } catch (error) {
    return {
      questions_status: "unavailable",
      questions: [],
      review_status: "not_requested",
      error: error instanceof Error ? error.message : "Could not fetch questions",
      next_actions: [
        {
          command: [
            "babli",
            "questions",
            ...scope.jobId ? ["--job", scope.jobId] : [],
            "--json"
          ],
          reason: "Question discovery failed. Retry inspection before declaring the workflow finished.",
          paid: false
        }
      ]
    };
  }
}

function reportFormatWarnings(count) {
  if (count) {
    console.info(
      `${FgYellow}${count} message format warnings. Review the generated translations in Babli.${Reset}`
    );
  }
}

async function jobCommand(ctx, options) {
  const status = options.wait ? await pollTranslationJob(
    ctx.host,
    ctx.projectId,
    ctx.accessToken,
    options.jobId,
    options.timeout,
    ctx.flags
  ) : await fetchJobStatus(
    ctx.host,
    ctx.projectId,
    ctx.accessToken,
    options.jobId
  );
  const followUp = await readTranslationFollowUp(
    ctx,
    { jobId: options.jobId },
    status.status !== "complete" && status.status !== "failed"
  );
  if (ctx.flags.json) {
    console.info(
      JSON.stringify(
        {
          version: 1,
          command: "job",
          follow_up: followUp,
          status: status.status,
          job_id: options.jobId,
          counts: {
            total: status.total,
            finished: status.finished,
            failed: status.failed,
            progress: status.progress
          },
          process_counts: {
            total: status.total,
            finished: status.finished,
            failed: status.failed
          },
          credits_charged: status.creditsCharged ? {
            units: status.creditsCharged.total,
            monthly_units: status.creditsCharged.monthly,
            persistent_units: status.creditsCharged.persistent,
            unit_scale: 100,
            display: status.creditsCharged.total / 100
          } : void 0,
          failures: status.failures.length > 0 ? status.failures : void 0,
          format_warning_count: status.formatWarningCount ?? 0
        },
        null,
        2
      )
    );
    return status.status === "failed" || status.status === "timeout" ? 2 : 0;
  }
  printTranslationFollowUp(followUp);
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
    console.info(
      `Run ${Bold}babli job ${options.jobId} --wait${Reset} to keep waiting.`
    );
  } else {
    console.info(
      `Job ${status.status}: ${status.finished}/${status.total} processes finished.`
    );
  }
  if (status.status !== "failed") {
    for (const failure of status.failures) {
      console.info(`  ${failure.process_id}: ${failure.message}`);
    }
  }
  reportFormatWarnings(status.formatWarningCount);
  return status.status === "failed" || status.status === "timeout" ? 2 : 0;
}

var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, key + "" , value);
class KeyDescriptionBatchError extends Error {
  constructor(report, cause) {
    super(
      `Description batch ${report.failure.batch} failed after ${report.completed_batches} completed batches: ${report.error.message}. ${report.failure.recovery}`,
      { cause }
    );
    __publicField(this, "report", report);
    this.name = "KeyDescriptionBatchError";
  }
}

const nonblankStringSchema = stringType().refine((value) => value.trim().length > 0, "Must not be blank");
const languageSchema = stringType().trim().min(1);
const descriptionSchema = stringType().max(2e4);
const descriptionItemSchema = objectType({
  keyId: stringType().uuid(),
  expectedDescription: stringType().nullable(),
  expectedSourceVersionId: stringType().uuid(),
  description: descriptionSchema.refine(
    (value) => value.trim().length > 0,
    "Description must not be blank"
  )
});
function validateUniqueKeyIds({ items }, context) {
  const seen = /* @__PURE__ */ new Set();
  for (const [index, item] of items.entries()) {
    const identity = item.keyId.toLowerCase();
    if (seen.has(identity)) {
      context.addIssue({
        code: ZodIssueCode.custom,
        path: ["items", index, "keyId"],
        message: "Duplicate key ID"
      });
    }
    seen.add(identity);
  }
}
objectType({
  language: languageSchema,
  dryRun: booleanType(),
  items: arrayType(descriptionItemSchema).min(1).max(100)
}).superRefine(validateUniqueKeyIds);
const keyDescriptionBatchResultSchema = objectType({
  items: arrayType(
    objectType({
      keyId: stringType().uuid(),
      status: enumType(["updated", "would_update", "unchanged"])
    })
  )
});
objectType({
  conflicts: arrayType(
    objectType({
      keyId: stringType().uuid(),
      reason: enumType([
        "key_not_found",
        "source_changed",
        "description_changed"
      ])
    })
  )
});
const unresolvedItemSchema = objectType({
  keyId: stringType().uuid(),
  status: literalType("unresolved"),
  reason: nonblankStringSchema,
  description: neverType().optional()
}).refine((item) => !Object.hasOwn(item, "description"), {
  path: ["description"],
  message: "Unresolved items must not contain a description"
}).transform(({ keyId, status, reason }) => ({ keyId, status, reason }));
const keyDescriptionFileSchema = objectType({
  version: literalType(1),
  projectId: stringType().uuid(),
  language: languageSchema,
  items: arrayType(
    unionType([
      descriptionItemSchema.extend({
        status: literalType("drafted").optional()
      }),
      unresolvedItemSchema
    ])
  ).max(1e5)
}).superRefine(validateUniqueKeyIds);

function serializeCliError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof CliRequestError)) return { message };
  return {
    message,
    ...error.code ? { code: error.code } : {},
    ...error.httpStatus !== void 0 ? { http_status: error.httpStatus } : {},
    ...error.details !== void 0 ? { details: error.details } : {}
  };
}

async function keyDescriptionFileCommand(ctx, options) {
  const parsed = keyDescriptionFileSchema.safeParse(
    JSON.parse(await fs$1.readFile(options.file, "utf8"))
  );
  if (!parsed.success) {
    throw new CliRequestError({
      message: "Invalid descriptions file.",
      code: "invalid_description_file",
      details: parsed.error.issues
    });
  }
  const file = parsed.data;
  if (file.projectId.toLowerCase() !== ctx.projectId.toLowerCase()) {
    throw new CliRequestError({
      message: "The descriptions file projectId does not match babli.json.",
      code: "project_mismatch"
    });
  }
  const items = [];
  for (const item of file.items) {
    if (item.status === "unresolved") continue;
    items.push({
      keyId: item.keyId,
      expectedDescription: item.expectedDescription,
      expectedSourceVersionId: item.expectedSourceVersionId,
      description: item.description
    });
  }
  const report = {
    version: 1,
    command: "key_update",
    status: options.dryRun ? "dry_run" : "updated",
    project_id: ctx.projectId,
    language: file.language,
    dry_run: options.dryRun,
    completed_batches: 0,
    total_batches: Math.ceil(items.length / 100),
    counts: {
      total: file.items.length,
      skipped_unresolved: file.items.length - items.length,
      updated: 0,
      would_update: 0,
      unchanged: 0,
      pending: items.length
    }
  };
  for (let offset = 0; offset < items.length; offset += 100) {
    const batch = items.slice(offset, offset + 100);
    try {
      const body = await requestCliJson(
        `${ctx.host}/api/cli/${ctx.projectId}/keys/descriptions`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${ctx.accessToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            language: file.language,
            dryRun: options.dryRun,
            items: batch
          })
        }
      );
      const result = keyDescriptionBatchResultSchema.safeParse(body);
      if (!result.success) throw invalidResult();
      const expectedIds = new Set(batch.map((item) => item.keyId));
      for (const item of result.data.items) {
        if (!expectedIds.delete(item.keyId) || (options.dryRun ? item.status === "updated" : item.status === "would_update"))
          throw invalidResult();
      }
      if (expectedIds.size !== 0) throw invalidResult();
      for (const item of result.data.items) report.counts[item.status]++;
      report.counts.pending -= batch.length;
      report.completed_batches++;
    } catch (cause) {
      throw new KeyDescriptionBatchError(
        {
          ...report,
          status: "error",
          error: serializeCliError(cause),
          failure: {
            batch: report.completed_batches + 1,
            key_ids: batch.map((item) => item.keyId),
            recovery: "Rerun the same file to resume; for conflicts, export fresh keys and review changed entries before retrying."
          }
        },
        cause
      );
    }
  }
  if (ctx.flags.json) {
    printJson(report);
  } else {
    console.info(
      `${report.counts.updated} updated, ${report.counts.would_update} would update, ${report.counts.unchanged} unchanged, ${report.counts.skipped_unresolved} unresolved skipped (${report.completed_batches} batches).`
    );
  }
}
function invalidResult() {
  return new CliRequestError({
    message: "Invalid description batch response; batch outcome is unconfirmed.",
    code: "invalid_response"
  });
}

const keyContextSchema = objectType({
  keyId: stringType().uuid(),
  key: stringType(),
  namespace: stringType(),
  source: stringType(),
  description: stringType().nullable(),
  sourceText: stringType().nullable(),
  sourceVersionId: stringType().uuid().nullable()
});
const keyContextPageSchema = objectType({
  keys: arrayType(keyContextSchema),
  nextCursor: stringType().uuid().nullable()
});
objectType({
  version: literalType(1),
  projectId: stringType().uuid(),
  language: stringType().trim().min(1),
  keys: arrayType(keyContextSchema)
});

async function keyExportCommand(ctx, options) {
  const language = options.language.trim();
  if (!language || !options.output.trim()) {
    throw new Error("Provide nonblank --language and --output values.");
  }
  const keys = [];
  const keyIds = /* @__PURE__ */ new Set();
  const cursors = /* @__PURE__ */ new Set();
  let cursor = null;
  do {
    const query = new URLSearchParams({
      language,
      limit: "500"
    });
    if (cursor !== null) query.set("cursor", cursor);
    const body = await requestCliJson(
      `${ctx.host}/api/cli/${ctx.projectId}/keys/export?${query}`,
      { headers: { Authorization: `Bearer ${ctx.accessToken}` } }
    );
    const parsed = keyContextPageSchema.safeParse(body);
    if (!parsed.success || parsed.data.keys.length > 500) {
      throw invalidResponse("Invalid key export response.");
    }
    const page = parsed.data;
    for (const key of page.keys) {
      if (keyIds.has(key.keyId))
        throw invalidResponse(`Duplicate exported key: ${key.keyId}`);
      keyIds.add(key.keyId);
      keys.push(key);
    }
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (page.keys.length === 0 || cursors.has(cursor)) {
        throw invalidResponse("Key export pagination did not advance.");
      }
      cursors.add(cursor);
    }
  } while (cursor !== null);
  const exported = {
    version: 1,
    projectId: ctx.projectId,
    language,
    keys
  };
  const output = await writeJsonFile(options.output, exported);
  if (ctx.flags.json) {
    printJson({
      version: 1,
      command: "key_export",
      status: "exported",
      output,
      count: keys.length
    });
  } else {
    console.info(`Exported ${keys.length} keys to ${output}.`);
  }
}
function invalidResponse(message) {
  return new CliRequestError({ message, code: "invalid_response" });
}

const stateSchema = objectType({
  key: stringType(),
  namespace: stringType(),
  source: stringType()
}).strict();
const itemSchema = objectType({
  keyId: stringType().uuid(),
  expectedKey: stringType(),
  expectedNamespace: stringType(),
  expectedSource: stringType(),
  to: stringType().refine((value) => value.trim().length > 0, "Key must not be blank"),
  toNamespace: stringType().optional(),
  toSource: stringType().optional()
}).strict();
const manifestSchema = objectType({
  version: literalType(1),
  projectId: stringType().uuid(),
  items: arrayType(itemSchema).min(1).max(1e3)
}).strict();
function validateIds(input, context) {
  const seen = /* @__PURE__ */ new Set();
  for (const [index, item] of input.items.entries()) {
    const id = item.keyId.toLowerCase();
    if (seen.has(id)) context.addIssue({
      code: ZodIssueCode.custom,
      path: ["items", index, "keyId"],
      message: "Duplicate key ID"
    });
    seen.add(id);
  }
}
const keyRenameFileSchema = manifestSchema.superRefine(validateIds);
manifestSchema.extend({
  dryRun: booleanType()
}).strict().superRefine(validateIds);
const keyRenameResultSchema = objectType({
  items: arrayType(objectType({
    index: numberType().int().nonnegative(),
    key_id: stringType().uuid(),
    status: enumType(["renamed", "would_rename", "unchanged"]),
    from: stateSchema,
    to: stateSchema
  }).strict()).max(1e3)
}).strict();

function keyRenameStates(item) {
  return {
    from: { key: item.expectedKey, namespace: item.expectedNamespace, source: item.expectedSource },
    to: { key: item.to, namespace: item.toNamespace ?? item.expectedNamespace, source: item.toSource ?? item.expectedSource }
  };
}

function keyRenamePaths(file, configs, languages) {
  return file.items.map((item, index) => {
    const states = keyRenameStates(item);
    const result = { index, key_id: item.keyId.toLowerCase(), from: [], to: [] };
    for (const side of ["from", "to"]) {
      for (const config of configs) {
        if (config.transform) continue;
        const localLanguages = config.languages ?? languages.map((language) => Object.entries(config.mapLocalToRemote ?? {}).find(([, remote]) => remote === language)?.[0] ?? language);
        for (const language of localLanguages) {
          try {
            const path = resolveTranslationPath(config, states[side], language);
            if (path !== null && !result[side].includes(path)) result[side].push(path);
          } catch (cause) {
            if (side === "from") continue;
            throw new CliRequestError({ code: "invalid_destination_path", message: cause instanceof Error ? cause.message : String(cause), details: { index, key_id: item.keyId, side }, cause });
          }
        }
      }
    }
    return result;
  });
}

async function validateKeyRenamePull(file, configs, project, serverKeys) {
  const targets = new Map(
    file.items.map((item) => [
      item.keyId.toLowerCase(),
      keyRenameStates(item).to
    ])
  );
  const mergedKeysByKeyByNamespace = {};
  gatherServerKeys({
    allServerKeys: serverKeys.map((key) => ({
      ...key,
      ...targets.get(key.id.toLowerCase())
    })),
    mergedKeysByKeyByNamespace,
    getLangCode: makeGetLangCode(project.languages),
    getFilePatternOrPath: () => void 0,
    mergedKeysInLocalOrder: {}
  });
  try {
    await prepareFilesToPull({
      mergedKeysByKeyByNamespace,
      mergedKeysInLocalOrder: {},
      translationFilesConfig: configs,
      allLanguages: project.languages,
      emptyValueString: null,
      selectedKeys: void 0,
      allFilesByPattern: {},
      keepLocalOnly: false
    });
  } catch (cause) {
    throw new CliRequestError({
      code: "invalid_rename_output",
      message: `The rename cannot be pulled with this configuration: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause
    });
  }
}

async function keyRenameFileCommand(ctx, options, configs) {
  let content;
  if (options.file === "-") {
    if (stdin$1.isTTY)
      throw new CliRequestError({
        code: "invalid_rename_file",
        message: "Pipe a JSON manifest to --file -."
      });
    stdin$1.setEncoding("utf8");
    content = "";
    for await (const chunk of stdin$1) content += String(chunk);
  } else {
    content = await fs$1.readFile(options.file, "utf8");
  }
  let json;
  try {
    json = JSON.parse(content);
  } catch (cause) {
    throw new CliRequestError({
      code: "invalid_rename_file",
      message: "The rename manifest is not valid JSON.",
      cause
    });
  }
  const parsed = keyRenameFileSchema.safeParse(json);
  if (!parsed.success)
    throw new CliRequestError({
      code: "invalid_rename_file",
      message: "Invalid rename manifest.",
      details: parsed.error.issues
    });
  const file = parsed.data;
  if (file.projectId.toLowerCase() !== ctx.projectId.toLowerCase())
    throw new CliRequestError({
      code: "project_mismatch",
      message: "The rename manifest does not match the configured project."
    });
  const project = await fetchProjectInfo(
    ctx.host,
    ctx.projectId,
    ctx.accessToken
  );
  const fileChanges = keyRenamePaths(
    file,
    configs,
    project.languages.map((language) => language.code)
  );
  const serverKeys = await fetchServerKeys(
    ctx.host,
    ctx.projectId,
    ctx.accessToken
  );
  await validateKeyRenamePull(file, configs, project, serverKeys);
  let response;
  try {
    response = await requestCliJson(
      `${ctx.host}/api/cli/${ctx.projectId}/keys/renames`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${ctx.accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ ...file, dryRun: options.dryRun })
      }
    );
  } catch (cause) {
    if (!options.dryRun && (!(cause instanceof CliRequestError) || cause.httpStatus === void 0 || cause.httpStatus >= 500 || cause.httpStatus === 408)) {
      throw new CliRequestError({
        code: "outcome_unknown",
        message: "The rename outcome is unconfirmed. Rerun the same manifest safely to confirm it.",
        cause
      });
    }
    throw cause;
  }
  const result = keyRenameResultSchema.safeParse(response);
  const invalidResult = () => new CliRequestError({
    code: options.dryRun ? "invalid_response" : "outcome_unknown",
    message: "Invalid rename response; rerun the same manifest to confirm the outcome."
  });
  if (!result.success || result.data.items.length !== file.items.length)
    throw invalidResult();
  const counts = {
    total: file.items.length,
    renamed: 0,
    would_rename: 0,
    unchanged: 0
  };
  for (const [index, item] of result.data.items.entries()) {
    const expected = file.items[index];
    if (!expected) throw invalidResult();
    const { to } = keyRenameStates(expected);
    if (item.index !== index || item.key_id.toLowerCase() !== expected.keyId.toLowerCase() || item.to.key !== to.key || item.to.namespace !== to.namespace || item.to.source !== to.source || (options.dryRun ? item.status === "renamed" : item.status === "would_rename"))
      throw invalidResult();
    counts[item.status]++;
  }
  const nextActions = options.dryRun ? [] : [
    {
      command: ["babli", "pull", "--json", "--no-interaction"],
      reason: "Pull writes the renamed keys and placements to local files and removes the old names. Do not push before pulling.",
      paid: false
    }
  ];
  if (ctx.flags.json)
    printJson({
      version: 1,
      command: "key_rename",
      status: options.dryRun ? "dry_run" : "renamed",
      project_id: ctx.projectId,
      dry_run: options.dryRun,
      counts,
      items: result.data.items,
      file_changes: fileChanges,
      next_actions: nextActions
    });
  else {
    console.info(
      `${counts.renamed} renamed, ${counts.would_rename} would rename, ${counts.unchanged} unchanged.`
    );
    if (!options.dryRun)
      console.info(
        'Run "babli pull" to update local files. Do not push before pulling.'
      );
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
    throw new Error(
      `Invalid --type "${options.type}". Use "key" or "document".`
    );
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
  console.info(
    `${FgGreen}Created project:${Reset} ${project.name} (${project.id})`
  );
  console.info(`${ctx.host}/app/project/${project.id}`);
}

function buildAnswerNextActions(pairs) {
  return pairs.map((pair) => ({
    command: ["babli", "key", "get", "--key-id", pair.keyId, "--json"],
    reason: `Inspect the ${pair.languageCode} wording against the saved answer. Run an AI review or request a human review if it needs reassessment.`,
    paid: false
  }));
}

const MAX_TRANSLATION_ANSWERS = 500;
const translationAnswerInput = objectType({
  questionId: stringType().uuid().optional(),
  keyId: stringType().uuid(),
  languageId: stringType().uuid(),
  questionText: stringType().min(1),
  answer: stringType().trim().min(1)
}).strict();
const translationAnswersInput = objectType({
  answers: arrayType(translationAnswerInput).min(1).max(MAX_TRANSLATION_ANSWERS)
}).strict().superRefine(({ answers }, ctx) => {
  const seen = /* @__PURE__ */ new Set();
  for (const [index, answer] of answers.entries()) {
    const identity = answer.questionId ?? JSON.stringify([answer.keyId, answer.languageId, answer.questionText]);
    if (seen.has(identity)) {
      ctx.addIssue({
        code: ZodIssueCode.custom,
        path: ["answers", index],
        message: "Duplicate question in answer batch"
      });
    }
    seen.add(identity);
  }
});

async function questionsCommand(ctx) {
  const fileAnswers = ctx.answersFile === void 0 ? void 0 : translationAnswersInput.parse(
    JSON.parse(await readFile(ctx.answersFile, "utf8"))
  ).answers;
  const questions = ctx.questions ?? await fetchQuestions(ctx.host, ctx.projectId, ctx.accessToken, ctx.scope);
  const answers = fileAnswers ?? [];
  if (ctx.scope && fileAnswers?.some(
    (answer) => !questions.some(
      (question) => (!answer.questionId || question.questionId === answer.questionId) && question.keyId === answer.keyId && question.languageId === answer.languageId && question.question === answer.questionText
    )
  )) {
    throw new Error(
      "Answer file includes questions outside the selected scope. Fetch the scoped questions again."
    );
  }
  const affectedPairs = [];
  let answered = 0;
  let retranslationRequired = false;
  async function saveAnswers() {
    const result = await submitAnswers(
      ctx.host,
      ctx.projectId,
      ctx.accessToken,
      [...answers]
    );
    if (result.answered !== answers.length)
      throw new Error(
        `Server saved ${result.answered} of ${answers.length} answers. Fetch questions again before retrying.`
      );
    retranslationRequired || (retranslationRequired = result.retranslationRequired ?? result.answered > 0);
    affectedPairs.push(...result.affectedPairs ?? []);
    answered += result.answered;
    answers.length = 0;
    if (!ctx.flags.json) {
      console.info(
        `${FgGreen}Saved ${answered} answer(s). Inspect affected wording before authorizing regeneration.${Reset}`
      );
    }
  }
  if (!fileAnswers && !ctx.flags.json) {
    console.info(
      questions.length ? `
${Bold}${questions.length} unanswered question(s):${Reset}
` : `${FgGreen}No unanswered questions.${Reset}`
    );
    for (const question of questions) {
      console.info(
        `${Dim}[${question.languageCode}] ${question.keyName}${Reset}`
      );
      console.info(`  ${question.question}`);
      if (ctx.flags.noInteraction) continue;
      const answer = (await input({ message: "Your answer (press Enter to skip):" })).trim();
      if (answer)
        answers.push({
          ...question.questionId ? { questionId: question.questionId } : {},
          keyId: question.keyId,
          languageId: question.languageId,
          questionText: question.question,
          answer
        });
      if (answers.length === MAX_TRANSLATION_ANSWERS) await saveAnswers();
    }
  }
  if (answers.length) await saveAnswers();
  const followUp = answered ? await readTranslationFollowUp(ctx, ctx.scope ?? {}) : void 0;
  const remaining = followUp?.questions ?? questions;
  if (ctx.flags.json) {
    console.info(
      JSON.stringify(
        {
          version: 1,
          command: "questions",
          status: answered ? "answered" : questions.length ? "skipped" : "none",
          summary: { total: questions.length, answered },
          questions: remaining,
          retranslationRequired,
          affected_pairs: affectedPairs,
          follow_up: followUp,
          next_actions: buildAnswerNextActions(affectedPairs)
        },
        null,
        2
      )
    );
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

function renderPushPreview(plan) {
  const translationCount = Object.values(
    plan.missingTranslationsPerLanguage
  ).reduce((sum, keys) => sum + keys.length, 0);
  console.info("Dry run \u2014 no server changes made.");
  console.info(
    `${plan.newLanguages.length} new languages, ${plan.newKeys.length} new keys, ${translationCount} translations, ${plan.conflicts.length} conflicting values, ${plan.keysToRemove.length} keys to archive.`
  );
  for (const key of plan.newKeys) console.info(`  Add: ${key}`);
  for (const [language, keys] of Object.entries(
    plan.missingTranslationsPerLanguage
  )) {
    for (const key of keys)
      console.info(`  Add translation: ${key} (${language})`);
  }
  for (const conflict of plan.conflicts) {
    console.info(`  Conflict: ${conflict.key} (${conflict.language})`);
  }
  for (const key of plan.keysToRemove)
    console.info(`  Archive: ${formatNamespacedKey(key)}`);
}

function deduplicateByKey(grouped) {
  const seen = /* @__PURE__ */ new Map();
  for (const keys of Object.values(grouped)) {
    for (const key of keys) {
      const comparisonKey = getComparisonKey(key);
      if (!seen.has(comparisonKey)) {
        seen.set(comparisonKey, key);
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
    lines.push(
      `    ${Dim}... and ${hiddenCount} more. Run with --full for complete list.${Reset}`
    );
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
  const missingTranslationsKeys = deduplicateByKey(
    comparison.missingTranslationsOnServerPerLanguage
  ).filter((k) => !newKeyNamesOnServer.has(getComparisonKey(k)));
  const changedKeys = deduplicateByKey(
    comparison.differentTranslationsLanguage
  );
  const newKeysOnLocal = Object.values(comparison.missingKeysOnLocal);
  const newKeyNamesOnLocal = new Set(
    newKeysOnLocal.map((key) => getComparisonKey(key))
  );
  const missingTranslationsLocalKeys = deduplicateByKey(
    comparison.missingTranslationsOnLocalPerLanguage
  ).filter((k) => !newKeyNamesOnLocal.has(getComparisonKey(k)));
  const hasPush = newKeysOnServer.length > 0 || changedKeys.length > 0 || missingTranslationsKeys.length > 0;
  const hasPull = newKeysOnLocal.length > 0 || missingTranslationsLocalKeys.length > 0;
  if (!hasPush && !hasPull && status.languages.serverOnly.length === 0) {
    lines.push("");
    lines.push(`  ${FgGreen}Local files and Babli are in sync.${Reset}`);
    renderCoverage(lines, opts.coverage, opts.full);
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
      renderSection(lines, changedKeys, termWidth, opts.full, {
        showDiff: true,
        onlyChanges: true
      });
    }
    if (missingTranslationsKeys.length > 0) {
      const totalCount = Object.values(
        comparison.missingTranslationsOnServerPerLanguage
      ).reduce(
        (s, keys) => s + keys.filter((k) => !newKeyNamesOnServer.has(getComparisonKey(k))).length,
        0
      );
      lines.push("");
      lines.push(
        `  ${FgGreen}${totalCount} missing translations across ${missingTranslationsKeys.length} keys:${Reset}`
      );
      renderSection(lines, missingTranslationsKeys, termWidth, opts.full, {
        onlyChanges: true
      });
    }
  }
  if (hasPull) {
    lines.push("");
    lines.push(`  ${FgBlue}${Bold}\u2B07 TO PULL${Reset}`);
    if (newKeysOnLocal.length > 0) {
      lines.push("");
      lines.push(
        `  ${FgBlue}${newKeysOnLocal.length} new keys from server:${Reset}`
      );
      renderSection(lines, newKeysOnLocal, termWidth, opts.full);
    }
    if (missingTranslationsLocalKeys.length > 0) {
      const totalCount = Object.values(
        comparison.missingTranslationsOnLocalPerLanguage
      ).reduce(
        (s, keys) => s + keys.filter((k) => !newKeyNamesOnLocal.has(getComparisonKey(k))).length,
        0
      );
      lines.push("");
      lines.push(
        `  ${FgBlue}${totalCount} translations available across ${missingTranslationsLocalKeys.length} keys:${Reset}`
      );
      renderSection(lines, missingTranslationsLocalKeys, termWidth, opts.full, {
        onlyChanges: true
      });
    }
  }
  if (status.languages.serverOnly.length > 0) {
    lines.push("");
    lines.push(
      `  ${FgYellow}Languages on server not in local files: ${status.languages.serverOnly.join(", ")}${Reset}`
    );
  }
  renderCoverage(lines, opts.coverage, opts.full);
  lines.push("");
  return lines.join("\n");
}
function renderStatusJson(status, coverage, filter) {
  const totalMissingTranslationsToPush = Object.values(
    status.toPush.missingTranslations
  ).reduce((sum, keys) => sum + keys.length, 0);
  const totalMissingTranslationsToPull = Object.values(
    status.toPull.missingTranslations
  ).reduce((sum, keys) => sum + keys.length, 0);
  return JSON.stringify(
    {
      version: 1,
      command: "status",
      status: status.needPush || status.needPull ? "has_changes" : "clean",
      filter: {
        applied: (filter?.keys.length ?? 0) > 0 || (filter?.namespaces.length ?? 0) > 0,
        keys: filter?.keys ?? [],
        namespaces: filter?.namespaces ?? []
      },
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
      },
      translation_coverage: coverage ? {
        strategy: coverage.strategy,
        status: coverage.status,
        summary: {
          keys_with_missing_translations: coverage.keysWithMissingTranslations,
          missing_language_pairs: coverage.missingLanguagePairs,
          translatable_keys: coverage.translatableKeys,
          translatable_language_pairs: coverage.translatableLanguagePairs,
          blocked_keys: coverage.blockedKeys
        },
        work_items: coverage.workItems.map((item) => ({
          key_id: item.keyId,
          key: item.key,
          namespace: item.namespace,
          missing_languages: item.languages
        })),
        blocked_items: coverage.blockedItems.map((item) => ({
          key_id: item.keyId,
          key: item.key,
          namespace: item.namespace,
          missing_languages: item.missingLanguages,
          reason: item.reason
        }))
      } : void 0
    },
    null,
    2
  );
}
function renderCoverage(lines, coverage, full) {
  if (!coverage) return;
  lines.push("");
  lines.push(`  ${Bold}TRANSLATION COVERAGE${Reset}`);
  if (coverage.status === "complete") {
    lines.push(`  ${FgGreen}All target translations are present.${Reset}`);
    return;
  }
  lines.push(
    `  ${FgYellow}${coverage.missingLanguagePairs} missing language pair(s) across ${coverage.keysWithMissingTranslations} key(s).${Reset}`
  );
  const limit = full ? coverage.workItems.length : 10;
  for (const item of coverage.workItems.slice(0, limit)) {
    const label = item.namespace ? `${item.namespace}:${item.key}` : item.key;
    lines.push(`    ${label}: ${item.languages.join(", ")}`);
  }
  if (coverage.workItems.length > limit) {
    lines.push(
      `    ${Dim}... and ${coverage.workItems.length - limit} more. Run with --full for the complete list.${Reset}`
    );
  }
  if (coverage.blockedKeys > 0) {
    lines.push(
      `  ${FgYellow}${coverage.blockedKeys} key(s) are blocked because they have no approved reference translation.${Reset}`
    );
  }
}
function renderPushJson(pushPlan, filter, dryRun = false) {
  const totalTranslations = Object.values(
    pushPlan.missingTranslationsPerLanguage
  ).reduce((sum, keys) => sum + keys.length, 0);
  return JSON.stringify(
    {
      version: 1,
      command: "push",
      status: dryRun ? "dry_run" : pushPlan.hasChanges ? "pushed" : "nothing_to_push",
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
        conflicts: pushPlan.conflicts,
        archived_keys: pushPlan.keysToRemove
      },
      counts: {
        new_languages: pushPlan.newLanguages.length,
        new_keys: pushPlan.newKeys.length,
        translations: totalTranslations,
        conflicts: pushPlan.conflicts.length,
        archived_keys: pushPlan.keysToRemove.length
      }
    },
    null,
    2
  );
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
  const result = await unarchiveCliKey(
    ctx.host,
    ctx.projectId,
    ctx.accessToken,
    {
      locator: makeLocator(options)
    }
  );
  if (ctx.flags.json) {
    printJson({
      command: "key_unarchive",
      key: result.key,
      status: "unarchived",
      version: 1
    });
    return;
  }
  console.info(
    `${FgGreen}Unarchived key:${Reset} ${formatKeyLine(result.key)}`
  );
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
function formatKeyLine(key) {
  const namespace = key.namespace ? `${key.namespace}:` : "";
  const archived = key.deleted ? " archived" : "";
  return `${namespace}${key.key} ${key.id}${archived}`;
}

async function collectKeysToRemove(input) {
  const { serverOnlyKeys } = input;
  if (serverOnlyKeys.length === 0) return [];
  if (input.prune) return serverOnlyKeys;
  if (input.noInteraction) return [];
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

function getSyncQuestionScope(input) {
  const selected = input.selectedKeys ?? resolveSelectedKeys(
    input.keys ?? [],
    input.syncResult.mergedKeysByKeyByNamespace,
    input.namespaces ?? []
  );
  const keyIds = Object.values(input.syncResult.mergedKeysByKeyByNamespace).flatMap((keys) => Object.values(keys)).filter(
    (key) => key.server && selected.has(getComparisonKey(key)) && (!input.onlyExisting || key.local) && (!input.keyIds?.length || input.keyIds.includes(key.server.id))
  ).flatMap((key) => key.server ? [key.server.id] : []);
  return { keyIds, languages: input.languages ?? input.targetLanguages };
}

async function syncAndTranslate(input) {
  const { host, projectId, accessToken, flags } = input;
  const json = flags.json;
  let { syncResult } = input;
  const selectedKeys = input.keys.length > 0 || input.namespaces.length > 0 ? resolveSelectedKeys(
    input.keys,
    syncResult.mergedKeysByKeyByNamespace,
    input.namespaces
  ) : void 0;
  const invalidLanguages = (input.languages ?? []).filter(
    (language) => !input.targetLanguages.includes(language)
  );
  if (invalidLanguages.length > 0) {
    throw new Error(
      `Invalid target language code(s): ${[...new Set(invalidLanguages)].join(", ")}.`
    );
  }
  if (!json) console.info(`
${Bold}  Sync & Translate${Reset}
`);
  let pushResult;
  let pushStatus = "nothing_to_push";
  const keysToRemove = await collectKeysToRemove({
    serverOnlyKeys: syncResult.status.issues.serverOnlyKeys,
    noInteraction: flags.noInteraction,
    prune: input.prune
  });
  const removedKeyIds = new Set(
    keysToRemove.map((key) => getComparisonKey(key))
  );
  const keptServerOnlyKeys = syncResult.status.issues.serverOnlyKeys.filter(
    (key) => !removedKeyIds.has(getComparisonKey(key))
  );
  if (syncResult.status.needPush || keysToRemove.length > 0) {
    if (!json) console.info(`  Pushing...`);
    syncResult = await input.doPush(keysToRemove);
    pushResult = syncResult.pushResult;
    pushStatus = "pushed";
    const created = pushResult?.createdKeyIds.length ?? 0;
    const updated = pushResult?.updatedKeyIds.length ?? 0;
    if (!json) {
      const parts = [];
      if (created > 0)
        parts.push(`${created} new key${created !== 1 ? "s" : ""}`);
      if (updated > 0)
        parts.push(`${updated} updated value${updated !== 1 ? "s" : ""}`);
      const archived = pushResult?.archivedKeyIds?.length ?? 0;
      if (archived > 0)
        parts.push(`${archived} archived key${archived !== 1 ? "s" : ""}`);
      if (parts.length > 0) {
        console.info(`  ${FgGreen}\u2713 ${parts.join(", ")} pushed${Reset}`);
      } else {
        console.info(`  ${FgGreen}\u2713 Push complete${Reset}`);
      }
    }
  }
  const pushedKeyIds = [
    ...pushResult?.createdKeyIds ?? [],
    ...pushResult?.updatedKeyIds ?? []
  ];
  if (pushStatus === "pushed") {
    syncResult = await input.reFetchAndSync();
  }
  const workSet = computeTranslationWork({
    mergedKeysByKeyByNamespace: syncResult.mergedKeysByKeyByNamespace,
    targetLanguages: input.targetLanguages,
    strategy: "missing",
    onlyExisting: input.onlyExisting,
    emptyValueString: input.emptyValueString,
    languages: input.languages,
    keys: input.keys,
    namespaces: input.namespaces,
    selectedKeys
  });
  const workKeyIds = new Set(workSet.map((w) => w.keyId));
  const workLanguages = [
    ...new Set(workSet.flatMap((item) => item.languages))
  ].sort();
  const workSummary = {
    keys: workSet.length,
    language_pairs: workSet.reduce(
      (total, item) => total + item.languages.length,
      0
    ),
    languages: workLanguages,
    strategy: "missing"
  };
  let translateSummary;
  if (workSet.length > 0) {
    translateSummary = await questionTranslateLoop({
      host,
      projectId,
      accessToken,
      flags,
      workSet,
      questionKeyIds: workKeyIds,
      languages: input.languages,
      model: input.model,
      maxCreditUnits: input.maxCreditUnits,
      timeout: input.timeout
    });
  } else if (!json) {
    console.info(`
  No translations needed.`);
  }
  if (!json) reportFormatWarnings(translateSummary?.formatWarningCount);
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
  const pullTranslationsCount = Object.values(
    pullToPull.missingTranslations
  ).reduce((sum, keys) => sum + keys.length, 0);
  let pullStatus = "nothing_to_pull";
  if (syncResult.status.needPull) {
    if (!flags.noInteraction) {
      pullStatus = "pulled";
      await pullWithTierPicker({
        flags,
        syncResult,
        pushedKeyIds,
        doPull: input.doPull,
        hasS2tContext: true,
        scores
      });
    } else {
      const pullOptions = automaticPullOptions(
        syncResult,
        keptServerOnlyKeys,
        input.onlyExisting
      );
      if (pullOptions !== "skip") {
        pullStatus = "pulled";
        if (!json) console.info(`
  Pulling...`);
        await input.doPull(pullOptions);
        if (!json) console.info(`  ${FgGreen}\u2713 Translations pulled${Reset}`);
      }
    }
  } else if (!json) {
    console.info(`
  ${FgGreen}\u2713 Nothing new to pull.${Reset}`);
  }
  const followUp = await readTranslationFollowUp(
    input,
    translateSummary?.jobId ? { jobId: translateSummary.jobId } : getSyncQuestionScope({ ...input, syncResult, selectedKeys }),
    translateSummary?.status === "timeout"
  );
  if (!json) printTranslationFollowUp(followUp);
  if (json) {
    const overallStatus = translateSummary?.status === "failed" ? "failed" : translateSummary?.status === "timeout" ? "timeout" : "complete";
    console.info(
      JSON.stringify(
        {
          version: 1,
          command: "sync-and-translate",
          follow_up: followUp,
          status: overallStatus,
          job_id: translateSummary?.jobId,
          phases: {
            push: {
              status: pushStatus,
              counts: {
                new_keys: pushResult?.createdKeyIds.length ?? 0,
                updated_keys: pushResult?.updatedKeyIds.length ?? 0,
                archived_keys: pushResult?.archivedKeyIds?.length ?? 0
              }
            },
            translate: {
              status: translateSummary?.status ?? "skipped",
              summary: workSummary,
              counts: {
                total: translateSummary?.total ?? 0,
                finished: translateSummary?.finished ?? 0,
                failed: translateSummary?.failed ?? 0
              },
              failures: translateSummary?.failures ?? [],
              format_warning_count: translateSummary?.formatWarningCount ?? 0,
              error: translateSummary?.error,
              process_counts: {
                total: translateSummary?.total ?? 0,
                finished: translateSummary?.finished ?? 0,
                failed: translateSummary?.failed ?? 0
              },
              billing: {
                billable_processes: translateSummary?.billableProcesses ?? 0
              },
              credits_charged: translateSummary ? {
                units: translateSummary.creditsCharged.total,
                monthly_units: translateSummary.creditsCharged.monthly,
                persistent_units: translateSummary.creditsCharged.persistent,
                unit_scale: 100,
                display: translateSummary.creditsCharged.total / 100
              } : void 0
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
    return translateSummary?.status === "failed" || translateSummary?.status === "timeout" ? 2 : 0;
  }
  if (translateSummary?.status === "failed" || translateSummary?.status === "timeout") {
    const message = translateSummary.status === "timeout" ? "Translation is still running; completed results were pulled." : "Translation could not be started or finished; available results were pulled.";
    console.info(`
${FgYellow}${Bold}  ${message}${Reset}
`);
  } else {
    console.info(
      `
${FgGreen}${Bold}  Done \u2014 your changes are synced.${Reset}
`
    );
  }
  return translateSummary?.status === "failed" || translateSummary?.status === "timeout" ? 2 : 0;
}
function buildScoreMap(reviews) {
  const map = /* @__PURE__ */ new Map();
  for (const r of reviews) {
    map.set(`${r.keyId}:${r.languageCode}`, r.score);
  }
  return map;
}
async function questionTranslateLoop(input) {
  const { host, projectId, accessToken, flags, workSet, questionKeyIds } = input;
  let iteration = 0;
  let summary;
  let remainingCreditUnits = input.maxCreditUnits;
  let billableProcesses = 0;
  const creditsCharged = { total: 0, monthly: 0, persistent: 0 };
  while (true) {
    iteration++;
    const label = iteration === 1 ? "Checking for questions" : "Checking for new questions";
    if (!flags.json) {
      process.stdout.write(`
  ${Dim}${label}...${Reset}`);
    }
    const questions = filterQuestionsForKeys(
      await fetchQuestions(host, projectId, accessToken),
      questionKeyIds,
      input.languages
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
    let response;
    try {
      const apiWork = keysToTranslate.map(({ keyId, languages }) => ({
        keyId,
        languages
      }));
      response = remainingCreditUnits === void 0 ? await requestTranslation(
        host,
        projectId,
        accessToken,
        apiWork,
        input.model
      ) : await requestTranslation(
        host,
        projectId,
        accessToken,
        apiWork,
        input.model,
        remainingCreditUnits
      );
    } catch (error) {
      return {
        status: "failed",
        total: summary?.total ?? 0,
        finished: summary?.finished ?? 0,
        failed: summary?.failed ?? 0,
        failures: summary?.failures ?? [],
        formatWarningCount: summary?.formatWarningCount ?? 0,
        error: serializeCliError(error),
        billableProcesses,
        creditsCharged
      };
    }
    billableProcesses += response.numberOfBillableProcesses ?? 0;
    if (response.creditsCharged) {
      creditsCharged.total += response.creditsCharged.total;
      creditsCharged.monthly += response.creditsCharged.monthly;
      creditsCharged.persistent += response.creditsCharged.persistent;
      if (remainingCreditUnits !== void 0) {
        remainingCreditUnits -= response.creditsCharged.total;
      }
    }
    const finalStatus = await pollTranslationJob(
      host,
      projectId,
      accessToken,
      response.jobId,
      input.timeout,
      flags
    );
    summary = {
      jobId: response.jobId,
      status: finalStatus.status,
      total: finalStatus.total,
      finished: finalStatus.finished,
      failed: finalStatus.failed,
      failures: finalStatus.failures,
      formatWarningCount: (summary?.formatWarningCount ?? 0) + (finalStatus.formatWarningCount ?? 0),
      billableProcesses,
      creditsCharged
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
          `  ${FgYellow}Translation timed out. The job is still running. Run \`babli job ${response.jobId} --wait\` to keep waiting.${Reset}`
        );
      }
      break;
    }
    if (flags.noInteraction) break;
    if (iteration >= 3) break;
    const newQuestions = filterQuestionsForKeys(
      await fetchQuestions(host, projectId, accessToken),
      questionKeyIds,
      input.languages
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
function filterQuestionsForKeys(questions, keyIds, languages) {
  const languageSet = languages ? new Set(languages) : void 0;
  return questions.filter(
    (question) => keyIds.has(question.keyId) && (!languageSet || languageSet.has(question.languageCode))
  );
}
function automaticPullOptions(syncResult, keptServerOnlyKeys, onlyExisting) {
  const fullPull = onlyExisting ? { onlyExisting: true } : void 0;
  if (keptServerOnlyKeys.length === 0 || onlyExisting || syncResult.status.languages.serverOnly.length > 0) {
    return fullPull;
  }
  const kept = new Set(keptServerOnlyKeys.map((key) => getComparisonKey(key)));
  const other = /* @__PURE__ */ new Set();
  const consider = (key) => {
    const id = getComparisonKey(key);
    if (!kept.has(id)) other.add(id);
  };
  for (const key of syncResult.status.toPull.missingKeys) consider(key);
  for (const key of Object.values(syncResult.comparison.missingKeysOnLocal)) {
    consider(key);
  }
  for (const keys of Object.values(
    syncResult.comparison.missingTranslationsOnLocalPerLanguage
  )) {
    for (const key of keys) consider(key);
  }
  const statusTranslationCount = Object.values(
    syncResult.status.toPull.missingTranslations
  ).reduce((sum, names) => sum + names.length, 0);
  const listedTranslations = Object.keys(syncResult.comparison.missingTranslationsOnLocalPerLanguage).length > 0;
  if (statusTranslationCount > 0 && !listedTranslations) return fullPull;
  if (other.size === 0) return "skip";
  return { selectedKeys: other };
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
    if (!flags.json)
      console.info(`
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
    await getCliProject(input.host, input.projectId, input.accessToken);
    if (input.strategy === "replace" && !input.keys?.length && !input.keyIds?.length && !input.namespaces?.length)
      throw new Error(
        "Replacement requires --key, --key-id, or --namespace to name the wording to replace."
      );
  } catch (error) {
    return reportFailure(input, void 0, error);
  }
  let work;
  try {
    validateLanguages(input);
    work = computeWork(input);
  } catch (error) {
    return reportFailure(input, void 0, error);
  }
  const summary = summarize(work, input.strategy);
  if (work.length === 0) {
    const followUp2 = input.dryRun || input.estimate ? void 0 : await readTranslationFollowUp(input, getSyncQuestionScope(input));
    if (followUp2 && !input.flags.json) printTranslationFollowUp(followUp2);
    if (input.flags.json) {
      emitJson({
        version: 1,
        command: "translate",
        status: "skipped",
        follow_up: followUp2,
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
        summary,
        work_items: serializeWorkItems(work)
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
    const apiWork = work.map(({ keyId, languages }) => ({ keyId, languages }));
    const quality = translationQuality(input);
    response = input.maxCreditUnits === void 0 ? quality ? await requestTranslation(
      input.host,
      input.projectId,
      input.accessToken,
      apiWork,
      input.model,
      void 0,
      quality
    ) : await requestTranslation(
      input.host,
      input.projectId,
      input.accessToken,
      apiWork,
      input.model
    ) : quality ? await requestTranslation(
      input.host,
      input.projectId,
      input.accessToken,
      apiWork,
      input.model,
      input.maxCreditUnits,
      quality
    ) : await requestTranslation(
      input.host,
      input.projectId,
      input.accessToken,
      apiWork,
      input.model,
      input.maxCreditUnits
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
        follow_up: await readTranslationFollowUp(
          input,
          { jobId: response.jobId },
          true
        ),
        job_id: response.jobId,
        summary,
        billing: response.numberOfBillableProcesses === void 0 ? void 0 : { billable_processes: response.numberOfBillableProcesses },
        credits_charged: serializeChargedCredits(response.creditsCharged)
      });
    } else {
      console.info(
        `${Dim}Job started: ${response.jobId} (${response.numberOfProcesses} processes)${Reset}`
      );
      console.info(
        `Run ${Bold}babli job ${response.jobId} --wait${Reset} to wait for completion.`
      );
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
  const followUp = await readTranslationFollowUp(
    input,
    { jobId: response.jobId },
    finalStatus.status === "timeout"
  );
  if (!input.flags.json) printTranslationFollowUp(followUp);
  if (input.flags.json) {
    emitJson({
      version: 1,
      command: "translate",
      follow_up: followUp,
      status: finalStatus.status,
      job_id: response.jobId,
      counts: {
        total: finalStatus.total,
        finished: finalStatus.finished,
        failed: finalStatus.failed
      },
      process_counts: {
        total: finalStatus.total,
        finished: finalStatus.finished,
        failed: finalStatus.failed
      },
      summary,
      billing: response.numberOfBillableProcesses === void 0 ? void 0 : { billable_processes: response.numberOfBillableProcesses },
      credits_charged: serializeChargedCredits(response.creditsCharged),
      failures: finalStatus.failures.length > 0 ? finalStatus.failures : void 0,
      format_warning_count: finalStatus.formatWarningCount ?? 0
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
    console.info(
      `Run ${Bold}babli job ${response.jobId} --wait${Reset} to keep waiting.`
    );
  }
  if (!input.flags.json) reportFormatWarnings(finalStatus.formatWarningCount);
  return finalStatus.status === "failed" || finalStatus.status === "timeout" ? 2 : 0;
}
async function runEstimate(input, work, summary) {
  let estimate;
  try {
    const keys = work.map(({ keyId, languages }) => ({ keyId, languages }));
    const quality = translationQuality(input);
    estimate = quality ? await estimateTranslation(
      input.host,
      input.projectId,
      input.accessToken,
      keys,
      input.model,
      quality
    ) : await estimateTranslation(
      input.host,
      input.projectId,
      input.accessToken,
      keys,
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
    need_to_buy: estimate.creditsToUse.needToBuy,
    unit_scale: 100,
    display_total: estimate.creditsToUse.total / 100,
    display_monthly: estimate.creditsToUse.monthly / 100,
    display_persistent: estimate.creditsToUse.persistent / 100,
    display_need_to_buy: estimate.creditsToUse.needToBuy / 100
  };
  if (input.flags.json) {
    emitJson({
      version: 1,
      command: "translate",
      status: "estimate",
      summary,
      work_items: serializeWorkItems(work),
      process_counts: {
        total: estimate.numberOfProcesses,
        finished: 0,
        failed: 0
      },
      billing: estimate.numberOfBillableProcesses === void 0 ? void 0 : { billable_processes: estimate.numberOfBillableProcesses },
      credits
    });
  } else {
    console.info(
      `
${Bold}Estimate: ${summary.keys} key(s), ${summary.language_pairs} language pair(s).${Reset}`
    );
    console.info(
      `${Dim}Credits needed: ${credits.display_total} (monthly ${credits.display_monthly}, persistent ${credits.display_persistent})${Reset}`
    );
    if (credits.has_enough) {
      console.info(`${FgGreen}You have enough credits.${Reset}`);
    } else {
      console.info(
        `${FgYellow}Not enough credits \u2014 need to buy ${credits.display_need_to_buy} more.${Reset}`
      );
    }
  }
  return 0;
}
function translationQuality(input) {
  if (!input.primaryLanguage && !input.referenceMode && !input.allowUnapprovedSources && input.strategy !== "replace")
    return void 0;
  return {
    primaryLanguage: input.primaryLanguage,
    referenceMode: input.referenceMode,
    ...input.allowUnapprovedSources ? { allowUnapprovedSources: true } : {},
    ...input.strategy === "replace" ? { replaceExisting: true } : {}
  };
}
function serializeChargedCredits(credits) {
  if (!credits) return void 0;
  return {
    units: credits.total,
    monthly_units: credits.monthly,
    persistent_units: credits.persistent,
    unit_scale: 100,
    display: credits.total / 100
  };
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
    const label = item.namespace ? `${item.namespace}:${item.key}` : item.key;
    console.info(`  ${label}: ${item.languages.join(", ")}`);
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
    const keysById = /* @__PURE__ */ new Map();
    for (const keysInNamespace of Object.values(
      input.syncResult.mergedKeysByKeyByNamespace
    )) {
      for (const key of Object.values(keysInNamespace)) {
        if (!key.server || !input.keyIds.includes(key.server.id)) continue;
        keysById.set(key.server.id, {
          keyId: key.server.id,
          key: key.key,
          namespace: key.server.namespace,
          languages
        });
      }
    }
    const invalidIds = input.keyIds.filter((keyId) => !keysById.has(keyId));
    if (invalidIds.length > 0) {
      throw new Error(`Invalid key id(s): ${invalidIds.join(", ")}.`);
    }
    return [...keysById.values()];
  }
  return computeTranslationWork({
    mergedKeysByKeyByNamespace: input.syncResult.mergedKeysByKeyByNamespace,
    allowUnapprovedSources: input.allowUnapprovedSources,
    targetLanguages: input.targetLanguages,
    strategy: input.strategy,
    onlyExisting: input.onlyExisting,
    emptyValueString: input.emptyValueString,
    languages: input.languages,
    keys: input.keys,
    namespaces: input.namespaces
  });
}
function serializeWorkItems(work) {
  return work.map((item) => ({
    key_id: item.keyId,
    key: item.key,
    namespace: item.namespace,
    missing_languages: item.languages
  }));
}

function validateKeyRenameOptions(options) {
  if (options.file !== void 0) {
    if (!options.file.trim()) throw new Error("Provide a nonblank --file path.");
    if ([options.key, options.keyId, options.namespace, options.to].some((value) => value !== void 0)) {
      throw new Error("Use --file separately from single-key lookup and destination flags.");
    }
    return;
  }
  if (options.dryRun) throw new Error("--dry-run requires --file.");
  if (options.allowUnpushed) throw new Error("--allow-unpushed requires --file.");
  if (!options.to) throw new Error("Provide --to or --file.");
  if (options.keyId !== void 0 === (options.key !== void 0)) throw new Error("Provide exactly one of --key-id or --key.");
}

function validateKeyUpdateOptions(options) {
  if (options.file !== void 0) {
    if (!options.file.trim())
      throw new Error("Provide a nonblank --file path.");
    const singleKeyFlags = [
      options.keyId,
      options.key,
      options.namespace,
      options.newNamespace,
      options.source,
      options.description
    ];
    if (singleKeyFlags.some((value) => value !== void 0)) {
      throw new Error(
        "Use --file separately from single-key lookup and update flags."
      );
    }
  } else if (options.dryRun) {
    throw new Error("--dry-run requires --file.");
  }
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

  quality check|show|decide|retry  Review translations through your coding agent
  questions                    Show and answer translation questions

  key list                     List remote keys
  key get                      Get one remote key
  key export                   Export compact key context
  key add                      Add a remote key
  key update                   Update key metadata/source text
  key rename                   Rename keys, namespaces, and sources
  key archive                  Archive a remote key
  key unarchive                Unarchive a remote key

  translation upsert           Create or update a translation

  project list|create          List or create projects
  project get                  Show remote project metadata
  project update               Update remote project metadata
  organization list|get|update  Manage organizations and shared instructions
  glossary                     Manage project and organization glossary terms

${agentTranslationGuidance}

Examples:
  babli status
  babli push --no-interaction
  babli pull
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
  "--prune",
  "Archive server keys absent from local translation files in the selected scope"
).option("--dry-run", "Preview changes without writing to the server").option(
  "--allow-empty-prune",
  "Allow archiving when no configured local translation files are found"
).addHelpText("after", `
${agentTranslationGuidance}
`).option(
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
  '\nExamples:\n  babli push                          # interactive, confirm each step\n  babli push --resolve local           # overwrite server for all conflicts\n  babli push --prune --dry-run --json   # preview uploads and archives\n  babli push --prune --no-interaction  # upload and archive server-only keys\n  babli push --no-interaction          # push all, no prompts\n  babli push --json --no-interaction   # for CI/agents\n  babli push --key "auth:*"            # only push keys in the auth namespace\n  babli push --namespace checkout      # only push the checkout namespace\n  babli push --key "auth:*" --dry-run --json  # preview the scoped plan\n\n--key and --namespace combine with AND (a key must match both).'
).action(
  async (options) => {
    await run({
      action: "push",
      prune: options.prune === true,
      allowEmptyPrune: options.allowEmptyPrune === true,
      dryRun: options.dryRun === true,
      keys: options.key,
      namespaces: options.namespace
    });
  }
);
program.command("pull").description("Pull translations from server to local files").option(
  "--only-existing",
  "Only pull updates to keys that already exist locally"
).option(
  "--keep-local-only",
  "Keep local keys that are not on the server instead of removing them"
).option(
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
  babli pull --only-existing       # skip new keys, update existing only
  babli pull --keep-local-only     # keep keys that exist only locally
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
        onlyExisting: options.onlyExisting,
        keepLocalOnly: options.keepLocalOnly === true,
        keys: options.key,
        namespaces: options.namespace
      }
    });
  }
);
program.command("status").description("Show sync status between local files and server").option(
  "--key <pattern>",
  'Only inspect keys matching this glob (repeatable; quote it; "namespace:key")',
  collectOption,
  []
).option(
  "--namespace <pattern>",
  "Only inspect keys in namespaces matching this glob (repeatable)",
  collectOption,
  []
).addHelpText(
  "after",
  'Examples:\n  babli status                                      # file sync and translation coverage\n  babli status --full                               # show all items\n  babli status --json                               # JSON output for agents\n  babli status --namespace speech --key "mosquito.*" # scoped status'
).action(async (options) => {
  await run({
    action: "status",
    keys: options.key,
    namespaces: options.namespace
  });
});
program.command("translate").description("Trigger AI translation for missing translations").addHelpText("after", `
${agentTranslationGuidance}
`).option(
  "--strategy <strategy>",
  "Which values to generate: missing, not-approved (neither AI nor human approved), or replace",
  "missing"
).option(
  "--languages <codes>",
  "Only translate these languages (comma-separated)"
).option(
  "--only-existing",
  "Only translate keys that exist in your local files"
).option(
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
).option("--key-ids <ids>", "Translate these key ids (comma-separated)").option(
  "--model <model>",
  "Translation model: production | preview",
  "production"
).option(
  "--dry-run",
  "Print the work-set without spending credits or starting a job"
).option(
  "--estimate",
  "Print the real credit cost without spending or starting a job"
).option(
  "--max-credits <amount>",
  "Refuse to dispatch if the exact cost exceeds this credit amount"
).option(
  "--wait",
  "Block and poll until the job finishes (non-interactive mode returns the job id immediately by default)"
).option("--timeout <seconds>", "Max wait time when polling", "300").option(
  "--allow-unapproved-sources",
  "Translate sources without a current AI pass or human approval"
).option(
  "--primary-language <code>",
  "Primary source language when the project has more than one source"
).option(
  "--reference-mode <mode>",
  "Supporting references to use: either (default), ai, or human"
).addHelpText(
  "after",
  '\nExamples:\n  babli translate                    # translate all missing, interactive\n  babli translate --languages cs,de  # only Czech and German\n  babli translate --strategy missing       # generate values that are absent\n  babli translate --only-existing    # skip keys not in local files\n  babli translate --key "auth:*"     # only translate the auth namespace\n  babli translate --namespace checkout  # only translate the checkout namespace\n  babli translate --key-ids key_1,key_2 --no-interaction\n  babli translate --dry-run --json   # complete work-set, no spend\n  babli translate --namespace speech --estimate --json\n  babli translate --namespace speech --max-credits 7.00 --wait --json\n  babli translate --json --no-interaction  # dispatch and return a job id\n\nInspect follow_up after completion: answer questions from evidence, ask the user about unknown product facts, and report anything unresolved.\nOn timeout, run `babli job <job_id> --wait`; do not dispatch translate again.\n--key and --namespace combine with AND (a key must match both).'
).action(
  async (options) => {
    const timeout = parseInt(options.timeout, 10);
    if (Number.isNaN(timeout) || timeout <= 0) {
      throw new Error(`Invalid --timeout value: "${options.timeout}"`);
    }
    if (options.dryRun && options.estimate) {
      throw new Error("Use either --dry-run or --estimate, not both.");
    }
    if (options.strategy !== "missing" && options.strategy !== "not-approved" && options.strategy !== "replace") {
      throw new Error(
        `Invalid --strategy value: "${options.strategy}". Use "missing", "replace", or "not-approved".`
      );
    }
    if (options.model !== "production" && options.model !== "preview") {
      throw new Error(
        `Invalid --model value: "${options.model}". Use "production" or "preview".`
      );
    }
    const referenceMode = options.referenceMode === void 0 ? void 0 : options.referenceMode === "either" || options.referenceMode === "ai" || options.referenceMode === "human" ? options.referenceMode : null;
    if (referenceMode === null) {
      throw new Error(
        `Invalid --reference-mode value: "${options.referenceMode}". Use "either", "ai", or "human".`
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
        maxCreditUnits: options.maxCredits === void 0 ? void 0 : parseCreditUnits(options.maxCredits),
        timeout,
        wait: options.wait === true,
        primaryLanguage: options.primaryLanguage,
        allowUnapprovedSources: options.allowUnapprovedSources,
        referenceMode
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
withGlobalOptions(keyCommand.command("get")).description("Get one remote key").option("--key-id <id>", "Key id").option("--key <name>", "Key name").option("--namespace <namespace>", "Key namespace").option("--include-archived", "Allow archived key lookup").action(
  async (options) => {
    await run({
      action: "key-get",
      options: {
        ...options,
        includeArchived: options.includeArchived === true
      }
    });
  }
);
withGlobalOptions(keyCommand.command("export")).description("Export compact key context for a source language").requiredOption("--language <code>", "Source language code").requiredOption("--output <path>", "Output JSON file").action(async (options) => {
  await run({ action: "key-export", options });
});
withGlobalOptions(keyCommand.command("add")).description("Add one remote key").requiredOption("--key <name>", "Key name").option("--namespace <namespace>", "Key namespace", "").option("--source <text>", "Source metadata", "").option("--description <text>", "Key description").option(
  "--translation <code=value>",
  "Approved translation",
  collectOption,
  []
).action(
  async (options) => {
    await run({ action: "key-add", options });
  }
);
withGlobalOptions(keyCommand.command("update")).description("Update key metadata").option("--key-id <id>", "Key id").option("--key <name>", "Key name").option("--namespace <namespace>", "Namespace for key lookup").option("--new-namespace <namespace>", "New namespace").option("--source <text>", "Source metadata").option("--description <text>", "Key description").option(
  "--file <path>",
  "Validated description draft file (separate from single-key flags)"
).option("--dry-run", "Check a description file without writing changes").action(async (options) => {
  options.dryRun = options.dryRun === true;
  validateKeyUpdateOptions(options);
  await run({ action: "key-update", options });
});
withGlobalOptions(keyCommand.command("rename")).description("Rename keys, namespaces, and source placement").option("--key-id <id>", "Key id").option("--key <name>", "Key name").option("--namespace <namespace>", "Key namespace").option("--to <new-key>", "New key name").option("--file <path>", "Atomic rename manifest; - reads JSON from stdin").option("--dry-run", "Validate the entire manifest without writing").option(
  "--allow-unpushed",
  "Rename even when local files have changes that are not pushed"
).action(async (options) => {
  options.dryRun = options.dryRun === true;
  options.allowUnpushed = options.allowUnpushed === true;
  validateKeyRenameOptions(options);
  await run({ action: "key-rename", options });
});
withGlobalOptions(keyCommand.command("archive")).description("Archive one key").option("--key-id <id>", "Key id").option("--key <name>", "Key name").option("--namespace <namespace>", "Key namespace").action(async (options) => {
  await run({ action: "key-archive", options });
});
withGlobalOptions(keyCommand.command("unarchive")).description("Unarchive one key").option("--key-id <id>", "Key id").option("--key <name>", "Key name").option("--namespace <namespace>", "Key namespace").action(async (options) => {
  await run({ action: "key-unarchive", options });
});
const translationCommand = program.command("translation").description("Manage remote translations");
withGlobalOptions(translationCommand.command("upsert")).description("Create or update one translation").option("--key-id <id>", "Key id").option("--key <name>", "Key name").option("--namespace <namespace>", "Key namespace").requiredOption("--language <code>", "Language code").option("--value <text>", "Translation value").option("--value-file <path>", "Read translation value from a file or -").action(
  async (options) => {
    await run({
      action: "translation-upsert",
      options
    });
  }
);
registerAdministrationCommands(
  program,
  async (input) => run({ action: "administration", input }),
  withGlobalOptions
);
const projectCommand = program.command("project").description("Manage remote project metadata");
withGlobalOptions(projectCommand.command("get")).description("Get remote project metadata").option("--project <id>", "Project id (defaults to babli.json project)").option(
  "--include-inherited",
  "Include company instructions and their precedence"
).action(async (options) => {
  await run({ action: "project-get", options });
});
withGlobalOptions(projectCommand.command("list")).description("List projects across your organizations").option("--organization <id>", "Filter to one organization").action(async (options) => {
  await run({ action: "project-list", options });
});
withGlobalOptions(projectCommand.command("create")).description("Create a new project").requiredOption("--name <name>", "Project name").requiredOption("--organization <id>", "Organization id").option("--type <type>", "Project type: key | document", "key").option("--description <text>", "Project description").option(
  "--languages <codes>",
  "Comma-separated language codes; first is the source"
).action(
  async (options) => {
    await run({ action: "project-create", options });
  }
);
withGlobalOptions(projectCommand.command("update")).description("Update remote project metadata").option("--project <id>", "Project id (defaults to babli.json project)").option("--name <name>", "Project name").option("--description <text>", "Project description").option(
  "--description-file <path>",
  "Read project description from a file or -"
).option("--instructions <text>", "Project translation instructions").option(
  "--instructions-file <path>",
  "Read project instructions from a file or -"
).action(async (options) => {
  await run({ action: "project-update", options });
});
program.command("sync-and-translate").description("Push local changes, translate, and pull results").option(
  "--allow-empty-prune",
  "Allow archiving when no configured local translation files are found"
).option(
  "--prune",
  "Archive server keys absent from local translation files in the selected scope"
).addHelpText("after", `
${agentTranslationGuidance}
`).option(
  "--resolve <strategy>",
  "Resolve push conflicts non-interactively: local | server"
).option(
  "--only-existing",
  "Only translate and pull keys that exist in your local files"
).option(
  "--languages <codes>",
  "Only translate these languages (comma-separated)"
).option(
  "--key <pattern>",
  'Only sync keys matching this glob (repeatable; quote it; "namespace:key")',
  collectOption,
  []
).option(
  "--namespace <pattern>",
  "Only sync keys in namespaces matching this glob (repeatable)",
  collectOption,
  []
).option(
  "--model <model>",
  "Translation model: production | preview",
  "production"
).option("--max-credits <amount>", "Maximum cumulative credit charge").option("--timeout <seconds>", "Max wait time when polling", "300").addHelpText(
  "after",
  'Examples:\n  babli sync-and-translate --json --no-interaction # descriptions prepared; waits automatically; inspect follow_up afterward\n  babli sync-and-translate                         # interactive\n  babli sync-and-translate --only-existing         # skip keys not in local files\n  babli sync-and-translate --prune --json          # also archive server-only keys\n  babli sync-and-translate --namespace speech --key "mosquito.*" --max-credits 7.00'
).action(
  async (options) => {
    if (options.model !== "production" && options.model !== "preview") {
      throw new Error(`Invalid --model value: "${options.model}"`);
    }
    const timeout = parseInt(options.timeout, 10);
    if (Number.isNaN(timeout) || timeout <= 0) {
      throw new Error(`Invalid --timeout value: "${options.timeout}"`);
    }
    await run({
      action: "sync-and-translate",
      options: {
        onlyExisting: options.onlyExisting === true,
        prune: options.prune === true,
        allowEmptyPrune: options.allowEmptyPrune === true,
        keys: options.key,
        namespaces: options.namespace,
        languages: options.languages?.split(",").map((language) => language.trim()).filter(Boolean),
        model: options.model,
        maxCreditUnits: options.maxCredits === void 0 ? void 0 : parseCreditUnits(options.maxCredits),
        timeout
      }
    });
  }
);
registerQualityCommands(
  program,
  async (input) => {
    await run({ action: "quality", input });
  },
  withGlobalOptions
);
const humanReview = program.command("human-review").description("Ask subscribed colleagues to check wording");
withGlobalOptions(humanReview.command("request")).description("Email subscribed reviewers for the selected translations").option(
  "--translation-id <id>",
  "Translation UUID (repeatable)",
  collectOption,
  []
).option(
  "--key <name>",
  "Key or namespace:key (repeatable)",
  collectOption,
  []
).option(
  "--language <code>",
  "Limit --key selection to this language (repeatable)",
  collectOption,
  []
).option("--reason <text>", "Why this review is needed", "").option("--source <code>", "Source language to review against").option("--request-id <uuid>", "Reuse after an uncertain submission").action(
  async (options) => {
    process.exit(
      await humanReviewCommand({
        action: "request",
        options: { ...options, json: getGlobalFlags().json }
      })
    );
  }
);
withGlobalOptions(humanReview.command("status")).description("Show whether invited wording has a later human decision").requiredOption("--invitation <id>", "Invitation id returned by request").action(async (options) => {
  process.exit(
    await humanReviewCommand({
      action: "status",
      invitationId: options.invitation,
      json: options.json
    })
  );
});
program.command("questions").option("--job <id>", "Inspect questions for the exact translation job scope").option(
  "--key <pattern>",
  "Only matching namespaced keys (repeatable)",
  collectOption,
  []
).option(
  "--namespace <pattern>",
  "Only matching namespaces (repeatable)",
  collectOption,
  []
).option("--key-id <id>", "Only this key UUID (repeatable)", collectOption, []).option("--languages <codes>", "Only these languages (comma-separated)").description("Show and answer unanswered translation questions").option(
  "--answers-file <path>",
  "Submit a JSON answers file without prompting (requires a user token)"
).addHelpText(
  "after",
  "\nExamples:\n  babli questions                    # interactive\n  babli questions --json             # JSON output for agents"
).action(
  async (options) => {
    await run({
      action: "questions",
      answersFile: options.answersFile,
      scope: {
        jobId: options.job,
        keys: options.key,
        namespaces: options.namespace,
        ...options.keyId.length ? { keyIds: options.keyId } : {},
        languages: options.languages?.split(",").map((code) => code.trim())
      }
    });
  }
);
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
      await exitAfterFlush(1);
    }
    if (result.exitCode !== void 0 && result.exitCode !== 0) {
      await exitAfterFlush(result.exitCode);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("User force closed the prompt")) {
      console.info("Exiting...");
      await exitAfterFlush(0);
    }
    if (getGlobalFlags().json) {
      if (err instanceof KeyDescriptionBatchError) {
        console.info(JSON.stringify(err.report, null, 2));
        await exitAfterFlush(2);
      }
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
      await exitAfterFlush(2);
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
    await exitAfterFlush(2);
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
  const localKeys = await gatherSyncLocalKeys({
    allFilesByPattern,
    keySeparator: projectInfo.keySeparator,
    emptyValueString: ctx.emptyValueString,
    transformConfigs,
    transforms,
    fileAPI: CliFileApi,
    cwd: process.cwd()
  });
  const snapshot = await fetchSyncKeys(ctx, cliInput, localKeys);
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
    allServerKeys: snapshot.keys,
    withheldChanges: "withheldChanges" in snapshot ? snapshot.withheldChanges : void 0,
    localKeys,
    getFilePatternOrPath,
    writeFile,
    removeFile: (file) => fs__default.rm(file, { force: true }),
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
  const server = await pingServer(host, buildInfo.versionLabel);
  const orgCtx = { host, accessToken, flags };
  if (cliInput.action === "project-list") {
    await projectListCommand(orgCtx, cliInput.options);
    return { needPush: false, needPull: false };
  }
  if (cliInput.action === "project-create") {
    await projectCreateCommand(orgCtx, cliInput.options);
    return { needPush: false, needPull: false };
  }
  if (cliInput.action === "administration") {
    const context = { ...orgCtx, projectId: parsed?.projectId };
    if (cliInput.input.kind === "organization")
      await organizationCommand(context, cliInput.input);
    else await glossaryCommand(context, cliInput.input);
    return { needPush: false, needPull: false };
  }
  if (cliInput.action === "project-get" || cliInput.action === "project-update") {
    await projectMetadataCommand(
      { ...orgCtx, projectId: parsed?.projectId },
      cliInput.action === "project-get" ? "get" : "update",
      cliInput.options
    );
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
  if (cliInput.action === "quality") {
    if (!server.capabilities?.includes("quality-review-v1"))
      throw new Error(
        "This server does not support CLI linguistic review. Update the server before submitting review work."
      );
    const exitCode = await qualityCommand(surgicalCtx, cliInput.input);
    return { needPush: false, needPull: false, exitCode };
  }
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
  if (cliInput.action === "key-export") {
    await keyExportCommand(surgicalCtx, cliInput.options);
    return { needPush: false, needPull: false };
  }
  if (cliInput.action === "key-add") {
    await keyAddCommand(surgicalCtx, cliInput.options);
    return { needPush: false, needPull: false };
  }
  if (cliInput.action === "key-update") {
    if (cliInput.options.file !== void 0) {
      await keyDescriptionFileCommand(surgicalCtx, {
        file: cliInput.options.file,
        dryRun: cliInput.options.dryRun
      });
    } else {
      await keyUpdateCommand(surgicalCtx, cliInput.options);
    }
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
    capabilities: server.capabilities ?? [],
    emptyValueString: parsed.emptyValueString,
    defaultFilePattern: parsed.defaultFilePattern
  };
  const doSync = (action) => performSync(syncCtx, action, translationFilesConfig, transforms);
  if (cliInput.action === "key-rename") {
    if (cliInput.options.file !== void 0) {
      if (!cliInput.options.allowUnpushed) {
        const status = await doSync({ action: "status" });
        assertNoUnpushedChanges(status.status);
      }
      await keyRenameFileCommand(
        surgicalCtx,
        { file: cliInput.options.file, dryRun: cliInput.options.dryRun },
        translationFilesConfig
      );
    } else {
      await keyRenameCommand(surgicalCtx, cliInput.options);
    }
    return { needPush: false, needPull: false };
  }
  if (cliInput.action === "workflow" || cliInput.action === "sync-and-translate") {
    const projectInfo = await fetchProjectInfo(host, projectId, accessToken);
    const projectName = projectInfo.name;
    const targetLanguages = getTargetLanguageCodes(projectInfo.languages);
    let questionsFetchFailed = false;
    const workflowKeys = cliInput.action === "sync-and-translate" ? cliInput.options.keys : [];
    const workflowNamespaces = cliInput.action === "sync-and-translate" ? cliInput.options.namespaces : [];
    const statusInput = {
      action: "status",
      keys: workflowKeys,
      namespaces: workflowNamespaces
    };
    const [result2, questions] = await Promise.all([
      doSync(statusInput),
      fetchQuestions(host, projectId, accessToken).catch(() => {
        questionsFetchFailed = true;
        return [];
      })
    ]);
    const workflowSelectedKeys = workflowKeys.length > 0 || workflowNamespaces.length > 0 ? resolveSelectedKeys(
      workflowKeys,
      result2.mergedKeysByKeyByNamespace,
      workflowNamespaces
    ) : void 0;
    const s2tInput = {
      host,
      projectId,
      accessToken,
      flags,
      syncResult: result2,
      targetLanguages,
      prune: cliInput.action === "sync-and-translate" && cliInput.options.prune,
      emptyValueString: parsed.emptyValueString,
      onlyExisting: cliInput.action === "sync-and-translate" ? cliInput.options.onlyExisting : false,
      keys: workflowKeys,
      namespaces: workflowNamespaces,
      languages: cliInput.action === "sync-and-translate" ? cliInput.options.languages : void 0,
      model: cliInput.action === "sync-and-translate" ? cliInput.options.model : "production",
      maxCreditUnits: cliInput.action === "sync-and-translate" ? cliInput.options.maxCreditUnits : void 0,
      timeout: cliInput.action === "sync-and-translate" ? cliInput.options.timeout : 300,
      doPush: (keysToRemove) => doSync({
        action: "push",
        keysToRemove,
        allowEmptyPrune: cliInput.action === "sync-and-translate" && cliInput.options.allowEmptyPrune,
        quiet: true,
        keys: workflowKeys,
        namespaces: workflowNamespaces
      }),
      reFetchAndSync: () => doSync({ ...statusInput, selectedKeys: workflowSelectedKeys }),
      doPull: async (options) => {
        await doSync({
          action: "pull",
          options: {
            keys: workflowKeys,
            namespaces: workflowNamespaces,
            selectedKeys: workflowSelectedKeys,
            ...options
          }
        });
      }
    };
    if (cliInput.action === "sync-and-translate") {
      const exitCode = await syncAndTranslate(s2tInput);
      return { needPush: false, needPull: false, exitCode };
    }
    const dashboard = computeDashboard(
      result2.status,
      questions.length,
      projectName,
      {
        questionsFetchFailed
      }
    );
    if (flags.json) {
      console.info(
        renderDashboardJson(dashboard, result2.status, questions.length)
      );
      return {
        needPush: result2.status.needPush,
        needPull: result2.status.needPull
      };
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
      console.info(
        renderStatusHuman(result2.comparison, result2.status, { full: false })
      );
    }
    return { needPush: false, needPull: false };
  }
  if (cliInput.action === "questions") {
    await questionsCommand({
      host,
      projectId,
      accessToken,
      flags,
      answersFile: cliInput.answersFile,
      scope: cliInput.scope
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
    const projectInfo = await fetchProjectInfo(host, projectId, accessToken);
    const coverage = computeTranslationCoverage({
      syncResult: result,
      targetLanguages: getTargetLanguageCodes(projectInfo.languages),
      emptyValueString: parsed.emptyValueString,
      keys: cliInput.keys,
      namespaces: cliInput.namespaces
    });
    const filter = {
      keys: cliInput.keys ?? [],
      namespaces: cliInput.namespaces ?? []
    };
    if (flags.json) {
      console.info(renderStatusJson(result.status, coverage, filter));
    } else {
      console.info(
        renderStatusHuman(result.comparison, result.status, {
          full: flags.full,
          coverage
        })
      );
    }
  }
  if (cliInput.action === "push") {
    const pushPlan = computePushPlan(result.comparison);
    if (flags.json) {
      console.info(
        renderPushJson(pushPlan, result.pushFilter, cliInput.dryRun === true)
      );
    } else if (cliInput.dryRun) {
      renderPushPreview(pushPlan);
    }
  }
  if (cliInput.action === "pull" && flags.json) {
    console.info(renderPullJson(unwrap(result.pullResult)));
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
      maxCreditUnits: cliInput.options.maxCreditUnits,
      primaryLanguage: cliInput.options.primaryLanguage,
      allowUnapprovedSources: cliInput.options.allowUnapprovedSources,
      referenceMode: cliInput.options.referenceMode,
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

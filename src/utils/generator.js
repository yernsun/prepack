/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

/* @flow */

import type { Realm } from "../realm.js";
import {
  AbstractValue,
  Value,
  FunctionValue,
  UndefinedValue,
  NullValue,
  StringValue,
  BooleanValue,
  NumberValue,
  SymbolValue,
  ObjectValue,
  ConcreteValue,
} from "../values/index.js";
import type { AbstractValueBuildNodeFunction } from "../values/AbstractValue.js";
import type { Descriptor } from "../types.js";
import { TypesDomain, ValuesDomain } from "../domains/index.js";
import * as base62 from "base62";
import * as t from "babel-types";
import invariant from "../invariant.js";
import type {
  BabelNodeExpression,
  BabelNodeIdentifier,
  BabelNodeStatement,
  BabelNodeMemberExpression,
} from "babel-types";
import { nullExpression } from "./internalizer.js";

export type SerializationContext = {
  serializeValue: Value => BabelNodeExpression,
  serializeGenerator: Generator => Array<BabelNodeStatement>,
  emitDefinePropertyBody: (ObjectValue, string | SymbolValue, Descriptor) => BabelNodeStatement,
  emit: BabelNodeStatement => void,
  canOmit: AbstractValue => boolean,
  declare: AbstractValue => void,
};

export type GeneratorBuildNodeFunction = (Array<BabelNodeExpression>, SerializationContext) => BabelNodeStatement;

export type GeneratorEntry = {
  declared?: AbstractValue,
  args: Array<Value>,
  buildNode: GeneratorBuildNodeFunction,
  dependencies?: Array<Generator>,
  isPure?: boolean,
};

export type VisitEntryCallbacks = {|
  visitValue: Value => void,
  visitGenerator: Generator => void,
  canSkip: AbstractValue => boolean,
  recordDeclaration: AbstractValue => void,
  recordDelayedEntry: GeneratorEntry => void,
|};

export class Generator {
  constructor(realm: Realm) {
    invariant(realm.useAbstractInterpretation);
    let realmPreludeGenerator = realm.preludeGenerator;
    invariant(realmPreludeGenerator);
    this.preludeGenerator = realmPreludeGenerator;
    this.parent = realm.generator;
    this.realm = realm;
    this.body = [];
  }

  realm: Realm;
  body: Array<GeneratorEntry>;
  preludeGenerator: PreludeGenerator;
  parent: void | Generator;

  clone(): Generator {
    let result = new Generator(this.realm);
    result.body = this.body.slice(0);
    return result;
  }

  getAsPropertyNameExpression(key: string, canBeIdentifier: boolean = true) {
    // If key is a non-negative numeric string literal, parse it and set it as a numeric index instead.
    let index = Number.parseInt(key, 10);
    if (index >= 0 && index.toString() === key) {
      return t.numericLiteral(index);
    }

    if (canBeIdentifier) {
      // TODO: revert this when Unicode identifiers are supported by all targetted JavaScript engines
      let keyIsAscii = /^[\u0000-\u007f]*$/.test(key);
      if (t.isValidIdentifier(key) && keyIsAscii) return t.identifier(key);
    }

    return t.stringLiteral(key);
  }

  getParent(): void | Generator {
    return this.parent;
  }

  empty() {
    return !this.body.length;
  }

  emitGlobalDeclaration(key: string, value: Value) {
    this.preludeGenerator.declaredGlobals.add(key);
    if (!(value instanceof UndefinedValue)) this.emitGlobalAssignment(key, value, true);
  }

  emitGlobalAssignment(key: string, value: Value, strictMode: boolean) {
    this.body.push({
      args: [value],
      buildNode: ([valueNode]) =>
        t.expressionStatement(
          t.assignmentExpression("=", this.preludeGenerator.globalReference(key, !strictMode), valueNode)
        ),
    });
  }

  emitGlobalDelete(key: string, strictMode: boolean) {
    this.body.push({
      args: [],
      buildNode: ([]) =>
        t.expressionStatement(t.unaryExpression("delete", this.preludeGenerator.globalReference(key, !strictMode))),
    });
  }

  emitPropertyAssignment(object: Value, key: string, value: Value) {
    let propName = this.getAsPropertyNameExpression(key);
    this.body.push({
      args: [object, value],
      buildNode: ([objectNode, valueNode]) =>
        t.expressionStatement(
          t.assignmentExpression("=", t.memberExpression(objectNode, propName, !t.isIdentifier(propName)), valueNode)
        ),
    });
  }

  emitDefineProperty(object: ObjectValue, key: string, desc: Descriptor) {
    if (desc.enumerable && desc.configurable && desc.writable && desc.value) {
      let descValue = desc.value;
      invariant(descValue instanceof Value);
      this.emitPropertyAssignment(object, key, descValue);
    } else {
      desc = Object.assign({}, desc);
      this.body.push({
        args: [
          object,
          desc.value || object.$Realm.intrinsics.undefined,
          desc.get || object.$Realm.intrinsics.undefined,
          desc.set || object.$Realm.intrinsics.undefined,
        ],
        buildNode: (_, context: SerializationContext) => context.emitDefinePropertyBody(object, key, desc),
      });
    }
  }

  emitPropertyDelete(object: Value, key: string) {
    let propName = this.getAsPropertyNameExpression(key);
    this.body.push({
      args: [object],
      buildNode: ([objectNode]) =>
        t.expressionStatement(
          t.unaryExpression("delete", t.memberExpression(objectNode, propName, !t.isIdentifier(propName)))
        ),
    });
  }

  emitCall(createCallee: () => BabelNodeExpression, args: Array<Value>) {
    this.body.push({
      args,
      buildNode: values => t.expressionStatement(t.callExpression(createCallee(), [...values])),
    });
  }

  emitConsoleLog(method: "log" | "warn" | "error", args: Array<string | ConcreteValue>) {
    this.emitCall(
      () => t.memberExpression(t.identifier("console"), t.identifier(method)),
      args.map(v => (typeof v === "string" ? new StringValue(this.realm, v) : v))
    );
  }

  emitInvariant(
    args: Array<Value>,
    violationConditionFn: (Array<BabelNodeExpression>) => BabelNodeExpression,
    appendLastToInvariantFn?: BabelNodeExpression => BabelNodeExpression
  ): void {
    this.body.push({
      args,
      buildNode: (nodes: Array<BabelNodeExpression>) => {
        let throwString = t.stringLiteral("Prepack model invariant violation");
        if (appendLastToInvariantFn) {
          let last = nodes.pop();
          throwString = t.binaryExpression(
            "+",
            t.stringLiteral("Prepack model invariant violation: "),
            appendLastToInvariantFn(last)
          );
        }
        let condition = violationConditionFn(nodes);
        let throwblock = t.blockStatement([t.throwStatement(t.newExpression(t.identifier("Error"), [throwString]))]);
        return t.ifStatement(condition, throwblock);
      },
    });
  }

  emitCallAndCaptureResult(
    types: TypesDomain,
    values: ValuesDomain,
    createCallee: () => BabelNodeExpression,
    args: Array<Value>,
    kind?: string
  ): AbstractValue {
    return this.derive(types, values, args, nodes => t.callExpression(createCallee(), nodes));
  }

  emitVoidExpression(
    types: TypesDomain,
    values: ValuesDomain,
    args: Array<Value>,
    buildNode_: AbstractValueBuildNodeFunction | BabelNodeExpression
  ): UndefinedValue {
    this.body.push({
      args,
      buildNode: (nodes: Array<BabelNodeExpression>) =>
        t.expressionStatement(
          (buildNode_: any) instanceof Function
            ? ((buildNode_: any): AbstractValueBuildNodeFunction)(nodes)
            : ((buildNode_: any): BabelNodeExpression)
        ),
    });
    return this.realm.intrinsics.undefined;
  }

  derive(
    types: TypesDomain,
    values: ValuesDomain,
    args: Array<Value>,
    buildNode_: AbstractValueBuildNodeFunction | BabelNodeExpression,
    optionalArgs?: {| kind?: string, isPure?: boolean, skipInvariant?: boolean |}
  ): AbstractValue {
    invariant(buildNode_ instanceof Function || args.length === 0);
    let id = t.identifier(this.preludeGenerator.nameGenerator.generate("derived"));
    this.preludeGenerator.derivedIds.set(id.name, args);
    let res = this.realm.createAbstract(types, values, [], id, optionalArgs ? optionalArgs.kind : undefined);
    this.body.push({
      isPure: optionalArgs ? optionalArgs.isPure : undefined,
      declared: res,
      args,
      buildNode: (nodes: Array<BabelNodeExpression>) =>
        t.variableDeclaration("var", [
          t.variableDeclarator(
            id,
            (buildNode_: any) instanceof Function
              ? ((buildNode_: any): AbstractValueBuildNodeFunction)(nodes)
              : ((buildNode_: any): BabelNodeExpression)
          ),
        ]),
    });
    let type = types.getType();
    res.intrinsicName = id.name;
    if (optionalArgs && optionalArgs.skipInvariant) return res;
    let typeofString;
    if (type instanceof FunctionValue) typeofString = "function";
    else if (type === UndefinedValue) invariant(false);
    else if (type === NullValue) invariant(false);
    else if (type === StringValue) typeofString = "string";
    else if (type === BooleanValue) typeofString = "boolean";
    else if (type === NumberValue) typeofString = "number";
    else if (type === SymbolValue) typeofString = "symbol";
    else if (type === ObjectValue) typeofString = "object";
    if (typeofString !== undefined) {
      // Verify that the types are as expected, a failure of this invariant
      // should mean the model is wrong.
      this.emitInvariant(
        [res, res],
        nodes => {
          invariant(typeofString !== undefined);
          let condition = t.binaryExpression(
            "!==",
            t.unaryExpression("typeof", nodes[0]),
            t.stringLiteral(typeofString)
          );
          if (typeofString === "object") {
            condition = t.logicalExpression(
              "&&",
              condition,
              t.binaryExpression("!==", t.unaryExpression("typeof", nodes[0]), t.stringLiteral("function"))
            );
            condition = t.logicalExpression("||", condition, t.binaryExpression("===", nodes[0], nullExpression));
          }
          return condition;
        },
        node => node
      );
    }

    return res;
  }

  serialize(context: SerializationContext) {
    for (let entry of this.body) {
      if (!entry.isPure || !entry.declared || !context.canOmit(entry.declared)) {
        let nodes = entry.args.map((boundArg, i) => context.serializeValue(boundArg));
        context.emit(entry.buildNode(nodes, context));
        if (entry.declared !== undefined) context.declare(entry.declared);
      }
    }
  }

  visitEntry(entry: GeneratorEntry, callbacks: VisitEntryCallbacks) {
    if (entry.isPure && entry.declared && callbacks.canSkip(entry.declared)) {
      callbacks.recordDelayedEntry(entry);
    } else {
      if (entry.declared) callbacks.recordDeclaration(entry.declared);
      for (let boundArg of entry.args) callbacks.visitValue(boundArg);
      if (entry.dependencies) for (let dependency of entry.dependencies) callbacks.visitGenerator(dependency);
    }
  }

  visit(callbacks: VisitEntryCallbacks) {
    for (let bodyEntry of this.body) this.visitEntry(bodyEntry, callbacks);
  }
}

export class NameGenerator {
  constructor(forbiddenNames: Set<string>, debugNames: boolean, uniqueSuffix: string, prefix: string) {
    this.prefix = prefix;
    this.uidCounter = 0;
    this.debugNames = debugNames;
    this.forbiddenNames = forbiddenNames;
    this.uniqueSuffix = uniqueSuffix;
  }
  prefix: string;
  uidCounter: number;
  debugNames: boolean;
  forbiddenNames: Set<string>;
  uniqueSuffix: string;
  generate(debugSuffix: ?string): string {
    let id;
    do {
      id = this.prefix + base62.encode(this.uidCounter++);
      if (this.uniqueSuffix.length > 0) id += this.uniqueSuffix;
      if (this.debugNames) {
        if (debugSuffix) id += "_" + debugSuffix.replace(/[.,:]/g, "_");
        else id += "_";
      }
    } while (this.forbiddenNames.has(id));
    return id;
  }
}

export class PreludeGenerator {
  constructor(debugNames: ?boolean, uniqueSuffix: ?string) {
    this.prelude = [];
    this.derivedIds = new Map();
    this.memoizedRefs = new Map();
    this.nameGenerator = new NameGenerator(new Set(), !!debugNames, uniqueSuffix || "", "_$");
    this.usesThis = false;
    this.declaredGlobals = new Set();
  }

  prelude: Array<BabelNodeStatement>;
  derivedIds: Map<string, Array<Value>>;
  memoizedRefs: Map<string, BabelNodeIdentifier>;
  nameGenerator: NameGenerator;
  usesThis: boolean;
  declaredGlobals: Set<string>;

  createNameGenerator(prefix: string): NameGenerator {
    return new NameGenerator(
      this.nameGenerator.forbiddenNames,
      this.nameGenerator.debugNames,
      this.nameGenerator.uniqueSuffix,
      prefix
    );
  }

  convertStringToMember(str: string): BabelNodeIdentifier | BabelNodeMemberExpression {
    return str
      .split(".")
      .map(name => (name === "global" ? this.memoizeReference(name) : t.identifier(name)))
      .reduce((obj, prop) => t.memberExpression(obj, prop));
  }

  globalReference(key: string, globalScope: boolean = false) {
    if (globalScope && t.isValidIdentifier(key)) return t.identifier(key);
    let keyNode = t.isValidIdentifier(key) ? t.identifier(key) : t.stringLiteral(key);
    return t.memberExpression(this.memoizeReference("global"), keyNode, !t.isIdentifier(keyNode));
  }

  memoizeReference(key: string): BabelNodeIdentifier {
    let ref = this.memoizedRefs.get(key);
    if (ref) return ref;

    let init;
    if (key.includes("(") || key.includes("[")) {
      // Horrible but effective hack:
      // Some internal object have intrinsic names such as
      //    ([][Symbol.iterator]().__proto__.__proto__)
      // and
      //    RegExp.prototype[Symbol.match]
      // which get turned into a babel node here.
      // TODO: We should properly parse such a string, and memoize all references in it separately.
      // Instead, we just turn it into a funky identifier, which Babel seems to accept.
      init = t.identifier(key);
    } else if (key === "global") {
      this.usesThis = true;
      init = t.thisExpression();
    } else {
      let i = key.lastIndexOf(".");
      if (i === -1) {
        init = t.memberExpression(this.memoizeReference("global"), t.identifier(key));
      } else {
        init = t.memberExpression(this.memoizeReference(key.substr(0, i)), t.identifier(key.substr(i + 1)));
      }
    }
    ref = t.identifier(this.nameGenerator.generate(key));
    this.prelude.push(t.variableDeclaration("var", [t.variableDeclarator(ref, init)]));
    this.memoizedRefs.set(key, ref);
    return ref;
  }
}

/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

/* @flow */

import type {
  BabelNode,
  BabelNodeComment,
  BabelNodeFile,
  BabelNodeLVal,
  BabelNodePosition,
  BabelNodeStatement,
  BabelNodeSourceLocation,
} from "babel-types";
import type { Realm } from "./realm.js";
import type { SourceFile, SourceMap, SourceType } from "./types.js";

import {
  AbruptCompletion,
  Completion,
  JoinedAbruptCompletions,
  NormalCompletion,
  PossiblyNormalCompletion,
  ThrowCompletion,
} from "./completions.js";
import { CompilerDiagnostic, FatalError } from "./errors.js";
import { defaultOptions } from "./options";
import type { PartialEvaluatorOptions } from "./options";
import { ExecutionContext } from "./realm.js";
import { Value } from "./values/index.js";
import {
  AbstractValue,
  NullValue,
  SymbolValue,
  BooleanValue,
  FunctionValue,
  NumberValue,
  ObjectValue,
  AbstractObjectValue,
  StringValue,
  UndefinedValue,
} from "./values/index.js";
import generate from "babel-generator";
import parse from "./utils/parse.js";
import invariant from "./invariant.js";
import traverseFast from "./utils/traverse-fast.js";
import {
  ToBooleanPartial,
  HasProperty,
  Get,
  GetValue,
  PutValue,
  DefinePropertyOrThrow,
  Set,
  IsExtensible,
  HasOwnProperty,
  IsDataDescriptor,
  ThrowIfMightHaveBeenDeleted,
  composePossiblyNormalCompletions,
  updatePossiblyNormalCompletionWithValue,
} from "./methods/index.js";
import * as t from "babel-types";

const sourceMap = require("source-map");

// ECMA262 8.1.1
export class EnvironmentRecord {
  realm: Realm;
  isReadOnly: boolean;
  $NewTarget: void | ObjectValue;

  constructor(realm: Realm) {
    invariant(realm, "expected realm");
    this.realm = realm;
    this.isReadOnly = false;
  }

  +HasBinding: (N: string) => boolean;
  +CreateMutableBinding: (N: string, D: boolean) => Value;
  +CreateImmutableBinding: (N: string, S: boolean) => Value;
  +InitializeBinding: (N: string, V: Value) => Value;
  +SetMutableBinding: (N: string, V: Value, S: boolean) => Value;
  +GetBindingValue: (N: string, S: boolean) => Value;
  +DeleteBinding: (N: string) => boolean;
  +HasThisBinding: () => boolean;
  +GetThisBinding: () => NullValue | ObjectValue | AbstractObjectValue | UndefinedValue;
  +HasSuperBinding: () => boolean;
  +WithBaseObject: () => Value;
  +BindThisValue: (
    V: NullValue | ObjectValue | AbstractObjectValue | UndefinedValue
  ) => NullValue | ObjectValue | AbstractObjectValue | UndefinedValue;
}

export type Binding = {
  value?: Value,
  initialized?: boolean,
  mutable?: boolean,
  deletable?: boolean,
};

// ECMA262 8.1.1.1
export class DeclarativeEnvironmentRecord extends EnvironmentRecord {
  constructor(realm: Realm) {
    super(realm);
    this.bindings = Object.create(null);
  }

  bindings: { [name: string]: Binding };

  // ECMA262 8.1.1.1.1
  HasBinding(N: string): boolean {
    // 1. Let envRec be the declarative Environment Record for which the method was invoked.
    let envRec = this;

    // 2. If envRec has a binding for the name that is the value of N, return true.
    if (envRec.bindings[N]) return true;

    // 3. Return false.
    return false;
  }

  // ECMA262 8.1.1.1.2
  CreateMutableBinding(N: string, D: boolean): Value {
    let realm = this.realm;

    // 1. Let envRec be the declarative Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Assert: envRec does not already have a binding for N.
    invariant(!envRec.bindings[N], `shouldn't have the binding ${N}`);

    // 3. Create a mutable binding in envRec for N and record that it is uninitialized. If D is true, record that the newly created binding may be deleted by a subsequent DeleteBinding call.
    this.bindings[N] = realm.recordModifiedBinding(
      {
        initialized: false,
        mutable: true,
        deletable: D,
      },
      envRec
    );

    // 4. Return NormalCompletion(empty).
    return realm.intrinsics.undefined;
  }

  // ECMA262 8.1.1.1.3
  CreateImmutableBinding(N: string, S: boolean): Value {
    let realm = this.realm;

    // 1. Let envRec be the declarative Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Assert: envRec does not already have a binding for N.
    invariant(!envRec.bindings[N], `shouldn't have the binding ${N}`);

    // 3. Create an immutable binding in envRec for N and record that it is uninitialized. If S is true, record that the newly created binding is a strict binding.
    this.bindings[N] = realm.recordModifiedBinding(
      {
        initialized: false,
        strict: S,
        deletable: false,
      },
      envRec
    );

    // 4. Return NormalCompletion(empty).
    return realm.intrinsics.undefined;
  }

  // ECMA262 8.1.1.1.4
  InitializeBinding(N: string, V: Value): Value {
    // 1. Let envRec be the declarative Environment Record for which the method was invoked.
    let envRec = this;

    let binding = envRec.bindings[N];

    // 2. Assert: envRec must have an uninitialized binding for N.
    invariant(binding && !binding.initialized, `shouldn't have the binding ${N}`);

    // 3. Set the bound value for N in envRec to V.
    this.realm.recordModifiedBinding(binding, envRec).value = V;

    // 4. Record that the binding for N in envRec has been initialized.
    binding.initialized = true;

    // 5. Return NormalCompletion(empty).
    return this.realm.intrinsics.empty;
  }

  // ECMA262 8.1.1.1.5
  SetMutableBinding(N: string, V: Value, S: boolean): Value {
    let realm = this.realm;

    // 1. Let envRec be the declarative Environment Record for which the method was invoked.
    let envRec = this;

    let binding = envRec.bindings[N];

    // 2. If envRec does not have a binding for N, then
    if (!binding) {
      // a. If S is true, throw a ReferenceError exception.
      if (S) {
        throw realm.createErrorThrowCompletion(realm.intrinsics.ReferenceError, `${N} not found`);
      }

      // b. Perform envRec.CreateMutableBinding(N, true).
      envRec.CreateMutableBinding(N, true);

      // c. Perform envRec.InitializeBinding(N, V).
      envRec.InitializeBinding(N, V);

      // d. Return NormalCompletion(empty).
      return this.realm.intrinsics.empty;
    }

    // 3. If the binding for N in envRec is a strict binding, let S be true.
    if (binding.strict) S = true;

    // 4. If the binding for N in envRec has not yet been initialized, throw a ReferenceError exception.
    if (!binding.initialized) {
      throw realm.createErrorThrowCompletion(realm.intrinsics.ReferenceError, `${N} has not yet been initialized`);
    } else if (binding.mutable) {
      // 5. Else if the binding for N in envRec is a mutable binding, change its bound value to V.
      realm.recordModifiedBinding(binding, envRec).value = V;
    } else {
      // 6. Else,
      // a. Assert: This is an attempt to change the value of an immutable binding.

      // b. If S is true, throw a TypeError exception.
      if (S) {
        throw realm.createErrorThrowCompletion(realm.intrinsics.TypeError, "attempt to change immutable binding");
      }
    }

    // 7. Return NormalCompletion(empty).
    return this.realm.intrinsics.empty;
  }

  // ECMA262 8.1.1.1.6
  GetBindingValue(N: string, S: boolean): Value {
    let realm = this.realm;

    // 1. Let envRec be the declarative Environment Record for which the method was invoked.
    let envRec = this;

    let binding = envRec.bindings[N];

    // 2. Assert: envRec has a binding for N.
    invariant(binding, "expected binding");

    // 3. If the binding for N in envRec is an uninitialized binding, throw a ReferenceError exception.
    if (!binding.initialized) {
      throw realm.createErrorThrowCompletion(realm.intrinsics.ReferenceError);
    }

    // 4. Return the value currently bound to N in envRec.
    invariant(binding.value);
    return binding.value;
  }

  // ECMA262 8.1.1.1.7
  DeleteBinding(N: string): boolean {
    // 1. Let envRec be the declarative Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Assert: envRec has a binding for the name that is the value of N.
    invariant(envRec.bindings[N], "expected binding to exist");

    // 3. If the binding for N in envRec cannot be deleted, return false.
    if (!envRec.bindings[N].deletable) return false;

    // 4. Remove the binding for N from envRec.
    this.realm.recordModifiedBinding(envRec.bindings[N], envRec).value = undefined;
    delete envRec.bindings[N];

    // 5. Return true.
    return true;
  }

  // ECMA262 8.1.1.1.8
  HasThisBinding(): boolean {
    // 1. Return false.
    return false;
  }

  // ECMA262 8.1.1.1.9
  HasSuperBinding(): boolean {
    // 1. Return false.
    return false;
  }

  // ECMA262 8.1.1.1.10
  WithBaseObject(): Value {
    // 1. Return undefined.
    return this.realm.intrinsics.undefined;
  }
}

// ECMA262 8.1.1.2
export class ObjectEnvironmentRecord extends EnvironmentRecord {
  object: ObjectValue | AbstractObjectValue;
  withEnvironment: boolean;

  constructor(realm: Realm, obj: ObjectValue | AbstractObjectValue) {
    super(realm);
    this.object = obj;
  }

  // ECMA262 8.1.1.2.1
  HasBinding(N: string): boolean {
    let realm = this.realm;

    // 1. Let envRec be the object Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Let bindings be the binding object for envRec.
    let bindings = this.object;

    // 3. Let foundBinding be ? HasProperty(bindings, N).
    let foundBinding = HasProperty(realm, bindings, N);

    // 4. If foundBinding is false, return false.
    if (!foundBinding) return false;

    // 5. If the withEnvironment flag of envRec is false, return true.
    if (!envRec.withEnvironment) return true;

    // 6. Let unscopables be ? Get(bindings, @@unscopables).
    let unscopables = Get(realm, bindings, realm.intrinsics.SymbolUnscopables);

    // 7. If Type(unscopables) is Object, then
    if (unscopables instanceof ObjectValue || unscopables instanceof AbstractObjectValue) {
      // a. Let blocked be ToBoolean(? Get(unscopables, N)).
      let blocked = ToBooleanPartial(realm, Get(realm, unscopables, N));

      // b. If blocked is true, return false.
      if (blocked) return false;
    }
    unscopables.throwIfNotConcrete();

    // 8. Return true.
    return true;
  }

  // ECMA262 8.1.1.2.2
  CreateMutableBinding(N: string, D: boolean): Value {
    let realm = this.realm;

    // 1. Let envRec be the object Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Let bindings be the binding object for envRec.
    let bindings = envRec.object;

    // 3. If D is true, let configValue be true; otherwise let configValue be false.
    let configValue = D ? true : false;

    // 4. Return ? DefinePropertyOrThrow(bindings, N, PropertyDescriptor{[[Value]]: undefined, [[Writable]]: true, [[Enumerable]]: true, [[Configurable]]: configValue}).
    return new BooleanValue(
      realm,
      DefinePropertyOrThrow(realm, bindings, N, {
        value: realm.intrinsics.undefined,
        writable: true,
        enumerable: true,
        configurable: configValue,
      })
    );
  }

  // ECMA262 8.1.1.2.3
  CreateImmutableBinding(N: string, S: boolean): Value {
    // The concrete Environment Record method CreateImmutableBinding is never used within this specification in association with object Environment Records.
    invariant(false);
  }

  // ECMA262 8.1.1.2.4
  InitializeBinding(N: string, V: Value): Value {
    // 1. Let envRec be the object Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Assert: envRec must have an uninitialized binding for N.
    // 3. Record that the binding for N in envRec has been initialized.

    // 4. Return ? envRec.SetMutableBinding(N, V, false).
    return envRec.SetMutableBinding(N, V, false);
  }

  // ECMA262 8.1.1.2.5
  SetMutableBinding(N: string, V: Value, S: boolean): Value {
    let realm = this.realm;

    // 1. Let envRec be the object Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Let bindings be the binding object for envRec.
    let bindings = envRec.object;

    // 3. Return ? Set(bindings, N, V, S).
    return new BooleanValue(realm, Set(realm, bindings, N, V, S));
  }

  // ECMA262 8.1.1.2.6
  GetBindingValue(N: string, S: boolean): Value {
    let realm = this.realm;

    // 1. Let envRec be the object Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Let bindings be the binding object for envRec.
    let bindings = envRec.object;

    // 3. Let value be ? HasProperty(bindings, N).
    let value = HasProperty(realm, bindings, N);

    // 4. If value is false, then
    if (!value) {
      // a. If S is false, return the value undefined; otherwise throw a ReferenceError exception.
      if (!S) {
        return realm.intrinsics.undefined;
      } else {
        throw realm.createErrorThrowCompletion(realm.intrinsics.ReferenceError);
      }
    }

    // 5. Return ? Get(bindings, N).
    return Get(realm, bindings, N);
  }

  // ECMA262 8.1.1.2.7
  DeleteBinding(N: string): boolean {
    // 1. Let envRec be the object Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Let bindings be the binding object for envRec.
    let bindings = envRec.object;

    // 3. Return ? bindings.[[Delete]](N).
    return bindings.$Delete(N);
  }

  // ECMA262 8.1.1.2.8
  HasThisBinding(): boolean {
    // 1. Return false.
    return false;
  }

  // ECMA262 8.1.1.2.9
  HasSuperBinding(): boolean {
    // 1. Return false.
    return false;
  }

  // ECMA262 8.1.1.2.10
  WithBaseObject(): Value {
    // 1. Let envRec be the object Environment Record for which the method was invoked.
    let envRec = this;

    // 2. If the withEnvironment flag of envRec is true, return the binding object for envRec.
    if (envRec.withEnvironment) return envRec.object;

    // 3. Otherwise, return undefined.
    return this.realm.intrinsics.undefined;
  }
}

// ECMA262 8.1.1.3
export class FunctionEnvironmentRecord extends DeclarativeEnvironmentRecord {
  $ThisBindingStatus: "lexical" | "initialized" | "uninitialized";
  $ThisValue: UndefinedValue | NullValue | ObjectValue | AbstractObjectValue;
  $HomeObject: void | ObjectValue;
  $FunctionObject: FunctionValue;

  // ECMA262 8.1.1.3.1
  BindThisValue(
    V: NullValue | ObjectValue | AbstractObjectValue | UndefinedValue
  ): NullValue | ObjectValue | AbstractObjectValue | UndefinedValue {
    let realm = this.realm;

    // 1. Let envRec be the function Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Assert: envRec.[[ThisBindingStatus]] is not "lexical".
    invariant(envRec.$ThisBindingStatus !== "lexical", "this binding status shouldn't be lexical");

    // 3. If envRec.[[ThisBindingStatus]] is "initialized", throw a ReferenceError exception.
    if (envRec.$ThisBindingStatus === "initialized") {
      throw realm.createErrorThrowCompletion(realm.intrinsics.ReferenceError);
    }

    // 4. Set envRec.[[ThisValue]] to V.
    envRec.$ThisValue = V;

    // 5. Set envRec.[[ThisBindingStatus]] to "initialized".
    envRec.$ThisBindingStatus = "initialized";

    // 6. Return V.
    return V;
  }

  // ECMA262 8.1.1.3.2
  HasThisBinding(): boolean {
    // 1. Let envRec be the function Environment Record for which the method was invoked.
    let envRec = this;

    // 2. If envRec.[[ThisBindingStatus]] is "lexical", return false; otherwise, return true.
    return envRec.$ThisBindingStatus === "lexical" ? false : true;
  }

  // ECMA262 8.1.1.3.3
  HasSuperBinding(): boolean {
    // 1. Let envRec be the function Environment Record for which the method was invoked.
    let envRec = this;

    // 2. If envRec.[[ThisBindingStatus]] is "lexical", return false.
    if (envRec.$ThisBindingStatus === "lexical") return false;

    // 3. If envRec.[[HomeObject]] has the value undefined, return false; otherwise, return true.
    if (envRec.$HomeObject === undefined) {
      return false;
    } else {
      return true;
    }
  }

  // ECMA262 8.1.1.3.4
  GetThisBinding(): NullValue | ObjectValue | AbstractObjectValue | UndefinedValue {
    let realm = this.realm;

    // 1. Let envRec be the function Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Assert: envRec.[[ThisBindingStatus]] is not "lexical".
    invariant(envRec.$ThisBindingStatus !== "lexical", "this binding status shouldn't be lexical");

    // 3. If envRec.[[ThisBindingStatus]] is "uninitialized", throw a ReferenceError exception.
    if (envRec.$ThisBindingStatus === "uninitialized") {
      throw realm.createErrorThrowCompletion(realm.intrinsics.ReferenceError);
    }

    // 4. Return envRec.[[ThisValue]].
    return envRec.$ThisValue;
  }

  // ECMA262 8.1.1.3.5
  GetSuperBase(): ObjectValue | NullValue | UndefinedValue {
    // 1. Let envRec be the function Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Let home be the value of envRec.[[HomeObject]].
    let home = envRec.$HomeObject;

    // 3. If home has the value undefined, return undefined.
    if (home === undefined) return this.realm.intrinsics.undefined;

    // 4. Assert: Type(home) is Object.
    invariant(home instanceof ObjectValue, "expected object value");

    // 5. Return ? home.[[GetPrototypeOf]]().
    return home.$GetPrototypeOf();
  }
}

// ECMA262 8.1.1.4
export class GlobalEnvironmentRecord extends EnvironmentRecord {
  $DeclarativeRecord: EnvironmentRecord;
  $ObjectRecord: ObjectEnvironmentRecord;
  $VarNames: Array<string>;
  $GlobalThisValue: ObjectValue;

  // ECMA262 8.1.1.4.1
  HasBinding(N: string): boolean {
    // 1. Let envRec be the global Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Let DclRec be envRec.[[DeclarativeRecord]].
    let DclRec = envRec.$DeclarativeRecord;

    // 3. If DclRec.HasBinding(N) is true, return true.
    if (DclRec.HasBinding(N)) return true;

    // 4. Let ObjRec be envRec.[[ObjectRecord]].
    let ObjRec = envRec.$ObjectRecord;

    // 5. Return ? ObjRec.HasBinding(N).
    return ObjRec.HasBinding(N);
  }

  // ECMA262 8.1.1.4.2
  CreateMutableBinding(N: string, D: boolean): Value {
    let realm = this.realm;

    // 1. Let envRec be the global Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Let DclRec be envRec.[[DeclarativeRecord]].
    let DclRec = envRec.$DeclarativeRecord;

    // 3. If DclRec.HasBinding(N) is true, throw a TypeError exception.
    if (DclRec.HasBinding(N)) {
      throw realm.createErrorThrowCompletion(realm.intrinsics.TypeError);
    }

    // 4. Return DclRec.CreateMutableBinding(N, D).
    return DclRec.CreateMutableBinding(N, D);
  }

  // ECMA262 8.1.1.4.3
  CreateImmutableBinding(N: string, S: boolean): Value {
    let realm = this.realm;

    // 1. Let envRec be the global Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Let DclRec be envRec.[[DeclarativeRecord]].
    let DclRec = envRec.$DeclarativeRecord;

    // 3. If DclRec.HasBinding(N) is true, throw a TypeError exception.
    if (DclRec.HasBinding(N)) {
      throw realm.createErrorThrowCompletion(realm.intrinsics.TypeError);
    }

    // 4. Return DclRec.CreateImmutableBinding(N, S).
    return DclRec.CreateImmutableBinding(N, S);
  }

  // ECMA262 8.1.1.4.4
  InitializeBinding(N: string, V: Value): Value {
    // 1. Let envRec be the global Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Let DclRec be envRec.[[DeclarativeRecord]].
    let DclRec = envRec.$DeclarativeRecord;

    // 3. If DclRec.HasBinding(N) is true, then
    if (DclRec.HasBinding(N)) {
      // a. Return DclRec.InitializeBinding(N, V).
      return DclRec.InitializeBinding(N, V);
    }

    // 4. Assert: If the binding exists, it must be in the object Environment Record.

    // 5. Let ObjRec be envRec.[[ObjectRecord]].
    let ObjRec = envRec.$ObjectRecord;

    // 6. Return ? ObjRec.InitializeBinding(N, V).
    return ObjRec.InitializeBinding(N, V);
  }

  // ECMA262 8.1.1.4.5
  SetMutableBinding(N: string, V: Value, S: boolean): Value {
    // 1. Let envRec be the global Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Let DclRec be envRec.[[DeclarativeRecord]].
    let DclRec = envRec.$DeclarativeRecord;

    // 3. If DclRec.HasBinding(N) is true, then
    if (DclRec.HasBinding(N)) {
      // a. Return DclRec.SetMutableBinding(N, V, S).
      return DclRec.SetMutableBinding(N, V, S);
    }

    // 4. Let ObjRec be envRec.[[ObjectRecord]].
    let ObjRec = envRec.$ObjectRecord;

    // 5. Return ? ObjRec.SetMutableBinding(N, V, S).
    return ObjRec.SetMutableBinding(N, V, S);
  }

  // ECMA262 8.1.1.4.6
  GetBindingValue(N: string, S: boolean): Value {
    // 1. Let envRec be the global Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Let DclRec be envRec.[[DeclarativeRecord]].
    let DclRec = envRec.$DeclarativeRecord;

    // 3. If DclRec.HasBinding(N) is true, then
    if (DclRec.HasBinding(N)) {
      // a. Return DclRec.GetBindingValue(N, S).
      return DclRec.GetBindingValue(N, S);
    }

    // 4. Let ObjRec be envRec.[[ObjectRecord]].
    let ObjRec = envRec.$ObjectRecord;

    // 5. Return ? ObjRec.GetBindingValue(N, S).
    return ObjRec.GetBindingValue(N, S);
  }

  // ECMA262 8.1.1.4.7
  DeleteBinding(N: string): boolean {
    let realm = this.realm;

    // 1. Let envRec be the global Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Let DclRec be envRec.[[DeclarativeRecord]].
    let DclRec = envRec.$DeclarativeRecord;

    // 3. If DclRec.HasBinding(N) is true, then
    if (DclRec.HasBinding(N)) {
      // a. Return DclRec.DeleteBinding(N).
      return DclRec.DeleteBinding(N);
    }

    // 4. Let ObjRec be envRec.[[ObjectRecord]].
    let ObjRec = envRec.$ObjectRecord;

    // 5. Let globalObject be the binding object for ObjRec.
    let globalObject = ObjRec.object;

    // 6. Let existingProp be ? HasOwnProperty(globalObject, N).
    let existingProp = HasOwnProperty(realm, globalObject, N);

    // 7. If existingProp is true, then
    if (existingProp) {
      // a. Let status be ? ObjRec.DeleteBinding(N).
      let status = ObjRec.DeleteBinding(N);

      // b. If status is true, then
      if (status) {
        // i. Let varNames be envRec.[[VarNames]].
        let varNames = envRec.$VarNames;

        // ii. If N is an element of varNames, remove that element from the varNames.
        if (varNames.indexOf(N) >= 0) {
          varNames.splice(varNames.indexOf(N), 1);
        }
      }

      // c. Return status.
      return status;
    }

    // 8. Return true.
    return true;
  }

  // ECMA262 8.1.1.4.8
  HasThisBinding(): boolean {
    // 1. Return true.
    return true;
  }

  // ECMA262 8.1.1.4.9
  HasSuperBinding(): boolean {
    // 1. Return true.
    return true;
  }

  // ECMA262 8.1.1.4.10
  WithBaseObject(): Value {
    // 1. Return undefined.
    return this.realm.intrinsics.undefined;
  }

  // ECMA262 8.1.1.4.11
  GetThisBinding(): NullValue | ObjectValue | AbstractObjectValue | UndefinedValue {
    // 1. Let envRec be the global Environment Record for which the method was invoked.
    let envRec = this;

    invariant(envRec.$GlobalThisValue);
    // 2. Return envRec.[[GlobalThisValue]].
    return envRec.$GlobalThisValue;
  }

  // ECMA262 8.1.1.4.12
  HasVarDeclaration(N: string): boolean {
    // 1. Let envRec be the global Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Let varDeclaredNames be envRec.[[VarNames]].
    let varDeclaredNames = envRec.$VarNames;

    // 3. If varDeclaredNames contains the value of N, return true.
    if (varDeclaredNames.indexOf(N) >= 0) return true;

    // 4. Return false.
    return false;
  }

  // ECMA262 8.1.1.4.13
  HasLexicalDeclaration(N: string): boolean {
    // 1. Let envRec be the global Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Let DclRec be envRec.[[DeclarativeRecord]].
    let DclRec = envRec.$DeclarativeRecord;

    // 3. Return DclRec.HasBinding(N).
    return DclRec.HasBinding(N);
  }

  // ECMA262 8.1.1.4.14
  HasRestrictedGlobalProperty(N: string): boolean {
    // 1. Let envRec be the global Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Let ObjRec be envRec.[[ObjectRecord]].
    let ObjRec = envRec.$ObjectRecord;

    // 3. Let globalObject be the binding object for ObjRec.
    let globalObject = ObjRec.object;

    // 4. Let existingProp be ? globalObject.[[GetOwnProperty]](N).
    let existingProp = globalObject.$GetOwnProperty(N);

    // 5. If existingProp is undefined, return false.
    if (!existingProp) return false;
    ThrowIfMightHaveBeenDeleted(existingProp.value);

    // 6. If existingProp.[[Configurable]] is true, return false.
    if (existingProp.configurable) return false;

    // 7. Return true.
    return true;
  }

  // ECMA262 8.1.1.4.15
  CanDeclareGlobalVar(N: string): boolean {
    let realm = this.realm;

    // 1. Let envRec be the global Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Let ObjRec be envRec.[[ObjectRecord]].
    let ObjRec = envRec.$ObjectRecord;

    // 3. Let globalObject be the binding object for ObjRec.
    let globalObject = ObjRec.object;

    // 4. Let hasProperty be ? HasOwnProperty(globalObject, N).
    let hasProperty = HasOwnProperty(realm, globalObject, N);

    // 5. If hasProperty is true, return true.
    if (hasProperty) return true;

    // 6. Return ? IsExtensible(globalObject).
    return IsExtensible(realm, globalObject);
  }

  // ECMA262 8.1.1.4.16
  CanDeclareGlobalFunction(N: string): boolean {
    let realm = this.realm;

    // 1. Let envRec be the global Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Let ObjRec be envRec.[[ObjectRecord]].
    let ObjRec = envRec.$ObjectRecord;

    // 3. Let globalObject be the binding object for ObjRec.
    let globalObject = ObjRec.object;

    // 4. Let existingProp be ? globalObject.[[GetOwnProperty]](N).
    let existingProp = globalObject.$GetOwnProperty(N);

    // 5. If existingProp is undefined, return ? IsExtensible(globalObject).
    if (!existingProp) return IsExtensible(realm, globalObject);
    ThrowIfMightHaveBeenDeleted(existingProp.value);

    // 6. If existingProp.[[Configurable]] is true, return true.
    if (existingProp.configurable) return true;

    // 7. If IsDataDescriptor(existingProp) is true and existingProp has attribute values {[[Writable]]: true, [[Enumerable]]: true}, return true.
    if (IsDataDescriptor(realm, existingProp) && existingProp.writable && existingProp.enumerable) {
      return true;
    }

    // 8. Return false.
    return false;
  }

  // ECMA262 8.1.1.4.17
  CreateGlobalVarBinding(N: string, D: boolean) {
    let realm = this.realm;

    // 1. Let envRec be the global Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Let ObjRec be envRec.[[ObjectRecord]].
    let ObjRec = envRec.$ObjectRecord;

    // 3. Let globalObject be the binding object for ObjRec.
    let globalObject = ObjRec.object;

    // 4. Let hasProperty be ? HasOwnProperty(globalObject, N).
    let hasProperty = HasOwnProperty(realm, globalObject, N);

    // 5. Let extensible be ? IsExtensible(globalObject).
    let extensible = IsExtensible(realm, globalObject);

    // 6. If hasProperty is false and extensible is true, then
    if (!hasProperty && extensible) {
      // a. Perform ? ObjRec.CreateMutableBinding(N, D).
      ObjRec.CreateMutableBinding(N, D);

      // b. Perform ? ObjRec.InitializeBinding(N, undefined).
      ObjRec.InitializeBinding(N, this.realm.intrinsics.undefined);
    }

    // 7. Let varDeclaredNames be envRec.[[VarNames]].
    let varDeclaredNames = envRec.$VarNames;

    // 8. If varDeclaredNames does not contain the value of N, then
    if (varDeclaredNames.indexOf(N) < 0) {
      // a. Append N to varDeclaredNames.
      varDeclaredNames.push(N);
    }

    // 9. Return NormalCompletion(empty).
  }

  // ECMA262 8.1.1.4.18
  CreateGlobalFunctionBinding(N: string, V: Value, D: boolean) {
    // 1. Let envRec be the global Environment Record for which the method was invoked.
    let envRec = this;

    // 2. Let ObjRec be envRec.[[ObjectRecord]].
    let ObjRec = envRec.$ObjectRecord;

    // 3. Let globalObject be the binding object for ObjRec.
    let globalObject = ObjRec.object;

    // 4. Let existingProp be ? globalObject.[[GetOwnProperty]](N).
    let existingProp = globalObject.$GetOwnProperty(N);

    // 5. If existingProp is undefined or existingProp.[[Configurable]] is true, then
    let desc;
    if (!existingProp || existingProp.configurable) {
      // a. Let desc be the PropertyDescriptor{[[Value]]: V, [[Writable]]: true, [[Enumerable]]: true, [[Configurable]]: D}.
      desc = { value: V, writable: true, enumerable: true, configurable: D };
    } else {
      // 6. Else,
      ThrowIfMightHaveBeenDeleted(existingProp.value);
      // a. Let desc be the PropertyDescriptor{[[Value]]: V }.
      desc = { value: V };
    }

    // 7. Perform ? DefinePropertyOrThrow(globalObject, N, desc).
    DefinePropertyOrThrow(this.realm, globalObject, N, desc);

    // TODO? 8. Record that the binding for N in ObjRec has been initialized.

    // 9. Perform ? Set(globalObject, N, V, false).
    Set(this.realm, globalObject, N, V, false);

    // 10. Let varDeclaredNames be envRec.[[VarNames]].
    let varDeclaredNames = envRec.$VarNames;

    // 11. If varDeclaredNames does not contain the value of N, then
    if (varDeclaredNames.indexOf(N) < 0) {
      // a. Append N to varDeclaredNames.
      varDeclaredNames.push(N);
    }

    // 12. Return NormalCompletion(empty).
  }
}

// ECMA262 8.1.1.5
export class ModuleEnvironmentRecord extends DeclarativeEnvironmentRecord {
  // ECMA262 8.1.1.3.1
  BindThisValue(
    V: NullValue | ObjectValue | AbstractObjectValue | UndefinedValue
  ): NullValue | ObjectValue | AbstractObjectValue | UndefinedValue {
    throw new FatalError("TODO: implement modules");
  }

  // ECMA262 8.1.1.3.2
  HasThisBinding(): boolean {
    throw new FatalError("TODO: implement modules");
  }

  // ECMA262 8.1.1.3.3
  HasSuperBinding(): boolean {
    throw new FatalError("TODO: implement modules");
  }

  // ECMA262 8.1.1.3.4
  GetThisBinding(): NullValue | ObjectValue | AbstractObjectValue | UndefinedValue {
    throw new FatalError("TODO: implement modules");
  }

  // ECMA262 8.1.1.3.5
  GetSuperBase(): NullValue | ObjectValue | UndefinedValue {
    throw new FatalError("TODO: implement modules");
  }
}

// ECMA262 8.1
export class LexicalEnvironment {
  constructor(realm: Realm) {
    invariant(realm, "expected realm");
    this.realm = realm;
  }

  environmentRecord: EnvironmentRecord;
  parent: null | LexicalEnvironment;
  realm: Realm;

  assignToGlobal(globalAst: BabelNodeLVal, rvalue: Value) {
    let globalValue = this.evaluate(globalAst, false);
    PutValue(this.realm, globalValue, rvalue);
  }

  partiallyEvaluateCompletionDeref(
    ast: BabelNode,
    strictCode: boolean,
    metadata?: any
  ): [Completion | Value, BabelNode, Array<BabelNodeStatement>] {
    let [result, partial_ast, partial_io] = this.partiallyEvaluateCompletion(ast, strictCode, metadata);
    if (result instanceof Reference) {
      result = GetValue(this.realm, result);
    }
    return [result, partial_ast, partial_io];
  }

  partiallyEvaluateCompletion(
    ast: BabelNode,
    strictCode: boolean,
    metadata?: any
  ): [Completion | Reference | Value, BabelNode, Array<BabelNodeStatement>] {
    try {
      return this.partiallyEvaluate(ast, strictCode, metadata);
    } catch (err) {
      if (err instanceof Completion) return [err, ast, []];
      if (err instanceof Error)
        // rethrowing Error should preserve stack trace
        throw err;
      // let's wrap into a proper Error to create stack trace
      throw new FatalError(err);
    }
  }

  evaluateCompletionDeref(ast: BabelNode, strictCode: boolean, metadata?: any): AbruptCompletion | Value {
    let result = this.evaluateCompletion(ast, strictCode, metadata);
    if (result instanceof Reference) result = GetValue(this.realm, result);
    return result;
  }

  evaluateCompletion(ast: BabelNode, strictCode: boolean, metadata?: any): AbruptCompletion | Value | Reference {
    try {
      return this.evaluate(ast, strictCode, metadata);
    } catch (err) {
      if (err instanceof JoinedAbruptCompletions || err instanceof PossiblyNormalCompletion) {
        AbstractValue.reportIntrospectionError(err.joinCondition);
        throw new FatalError();
      }
      if (err instanceof AbruptCompletion) return err;
      if (err instanceof Error)
        // rethrowing Error should preserve stack trace
        throw err;
      // let's wrap into a proper Error to create stack trace
      throw new FatalError(err);
    }
  }

  evaluateAbstractCompletion(ast: BabelNode, strictCode: boolean, metadata?: any): Completion | Value | Reference {
    try {
      return this.evaluateAbstract(ast, strictCode, metadata);
    } catch (err) {
      if (err instanceof Completion) return err;
      if (err instanceof Error)
        // rethrowing Error should preserve stack trace
        throw err;
      // let's wrap into a proper Error to create stack trace
      if (err instanceof Object) throw new FatalError(err.constructor.name + ": " + err);
      throw new FatalError(err);
    }
  }

  concatenateAndParse(sources: Array<SourceFile>, sourceType: SourceType = "script"): [BabelNodeFile, any] {
    let asts = [];
    let code = {};
    let directives = [];
    for (let source of sources) {
      try {
        let node = parse(this.realm, source.fileContents, source.filePath, sourceType);
        if (source.sourceMapContents && source.sourceMapContents.length > 0)
          this.fixup_source_locations(node, source.sourceMapContents);
        this.fixup_filenames(node);
        asts = asts.concat(node.program.body);
        code[source.filePath] = source.fileContents;
        directives = directives.concat(node.program.directives);
      } catch (e) {
        if (e instanceof ThrowCompletion) {
          let error = e.value;
          if (error instanceof ObjectValue) {
            let message = error.$Get("message", error);
            e.location.source = source.filePath;
            let err = new CompilerDiagnostic(message.value, e.location, "PP1004", "FatalError");
            this.realm.handleError(err);
            throw new FatalError("syntax error");
          }
        }
        throw e;
      }
    }
    return [t.file(t.program(asts, directives)), code];
  }

  executeSources(
    sources: Array<SourceFile>,
    sourceType: SourceType = "script",
    onParse: void | (BabelNodeFile => void) = undefined
  ): [AbruptCompletion | Value, any] {
    let context = new ExecutionContext();
    context.lexicalEnvironment = this;
    context.variableEnvironment = this;
    context.realm = this.realm;
    this.realm.pushContext(context);
    let res, code;
    try {
      let ast;
      [ast, code] = this.concatenateAndParse(sources, sourceType);
      if (onParse) onParse(ast);
      res = this.evaluateCompletion(ast, false);
    } finally {
      this.realm.popContext(context);
    }
    if (res instanceof AbruptCompletion) return [res, code];

    return [GetValue(this.realm, res), code];
  }

  executePartialEvaluator(
    sources: Array<SourceFile>,
    options: PartialEvaluatorOptions = defaultOptions,
    sourceType: SourceType = "script"
  ): AbruptCompletion | { code: string, map?: SourceMap } {
    let [ast, code] = this.concatenateAndParse(sources, sourceType);
    let context = new ExecutionContext();
    context.lexicalEnvironment = this;
    context.variableEnvironment = this;
    context.realm = this.realm;
    this.realm.pushContext(context);
    let partialAST;
    try {
      let res;
      [res, partialAST] = this.partiallyEvaluateCompletionDeref(ast, false);
      if (res instanceof AbruptCompletion) return res;
    } finally {
      this.realm.popContext(context);
    }
    invariant(partialAST.type === "File");
    let fileAst = ((partialAST: any): BabelNodeFile);
    let prog = t.program(fileAst.program.body, ast.program.directives);
    this.fixup_filenames(prog);
    return generate(prog, { sourceMaps: options.sourceMaps }, (code: any));
  }

  execute(
    code: string,
    filename: string,
    map: string = "",
    sourceType: SourceType = "script",
    onParse: void | (BabelNodeFile => void) = undefined
  ): AbruptCompletion | Value {
    let context = new ExecutionContext();
    context.lexicalEnvironment = this;
    context.variableEnvironment = this;
    context.realm = this.realm;

    this.realm.pushContext(context);

    let ast, res;
    try {
      try {
        ast = parse(this.realm, code, filename, sourceType);
      } catch (e) {
        if (e instanceof ThrowCompletion) return e;
        throw e;
      }
      if (onParse) onParse(ast);
      if (map.length > 0) this.fixup_source_locations(ast, map);
      this.fixup_filenames(ast);
      res = this.evaluateCompletion(ast, false);
    } finally {
      this.realm.popContext(context);
    }
    if (res instanceof AbruptCompletion) return res;

    return GetValue(this.realm, res);
  }

  fixup_source_locations(ast: BabelNode, map: string) {
    const smc = new sourceMap.SourceMapConsumer(map);
    traverseFast(ast, node => {
      let loc = node.loc;
      if (!loc) return false;
      fixup(loc, loc.start);
      fixup(loc, loc.end);
      fixup_comments(node.leadingComments);
      fixup_comments(node.innerComments);
      fixup_comments(node.trailingComments);
      return false;

      function fixup(new_loc: BabelNodeSourceLocation, new_pos: BabelNodePosition) {
        let old_pos = smc.originalPositionFor({ line: new_pos.line, column: new_pos.column });
        if (old_pos.source === null) return;
        new_pos.line = old_pos.line;
        new_pos.column = old_pos.column;
        new_loc.source = old_pos.source;
      }

      function fixup_comments(comments: ?Array<BabelNodeComment>) {
        if (!comments) return;
        for (let c of comments) {
          let cloc = c.loc;
          if (!cloc) continue;
          fixup(cloc, cloc.start);
          fixup(cloc, cloc.end);
        }
      }
    });
  }

  fixup_filenames(ast: BabelNode) {
    traverseFast(ast, node => {
      let loc = node.loc;
      if (!loc || !loc.source) {
        node.leadingComments = null;
        node.innerComments = null;
        node.trailingComments = null;
        node.loc = null;
      } else {
        let filename = loc.source;
        (loc: any).filename = filename;
        fixup_comments(node.leadingComments, filename);
        fixup_comments(node.innerComments, filename);
        fixup_comments(node.trailingComments, filename);
      }
      return false;

      function fixup_comments(comments: ?Array<BabelNodeComment>, filename: string) {
        if (!comments) return;
        for (let c of comments) {
          if (c.loc) {
            (c.loc: any).filename = filename;
            c.loc.source = filename;
          }
        }
      }
    });
  }

  evaluate(ast: BabelNode, strictCode: boolean, metadata?: any): Value | Reference {
    let res = this.evaluateAbstract(ast, strictCode, metadata);
    if (res instanceof PossiblyNormalCompletion) {
      AbstractValue.reportIntrospectionError(res.joinCondition);
      throw new FatalError();
    }
    invariant(res instanceof Value || res instanceof Reference, ast.type);
    return res;
  }

  evaluateAbstract(ast: BabelNode, strictCode: boolean, metadata?: any): NormalCompletion | Value | Reference {
    this.realm.currentLocation = ast.loc;
    this.realm.testTimeout();

    let evaluator = this.realm.evaluators[(ast.type: string)];
    if (evaluator) {
      let result = evaluator(ast, strictCode, this, this.realm, metadata);
      let context = this.realm.getRunningContext();
      let savedCompletion = context.savedCompletion;
      if (savedCompletion !== undefined) {
        if (result instanceof Value) {
          updatePossiblyNormalCompletionWithValue(this.realm, savedCompletion, result);
          result = savedCompletion;
        } else if (result instanceof PossiblyNormalCompletion) {
          result = composePossiblyNormalCompletions(this.realm, savedCompletion, result);
        } else {
          AbstractValue.reportIntrospectionError(savedCompletion.joinCondition);
          throw new FatalError();
        }
        context.savedCompletion = undefined;
      }
      return result;
    }

    throw new TypeError(`Unsupported node type ${ast.type}`);
  }

  partiallyEvaluate(
    ast: BabelNode,
    strictCode: boolean,
    metadata?: any
  ): [Completion | Reference | Value, BabelNode, Array<BabelNodeStatement>] {
    let partialEvaluator = this.realm.partialEvaluators[(ast.type: string)];
    if (partialEvaluator) {
      return partialEvaluator(ast, strictCode, this, this.realm, metadata);
    }

    let err = new TypeError(`Unsupported node type ${ast.type}`);
    throw err;
  }
}

// ECMA262 6.2.3
// A Reference is a resolved name or property binding. A Reference consists of three components, the base value,
// the referenced name and the Boolean valued strict reference flag. The base value is either undefined, an Object,
// a Boolean, a String, a Symbol, a Number, or an Environment Record. A base value of undefined indicates that the
// Reference could not be resolved to a binding. The referenced name is a String or Symbol value.
export type BaseValue = void | ObjectValue | BooleanValue | StringValue | SymbolValue | NumberValue | EnvironmentRecord;
export type ReferenceName = string | SymbolValue;

export function canBecomeAnObject(base: Value): boolean {
  let type = base.getType();
  return type === BooleanValue || type === StringValue || type === SymbolValue || type === NumberValue;
}

export class Reference {
  base: BaseValue | AbstractValue;
  referencedName: ReferenceName | AbstractValue;
  strict: boolean;
  thisValue: void | Value;

  constructor(
    base: BaseValue | AbstractValue,
    refName: ReferenceName | AbstractValue,
    strict: boolean,
    thisValue?: void | Value
  ) {
    invariant(
      base instanceof AbstractObjectValue ||
        base === undefined ||
        base instanceof ObjectValue ||
        base instanceof EnvironmentRecord ||
        canBecomeAnObject(base)
    );
    this.base = base;
    this.referencedName = refName;
    invariant(!(refName instanceof AbstractValue) || !refName.mightNotBeString());
    this.strict = strict;
    this.thisValue = thisValue;
    invariant(thisValue === undefined || !(base instanceof EnvironmentRecord));
  }
}

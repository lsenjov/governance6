/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as calls from "../calls.js";
import type * as drawbacks from "../drawbacks.js";
import type * as games from "../games.js";
import type * as goals from "../goals.js";
import type * as http from "../http.js";
import type * as ledger from "../ledger.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_calls from "../lib/calls.js";
import type * as lib_rolls from "../lib/rolls.js";
import type * as minionBuys from "../minionBuys.js";
import type * as minions from "../minions.js";
import type * as notes from "../notes.js";
import type * as presetDrawbacks from "../presetDrawbacks.js";
import type * as presetSkills from "../presetSkills.js";
import type * as publicBids from "../publicBids.js";
import type * as syndicates from "../syndicates.js";
import type * as treasonGrants from "../treasonGrants.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  calls: typeof calls;
  drawbacks: typeof drawbacks;
  games: typeof games;
  goals: typeof goals;
  http: typeof http;
  ledger: typeof ledger;
  "lib/auth": typeof lib_auth;
  "lib/calls": typeof lib_calls;
  "lib/rolls": typeof lib_rolls;
  minionBuys: typeof minionBuys;
  minions: typeof minions;
  notes: typeof notes;
  presetDrawbacks: typeof presetDrawbacks;
  presetSkills: typeof presetSkills;
  publicBids: typeof publicBids;
  syndicates: typeof syndicates;
  treasonGrants: typeof treasonGrants;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};

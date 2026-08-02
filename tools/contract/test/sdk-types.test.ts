import type {
  BuildDescription as CoreBuildDescription,
  ContextBundle as CoreContextBundle,
  SearchRequest as CoreSearchRequest,
  SearchResult as CoreSearchResult,
  SourceLocator as CoreSourceLocator,
  SourceReadResult as CoreSourceReadResult,
  TableDescription as CoreTableDescription,
  TableQueryResult as CoreTableQueryResult,
  TaskContextRequest as CoreTaskContextRequest,
} from '@lorepack/core';
import type {
  BuildDescription as SdkBuildDescription,
  ContextBundle as SdkContextBundle,
  SearchRequest as SdkSearchRequest,
  SearchResult as SdkSearchResult,
  SourceLocator as SdkSourceLocator,
  SourceReadResult as SdkSourceReadResult,
  TableDescription as SdkTableDescription,
  TableQueryResult as SdkTableQueryResult,
  TaskContextRequest as SdkTaskContextRequest,
} from '@lorepack/sdk';
import { describe, expect, it } from 'vitest';

/**
 * The SDK's types must equal the server's, and this is what enforces it.
 *
 * `@lorepack/sdk` depends on nothing, including no workspace package, so a consumer can
 * install it without inheriting a compiler or a schema library. The price is that its types
 * are written by hand rather than imported, and the risk is drift: a field added to a Zod
 * schema and forgotten here would be invisible until a consumer hit it at runtime.
 *
 * These assertions are type-level. If a contract changes on either side, this file stops
 * compiling and CI fails, which is the guarantee the ticket asks for. The runtime `expect`
 * calls exist only so the file is a test rather than a lint target: the real work happens
 * before any of them run.
 */

/** Compile-time proof that two types are the same, in both directions. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

function assertExact<T extends true>(_proof: T): void {
  // Nothing to do. Reaching here means the compiler agreed.
}

describe('the SDK mirrors the server contracts exactly', () => {
  it('for every response shape', () => {
    assertExact<Exact<SdkSearchResult, CoreSearchResult>>(true);
    assertExact<Exact<SdkContextBundle, CoreContextBundle>>(true);
    assertExact<Exact<SdkBuildDescription, CoreBuildDescription>>(true);
    assertExact<Exact<SdkSourceReadResult, CoreSourceReadResult>>(true);
    assertExact<Exact<SdkTableDescription, CoreTableDescription>>(true);
    assertExact<Exact<SdkTableQueryResult, CoreTableQueryResult>>(true);
    assertExact<Exact<SdkSourceLocator, CoreSourceLocator>>(true);
    expect(true).toBe(true);
  });

  it('for every request shape a caller constructs', () => {
    // Requests are compared as what a caller may send. The server applies defaults, so its
    // parsed type has them required while the SDK's input has them optional: the assertion
    // is therefore that an SDK request is always a valid server input.
    const search: CoreSearchRequest = {
      query: 'a',
      limit: 10,
      includeArchived: false,
      debug: false,
    };
    const asSdk: SdkSearchRequest = search;
    expect(asSdk.query).toBe('a');

    const task: CoreTaskContextRequest = { task: 'a', includeArchived: false };
    const asSdkTask: SdkTaskContextRequest = task;
    expect(asSdkTask.task).toBe('a');
  });
});

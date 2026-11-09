import { AsyncLocalStorage } from "node:async_hooks";
import postgres from "postgres";
import { sql as q } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

export const DB = Symbol("DB");

export type Orm = PostgresJsDatabase<typeof schema>;

export interface RequestScope {
  entityId: string;
  userId: string;
}

export interface Database {
  /**
   * The connection to query through. Inside a signed-in request it is that request's transaction,
   * running as `mms_app` with the entity set, so row-level security applies (TR-SEC-05).
   */
  readonly orm: Orm;
  /** Outside any request scope: identity tables, sign-in bookkeeping, migrations, seeds and tests. */
  readonly base: Orm;
  readonly sql: postgres.Sql;
  inRequestScope<T>(scope: RequestScope, fn: () => Promise<T>): Promise<T>;
}

const requestTx = new AsyncLocalStorage<Orm>();

export function createDatabase(url = process.env.DATABASE_URL ?? "postgres://mms:mms@localhost:5432/mms_dev"): Database {
  // Return DATE columns as plain YYYY-MM-DD strings, never JS Dates.
  const sql = postgres(url, {
    max: 10,
    onnotice: () => {},
    types: { date: { to: 1082, from: [1082], serialize: (v: string) => v, parse: (v: string) => v } },
  });
  const base = drizzle(sql, { schema });
  return {
    sql,
    base,
    get orm() {
      return requestTx.getStore() ?? base;
    },
    inRequestScope(scope, fn) {
      return base.transaction(async (tx) => {
        // SET LOCAL lasts until the transaction ends, so a pooled connection never leaks the role.
        await tx.execute(q`set local role mms_app`);
        await tx.execute(q`select set_config('app.entity_id', ${scope.entityId}, true), set_config('app.user_id', ${scope.userId}, true)`);
        return requestTx.run(tx as unknown as Orm, fn);
      });
    },
  };
}

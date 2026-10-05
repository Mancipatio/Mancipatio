// tests/helpers/memory-supabase.ts: the opt-in primary key on `id`
// (`uniqueIds`) refuses an insert whose id is taken, or repeated within one
// batch, as a whole statement (23505, nothing written), like Postgres. Upserts
// are not checked (the header says so).
import { describe, expect, it } from "vitest";
import { memorySupabase } from "./helpers/memory-supabase";

type Result = { data: unknown; error: { code?: string } | null };

describe("memorySupabase uniqueIds", () => {
  it("refuses a taken id, and a repeated id within one batch, writing nothing", async () => {
    const db = memorySupabase();
    db.uniqueIds.add("t");
    const from = db.client.from as (table: string) => { insert: (rows: unknown) => PromiseLike<Result>; upsert: (rows: unknown) => PromiseLike<Result> };

    expect((await from("t").insert({ id: "a" })).error).toBeNull();
    expect((await from("t").insert({ id: "a" })).error?.code).toBe("23505");
    expect((await from("t").insert([{ id: "b" }, { id: "b" }])).error?.code).toBe("23505");
    expect((await from("t").insert([{ id: "c" }, { id: "a" }])).error?.code).toBe("23505");
    expect(db.rows("t").map((r) => r.id)).toEqual(["a"]);
    expect((await from("t").insert([{ id: "b" }, { id: "c" }])).error).toBeNull();
    expect(db.rows("t").map((r) => r.id)).toEqual(["a", "b", "c"]);

    // Off for a table that did not opt in; upserts are never checked.
    expect((await from("u").insert([{ id: "x" }, { id: "x" }])).error).toBeNull();
    expect((await from("t").upsert({ id: "a" })).error).toBeNull();
    expect(db.rows("t").filter((r) => r.id === "a")).toHaveLength(2);
  });
});

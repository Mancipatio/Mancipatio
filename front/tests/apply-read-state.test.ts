// lib/apply-read-state.ts — /apply must distinguish "waiting for the wallet"
// from "loading", and a failed private read from an empty list (F08).
import { describe, expect, it } from "vitest";
import {
  applicationReadStatusCopy,
  classifyApplicationReadError,
  withSigningObserver,
} from "@/lib/apply-read-state";

describe("withSigningObserver", () => {
  it("reports the wallet prompt opening and closing around signMessage", async () => {
    const events: string[] = [];
    class Session {
      account = { address: "wallet" };
      calls = 0;
      async signMessage(message: Uint8Array) {
        events.push(`sign:${message.length}`);
        this.calls += 1;
        return new Uint8Array([1, 2, 3]);
      }
      label() {
        return "proto-method";
      }
    }
    const session = new Session();
    const observed = withSigningObserver(session, {
      onSignStart: () => events.push("start"),
      onSignEnd: () => events.push("end"),
    });
    const signature = await observed.signMessage!(new Uint8Array(4));
    expect(Array.from(signature)).toEqual([1, 2, 3]);
    expect(events).toEqual(["start", "sign:4", "end"]);
    // The wrapper is transparent for every other member, prototype included.
    expect(observed.account.address).toBe("wallet");
    expect(observed.label()).toBe("proto-method");
    expect(session.calls).toBe(1); // `this` reached the real session
  });

  it("wraps a frozen session whose signMessage is non-writable and non-configurable", async () => {
    // Regression: a Proxy over a frozen session threw on every read of
    // `signMessage` ("'get' on proxy: property 'signMessage' is a read-only
    // and non-configurable data property…"), so /apply showed a false
    // "could not reach the application service" error.
    const events: string[] = [];
    const brand = Symbol("session-brand");
    const session = Object.freeze({
      [brand]: true,
      account: Object.freeze({ address: "wallet" }),
      get connector() {
        return "phantom";
      },
      async signMessage(message: Uint8Array) {
        events.push(`sign:${message.length}:${this === session}`);
        return new Uint8Array([9]);
      },
    });
    const observed = withSigningObserver(session, {
      onSignStart: () => events.push("start"),
      onSignEnd: () => events.push("end"),
    });
    expect(() => observed.signMessage).not.toThrow();
    expect(observed).not.toBe(session);
    const signature = await observed.signMessage(new Uint8Array(2));
    expect(Array.from(signature)).toEqual([9]);
    expect(events).toEqual(["start", "sign:2:true", "end"]);
    expect(observed.account).toBe(session.account);
    expect(observed.connector).toBe("phantom");
    expect(observed[brand]).toBe(true);
    expect(Object.isFrozen(observed)).toBe(true);
    // The original session is untouched.
    expect(Object.getOwnPropertyDescriptor(session, "signMessage")?.value).not.toBe(
      observed.signMessage,
    );
  });

  it("still signals the prompt closing when the wallet rejects", async () => {
    const events: string[] = [];
    const session = {
      signMessage: async (message: Uint8Array): Promise<Uint8Array> => {
        void message;
        throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      },
    };
    const observed = withSigningObserver(session, {
      onSignStart: () => events.push("start"),
      onSignEnd: () => events.push("end"),
    });
    await expect(observed.signMessage!(new Uint8Array())).rejects.toThrow(
      /rejected/,
    );
    expect(events).toEqual(["start", "end"]);
  });

  it("passes through sessions that cannot sign, and null", () => {
    const noSign: { account: { address: string }; signMessage?: undefined } = {
      account: { address: "x" },
    };
    expect(withSigningObserver(noSign, { onSignStart() {}, onSignEnd() {} })).toBe(
      noSign,
    );
    expect(withSigningObserver(null, { onSignStart() {}, onSignEnd() {} })).toBeNull();
    expect(
      withSigningObserver(undefined, { onSignStart() {}, onSignEnd() {} }),
    ).toBeUndefined();
  });
});

describe("classifyApplicationReadError", () => {
  it("recognises a declined wallet signature by code or message", () => {
    expect(
      classifyApplicationReadError(Object.assign(new Error("x"), { code: 4001 })).kind,
    ).toBe("signature_rejected");
    expect(classifyApplicationReadError({ code: "WALLET_REJECTED" }).kind).toBe(
      "signature_rejected",
    );
    expect(
      classifyApplicationReadError(new Error("User rejected the request.")).kind,
    ).toBe("signature_rejected");
    const failure = classifyApplicationReadError(new Error("Request rejected"));
    expect(failure.message).toMatch(/declined/);
    expect(failure.message).toMatch(/Nothing was submitted/);
    expect(failure.detail).toBe("Request rejected");
  });

  it("recognises a wallet without message signing", () => {
    const failure = classifyApplicationReadError(
      new Error("Connected wallet does not support message signing"),
    );
    expect(failure.kind).toBe("signing_unsupported");
    expect(failure.message).toMatch(/cannot sign messages/);
  });

  it("recognises transport failures without treating them as an empty list", () => {
    expect(classifyApplicationReadError(new TypeError("Failed to fetch")).kind).toBe(
      "transport",
    );
    expect(classifyApplicationReadError(new Error("fetch failed")).kind).toBe(
      "transport",
    );
    const failure = classifyApplicationReadError(new TypeError("Load failed"));
    expect(failure.message).toMatch(/may exist/);
  });

  it("treats anything else as a server error that explicitly is not 'no applications'", () => {
    const failure = classifyApplicationReadError(new Error("Signature expired"));
    expect(failure.kind).toBe("server");
    expect(failure.message).toMatch(/not confirmation that you have none/);
    expect(failure.detail).toBe("Signature expired");
    expect(classifyApplicationReadError("boom").detail).toBe("boom");
    expect(classifyApplicationReadError(undefined).kind).toBe("server");
  });
});

describe("applicationReadStatusCopy", () => {
  it("names the wallet wait explicitly and keeps the plain loading line", () => {
    expect(applicationReadStatusCopy("signing")).toMatch(/Waiting for your wallet/);
    expect(applicationReadStatusCopy("signing")).toMatch(/No transaction is sent/);
    expect(applicationReadStatusCopy("loading")).toBe("Checking your applications…");
  });
});

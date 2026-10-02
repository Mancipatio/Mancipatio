// The "Ledger (USB)" prompt state (lib/ledger-usb-prompts.ts) that
// components/ledger-usb-dialogs.tsx renders: one prompt at a time, a cancel is
// a user rejection, and a device opened after a cancel is closed again.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LedgerAccountChoiceRequest, LedgerUsbDevice } from "@/lib/ledger-usb";
import { ledgerUsbPrompts, ledgerUsbPromptSnapshot, subscribeLedgerUsbPrompt } from "@/lib/ledger-usb-prompts";

const option = { path: "44'/501'/0'", address: "11111111111111111111111111111111" };
const request: LedgerAccountChoiceRequest = {
  accounts: [option],
  app: { version: "1.16.0", blindSigningEnabled: true, signsMessages: true },
  showOnDevice: async () => true,
};
const device = () => ({ close: vi.fn(async () => undefined) }) as unknown as LedgerUsbDevice & { close: ReturnType<typeof vi.fn> };

let unsubscribe: (() => void) | null = null;
function view() {
  const renders = vi.fn();
  unsubscribe = subscribeLedgerUsbPrompt(renders);
  return renders;
}
afterEach(() => { unsubscribe?.(); unsubscribe = null; });

describe("ledgerUsbPrompts", () => {
  it("refuses to ask without a mounted view (the page would hang otherwise)", async () => {
    await expect(ledgerUsbPrompts.chooseAccount(request)).rejects.toMatchObject({ name: "LedgerUsbError" });
    await expect(ledgerUsbPrompts.requestAccess(async () => device())).rejects.toMatchObject({ name: "LedgerUsbError" });
  });

  it("shows the account picker until the user chooses or cancels", async () => {
    const renders = view();
    const choice = ledgerUsbPrompts.chooseAccount(request);
    const prompt = ledgerUsbPromptSnapshot();
    expect(prompt).toMatchObject({ kind: "choose", request });
    if (prompt?.kind !== "choose") throw new Error("no picker");
    prompt.choose(option);
    await expect(choice).resolves.toBe(option);
    expect(ledgerUsbPromptSnapshot()).toBeNull();
    expect(renders).toHaveBeenCalledTimes(2);

    const cancelled = ledgerUsbPrompts.chooseAccount(request);
    const second = ledgerUsbPromptSnapshot();
    if (second?.kind !== "choose") throw new Error("no picker");
    second.cancel();
    await expect(cancelled).rejects.toMatchObject({ code: 4001 });
  });

  it("asks for device access, runs the grant once from the click, and closes a device opened after a cancel", async () => {
    view();
    const opened = device();
    const grant = vi.fn(async () => opened);
    const access = ledgerUsbPrompts.requestAccess(grant);
    const prompt = ledgerUsbPromptSnapshot();
    if (prompt?.kind !== "access") throw new Error("no access prompt");
    prompt.grant();
    const pending = ledgerUsbPromptSnapshot();
    expect(pending).toMatchObject({ kind: "access", pending: true });
    if (pending?.kind === "access") pending.grant(); // a double click
    await expect(access).resolves.toBe(opened);
    expect(grant).toHaveBeenCalledOnce();
    expect(ledgerUsbPromptSnapshot()).toBeNull();

    let finish!: (value: LedgerUsbDevice) => void;
    const late = device();
    const slow = ledgerUsbPrompts.requestAccess(() => new Promise<LedgerUsbDevice>((resolve) => { finish = resolve; }));
    const again = ledgerUsbPromptSnapshot();
    if (again?.kind !== "access") throw new Error("no access prompt");
    again.grant();
    again.cancel();
    await expect(slow).rejects.toMatchObject({ code: 4001 });
    finish(late);
    await Promise.resolve();
    expect(late.close).toHaveBeenCalledOnce();
  });

  it("shows a confirm-on-device notice until the device answers", () => {
    view();
    const hide = ledgerUsbPrompts.confirmOnDevice({ kind: "transaction", hash: "abc" });
    expect(ledgerUsbPromptSnapshot()).toEqual({ kind: "confirm", info: { kind: "transaction", hash: "abc" } });
    hide();
    expect(ledgerUsbPromptSnapshot()).toBeNull();
  });
});

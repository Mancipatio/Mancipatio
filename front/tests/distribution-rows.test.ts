// "Send to wallets" input (lib/distribution-rows): one box, "wallet amount"
// per line or a pasted CSV, duplicates merged, and each row's share of the
// company from the tokenize figures (never the public total_shares).
import { describe, expect, it } from "vitest";
import {
  AMBIGUOUS_AMOUNT,
  MAX_DISTRIBUTION_ROWS,
  companyFiguresFrom,
  normalizedRows,
  parseRecipients,
  percentOfCompany,
} from "@/lib/distribution-rows";

const A = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const B2 = "6AnFbinF7X12mACTVEGfjWZyzYGAShEscAB5UgV3vHsP";
const C = "HRcahPjAhX9ssiY5WvNJxHmy5vuDL7Q6GF6J5gNGjgwC";
const n = (v: number | string) => BigInt(v);

describe("parseRecipients", () => {
  it("reads 'wallet amount' per line with any of the usual separators", () => {
    const parsed = parseRecipients(`${A} 100\n${B2},250\n${C};5\n${A.slice(0, 0)}`);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map((r) => [r.wallet, r.amount])).toEqual([
      [A, n(100)],
      [B2, n(250)],
      [C, n(5)],
    ]);
    expect(parsed.total).toBe(n(355));
    const tabbed = parseRecipients(`${A}\t7\n  ${B2}   8  \n`);
    expect(tabbed.rows.map((r) => r.amount)).toEqual([n(7), n(8)]);
  });

  it("tolerates a header row, quotes, blank and comment lines, and the amount first", () => {
    const csv = `"wallet","amount"\n# investors\n\n"${A}","100"\n50;${B2}\r\n`;
    const parsed = parseRecipients(csv);
    expect(parsed.header).toBe(true);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map((r) => [r.wallet, r.amount, r.lines])).toEqual([
      [A, n(100), [4]],
      [B2, n(50), [5]],
    ]);
    // Only the first content line can be a header.
    expect(parseRecipients(`${A} 1\nwallet amount`).errors).toEqual([{ line: 2, text: "Not a valid Solana wallet address." }]);
  });

  it("merges a wallet listed twice (amounts added) and says so", () => {
    const parsed = parseRecipients(`${A} 100\n${B2} 1\n${A} 50`);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toEqual({ wallet: A, amount: n(150), lines: [1, 3] });
    expect(parsed.merged.map((m) => m.wallet)).toEqual([A]);
    expect(parsed.total).toBe(n(151));
  });

  it("refuses what it cannot read, line by line", () => {
    const parsed = parseRecipients([`${A}`, `${A} 1.5`, `${A},1,000`, `${A} 0`, `notawallet 5`, `${A} ${B2} 10`, `${A} -3`].join("\n"));
    expect(parsed.errors).toEqual([
      { line: 1, text: "Write the wallet address and the number of tokens on the same line." },
      { line: 2, text: "Share tokens are whole: use a whole number of tokens." },
      { line: 3, text: AMBIGUOUS_AMOUNT },
      { line: 4, text: "Send at least 1 token, or remove the line." },
      { line: 5, text: "Not a valid Solana wallet address." },
      { line: 6, text: 'Two different wallet addresses on one line: keep only the recipient\'s column, or add a header row naming it "wallet".' },
      { line: 7, text: "The amount must be a whole number of tokens (digits only)." },
    ]);
    expect(parsed.rows).toEqual([]);
    expect(parseRecipients(`${A} 18446744073709551616`).errors[0].text).toMatch(/whole number/);
  });

  it("tolerates extra columns: the line's wallet and the number after it", () => {
    const parsed = parseRecipients(
      [`Alice,${A},100,Seed round`, `${B2};250;note;7`, `${C}\t5\t2026-10-01`, `"Bob","${A}","20","x"`].join("\n"),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map((r) => [r.wallet, r.amount])).toEqual([
      [A, n(120)],
      [B2, n(250)],
      [C, n(5)],
    ]);
    // A wallet with a text column after it and the amount before it (the old "amount wallet" order).
    expect(parseRecipients(`7 ${A} founder`).rows.map((r) => r.amount)).toEqual([n(7)]);
  });

  it("reads thousands separators that cannot be misread, and refuses the ones that can", () => {
    const ok = parseRecipients(
      [`"${A}","1,000"`, `${B2};"12,500"`, `${C}\t1,000,000`, `${A} 1'000`, `${B2} "2 000"`].join("\n"),
    );
    expect(ok.errors).toEqual([]);
    expect(ok.rows.map((r) => [r.wallet, r.amount])).toEqual([
      [A, n(2_000)],
      [B2, n(14_500)],
      [C, n(1_000_000)],
    ]);
    // Unquoted in a comma (or space) line: "1" and "000" could be two columns — never read as 1.
    expect(parseRecipients(`${A},1,000`).errors).toEqual([{ line: 1, text: AMBIGUOUS_AMOUNT }]);
    expect(parseRecipients(`${A} 1 000`).errors).toEqual([{ line: 1, text: AMBIGUOUS_AMOUNT }]);
    expect(parseRecipients(`${A},100,250`).errors).toEqual([{ line: 1, text: AMBIGUOUS_AMOUNT }]);
    // A decimal (in either notation) is still not a whole number of tokens.
    expect(parseRecipients(`${A};1,5`).errors[0].text).toMatch(/whole/);
    expect(parseRecipients(`${A} 1.000`).errors[0].text).toMatch(/whole/);
  });

  it("reads the columns a header row names, in any order and with extra columns", () => {
    const parsed = parseRecipients([`name,tokens,note,Wallet`, `Alice,"1,000",seed,${A}`, `Bob,25,,${B2}`].join("\n"));
    expect(parsed.header).toBe(true);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map((r) => [r.wallet, r.amount])).toEqual([
      [A, n(1_000)],
      [B2, n(25)],
    ]);
    // Under a header, an unquoted thousands separator shifts the columns: refused, never misread.
    expect(parseRecipients(`wallet,amount\n${A},1,000`).errors[0].text).toMatch(/more columns than the header row/);
    // A header naming neither column is skipped; the lines are read by position.
    const plain = parseRecipients(`Recipients list\n${A} 3`);
    expect(plain.header).toBe(true);
    expect(plain.rows.map((r) => r.amount)).toEqual([n(3)]);
  });

  it(`caps a run at ${MAX_DISTRIBUTION_ROWS} wallets`, async () => {
    const { generateKeyPairSigner } = await import("@solana/kit");
    const wallets = await Promise.all(Array.from({ length: MAX_DISTRIBUTION_ROWS + 1 }, async () => (await generateKeyPairSigner()).address));
    const parsed = parseRecipients(wallets.map((w) => `${w} 1`).join("\n"));
    expect(parsed.errors).toEqual([{ line: 0, text: `At most ${MAX_DISTRIBUTION_ROWS} wallets per run; split the list (${MAX_DISTRIBUTION_ROWS + 1} wallets now).` }]);
  });

  it("normalizes a list independently of its order (the run id hashes this)", () => {
    const a = parseRecipients(`${A} 1\n${B2} 2`).rows;
    const b = parseRecipients(`${B2} 2\n${A} 1`).rows;
    expect(normalizedRows(a)).toBe(normalizedRows(b));
    expect(normalizedRows(a)).not.toBe(normalizedRows(parseRecipients(`${A} 1\n${B2} 3`).rows));
  });
});

describe("share of the company per row", () => {
  const tokenize = { percent_e4: "50000", granularity_percent: "0.001", tokens: "5000", company_name: "Mancipatio" };

  it("comes from the tokenize figures, exactly", () => {
    const f = companyFiguresFrom(tokenize);
    expect(f).toEqual({ tokens: n(5_000), percentE4: n(50_000), tokenE4: n(10) });
    expect(percentOfCompany(n(5_000), f)).toBe("5");
    expect(percentOfCompany(n(100), f)).toBe("0.1");
    expect(percentOfCompany(n(1), f)).toBe("0.001");
    expect(percentOfCompany(n(333), f)).toBe("0.333");
    // More than the whole company is a bound, never an unbounded figure.
    expect(percentOfCompany(n(100_001), f)).toBe("> 100");
  });

  it("refuses figures that do not add up, and anything that is not the flow's record", () => {
    expect(companyFiguresFrom({ ...tokenize, percent_e4: "50001" })).toBeNull();
    expect(companyFiguresFrom({ ...tokenize, granularity_percent: "0.5" })).toBeNull();
    expect(companyFiguresFrom({ ...tokenize, tokens: 5000 })).toBeNull();
    expect(companyFiguresFrom(null)).toBeNull();
    expect(companyFiguresFrom([])).toBeNull();
    // A public total_shares column is never read: no figures, no percent.
    expect(percentOfCompany(n(100), companyFiguresFrom({ total_shares: 5000 }))).toBeNull();
  });
});

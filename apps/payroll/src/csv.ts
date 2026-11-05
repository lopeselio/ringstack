/**
 * Payroll CSV: a header row with `address` and `amount` (UI units), and an
 * optional `memo` column (which rows may also leave off). RFC 4180 quoting; blank lines and lines starting
 * with `#` are skipped. Row numbers are 1-based file lines, for messages.
 */
export interface CsvRow {
  readonly line: number;
  readonly address: string;
  readonly amount: string;
  readonly memo?: string;
}

/** Split CSV text into records of fields, honouring quotes. */
export function parseCsvRecords(text: string): { line: number; fields: string[] }[] {
  const records: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let fieldStarted = false;

  const endField = () => {
    fields.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    records.push({ line: recordLine, fields });
    fields = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (c === "\n") line++;
        field += c;
      }
      continue;
    }
    if (c === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (c === ",") endField();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
      recordLine = line;
    } else {
      field += c;
      fieldStarted = true;
    }
  }
  if (quoted) throw new Error(`line ${recordLine}: unterminated quoted field`);
  if (field !== "" || fields.length > 0) endRecord();
  return records.filter((r) => !(r.fields.length === 1 && r.fields[0]!.trim() === "") && !r.fields[0]!.startsWith("#"));
}

export function parsePayrollCsv(text: string): CsvRow[] {
  const records = parseCsvRecords(text.replace(/^﻿/, ""));
  const header = records.shift();
  if (header === undefined) throw new Error("CSV is empty");
  const cols = header.fields.map((f) => f.trim().toLowerCase());
  const at = (name: string) => cols.indexOf(name);
  if (at("address") < 0 || at("amount") < 0) throw new Error("CSV header needs address and amount columns");
  for (const c of cols) {
    if (!["address", "amount", "memo"].includes(c)) throw new Error(`unknown CSV column ${JSON.stringify(c)}`);
  }
  return records.map((r) => {
    // Trailing optional columns (memo) may be left out entirely.
    const missing = cols.slice(r.fields.length);
    if (r.fields.length > cols.length || missing.some((c) => c !== "memo")) {
      throw new Error(`line ${r.line}: expected ${cols.length} fields, got ${r.fields.length}`);
    }
    const memo = at("memo") >= 0 ? (r.fields[at("memo")] ?? "") : "";
    return {
      line: r.line,
      address: r.fields[at("address")]!.trim(),
      amount: r.fields[at("amount")]!.trim(),
      ...(memo === "" ? {} : { memo }),
    };
  });
}

/** Registered accounts, not unique people or live sessions. Methods overlap. */
export type AccountDirectoryMethod = "wallet" | "google" | "email";
export type AccountDirectoryRow = {
  id: string;
  display_name: string;
  email: string | null;
  google_email: string | null;
  created_at: string;
  wallets: string[];
  methods: AccountDirectoryMethod[];
  dossiers: { id: string; status: string }[];
};
export type AccountDirectorySummary = {
  total: number;
  wallet: number;
  google: number;
  email: number;
  without_verification: number;
};
export type AccountDirectory = {
  accounts: AccountDirectoryRow[];
  summary: AccountDirectorySummary;
  filtered_total: number;
  page: number;
  page_size: number;
  network: string;
};

export const ACCOUNT_DIRECTORY_PAGE_SIZE = 25;

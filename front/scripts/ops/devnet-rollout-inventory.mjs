#!/usr/bin/env node
/**
 * Read-only devnet rollout inventory. Requires Node >=22 and this repo's npm deps.
 * Usage: node scripts/ops/devnet-rollout-inventory.mjs [--program-dir PATH] [--env-file PATH] [--output PATH]
 * --dry-metadata verifies local paths/configuration without RPC or output-file writes.
 * Never loads a wallet/keypair. Only the RPC methods in READ_METHODS are callable.
 * Environment values, RPC paths/query strings and raw account data are not output.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { isRegistryTombstone } from './closed-account-tag.mjs';

const FRONT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const ROOT = path.resolve(arg('--program-dir', path.resolve(FRONT, '../program')));
const dryMetadata = process.argv.includes('--dry-metadata');
const envFile = path.resolve(arg('--env-file', path.join(FRONT, '.env.local')));
const outputFile = path.resolve(arg('--output', path.join(FRONT, 'docs/release-evidence/2026-09-07/devnet-inventory.json')));
const IDS = {
  asset_registry: 'FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS',
  transfer_hook: 'GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy',
};
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ZERO = '11111111111111111111111111111111';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const READ_METHODS = new Set(['getGenesisHash', 'getSlot', 'getVersion', 'getBlockTime', 'getMultipleAccounts', 'getProgramAccounts', 'getTokenLargestAccounts']);
const sha = value => createHash('sha256').update(value).digest('hex');
const bytes = getAddressEncoder();
const pubkeys = getAddressDecoder();
const key = data => pubkeys.decode(data);
const utf8 = value => Buffer.from(value, 'utf8');
const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
const pda = async (program, ...seeds) => (await getProgramDerivedAddress({ programAddress: address(program), seeds }))[0];
const trimZeros = b => { let n = b.length; while (n && b[n - 1] === 0) n--; return b.subarray(0, n); };

// Explicit allowlist: do not retain unrelated .env values or source shell code.
const envKeys = new Set(['NEXT_PUBLIC_NETWORK', 'NEXT_PUBLIC_SOLANA_RPC_URL', 'HELIUS_DEVNET_RPC', 'NEXT_PUBLIC_SOLANA_GENESIS_HASH', 'NEXT_PUBLIC_KYC_REGISTRY']);
const config = {};
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (!match || !envKeys.has(match[1])) continue;
  let value = match[2];
  if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
  else value = value.replace(/\s+#.*$/, '');
  config[match[1]] = value;
}
const network = config.NEXT_PUBLIC_NETWORK;
if (network !== 'devnet') throw new Error('Inventory only permits an explicitly configured devnet network');
const endpoint = config.HELIUS_DEVNET_RPC || 'https://api.devnet.solana.com';
function safeEndpoint(value) {
  try { const url = new URL(value); if (!['https:', 'http:'].includes(url.protocol)) throw new Error(); return url; }
  catch { throw new Error('Invalid RPC URL configuration (value withheld)'); }
}
const endpointHost = safeEndpoint(endpoint).hostname;
const evidence = {
  schema: 'mancipatio-read-only-devnet-inventory-v1',
  path_base: ROOT,
  started_at_utc: new Date().toISOString(),
  scope: 'Finalized read-only RPC observations over a slot interval, not an atomic snapshot. No wallet/keypair read, simulation, transaction, deployment or account mutation.',
  configuration: {
    env_file: path.relative(ROOT, envFile), network, rpc_hostname: endpointHost,
    rpc_selection: config.HELIUS_DEVNET_RPC ? 'HELIUS_DEVNET_RPC' : 'server default public devnet RPC',
    browser_rpc_hostname: config.NEXT_PUBLIC_SOLANA_RPC_URL ? safeEndpoint(config.NEXT_PUBLIC_SOLANA_RPC_URL).hostname : null,
    browser_rpc_equals_server_rpc: !config.NEXT_PUBLIC_SOLANA_RPC_URL || config.NEXT_PUBLIC_SOLANA_RPC_URL === endpoint,
    genesis_pin_configured: Boolean(config.NEXT_PUBLIC_SOLANA_GENESIS_HASH),
    // 2C-1: the platform KYC registry is pinned by address (a public account
    // address, not a secret). Unset = the front falls back to the scan
    // heuristic, which a rotation can make ambiguous.
    kyc_registry_pin_configured: Boolean(config.NEXT_PUBLIC_KYC_REGISTRY),
    kyc_registry_pin: config.NEXT_PUBLIC_KYC_REGISTRY || null,
  },
  git_head_start: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
  calls: [], failures: [], programs: [], scans: [], accounts: [], singletons: {}, mints: [], escrow_accounts: [], holder_scans: [], meta_lists: [], blockers: [], observations: [],
};
let requestId = 0;
async function rpc(method, params = [], scope = method) {
  if (dryMetadata) throw new Error('RPC is disabled in dry-metadata mode');
  if (!READ_METHODS.has(method)) throw new Error('Non-read-only RPC method refused');
  for (let attempt = 1; attempt <= 3; attempt++) {
    let failure;
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }), signal: AbortSignal.timeout(25000) });
      if (!response.ok) failure = { category: 'http', status: response.status };
      else {
        const body = await response.json();
        if (body.error) failure = { category: 'rpc', code: body.error.code };
        else if (!Object.hasOwn(body, 'result')) failure = { category: 'missing_result' };
        else {
          evidence.calls.push({ method, scope, attempt, status: 'ok', context_slot: body.result?.context?.slot ?? null });
          return body.result;
        }
      }
    } catch (error) { failure = { category: 'transport_or_parse', name: error?.name || 'Error' }; }
    const retry = attempt < 3 && (failure.category === 'transport_or_parse' || failure.status === 429 || failure.status >= 500 || failure.code === -32005);
    evidence.calls.push({ method, scope, attempt, status: 'failed', ...failure, retrying: retry });
    if (!retry) { evidence.failures.push({ method, scope, ...failure }); return null; }
    await new Promise(resolve => setTimeout(resolve, attempt * 1000));
  }
}
const getOpts = () => ({ encoding: 'base64', commitment: 'finalized', minContextSlot: evidence.start_slot });
const rawAccounts = new Map();
function remember(pubkey, account) {
  const value = account ? { ...account, data: Buffer.from(account.data[0], 'base64') } : null;
  rawAccounts.set(pubkey, value);
  return value;
}
async function fetchAccounts(keys, scope) {
  const unique = [...new Set(keys)].filter(k => k && k !== ZERO);
  for (let start = 0; start < unique.length; start += 100) {
    const batch = unique.slice(start, start + 100);
    const result = await rpc('getMultipleAccounts', [batch, getOpts()], `${scope}:${start / 100}`);
    if (result) result.value.forEach((a, i) => remember(batch[i], a));
  }
}
function snapshotCandidate(name) {
  const relative = `target/deploy/${name}.so`;
  if (!fs.existsSync(path.join(ROOT, relative))) return { path: relative, missing: true };
  const data = fs.readFileSync(path.join(ROOT, relative));
  return { path: relative, bytes: data.length, sha256: sha(data), nonzero_prefix_bytes: trimZeros(data).length, trailing_zero_normalized_sha256: sha(trimZeros(data)) };
}

// Decode current IDLs with an explicit v1 boundary. Never fabricate appended v2 counters.
const schemas = Object.fromEntries(Object.keys(IDS).map(name => {
  const file = path.join(FRONT, 'idl', `${name}.json`);
  const data = fs.readFileSync(file);
  return [name, { ...JSON.parse(data), file_sha256: sha(data) }];
}));
for (const [name, idl] of Object.entries(schemas)) if (idl.address !== IDS[name]) throw new Error(`IDL program address mismatch: ${name}`);
evidence.idl_inputs = Object.fromEntries(Object.entries(schemas).map(([name, idl]) => [name, { path: path.relative(ROOT, path.join(FRONT, 'idl', `${name}.json`)), sha256: idl.file_sha256 }]));
const CUSTODY_VAULT_V2_BYTES = 269;
const legacyAppend = { ShareClass: new Set(['lifetime_minted', 'cumulative_cap']), PayoutVault: new Set(['vote_round', 'vote_pending']), VaultVote: new Set(['round']) };
class Reader {
  constructor(data, idl) { this.data = data; this.offset = 8; this.types = new Map(idl.types.map(t => [t.name, t.type])); }
  take(n) { if (!Number.isSafeInteger(n) || n < 0 || this.offset + n > this.data.length) throw new Error('Account layout truncated'); const v = this.data.subarray(this.offset, this.offset + n); this.offset += n; return v; }
  read(type, named) {
    if (type === 'pubkey') return key(this.take(32));
    if (type === 'u8') return this.take(1)[0];
    if (type === 'u16') return this.take(2).readUInt16LE();
    if (type === 'u32') return this.take(4).readUInt32LE();
    if (type === 'u64') return this.take(8).readBigUInt64LE().toString();
    if (type === 'i64') return this.take(8).readBigInt64LE().toString();
    if (type === 'bool') { const n = this.take(1)[0]; if (n > 1) throw new Error('Invalid boolean'); return n === 1; }
    if (type === 'string') { const n = this.read('u32'); if (n > 65536) throw new Error('String bound'); return this.take(n).toString('utf8'); }
    if (type?.array) { const [item, n] = type.array; return item === 'u8' ? [...this.take(n)] : Array.from({ length: n }, () => this.read(item)); }
    if (type?.vec) { const n = this.read('u32'); if (n > 4096) throw new Error('Vector bound'); return Array.from({ length: n }, () => this.read(type.vec)); }
    if (type?.option) { const n = this.take(1)[0]; if (n > 1) throw new Error('Invalid option'); return n ? this.read(type.option) : null; }
    if (type?.defined) { const name = type.defined.name; return this.read(this.types.get(name), name); }
    if (type?.kind === 'enum') {
      const variant = type.variants[this.read('u8')]; if (!variant) throw new Error('Invalid enum');
      if (!variant.fields?.length) return variant.name;
      return { variant: variant.name, fields: variant.fields.map(f => this.read(f.type || f)) };
    }
    if (type?.kind === 'struct') {
      const value = {};
      for (const field of type.fields) {
        if (legacyAppend[named]?.has(field.name) && value.version !== 2) continue;
        value[field.name] = this.read(field.type);
      }
      return value;
    }
    throw new Error('Unsupported IDL type');
  }
}
const decoded = new Map();
const excludedFields = new Set(['name', 'symbol', 'symbol_prefix', 'uri', 'metadata_uri', 'asset_id', 'legal_entity_id', 'metadata_hash', 'legal_doc_hash', 'jurisdiction', 'display_name', 'description']);
function publicFields(value) {
  return Object.fromEntries(Object.entries(value).filter(([k, v]) => !excludedFields.has(k) && !Array.isArray(v) && (v === null || typeof v !== 'object')));
}
function decodeAccount(programName, pubkey, account) {
  // 2D: a rent-reclaimed Offer / OtcDeal / CustodyVault is an 8-byte
  // registry-owned tombstone, a known terminal row and never a blocker.
  if (isRegistryTombstone(account.owner, IDS.asset_registry, account.data)) {
    evidence.accounts.push({ address: pubkey, owner: account.owner, bytes: account.data.length, sha256: sha(account.data), type: 'Tombstone', executable: account.executable });
    return;
  }
  const idl = schemas[programName];
  const type = idl.accounts.find(a => account.data.subarray(0, 8).equals(Buffer.from(a.discriminator)));
  const row = { address: pubkey, owner: account.owner, bytes: account.data.length, sha256: sha(account.data), type: type?.name ?? 'Unknown', executable: account.executable };
  // 2C-3 hard gate: CustodyVault v2 appends kyc_registry (269 B) with no
  // realloc path, so the upgraded program cannot load a v1 (237 B) vault
  // (3003) — not even to realize, return or burn a clawback quarantine.
  // Drain every v1 vault BEFORE the upgrade.
  if (type?.name === 'CustodyVault' && account.data.length !== CUSTODY_VAULT_V2_BYTES) evidence.blockers.push(`CustodyVault ${pubkey}: ${account.data.length} B, not v2 (${CUSTODY_VAULT_V2_BYTES} B); the 2C-3 program cannot load it. Realize, return or revert it before the upgrade`);
  if (type) {
    try {
      const reader = new Reader(account.data, idl);
      const value = reader.read({ defined: { name: type.name } });
      if (Object.hasOwn(legacyAppend, type.name) && ![1, 2].includes(value.version)) throw new Error('Unsupported account version');
      row.fields = publicFields(value); row.decoded_prefix_bytes = reader.offset;
      row.legacy_v1 = value.version === 1 && Object.hasOwn(legacyAppend, type.name);
      decoded.set(pubkey, { type: type.name, value });
    } catch (error) { row.decode_error = error.message; evidence.blockers.push(`Cannot safely decode ${type.name} ${pubkey}: ${error.message}`); }
  } else if (account.executable || account.data.length >= 4 && account.data.readUInt32LE(0) === 2) {
    row.note = 'Non-Anchor program-owned data; inspected separately if executable';
  } else {
    row.discriminator_hex = account.data.subarray(0, 8).toString('hex');
    // Hook TLV accounts have the Execute discriminator, not an Anchor account discriminator.
    const executeDisc = createHash('sha256').update('spl-transfer-hook-interface:execute').digest().subarray(0, 8);
    if (programName !== 'transfer_hook' || !account.data.subarray(0, 8).equals(executeDisc)) evidence.blockers.push(`Unknown ${programName} account layout ${pubkey}`);
  }
  evidence.accounts.push(row);
}
const tokenExtensionNames = ['Uninitialized','TransferFeeConfig','TransferFeeAmount','MintCloseAuthority','ConfidentialTransferMint','ConfidentialTransferAccount','DefaultAccountState','ImmutableOwner','MemoTransfer','NonTransferable','InterestBearingConfig','CpiGuard','PermanentDelegate','NonTransferableAccount','TransferHook','TransferHookAccount','ConfidentialTransferFeeConfig','ConfidentialTransferFeeAmount','MetadataPointer','TokenMetadata','GroupPointer','TokenGroup','GroupMemberPointer','TokenGroupMember','ConfidentialMintBurn','ScaledUiAmount','Pausable','PausableAccount','PermissionedBurn'];
function extensions(account, kind) {
  if (account.owner !== TOKEN2022 || account.data.length === (kind === 'mint' ? 82 : 165)) return [];
  if (account.data.length < 166 || account.data[165] !== (kind === 'mint' ? 1 : 2)) throw new Error('Invalid Token-2022 account type');
  const values = [];
  for (let offset = 166; offset < account.data.length;) {
    if (account.data.subarray(offset).every(b => b === 0)) break;
    if (offset + 4 > account.data.length) throw new Error('Truncated TLV header');
    const id = account.data.readUInt16LE(offset), length = account.data.readUInt16LE(offset + 2);
    if (offset + 4 + length > account.data.length) throw new Error('Truncated TLV data');
    values.push({ id, name: tokenExtensionNames[id] || `Unknown${id}`, data: account.data.subarray(offset + 4, offset + 4 + length) });
    offset += 4 + length;
  }
  return values;
}
function optionalPubkey(data, offset) { const tag = data.readUInt32LE(offset); if (tag > 1) throw new Error('Invalid COption'); return tag ? key(data.subarray(offset + 4, offset + 36)) : null; }
function decodeToken(account) {
  if (![TOKEN, TOKEN2022].includes(account.owner) || account.data.length < 165) throw new Error('Not a supported token account');
  const ext = extensions(account, 'account');
  return { token_program: account.owner, mint: key(account.data.subarray(0, 32)), authority: key(account.data.subarray(32, 64)), amount: account.data.readBigUInt64LE(64).toString(), state: ['Uninitialized', 'Initialized', 'Frozen'][account.data[108]] || 'Invalid', immutable_owner: ext.some(e => e.id === 7), extensions: ext.map(e => e.name), bytes: account.data.length };
}
function mintPolicy(account, share) {
  if (![TOKEN, TOKEN2022].includes(account.owner) || account.data.length < 82) throw new Error('Not a supported mint');
  const ext = extensions(account, 'mint');
  const mintAuthority = optionalPubkey(account.data, 0);
  const hook = ext.find(e => e.id === 14), delegate = ext.find(e => e.id === 12);
  const hookAuthority = hook ? key(hook.data.subarray(0, 32)) : null;
  const hookProgram = hook ? key(hook.data.subarray(32, 64)) : null;
  const permanentDelegate = delegate ? key(delegate.data) : null;
  const authenticShare = Boolean(share && account.owner === TOKEN2022 && mintAuthority === share && hookAuthority === share && hookProgram === IDS.transfer_hook && permanentDelegate === share);
  const supported = new Set([0, 3, 18, 19, 20, 21, 22, 23, ...(authenticShare ? [12, 14] : [])]);
  return { token_program: account.owner, bytes: account.data.length, supply: account.data.readBigUInt64LE(36).toString(), decimals: account.data[44], initialized: account.data[45] === 1, mint_authority: mintAuthority, freeze_authority: optionalPubkey(account.data, 46), hook_authority: hookAuthority, hook_program: hookProgram, permanent_delegate: permanentDelegate, canonical_share_authorities: authenticShare, extensions: ext.map(e => e.name), unsupported_extensions: ext.filter(e => !supported.has(e.id)).map(e => e.name) };
}

async function inspectMetaList(shareAddress, share) {
  const mint = share.mint;
  const configPda = await pda(IDS.transfer_hook, utf8('hook_cfg'), bytes.encode(mint));
  const metaPda = await pda(IDS.transfer_hook, utf8('extra-account-metas'), bytes.encode(mint));
  await fetchAccounts([configPda, metaPda], `hook-meta:${mint}`);
  const cfg = decoded.get(configPda), meta = rawAccounts.get(metaPda);
  const row = { mint, share_class: shareAddress, config_pda: configPda, meta_pda: metaPda, config_exists: Boolean(rawAccounts.get(configPda)), meta_exists: Boolean(meta), compatible: false };
  if (!cfg || cfg.type !== 'TransferHookConfig' || !meta) { row.reason = 'Missing or undecodable hook config/meta list'; evidence.meta_lists.push(row); return; }
  const data = meta.data;
  const packedSeed = (...parts) => { const value = Buffer.concat(parts); if (value.length > 32) throw new Error('Seed config too long'); return Buffer.concat([value, Buffer.alloc(32 - value.length)]); };
  const literal = value => Buffer.concat([Buffer.from([1, Buffer.byteLength(value)]), utf8(value)]);
  const own = (...parts) => ({ discriminator: 1, config: packedSeed(...parts) });
  const external = (...parts) => ({ discriminator: 136, config: packedSeed(...parts) });
  const expected = [own(literal('blocked'), Buffer.from([4, 0, 32, 32]))];
  if (cfg.value.restriction_mode === 'KycGated') expected.push(
    own(literal('hook_cfg'), Buffer.from([3, 1])),
    { discriminator: 0, config: Buffer.from(bytes.encode(cfg.value.kyc_registry)) },
    { discriminator: 0, config: Buffer.from(bytes.encode(IDS.asset_registry)) },
    external(literal('kyc'), Buffer.from([3, 7, 4, 2, 32, 32])),
    external(literal('escrow_marker'), Buffer.from([4, 2, 32, 32])),
    external(literal('escrow_marker'), Buffer.from([4, 0, 32, 32])),
  );
  const count = data.length >= 16 ? data.readUInt32LE(12) : -1;
  const executeDisc = createHash('sha256').update('spl-transfer-hook-interface:execute').digest().subarray(0, 8);
  const entriesMatch = count === expected.length && expected.every((e, i) => { const start = 16 + i * 35; return data.length >= start + 35 && data[start] === e.discriminator && data.subarray(start + 1, start + 33).equals(e.config) && data[start + 33] === 0 && data[start + 34] === 0; });
  row.mode = cfg.value.restriction_mode; row.count = count; row.bytes = data.length; row.sha256 = sha(data);
  row.compatible = meta.owner === IDS.transfer_hook && data.subarray(0, 8).equals(executeDisc) && data.readUInt32LE(8) === 4 + count * 35 && entriesMatch && cfg.value.mint === mint && cfg.value.share_class === shareAddress && cfg.value.blocklist === evidence.singletons.blocklist.address;
  row.source_block_entry_semantics = data.subarray(17, 49).equals(expected[0].config) ? 'source_token_owner' : 'legacy_or_unknown';
  if (!row.compatible) row.reason = 'Exact current metadata/config comparison failed';
  evidence.meta_lists.push(row);
}

async function main() {
  evidence.genesis_hash = await rpc('getGenesisHash');
  if (evidence.genesis_hash !== DEVNET_GENESIS) throw new Error('Devnet genesis verification failed; no account inventory attempted');
  if (config.NEXT_PUBLIC_SOLANA_GENESIS_HASH && config.NEXT_PUBLIC_SOLANA_GENESIS_HASH !== evidence.genesis_hash) throw new Error('Configured genesis pin mismatch');
  evidence.start_slot = await rpc('getSlot', [{ commitment: 'finalized' }]);
  if (!Number.isSafeInteger(evidence.start_slot)) throw new Error('Finalized start slot unavailable');
  evidence.node_version = await rpc('getVersion');
  const candidateStart = Object.fromEntries(Object.keys(IDS).map(n => [n, snapshotCandidate(n)]));
  const manifestPath = path.join(ROOT, 'docs/release-evidence/2026-09-07/local-sbf-provenance.json');
  if (fs.existsSync(manifestPath)) {
    const manifestBytes = fs.readFileSync(manifestPath), manifest = JSON.parse(manifestBytes);
    evidence.local_build_evidence = { path: path.relative(ROOT, manifestPath), sha256: sha(manifestBytes), created_at_utc: manifest.created_at_utc, source_inputs_sha256: manifest.source_inputs_sha256, test_inputs_sha256: manifest.test_inputs_sha256 };
  }
  await fetchAccounts(Object.values(IDS), 'programs');
  for (const [name, programId] of Object.entries(IDS)) {
    const a = rawAccounts.get(programId);
    const row = { name, address: programId, exists: Boolean(a), candidate: candidateStart[name] };
    if (a) {
      Object.assign(row, { owner: a.owner, executable: a.executable, bytes: a.data.length, account_sha256: sha(a.data) });
      if (a.owner === LOADER && a.executable && a.data.length >= 36 && a.data.readUInt32LE(0) === 2) {
        row.program_data = key(a.data.subarray(4, 36));
        row.expected_program_data = await pda(LOADER, bytes.encode(programId));
        row.canonical_program_data = row.program_data === row.expected_program_data;
        if (!row.canonical_program_data) evidence.blockers.push(`${name}: noncanonical ProgramData address`);
      } else { row.invalid_program_layout = true; evidence.blockers.push(`${name}: invalid program account layout/owner/executable flag`); }
    }
    evidence.programs.push(row);
  }
  await fetchAccounts(evidence.programs.map(p => p.program_data), 'program-data');
  for (const row of evidence.programs) {
    const data = rawAccounts.get(row.program_data);
    if (data && data.data.length >= 45 && data.owner === LOADER && data.data.readUInt32LE(0) === 3) {
      const payload = data.data.subarray(45), candidate = fs.existsSync(path.join(ROOT, row.candidate.path)) ? fs.readFileSync(path.join(ROOT, row.candidate.path)) : null;
      const authorityTag = data.data[12];
      row.program_data_info = { owner: data.owner, bytes: data.data.length, account_sha256: sha(data.data), payload_capacity_bytes: payload.length, last_deploy_slot: data.data.readBigUInt64LE(4).toString(), upgrade_authority: authorityTag === 1 ? key(data.data.subarray(13, 45)) : null, authority_option_valid: authorityTag <= 1, full_payload_sha256: sha(payload), nonzero_prefix_bytes: trimZeros(payload).length, trailing_zero_normalized_sha256: sha(trimZeros(payload)), candidate_fits_capacity: Boolean(candidate && candidate.length <= payload.length), candidate_bytes: candidate ? candidate.length : null, candidate_headroom_bytes: candidate ? payload.length - candidate.length : null, candidate_exact_prefix_and_zero_padding: Boolean(candidate && candidate.length <= payload.length && payload.subarray(0, candidate.length).equals(candidate) && payload.subarray(candidate.length).every(b => b === 0)), candidate_normalized_match: Boolean(candidate && trimZeros(payload).equals(trimZeros(candidate))) };
      if (!row.program_data_info.authority_option_valid) evidence.blockers.push(`${row.name}: invalid ProgramData upgrade-authority option`);
      if (!row.program_data_info.candidate_exact_prefix_and_zero_padding) evidence.blockers.push(`${row.name}: deployed bytes differ from local candidate`);
      if (!row.program_data_info.candidate_fits_capacity) evidence.blockers.push(`${row.name}: ProgramData capacity smaller than local candidate`);
    } else evidence.blockers.push(`${row.name}: ProgramData unavailable or invalid`);
  }
  for (const [name, id] of Object.entries(IDS)) {
    const result = await rpc('getProgramAccounts', [id, { ...getOpts(), withContext: true }], `${name}:all-owned-accounts`);
    evidence.scans.push({ program: name, address: id, complete: result !== null, context_slot: result?.context?.slot ?? null, count: result?.value.length ?? null, account_set_sha256: result ? sha(result.value.map(a => `${a.pubkey}\0${sha(Buffer.from(a.account.data[0], 'base64'))}\n`).sort().join('')) : null });
    if (result) for (const { pubkey, account } of result.value) decodeAccount(name, pubkey, remember(pubkey, account));
  }
  for (const [label, program, seed, expectedType] of [['platform', IDS.asset_registry, 'platform', 'Platform'], ['blocklist', IDS.transfer_hook, 'blocklist_authority', 'BlocklistAuthority']]) {
    const addr = await pda(program, utf8(seed));
    await fetchAccounts([addr], `singleton:${label}`);
    const a = rawAccounts.get(addr), dec = decoded.get(addr);
    evidence.singletons[label] = { address: addr, exists: Boolean(a), expected_owner: program, owner: a?.owner ?? null, type: dec?.type ?? null, fields: dec ? publicFields(dec.value) : null, valid: Boolean(a?.owner === program && dec?.type === expectedType) };
    if (!evidence.singletons[label].valid) evidence.blockers.push(`${expectedType}: not initialized at canonical PDA or invalid`);
  }
  // 2C-1: the pinned platform KYC registry must be a live KycRegistry. It is
  // found by ADDRESS (a rotated registry is not derivable from its authority).
  if (config.NEXT_PUBLIC_KYC_REGISTRY) {
    const pin = config.NEXT_PUBLIC_KYC_REGISTRY;
    await fetchAccounts([pin], 'singleton:kyc_registry_pin');
    const a = rawAccounts.get(pin), dec = decoded.get(pin);
    evidence.singletons.kyc_registry_pin = { address: pin, exists: Boolean(a), expected_owner: IDS.asset_registry, owner: a?.owner ?? null, type: dec?.type ?? null, fields: dec ? publicFields(dec.value) : null, valid: Boolean(a?.owner === IDS.asset_registry && dec?.type === 'KycRegistry') };
    if (!evidence.singletons.kyc_registry_pin.valid) evidence.blockers.push(`NEXT_PUBLIC_KYC_REGISTRY ${pin}: not a live KycRegistry on this network`);
  } else evidence.blockers.push('NEXT_PUBLIC_KYC_REGISTRY: not configured (2C-1 pins the platform KYC registry by address)');
  const mintShares = new Map(), mintRefs = new Set(), escrowRefs = [];
  for (const [addr, { type, value: v }] of decoded) {
    let expected;
    if (type === 'Admin') expected = await pda(IDS.asset_registry, utf8('admin'), bytes.encode(v.admin));
    if (type === 'Issuer') expected = await pda(IDS.asset_registry, utf8('issuer'), Buffer.from(v.legal_entity_id));
    if (expected) {
      const row = evidence.accounts.find(a => a.address === addr); row.canonical_pda = addr === expected;
      if (!row.canonical_pda) evidence.blockers.push(`${type} ${addr}: noncanonical PDA`);
    }
    for (const field of ['mint', 'payment_mint', 'token_mint', 'underlying_mint']) if (v[field] && v[field] !== ZERO) mintRefs.add(v[field]);
    if (type === 'ShareClass') {
      const expectedClass = await pda(IDS.asset_registry, utf8('share_class'), bytes.encode(v.asset), Buffer.from([v.class_index]));
      const expectedMint = await pda(IDS.asset_registry, utf8('share_mint'), bytes.encode(addr));
      if (addr !== expectedClass || v.mint_initialized && v.mint !== expectedMint) evidence.blockers.push(`ShareClass ${addr}: canonical PDA/mint mismatch`);
      if (v.mint_initialized) mintShares.set(v.mint, addr);
      if (v.version !== 2) evidence.blockers.push(`ShareClass ${addr}: legacy version; no new issuance and size preparation required before affected exits`);
    }
    if (type === 'PayoutVault' && (v.state === 'Frozen' || v.vote_pending)) evidence.blockers.push(`PayoutVault ${addr}: frozen/pending vote requires explicit round and entitlement review`);
    if (type === 'VaultVote' && v.version !== 2 && v.outcome === 'Pending') evidence.blockers.push(`VaultVote ${addr}: pending legacy vote migration gate`);
    const fields = ['escrow', 'proceeds', 'asset_escrow', 'payment_escrow'];
    for (const field of fields) if (v[field]) {
      const mint = field === 'payment_escrow' || field === 'proceeds' || ['Distribution','PayoutVault'].includes(type) ? v.payment_mint : v.token_mint || v.underlying_mint || v.mint;
      escrowRefs.push({ address: v[field], parent: addr, parent_type: type, field, expected_mint: mint, parent_status: v.status || v.state || null });
    }
  }
  await fetchAccounts([...mintRefs, ...escrowRefs.map(e => e.address)], 'mints-and-escrows');
  for (const mint of mintRefs) {
    const a = rawAccounts.get(mint), row = { address: mint, exists: Boolean(a), share_class: mintShares.get(mint) || null };
    try { if (a) Object.assign(row, mintPolicy(a, mintShares.get(mint))); else row.decode_error = 'Mint missing/unread'; }
    catch (error) { row.decode_error = error.message; }
    if (row.decode_error || row.unsupported_extensions?.length) evidence.blockers.push(`Mint ${mint}: ${row.decode_error || `unsupported extensions ${row.unsupported_extensions.join(', ')}`}`);
    if (row.share_class && !row.canonical_share_authorities) evidence.blockers.push(`Share mint ${mint}: expected registry mint authority, transfer hook and permanent delegate binding missing`);
    if (row.freeze_authority) evidence.observations.push(`Mint ${mint} retains freeze authority; operational freeze risk remains`);
    evidence.mints.push(row);
  }
  for (const ref of escrowRefs) {
    const a = rawAccounts.get(ref.address), row = { ...ref, exists: Boolean(a) };
    try {
      if (a) {
        Object.assign(row, decodeToken(a)); row.identity_matches_parent = row.authority === ref.parent && row.mint === ref.expected_mint;
        if (!row.identity_matches_parent) evidence.blockers.push(`Escrow ${ref.address}: authority/mint mismatch`);
        if (row.token_program === TOKEN2022 && !row.immutable_owner) evidence.observations.push(`Escrow ${ref.address}: mutable legacy owner; preserve exits, block new inbound funding`);
      } else row.note = 'Absent or unread; may be closed for terminal parent, inspect status';
    } catch (error) { row.decode_error = error.message; evidence.blockers.push(`Escrow ${ref.address}: cannot decode`); }
    if (['RightsIssuance','VestingSeries'].includes(ref.parent_type)) {
      const identity = await pda(IDS.asset_registry, utf8('escrow_marker'), bytes.encode(ref.parent));
      row.identity_pda = identity; row.identity_type = decoded.get(identity)?.type || null;
      if (row.identity_type !== 'EscrowIdentity') evidence.observations.push(`${ref.parent_type} ${ref.parent}: needs legacy identity attach; own deposit history must remain zero`);
    }
    evidence.escrow_accounts.push(row);
  }
  for (const [mint, shareAddress] of mintShares) {
    const result = await rpc('getProgramAccounts', [TOKEN2022, { ...getOpts(), withContext: true, filters: [{ memcmp: { offset: 0, bytes: mint } }] }], `holders:${mint}`);
    const row = { mint, complete: result !== null, context_slot: result?.context?.slot ?? null, accounts: [] };
    if (result) {
      for (const { pubkey, account } of result.value) {
        try { const t = decodeToken(remember(pubkey, account)); if (t.mint === mint) row.accounts.push({ address: pubkey, ...t }); }
        catch { row.decode_failures = (row.decode_failures || 0) + 1; row.complete = false; }
      }
    } else {
      const largest = await rpc('getTokenLargestAccounts', [mint, { commitment: 'finalized' }], `holders-largest-fallback:${mint}`);
      row.fallback = { kind: 'at-most-20-largest-not-complete-inventory', context_slot: largest?.context?.slot ?? null, count: largest?.value.length ?? null };
      if (largest) {
        await fetchAccounts(largest.value.map(a => a.address), `holders-largest-data:${mint}`);
        for (const account of largest.value) { const raw = rawAccounts.get(account.address); try { if (raw) row.accounts.push({ address: account.address, ...decodeToken(raw) }); } catch { /* represented by incomplete coverage */ } }
      }
    }
    row.funded_mutable_accounts = row.accounts.filter(a => BigInt(a.amount) > 0n && !a.immutable_owner).map(a => a.address);
    row.observed_amount_sum = row.accounts.reduce((sum, a) => sum + BigInt(a.amount), 0n).toString();
    if (!row.complete) evidence.blockers.push(`Mint ${mint}: incomplete holder/ImmutableOwner inventory`);
    if (row.funded_mutable_accounts.length) evidence.blockers.push(`Mint ${mint}: ${row.funded_mutable_accounts.length} funded accounts lack ImmutableOwner`);
    evidence.holder_scans.push(row);
    await inspectMetaList(shareAddress, decoded.get(shareAddress).value);
  }
  for (const meta of evidence.meta_lists) if (!meta.compatible) evidence.blockers.push(`Mint ${meta.mint}: hook extra-account metadata requires refresh/initialization`);
  evidence.account_counts_by_type = evidence.accounts.reduce((a, row) => { a[row.type] = (a[row.type] || 0) + 1; return a; }, {});
  evidence.scan_rechecks = [];
  for (const scan of evidence.scans) {
    const result = await rpc('getProgramAccounts', [scan.address, { ...getOpts(), withContext: true }], `${scan.program}:stability-recheck`);
    const digest = result ? sha(result.value.map(a => `${a.pubkey}\0${sha(Buffer.from(a.account.data[0], 'base64'))}\n`).sort().join('')) : null;
    evidence.scan_rechecks.push({ program: scan.program, context_slot: result?.context?.slot ?? null, count: result?.value.length ?? null, account_set_sha256: digest, unchanged: Boolean(result && digest === scan.account_set_sha256) });
  }
  evidence.program_account_sets_stable = evidence.scan_rechecks.every(s => s.unchanged);
  if (!evidence.program_account_sets_stable) evidence.blockers.push('Program-owned account sets changed or could not be rechecked; repeat inventory');
  await fetchAccounts(evidence.programs.flatMap(p => [p.address, p.program_data]), 'program-binary-stability-recheck');
  for (const program of evidence.programs) {
    const p = rawAccounts.get(program.address), d = rawAccounts.get(program.program_data);
    program.unchanged_at_recheck = Boolean(p && d && sha(p.data) === program.account_sha256 && sha(d.data) === program.program_data_info?.account_sha256 && d.data.length === program.program_data_info?.bytes);
    if (!program.unchanged_at_recheck) evidence.blockers.push(`${program.name}: on-chain program changed or could not be rechecked`);
  }
  evidence.end_slot = await rpc('getSlot', [{ commitment: 'finalized' }]);
  evidence.end_slot_block_time = evidence.end_slot === null ? null : await rpc('getBlockTime', [evidence.end_slot]);
  evidence.candidates_end = Object.fromEntries(Object.keys(IDS).map(n => [n, snapshotCandidate(n)]));
  evidence.candidate_files_changed_during_inventory = Object.keys(IDS).some(n => candidateStart[n].sha256 !== evidence.candidates_end[n].sha256);
  if (evidence.candidate_files_changed_during_inventory) evidence.blockers.push('Local candidate files changed during inventory; repeat binary comparison');
  evidence.git_head_end = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  evidence.coverage_complete = evidence.failures.length === 0 && evidence.scans.every(s => s.complete) && !evidence.accounts.some(a => a.decode_error) && evidence.holder_scans.every(s => s.complete);
  evidence.inventory_gate_clear = evidence.coverage_complete && evidence.blockers.length === 0;
  evidence.pilot_ready = null;
  evidence.pilot_readiness_scope = 'This inventory does not establish complete pilot readiness. It excludes DB/hosting/session configuration, real wallet transaction flows, legal review, role custody and production/mainnet approval. Zero share classes means mint, holder, escrow and hook-meta compatibility branches have no live sample.';
}
if (dryMetadata) {
  console.log(JSON.stringify({ mode: 'dry-metadata', rpc_calls: requestId, output_written: false, frontend_dir: FRONT, program_dir: ROOT, env_file: envFile, output_file: outputFile, network, rpc_hostname: endpointHost, program_git_head: evidence.git_head_start, idl_inputs: evidence.idl_inputs, candidates: Object.fromEntries(Object.keys(IDS).map(name => [name, snapshotCandidate(name)])) }, null, 2));
} else {
  try { await main(); }
  catch (error) { evidence.fatal_error = error.message; evidence.coverage_complete = false; evidence.inventory_gate_clear = false; evidence.pilot_ready = null; }
  evidence.finished_at_utc = new Date().toISOString();
  evidence.script_sha256 = sha(fs.readFileSync(fileURLToPath(import.meta.url)));
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ output: path.relative(FRONT, outputFile), started_at_utc: evidence.started_at_utc, finished_at_utc: evidence.finished_at_utc, network, genesis_verified: evidence.genesis_hash === DEVNET_GENESIS, start_slot: evidence.start_slot, end_slot: evidence.end_slot, account_counts: evidence.account_counts_by_type, failures: evidence.failures.length, blockers: evidence.blockers, coverage_complete: evidence.coverage_complete, inventory_gate_clear: evidence.inventory_gate_clear, fatal_error: evidence.fatal_error }, null, 2));
  if (evidence.fatal_error || !evidence.coverage_complete) process.exitCode = 2;
}

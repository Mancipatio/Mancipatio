// Sekvencijalni upload IDL-a u canonical program-metadata nalog (zaobilazi
// paralelni executor CLI-ja koji pada na devnetu). Sve tx idu jedna po jedna,
// potvrda preko HTTP getSignatureStatuses (bez websocketa).
//
// Pokretanje (posle `anchor build`, iz korena workspace-a):
//   npm install        # zavisnosti su u devDependencies, NODE_PATH nije potreban
//   npm run idl:upload
//
// Env: PROGRAM_ID, IDL_PATH, HELIUS_DEVNET_RPC (default javni devnet RPC).
const fs = require('fs');
const kit = require('@solana/kit');
const pm = require('@solana-program/program-metadata');
const system = require('@solana-program/system');

const RPC = process.env.HELIUS_DEVNET_RPC || 'https://api.devnet.solana.com';
const PROGRAM = process.env.PROGRAM_ID || 'FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS';
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const KEYPAIR = process.env.HOME + '/.config/solana/id-devnet.json';
const IDL_PATH = process.env.IDL_PATH || require('path').resolve(__dirname, '../target/idl/asset_registry.json');
const REALLOC_LIMIT = 10240;
const WRITE_CHUNK = 800;

const rpc = kit.createSolanaRpc(RPC);

async function sendSeq(label, signer, extraSigners, instructions) {
  const { value: bh } = await rpc.getLatestBlockhash().send();
  const msg = kit.pipe(
    kit.createTransactionMessage({ version: 0 }),
    (m) => kit.setTransactionMessageFeePayerSigner(signer, m),
    (m) => kit.setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => kit.appendTransactionMessageInstructions(instructions, m)
  );
  const signed = await kit.signTransactionMessageWithSigners(msg);
  const wire = kit.getBase64EncodedWireTransaction(signed);
  const sig = kit.getSignatureFromTransaction(signed);
  await rpc.sendTransaction(wire, { encoding: 'base64', skipPreflight: false, maxRetries: 10n }).send();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    const st = value && value[0];
    if (st && st.err) throw new Error(label + ' FAILED: ' + JSON.stringify(st.err));
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
      console.log('OK  ' + label + '  ' + sig.slice(0, 16) + '…');
      return sig;
    }
  }
  throw new Error(label + ': potvrda istekla (60s)');
}

(async () => {
  const bytes = new Uint8Array(JSON.parse(fs.readFileSync(KEYPAIR, 'utf8')));
  const signer = await kit.createKeyPairSignerFromBytes(bytes);
  console.log('authority:', signer.address);

  const [metadata] = await pm.findCanonicalPda({ program: PROGRAM, seed: 'idl' });
  const [programData] = await kit.getProgramDerivedAddress({
    programAddress: LOADER,
    seeds: [kit.getAddressEncoder().encode(PROGRAM)],
  });
  console.log('metadata:', metadata, ' programData:', programData);

  const content = fs.readFileSync(IDL_PATH, 'utf8');
  const data = pm.compressData(pm.encodeData(content, pm.Encoding.Utf8), pm.Compression.Zlib);
  console.log('idl raw:', content.length, 'B → zlib:', data.length, 'B');

  const meta = await pm.fetchMaybeMetadata(rpc, metadata);
  if (!meta.exists) throw new Error('metadata nalog ne postoji — očekivan update tok');
  if (!meta.data.mutable) throw new Error('metadata je immutable');
  const oldLen = meta.data.data.length;
  const sizeDiff = data.length - oldLen;
  console.log('stara dužina:', oldLen, ' nova:', data.length, ' razlika:', sizeDiff);

  // 1) rent dopuna + extend metadata naloga (≤10240 realloc po tx)
  if (sizeDiff > 0) {
    const extraRent = await rpc.getMinimumBalanceForRentExemption(BigInt(sizeDiff)).send();
    let remaining = sizeDiff;
    let first = true;
    while (remaining > 0) {
      const step = Math.min(remaining, REALLOC_LIMIT);
      const ixs = [];
      if (first) {
        ixs.push(system.getTransferSolInstruction({ source: signer, destination: metadata, amount: extraRent }));
        first = false;
      }
      ixs.push(pm.getExtendInstruction({ account: metadata, authority: signer, length: step, program: PROGRAM, programData }));
      await sendSeq('extend +' + step, signer, [], ixs);
      remaining -= step;
    }
  }

  // 2) kreiraj buffer nalog pune veličine (createAccount nema realloc limit)
  const buffer = await kit.generateKeyPairSigner();
  const space = BigInt(pm.ACCOUNT_HEADER_LENGTH + data.length);
  const fullRent = await rpc.getMinimumBalanceForRentExemption(space).send();
  await sendSeq('create buffer', signer, [buffer], [
    system.getCreateAccountInstruction({ payer: signer, newAccount: buffer, lamports: fullRent, space, programAddress: pm.PROGRAM_METADATA_PROGRAM_ADDRESS }),
    pm.getAllocateInstruction({ buffer: buffer.address, authority: buffer }),
    pm.getSetAuthorityInstruction({ account: buffer.address, authority: buffer, newAuthority: signer.address }),
  ]);
  console.log('buffer:', buffer.address);

  // 3) upiši sadržaj u buffer, sekvencijalno
  const total = Math.ceil(data.length / WRITE_CHUNK);
  for (let off = 0, n = 1; off < data.length; off += WRITE_CHUNK, n++) {
    const chunk = data.slice(off, off + WRITE_CHUNK);
    await sendSeq('write ' + n + '/' + total, signer, [], [
      pm.getWriteInstruction({ buffer: buffer.address, authority: signer, offset: off, data: chunk }),
    ]);
  }

  // 4) setData iz buffera + zatvori buffer (vraća rent)
  await sendSeq('setData', signer, [], [
    pm.getSetDataInstruction({
      metadata, authority: signer, buffer: buffer.address, program: PROGRAM, programData,
      compression: pm.Compression.Zlib, encoding: pm.Encoding.Utf8, dataSource: pm.DataSource.Direct, format: pm.Format.Json, data: null,
    }),
  ]);
  await sendSeq('close buffer', signer, [], [
    pm.getCloseInstruction({ account: buffer.address, authority: signer, destination: signer.address }),
  ]);

  // 5) trim viška ako se novi sadržaj smanjio (ovde ne očekujemo)
  if (sizeDiff < 0) {
    await sendSeq('trim', signer, [], [
      pm.getTrimInstruction({ account: metadata, authority: signer, destination: signer.address, program: PROGRAM, programData }),
    ]);
  }

  console.log('GOTOVO — IDL upisan u', metadata);
})().catch((e) => { console.error('GREŠKA:', e.message || e); process.exit(1); });

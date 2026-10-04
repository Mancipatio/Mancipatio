// Messages Phantom signed on mainnet for the issuer authority 6AnF…HsP, read
// from the public RPC (getTransaction, encoding "base64"; the wire
// transaction minus its signature). Phantom kept Manci's compute budget
// exactly as built, [SetComputeUnitLimit(200000), SetComputeUnitPrice(100000)]
// (fee 25 000 lamports = 5 000 + 200 000 × 0.1), and added Lighthouse
// assertions (L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95) with the
// Lighthouse program key as a read-only account. Nothing else changed.

/**
 * 5BKju48sSPui7JWuR1oCNf7WmRmcPESRs3AsF38MggNESyqjGYBeszKjV38fC37q5oEeGxvoRxQKAuNHRyYwwtS8,
 * "Send to holder": 500 MANCI0 to 3ND1v63… (slot 453357665, 63 269 CU, legacy).
 * [limit, price, ATA CreateIdempotent, Token-2022 TransferChecked + hook tail,
 *  Lighthouse AssertAccountInfoMulti (the fee payer),
 *  Lighthouse AssertTokenAccountMulti (the sender's token account 2C2J…)]:
 * the shape of a one-row "Send to wallets" transaction, guards appended.
 */
export const PHANTOM_SEND_TO_HOLDER_MESSAGE =
  "AQAKDUzL1AM6knEks5ol+j/hDD+Jao+AAxBrj5f7K/FKY/LSEa6Jw2lRW5CilX19pvjagTUXEV3dUXoNSXJB0+90V+UXVr6loqIM87/14JiNdhwRUEhFLH67HNvFGcMKInGV0wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwZGb+UhFzL/7K26csOb57yM5bvF9xJrLEObOkAAAAAE3615Yv+x3ZJdCp+15tAM5hlbqLs6kf0H75hgxel7uAbd9uHudY/eGEJdvORszdq2GvxNg7kNJ/69+SjYoYv8IyYoOazXpmKghdtORYsaGTmcMlL8/BwFQReZEh7FXVojUufhLR4sFqEciyQUTeaaw1YIF3vTiqut5Y9xv+7k0WSiqdVNS/jO7C+fPKADtGznKBw9ePgDiTjNuDaNwcHjZafcLQO2mLuL6EquLpIZiwhuKbWNFYH0Wm+RbJRF8T+MlyWPTiSJ8bs9ECkUjg2DC1oTmdr/EIQEjnvY2+n4WeF9yO2P8M94uBa93PxT+AVLnClxsVsAo3lbhqBRFTDooQV6KQkz47RFX+zciKPbNBImE+UyAxgygaNOjGsILmkGBAAFAkANAwAEAAkDoIYBAAAAAAALBgACBwoDBgEBBgcBCgIACAkMCgz0AQAAAAAAAAAFAQAaBgQDAJWrB34AAAAABAMAAAEAAAAAAAAAAAAFAQERCgQDAwAABgAAAAAAAAAABQg=";

/**
 * 2sHzKLUsMawtWa7pm7Yx4LmsJ5ypiqEL2fXaudzk4r1SyibAhPziaAYZrrNFBiZbAHTRALDRQhQVkKVj3WEDJ5WQ,
 * the treasury mint of 500 and the re-pause of Primary issuance (legacy).
 * [limit, price, Lighthouse ×4, ATA CreateIdempotent, mint, re-pause,
 *  Lighthouse ×2]: guards both before and after the app's instructions.
 */
export const PHANTOM_TREASURY_MINT_MESSAGE =
  "AQAJDkzL1AM6knEks5ol+j/hDD+Jao+AAxBrj5f7K/FKY/LSEa6Jw2lRW5CilX19pvjagTUXEV3dUXoNSXJB0+90V+Vlp9wtA7aYu4voSq4ukhmLCG4ptY0VgfRab5FslEXxP8IOclMx6zHBInQlWMprbM2j/wWO5BqxudA3LZhAJLAD1IRjWBPnko4Qz58ccOBBT2cRvng7fjqu5qRxh8fq0h4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMGRm/lIRcy/+ytunLDm+e8jOW7xfcSayxDmzpAAAAABN+teWL/sd2SXQqftebQDOYZW6i7OpH9B++YYMXpe7gG3fbh7nWP3hhCXbzkbM3athr8TYO5DSf+vfko2KGL/IyXJY9OJInxuz0QKRSODYMLWhOZ2v8QhASOe9jb6fhZlZPjCGaeM9vsUm6f62DA+CsOrBidR5hClCIcCrNVDorSiX2gkRWQ2nhipD3Rev8M77b01T/ezv0Bazy1utWjPdSXB8eRpAFh+zHlK1XwCwJ63c1ZwnfEwf6nYC3joFrL/IVZtU5+90c4i4nZ37VzlPfHSPsaLx78LO2UfaOam28eT3HK1acYzfnkyA5qjab2XfwccVkqxxx5js7Gp41AKAsGAAUCQA0DAAYACQOghgEAAAAAAAcBAQ0GBAEAAAAAAAAAAAAABwECNAYEAwMCAAHmAQAAAAAAAAAIRQ54kSLAgj2b+ha2ss7mHT5L7azshnuPUIdpA2oyVYgA5gMHAQQlBgQBAtSXB8eRpAFh+zHlK1XwCwJ63c1ZwnfEwf6nYC3joFrLAAcBAyUGBAEC1JcHx5GkAWH7MeUrVfALAnrdzVnCd8TB/qdgLeOgWssACQYAAQACBQgBAQwJAAsKDQMCAQgEEAshLBMookwC9AEAAAAAAAAMAwALBArNp1XtkMr4rwIABwEAGgYEAwDliR9+AAAAAAQDAAABAAAAAAAAAAAABwEBGwoEBALCAQAAAAAAAAQDAAAGAAAAAAAAAAAFCA==";

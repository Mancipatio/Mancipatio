import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { OAuth2Client, CodeChallengeMethod, type TokenPayload } from "google-auth-library";
import { NextRequest, NextResponse } from "next/server";
import { detectNetwork, type Network } from "@/lib/network";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { boundedRequest } from "@/lib/server/bounded-request";
import { SiwsError, verifySigned } from "@/lib/server/siws";
import { accountSiteOrigin } from "@/lib/server/account-origin";
import { accountErrorResponse, accountResponse, callAccountMutation, consumeAccountRateLimit, getAccountProfile } from "@/lib/server/account-profile";
import { accountId, accountParams } from "@/lib/server/account-validation";
import { readAccountSession } from "@/lib/server/account-auth";
import { assertSameSite, withAccountSession } from "@/lib/server/auth-login";

const COOKIE = "manci_google_link";
const COOKIE_PATH = "/api/account/google";
const TTL_SECONDS = 600;
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CALLBACK_PATH = "/api/account/google/callback";

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function nonceFor(state: string) {
  return hash(`manci:google-link:nonce:${state}`);
}

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

function googleClient(redirectUri: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new SiwsError(503, "Google connection is not available yet. Please try again later.");
  }
  return new OAuth2Client({
    clientId, clientSecret, redirectUri,
    transporterOptions: { timeout: 15_000, retry: false },
  });
}

function googleAccountId(params: Record<string, unknown>) {
  accountParams(params, ["account_id"]);
  return accountId(params.account_id);
}

export async function startGoogleLink(request: Request) {
  try {
    const { wallet, params } = await verifySigned(await boundedRequest(request, 8192), "account.google.start");
    const expectedAccountId = googleAccountId(params);
    const network = detectNetwork();
    const origin = accountSiteOrigin(request);
    const redirectUri = origin + CALLBACK_PATH;
    const client = googleClient(redirectUri);
    await consumeAccountRateLimit(`google-start:${network}:${wallet}`, 5, TTL_SECONDS);
    const profile = await getAccountProfile(wallet, network);
    if (profile.id !== expectedAccountId) throw new SiwsError(403, "This wallet no longer has access to the selected account.");

    const state = randomBytes(32).toString("base64url");
    const browserToken = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const sb = getSupabaseAdmin();
    // Prune only expired states belonging to this authorized wallet.
    const cleanup = await sb.from("account_google_states").delete()
      .eq("wallet", wallet).eq("network", network).lt("expires_at", new Date().toISOString());
    if (cleanup.error) throw new SiwsError(503, "Google connection is temporarily unavailable.");
    const { error } = await sb.from("account_google_states").insert({
      state_hash: hash(state), browser_hash: hash(browserToken), wallet, network,
      account_id: profile.id,
      code_verifier: verifier, redirect_uri: redirectUri,
      expires_at: new Date(Date.now() + TTL_SECONDS * 1000).toISOString(),
    });
    if (error) throw new SiwsError(503, "Google connection is temporarily unavailable.");

    const url = client.generateAuthUrl({
      access_type: "online", scope: ["openid", "email"], response_type: "code",
      prompt: "select_account", state, nonce: nonceFor(state),
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: CodeChallengeMethod.S256,
    });
    const response = noStore(NextResponse.json({ ok: true, data: { url } }));
    response.cookies.set(COOKIE, browserToken, {
      httpOnly: true, secure: origin.startsWith("https:"), sameSite: "lax",
      path: COOKIE_PATH, maxAge: TTL_SECONDS,
    });
    return response;
  } catch (error) {
    return noStore(accountErrorResponse(error));
  }
}

/** Sign in with Google (no wallet), or connect Google to the signed-in
 * email account (mode "link"). Unsigned; same-site POST only. */
export async function startGoogleSignIn(request: Request) {
  try {
    const origin = assertSameSite(request);
    const body = await (await boundedRequest(request, 1024)).json().catch(() => null) as { mode?: unknown } | null;
    const mode = body?.mode === "link" ? "link" : "login";
    const network = detectNetwork();
    const redirectUri = origin + CALLBACK_PATH;
    const client = googleClient(redirectUri);
    let linkAccountId: string | null = null;
    if (mode === "link") {
      const session = readAccountSession(request);
      if (!session) throw new SiwsError(401, "Please sign in again.");
      linkAccountId = session.a;
    }
    const state = randomBytes(32).toString("base64url");
    const browserToken = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const sb = getSupabaseAdmin();
    await sb.from("auth_google_states").delete().lt("expires_at", new Date().toISOString());
    const { error } = await sb.from("auth_google_states").insert({
      state_hash: hash(state), browser_hash: hash(browserToken), network, code_verifier: verifier,
      redirect_uri: redirectUri, link_account_id: linkAccountId,
      expires_at: new Date(Date.now() + TTL_SECONDS * 1000).toISOString(),
    });
    if (error) throw new SiwsError(503, "Google sign-in is temporarily unavailable.");
    const url = client.generateAuthUrl({
      access_type: "online", scope: ["openid", "email"], response_type: "code",
      prompt: "select_account", state, nonce: nonceFor(state),
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: CodeChallengeMethod.S256,
    });
    const response = noStore(NextResponse.json({ ok: true, data: { url } }));
    response.cookies.set(COOKIE, browserToken, {
      httpOnly: true, secure: origin.startsWith("https:"), sameSite: "lax", path: COOKIE_PATH, maxAge: TTL_SECONDS,
    });
    return response;
  } catch (error) {
    return noStore(accountErrorResponse(error));
  }
}

async function verifiedGoogleIdentity(stored: { code_verifier: string; redirect_uri: string }, code: string, state: string) {
  const client = googleClient(stored.redirect_uri);
  const { tokens } = await client.getToken({ code, codeVerifier: stored.code_verifier, redirect_uri: stored.redirect_uri });
  if (!tokens.id_token) throw new Error("Missing identity proof");
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID!.trim() });
  const claims = ticket.getPayload() as (TokenPayload & { nonce?: string }) | undefined;
  if (!claims || claims.nonce !== nonceFor(state) || claims.email_verified !== true ||
      !claims.sub || claims.sub.length > 255 || !claims.email || claims.email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email) ||
      (claims.azp && claims.azp !== process.env.GOOGLE_CLIENT_ID!.trim())) {
    throw new Error("Invalid identity proof");
  }
  return { sub: claims.sub, email: claims.email.trim().toLowerCase() };
}

/** Callback half of startGoogleSignIn. Returns null when the state is not a sign-in state. */
async function finishGoogleSignIn(request: NextRequest, origin: string, network: Network, state: string, browserToken: string) {
  const sb = getSupabaseAdmin();
  const { data: stored } = await sb.from("auth_google_states")
    .select("state_hash,code_verifier,redirect_uri,expires_at,link_account_id")
    .eq("state_hash", hash(state)).eq("browser_hash", hash(browserToken)).eq("network", network).maybeSingle();
  if (!stored) return null;
  // Single use, whatever happens next.
  await sb.from("auth_google_states").delete().eq("state_hash", hash(state));
  if (Date.parse(stored.expires_at) <= Date.now() || stored.redirect_uri !== origin + CALLBACK_PATH) {
    return callbackRedirect(origin, "expired", true);
  }
  if (request.nextUrl.searchParams.has("error")) {
    return callbackRedirect(origin, request.nextUrl.searchParams.get("error") === "access_denied" ? "cancelled" : "failed", true);
  }
  try {
    const code = request.nextUrl.searchParams.get("code");
    if (!code || code.length > 4096) throw new Error("Invalid authorization code");
    const identity = await verifiedGoogleIdentity(stored, code, state);
    if (stored.link_account_id) {
      const { data } = await sb.rpc("link_account_google_by_id", {
        p_account_id: stored.link_account_id, p_network: network, p_sub: identity.sub, p_email: identity.email,
      });
      return callbackRedirect(origin, data === "linked" ? "connected" : data === "google_in_use" ? "in_use" : "failed", true);
    }
    const { data: accountId, error } = await sb.rpc("login_account_google", { p_network: network, p_sub: identity.sub, p_email: identity.email });
    if (error || typeof accountId !== "string") return callbackRedirect(origin, "unavailable", true);
    return withAccountSession(callbackRedirect(origin, "signed_in", true), accountId, origin);
  } catch {
    return callbackRedirect(origin, "failed", true);
  }
}

type GoogleState = {
  state_hash: string;
  browser_hash: string;
  wallet: string;
  network: string;
  code_verifier: string;
  redirect_uri: string;
  expires_at: string;
};

type GoogleResult = "connected" | "signed_in" | "in_use" | "cancelled" | "expired" | "unavailable" | "failed";

function callbackRedirect(origin: string, result: GoogleResult, clearCookie: boolean) {
  const response = noStore(NextResponse.redirect(new URL(`/account?google=${result}`, origin), 303));
  if (clearCookie) response.cookies.set(COOKIE, "", {
    httpOnly: true, secure: origin.startsWith("https:"), sameSite: "lax", path: COOKIE_PATH, maxAge: 0,
  });
  return response;
}

/** Callback binds the Google proof to the browser AND the wallet-signed start. */
export async function finishGoogleLink(request: NextRequest) {
  let origin: string;
  let network: Network;
  try {
    origin = accountSiteOrigin(request);
    network = detectNetwork();
  }
  catch (error) { return noStore(accountErrorResponse(error)); }
  const state = request.nextUrl.searchParams.get("state");
  const browserToken = request.cookies.get(COOKIE)?.value;
  if (!state || !browserToken || !OPAQUE_TOKEN.test(state) || !OPAQUE_TOKEN.test(browserToken)) {
    return callbackRedirect(origin, "expired", false);
  }
  const signIn = await finishGoogleSignIn(request, origin, network, state, browserToken);
  if (signIn) return signIn;
  const stateHash = hash(state);
  const browserHash = hash(browserToken);
  let matched = false;
  try {
    const sb = getSupabaseAdmin();
    const { data, error } = await sb.from("account_google_states")
      .select("state_hash,browser_hash,wallet,network,code_verifier,redirect_uri,expires_at")
      .eq("state_hash", stateHash).eq("browser_hash", browserHash).eq("network", network).maybeSingle();
    if (error) return callbackRedirect(origin, "unavailable", false);
    const stored = data as GoogleState | null;
    if (!stored) return callbackRedirect(origin, "expired", false);
    matched = true;
    if (!Number.isFinite(Date.parse(stored.expires_at)) || Date.parse(stored.expires_at) <= Date.now() ||
        stored.redirect_uri !== origin + CALLBACK_PATH) {
      await discardState(stateHash, browserHash, network);
      return callbackRedirect(origin, "expired", true);
    }
    if (request.nextUrl.searchParams.has("error")) {
      await discardState(stateHash, browserHash, network);
      return callbackRedirect(origin, request.nextUrl.searchParams.get("error") === "access_denied" ? "cancelled" : "failed", true);
    }
    const code = request.nextUrl.searchParams.get("code");
    if (!code || code.length > 4096) throw new Error("Invalid authorization code");
    const client = googleClient(stored.redirect_uri);
    const { tokens } = await client.getToken({ code, codeVerifier: stored.code_verifier, redirect_uri: stored.redirect_uri });
    if (!tokens.id_token) throw new Error("Missing identity proof");
    // Google's library verifies the signature, issuer, audience and expiry.
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID!.trim() });
    const claims = ticket.getPayload() as (TokenPayload & { nonce?: string }) | undefined;
    if (!claims || claims.nonce !== nonceFor(state) || claims.email_verified !== true ||
        !claims.sub || claims.sub.length > 255 || !claims.email || claims.email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email) ||
        (claims.azp && claims.azp !== process.env.GOOGLE_CLIENT_ID!.trim())) {
      throw new Error("Invalid identity proof");
    }
    // The transaction locks the owning profile, consumes the still-live state,
    // and changes Google fields together. An unlink invalidates pending states.
    const completed = await sb.rpc("complete_account_google_link", {
      p_state_hash: stateHash, p_browser_hash: browserHash, p_network: network,
      p_sub: claims.sub, p_email: claims.email.trim().toLowerCase(),
    });
    if (completed.error) throw new Error("Could not save Google connection");
    return callbackRedirect(origin, completed.data === true ? "connected" : "expired", true);
  } catch (error) {
    if (matched) await discardState(stateHash, browserHash, network);
    // Provider errors can embed authorization codes/tokens; never log them.
    return callbackRedirect(origin, error instanceof SiwsError && error.status === 503 ? "unavailable" : "failed", matched);
  }
}

async function discardState(stateHash: string, browserHash: string, network: string) {
  try {
    await getSupabaseAdmin().from("account_google_states").delete()
      .eq("state_hash", stateHash).eq("browser_hash", browserHash).eq("network", network);
  } catch { /* Expiry and atomic completion still fail closed. */ }
}

export async function unlinkGoogle(request: Request) {
  try {
    const { wallet, params } = await verifySigned(await boundedRequest(request, 8192), "account.google.unlink");
    const expectedAccountId = googleAccountId(params);
    const network = detectNetwork();
    const unlinked = await callAccountMutation<boolean>(wallet, network, expectedAccountId, "google.unlink", {});
    if (unlinked !== true) throw new SiwsError(503, "Could not disconnect Google. Please try again.");
    return await accountResponse(wallet, network);
  } catch (error) { return noStore(accountErrorResponse(error)); }
}

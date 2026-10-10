import { redirect } from "next/navigation";

// The former "Pilot operator guide". Its recovery guidance now lives at
// /docs/recovery; this route only forwards old links and bookmarks there.
// Temporary (307) on purpose, like /platform and /solutions: a permanent
// redirect would stay cached in browsers if the URL is ever reused.
export default function FormerPilotGuide() {
  redirect("/docs/recovery");
}
